/* AI Studio — Telegram Mini App */
(() => {
'use strict';
const tg = window.Telegram?.WebApp;
const $ = s => document.querySelector(s);
const esc = MD.esc;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const try_ = f => { try { return f(); } catch { } };
const haptic = (t = 'light') => try_(() => t === 'success' || t === 'error' || t === 'warning' ? tg.HapticFeedback.notificationOccurred(t)
  : t === 'select' ? tg.HapticFeedback.selectionChanged() : tg.HapticFeedback.impactOccurred(t));
const inTG = !!tg?.initData;
hydrateIcons();

/* ---------- Telegram & theme ---------- */
function applyTheme() {
  const dark = tg?.colorScheme ? tg.colorScheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const bg = dark ? '#06060b' : '#f4f3fa';
  try_(() => tg.setHeaderColor(bg)); try_(() => tg.setBackgroundColor(bg)); try_(() => tg.setBottomBarColor(bg));
}
if (tg) { tg.ready(); tg.expand(); try_(() => tg.disableVerticalSwipes()); tg.onEvent?.('themeChanged', applyTheme); }
applyTheme();

/* ---------- API ---------- */
async function api(path, body, signal) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET', signal,
    headers: { 'Content-Type': 'application/json', 'X-Init-Data': tg?.initData || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`, j = {};
    try { j = await r.json(); msg = j.error || msg; } catch { }
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); err.status = r.status;
    if (j.blocked) { err.blocked = true; showBlocked(err.message); }
    throw err;
  }
  return r;
}

/* ---------- IndexedDB ---------- */
const DB = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('ai-studio', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('chats', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, mode), q = fn(t.objectStore(store));
    t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); };
  return {
    all: () => tx('chats', 'readonly', s => s.getAll()),
    put: c => tx('chats', 'readwrite', s => s.put(c)),
    del: id => tx('chats', 'readwrite', s => s.delete(id)),
    clear: () => tx('chats', 'readwrite', s => s.clear()),
    get: k => tx('kv', 'readonly', s => s.get(k)),
    set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  };
})();

/* ---------- State ---------- */
const S = {
  config: { defaultModel: 'stealth/space-bunny-alpha' },
  chats: [], chat: null, models: [], orModels: [], favs: new Set(), providers: [],
  settings: { system: '', temp: 0.7, reason: 'off', showReason: true, maxTok: '', tools: true },
  lastModel: null, attachments: [], streaming: null, filter: 'all', galFilter: 'all', reasonOpen: {},
};
const saveSettings = () => DB.set('settings', S.settings);
const saveChat = c => { c.updatedAt = Date.now(); return DB.put(JSON.parse(JSON.stringify(c, (k, v) => k.startsWith('_') ? undefined : v))); };

/* ---------- Logos (Lobe Icons через наш сервер) ---------- */
const VENDOR_LOGO = { openai: 'openai', anthropic: 'claude-color', google: 'gemini-color', 'meta-llama': 'meta-color', mistralai: 'mistral-color',
  deepseek: 'deepseek-color', qwen: 'qwen-color', 'x-ai': 'grok', cohere: 'cohere-color', perplexity: 'perplexity-color', nvidia: 'nvidia-color',
  microsoft: 'microsoft-color', moonshotai: 'kimi-color', 'z-ai': 'zhipu-color', thudm: 'zhipu-color', minimax: 'minimax-color', openrouter: 'openrouter',
  amazon: 'nova-color', baidu: 'baidu-color', tencent: 'hunyuan-color', bytedance: 'bytedance-color', 'bytedance-seed': 'bytedance-color',
  'stepfun-ai': 'stepfun-color', nousresearch: 'nousresearch', 'black-forest-labs': 'flux', inflection: 'inflection', ai21: 'ai21', ibm: 'ibm', 'ibm-granite': 'ibm', liquid: 'liquid', 'arcee-ai': 'arcee-color', inception: 'inception', morph: 'morph' };
const PROV_LOGO = [['openai', 'openai'], ['gemini', 'gemini-color'], ['google', 'gemini-color'], ['groq', 'groq'], ['deepseek', 'deepseek-color'], ['mistral', 'mistral-color'],
  ['grok', 'grok'], ['xai', 'grok'], ['together', 'together-color'], ['openrouter', 'openrouter'], ['anthropic', 'claude-color'], ['claude', 'claude-color']];
const GRADS = ['linear-gradient(135deg,#a855f7,#6366f1)', 'linear-gradient(135deg,#3b82f6,#06b6d4)', 'linear-gradient(135deg,#ec4899,#f97316)', 'linear-gradient(135deg,#10b981,#06b6d4)', 'linear-gradient(135deg,#f59e0b,#ef4444)', 'linear-gradient(135deg,#6366f1,#ec4899)'];
const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const cleanName = n => n.replace(/^[^:]+:\s*/, '');
function logoSlug(m) {
  if (m.provider && m.provider !== 'or') {
    const n = (m.providerName + ' ' + (m.baseUrl || '')).toLowerCase();
    const hit = PROV_LOGO.find(([k]) => n.includes(k)); if (hit) return hit[1];
  }
  return VENDOR_LOGO[m.id.split('/')[0]] || '';
}
function logo(m, cls = '') {
  if (m.id?.startsWith('stealth/') || m.id === 'openrouter/free') return `<span class="logo spark ${cls}"><b></b></span>`;
  const slug = logoSlug(m), name = cleanName(m.name || m.id), ini = (name[0] || '?').toUpperCase();
  return `<span class="logo ${cls}" style="--lg:${GRADS[hash(m.id.split('/')[0] + (m.providerName || '')) % GRADS.length]}"><b>${esc(ini)}</b>${slug ? `<img src="/logo/${slug}.svg" alt="" loading="lazy" onload="this.parentNode.classList.add('ok')" onerror="this.remove()">` : ''}</span>`;
}

/* ---------- Models ---------- */
const fmtCtx = n => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1000) + 'K';
function caps(m, withCtx) {
  return (m.free ? '<span class="cap c-free">FREE</span>' : '') + (m.vision ? `<span class="cap c-vis">${icon('eye')}</span>` : '') +
    (m.imageOut ? `<span class="cap c-gen">${icon('wand')}</span>` : '') + (m.provider !== 'or' ? `<span class="cap c-own">${icon('key')}</span>` : '') +
    (withCtx && m.ctx ? `<span class="cap c-ctx">${fmtCtx(m.ctx)}</span>` : '');
}
function buildModels() {
  const list = S.orModels.map(m => ({ ...m, key: 'or::' + m.id, provider: 'or', providerName: 'OpenRouter' }));
  const orById = Object.fromEntries(S.orModels.map(m => [m.id, m]));
  for (const p of S.providers) for (const id of p.models) {
    const c = p.baseUrl.includes('openrouter.ai') && orById[id];
    list.push({ id, name: c?.name || id, key: p.id + '::' + id, provider: p.id, providerName: p.name, baseUrl: p.baseUrl,
      vision: c ? c.vision : !!p.vision, imageOut: c ? c.imageOut : false, textOut: c ? c.textOut : true, free: false, ctx: c?.ctx || 0 });
  }
  S.models = list;
}
function getModel(key) {
  key ||= S.chat?.model || S.lastModel || 'or::' + S.config.defaultModel;
  const m = S.models.find(x => x.key === key);
  if (m) return m;
  const [prov, ...rest] = key.split('::'); const id = rest.join('::');
  const p = S.providers.find(x => x.id === prov);
  return { key, id, name: id.split('/').pop(), provider: prov, providerName: prov === 'or' ? 'OpenRouter' : p?.name || 'API', vision: true, textOut: true };
}
async function loadModels() {
  try { S.orModels = await (await api('/api/models')).json(); } catch (e) { toast('Не удалось загрузить модели: ' + e.message, 'alert'); }
  buildModels(); renderHeader(); if ($('#sheetModels').classList.contains('on')) renderModelList();
}

/* ---------- Layers & BackButton ---------- */
const layers = [];
const isOverlay = el => el.classList.contains('sheet') || el.id === 'drawer';
function syncBack() { if (!tg?.BackButton) return; layers.length ? tg.BackButton.show() : tg.BackButton.hide(); }
tg?.BackButton?.onClick(() => closeTop());
function openLayer(el, onClose) {
  if (layers.some(l => l.el === el)) return;
  el.classList.add('on'); layers.push({ el, onClose });
  if (isOverlay(el)) $('#scrim').classList.add('on');
  syncBack(); haptic('light');
}
function closeLayer(el) {
  const i = layers.findIndex(l => l.el === el); if (i < 0) return;
  const [l] = layers.splice(i, 1); el.classList.remove('on'); l.onClose?.();
  if (!layers.some(x => isOverlay(x.el))) $('#scrim').classList.remove('on');
  syncBack();
}
const closeTop = () => layers.length && closeLayer(layers[layers.length - 1].el);
$('#scrim').onclick = closeTop;
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeTop);
document.querySelectorAll('.sheet').forEach(sh => {
  let y0 = null, dy = 0;
  const start = e => { if (e.target.closest('input,textarea,button')) return; y0 = e.touches[0].clientY; dy = 0; sh.style.transition = 'none'; };
  sh.querySelectorAll('.sheet-grip,.sheet-head').forEach(h => h.addEventListener('touchstart', start, { passive: true }));
  sh.addEventListener('touchmove', e => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sh.addEventListener('touchend', () => { if (y0 == null) return; sh.style.transition = ''; sh.style.transform = ''; if (dy > 90) closeLayer(sh); y0 = null; });
});

/* ---------- Toast ---------- */
let toastT;
function toast(t, ic = 'check') { const el = $('#toast'); el.innerHTML = icon(ic) + `<span>${esc(t)}</span>`; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2600); }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); } catch {
    const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  haptic('success'); toast('Скопировано', 'copy');
}
const confirmBox = text => new Promise(res => tg?.showConfirm && inTG ? tg.showConfirm(text, ok => res(ok)) : res(confirm(text)));

/* ---------- Header & hero ---------- */
const sphere = FX.Sphere($('#sphere'));
function renderHeader() {
  const m = getModel();
  $('#chipLogo').innerHTML = logo(m);
  $('#modelName').textContent = cleanName(m.name);
  $('#modelSub').innerHTML = `${esc(m.provider === 'or' ? (m.id.split('/')[0]) : m.providerName)}${m.vision ? icon('eye') : ''}${m.imageOut ? icon('wand') : ''}${m.free ? ' · free' : ''}`;
  $('#btnAttach').classList.toggle('off', !m.vision);
  $('#input').placeholder = m.imageOut ? 'Опишите, что нарисовать' : 'Спросите что угодно';
  renderEmpty();
}
const SUG_TEXT = [['bulb', 'Объясни', 'как работают нейросети', 0], ['pen', 'Напиши пост', 'для Telegram-канала о путешествиях', 2], ['code', 'Помоги с кодом', 'бот для Telegram на Python', 1], ['globe', 'Переведи', 'текст на английский язык', 3]];
const SUG_IMG = [['moon', 'Космос', 'кот-астронавт в стиле аниме', 0], ['city', 'Город', 'футуристичный мегаполис на закате', 1], ['coffee', 'Логотип', 'для кофейни, минимализм', 4], ['leaf', 'Акварель', 'лиса в осеннем лесу', 3]];
const TYPE_TEXT = ['составь план тренировок на неделю', 'объясни квантовую физику как пятилетнему', 'придумай название для стартапа', 'разбери ошибку в моём коде', 'напиши письмо начальнику'];
const TYPE_IMG = ['неоновый самурай под дождём', 'уютная кофейня в стиле Гибли', 'кристальный дракон над облаками', 'постер ретро-синтвейв'];
const SHADOWS = ['rgba(168,85,247,.6)', 'rgba(59,130,246,.6)', 'rgba(236,72,153,.6)', 'rgba(16,185,129,.6)', 'rgba(245,158,11,.6)', 'rgba(99,102,241,.6)'];
let lastEmptyKind = '';
function renderEmpty() {
  const has = S.chat?.messages.length;
  $('#empty').classList.toggle('hidden', !!has);
  if (has) return;
  const m = getModel(), kind = m.imageOut ? 'img' : 'text';
  if (kind === lastEmptyKind && $('#suggest').children.length) return;
  lastEmptyKind = kind;
  $('#suggest').innerHTML = (kind === 'img' ? SUG_IMG : SUG_TEXT).map(([ic, a, b, g], n) =>
    `<button data-q="${esc(a + ': ' + b)}" style="--n:${n};--sg:${GRADS[g]};--sgs:${SHADOWS[g]}"><div class="sg-ic">${icon(ic)}</div><b>${esc(a)}</b><span>${esc(b)}</span></button>`).join('');
  $('#typerPrefix').textContent = kind === 'img' ? 'Нарисуй:' : 'Попробуйте:';
  FX.typer($('#typer'), kind === 'img' ? TYPE_IMG : TYPE_TEXT);
}
$('#suggest').addEventListener('pointerdown', e => { const b = e.target.closest('button'); if (!b) return; const r = b.getBoundingClientRect(); b.style.setProperty('--mx', e.clientX - r.left + 'px'); b.style.setProperty('--my', e.clientY - r.top + 'px'); });
$('#suggest').onclick = e => { const b = e.target.closest('[data-q]'); if (!b) return; sphere.pulse(); input.value = b.dataset.q; autosize(); updateSend(); send(); };

/* ---------- Chats ---------- */
function newChat(focus) {
  if (S.streaming) stop();
  S.chat = { id: uid(), title: 'Новый чат', model: getModel().key, messages: [], updatedAt: Date.now() };
  lastEmptyKind = ''; renderChat(); renderHeader(); if (focus) input.focus();
}
function openChat(id) {
  if (S.streaming) stop();
  S.chat = S.chats.find(c => c.id === id); renderChat(); renderHeader(); renderChatList(); scrollBottom(true);
}
function ensureSaved() { if (!S.chats.includes(S.chat)) S.chats.unshift(S.chat); }
function relTime(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'только что'; if (d < 3600) return Math.floor(d / 60) + ' мин назад'; if (d < 86400) return Math.floor(d / 3600) + ' ч назад';
  return new Date(t).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}
function renderChatList() {
  const list = [...S.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  $('#chatList').innerHTML = list.length ? list.map((c, n) => `<div class="chat-item ${c === S.chat ? 'on' : ''}" data-id="${c.id}" style="--n:${n + 2}">
    ${logo(getModel(c.model), 'sm')}<div class="t"><b>${esc(c.title)}</b><small>${relTime(c.updatedAt)}</small></div>
    <button class="del" data-del="${c.id}">${icon('trash')}</button></div>`).join('') : '<div class="no-chats">Пока пусто — начните первый диалог</div>';
  document.querySelectorAll('.drawer-nav button').forEach((b, i) => b.style.setProperty('--n', i));
  $('#galleryCount').textContent = galleryItems().length || '';
}
$('#chatList').onclick = async e => {
  const d = e.target.closest('[data-del]');
  if (d) { if (!await confirmBox('Удалить этот чат?')) return;
    S.chats = S.chats.filter(c => c.id !== d.dataset.del); await DB.del(d.dataset.del);
    if (S.chat?.id === d.dataset.del) newChat(); renderChatList(); return; }
  const it = e.target.closest('.chat-item'); if (it) { openChat(it.dataset.id); closeLayer($('#drawer')); }
};

/* ---------- Messages ---------- */
function imgsHtml(imgs, cls, reveal) { return imgs?.length ? `<div class="imgs ${cls}">${imgs.map(u => `<img src="${u}" ${reveal ? 'class="reveal"' : ''} loading="lazy" alt="">`).join('')}</div>` : ''; }
function renderChat() {
  const box = $('#messages'); box.innerHTML = '';
  for (const m of S.chat.messages) box.appendChild(msgEl(m));
  renderEmpty();
}
function msgEl(m) {
  const el = document.createElement('div'); el.className = 'msg ' + m.role; el.dataset.id = m.id;
  if (m.role === 'user') {
    el.innerHTML = `<div class="body">${imgsHtml(m.images, '')}${m.content ? `<div class="bubble">${esc(m.content)}</div>` : ''}
      <div class="actions"><button data-act="copy">${icon('copy')}</button><button data-act="edit">${icon('pen')}</button></div></div>`;
  } else {
    el.innerHTML = `<div class="ai-ava"></div><div class="body"><div class="meta"></div><div class="s-reason"></div><div class="s-tools"></div><div class="s-imgs"></div><div class="md"></div><div class="s-files"></div><div class="s-status"></div><div class="s-err"></div><div class="actions"></div></div>`;
    el._imgCount = -1; patchAssistant(el, m);
  }
  return el;
}
const CARET = '<span class="caret"></span>';
function patchAssistant(el, m) {
  const q = s => el.querySelector(s), model = getModel(m.model);
  el.classList.toggle('pending', !!m.pending);
  q('.meta').innerHTML = `${esc(cleanName(model.name))}${m.ms ? `<span class="t">· ${(m.ms / 1000).toFixed(1)} с</span>` : ''}`;
  // reasoning
  const rs = q('.s-reason');
  if (m.reasoning && S.settings.showReason) {
    if (!rs.firstChild) {
      rs.innerHTML = `<details class="reason"><summary>${icon('brain')}<span></span>${icon('chevDown', 'chev')}</summary><div class="rtext"></div></details>`;
      const det = rs.firstChild; det.open = S.reasonOpen[m.id] ?? !!m.pending;
      det.addEventListener('toggle', () => S.reasonOpen[m.id] = det.open);
    }
    const thinking = m.pending && !m.content, sp = rs.querySelector('summary span');
    sp.className = thinking ? 'shimmer' : ''; sp.textContent = thinking ? 'Размышляет' : 'Ход мыслей';
    const rt = rs.querySelector('.rtext'); rt.textContent = m.reasoning; if (m.pending) rt.scrollTop = rt.scrollHeight;
  } else rs.innerHTML = '';
  // images
  const n = m.images?.length || 0;
  if (n !== el._imgCount) { q('.s-imgs').innerHTML = imgsHtml(m.images, 'gen', el._imgCount !== -1); el._imgCount = n; }
  // tools
  const tl = m.tools || [], tk = tl.map(t => t.id + t.status).join();
  if (tk !== el._toolKey) { el._toolKey = tk; q('.s-tools').innerHTML = tl.length ? `<div class="tools">${tl.map(t => `<div class="tool ${t.status === 'done' ? 'done' : 'run'}">
      <span class="t-ic">${t.status === 'done' ? icon('check') : '<i class="spin"></i>'}</span>${icon(toolIcon(t.name))}<span class="${t.status === 'done' ? '' : 'shimmer'}">${esc(t.label || t.name)}</span></div>`).join('')}</div>` : ''; }
  // files
  const fl = m.files || [];
  if (fl.length !== el._fileCount) { el._fileCount = fl.length; q('.s-files').innerHTML = fl.length ? `<div class="files">${fl.map((f, i) => `<button class="fcard" data-dl="${i}" style="--n:${i}">
      <span class="f-ic ${fileKind(f.name)}">${icon(fileIcon(f.name))}<em>${esc(ext(f.name))}</em></span><span class="f-t"><b>${esc(f.name)}</b><small>${fmtSize(f.size)} · отправлен в чат с ботом</small></span><span class="f-dl">${icon('download')}</span></button>`).join('')}</div>` : ''; }
  // text + курсор
  const md = q('.md'); md.innerHTML = MD.render(m.content || '');
  if (m.pending && m.content) {
    let t = md.lastElementChild;
    while (t && t.lastElementChild && /^(UL|OL|LI|BLOCKQUOTE)$/.test(t.tagName)) t = t.lastElementChild;
    if (t && /^(P|LI|H[1-4])$/.test(t.tagName)) t.insertAdjacentHTML('beforeend', CARET); else md.insertAdjacentHTML('beforeend', CARET);
  }
  // status
  const state = m.pending && !n && model.imageOut ? 'gen' : m.pending && !m.content && !(m.reasoning && S.settings.showReason) && !(m.tools || []).some(t => t.status !== 'done') ? 'think' : '';
  if (el._st !== state) {
    el._st = state; const st = q('.s-status');
    if (state === 'gen') { st.innerHTML = `<div class="gen-ph"><canvas></canvas><div class="gp-label">${icon('wand')}<span class="shimmer" style="--muted:#ddd;--text:#fff">Создаю изображение</span></div></div>`; FX.latent(st.querySelector('canvas')); }
    else if (state === 'think') st.innerHTML = '<div class="thinking"><div class="dots"><i></i><i></i><i></i></div><span class="shimmer">Думаю</span></div>';
    else st.innerHTML = '';
  }
  q('.s-err').innerHTML = m.error ? `<div class="err">${icon('alert')}<span>${esc(m.error)}</span></div>` : '';
  q('.actions').innerHTML = m.pending ? '' : `${m.content ? `<button data-act="copy">${icon('copy')}</button>` : ''}<button data-act="regen">${icon('refresh')}</button><button data-act="del">${icon('trash')}</button>`;
}
const ext = n => (n.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toUpperCase();
const fileKind = n => /\.(zip|rar|7z|tar|gz)$/i.test(n) ? 'k-zip' : /\.(xlsx|xls|csv)$/i.test(n) ? 'k-xls' : /\.(docx?|pdf|txt|md|rtf)$/i.test(n) ? 'k-doc' : /\.(py|js|ts|html|css|json|java|c|cpp|go|rs|sh|php|sql|xml|yaml|yml)$/i.test(n) ? 'k-code' : 'k-any';
const fileIcon = n => ({ 'k-zip': 'archive', 'k-xls': 'sheet', 'k-code': 'code' })[fileKind(n)] || 'file';
const toolIcon = n => ({ create_files: 'file', web_search: 'search', fetch_url: 'globe' })[n] || 'wrench';
const fmtSize = b => b < 1024 ? `${b} Б` : b < 1048576 ? `${(b / 1024).toFixed(1)} КБ` : `${(b / 1048576).toFixed(1)} МБ`;
function downloadFile(f) {
  const url = new URL(f.url, location.href).href; haptic();
  if (inTG && tg.downloadFile && tg.isVersionAtLeast?.('8.0')) {
    try { tg.downloadFile({ url, file_name: f.name }, ok => ok && toast('Загрузка началась', 'download')); return; } catch { }
  }
  if (inTG && tg.openLink) { tg.openLink(url); return; }
  const a = document.createElement('a'); a.href = url; a.download = f.name; a.target = '_blank'; a.click();
}
const findMsgEl = id => $('#messages').querySelector(`.msg[data-id="${id}"]`);

$('#messages').addEventListener('click', e => {
  const img = e.target.closest('.imgs img, .md img');
  if (img) { openViewerBySrc(img.src); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { copyText(cp.closest('.code').querySelector('code').textContent); cp.textContent = 'Готово'; setTimeout(() => cp.textContent = 'Копировать', 1500); return; }
  const dl = e.target.closest('[data-dl]');
  if (dl) { const m = S.chat.messages.find(x => x.id === dl.closest('.msg').dataset.id); const f = m?.files?.[+dl.dataset.dl]; if (f) downloadFile(f); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const id = a.closest('.msg').dataset.id, msgs = S.chat.messages, i = msgs.findIndex(m => m.id === id), m = msgs[i];
  const act = a.dataset.act;
  if (act === 'copy') copyText(m.content);
  if (act === 'edit' && !S.streaming) {
    msgs.splice(i); S.attachments = [...(m.images || [])];
    input.value = m.content; autosize(); renderAttachments(); updateSend(); renderChat(); saveChat(S.chat); input.focus();
  }
  if (act === 'regen' && !S.streaming) { msgs.splice(i); renderChat(); haptic('medium'); runCompletion(); }
  if (act === 'del') { msgs.splice(i, 1); const el = findMsgEl(id); el.style.transition = 'all .3s'; el.style.opacity = 0; el.style.transform = 'scale(.95)'; setTimeout(() => el.remove(), 300); saveChat(S.chat); setTimeout(renderEmpty, 310); }
});

/* ---------- Scrolling ---------- */
const sc = $('#scroller');
const nearBottom = () => sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
function scrollBottom(force) { if (force || nearBottom()) sc.scrollTop = sc.scrollHeight; }
sc.addEventListener('scroll', () => $('#toBottom').classList.toggle('hidden', nearBottom()), { passive: true });
$('#toBottom').onclick = () => sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });

/* ---------- Composer ---------- */
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
function updateSend() {
  const b = $('#btnSend');
  b.classList.toggle('stop', !!S.streaming);
  b.disabled = !S.streaming && !input.value.trim() && !S.attachments.length;
  $('#app').classList.toggle('busy', !!S.streaming);
}
input.addEventListener('input', () => { autosize(); updateSend(); });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send(); } });
$('#btnSend').onclick = () => S.streaming ? stop() : send();
$('#btnAttach').onclick = () => {
  if (!getModel().vision) { toast('Эта модель не видит изображения', 'eye'); haptic('error'); return; }
  $('#file').click();
};
$('#file').onchange = async e => { for (const f of e.target.files) await addFile(f); e.target.value = ''; };
input.addEventListener('paste', async e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length && getModel().vision) { e.preventDefault(); for (const f of files) await addFile(f); }
});
async function addFile(f) {
  if (!f.type.startsWith('image/')) return;
  if (S.attachments.length >= 6) { toast('Максимум 6 изображений', 'alert'); return; }
  try { S.attachments.push(await compress(f)); renderAttachments(); updateSend(); haptic(); }
  catch { toast('Не удалось открыть изображение', 'alert'); }
}
function compress(file, max = 1600) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = rej; img.src = url;
  });
}
function renderAttachments() {
  $('#attachments').innerHTML = S.attachments.map((u, i) => `<div class="att"><img src="${u}"><button data-rm="${i}">${icon('x')}</button></div>`).join('');
}
$('#attachments').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { S.attachments.splice(+b.dataset.rm, 1); renderAttachments(); updateSend(); haptic(); } };

/* ---------- Sending ---------- */
function send() {
  const text = input.value.trim();
  if (S.streaming || (!text && !S.attachments.length)) return;
  const model = getModel();
  const m = { id: uid(), role: 'user', content: text, images: model.vision ? [...S.attachments] : [] };
  S.chat.messages.push(m);
  if (S.chat.title === 'Новый чат') S.chat.title = (text || 'Изображение').slice(0, 48);
  S.chat.model = model.key; ensureSaved();
  input.value = ''; S.attachments = []; autosize(); renderAttachments();
  $('#messages').appendChild(msgEl(m)); renderEmpty(); scrollBottom(true); haptic('medium');
  runCompletion();
}
function buildMessages(model) {
  const sys = S.settings.system.trim(), out = [];
  const msgs = S.chat.messages.filter(m => m.role === 'user' || (!m.error && (m.content || m.images?.length))).slice(-30);
  let imgBudget = 4;
  const lastGen = [...S.chat.messages].reverse().find(m => m.role === 'assistant' && m.images?.length)?.images.slice(-1)[0];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user') {
      let imgs = model.vision && imgBudget > 0 ? (m.images || []) : [];
      if (i === msgs.length - 1 && !imgs.length && model.vision && model.imageOut && lastGen) imgs = [lastGen];
      if (imgs.length) imgBudget--;
      const text = m.content || (m.images?.length ? 'Посмотри на изображение' : '');
      out.unshift(imgs.length ? { role: 'user', content: [{ type: 'text', text }, ...imgs.map(url => ({ type: 'image_url', image_url: { url } }))] }
        : { role: 'user', content: text + (m.images?.length && !model.vision ? ' [пользователь прикрепил изображение]' : '') });
    } else {
      let c = m.content || (m.images?.length ? '[сгенерировано изображение]' : '');
      if (m.files?.length) c += `\n\n[Созданы и отправлены пользователю файлы: ${m.files.map(f => f.name).join(', ')}]`;
      out.unshift({ role: 'assistant', content: c.trim() || '…' });
    }
  }
  if (sys) out.unshift({ role: 'system', content: sys });
  return out;
}
async function runCompletion() {
  const model = getModel();
  const am = { id: uid(), role: 'assistant', content: '', reasoning: '', images: [], tools: [], files: [], model: model.key, pending: true };
  const messages = buildMessages(model);
  S.chat.messages.push(am);
  const el = msgEl(am); $('#messages').appendChild(el); scrollBottom(true);
  const ctrl = new AbortController(); S.streaming = { ctrl, am }; updateSend(); sphere.setActive(true);
  const t0 = Date.now();
  const body = { model: model.id, messages, temperature: +S.settings.temp };
  if (+S.settings.maxTok > 0) body.max_tokens = +S.settings.maxTok;
  if (S.settings.reason !== 'off') body.reasoning = { effort: S.settings.reason };
  if (S.settings.tools && !model.imageOut) body.tools = true;
  if (model.imageOut) body.modalities = model.textOut === false ? ['image'] : ['image', 'text'];
  if (model.provider !== 'or') { const p = S.providers.find(x => x.id === model.provider); body.provider = { baseUrl: p?.baseUrl, apiKey: p?.apiKey }; }
  let raf = 0;
  const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; patchAssistant(el, am); scrollBottom(); }); };
  try {
    const res = await api('/api/chat', body, ctrl.signal);
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        if (j.x_tool) { const t = am.tools.find(x => x.id === j.x_tool.id); if (t) Object.assign(t, j.x_tool); else am.tools.push(j.x_tool); haptic('select'); schedule(); continue; }
        if (j.x_file) { am.files.push(j.x_file); haptic('success'); schedule(); continue; }
        const ch = j.choices?.[0]; if (!ch) continue;
        const delta = ch.delta || ch.message || {};
        if (typeof delta.content === 'string') am.content += delta.content;
        else if (Array.isArray(delta.content)) for (const p of delta.content) { if (p.type === 'text') am.content += p.text; if (p.type === 'image_url') am.images.push(p.image_url.url); }
        if (delta.reasoning) am.reasoning += delta.reasoning; else if (delta.reasoning_content) am.reasoning += delta.reasoning_content;
        for (const im of delta.images || []) { const u = im.image_url?.url || im.url; if (u) am.images.push(u); }
        if (ch.finish_reason === 'error') throw new Error('Модель вернула ошибку');
        schedule();
      }
    }
    if (!am.content && !am.images.length && !am.files.length) am.error = 'Пустой ответ. Попробуйте ещё раз или выберите другую модель.';
    haptic('success');
  } catch (e) {
    if (e.name === 'AbortError') { if (!am.content && !am.images.length && !am.files.length) am.error = 'Остановлено'; }
    else { am.error = friendlyError(e.message); haptic('error'); }
  } finally {
    cancelAnimationFrame(raf);
    am.tools.forEach(t => t.status = 'done'); if (!am.tools.length) delete am.tools; if (!am.files.length) delete am.files;
    am.pending = false; am.ms = Date.now() - t0; delete S.reasonOpen[am.id];
    S.streaming = null; updateSend(); sphere.setActive(false);
    const d = el.querySelector('details'); if (d) d.open = false;
    patchAssistant(el, am); scrollBottom();
    await saveChat(S.chat); renderChatList();
  }
}
function friendlyError(m) {
  if (/data policy|No endpoints found matching/i.test(m)) return m + '\n\nВключите бесплатные модели: openrouter.ai → Settings → Privacy.';
  if (/rate.?limit|429/i.test(m)) return 'Слишком много запросов к модели (лимит бесплатного тарифа). Подождите минуту или выберите другую модель.';
  if (/credits|402|insufficient/i.test(m)) return 'Недостаточно средств на OpenRouter для этой модели. Выберите бесплатную (FREE).';
  return m;
}
function stop() { S.streaming?.ctrl.abort(); }

/* ---------- Model picker ---------- */
const FILTERS = [['all', 'Все', 'layers'], ['fav', 'Избранное', 'star'], ['free', 'Бесплатные', 'gift'], ['vision', 'Видят фото', 'eye'], ['gen', 'Рисуют', 'wand'], ['own', 'Мои API', 'key']];
$('#modelFilters').innerHTML = FILTERS.map(([k, t, ic]) => `<button class="chip" data-f="${k}">${icon(ic)}${t}</button>`).join('');
$('#modelFilters').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.filter = b.dataset.f; haptic('select'); renderModelList(); };
$('#modelSearch').oninput = () => renderModelList();
$('#btnModel').onclick = () => { renderModelList(); openLayer($('#sheetModels')); if (!S.orModels.length) loadModels(); };
function modelRow(m, cur, n) {
  return `<div class="model-row ${m.key === cur ? 'on' : ''}" data-key="${esc(m.key)}" role="button" style="--n:${n}">
    ${logo(m)}<div class="t"><b>${esc(cleanName(m.name))}</b><small>${caps(m, true)}<span>${esc(m.provider === 'or' ? m.id : m.providerName + ' · ' + m.id)}</span></small></div>
    <button class="star ${S.favs.has(m.key) ? 'on' : ''}" data-star="${esc(m.key)}">${icon('star')}</button></div>`;
}
function renderModelList() {
  document.querySelectorAll('#modelFilters .chip').forEach(c => c.classList.toggle('on', c.dataset.f === S.filter));
  const q = $('#modelSearch').value.trim().toLowerCase(), cur = getModel().key, f = S.filter;
  let list = S.models.filter(m => m.textOut !== false || m.imageOut);
  if (q) list = list.filter(m => (m.name + ' ' + m.id + ' ' + m.providerName).toLowerCase().includes(q));
  if (f === 'fav') list = list.filter(m => S.favs.has(m.key));
  if (f === 'free') list = list.filter(m => m.free);
  if (f === 'vision') list = list.filter(m => m.vision);
  if (f === 'gen') list = list.filter(m => m.imageOut);
  if (f === 'own') list = list.filter(m => m.provider !== 'or');
  const def = 'or::' + S.config.defaultModel;
  list.sort((a, b) => (b.key === def) - (a.key === def) || (b.created || 0) - (a.created || 0));
  $('#modelsCount').textContent = list.length || '';
  const favs = f === 'all' && !q ? list.filter(m => S.favs.has(m.key)) : [];
  const rest = favs.length ? list.filter(m => !S.favs.has(m.key)) : list;
  const LIMIT = 150; let n = 0, h = '';
  if (favs.length) h += `<div class="group-label">Избранное</div>` + favs.map(m => modelRow(m, cur, n++)).join('') + `<div class="group-label">Все модели</div>`;
  h += rest.slice(0, LIMIT).map(m => modelRow(m, cur, n++)).join('');
  if (rest.length > LIMIT) h += `<div class="hint" style="text-align:center;padding:14px">и ещё ${rest.length - LIMIT} — уточните поиск</div>`;
  if (!list.length) h = `<div class="empty-small"><div class="es-ic">${icon(S.models.length ? 'search' : 'layers')}</div>${S.models.length ? 'Ничего не найдено' : 'Загружаю модели…'}${f === 'own' && !S.providers.length ? '<br><br><button class="btn primary" id="goAddProv">' + icon('plus') + 'Добавить свой API</button>' : ''}</div>`;
  $('#modelList').innerHTML = h;
  $('#goAddProv')?.addEventListener('click', () => openProvider());
}
$('#modelList').onclick = e => {
  const st = e.target.closest('[data-star]');
  if (st) { const k = st.dataset.star; S.favs.has(k) ? S.favs.delete(k) : S.favs.add(k); DB.set('favs', [...S.favs]); haptic('select'); st.classList.toggle('on'); return; }
  const r = e.target.closest('[data-key]'); if (!r) return;
  S.lastModel = r.dataset.key; DB.set('lastModel', S.lastModel);
  S.chat.model = r.dataset.key; if (S.chats.includes(S.chat)) saveChat(S.chat);
  haptic('select'); renderHeader(); closeLayer($('#sheetModels')); sphere.pulse();
  if (S.attachments.length && !getModel().vision) toast('Эта модель не видит изображения', 'eye');
};

/* ---------- Drawer ---------- */
$('#btnMenu').onclick = () => { renderChatList(); openLayer($('#drawer')); };
$('#btnNew').onclick = () => { haptic('medium'); newChat(true); };
$('#drawerNew').onclick = () => { newChat(); closeLayer($('#drawer')); };
$('#navGallery').onclick = () => { closeLayer($('#drawer')); renderGallery(); openLayer($('#panelGallery')); };
$('#navAdmin').onclick = () => { closeLayer($('#drawer')); openLayer($('#panelAdmin')); loadAdmin(); };
$('#navSettings').onclick = () => { closeLayer($('#drawer')); renderSettings(); openLayer($('#sheetSettings')); };

/* ---------- Gallery & viewer ---------- */
function galleryItems() {
  const out = [];
  for (const c of [...S.chats].sort((a, b) => b.updatedAt - a.updatedAt))
    for (const m of [...c.messages].reverse())
      for (const src of m.images || []) out.push({ src, chatId: c.id, msgId: m.id, kind: m.role === 'user' ? 'up' : 'gen', caption: m.role === 'user' ? m.content : '' });
  return out;
}
let gal = [], galIdx = 0;
function renderGallery() {
  gal = galleryItems().filter(x => S.galFilter === 'all' || x.kind === S.galFilter);
  document.querySelectorAll('#galFilter button').forEach(b => b.classList.toggle('on', b.dataset.v === S.galFilter));
  $('#galleryGrid').innerHTML = gal.map((x, i) => `<button data-i="${i}" style="--n:${i}"><img src="${x.src}" loading="lazy" alt="">${x.kind === 'gen' ? `<span class="tag">${icon('sparkles')}AI</span>` : ''}</button>`).join('');
  $('#galleryEmpty').classList.toggle('hidden', gal.length > 0);
}
$('#galFilter').onclick = e => { const b = e.target.closest('[data-v]'); if (b) { S.galFilter = b.dataset.v; haptic('select'); renderGallery(); } };
$('#galleryGrid').onclick = e => { const b = e.target.closest('[data-i]'); if (b) openViewer(gal, +b.dataset.i); };
function openViewerBySrc(src) {
  let items = galleryItems(); if (!items.some(x => x.src === src)) items = [{ src, kind: 'gen' }];
  openViewer(items, Math.max(0, items.findIndex(x => x.src === src)));
}
function openViewer(items, i) { gal = items; galIdx = i; showViewer(); openLayer($('#viewer')); }
function showViewer() {
  const x = gal[galIdx], img = $('#viewerImg'); img.style.transform = ''; img.src = x.src;
  img.style.animation = 'none'; img.offsetHeight; img.style.animation = '';
  $('#viewerBg').style.backgroundImage = `url("${x.src}")`;
  $('#viewerInfo').textContent = `${galIdx + 1} из ${gal.length} · ${x.kind === 'gen' ? 'создано AI' : 'загружено'}`;
  $('#viewerPrev').classList.toggle('hidden', galIdx === 0); $('#viewerNext').classList.toggle('hidden', galIdx >= gal.length - 1);
  $('#vChat').classList.toggle('hidden', !x.chatId); $('#vDownload').classList.toggle('hidden', inTG);
}
const step = d => { const n = galIdx + d; if (n >= 0 && n < gal.length) { galIdx = n; haptic('select'); showViewer(); } };
$('#viewerPrev').onclick = () => step(-1); $('#viewerNext').onclick = () => step(1);
$('#viewerClose').onclick = () => closeLayer($('#viewer'));
(() => { let x0 = null, y0, lastTap = 0; const st = $('#viewerStage');
  st.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  st.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1); else if (dy > 110) closeLayer($('#viewer')); });
  st.addEventListener('click', e => { const now = Date.now(); if (now - lastTap < 300) { const im = $('#viewerImg'); im.style.transform = im.style.transform ? '' : 'scale(2)'; } else if (e.target === st) closeLayer($('#viewer')); lastTap = now; });
})();
$('#vSend').onclick = async () => {
  const b = $('#vSend'); b.disabled = true; toast('Отправляю в чат с ботом', 'send');
  try { const r = await (await api('/api/send-photo', { dataUrl: gal[galIdx].src, caption: gal[galIdx].caption || 'AI Studio' })).json();
    if (!r.ok) throw new Error(r.error || 'ошибка'); haptic('success'); toast('Отправлено — проверьте чат с ботом'); }
  catch (e) { toast('Не удалось: ' + e.message, 'alert'); } finally { b.disabled = false; }
};
$('#vDownload').onclick = () => { const a = document.createElement('a'); a.href = gal[galIdx].src; a.download = `ai-studio-${Date.now()}.${gal[galIdx].src.includes('image/png') ? 'png' : 'jpg'}`; a.click(); };
$('#vUse').onclick = () => {
  if (!getModel().vision) { toast('Текущая модель не видит изображения', 'eye'); return; }
  S.attachments.push(gal[galIdx].src); renderAttachments(); updateSend();
  closeLayer($('#viewer')); closeLayer($('#panelGallery')); toast('Изображение прикреплено', 'clip'); input.focus();
};
$('#vChat').onclick = () => {
  const x = gal[galIdx]; closeLayer($('#viewer')); closeLayer($('#panelGallery')); openChat(x.chatId);
  setTimeout(() => findMsgEl(x.msgId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
};

/* ---------- Settings ---------- */
function renderSettings() {
  const s = S.settings;
  $('#setSystem').value = s.system; $('#setTemp').value = s.temp; $('#tempVal').textContent = (+s.temp).toFixed(1);
  $('#setMaxTok').value = s.maxTok; $('#setShowReason').checked = s.showReason; $('#setTools').checked = s.tools;
  document.querySelectorAll('#setReason button').forEach(b => b.classList.toggle('on', b.dataset.v === s.reason));
  $('#providerList').innerHTML = S.providers.map(p => `<button class="prov" data-pid="${p.id}">${logo({ id: p.name, name: p.name, provider: p.id, providerName: p.name, baseUrl: p.baseUrl })}
    <div class="t"><b>${esc(p.name)}</b><small>${p.models.length} моделей · ${esc(p.baseUrl.replace(/^https?:\/\//, ''))}</small></div>${icon('chevRight')}</button>`).join('');
}
$('#setSystem').oninput = e => { S.settings.system = e.target.value; saveSettings(); };
$('#setTemp').oninput = e => { S.settings.temp = +e.target.value; $('#tempVal').textContent = (+e.target.value).toFixed(1); saveSettings(); haptic('select'); };
$('#setMaxTok').oninput = e => { S.settings.maxTok = e.target.value; saveSettings(); };
$('#setTools').onchange = e => { S.settings.tools = e.target.checked; saveSettings(); haptic('select'); };
$('#setShowReason').onchange = e => { S.settings.showReason = e.target.checked; saveSettings(); haptic('select'); };
$('#setReason').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; S.settings.reason = b.dataset.v; haptic('select'); saveSettings(); renderSettings(); };
$('#btnClearAll').onclick = async () => { if (!await confirmBox('Удалить все чаты и изображения?')) return; await DB.clear(); S.chats = []; newChat(); renderChatList(); toast('Все чаты удалены', 'trash'); };
$('#providerList').onclick = e => { const b = e.target.closest('[data-pid]'); if (b) openProvider(S.providers.find(p => p.id === b.dataset.pid)); };
$('#btnAddProvider').onclick = () => openProvider();

/* ---------- Providers ---------- */
const PRESETS = [
  ['OpenAI', 'https://api.openai.com/v1', true], ['Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', true],
  ['Groq', 'https://api.groq.com/openai/v1', false], ['DeepSeek', 'https://api.deepseek.com/v1', false],
  ['Mistral', 'https://api.mistral.ai/v1', true], ['xAI Grok', 'https://api.x.ai/v1', true],
  ['Together', 'https://api.together.xyz/v1', false], ['OpenRouter', 'https://openrouter.ai/api/v1', true],
];
$('#presets').innerHTML = PRESETS.map((p, i) => `<button class="preset" data-p="${i}">${logo({ id: p[0], name: p[0], provider: 'x', providerName: p[0], baseUrl: p[1] }, 'sm')}${p[0]}</button>`).join('');
$('#presets').onclick = e => { const b = e.target.closest('[data-p]'); if (!b) return; const [n, u, v] = PRESETS[+b.dataset.p];
  document.querySelectorAll('.preset').forEach(x => x.classList.toggle('on', x === b));
  $('#provName').value = n; $('#provUrl').value = u; $('#provVision').checked = v; haptic('select'); $('#provKey').focus(); };
let editingProv = null;
function openProvider(p) {
  editingProv = p || null;
  $('#provTitle').textContent = p ? p.name : 'Новый API';
  $('#provName').value = p?.name || ''; $('#provUrl').value = p?.baseUrl || ''; $('#provKey').value = p?.apiKey || '';
  $('#provModels').value = p?.models.join(', ') || ''; $('#provVision').checked = p ? !!p.vision : true;
  document.querySelectorAll('.preset').forEach(x => x.classList.remove('on'));
  $('#btnDelProvider').classList.toggle('hidden', !p); $('#presets').classList.toggle('hidden', !!p);
  openLayer($('#sheetProvider'));
}
$('#btnFetchModels').onclick = async () => {
  const baseUrl = $('#provUrl').value.trim(), apiKey = $('#provKey').value.trim();
  if (!baseUrl) { toast('Укажите Base URL', 'alert'); return; }
  const b = $('#btnFetchModels'), html = b.innerHTML; b.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>'; b.disabled = true;
  try { const r = await (await api('/api/provider-models', { provider: { baseUrl, apiKey } })).json();
    $('#provModels').value = r.models.join(', '); haptic('success'); toast(`Найдено моделей: ${r.models.length}`); }
  catch (e) { toast(e.message, 'alert'); haptic('error'); } finally { b.innerHTML = html; b.disabled = false; }
};
$('#btnSaveProvider').onclick = async () => {
  const name = $('#provName').value.trim() || 'Мой API', baseUrl = $('#provUrl').value.trim().replace(/\/+$/, ''), apiKey = $('#provKey').value.trim();
  const models = [...new Set($('#provModels').value.split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
  if (!/^https?:\/\//.test(baseUrl)) { toast('Base URL должен начинаться с https://', 'alert'); return; }
  if (!models.length) { toast('Добавьте модели или нажмите «Найти модели»', 'alert'); return; }
  const p = editingProv || { id: 'p' + uid() };
  Object.assign(p, { name, baseUrl, apiKey, models, vision: $('#provVision').checked });
  if (!editingProv) S.providers.push(p);
  await DB.set('providers', S.providers); buildModels(); renderSettings(); haptic('success');
  closeLayer($('#sheetProvider')); toast(`${name}: подключено ${models.length} моделей`);
};
$('#btnDelProvider').onclick = async () => {
  if (!editingProv || !await confirmBox(`Удалить «${editingProv.name}»?`)) return;
  S.providers = S.providers.filter(p => p !== editingProv); await DB.set('providers', S.providers);
  buildModels(); renderSettings(); renderHeader(); closeLayer($('#sheetProvider'));
};

/* ---------- Admin ---------- */
const AD = { users: [], admins: [], filter: 'all' };
const ago = t => { if (!t) return '—'; const s = Date.now() / 1000 - t;
  return s < 120 ? 'сейчас онлайн' : s < 3600 ? `${Math.floor(s / 60)} мин назад` : s < 86400 ? `${Math.floor(s / 3600)} ч назад` : s < 86400 * 30 ? `${Math.floor(s / 86400)} дн назад` : new Date(t * 1000).toLocaleDateString('ru'); };
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
async function loadAdmin() {
  if (!AD.users.length) $('#adminList').innerHTML = '<div class="thinking" style="justify-content:center;padding:30px"><div class="dots"><i></i><i></i><i></i></div><span class="shimmer">Загружаю</span></div>';
  try { const r = await (await api('/api/admin/users')).json(); AD.users = r.users; AD.admins = r.admins; renderStats(r.stats); renderAdmin(); }
  catch (e) { $('#adminList').innerHTML = `<div class="err">${icon('alert')}<span>${esc(e.message)}</span></div>`; }
}
function renderStats(st) {
  $('#adminCount').textContent = st.total || '';
  $('#adminStats').innerHTML = [['users', 'Всего', st.total], ['activity', 'За 24 часа', st.active24], ['message', 'Сообщений сегодня', st.msgsToday], ['ban', 'Заблокированы', st.blocked]]
    .map(([ic, t, v], i) => `<div class="stat" style="--n:${i}"><span class="st-ic">${icon(ic)}</span><b>${v ?? 0}</b><small>${t}</small></div>`).join('');
}
function renderAdmin() {
  document.querySelectorAll('#adminFilter button').forEach(b => b.classList.toggle('on', b.dataset.v === AD.filter));
  const q = $('#adminSearch').value.trim().toLowerCase().replace(/^@/, ''), day = Date.now() / 1000 - 86400;
  let list = AD.users;
  if (AD.filter === 'active') list = list.filter(u => u.last_seen > day);
  if (AD.filter === 'blocked') list = list.filter(u => u.blocked);
  if (q) list = list.filter(u => `${u.name} ${u.username} ${u.id}`.toLowerCase().includes(q));
  $('#adminList').innerHTML = list.length ? list.map((u, i) => {
    const adm = AD.admins.includes(u.id), on = u.last_seen > Date.now() / 1000 - 300, nm = u.name || (u.username ? '@' + u.username : 'ID ' + u.id);
    return `<div class="urow ${u.blocked ? 'blk' : ''}" style="--n:${Math.min(i, 14)}">
      <span class="u-ava" style="--h:${(u.id * 47) % 360}">${esc((nm.replace('@', '')[0] || '?').toUpperCase())}${on ? '<i class="online"></i>' : ''}</span>
      <span class="u-t"><b>${esc(nm)}${adm ? '<em class="badge">админ</em>' : ''}${u.blocked ? '<em class="badge red">блок</em>' : ''}</b>
      <small>${u.username ? '@' + esc(u.username) + ' · ' : ''}${ago(u.last_seen)} · ${u.msgs || 0} ${plural(u.msgs || 0, 'сообщение', 'сообщения', 'сообщений')}</small></span>
      ${adm ? '' : `<button class="u-btn ${u.blocked ? 'un' : ''}" data-block="${u.id}">${icon(u.blocked ? 'unlock' : 'ban')}<span>${u.blocked ? 'Разблокировать' : 'Блок'}</span></button>`}</div>`;
  }).join('') : `<div class="empty-small">${icon('users')}<br>${AD.users.length ? 'Никого не найдено' : 'Пока никто не заходил'}</div>`;
}
$('#adminSearch').oninput = renderAdmin;
$('#adminRefresh').onclick = () => { haptic(); loadAdmin(); };
$('#adminFilter').onclick = e => { const b = e.target.closest('[data-v]'); if (b) { AD.filter = b.dataset.v; haptic('select'); renderAdmin(); } };
$('#adminList').onclick = async e => {
  const b = e.target.closest('[data-block]'); if (!b) return;
  const u = AD.users.find(x => x.id === +b.dataset.block), nm = u.name || u.username || u.id, block = !u.blocked;
  if (!await confirmBox(block ? `Заблокировать ${nm}? Он больше не сможет пользоваться AI Studio.` : `Разблокировать ${nm}?`)) return;
  b.disabled = true;
  try { const r = await (await api('/api/admin/block', { id: u.id, blocked: block })).json();
    u.blocked = block; renderStats(r.stats); renderAdmin(); haptic(block ? 'warning' : 'success'); toast(block ? `${nm} заблокирован` : `${nm} разблокирован`, block ? 'ban' : 'unlock'); }
  catch (er) { toast(er.message, 'alert'); haptic('error'); b.disabled = false; }
};
function showBlocked(text) {
  if (text) $('#blockedText').textContent = text;
  $('#blockedScreen').classList.remove('hidden'); haptic('error');
}

/* ---------- Init ---------- */
(async function init() {
  const u = tg?.initDataUnsafe?.user;
  $('#userName').textContent = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : 'Гость';
  $('#heroHello').textContent = u?.first_name ? `Привет, ${u.first_name}` : 'Привет,';
  try {
    const [chats, settings, favs, providers, lastModel] = await Promise.all([DB.all(), DB.get('settings'), DB.get('favs'), DB.get('providers'), DB.get('lastModel')]);
    S.chats = chats || []; Object.assign(S.settings, settings || {}); S.favs = new Set(favs || []); S.providers = providers || []; S.lastModel = lastModel || null;
  } catch (e) { console.warn('IndexedDB', e); }
  try { S.config = await (await api('/api/config')).json(); } catch (e) { if (!e.blocked) toast(e.message, 'alert'); }
  if (S.config.isAdmin) { $('#navAdmin').classList.remove('hidden'); api('/api/admin/users').then(r => r.json()).then(r => renderStats(r.stats)).catch(() => { }); }
  buildModels(); newChat(); renderChatList(); updateSend();
  loadModels();
})();
})();
