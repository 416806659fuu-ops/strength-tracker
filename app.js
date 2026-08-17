// ---- 核心：与后端同步的状态 / 保存条 / 通用工具 ----
const CACHE_KEY = 'strength-tracker-cache-v1';
// 从哪一天开始有没上传的本机记录（'YYYY-MM-DD'）；没有积压时这个键不存在。
// 必须持久化：长期离线时关掉 app 再打开，也得知道「本机还有 X 天没传」，
// 更重要的是启动时靠它判断绝不能拿服务器数据覆盖本机。
const DIRTY_KEY = 'strength-tracker-dirty-since';

// ---- IndexedDB 镜像：localStorage 的第二保险 ----
// 记录是每天的命根子，只靠 localStorage 一份不放心（系统空间紧张时
// 可能被回收）。每次写缓存时同步镜像一份到 IndexedDB，
// 读的时候 localStorage 坏了/没了就回退读这份。
const IDB_NAME = 'strength-tracker-idb';
const IDB_STORE = 'state';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbSet(raw) {
  return idbOpen()
    .then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(raw, 'state');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }))
    .catch(() => { /* IDB 不可用就算了，localStorage 那份还在 */ });
}

function idbGet() {
  return idbOpen()
    .then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const rq = tx.objectStore(IDB_STORE).get('state');
      rq.onsuccess = () => { db.close(); resolve(rq.result || null); };
      rq.onerror = () => { db.close(); reject(rq.error); };
    }))
    .catch(() => null);
}

// IndexedDB 在个别环境下会「既不成功也不报错」地干挂着（比如某些隐私模式），
// 镜像只是保险，绝不允许它拖住启动：超时就当作没有这份数据。
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// 后端是 Google Apps Script + Google Sheet。地址和密码不写死在代码里
// （这份代码要发布到公开的 GitHub Pages，写死的话谁都能看到源码里的密码），
// 而是第一次打开时问一次，存在这台设备的浏览器本地，以后就不用再问了。
// 存储键必须带 strength-tracker- 前缀。三个 app（摄入管理、重训、记账）都发布在
// 416806659fuu-ops.github.io 这同一个域名下，只是路径不同，而 localStorage 是按
// **域名**隔离的、不看路径——三个 app 共用一份存储。原来它们都用裸的
// 'api_url'/'api_token'，于是谁后打开谁就把别人的后端地址覆盖掉，表现就是
// "在新设备上打开重训，后端却连到了摄入管理"。缓存那几个键早就带前缀了，
// 唯独这两个漏了。
const API_URL_KEY = 'strength-tracker-api-url';
const API_TOKEN_KEY = 'strength-tracker-api-token';
const LEGACY_API_URL_KEY = 'api_url';
const LEGACY_API_TOKEN_KEY = 'api_token';

// 从旧版本升上来的设备，配置还存在裸键里，搬一次过来免得用户重填。
// 搬过来的值有可能本来就是别的 app 的地址（正是这个 bug 的后果），所以搬完
// 之后如果发现连错了，用设置页的「重新设置后端」改一次即可。
//
// 只搬这一次，靠 MIGRATED_KEY 记住。不然"重新设置后端"会失效：那个功能是
// 删掉已存的地址让 prompt 重新问一遍，而如果每次都无条件从裸键搬，删完立刻
// 又被搬回来，用户永远改不掉。
const API_MIGRATED_KEY = 'strength-tracker-api-migrated';
function migrateLegacyApiConfig() {
  if (localStorage.getItem(API_MIGRATED_KEY)) return;
  localStorage.setItem(API_MIGRATED_KEY, '1');
  if (localStorage.getItem(API_URL_KEY)) return;
  const url = localStorage.getItem(LEGACY_API_URL_KEY);
  const token = localStorage.getItem(LEGACY_API_TOKEN_KEY);
  if (!url || !token) return;
  localStorage.setItem(API_URL_KEY, url);
  localStorage.setItem(API_TOKEN_KEY, token);
}

function getApiConfig() {
  migrateLegacyApiConfig();
  let url = localStorage.getItem(API_URL_KEY);
  let token = localStorage.getItem(API_TOKEN_KEY);
  if (!url || !token) {
    url = (prompt('请输入后端地址（Apps Script 部署网址）：', url || '') || '').trim();
    token = (prompt('请输入密码（token）：', token || '') || '').trim();
    // 只写带前缀的键，绝不碰那两个裸键——另外两个 app 还在用它们
    if (url) localStorage.setItem(API_URL_KEY, url);
    if (token) localStorage.setItem(API_TOKEN_KEY, token);
  }
  return { url, token };
}

// 组间休息时长（秒）：热身组之后 30s，正式组之间 60s，一个动作全部练完 180s
const DEFAULT_REST = { afterWarmup: 30, betweenSets: 60, betweenExercises: 180 };

function defaultState() {
  return {
    settings: { rest: { ...DEFAULT_REST } },
    strength: { catalog: [], days: {} },
  };
}

let state = defaultState();
let dirty = false;
let offline = false;
let dirtySince = localStorage.getItem(DIRTY_KEY);

function cacheLocally() {
  const raw = JSON.stringify(state);
  try {
    localStorage.setItem(CACHE_KEY, raw);
  } catch (e) {
    /* 存储满了也不影响主流程 */
  }
  idbSet(raw);
}

function loadLocalCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return mergeIntoDefaults(JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

// localStorage 没有或者坏了，退回读 IndexedDB 镜像
async function loadIdbCache() {
  const raw = await withTimeout(idbGet(), 1500, null);
  if (!raw) return null;
  try {
    return mergeIntoDefaults(JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

// 把任意一份（可能缺字段的）数据补齐成完整结构
function mergeIntoDefaults(parsed) {
  const d = defaultState();
  const settings = Object.assign(d.settings, parsed.settings);
  // rest 是嵌套对象，上面那行会整个替换掉它，所以单独再补一次缺失的键
  settings.rest = Object.assign({ ...DEFAULT_REST }, (parsed.settings || {}).rest);
  return Object.assign(d, parsed, {
    settings,
    strength: Object.assign(d.strength, parsed.strength),
  });
}

// 「没配置后端」和「配置了但连不上」是两回事，提示语不能混为一谈：
// 前者要引导你去填地址，后者才是真的离线。
let notConfigured = false;

// 只有「全新设备、本机什么都没有」时才走这条阻塞路径：
// 问一次配置、等服务器把数据拉下来。平时启动都走本地优先，不等网络。
async function bootState() {
  try {
    const { url, token } = getApiConfig();
    if (!url || !token) {
      notConfigured = true;
      throw new Error('not configured');
    }
    const res = await fetch(`${url}?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state = mergeIntoDefaults(data);
    offline = false;
    notConfigured = false;
    cacheLocally();
  } catch (e) {
    offline = true;
  }
}

// 后台静默同步检查：本地优先启动后偷偷跑一次，任何失败都不打扰使用。
// 超时要设短——封锁环境下请求往往是挂着不动而不是快速失败，
// 不设超时的话状态栏会一直停在旧文案。
async function refreshFromServer() {
  const url = localStorage.getItem(API_URL_KEY);
  const token = localStorage.getItem(API_TOKEN_KEY);
  if (!url || !token) {
    notConfigured = true;
    showConfigHint();
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${url}?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    offline = false;
    if (dirtySince) {
      // 本机有没上传的记录：绝不能拿服务器数据覆盖本机。
      // （服务器那份此刻是旧的；等用户点「上传」把本机推上去。）
      updateSaveBar('dirty');
      return;
    }
    state = mergeIntoDefaults(data);
    cacheLocally();
    switchView(currentViewName()); // 用最新数据重画当前页
    updateSaveBar('synced');
  } catch (e) {
    offline = true;
    updateSaveBar(dirtySince ? 'dirty' : 'local');
  }
}

function currentViewName() {
  const active = document.querySelector('.tab-bar button.active');
  return active ? active.dataset.tab : 'strength';
}

function showConfigHint() {
  const status = document.getElementById('save-status');
  status.textContent = '还没连后端，点这里设置';
  status.style.cursor = 'pointer';
  status.onclick = async () => {
    // 只删自己那份。裸键归另外两个 app 用，不能碰
    localStorage.removeItem(API_URL_KEY);
    localStorage.removeItem(API_TOKEN_KEY);
    // 不能刷新页面了事：这台设备本机已经有缓存数据，boot() 走的是「本地优先」
    // 分支（loadLocalCache() 命中），根本不会碰到 bootState() 里那个会弹输入框
    // 的分支——刷新只会把你原样送回这条「点这里设置」提示，永远弹不出框。
    // 直接在这次点击的用户手势里同步问，才弹得出来。
    const { url, token } = getApiConfig();
    if (!url || !token) return; // 取消了就算了，下次再点
    await refreshFromServer();
  };
}

// ---- 本机记录 / 上传条 ----
// 语义：记录永远先落在本机（写缓存+IndexedDB 镜像），「上传」是独立的
// 主动动作，攒一个月再传也没关系。所以积压不是需要焦虑的红色警告，
// 只是一个平静的事实陈述。
function markDirty() {
  dirty = true;
  if (!dirtySince) {
    dirtySince = todayKey();
    localStorage.setItem(DIRTY_KEY, dirtySince);
  }
  cacheLocally();
  updateSaveBar('dirty');
}

// 从第一条没上传的记录那天到今天，一共积压了几天（含两端）
function pendingDays() {
  if (!dirtySince) return 0;
  const ms = new Date(todayKey() + 'T00:00:00') - new Date(dirtySince + 'T00:00:00');
  return Math.max(0, Math.round(ms / 86400000)) + 1;
}

function pendingLabel() {
  const d = pendingDays();
  if (d <= 1) return '已记录到本机 · 今天的记录未上传';
  return `已记录到本机 · 积压 ${d} 天未上传`;
}

function updateSaveBar(mode) {
  const bar = document.getElementById('save-bar');
  const status = document.getElementById('save-status');
  bar.dataset.mode = mode;
  const t = new Date();
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (mode === 'dirty') status.textContent = pendingLabel();
  else if (mode === 'saving') status.textContent = '上传中…';
  else if (mode === 'saved') status.textContent = `已上传 · ${hhmm}`;
  else if (mode === 'synced') status.textContent = `已同步 · ${hhmm}`;
  else if (mode === 'local') status.textContent = '使用本机数据';
  else if (mode === 'error') status.textContent = '上传失败 · 记录仍在本机，稍后再试';
  else status.textContent = '';
}

async function syncToServer() {
  updateSaveBar('saving');
  try {
    const { url, token } = getApiConfig();
    if (!url || !token) throw new Error('not configured');
    // 不显式设置 Content-Type，让浏览器默认用 text/plain，
    // 避免触发 CORS 预检请求（Apps Script Web App 不支持 OPTIONS 预检）。
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ token, state }),
    });
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    offline = false;
    dirty = false;
    dirtySince = null;
    localStorage.removeItem(DIRTY_KEY);
    updateSaveBar('saved');
  } catch (e) {
    offline = true;
    updateSaveBar('error');
  }
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateKey, delta) {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function fmt(n) {
  return Math.round(n * 10) / 10;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 1600);
}

// ---- 安全的算式求值（数值输入框用），不用 eval/Function ----
function evalCalExpr(raw) {
  if (raw == null) return null;
  const str = String(raw).trim().replace(/[xX×]/g, '*').replace(/[÷]/g, '/');
  if (str === '') return null;
  if (!/^[0-9+\-*/(). ]+$/.test(str)) return null;

  let i = 0;
  function skipSpace() {
    while (str[i] === ' ') i++;
  }
  function parseNumber() {
    skipSpace();
    const start = i;
    if (str[i] === '+' || str[i] === '-') i++;
    let sawDigit = false;
    while (i < str.length && /[0-9]/.test(str[i])) {
      i++;
      sawDigit = true;
    }
    if (str[i] === '.') {
      i++;
      while (i < str.length && /[0-9]/.test(str[i])) {
        i++;
        sawDigit = true;
      }
    }
    if (!sawDigit) throw new Error('bad number');
    return Number(str.slice(start, i));
  }
  function parseFactor() {
    skipSpace();
    if (str[i] === '(') {
      i++;
      const v = parseExpr();
      skipSpace();
      if (str[i] !== ')') throw new Error('missing )');
      i++;
      return v;
    }
    if (str[i] === '-') {
      i++;
      return -parseFactor();
    }
    if (str[i] === '+') {
      i++;
      return parseFactor();
    }
    return parseNumber();
  }
  function parseTerm() {
    let v = parseFactor();
    skipSpace();
    while (str[i] === '*' || str[i] === '/') {
      const op = str[i];
      i++;
      const rhs = parseFactor();
      v = op === '*' ? v * rhs : v / rhs;
      skipSpace();
    }
    return v;
  }
  function parseExpr() {
    let v = parseTerm();
    skipSpace();
    while (str[i] === '+' || str[i] === '-') {
      const op = str[i];
      i++;
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
      skipSpace();
    }
    return v;
  }

  try {
    const result = parseExpr();
    skipSpace();
    if (i !== str.length) return null;
    if (!Number.isFinite(result)) return null;
    return result;
  } catch (e) {
    return null;
  }
}

// ---- 导航 ----
const VIEW_TITLES = { strength: '重训记录', history: '训练历史', settings: '设置' };

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  document.querySelectorAll('.tab-bar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('page-title').textContent = VIEW_TITLES[name] || '';
  if (name === 'history' && window.renderStrengthHistory) window.renderStrengthHistory();
  if (name === 'settings' && window.renderSettings) window.renderSettings();
  if (name === 'strength' && window.renderStrength) window.renderStrength();
}

async function boot() {
  // 本地优先：本机有数据就立刻用它渲染（秒开），网络检查放到后台。
  // 封锁/离线环境下打开不再卡在「加载中」等一个连不上的服务器。
  const cached = loadLocalCache() || (await loadIdbCache());
  if (cached) {
    state = cached;
  } else {
    await bootState();
  }

  document.querySelectorAll('.tab-bar button[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      switchView(btn.dataset.tab);
    });
  });

  document.getElementById('save-btn').addEventListener('click', syncToServer);

  // 每个模块独立初始化：某一个出错时，其他页面照常能用。
  [
    ['重训', window.initStrength],
    ['设置', window.initSettings],
  ].forEach(([label, init]) => {
    if (!init) return;
    try {
      init();
    } catch (e) {
      console.error(`[${label}] 初始化失败`, e);
    }
  });

  switchView('strength');

  if (dirtySince) {
    dirty = true;
    updateSaveBar('dirty');
  } else if (cached) {
    updateSaveBar('local');
  } else if (notConfigured) {
    showConfigHint();
  } else {
    updateSaveBar(offline ? 'local' : 'synced');
  }

  document.getElementById('app-loading').style.display = 'none';
  document.getElementById('app-root').style.display = '';

  // 后台静默检查云端（本机有积压时只更新文案，绝不覆盖本机数据）
  if (cached) refreshFromServer();

  // 向系统申请持久化存储，降低长期离线时本机数据被回收的概率；不支持就算了
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
