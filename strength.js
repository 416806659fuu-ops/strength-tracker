// ---- 重训记录页 ----
// 数据结构见 app.js 的 defaultState()：
//   strength.catalog —— 动作库，记着每个动作属于 A 还是 B 计划、当前重量、怎么计重
//   strength.days    —— 每天练了哪些动作、每组多重多少次
// catalog 和 days 分开存：改动作库里的「当前重量」不会篡改历史记录，
// 因为每一组都存了当时的重量快照。

// A / B 两套训练计划。A 练腿，B 练胸背 + 有氧。
function splitLabel(split) {
  return `${split} 训练计划`;
}

// 组标记，对应你在 Excel 里手写的那套符号：热 / 姿 / -15 / +
const SET_TAGS = [
  { key: null, label: '正式', color: 'var(--series-blue)' },
  { key: 'warmup', label: '热身', color: 'var(--series-aqua)' },
  { key: 'form', label: '姿势', color: 'var(--series-red)' },
  { key: 'drop', label: '递减', color: 'var(--series-green)' },
  { key: 'up', label: '加重', color: 'var(--series-blue)' },
];

let strengthDate = todayKey();

// 每个动作的「待添加组」暂存的标记，key 是 exerciseId
const pendingTag = {};

function tagInfo(key) {
  return SET_TAGS.find((t) => t.key === key) || SET_TAGS[0];
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- 数据读写 ----
function sEmptyDay() {
  return { split: 'A', exercises: [] };
}

function sGetDay(dateKey) {
  return state.strength.days[dateKey] || sEmptyDay();
}

function sEnsureDay(dateKey) {
  if (!state.strength.days[dateKey]) {
    state.strength.days[dateKey] = sEmptyDay();
  }
  return state.strength.days[dateKey];
}

function exerciseById(id) {
  return state.strength.catalog.find((e) => e.id === id);
}

function exercisesForSplit(split) {
  return state.strength.catalog
    .filter((e) => e.split === split && !e.archived)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

// 当天该显示哪些动作：该分化下的动作，外加当天已经记过、但如今已归档或改了分化的动作
// （否则那些记录会从界面上消失，数据还在但看不见）
function visibleExercises(day) {
  const list = exercisesForSplit(day.split);
  const seen = new Set(list.map((e) => e.id));
  day.exercises.forEach((rec) => {
    if (seen.has(rec.exerciseId)) return;
    const ex = exerciseById(rec.exerciseId);
    if (ex) {
      list.push(ex);
      seen.add(ex.id);
    }
  });
  return list;
}

function recordFor(day, exId) {
  return day.exercises.find((r) => r.exerciseId === exId);
}

function ensureRecord(day, exId) {
  let rec = recordFor(day, exId);
  if (!rec) {
    rec = { exerciseId: exId, note: '', sets: [] };
    day.exercises.push(rec);
  }
  return rec;
}

// 往前找这个动作最近一次练的记录，用来在录入时对照
function lastSession(exId, beforeDate) {
  const dates = Object.keys(state.strength.days)
    .filter((d) => d < beforeDate)
    .sort()
    .reverse();
  for (const d of dates) {
    const rec = (state.strength.days[d].exercises || []).find((r) => r.exerciseId === exId);
    if (rec && (rec.sets || []).length) return { date: d, sets: rec.sets };
  }
  return null;
}

// ---- 计重与容量 ----
function weightLabel(ex, w) {
  if (ex.weightMode === 'bodyweight') return '自重';
  if (w === null || w === undefined || w === '') return '—';
  if (ex.weightMode === 'pair') return `${fmt(w)}kg×2`;
  if (ex.weightMode === 'level') return `档 ${fmt(w)}`;
  return `${fmt(w)}kg`;
}

// 有氧、自重和器械档位都不计入容量：
// 档位是机器刻度不是公斤数，乘起来没有物理意义；有氧根本没有重量和次数。
function setVolume(ex, s) {
  if (isCardio(ex)) return 0;
  const reps = Number(s.reps) || 0;
  const w = Number(s.weight) || 0;
  if (ex.weightMode === 'bodyweight' || ex.weightMode === 'level') return 0;
  if (ex.weightMode === 'pair') return w * 2 * reps;
  return w * reps;
}

function dayTotals(day) {
  let volume = 0;
  let sets = 0;
  let reps = 0;
  day.exercises.forEach((rec) => {
    const ex = exerciseById(rec.exerciseId);
    if (!ex) return;
    // 有氧记录没有 sets，只有 durationSec
    (rec.sets || []).forEach((s) => {
      volume += setVolume(ex, s);
      sets += 1;
      reps += Number(s.reps) || 0;
    });
  });
  return { volume, sets, reps };
}

// 新增一组时，重量默认沿用这个动作上一组的重量；没有就用动作库里的当前重量
function defaultWeightFor(ex, rec) {
  if (ex.weightMode === 'bodyweight') return '';
  if (rec && (rec.sets || []).length) return rec.sets[rec.sets.length - 1].weight ?? '';
  return ex.weight ?? '';
}

// ---- 交互 ----
function initStrength() {
  // 日期不可切换 —— 训练页永远是今天，往日回顾以后放历史页。
  // 时钟每 10 秒走一格；跨天（比如练到半夜十二点）自动翻到新的一天。
  updateDateClock();
  setInterval(() => {
    if (todayKey() !== strengthDate) {
      strengthDate = todayKey();
      forceFormMode = false;
      renderStrength();
    }
    updateDateClock();
  }, 10000);

  document.getElementById('back-to-session-btn').addEventListener('click', () => showStrengthForm(false));

  document.getElementById('split-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-split]');
    if (!btn) return;
    const isToday = strengthDate === todayKey();
    const rec = state.strength.days[strengthDate];

    // 今天已确认 → 锁死，不给改
    if (isToday && rec && rec.confirmed) {
      if (rec.split !== btn.dataset.split) showToast(`今天已锁定：${splitLabel(rec.split)}`);
      return;
    }
    // 今天还没确认 → 也走确认弹窗，确认了才算数
    if (isToday && !forceFormMode) {
      if (window.openPlanConfirm) window.openPlanConfirm(btn.dataset.split);
      return;
    }
    // 过去的日期是补记，可以自由改
    const day = sEnsureDay(strengthDate);
    if (day.split === btn.dataset.split) return;
    day.split = btn.dataset.split;
    markDirty();
    renderStrength();
  });

  const container = document.getElementById('exercise-cards');

  container.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.set-del');
    if (delBtn) {
      const day = sEnsureDay(strengthDate);
      const rec = recordFor(day, delBtn.dataset.ex);
      if (rec) {
        rec.sets.splice(Number(delBtn.dataset.idx), 1);
        if (rec.sets.length === 0) {
          day.exercises = day.exercises.filter((r) => r.exerciseId !== delBtn.dataset.ex);
        }
        markDirty();
        renderStrength();
      }
      return;
    }
    const tagBtn = e.target.closest('.tag-toggle');
    if (tagBtn) {
      cycleTag(tagBtn.dataset.ex);
      return;
    }
    const addBtn = e.target.closest('.set-add');
    if (addBtn) {
      addSet(addBtn.dataset.ex);
      return;
    }
    const cardioBtn = e.target.closest('.cardio-save');
    if (cardioBtn) saveCardio(cardioBtn.dataset.ex);
  });

  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const card = e.target.closest('.exercise-card');
    if (!card) return;
    if (e.target.classList.contains('set-weight') || e.target.classList.contains('set-reps')) {
      e.preventDefault();
      addSet(card.dataset.ex);
    }
  });

  // 各自独立初始化：一个模块的 DOM 缺失不该拖垮另一个
  initCatalog();
  initSession();
}

function cycleTag(exId) {
  const cur = pendingTag[exId] ?? null;
  const idx = SET_TAGS.findIndex((t) => t.key === cur);
  pendingTag[exId] = SET_TAGS[(idx + 1) % SET_TAGS.length].key;
  updateTagButton(exId);
}

function updateTagButton(exId) {
  const btn = document.querySelector(`.tag-toggle[data-ex="${exId}"]`);
  if (!btn) return;
  const info = tagInfo(pendingTag[exId] ?? null);
  btn.style.setProperty('--tag-color', info.color);
  btn.textContent = `● ${info.label}`;
}

function addSet(exId) {
  const ex = exerciseById(exId);
  if (!ex) return;
  const card = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  const repsInput = card.querySelector('.set-reps');
  const weightInput = card.querySelector('.set-weight');

  const reps = evalCalExpr(repsInput.value);
  if (reps === null || reps <= 0) {
    repsInput.focus();
    return;
  }
  // 自重动作没有重量输入框
  const weight = ex.weightMode === 'bodyweight' ? null : evalCalExpr(weightInput ? weightInput.value : '');
  if (ex.weightMode !== 'bodyweight' && weight === null) {
    weightInput.focus();
    return;
  }

  const day = sEnsureDay(strengthDate);
  const rec = ensureRecord(day, exId);
  const tag = pendingTag[exId] ?? null;
  rec.sets.push({ weight, reps, tags: tag ? [tag] : [] });
  markDirty();

  pendingTag[exId] = null;
  // 只重画这一张卡，别动其他卡——你可能已经在下一个动作的框里填了重量还没提交
  refreshExerciseCard(exId);

  const nextCard = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  if (nextCard) nextCard.querySelector('.set-reps').focus();
}

function saveCardio(exId) {
  const card = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  const raw = card.querySelector('.cardio-min').value.trim();
  const day = sEnsureDay(strengthDate);

  if (raw === '') {
    // 清空输入 = 删掉这条记录
    day.exercises = day.exercises.filter((r) => r.exerciseId !== exId);
    markDirty();
    renderStrength();
    return;
  }

  const mins = evalCalExpr(raw);
  if (mins === null || mins <= 0) {
    card.querySelector('.cardio-min').focus();
    return;
  }
  const rec = ensureRecord(day, exId);
  delete rec.sets; // 有氧记录不该带着空的 sets 数组
  rec.durationSec = Math.round(mins * 60);
  markDirty();
  renderStrength();
  showToast(`已记录 ${Math.round(mins)} 分钟`);
}

function refreshExerciseCard(exId) {
  const ex = exerciseById(exId);
  const card = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  if (!ex || !card) {
    renderStrength();
    return;
  }
  card.outerHTML = renderExerciseCard(ex, sGetDay(strengthDate));
  updateTagButton(exId);
  renderStrengthHero();
}

// ---- 渲染 ----
function renderStrengthHero() {
  const day = sGetDay(strengthDate);
  const { volume, sets, reps } = dayTotals(day);
  document.getElementById('s-hero-value').innerHTML = `${fmt(volume)}<span class="unit">kg·次</span>`;
  document.getElementById('s-hero-sets').textContent = sets;
  document.getElementById('s-hero-reps').textContent = reps;
  document.getElementById('s-hero-moves').textContent = day.exercises.filter((r) => r.sets.length).length;
}

function renderSetRow(ex, s, i) {
  const info = tagInfo(s.tags && s.tags.length ? s.tags[0] : null);
  const tagChip = s.tags && s.tags.length ? `<span class="set-tag" style="color:${info.color}">${info.label}</span>` : '';
  return `
    <div class="set-row">
      <span class="set-idx">${i + 1}</span>
      <span class="set-weight-label">${weightLabel(ex, s.weight)}</span>
      <span class="set-x">×</span>
      <span class="set-reps-label">${fmt(s.reps)}</span>
      ${tagChip}
      <button class="set-del" data-ex="${esc(ex.id)}" data-idx="${i}" aria-label="删除这一组">&times;</button>
    </div>`;
}

// 有氧只记时长，没有重量和次数
function renderCardioCard(ex, day) {
  const rec = recordFor(day, ex.id);
  const mins = rec && rec.durationSec ? Math.round(rec.durationSec / 60) : '';
  const planned = ex.durationMin ?? 20;
  return `
    <div class="exercise-card" data-ex="${esc(ex.id)}">
      <div class="exercise-head">
        <span class="exercise-name">${esc(ex.name)}</span>
        <span class="exercise-summary">${mins ? mins + ' min' : ''}</span>
      </div>
      <div class="last-session muted">计划 ${planned} 分钟有氧</div>
      <div class="add-row">
        <input class="cardio-min" type="text" inputmode="numeric" autocomplete="off"
               value="${mins}" placeholder="实际做了几分钟">
        <button class="cardio-save" data-ex="${esc(ex.id)}">记录</button>
      </div>
    </div>`;
}

function renderExerciseCard(ex, day) {
  if (isCardio(ex)) return renderCardioCard(ex, day);
  const rec = recordFor(day, ex.id);
  const sets = rec ? rec.sets : [];
  const prev = lastSession(ex.id, strengthDate);

  const setsHtml = sets.length
    ? sets.map((s, i) => renderSetRow(ex, s, i)).join('')
    : '<div class="set-empty">还没有记录</div>';

  const volume = sets.reduce((sum, s) => sum + setVolume(ex, s), 0);
  const summary = sets.length
    ? `${sets.length} 组 · ${volume > 0 ? fmt(volume) + ' kg·次' : fmt(sets.reduce((n, s) => n + (Number(s.reps) || 0), 0)) + ' 次'}`
    : '';

  const prevHtml = prev
    ? `<div class="last-session">上次 ${prev.date.slice(5)}：${prev.sets.map((s) => fmt(s.reps)).join(' / ')}</div>`
    : '<div class="last-session muted">这是第一次记录</div>';

  const defW = defaultWeightFor(ex, rec);
  const weightInput =
    ex.weightMode === 'bodyweight'
      ? '<span class="set-bodyweight">自重</span>'
      : `<input class="set-weight" type="text" inputmode="text" autocomplete="off" spellcheck="false"
           value="${esc(defW)}" placeholder="${ex.weightMode === 'level' ? '档位' : '重量kg'}">`;

  return `
    <div class="exercise-card" data-ex="${esc(ex.id)}">
      <div class="exercise-head">
        <span class="exercise-name">${esc(ex.name)}</span>
        <span class="exercise-summary">${summary}</span>
      </div>
      ${prevHtml}
      <div class="set-list">${setsHtml}</div>
      <div class="add-row">
        <button class="tag-toggle" data-ex="${esc(ex.id)}">● 正式</button>
        ${weightInput}
        <input class="set-reps" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="次数">
        <button class="set-add" data-ex="${esc(ex.id)}">+</button>
      </div>
    </div>`;
}

// 今天默认进训练模式；看别的日期、或手动点「查看 / 修改记录」时进表单模式。
let forceFormMode = false;

function showStrengthForm(on) {
  forceFormMode = on;
  renderStrength();
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function updateDateClock() {
  const dEl = document.getElementById('s-date-label');
  const tEl = document.getElementById('s-time-label');
  if (!dEl || !tEl) return;
  const now = new Date();
  dEl.textContent = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} 周${WEEKDAYS[now.getDay()]}`;
  tEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function renderStrength() {
  updateDateClock();

  const day = sGetDay(strengthDate);
  const rawToday = state.strength.days[strengthDate];
  const locked = strengthDate === todayKey() && rawToday && rawToday.confirmed;
  // 今天未确认时整条切换栏隐藏 —— 选择权在选计划画面的大按钮上。
  // 确认后只剩一个按钮，且只显示计划字母（Figma Ver.1.0.2）。
  const chosen = strengthDate !== todayKey() || (rawToday && rawToday.confirmed);
  const sw = document.getElementById('split-switch');
  // 训练模式下大字母显示在 session-head 里，这条切换栏只在补记/档案页出现
  const inSession = strengthDate === todayKey() && !forceFormMode;
  sw.style.display = inSession ? 'none' : (chosen ? '' : 'none');
  document.querySelectorAll('#split-switch button[data-split]').forEach((b) => {
    const active = !!chosen && b.dataset.split === day.split;
    b.classList.toggle('active', active);
    b.textContent = locked && active ? b.dataset.split : `${b.dataset.split} 训练计划`;
  });
  sw.classList.toggle('locked', !!locked);

  // 今天默认进训练模式（哪怕项目库是空的——那一屏会给你一个「去设置训练项目」的入口）。
  // 看别的日期，或者手动点了「查看 / 修改记录」，才进表单模式。
  const isToday = strengthDate === todayKey();
  const useSession = isToday && !forceFormMode;

  document.getElementById('strength-session').style.display = useSession ? '' : 'none';
  document.getElementById('strength-form').style.display = useSession ? 'none' : '';
  document.getElementById('back-to-session-btn').style.display = !useSession && isToday ? '' : 'none';

  if (useSession) {
    window.renderSession();
    // 内容画完之后再量高度，否则量到的是旧布局
    requestAnimationFrame(() => window.fitSessionHeight && window.fitSessionHeight());
  } else {
    renderStrengthForm(day);
  }
}

function renderStrengthForm(day) {
  const container = document.getElementById('exercise-cards');

  if (state.strength.catalog.length === 0) {
    container.innerHTML = `
      <div class="empty-hint">
        <p>动作库还是空的。</p>
        <p>去「设置 → 动作库」把你在练的动作加进来，之后每天来这里点几下就能记完。</p>
      </div>`;
    renderStrengthHero();
    return;
  }

  const list = visibleExercises(day);
  container.innerHTML = list.length
    ? list.map((ex) => renderExerciseCard(ex, day)).join('')
    : `<div class="empty-hint"><p>${splitLabel(day.split)}里还没有动作。</p><p>去「设置 → 动作库」添加，或切换到另一套计划。</p></div>`;

  list.filter((ex) => !isCardio(ex)).forEach((ex) => updateTagButton(ex.id));
  renderStrengthHero();
}

// ---- 动作库 ----
// 列表渲染在设置页里，点任意一行进入这个动作的全屏详情页，
// 组数、步进、器械刻度这些都在详情页里设。
const WEIGHT_MODES = [
  { key: 'single', label: '单一重量', hint: '杠铃、史密斯机，一个数字' },
  { key: 'pair', label: '双侧各计', hint: '一对哑铃，各 4kg 就填 4' },
  { key: 'level', label: '器械档位', hint: '配重片上的刻度，不是公斤' },
  { key: 'bodyweight', label: '自重', hint: '不加负重' },
];

// 你现在真正在练的：A 计划练腿 4 项，B 计划胸背 3 项 + 爬坡走有氧。顺序固定。
const SEED_CATALOG = [
  { name: '传统硬拉', split: 'A', kind: 'strength', weightMode: 'single', weight: 40, step: 2.5, warmupSets: 1, workSets: 4 },
  { name: '保加利亚单腿蹲', split: 'A', kind: 'strength', weightMode: 'pair', weight: 4, step: 1, warmupSets: 0, workSets: 4 },
  { name: '侧平举', split: 'A', kind: 'strength', weightMode: 'pair', weight: 4, step: 1, warmupSets: 0, workSets: 4 },
  { name: '肩背中束面拉', split: 'A', kind: 'strength', weightMode: 'level', weight: 18.1, levels: [14.7, 16.97, 18.1], warmupSets: 0, workSets: 4 },
  { name: '卧推', split: 'B', kind: 'strength', weightMode: 'single', weight: 20, step: 2.5, warmupSets: 1, workSets: 4 },
  { name: '高位下拉', split: 'B', kind: 'strength', weightMode: 'single', weight: 25, step: 2.5, warmupSets: 0, workSets: 4 },
  { name: '宽距划船', split: 'B', kind: 'strength', weightMode: 'single', weight: 22.5, step: 2.5, warmupSets: 0, workSets: 4 },
  { name: '爬坡走', split: 'B', kind: 'cardio', durationMin: 20 },
];

// 这个动作被多少天的记录引用了。有引用就不能真删，只能归档，
// 否则那些天的记录会因为找不到动作而在界面上凭空消失。
function usageCount(exId) {
  return Object.values(state.strength.days).filter((day) =>
    (day.exercises || []).some(
      // 力量动作看有没有组，有氧动作看有没有时长
      (r) => r.exerciseId === exId && ((r.sets || []).length > 0 || r.durationSec > 0)
    )
  ).length;
}

function isCardio(ex) {
  return ex.kind === 'cardio';
}

function exerciseSummary(ex) {
  const parts = [splitLabel(ex.split)];
  if (isCardio(ex)) {
    parts.push(`${ex.durationMin ?? 20} min 有氧`);
    return parts.join(' · ');
  }
  parts.push(weightLabel(ex, ex.weight));
  const w = ex.warmupSets || 0;
  parts.push(w > 0 ? `${w} 热身 + ${ex.workSets || 0} 正式` : `${ex.workSets || 0} 组`);
  return parts.join(' · ');
}

function seedCatalog() {
  if (state.strength.catalog.length > 0 && !confirm('动作库里已经有动作了，载入预设会把它们追加进来，确定吗？')) return;
  const base = state.strength.catalog.length;
  SEED_CATALOG.forEach((tpl, i) => {
    state.strength.catalog.push(Object.assign({ id: uid(), order: base + i, archived: false }, tpl));
  });
  markDirty();
  renderCatalog();
  showToast('已载入预设动作库');
}

function addExercise() {
  const input = document.getElementById('catalog-new-name');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const split = document.getElementById('catalog-new-split').value;
  const order = state.strength.catalog.reduce((m, e) => Math.max(m, e.order || 0), -1) + 1;
  const ex = {
    id: uid(),
    name,
    split,
    order,
    archived: false,
    kind: 'strength',
    weightMode: 'single',
    weight: null,
    step: 2.5,
    warmupSets: 0,
    workSets: 4,
  };
  state.strength.catalog.push(ex);
  input.value = '';
  markDirty();
  renderCatalog();
  openExerciseDetail(ex.id); // 新动作直接进详情页配置
}

function moveExercise(exId, delta) {
  const ex = exerciseById(exId);
  const list = state.strength.catalog
    .filter((e) => e.split === ex.split)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const i = list.findIndex((e) => e.id === exId);
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  const tmp = list[i].order;
  list[i].order = list[j].order;
  list[j].order = tmp;
  markDirty();
  renderCatalog();
}

// ---- 动作详情页（全屏覆盖层）----
let detailExId = null;

function openExerciseDetail(exId) {
  detailExId = exId;
  document.getElementById('exercise-detail').style.display = 'block';
  document.body.style.overflow = 'hidden';
  renderExerciseDetail();
}

function closeExerciseDetail() {
  detailExId = null;
  document.getElementById('exercise-detail').style.display = 'none';
  document.body.style.overflow = '';
  renderCatalog();
}

function detailField(label, hint, inner) {
  return `
    <div class="detail-field">
      <label>${label}</label>
      ${inner}
      ${hint ? `<p class="detail-hint">${hint}</p>` : ''}
    </div>`;
}

function setsSelect(cls, value, max) {
  const opts = [];
  for (let i = 0; i <= max; i++) {
    opts.push(`<option value="${i}"${i === (value || 0) ? ' selected' : ''}>${i} 组</option>`);
  }
  return `<select class="${cls}">${opts.join('')}</select>`;
}

function renderExerciseDetail() {
  const ex = exerciseById(detailExId);
  if (!ex) {
    closeExerciseDetail();
    return;
  }
  const body = document.getElementById('detail-body');
  const cardio = isCardio(ex);

  const modeBtns = WEIGHT_MODES.map(
    (m) => `<button class="pill mode-btn${m.key === ex.weightMode ? ' active' : ''}" data-mode="${m.key}">${m.label}</button>`
  ).join('');
  const modeHint = (WEIGHT_MODES.find((m) => m.key === ex.weightMode) || {}).hint || '';

  let weightBlock = '';
  if (!cardio && ex.weightMode !== 'bodyweight') {
    if (ex.weightMode === 'level') {
      weightBlock =
        detailField('当前档位', '', `<input class="d-weight" type="text" inputmode="decimal" value="${ex.weight ?? ''}">`) +
        detailField(
          '这台机器的全部刻度',
          '用逗号隔开，按从轻到重排。设好之后，训练页的 − / + 就在这些档位之间跳，不会跳出机器上没有的数字。',
          `<input class="d-levels" type="text" value="${(ex.levels || []).join(', ')}" placeholder="14.7, 16.97, 18.1">`
        );
    } else {
      weightBlock =
        detailField('当前重量（kg）', '', `<input class="d-weight" type="text" inputmode="decimal" value="${ex.weight ?? ''}">`) +
        detailField('每次 − / + 加减多少', '杠铃通常 2.5，哑铃通常 1。', `<input class="d-step" type="text" inputmode="decimal" value="${ex.step ?? 2.5}">`);
    }
  }

  const strengthBlock = `
    ${detailField('计重方式', modeHint, `<div class="pill-row">${modeBtns}</div>`)}
    ${weightBlock}
    ${detailField('热身组', '侧平举、面拉这种小重量动作通常填 0。', setsSelect('d-warmup', ex.warmupSets, 3))}
    ${detailField('正式组', '', setsSelect('d-work', ex.workSets, 8))}
  `;

  const cardioBlock = detailField(
    '时长（分钟）',
    '训练页会给你一个倒计时盘。有氧不记重量和次数，消耗的卡路里你在摄入页手动填。',
    `<input class="d-duration" type="text" inputmode="numeric" value="${ex.durationMin ?? 20}">`
  );

  const used = usageCount(ex.id);
  const usedNote = used > 0 ? `已经在 ${used} 天的记录里出现过，不能删除，只能归档。` : '还没有任何记录，可以直接删除。';

  body.innerHTML = `
    ${detailField('名称', '', `<input class="d-name" type="text" value="${esc(ex.name)}">`)}
    ${detailField(
      '属于哪套计划',
      '',
      `<div class="pill-row">
        <button class="pill split-btn${ex.split === 'A' ? ' active' : ''}" data-split="A">A 计划（腿）</button>
        <button class="pill split-btn${ex.split === 'B' ? ' active' : ''}" data-split="B">B 计划（胸背）</button>
      </div>`
    )}
    ${detailField(
      '类型',
      '',
      `<div class="pill-row">
        <button class="pill kind-btn${!cardio ? ' active' : ''}" data-kind="strength">力量</button>
        <button class="pill kind-btn${cardio ? ' active' : ''}" data-kind="cardio">有氧</button>
      </div>`
    )}
    ${cardio ? cardioBlock : strengthBlock}

    <div class="detail-danger">
      <p class="detail-hint">${usedNote}</p>
      <button class="settings-btn" id="d-archive">${ex.archived ? '取消归档' : '归档（不再出现在训练页）'}</button>
      <button class="settings-btn danger" id="d-delete"${used > 0 ? ' disabled' : ''}>删除这个动作</button>
    </div>`;

  document.getElementById('detail-title').textContent = ex.name;
}

function parseLevels(raw) {
  return String(raw)
    .split(/[,，\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

function initExerciseDetail() {
  const back = document.getElementById('detail-back');
  const body = document.getElementById('detail-body');
  if (!back || !body) return;
  back.addEventListener('click', closeExerciseDetail);

  body.addEventListener('click', (e) => {
    const ex = exerciseById(detailExId);
    if (!ex) return;

    const modeBtn = e.target.closest('.mode-btn');
    if (modeBtn) {
      ex.weightMode = modeBtn.dataset.mode;
      if (ex.weightMode === 'level' && !ex.levels) ex.levels = [];
      markDirty();
      renderExerciseDetail();
      return;
    }
    const splitBtn = e.target.closest('.split-btn');
    if (splitBtn) {
      ex.split = splitBtn.dataset.split;
      // 换了分化就排到那一天的末尾，免得和别的动作抢同一个序号
      ex.order = state.strength.catalog
        .filter((x) => x.split === ex.split && x.id !== ex.id)
        .reduce((m, x) => Math.max(m, x.order || 0), -1) + 1;
      markDirty();
      renderExerciseDetail();
      return;
    }
    const kindBtn = e.target.closest('.kind-btn');
    if (kindBtn) {
      ex.kind = kindBtn.dataset.kind;
      if (isCardio(ex)) {
        if (ex.durationMin == null) ex.durationMin = 20;
      } else if (!ex.weightMode) {
        ex.weightMode = 'single';
        ex.step = 2.5;
        ex.workSets = ex.workSets || 4;
      }
      markDirty();
      renderExerciseDetail();
      return;
    }
    if (e.target.id === 'd-archive') {
      ex.archived = !ex.archived;
      markDirty();
      renderExerciseDetail();
      return;
    }
    if (e.target.id === 'd-delete') {
      if (usageCount(ex.id) > 0) return;
      if (!confirm(`删除动作「${ex.name}」？`)) return;
      state.strength.catalog = state.strength.catalog.filter((x) => x.id !== ex.id);
      markDirty();
      closeExerciseDetail();
    }
  });

  body.addEventListener('change', (e) => {
    const ex = exerciseById(detailExId);
    if (!ex) return;
    const t = e.target;

    if (t.classList.contains('d-name')) {
      ex.name = t.value.trim() || ex.name;
      document.getElementById('detail-title').textContent = ex.name;
    } else if (t.classList.contains('d-weight')) {
      ex.weight = evalCalExpr(t.value);
    } else if (t.classList.contains('d-step')) {
      const v = evalCalExpr(t.value);
      ex.step = v && v > 0 ? v : 2.5;
      t.value = ex.step;
    } else if (t.classList.contains('d-levels')) {
      ex.levels = parseLevels(t.value);
      t.value = ex.levels.join(', ');
    } else if (t.classList.contains('d-warmup')) {
      ex.warmupSets = Number(t.value);
    } else if (t.classList.contains('d-work')) {
      ex.workSets = Number(t.value);
    } else if (t.classList.contains('d-duration')) {
      const v = evalCalExpr(t.value);
      ex.durationMin = v && v > 0 ? Math.round(v) : 20;
      t.value = ex.durationMin;
    }
    markDirty();
  });
}

// ---- 训练项目编辑页（全屏覆盖层）----
// 入口在设置页（演示里是底部栏的「设置」）。主训练界面不放编辑入口，
// 唯一例外：项目库为空时，选计划画面会给一个「去设置训练项目」的引导。
function openCatalogPage() {
  const page = document.getElementById('catalog-page');
  if (!page) return;
  page.style.display = 'block';
  document.body.style.overflow = 'hidden';
  renderCatalog();
}

function closeCatalogPage() {
  const page = document.getElementById('catalog-page');
  if (!page) return;
  page.style.display = 'none';
  document.body.style.overflow = '';
  // 改完项目之后训练页要跟着变（比如组数改了，圆点数量就不一样）
  renderStrength();
}

function initCatalog() {
  const root = document.getElementById('catalog-list');
  if (!root) return; // 页面上没有这一块就跳过

  const backBtn = document.getElementById('catalog-back');
  if (backBtn) backBtn.addEventListener('click', closeCatalogPage);

  const openBtn = document.getElementById('open-catalog-btn');
  if (openBtn) openBtn.addEventListener('click', openCatalogPage);

  root.addEventListener('click', (e) => {
    const moveBtn = e.target.closest('button[data-act]');
    if (moveBtn) {
      e.stopPropagation();
      moveExercise(moveBtn.dataset.ex, moveBtn.dataset.act === 'up' ? -1 : 1);
      return;
    }
    const row = e.target.closest('.catalog-row');
    if (row) openExerciseDetail(row.dataset.ex);
  });

  document.getElementById('catalog-add-btn').addEventListener('click', addExercise);
  document.getElementById('seed-catalog-btn').addEventListener('click', seedCatalog);
  initExerciseDetail();
}

function renderCatalog() {
  const root = document.getElementById('catalog-list');
  if (!root) return;

  const list = [...state.strength.catalog].sort(
    (a, b) => a.split.localeCompare(b.split) || (a.order || 0) - (b.order || 0)
  );

  if (!list.length) {
    root.innerHTML = '<p class="settings-note">还没有动作。点下面的「载入预设动作库」，或者自己一个个加。</p>';
  } else {
    let html = '';
    let lastSplit = null;
    list.forEach((ex) => {
      if (ex.split !== lastSplit) {
        html += `<div class="catalog-split-head">${splitLabel(ex.split)}</div>`;
        lastSplit = ex.split;
      }
      html += `
        <div class="catalog-row${ex.archived ? ' archived' : ''}" data-ex="${esc(ex.id)}">
          <div class="catalog-row-main">
            <span class="catalog-name">${esc(ex.name)}</span>
            <span class="catalog-sub">${exerciseSummary(ex)}</span>
          </div>
          <button data-act="up" data-ex="${esc(ex.id)}" aria-label="上移">↑</button>
          <button data-act="down" data-ex="${esc(ex.id)}" aria-label="下移">↓</button>
          <span class="catalog-chevron">›</span>
        </div>`;
    });
    root.innerHTML = html;
  }

  const seedBtn = document.getElementById('seed-catalog-btn');
  if (seedBtn) seedBtn.style.display = state.strength.catalog.length ? 'none' : 'block';
}


// ---- 历史与分析页 ----
// 独立重训 app 的历史 tab。KPI + 最近训练的容量柱状图 + 逐日明细。
function renderStrengthHistory() {
  const root = document.getElementById('strength-history');
  if (!root) return;

  const entries = Object.entries(state.strength.days)
    .filter(([, rec]) => (rec.exercises || []).some((r) => (r.sets || []).length || r.durationSec))
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)); // 新的在前

  if (!entries.length) {
    root.innerHTML = '<div class="empty-hint"><p>还没有训练记录。</p><p>练完第一天，这里就会有内容。</p></div>';
    return;
  }

  const month = todayKey().slice(0, 7);
  let monthCount = 0;
  let monthVol = 0;
  entries.forEach(([d, rec]) => {
    if (d.slice(0, 7) === month) {
      monthCount += 1;
      monthVol += dayTotals(rec).volume;
    }
  });

  // 最近 12 次训练的容量柱状图，按 A / B 计划着色
  const chart = entries.slice(0, 12).reverse();
  const maxV = Math.max(...chart.map(([, r]) => dayTotals(r).volume), 1);
  const bars = chart
    .map(([d, r]) => {
      const v = dayTotals(r).volume;
      const h = Math.max(5, Math.round((v / maxV) * 100));
      const c = r.split === 'A' ? 'var(--series-blue)' : 'var(--series-aqua)';
      return `
        <div class="hbar-col" title="${d} · ${fmt(v)} kg·次">
          <div class="hbar" style="height:${h}%;background:${c}"></div>
          <span>${Number(d.slice(5, 7))}/${Number(d.slice(8))}</span>
        </div>`;
    })
    .join('');

  const list = entries
    .map(([d, rec]) => {
      const rows = (rec.exercises || [])
        .map((r) => {
          const ex = exerciseById(r.exerciseId);
          if (!ex) return '';
          if (isCardio(ex)) {
            return `<div class="h-ex"><span>${esc(ex.name)}</span><span class="h-sets">${Math.round((r.durationSec || 0) / 60)} min</span></div>`;
          }
          const sets = r.sets || [];
          if (!sets.length) return '';
          const reps = sets.map((x) => fmt(x.reps)).join('/');
          const w = weightLabel(ex, sets[sets.length - 1].weight);
          return `<div class="h-ex"><span>${esc(ex.name)}</span><span class="h-sets">${w} · ${reps}</span></div>`;
        })
        .join('');
      const t = dayTotals(rec);
      return `
        <div class="h-day">
          <div class="h-day-head">
            <b>${d.replace(/-/g, '/')}</b>
            <span class="h-split ${rec.split}">${rec.split}</span>
            <span class="h-vol">${fmt(t.volume)} kg·次</span>
          </div>
          ${rows}
        </div>`;
    })
    .join('');

  root.innerHTML = `
    <div class="kpi-row">
      <div class="kpi-tile"><div class="kpi-label">本月训练</div><div class="kpi-value">${monthCount} 次</div></div>
      <div class="kpi-tile"><div class="kpi-label">本月容量</div><div class="kpi-value">${fmt(monthVol)}</div></div>
      <div class="kpi-tile"><div class="kpi-label">累计</div><div class="kpi-value">${entries.length} 次</div></div>
    </div>
    <div class="hchart">
      <div class="hchart-legend">
        <span><span class="dot" style="background:var(--series-blue)"></span>A 计划</span>
        <span><span class="dot" style="background:var(--series-aqua)"></span>B 计划</span>
      </div>
      <div class="hchart-bars">${bars}</div>
    </div>
    <div class="h-list">${list}</div>`;
}

window.initStrength = initStrength;
window.renderStrength = renderStrength;
window.showStrengthForm = showStrengthForm;
window.initCatalog = initCatalog;
window.renderCatalog = renderCatalog;
window.renderStrengthHistory = renderStrengthHistory;
window.openCatalogPage = openCatalogPage;
