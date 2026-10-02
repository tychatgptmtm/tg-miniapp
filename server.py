"""AI Studio — Telegram Mini App (сервер).
Отдаёт мини-апп, проксирует запросы к OpenRouter / любым OpenAI-совместимым API,
проверяет подпись Telegram и обслуживает бота (вебхук).
"""
import asyncio, base64, hashlib, hmac, json, logging, os, re, time
from urllib.parse import parse_qsl

import aiohttp
from aiohttp import web

from store import Store
import chatbot
from tools import TOOLS, FILES_DIR, run_tool, tool_label, tool_prompt

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("app")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
OR_KEY = os.getenv("OPENROUTER_API_KEY", "")
PUBLIC_URL = (os.getenv("PUBLIC_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "stealth/space-bunny-alpha")
ADMINS = [int(x) for x in os.getenv("ADMIN_ID", "").replace(" ", "").split(",") if x]
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
store = Store()


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
        return json.loads(pairs.get("user", "{}"))
    except Exception:
        return None


@web.middleware
async def auth_mw(request, handler):
    if request.path.startswith("/api/"):
        user = check_init_data(request.headers.get("X-Init-Data", ""))
        if user is None:
            return web.json_response({"error": "Откройте приложение через кнопку в боте"}, status=401)
        uid = user.get("id")
        if uid not in ADMINS:
            if ALLOWED and uid not in ALLOWED:
                return web.json_response({"error": "Это приватный бот — доступ есть только у владельца", "blocked": True}, status=403)
            if store.is_blocked(uid):
                return web.json_response({"error": "Доступ ограничен администратором", "blocked": True}, status=403)
        request["user"] = user
    resp = await handler(request)
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
    store.touch(request["user"])
    return web.json_response({"defaultModel": DEFAULT_MODEL, "user": request["user"], "serverKey": bool(OR_KEY),
                              "isAdmin": request["user"].get("id") in ADMINS})


# ---------- admin ----------
def require_admin(request):
    if request["user"].get("id") not in ADMINS:
        raise web.HTTPForbidden(text="admin only")


async def api_admin_users(request):
    require_admin(request)
    users = sorted(store.users.values(), key=lambda u: u.get("last_seen", 0), reverse=True)
    return web.json_response({"users": users, "stats": store.stats(), "admins": ADMINS})


async def api_admin_block(request):
    require_admin(request)
    body = await request.json()
    uid = int(body["id"])
    if uid in ADMINS:
        return web.json_response({"error": "Нельзя заблокировать администратора"}, status=400)
    store.set_blocked(uid, bool(body.get("blocked")))
    if BOT_TOKEN:
        txt = "Администратор ограничил вам доступ к AI Studio." if body.get("blocked") else "Доступ к AI Studio снова открыт."
        asyncio.get_running_loop().create_task(tg("sendMessage", chat_id=uid, text=txt))
    return web.json_response({"ok": True, "stats": store.stats()})


async def api_models(request):
    resp = web.json_response(await get_models(), headers={"Cache-Control": "private, max-age=600"})
    resp.enable_compression()
    return resp


async def get_models():
    if _models_cache["data"] and time.time() - _models_cache["t"] < 1800:
        return _models_cache["data"]
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
        return out
    except Exception as e:
        log.warning("models fetch failed: %s", e)
        return _models_cache["data"] or FALLBACK_MODELS


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


def upstream_error(text, status):
    try:
        j = json.loads(text)
        err = j.get("error")
        msg = err.get("message") if isinstance(err, dict) else err or text
        meta = err.get("metadata", {}) if isinstance(err, dict) else {}
        if meta.get("raw"):
            msg = f"{msg}: {str(meta['raw'])[:300]}"
    except Exception:
        msg = text[:500]
    return msg or f"HTTP {status}"


async def sse(resp, obj):
    await resp.write(b"data: " + json.dumps(obj, ensure_ascii=False).encode() + b"\n\n")


async def agent_events(body, user):
    """Общий «мозг»: запрос к модели + инструменты. Выдаёт события (чанки OpenRouter, x_tool, x_file, error).
    Ошибка до начала ответа приходит с ключом _status."""
    base, key = provider_target(body)
    if base == OR_URL and not key:
        yield {"error": {"message": "На сервере не задан OPENROUTER_API_KEY"}, "_status": 500}
        return
    payload = {"model": body["model"], "stream": True}
    for k in ("temperature", "max_tokens", "modalities", "reasoning", "top_p"):
        if body.get(k) is not None:
            payload[k] = body[k]
    if base != OR_URL:  # чужие API не знают OpenRouter-специфичных полей
        payload.pop("reasoning", None)
        payload.pop("modalities", None)
    use_tools = bool(body.get("tools")) and not payload.get("modalities")
    base_msgs = body["messages"]
    messages = ([{"role": "system", "content": tool_prompt()}] + base_msgs) if use_tools else list(base_msgs)
    started = False
    for step in range(7):
        p = dict(payload, messages=messages)
        if use_tools:
            p["tools"] = TOOLS
        try:
            upstream = await http.post(f"{base}/chat/completions", json=p, headers=headers_for(key),
                                       timeout=aiohttp.ClientTimeout(total=600, sock_read=300))
        except Exception as e:
            yield {"error": {"message": f"Сеть: {e}"}, **({} if started else {"_status": 502})}
            return
        if upstream.status != 200:
            msg = upstream_error(await upstream.text(), upstream.status)
            upstream.release()
            if use_tools and re.search(r"tool|function", msg, re.I):
                # модель не поддерживает инструменты — повторяем без них
                use_tools = False
                messages = [m for m in messages if m.get("role") != "tool" and not m.get("tool_calls")]
                messages = [m for m in messages if not (m.get("role") == "system" and "AI Studio. Сейчас" in str(m.get("content")))]
                continue
            yield {"error": {"message": msg}, **({} if started else {"_status": upstream.status})}
            return
        started = True
        content, rdetails, calls, buf = "", [], {}, b""
        try:
            async for chunk in upstream.content.iter_any():
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line.startswith(b"data:"):
                        continue
                    d = line[5:].strip()
                    if not d or d == b"[DONE]":
                        continue
                    try:
                        j = json.loads(d)
                    except Exception:
                        continue
                    ch = (j.get("choices") or [{}])[0]
                    delta = ch.get("delta") or ch.get("message") or {}
                    tcs = delta.pop("tool_calls", None)
                    for tc in tcs or []:
                        c = calls.setdefault(tc.get("index", len(calls)), {"id": "", "name": "", "args": ""})
                        c["id"] = tc.get("id") or c["id"]
                        fn = tc.get("function") or {}
                        c["name"] += fn.get("name") or ""
                        c["args"] += fn.get("arguments") or ""
                    if isinstance(delta.get("content"), str):
                        content += delta["content"]
                    if delta.get("reasoning_details"):
                        rdetails.extend(delta["reasoning_details"])
                    if tcs and not delta.get("content") and not delta.get("reasoning") and not j.get("error"):
                        continue
                    yield j
        finally:
            upstream.release()
        if not calls:
            return
        tool_calls = [{"id": c["id"] or f"call_{step}_{i}", "type": "function",
                       "function": {"name": c["name"], "arguments": c["args"] or "{}"}} for i, c in sorted(calls.items())]
        am = {"role": "assistant", "content": content or "", "tool_calls": tool_calls}
        if rdetails:
            am["reasoning_details"] = rdetails
        messages = messages + [am]
        for tc in tool_calls:
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
            except Exception:
                args = {}
            yield {"x_tool": {"id": tc["id"], "name": name, "label": tool_label(name, args), "status": "start"}}
            result, files = await run_tool(http, name, args, PUBLIC_URL)
            for f in files:
                data = f.pop("_data")
                yield {"x_file": f}
                if user.get("id") and BOT_TOKEN:
                    asyncio.get_running_loop().create_task(
                        tg_upload("sendDocument", {"document": (f["name"], data, "application/octet-stream")},
                                  chat_id=user["id"], caption="Файл из AI Studio"))
            yield {"x_tool": {"id": tc["id"], "status": "done"}}
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": str(result)[:16000]})
        if content:
            yield {"choices": [{"delta": {"content": "\n\n"}}]}


async def api_chat(request):
    body = await request.json()
    user = request["user"]
    store.touch(user, msg=True)
    gen = agent_events(body, user)
    resp = None
    try:
        async for ev in gen:
            if resp is None:
                if "_status" in ev:
                    return web.json_response({"error": ev["error"]["message"]}, status=ev["_status"])
                resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                                                   "X-Accel-Buffering": "no"})
                await resp.prepare(request)
            await sse(resp, ev)
        if resp is None:
            resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await resp.prepare(request)
        await resp.write(b"data: [DONE]\n\n")
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        await gen.aclose()
    return resp


async def serve_file(request):
    fid, name = request.match_info["fid"], request.match_info["name"]
    if not re.fullmatch(r"[0-9a-f]{32}", fid) or "/" in name or ".." in name:
        raise web.HTTPNotFound()
    path = os.path.join(FILES_DIR, fid, name)
    if not os.path.isfile(path):
        raise web.HTTPNotFound(text="Файл устарел (хранится 24 часа)")
    from urllib.parse import quote
    return web.FileResponse(path, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


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
BOT_NAME = os.getenv("BOT_NAME", "AI Studio")
SHORT_DESC = "Сотни нейросетей в одном окне: чат, анализ фото и генерация изображений."
DESC = ("AI Studio — личная студия нейросетей прямо в Telegram.\n\n"
        "• GPT, Claude, Gemini, DeepSeek, Grok и сотни других моделей\n"
        "• Анализ фото и файлов, генерация изображений\n"
        "• Создание файлов и архивов, поиск в интернете\n"
        "• Можно общаться и прямо в чате с ботом\n\n"
        "Нажмите «Запустить», чтобы начать.")
COMMANDS = [{"command": "start", "description": "Главное меню"},
            {"command": "app", "description": "Открыть AI Studio"},
            {"command": "new", "description": "Новый диалог в чате"},
            {"command": "model", "description": "Нейросеть для чата"},
            {"command": "help", "description": "Как пользоваться"},
            {"command": "about", "description": "О боте"}]
HELP = ("<b>Как пользоваться AI Studio</b>\n\n"
        "<b>1. Выберите модель.</b> Нажмите на название модели вверху приложения. Фильтры помогут найти "
        "бесплатные модели, модели, которые видят фото, и модели, которые рисуют.\n\n"
        "<b>2. Пишите или прикладывайте фото.</b> Скрепка слева от поля ввода — до 6 изображений за раз.\n\n"
        "<b>3. Генерируйте картинки.</b> Выберите модель с иконкой волшебной палочки и опишите, что нарисовать.\n\n"
        "<b>4. Файлы и интернет.</b> Попросите создать документ, таблицу, код или архив — ИИ сделает файл и пришлёт "
        "его сюда. Он также умеет искать в интернете и читать сайты по ссылке.\n\n"
        "<b>5. Свои API.</b> Меню → Настройки и API → Добавить: OpenAI, Gemini, Groq, DeepSeek и другие.\n\n"
        "<b>Без приложения.</b> Можно писать прямо сюда, в чат — бот ответит. Понимает фото, PDF, Word, Excel и код. "
        "/new — новый диалог, /model — выбрать нейросеть.")
ABOUT = ("<b>AI Studio</b>\n\nРаботает через OpenRouter — единый доступ к сотням нейросетей. "
         "История чатов приложения хранится только на вашем устройстве.")


def esc_html(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def app_kb(extra=True):
    rows = [[{"text": "Открыть AI Studio", "web_app": {"url": PUBLIC_URL}}]]
    if extra:
        rows.append([{"text": "Как пользоваться", "callback_data": "help"}, {"text": "О боте", "callback_data": "about"}])
    return {"inline_keyboard": rows}


async def tg(method, **params):
    async with http.post(TG_URL + method, json=params) as r:
        res = await r.json()
    if not res.get("ok"):
        log.warning("tg %s failed: %s", method, res.get("description"))
    return res


async def tg_upload(method, files: dict, **params):
    form = aiohttp.FormData()
    for k, v in params.items():
        form.add_field(k, str(v))
    for field, (fname, data, ctype) in files.items():
        form.add_field(field, data, filename=fname, content_type=ctype)
    async with http.post(TG_URL + method, data=form) as r:
        res = await r.json()
    if not res.get("ok"):
        log.warning("tg %s failed: %s", method, res.get("description"))
    return res


async def tg_download(file_path):
    async with http.get(f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}") as r:
        return await r.read()


async def send_welcome(chat_id, first_name):
    name = esc_html(first_name or "друг")
    caption = (f"<b>Привет, {name}!</b>\n\n"
               "Это <b>AI Studio</b> — студия нейросетей прямо в Telegram.\n\n"
               "<b>Что внутри</b>\n"
               "— сотни моделей: GPT, Claude, Gemini, DeepSeek, Grok\n"
               "— анализ фото и генерация изображений\n"
               "— создание файлов и поиск в интернете\n"
               "— галерея и история диалогов\n\n"
               "Нажмите кнопку ниже — приложение откроется прямо здесь. "
               "А если удобнее — просто напишите сообщение в этот чат.")
    r = await tg("sendPhoto", chat_id=chat_id, photo=f"{PUBLIC_URL}/static/banner.jpg", caption=caption,
                 parse_mode="HTML", reply_markup=app_kb())
    if not r.get("ok"):
        await tg("sendMessage", chat_id=chat_id, text=caption, parse_mode="HTML", reply_markup=app_kb())


async def tg_webhook(request):
    if request.headers.get("X-Telegram-Bot-Api-Secret-Token") != WEBHOOK_SECRET:
        return web.Response(status=403)
    upd = await request.json()
    try:
        if cq := upd.get("callback_query"):
            cuid = cq["from"]["id"]
            if cuid not in ADMINS and (ALLOWED and cuid not in ALLOWED or store.is_blocked(cuid)):
                await tg("answerCallbackQuery", callback_query_id=cq["id"], text="Доступ ограничен")
                return web.Response(text="ok")
            if cq.get("message") and await chatbot.on_callback(cq):
                return web.Response(text="ok")
            await tg("answerCallbackQuery", callback_query_id=cq["id"])
            text = HELP if cq.get("data") == "help" else ABOUT
            await tg("sendMessage", chat_id=cq["message"]["chat"]["id"], text=text, parse_mode="HTML", reply_markup=app_kb(False))
            return web.Response(text="ok")
        msg = upd.get("message") or {}
        if not msg.get("chat") or msg["chat"].get("type") != "private":
            return web.Response(text="ok")
        chat_id, user = msg["chat"]["id"], msg.get("from", {})
        store.touch(user)
        if user.get("id") not in ADMINS and (ALLOWED and user.get("id") not in ALLOWED or store.is_blocked(user.get("id"))):
            await tg("sendMessage", chat_id=chat_id, text="Доступ к боту ограничен.")
            return web.Response(text="ok")
        txt = (msg.get("text") or "").strip()
        cmd = txt.split()[0].split("@")[0].lower() if txt.startswith("/") else ""
        arg = txt.split(maxsplit=1)[1] if cmd and len(txt.split(maxsplit=1)) > 1 else ""
        if cmd and await chatbot.on_command(cmd, arg, chat_id, user):
            pass
        elif cmd == "/start":
            await send_welcome(chat_id, user.get("first_name"))
        elif cmd == "/help":
            await tg("sendMessage", chat_id=chat_id, text=HELP, parse_mode="HTML", reply_markup=app_kb(False))
        elif cmd == "/about":
            await tg("sendMessage", chat_id=chat_id, text=ABOUT, parse_mode="HTML", reply_markup=app_kb(False))
        elif cmd == "/app":
            await tg("sendMessage", chat_id=chat_id, reply_markup=app_kb(False), text="Откройте AI Studio кнопкой ниже.")
        elif cmd:
            await tg("sendMessage", chat_id=chat_id, text="Не знаю такую команду. Список — /help")
        else:
            asyncio.get_running_loop().create_task(chatbot.answer(chat_id, user, msg))
    except Exception as e:
        log.exception("webhook error: %s", e)
    return web.Response(text="ok")


async def setup_bot_profile():
    """Оформление профиля бота: имя, описания, команды, кнопка меню."""
    me = await tg("getMyName")
    if BOT_NAME and me.get("result", {}).get("name") != BOT_NAME:
        await tg("setMyName", name=BOT_NAME)
    for lang in ("", "ru"):
        extra = {"language_code": lang} if lang else {}
        await tg("setMyShortDescription", short_description=SHORT_DESC, **extra)
        await tg("setMyDescription", description=DESC, **extra)
        await tg("setMyCommands", commands=COMMANDS, **extra)


async def on_startup(app):
    global http
    http = aiohttp.ClientSession()
    if BOT_TOKEN and PUBLIC_URL:
        try:
            r1 = await tg("setWebhook", url=f"{PUBLIC_URL}/tg/webhook", secret_token=WEBHOOK_SECRET,
                          allowed_updates=["message", "callback_query"], drop_pending_updates=True)
            r2 = await tg("setChatMenuButton", menu_button={"type": "web_app", "text": "AI Studio",
                                                            "web_app": {"url": PUBLIC_URL}})
            log.info("webhook: %s, menu: %s", r1.get("ok"), r2.get("ok"))
            asyncio.create_task(setup_bot_profile())
            store.tg, store.tg_upload, store.download, store.admins = tg, tg_upload, tg_download, ADMINS
            chatbot.init(tg=tg, tg_upload=tg_upload, download=tg_download, agent=agent_events, store=store,
                         models=get_models, admins=ADMINS, default_model=DEFAULT_MODEL, public_url=PUBLIC_URL)
            await store.load()
        except Exception as e:
            log.error("bot setup failed: %s", e)
    else:
        log.warning("BOT_TOKEN или PUBLIC_URL не заданы — бот не настроен")


async def on_cleanup(app):
    if store._dirty:
        await store.save()
    await http.close()


_sdk_cache = {"body": None, "t": 0}


async def tg_sdk(request):
    """Скрипт Telegram WebApp через наш сервер — на случай, если telegram.org недоступен у пользователя."""
    if not _sdk_cache["body"] or time.time() - _sdk_cache["t"] > 86400:
        try:
            async with http.get("https://telegram.org/js/telegram-web-app.js", timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status == 200:
                    _sdk_cache.update(body=await r.read(), t=time.time())
        except Exception as e:
            log.warning("tg sdk fetch: %s", e)
    if not _sdk_cache["body"]:
        raise web.HTTPFound("https://telegram.org/js/telegram-web-app.js")
    return web.Response(body=_sdk_cache["body"], content_type="application/javascript",
                        headers={"Cache-Control": "public, max-age=3600"})


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


_static: dict = {}
CTYPES = {".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".jpg": "image/jpeg",
          ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain"}


def load_static():
    """Читаем статику в память один раз: сжимаем gzip и ставим версии — телефон кэширует файлы надолго."""
    import gzip, hashlib
    for name in os.listdir(STATIC):
        path = os.path.join(STATIC, name)
        if not os.path.isfile(path):
            continue
        raw = open(path, "rb").read()
        ext = os.path.splitext(name)[1].lower()
        gz = gzip.compress(raw, 9) if ext in (".js", ".css", ".html", ".svg", ".txt") else None
        _static[name] = {"raw": raw, "gz": gz, "ct": CTYPES.get(ext, "application/octet-stream"),
                         "v": hashlib.md5(raw).hexdigest()[:10]}
    html = _static["index.html"]["raw"].decode()
    for name, f in _static.items():
        html = html.replace(f'"/static/{name}"', f'"/static/{name}?v={f["v"]}"')
    import gzip as _g
    _static["index.html"].update(raw=html.encode(), gz=_g.compress(html.encode(), 9))


def send_static(request, name, cache):
    f = _static.get(name)
    if not f:
        raise web.HTTPNotFound()
    use_gz = f["gz"] is not None and "gzip" in request.headers.get("Accept-Encoding", "")
    h = {"Cache-Control": cache, "Vary": "Accept-Encoding"}
    if use_gz:
        h["Content-Encoding"] = "gzip"
    return web.Response(body=f["gz"] if use_gz else f["raw"], content_type=f["ct"], headers=h,
                        charset="utf-8" if f["ct"].startswith(("text/", "application/javascript")) else None)


async def index(request):
    return send_static(request, "index.html", "no-cache")


async def static_file(request):
    cache = "public, max-age=31536000, immutable" if request.query.get("v") else "public, max-age=600"
    return send_static(request, request.match_info["name"], cache)


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
    app.router.add_get("/api/admin/users", api_admin_users)
    app.router.add_post("/api/admin/block", api_admin_block)
    app.router.add_get("/files/{fid}/{name}", serve_file)
    app.router.add_post("/tg/webhook", tg_webhook)
    app.router.add_get("/logo/{slug}.svg", logo)
    app.router.add_get("/tg-sdk.js", tg_sdk)
    load_static()
    app.router.add_get("/static/{name}", static_file)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=PORT)
