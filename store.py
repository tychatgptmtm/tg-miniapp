"""Мини-база пользователей. Бесплатно и надёжно хранится в Telegram:
JSON-файл закрепляется в чате администратора с ботом и подгружается при старте."""
import asyncio, json, logging, time
from datetime import datetime, timezone, timedelta

log = logging.getLogger("store")
DB_NAME = "ai-studio-db.json"
CAPTION = "База пользователей AI Studio. Обновляется сама — не удаляйте и не открепляйте."
MSK = timezone(timedelta(hours=3))


def today():
    return datetime.now(MSK).strftime("%Y-%m-%d")


class Store:
    def __init__(self):
        self.users: dict = {}
        self._dirty = False
        self._task = None
        self._soon = False
        self._msg_id = None
        self.tg = None          # async (method, **params) -> dict
        self.tg_upload = None   # async (method, files: dict, **params) -> dict
        self.download = None    # async (file_path) -> bytes
        self.admins: list = []

    def touch(self, user, msg=False):
        if not user or not user.get("id"):
            return
        uid, now = str(user["id"]), int(time.time())
        new = uid not in self.users
        u = self.users.setdefault(uid, {"id": user["id"], "first_seen": now, "msgs": 0, "blocked": False, "today": {"d": today(), "n": 0}})
        u["name"] = " ".join(x for x in [user.get("first_name"), user.get("last_name")] if x) or u.get("name", "")
        u["username"] = user.get("username") or u.get("username", "")
        u["last_seen"] = now
        if msg:
            u["msgs"] = u.get("msgs", 0) + 1
            t = u.get("today") or {}
            u["today"] = {"d": today(), "n": (t.get("n", 0) if t.get("d") == today() else 0) + 1}
        self.mark(soon=new)

    def is_blocked(self, uid):
        return bool(self.users.get(str(uid), {}).get("blocked"))

    def set_blocked(self, uid, blocked):
        u = self.users.setdefault(str(uid), {"id": int(uid), "first_seen": int(time.time()), "msgs": 0, "name": "", "username": ""})
        u["blocked"] = bool(blocked)
        self.mark(soon=True)

    def stats(self):
        d, day_ago = today(), time.time() - 86400
        us = list(self.users.values())
        return {"total": len(us), "active24": sum(1 for u in us if u.get("last_seen", 0) > day_ago),
                "msgsToday": sum((u.get("today") or {}).get("n", 0) for u in us if (u.get("today") or {}).get("d") == d),
                "blocked": sum(1 for u in us if u.get("blocked"))}

    def mark(self, soon=False):
        self._dirty = True
        if self._task and soon and not self._soon:
            self._task.cancel()
            self._task = None
        if self._task is None:
            self._soon = soon
            self._task = asyncio.get_running_loop().create_task(self._later(3 if soon else 300))

    async def _later(self, delay):
        await asyncio.sleep(delay)
        self._task = None
        await self.save()

    async def save(self):
        """Один закреплённый файл, который тихо обновляется (editMessageMedia) — без новых сообщений в чате."""
        if not (self._dirty and self.admins and self.tg):
            return
        self._dirty = False
        data = json.dumps({"v": 1, "saved": int(time.time()), "users": self.users}, ensure_ascii=False).encode()
        doc = {"document": (DB_NAME, data, "application/json")}
        chat = self.admins[0]
        try:
            if self._msg_id:
                r = await self.tg_upload("editMessageMedia", doc, chat_id=chat, message_id=self._msg_id,
                                         media=json.dumps({"type": "document", "media": "attach://document", "caption": CAPTION}))
                desc = str(r.get("description", ""))
                if r.get("ok") or "not modified" in desc:
                    return
                log.info("db: edit failed (%s), sending new file", desc)
            r = await self.tg_upload("sendDocument", doc, chat_id=chat, disable_notification="true", caption=CAPTION)
            if not r.get("ok"):
                log.warning("db save failed: %s", r.get("description"))
                self._dirty = True
                return
            self._msg_id = r["result"]["message_id"]
            await self.tg("pinChatMessage", chat_id=chat, message_id=self._msg_id, disable_notification=True)
        except Exception as e:
            self._dirty = True
            log.warning("db save error: %s", e)

    async def load(self):
        if not (self.admins and self.tg):
            return
        try:
            r = await self.tg("getChat", chat_id=self.admins[0])
            pm = (r.get("result") or {}).get("pinned_message") or {}
            doc = pm.get("document") or {}
            if doc.get("file_name") != DB_NAME:
                log.info("db: pinned database not found, starting empty")
                return
            f = await self.tg("getFile", file_id=doc["file_id"])
            raw = await self.download(f["result"]["file_path"])
            self.users = json.loads(raw).get("users", {})
            self._msg_id = pm["message_id"]
            log.info("db: loaded %d users", len(self.users))
        except Exception as e:
            log.warning("db load error: %s", e)
