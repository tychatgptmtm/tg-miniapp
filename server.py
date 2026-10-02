"""AI Studio — Telegram Mini App (сервер).
Отдаёт мини-апп, проксирует запросы к OpenRouter / любым OpenAI-совместимым API,
проверяет подпись Telegram и обслуживает бота (вебхук).
"""
import asyncio, base64, hashlib, hmac, json, logging, os, re, time
from urllib.parse import parse_qsl

import aiohttp
from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("app")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
OR_KEY = os.getenv("OPENROUTER_API_KEY", "")
PUBLIC_URL = (os.getenv("PUBLIC_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "stealth/space-bunny-alpha")
ALLOWED = {int(x) for x in os.getenv("ALLOWED_USERS", "").replace(" ", "").split(",") if x}
DEV = os.getenv("DEV") == "1"  # разрешить открывать в обычном браузере без Telegram
PORT = int(os.getenv("PORT", "8080"))
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET") or hashlib.sha256(f"wh:{BOT_TOKEN}".encode()).hexdigest()[:40]
OR_URL = "https://openrouter.ai/api/v1"
TG_URL = f"https://api.telegram.org/bot{BOT_TOKEN}/"
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

FALLBACK_MODELS = [
    {"id": "stealth/space-bunny-alpha", "name": "Space Bunny Alpha", "vision": True, "imageOut": False, "free": True, "ctx": 1000000},
    {"id": "openrouter/free", "name": "Auto (бесплатные модели)", "vision": True, "imageOut": False, "free": True, "ctx": 128000},
    {"id": "google/gemini-2.5-flash-image", "name": "Gemini 2.5 Flash Image (Nano Banana)", "vision": True, "imageOut": True, "free": False, "ctx": 32768},
]

http: aiohttp.ClientSession | None = None
_models_cache = {"t": 0, "data": None}


# ---------- Telegram auth ----------
def check_init_data(init_data: str):
    if not init_data:
        return {"id": 0, "first_name": "Dev"} if DEV else None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        received = pairs.pop("hash")
        dcs = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest(), received):
            return None
        if time.time() - int(pairs.get("auth_date", 0)) > 7 * 86400:
            return None
        user = json.loads(pairs.get("user", "{}"))
        if ALLOWED and user.get("id") not in ALLOWED:
            return None
        return user
    except Exception:
        return None


@web.middleware
async def auth_mw(request, handler):
    if request.path.startswith("/api/"):
        user = check_init_data(request.headers.get("X-Init-Data", ""))
        if user is None:
            return web.json_response({"error": "Откройте приложение через Telegram (нет доступа)"}, status=401)
        request["user"] = user
    resp = await handler(request)
    if request.path in ("/", "/index.html") or request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ---------- helpers ----------
def provider_target(body):
    """Куда слать запрос: OpenRouter (ключ сервера) или пользовательский провайдер."""
    p = body.get("provider") or None
    if p and p.get("baseUrl"):
        base = p["baseUrl"].rstrip("/")
        if not base.startswith(("https://", "http://")):
            raise web.HTTPBadRequest(text="bad baseUrl")
        return base, p.get("apiKey", "")
    return OR_URL, OR_KEY


def headers_for(key):
    h = {"Content-Type": "application/json", "HTTP-Referer": PUBLIC_URL or "https://t.me", "X-Title": "AI Studio Mini App"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


# ---------- API ----------
async def api_config(request):
    return web.json_response({"defaultModel": DEFAULT_MODEL, "user": request["user"], "serverKey": bool(OR_KEY)})


async def api_models(request):
    if _models_cache["data"] and time.time() - _models_cache["t"] < 1800:
        return web.json_response(_models_cache["data"])
    try:
        async with http.get(f"{OR_URL}/models", timeout=aiohttp.ClientTimeout(total=20)) as r:
            raw = (await r.json())["data"]
        out = []
        for m in raw:
            arch = m.get("architecture") or {}
            inp, outm = arch.get("input_modalities") or [], arch.get("output_modalities") or []
            pr = m.get("pricing") or {}
            free = str(pr.get("prompt", "1")) in ("0", "0.0") and str(pr.get("completion", "1")) in ("0", "0.0")
            out.append({
                "id": m["id"], "name": m.get("name", m["id"]), "ctx": m.get("context_length") or 0,
                "vision": "image" in inp, "imageOut": "image" in outm, "textOut": "text" in outm or not outm,
                "free": free, "price": [pr.get("prompt"), pr.get("completion")], "created": m.get("created", 0),
            })
        _models_cache.update(t=time.time(), data=out)
        return web.json_response(out)
    except Exception as e:
        log.warning("models fetch failed: %s", e)
        return web.json_response(_models_cache["data"] or FALLBACK_MODELS)


async def api_provider_models(request):
    body = await request.json()
    base, key = provider_target(body)
    try:
        async with http.get(f"{base}/models", headers=headers_for(key), timeout=aiohttp.ClientTimeout(total=20)) as r:
            data = await r.json(content_type=None)
            if r.status != 200:
                return web.json_response({"error": str(data)[:300]}, status=400)
        items = data.get("data", data) if isinstance(data, dict) else data
        ids = sorted({(i.get("id") if isinstance(i, dict) else str(i)) for i in items} - {None})
        return web.json_response({"models": ids})
    except Exception as e:
        return web.json_response({"error": f"Не удалось получить список моделей: {e}"}, status=400)


async def api_chat(request):
    body = await request.json()
    base, key = provider_target(body)
    if base == OR_URL and not key:
        return web.json_response({"error": "На сервере не задан OPENROUTER_API_KEY"}, status=500)
    payload = {"model": body["model"], "messages": body["messages"], "stream": True}
    for k in ("temperature", "max_tokens", "modalities", "reasoning", "top_p"):
        if body.get(k) is not None:
            payload[k] = body[k]
    if base != OR_URL:  # чужие API не знают OpenRouter-специфичных полей
        payload.pop("reasoning", None)
        payload.pop("modalities", None)
    try:
        upstream = await http.post(f"{base}/chat/completions", json=payload, headers=headers_for(key),
                                   timeout=aiohttp.ClientTimeout(total=600, sock_read=300))
    except Exception as e:
        return web.json_response({"error": f"Сеть: {e}"}, status=502)
    async with upstream:
        if upstream.status != 200:
            text = await upstream.text()
            try:
                j = json.loads(text)
                msg = j.get("error", {}).get("message") if isinstance(j.get("error"), dict) else j.get("error") or text
                meta = j.get("error", {}).get("metadata", {}) if isinstance(j.get("error"), dict) else {}
                if meta.get("raw"):
                    msg = f"{msg}: {str(meta['raw'])[:300]}"
            except Exception:
                msg = text[:500]
            return web.json_response({"error": msg or f"HTTP {upstream.status}"}, status=upstream.status)
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                                           "X-Accel-Buffering": "no"})
        await resp.prepare(request)
        try:
            async for chunk in upstream.content.iter_any():
                await resp.write(chunk)
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return resp


async def api_send_photo(request):
    body = await request.json()
    uid = request["user"].get("id")
    if not uid or not BOT_TOKEN:
        return web.json_response({"error": "Доступно только внутри Telegram"}, status=400)
    data_url = body.get("dataUrl", "")
    if data_url.startswith("data:"):
        head, b64 = data_url.split(",", 1)
        raw, mime = base64.b64decode(b64), head[5:].split(";")[0]
    else:
        async with http.get(data_url) as r:
            raw, mime = await r.read(), r.content_type
    ext = (mime.split("/")[-1] or "png").replace("jpeg", "jpg")
    form = aiohttp.FormData()
    form.add_field("chat_id", str(uid))
    if body.get("caption"):
        form.add_field("caption", body["caption"][:1000])
    form.add_field("document", raw, filename=f"image.{ext}", content_type=mime)
    async with http.post(TG_URL + "sendDocument", data=form) as r:
        res = await r.json()
    return web.json_response({"ok": res.get("ok", False), "error": res.get("description")})


# ---------- Bot ----------
async def tg(method, **params):
    async with http.post(TG_URL + method, json=params) as r:
        return await r.json()


async def tg_webhook(request):
    if request.headers.get("X-Telegram-Bot-Api-Secret-Token") != WEBHOOK_SECRET:
        return web.Response(status=403)
    upd = await request.json()
    msg = upd.get("message") or {}
    if msg.get("text", "").startswith("/start") or msg.get("text"):
        await tg("sendMessage", chat_id=msg["chat"]["id"],
                 text="<b>AI Studio</b>\n\nСотни нейросетей, анализ и генерация изображений — в одном приложении.",
                 parse_mode="HTML",
                 reply_markup={"inline_keyboard": [[{"text": "Открыть AI Studio", "web_app": {"url": PUBLIC_URL}}]]})
    return web.Response(text="ok")


async def on_startup(app):
    global http
    http = aiohttp.ClientSession()
    if BOT_TOKEN and PUBLIC_URL:
        try:
            r1 = await tg("setWebhook", url=f"{PUBLIC_URL}/tg/webhook", secret_token=WEBHOOK_SECRET,
                          allowed_updates=["message"], drop_pending_updates=True)
            r2 = await tg("setChatMenuButton", menu_button={"type": "web_app", "text": "AI Studio",
                                                            "web_app": {"url": PUBLIC_URL}})
            log.info("webhook: %s, menu: %s", r1.get("ok"), r2.get("ok"))
        except Exception as e:
            log.error("bot setup failed: %s", e)
    else:
        log.warning("BOT_TOKEN или PUBLIC_URL не заданы — бот не настроен")


async def on_cleanup(app):
    await http.close()


_logo_cache: dict = {}
LOGO_CDNS = ["https://unpkg.com/@lobehub/icons-static-svg@latest/icons/{}.svg",
             "https://registry.npmmirror.com/@lobehub/icons-static-svg/latest/files/icons/{}.svg"]


async def logo(request):
    """Логотипы AI-брендов (Lobe Icons), кешируются на сервере — клиенту не нужен доступ к CDN."""
    slug = request.match_info["slug"]
    if not re.fullmatch(r"[a-z0-9.-]{1,40}", slug):
        raise web.HTTPNotFound()
    if slug not in _logo_cache:
        body = None
        for url in LOGO_CDNS:
            try:
                async with http.get(url.format(slug), timeout=aiohttp.ClientTimeout(total=8)) as r:
                    if r.status == 200:
                        b = await r.read()
                        if b.lstrip().startswith(b"<svg"):
                            body = b
                            break
            except Exception:
                pass
        _logo_cache[slug] = body
    body = _logo_cache[slug]
    if not body:
        raise web.HTTPNotFound()
    return web.Response(body=body, content_type="image/svg+xml", headers={"Cache-Control": "public, max-age=604800"})


async def index(request):
    return web.FileResponse(os.path.join(STATIC, "index.html"))


def make_app():
    app = web.Application(middlewares=[auth_mw], client_max_size=60 * 1024 * 1024)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_get("/", index)
    app.router.add_get("/health", lambda r: web.Response(text="ok"))
    app.router.add_get("/api/config", api_config)
    app.router.add_get("/api/models", api_models)
    app.router.add_post("/api/provider-models", api_provider_models)
    app.router.add_post("/api/chat", api_chat)
    app.router.add_post("/api/send-photo", api_send_photo)
    app.router.add_post("/tg/webhook", tg_webhook)
    app.router.add_get("/logo/{slug}.svg", logo)
    app.router.add_static("/static/", STATIC)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=PORT)
