# AI Studio — Telegram Mini App

Чат с любыми моделями OpenRouter (по умолчанию stealth/space-bunny-alpha) + свои API,
загрузка и генерация изображений, галерея, история чатов.

## Файлы
- server.py — сервер (aiohttp): отдаёт приложение, проксирует запросы к ИИ, обслуживает бота
- static/ — само мини-приложение (index.html, app.css, app.js, md.js)

## Переменные окружения
| Имя | Обязательно | Что это |
|---|---|---|
| BOT_TOKEN | да | токен от @BotFather |
| OPENROUTER_API_KEY | да | ключ с openrouter.ai/keys |
| ALLOWED_USERS | рекомендуется | ваш Telegram ID (через запятую — несколько). Пусто = доступ всем |
| DEFAULT_MODEL | нет | модель по умолчанию |
| PUBLIC_URL | нет | адрес сайта (на Render подставляется сам) |

Деплой на Render: New → Web Service → репозиторий → Build `pip install -r requirements.txt`,
Start `python server.py`, Instance type Free. Подробная инструкция — в чате.
