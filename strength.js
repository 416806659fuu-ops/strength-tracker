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
// 非空时说明正在从「历史」tab 点进来改某一天的记录（补记/改错），
// strengthDate 被故意指向了过去——下面 initStrength() 里的跨天检查得知道
// 这不是「忘了切到今天」，不能把人拽回去。
let viewingHistoryDate = null;

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
  // 没有「归档」这个中间态了：动作要么在目录里（对应计划的训练页就会出现），
  // 要么被删掉。旧数据里可能还留着 archived:true 的动作（归档功能下线前
  // 产生的），这里不再认这个字段，让它们正常显示回来。
  return state.strength.catalog.filter((e) => e.split === split).sort((a, b) => (a.order || 0) - (b.order || 0));
}

// 当天该显示哪些动作：该分化下的动作，外加当天已经记过、但如今改了分化的动作
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

// 「仅本次」编辑的合并点：某天的记录如果带了 override，就用它盖掉动作库
// 的对应字段——训练中/表单里/历史页，所有「这个动作现在怎么练」的地方
// 都从这一个函数过，不用到处判断有没有 override。
function effectiveExercise(ex, rec) {
  return rec && rec.override ? Object.assign({}, ex, rec.override) : ex;
}

// ---- 计重与容量 ----
function weightLabel(ex, w) {
  if (ex.weightMode === 'bodyweight') return '自重';
  if (w === null || w === undefined || w === '') return '—';
  // 左右分计跟双侧各计一样，都是「一个数字，两侧各用这个重量」
  if (ex.weightMode === 'pair' || ex.weightMode === 'unilateral') return `${fmt(w)}kg×2`;
  if (ex.weightMode === 'level') return `档 ${fmt(w)}`;
  return `${fmt(w)}kg`;
}

// 左右分计的组，次数字符串显示成「8/6」而不是合计的 14——一眼看出两边差多少
function repsLabel(s) {
  if (s.repsBySide) return `${fmt(s.repsBySide.L)}/${fmt(s.repsBySide.R)}`;
  return fmt(s.reps);
}

// 有氧、自重和器械档位都不计入容量：
// 档位是机器刻度不是公斤数，乘起来没有物理意义；有氧根本没有重量和次数。
function setVolume(ex, s) {
  if (isCardio(ex)) return 0;
  const reps = Number(s.reps) || 0;
  const w = Number(s.weight) || 0;
  if (ex.weightMode === 'bodyweight' || ex.weightMode === 'level') return 0;
  if (ex.weightMode === 'unilateral') {
    // 正常情况下用左右分开记的次数算；没有 repsBySide 的老数据/手填数据，
    // 退回跟 pair 一样的公式兜底
    if (s.repsBySide) return w * ((Number(s.repsBySide.L) || 0) + (Number(s.repsBySide.R) || 0));
    return w * 2 * reps;
  }
  if (ex.weightMode === 'pair') return w * 2 * reps;
  return w * reps;
}

function dayTotals(day) {
  let volume = 0;
  let sets = 0;
  let reps = 0;
  day.exercises.forEach((rec) => {
    const rawEx = exerciseById(rec.exerciseId);
    if (!rawEx) return;
    const ex = effectiveExercise(rawEx, rec);
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
  // 训练页平时永远是今天；时钟每 10 秒走一格，跨天（比如练到半夜十二点）
  // 自动翻到新的一天。但如果正在从历史页编辑某一天（viewingHistoryDate
  // 非空），这个检查得让路，不然 10 秒内就会被强制拽回今天。
  updateDateClock();
  setInterval(() => {
    if (!viewingHistoryDate && todayKey() !== strengthDate) {
      strengthDate = todayKey();
      forceFormMode = false;
      renderStrength();
    }
    updateDateClock();
  }, 10000);

  document.getElementById('back-to-session-btn').addEventListener('click', () => {
    if (viewingHistoryDate) {
      viewingHistoryDate = null;
      strengthDate = todayKey();
      forceFormMode = false;
      renderStrength();
    } else {
      showStrengthForm(false);
    }
  });

  document.getElementById('confirm-edit-btn').addEventListener('click', () => {
    // 输入框其实是失焦/回车就存了，这里只是把当前还聚着焦、没触发 blur 的
    // 那一个也强制提交一次，再给个明确的提示——纯粹是让人放心的确认动作
    if (document.activeElement) document.activeElement.blur();
    showToast(`已保存 ${viewingHistoryDate ? viewingHistoryDate.replace(/-/g, '/') : ''} 的修改`);
  });

  // 历史页点某一天 = 进补记模式改那天的记录：加/删组、改计划归属，
  // 复用表单模式本来就有的这套逻辑（本来就不认「今天」，只认 strengthDate）。
  const historyRoot = document.getElementById('strength-history');
  if (historyRoot) {
    historyRoot.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.h-day .swipe-delete-btn');
      if (delBtn) {
        const date = delBtn.dataset.date;
        if (confirm(`删除 ${date} 的整条训练记录？无法恢复。`)) {
          delete state.strength.days[date];
          markDirty();
          renderStrengthHistory();
        }
        return;
      }
      const dayEl = e.target.closest('.h-day');
      if (!dayEl || !dayEl.dataset.date) return;
      openHistoryDayEdit(dayEl.dataset.date);
    });
  }

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
    const editBtn = e.target.closest('.exercise-edit-btn');
    if (editBtn) {
      openExerciseDetail(editBtn.dataset.ex, { dayKey: strengthDate });
      return;
    }
    const delBtn = e.target.closest('.set-row .swipe-delete-btn');
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
    if (
      e.target.classList.contains('set-weight') ||
      e.target.classList.contains('set-reps') ||
      e.target.classList.contains('set-reps-l') ||
      e.target.classList.contains('set-reps-r')
    ) {
      e.preventDefault();
      addSet(card.dataset.ex);
    } else if (
      e.target.classList.contains('set-edit-weight') ||
      e.target.classList.contains('set-edit-reps') ||
      e.target.classList.contains('set-edit-reps-l') ||
      e.target.classList.contains('set-edit-reps-r')
    ) {
      // 已经记录的组：回车 = 收起键盘触发下面的 change 保存，不是新增一组
      e.preventDefault();
      e.target.blur();
    }
  });

  // 点开某一组已经记下的重量/次数直接改——之前这两格是纯文字，看着像能点进去改，
  // 其实改不了，只能删了重加；现在改成输入框，失焦/回车就直接写回这一组。
  container.addEventListener('change', (e) => {
    const t = e.target;
    const editingWeight = t.classList.contains('set-edit-weight');
    const editingReps = t.classList.contains('set-edit-reps');
    const editingRepsL = t.classList.contains('set-edit-reps-l');
    const editingRepsR = t.classList.contains('set-edit-reps-r');
    if (!editingWeight && !editingReps && !editingRepsL && !editingRepsR) return;

    const exId = t.dataset.ex;
    const idx = Number(t.dataset.idx);
    const day = sEnsureDay(strengthDate);
    const rec = recordFor(day, exId);
    const s = rec && rec.sets[idx];
    if (!s) return;

    if (editingWeight) {
      const v = evalCalExpr(t.value);
      if (v !== null) s.weight = v;
    } else if (editingRepsL || editingRepsR) {
      const v = evalCalExpr(t.value);
      if (!s.repsBySide) s.repsBySide = { L: 0, R: 0 };
      s.repsBySide[editingRepsL ? 'L' : 'R'] = v !== null ? v : 0;
      s.reps = s.repsBySide.L + s.repsBySide.R;
    } else {
      const v = evalCalExpr(t.value);
      if (v !== null) s.reps = v;
    }
    markDirty();
    refreshExerciseCard(exId);
  });

  // 重量框支持算式（比如递增填 40+2.5），边打字边告诉你算出来是多少，
  // 不用等失焦才知道存进去的是哪个数——跟摄入 app 的算式预览同一个思路。
  // 只有算出来的结果和原始输入不一样时才显示，免得打「8」还要多显示一遍「= 8」。
  container.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.classList.contains('calc-input')) return;
    const preview = t.nextElementSibling;
    if (!preview || !preview.classList.contains('calc-preview')) return;
    const raw = t.value.trim();
    const val = evalCalExpr(raw);
    if (val === null || raw === '' || String(val) === raw) {
      preview.textContent = '';
      preview.classList.remove('show');
    } else {
      preview.textContent = `= ${fmt(val)}`;
      preview.classList.add('show');
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
  const rawEx = exerciseById(exId);
  if (!rawEx) return;
  const day = sEnsureDay(strengthDate);
  const ex = effectiveExercise(rawEx, recordFor(day, exId));
  const card = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  const weightInput = card.querySelector('.set-weight');

  // 左右分计：左右各一个框，跟单一次数框长得不一样，别再混着猜
  let reps;
  let repsBySide;
  if (ex.weightMode === 'unilateral') {
    const lInput = card.querySelector('.set-reps-l');
    const rInput = card.querySelector('.set-reps-r');
    const L = evalCalExpr(lInput.value);
    const R = evalCalExpr(rInput.value);
    if ((L === null || L <= 0) && (R === null || R <= 0)) {
      lInput.focus();
      return;
    }
    repsBySide = { L: L || 0, R: R || 0 };
    reps = repsBySide.L + repsBySide.R;
  } else {
    const repsInput = card.querySelector('.set-reps');
    reps = evalCalExpr(repsInput.value);
    if (reps === null || reps <= 0) {
      repsInput.focus();
      return;
    }
  }
  // 自重动作没有重量输入框
  const weight = ex.weightMode === 'bodyweight' ? null : evalCalExpr(weightInput ? weightInput.value : '');
  if (ex.weightMode !== 'bodyweight' && weight === null) {
    weightInput.focus();
    return;
  }

  const rec = ensureRecord(day, exId);
  const tag = pendingTag[exId] ?? null;
  rec.sets.push(Object.assign({ weight, reps, tags: tag ? [tag] : [] }, repsBySide ? { repsBySide } : null));
  markDirty();

  pendingTag[exId] = null;
  // 只重画这一张卡，别动其他卡——你可能已经在下一个动作的框里填了重量还没提交
  refreshExerciseCard(exId);

  const nextCard = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  const nextInput = nextCard && (nextCard.querySelector('.set-reps') || nextCard.querySelector('.set-reps-l'));
  if (nextInput) nextInput.focus();
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
  // 在改历史记录时把标签换成具体日期，别让人以为自己在改「今天」
  const label = document.getElementById('s-hero-label');
  if (label) label.textContent = viewingHistoryDate ? `${viewingHistoryDate.replace(/-/g, '/')} 训练容量` : '今日训练容量';
}

function renderSetRow(ex, s, i) {
  const info = tagInfo(s.tags && s.tags.length ? s.tags[0] : null);
  const tagChip = s.tags && s.tags.length ? `<span class="set-tag" style="color:${info.color}">${info.label}</span>` : '';
  // 重量/次数是输入框，不是纯文字——点进去能直接改，失焦就存（container 的
  // change 监听器接住）。删除挪到往左滑才露出的按钮，小×太容易误触/漏点。
  // 输入框里只放数字本身，单位（kg/档/×2）挪到旁边一个不能点的小字，
  // 不然编辑的时候框里还带着单位，改起来碍事。
  const unitHint = ex.weightMode === 'level' ? '档' : ex.weightMode === 'pair' || ex.weightMode === 'unilateral' ? '×2' : ex.weightMode === 'bodyweight' ? '' : 'kg';
  const weightInput =
    ex.weightMode === 'bodyweight'
      ? '<span class="set-bodyweight-label">自重</span>'
      : `<span class="calc-field"><input class="set-edit-weight calc-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
           value="${esc(fmt(s.weight))}" data-ex="${esc(ex.id)}" data-idx="${i}"><span class="calc-preview"></span></span><span class="set-unit-hint">${unitHint}</span>`;
  // 左右分计用两个各自独立的输入框（左/右），不是一个框里塞「8/6」这种格式——
  // 没有 repsBySide 的老数据/手填数据对半分一下，好歹能进去改，不会一片空白
  const repsInput = ex.weightMode === 'unilateral'
    ? `<span class="set-reps-side-group">
         <input class="set-edit-reps-l" type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
           value="${esc(fmt(s.repsBySide ? s.repsBySide.L : Math.round((s.reps || 0) / 2)))}" data-ex="${esc(ex.id)}" data-idx="${i}">
         <span class="set-reps-side-sep">/</span>
         <input class="set-edit-reps-r" type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
           value="${esc(fmt(s.repsBySide ? s.repsBySide.R : Math.round((s.reps || 0) / 2)))}" data-ex="${esc(ex.id)}" data-idx="${i}">
       </span>`
    : `<input class="set-edit-reps" type="text" inputmode="numeric" autocomplete="off" spellcheck="false"
         value="${esc(fmt(s.reps))}" data-ex="${esc(ex.id)}" data-idx="${i}">`;
  return `
    <div class="set-row swipe-row">
      <div class="swipe-track">
        <div class="swipe-content">
          <span class="set-idx">${i + 1}</span>
          ${weightInput}
          <span class="set-x">×</span>
          ${repsInput}
          ${tagChip}
        </div>
        <button class="swipe-delete-btn" data-ex="${esc(ex.id)}" data-idx="${i}" aria-label="删除这一组">删除</button>
      </div>
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
        <button class="exercise-edit-btn" data-ex="${esc(ex.id)}" aria-label="编辑这个动作">✎</button>
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

function renderExerciseCard(rawEx, day) {
  if (isCardio(rawEx)) return renderCardioCard(rawEx, day);
  const rec = recordFor(day, rawEx.id);
  const ex = effectiveExercise(rawEx, rec); // 今天有「仅本次」override 就用它
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
    ? `<div class="last-session">上次 ${prev.date.slice(5)}：${prev.sets.map((s) => repsLabel(s)).join(' / ')}</div>`
    : '<div class="last-session muted">这是第一次记录</div>';

  const defW = defaultWeightFor(ex, rec);
  const weightInput =
    ex.weightMode === 'bodyweight'
      ? '<span class="set-bodyweight">自重</span>'
      : `<span class="calc-field"><input class="set-weight calc-input" type="text" inputmode="text" autocomplete="off" spellcheck="false"
           value="${esc(defW)}" placeholder="${ex.weightMode === 'level' ? '档位' : '重量kg'}"><span class="calc-preview"></span></span>`;

  return `
    <div class="exercise-card" data-ex="${esc(ex.id)}">
      <div class="exercise-head">
        <span class="exercise-name">${esc(ex.name)}</span>
        <button class="exercise-edit-btn" data-ex="${esc(ex.id)}" aria-label="编辑这个动作">✎</button>
        <span class="exercise-summary">${summary}</span>
      </div>
      ${prevHtml}
      <div class="set-list">${setsHtml}</div>
      <div class="add-row">
        <button class="tag-toggle" data-ex="${esc(ex.id)}">● 正式</button>
        ${weightInput}
        ${ex.weightMode === 'unilateral'
          ? `<span class="set-reps-side-group">
               <input class="set-reps-l" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="左">
               <span class="set-reps-side-sep">/</span>
               <input class="set-reps-r" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="右">
             </span>`
          : `<input class="set-reps" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="次数">`}
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

// 从历史页点某一天进来：把 strengthDate 指过去，走的还是表单模式的
// add/del-set、split-switch 那套（strengthDate !== todayKey() 时
// renderStrength() 已经自动只走表单模式，不用另外分支）。
function openHistoryDayEdit(dateKey) {
  viewingHistoryDate = dateKey;
  strengthDate = dateKey;
  switchView('strength');
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
  const backBtn = document.getElementById('back-to-session-btn');
  if (viewingHistoryDate) {
    backBtn.textContent = '返回今天';
    backBtn.style.display = '';
  } else {
    backBtn.textContent = '返回训练模式';
    backBtn.style.display = !useSession && isToday ? '' : 'none';
  }
  // 改历史记录才需要这个按钮：字段本来就是失焦即存，这个按钮的作用是给一个
  // 明确的「存好了」反馈——用户反馈过一次"输入不进去也存不上"，光是自动保存
  // 不够让人放心，加个能主动点一下的确认动作。
  document.getElementById('confirm-edit-btn').style.display = viewingHistoryDate ? '' : 'none';

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
  { key: 'unilateral', label: '左右分计', hint: '先记左边再记右边，比如保加利亚单腿蹲最后一组两边次数不一样' },
  { key: 'level', label: '器械档位', hint: '配重片上的刻度，不是公斤' },
  { key: 'bodyweight', label: '自重', hint: '不加负重' },
];

// 你现在真正在练的：A 计划练腿 4 项，B 计划胸背 3 项 + 爬坡走有氧。顺序固定。
const SEED_CATALOG = [
  { name: '传统硬拉', split: 'A', kind: 'strength', weightMode: 'single', weight: 40, step: 2.5, warmupSets: 1, workSets: 4 },
  { name: '保加利亚单腿蹲', split: 'A', kind: 'strength', weightMode: 'unilateral', weight: 4, step: 1, warmupSets: 0, workSets: 4 },
  { name: '侧平举', split: 'A', kind: 'strength', weightMode: 'pair', weight: 4, step: 1, warmupSets: 0, workSets: 4 },
  { name: '肩背中束面拉', split: 'A', kind: 'strength', weightMode: 'level', weight: 18.1, levels: [14.7, 16.97, 18.1], warmupSets: 0, workSets: 4 },
  { name: '卧推', split: 'B', kind: 'strength', weightMode: 'single', weight: 20, step: 2.5, warmupSets: 1, workSets: 4 },
  { name: '高位下拉', split: 'B', kind: 'strength', weightMode: 'single', weight: 25, step: 2.5, warmupSets: 0, workSets: 4 },
  { name: '宽距划船', split: 'B', kind: 'strength', weightMode: 'single', weight: 22.5, step: 2.5, warmupSets: 0, workSets: 4 },
  { name: '爬坡走', split: 'B', kind: 'cardio', durationMin: 20 },
];

// 这个动作被多少天的记录引用了。有引用就不能删，
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
// 从训练/表单里带着 dayKey 进来时，才有「仅本次 / 永久保存」的选择；
// 从设置→动作库直接点进来的（dayKey 为空）只有永久保存这一种概念，
// 界面上完全不出现这个切换，行为跟原来一样。
let detailDayKey = null;
let detailOnce = false;

function openExerciseDetail(exId, ctx) {
  detailExId = exId;
  detailDayKey = (ctx && ctx.dayKey) || null;
  detailOnce = !!detailDayKey; // 训练中点进来的默认先给「仅本次」，符合大多数场景
  document.getElementById('exercise-detail').style.display = 'block';
  document.body.style.overflow = 'hidden';
  renderExerciseDetail();
}

function closeExerciseDetail() {
  detailExId = null;
  detailDayKey = null;
  detailOnce = false;
  document.getElementById('exercise-detail').style.display = 'none';
  document.body.style.overflow = '';
  renderCatalog();
  // 训练页可能因为这次编辑（组数、重量……）需要立刻重画，不等下次切 tab
  if (window.renderStrength) window.renderStrength();
}

// 编辑写去哪：仅本次模式写进当天记录的 override，否则跟原来一样直接改目录
function detailWriteTarget() {
  if (detailDayKey && detailOnce) {
    const day = sEnsureDay(detailDayKey);
    const rec = ensureRecord(day, detailExId);
    if (!rec.override) rec.override = {};
    return rec.override;
  }
  return exerciseById(detailExId);
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
  const rawEx = exerciseById(detailExId);
  if (!rawEx) {
    closeExerciseDetail();
    return;
  }
  const day = detailDayKey ? sGetDay(detailDayKey) : null;
  const rec = day ? recordFor(day, detailExId) : null;
  const showOnce = !!detailDayKey && detailOnce; // 当前是不是在编「仅本次」的那份
  const ex = showOnce ? effectiveExercise(rawEx, rec) : rawEx;
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

  const used = usageCount(rawEx.id);
  const usedNote = used > 0 ? `已经在 ${used} 天的记录里出现过，不能删除。` : '还没有任何记录，可以直接删除。';

  // 只有从训练/表单带着 dayKey 进来才有这个切换；从设置→动作库直接进来的
  // 没有「今天」这个概念，行为跟原来一样——全部当永久保存，不显示切换。
  const scopeToggle = detailDayKey
    ? `
    <div class="detail-field detail-scope">
      <div class="pill-row">
        <button class="pill scope-btn${detailOnce ? ' active' : ''}" data-scope="once">仅本次</button>
        <button class="pill scope-btn${!detailOnce ? ' active' : ''}" data-scope="permanent">永久保存</button>
      </div>
      <p class="detail-hint">${detailOnce ? '改动只影响今天的记录，动作库里的默认设置不会变。' : '改动会直接写进动作库，以后每次训练都用新设置。'}</p>
      ${showOnce && rec && rec.override ? '<button class="settings-btn" id="d-reset-override">恢复今日默认设置</button>' : ''}
    </div>`
    : '';

  // 名称/计划归属/类型/删除都是目录的身份字段，「仅本次」模式下没有意义，不显示
  const identityBlock = showOnce
    ? ''
    : `
    ${detailField('名称', '', `<input class="d-name" type="text" value="${esc(rawEx.name)}">`)}
    ${detailField(
      '属于哪套计划',
      '',
      `<div class="pill-row">
        <button class="pill split-btn${rawEx.split === 'A' ? ' active' : ''}" data-split="A">A 计划（腿）</button>
        <button class="pill split-btn${rawEx.split === 'B' ? ' active' : ''}" data-split="B">B 计划（胸背）</button>
      </div>`
    )}
    ${detailField(
      '类型',
      '',
      `<div class="pill-row">
        <button class="pill kind-btn${!cardio ? ' active' : ''}" data-kind="strength">力量</button>
        <button class="pill kind-btn${cardio ? ' active' : ''}" data-kind="cardio">有氧</button>
      </div>`
    )}`;

  // 没有「归档」这个中间状态了——目录里的动作要么在（对之后每次训练都生效，
  // 不分「今天加的」和「以前就有的」），要么删掉。这里两个按钮都不是真的在
  // "add"：字段本来就是失焦即存，「添加项目」点了只是关掉详情页、回到目录，
  // 给一个明确的"存好了"反馈（原来没有这一下，容易被当成没保存成功）。
  const dangerBlock = showOnce
    ? ''
    : `
    <div class="detail-danger">
      <p class="detail-hint">${usedNote}</p>
      <button class="settings-btn primary" id="d-confirm-add">添加项目</button>
      <button class="settings-btn danger" id="d-delete"${used > 0 ? ' disabled' : ''}>删除此项目</button>
    </div>`;

  body.innerHTML = `
    ${scopeToggle}
    ${identityBlock}
    ${cardio ? cardioBlock : strengthBlock}
    ${dangerBlock}`;

  document.getElementById('detail-title').textContent = rawEx.name;
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

    const scopeBtn = e.target.closest('.scope-btn');
    if (scopeBtn) {
      detailOnce = scopeBtn.dataset.scope === 'once';
      renderExerciseDetail();
      return;
    }
    if (e.target.id === 'd-reset-override') {
      const day = sGetDay(detailDayKey);
      const rec = recordFor(day, detailExId);
      if (rec) delete rec.override;
      markDirty();
      renderExerciseDetail();
      return;
    }
    const modeBtn = e.target.closest('.mode-btn');
    if (modeBtn) {
      const target = detailWriteTarget();
      target.weightMode = modeBtn.dataset.mode;
      if (target.weightMode === 'level' && !target.levels) target.levels = [];
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
    if (e.target.id === 'd-confirm-add') {
      // 字段本来就是失焦即存，这里不用额外写什么，纯粹是给一个"关掉=存好了"
      // 的明确反馈，跟点返回箭头效果一样。
      closeExerciseDetail();
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

    // 名称是目录的身份字段，「仅本次」模式下这个输入框根本不会渲染出来，
    // 不需要判断 target——能走到这个分支就一定是永久模式
    if (t.classList.contains('d-name')) {
      ex.name = t.value.trim() || ex.name;
      document.getElementById('detail-title').textContent = ex.name;
      markDirty();
      return;
    }

    const target = detailWriteTarget();
    if (t.classList.contains('d-weight')) {
      target.weight = evalCalExpr(t.value);
    } else if (t.classList.contains('d-step')) {
      const v = evalCalExpr(t.value);
      target.step = v && v > 0 ? v : 2.5;
      t.value = target.step;
    } else if (t.classList.contains('d-levels')) {
      target.levels = parseLevels(t.value);
      t.value = target.levels.join(', ');
    } else if (t.classList.contains('d-warmup')) {
      target.warmupSets = Number(t.value);
    } else if (t.classList.contains('d-work')) {
      target.workSets = Number(t.value);
    } else if (t.classList.contains('d-duration')) {
      const v = evalCalExpr(t.value);
      target.durationMin = v && v > 0 ? Math.round(v) : 20;
      t.value = target.durationMin;
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
    // 每套计划清单下面那个「+」：直接把下面常驻的新增框预设成这个计划，
    // 光标也点过去，不用自己再从下拉菜单里选一遍
    const addBtn = e.target.closest('.catalog-split-add');
    if (addBtn) {
      document.getElementById('catalog-new-split').value = addBtn.dataset.split;
      const nameInput = document.getElementById('catalog-new-name');
      nameInput.focus();
      nameInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  if (!state.strength.catalog.length) {
    root.innerHTML = '<p class="settings-note">还没有动作。点下面的「载入预设动作库」，或者自己一个个加。</p>';
  } else {
    // A、B 两组固定都渲染，不是「有动作才出现」——不然某个计划一个动作都
    // 没有时，连标题和「+」都不会出现，没法给它加第一个动作。
    const html = ['A', 'B']
      .map((split) => {
        const rows = state.strength.catalog
          .filter((ex) => ex.split === split)
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map(
            (ex) => `
        <div class="catalog-row" data-ex="${esc(ex.id)}">
          <div class="catalog-row-main">
            <span class="catalog-name">${esc(ex.name)}</span>
            <span class="catalog-sub">${exerciseSummary(ex)}</span>
          </div>
          <button data-act="up" data-ex="${esc(ex.id)}" aria-label="上移">↑</button>
          <button data-act="down" data-ex="${esc(ex.id)}" aria-label="下移">↓</button>
          <span class="catalog-chevron">›</span>
        </div>`
          )
          .join('');
        return `
        <div class="catalog-split-head">${splitLabel(split)}</div>
        ${rows}
        <button class="catalog-split-add" data-split="${split}">+ 添加到${splitLabel(split)}</button>`;
      })
      .join('');
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
          const rawEx = exerciseById(r.exerciseId);
          if (!rawEx) return '';
          const ex = effectiveExercise(rawEx, r);
          if (isCardio(ex)) {
            return `<div class="h-ex"><span>${esc(ex.name)}</span><span class="h-sets">${Math.round((r.durationSec || 0) / 60)} min</span></div>`;
          }
          const sets = r.sets || [];
          if (!sets.length) return '';
          const reps = sets.map((x) => repsLabel(x)).join(' / ');
          const w = weightLabel(ex, sets[sets.length - 1].weight);
          return `<div class="h-ex"><span>${esc(ex.name)}</span><span class="h-sets">${w} · ${reps}</span></div>`;
        })
        .join('');
      const t = dayTotals(rec);
      return `
        <div class="h-day swipe-row" data-date="${d}">
          <div class="swipe-track">
            <div class="swipe-content" data-date="${d}">
              <div class="h-day-head">
                <b>${d.replace(/-/g, '/')}</b>
                <span class="h-split ${rec.split}">${rec.split}</span>
                <span class="h-vol">${fmt(t.volume)} kg·次</span>
                <span class="h-edit-hint">✎</span>
              </div>
              ${rows}
            </div>
            <button class="swipe-delete-btn" data-date="${d}" aria-label="删除这一天">删除</button>
          </div>
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
