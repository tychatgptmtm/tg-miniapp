// Лёгкий безопасный Markdown-рендерер (без внешних библиотек)
(function () {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const KW = /\b(const|let|var|function|return|if|else|for|while|class|import|from|export|def|async|await|try|except|catch|new|in|of|and|or|not|None|True|False|null|true|false|undefined|this|self|print|public|private|static|void|int|string|bool|struct|fn|pub|use|match|package|func|go|elif|lambda|with|as|yield|switch|case|break|continue|interface|type|extends|implements|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|ORDER|BY|GROUP)\b/g;

  function highlight(code) {
    // токенизация: комментарии и строки, затем ключевые слова/числа в остальном тексте
    const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/g;
    let out = '', last = 0, m;
    const plain = t => esc(t).replace(KW, '<span class="tk-k">$1</span>')
      .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tk-n">$1</span>')
      .replace(/\b([a-zA-Z_]\w*)(?=\()/g, '<span class="tk-f">$1</span>');
    while ((m = re.exec(code))) {
      out += plain(code.slice(last, m.index));
      const t = m[0], cls = /^(\/\/|#|\/\*)/.test(t) ? 'tk-c' : 'tk-s';
      out += `<span class="${cls}">${esc(t)}</span>`;
      last = re.lastIndex;
    }
    return out + plain(code.slice(last));
  }

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s)
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+|data:image\/[^)\s]+)\)/g, '<img class="md-img" src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
      .replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>').replace(/__([^_]+?)__/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>')
      .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  }

  function render(src) {
    if (!src) return '';
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    let html = '', i = 0;
    const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    while (i < lines.length) {
      let l = lines[i];
      const fence = l.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
      if (fence) {
        const buf = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
        i++;
        const lang = fence[2] || 'code', code = buf.join('\n');
        html += `<div class="code"><div class="code-head"><span>${esc(lang)}</span><button data-copy>Копировать</button></div><pre><code>${highlight(code)}</code></pre></div>`;
        continue;
      }
      if (!l.trim()) { i++; continue; }
      let h = l.match(/^(#{1,6})\s+(.*)/);
      if (h) { const n = Math.min(h[1].length, 4); html += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(l)) { html += '<hr>'; i++; continue; }
      if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(l); i += 2;
        let t = '<div class="tbl"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          t += '<tr>' + cells(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++;
        }
        html += t + '</tbody></table></div>'; continue;
      }
      if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${render(buf.join('\n'))}</blockquote>`; continue;
      }
      const li = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
      if (li) {
        const ordered = /\d/.test(li[2]), tag = ordered ? 'ol' : 'ul', base = li[1].length;
        let items = [], cur = null;
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
          if (m && m[1].length <= base + 1 && /\d/.test(m[2]) !== ordered) break;
          if (m && m[1].length <= base + 1) { cur = [m[3]]; items.push(cur); i++; }
          else if (lines[i].trim() && (/^\s{2,}/.test(lines[i]) || (m && m[1].length > base))) { cur.push(lines[i].replace(/^\s{2,4}/, '')); i++; }
          else if (!lines[i].trim() && i + 1 < lines.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i + 1])) { i++; }
          else break;
        }
        const start = ordered ? parseInt(li[2]) : 1;
        html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>` + items.map(it => {
          const [first, ...rest] = it;
          let task = first.match(/^\[([ xX])\]\s+(.*)/);
          const head = task ? `${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2])}` : inline(first);
          return `<li>${head}${rest.length ? render(rest.join('\n')) : ''}</li>`;
        }).join('') + `</${tag}>`;
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
      if (!buf.length) { buf.push(lines[i++]); }
      html += `<p>${buf.map(inline).join('<br>')}</p>`;
    }
    return html;
  }
  window.MD = { render, esc };
})();
