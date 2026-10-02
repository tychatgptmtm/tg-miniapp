"""Markdown от нейросети -> HTML для Telegram (+ разбиение длинных ответов)."""
import re

LIMIT = 3500  # запас до лимита Telegram в 4096 символов


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _inline(t):
    """Форматирование внутри строки (без блоков кода)."""
    keep = []

    def stash(html):
        keep.append(html)
        return f"\x00{len(keep) - 1}\x00"

    t = re.sub(r"`([^`\n]+)`", lambda m: stash(f"<code>{esc(m.group(1))}</code>"), t)
    t = re.sub(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)",
               lambda m: stash(f'<a href="{esc(m.group(2)).replace(chr(34), "&quot;")}">{esc(m.group(1))}</a>'), t)
    t = esc(t)
    t = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"__(?=\S)(.+?)(?<=\S)__", r"<u>\1</u>", t)
    t = re.sub(r"(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\w*])", r"<i>\1</i>", t)
    t = re.sub(r"(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])", r"<i>\1</i>", t)
    t = re.sub(r"~~(?=\S)(.+?)(?<=\S)~~", r"<s>\1</s>", t)
    t = re.sub(r"\|\|(?=\S)(.+?)(?<=\S)\|\|", r'<tg-spoiler>\1</tg-spoiler>', t)
    return re.sub(r"\x00(\d+)\x00", lambda m: keep[int(m.group(1))], t)


def _table(lines):
    rows = [[c.strip() for c in l.strip().strip("|").split("|")] for l in lines
            if not re.fullmatch(r"\s*\|?[\s:\-|]+\|?\s*", l)]
    rows = [[re.sub(r"\*\*|`", "", c) for c in r] for r in rows]
    n = max(len(r) for r in rows)
    w = [max(len(r[i]) if i < len(r) else 0 for r in rows) for i in range(n)]
    out = ["  ".join((r[i] if i < len(r) else "").ljust(w[i]) for i in range(n)).rstrip() for r in rows]
    return "<pre>" + esc("\n".join(out)) + "</pre>"


def md_to_html(md):
    out, lines, i = [], md.replace("\r\n", "\n").split("\n"), 0
    quote = []

    def flush_quote():
        if quote:
            out.append("<blockquote>" + "\n".join(quote) + "</blockquote>")
            quote.clear()

    while i < len(lines):
        line = lines[i]
        m = re.match(r"\s*```\s*([\w+#.-]*)", line)
        if m:
            flush_quote()
            lang, body, i = m.group(1), [], i + 1
            while i < len(lines) and not re.match(r"\s*```\s*$", lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            code = esc("\n".join(body))
            out.append(f'<pre><code class="language-{lang}">{code}</code></pre>' if lang else f"<pre>{code}</pre>")
            continue
        if line.strip().startswith("|") and i + 1 < len(lines) and re.fullmatch(r"\s*\|?[\s:\-|]+\|?\s*", lines[i + 1]) and "-" in lines[i + 1]:
            flush_quote()
            tbl = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                tbl.append(lines[i])
                i += 1
            out.append(_table(tbl))
            continue
        if line.startswith(">"):
            quote.append(_inline(line.lstrip(">").strip()))
            i += 1
            continue
        flush_quote()
        if m := re.match(r"\s*#{1,6}\s+(.*)", line):
            out.append(f"<b>{_inline(m.group(1).strip('# '))}</b>")
        elif re.fullmatch(r"\s*([-*_])\s*(\1\s*){2,}", line):
            out.append("——————")
        elif m := re.match(r"(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)", line):
            box = {" ": "☐ ", "x": "☑ ", "X": "☑ "}.get(m.group(2), "")
            out.append(f"{'   ' * (len(m.group(1)) // 2)}• {box}{_inline(m.group(3))}")
        elif m := re.match(r"(\s*)(\d+)[.)]\s+(.*)", line):
            out.append(f"{'   ' * (len(m.group(1)) // 2)}{m.group(2)}. {_inline(m.group(3))}")
        else:
            out.append(_inline(line))
        i += 1
    flush_quote()
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def split_md(md, limit=LIMIT):
    """Режем длинный ответ по абзацам, не разрывая блоки кода."""
    if len(md) <= limit:
        return [md]
    parts, cur, in_code, fence = [], "", False, ""
    for line in md.split("\n"):
        if len(cur) + len(line) + 1 > limit and cur:
            if in_code:
                cur += "\n```"
            parts.append(cur)
            cur = fence if in_code else ""
        while len(line) > limit:
            parts.append(line[:limit])
            line = line[limit:]
        cur = (cur + "\n" + line) if cur else line
        if re.match(r"\s*```", line):
            in_code = not in_code
            fence = line.strip() if in_code else ""
    if cur:
        parts.append(cur)
    return parts


def strip_md(md):
    """Запасной вариант без форматирования."""
    return re.sub(r"\*\*|__|~~|`{1,3}", "", md)
