// ---- 全屏训练页 ----
// 一屏只有当前这一组：拖拽滚轮选次数，− / + 调重量，
// 点「休息」就确认这一组、开始倒计时、推进到下一组。
//
// 两个休息按钮语义不同：
//   休     —— 调整用休息，只倒计时，不确认记录、不推进
//   60s    —— 组间休息，确认当前次数并推进（时长随情境变：30 / 60 / 180）
//
// iOS 会在锁屏时冻结网页里的计时器，所以：
//   1. 倒计时记的是「结束时刻」而不是「还剩几秒」，被冻结后回来仍然准确
//   2. 倒计时期间申请 Wake Lock 保持屏幕常亮，这样提示音才响得出来
// iOS Safari 不支持 navigator.vibrate，震动没戏，只能靠声音和屏幕。

const REPS_MIN = 1;
const REPS_MAX = 30;

// 进度条上每个动作一种颜色，循环使用
// 设计稿（Ver.1.0.6）的四色：橙 / 绿 / 蓝 / 红，进度条和圆点共用
const EXERCISE_COLORS = ['#d68b41', '#7bc865', '#6595c8', '#d94b4f', '#1baf7a'];

let sessionWeight = null; // 当前组的重量，随 −/+ 变化
let sessionReps = null; // 滚轮当前停在哪个数
let restEndAt = null; // 倒计时结束时刻（毫秒时间戳）
let restTotal = 0; // 这次休息一共多少秒，用来画圆环
let restConfirms = false; // 这次休息结束后要不要推进到下一组
let restTimer = null;
let wakeLock = null;
let audioCtx = null;
let cardioEndAt = null; // 有氧倒计时

// ---- 会话结构 ----
function planFor(ex) {
  if (isCardio(ex)) return 1;
  return (ex.warmupSets || 0) + (ex.workSets || 0);
}

function isWarmupIdx(ex, setIdx) {
  return setIdx < (ex.warmupSets || 0);
}

function sessionExercises(day) {
  return visibleExercises(day).map((ex) => {
    const rec = recordFor(day, ex.id);
    const done = isCardio(ex)
      ? rec && rec.durationSec
        ? 1
        : 0
      : rec
        ? rec.sets.length
        : 0;
    return { ex, rec, planned: planFor(ex), done };
  });
}

// 当前该练哪个动作的第几组。全部练完返回 null。
function currentPos(list) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].done < list[i].planned) return { exIdx: i, setIdx: list[i].done };
  }
  return null;
}

// 刚做完 list[exIdx] 的第 setIdx 组，接下来该休息多久
function restSecondsAfter(list, exIdx, setIdx) {
  const rest = state.settings.rest || DEFAULT_REST;
  const item = list[exIdx];
  if (isWarmupIdx(item.ex, setIdx)) return rest.afterWarmup;
  if (setIdx < item.planned - 1) return rest.betweenSets;
  // 这个动作练完了。如果后面还有动作，就是动作间的长休息。
  const hasNext = list.slice(exIdx + 1).some((it) => it.done < it.planned);
  return hasNext ? rest.betweenExercises : 0;
}

// 滚轮进入一组时停在哪：优先用上次同一组的次数
function defaultRepsFor(ex, setIdx, rec) {
  const prev = lastSession(ex.id, strengthDate);
  if (prev && prev.sets[setIdx] != null) return Number(prev.sets[setIdx].reps) || 10;
  if (rec && rec.sets.length) return Number(rec.sets[rec.sets.length - 1].reps) || 10;
  return 10;
}

function defaultSessionWeight(ex, rec) {
  if (isCardio(ex) || ex.weightMode === 'bodyweight') return null;
  if (rec && rec.sets.length) {
    const w = rec.sets[rec.sets.length - 1].weight;
    if (w != null) return w;
  }
  return ex.weight ?? null;
}

// ---- 重量加减 ----
function nearestLevelIndex(levels, w) {
  let best = 0;
  let bestDiff = Infinity;
  levels.forEach((lv, i) => {
    const d = Math.abs(lv - w);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}

function adjustWeight(dir) {
  const list = sessionExercises(sGetDay(strengthDate));
  const pos = currentPos(list);
  if (!pos) return;
  const ex = list[pos.exIdx].ex;
  if (isCardio(ex) || ex.weightMode === 'bodyweight') return;

  const levels = ex.levels || [];
  if (ex.weightMode === 'level' && levels.length) {
    // 器械刻度不等距，只在机器真有的档位之间跳
    const i = nearestLevelIndex(levels, sessionWeight ?? levels[0]);
    const next = Math.min(Math.max(i + dir, 0), levels.length - 1);
    sessionWeight = levels[next];
  } else {
    const step = ex.step || 2.5;
    sessionWeight = Math.max(0, Math.round(((sessionWeight || 0) + dir * step) * 100) / 100);
  }
  renderSessionWeight();
}

// ---- 提示音 / 屏幕常亮 ----
// AudioContext 必须在用户手势里创建或恢复，否则 iOS 不让出声
function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {
    /* 没声音也不影响记录 */
  }
}

function beep() {
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    [0, 0.18].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
      osc.start(now + offset);
      osc.stop(now + offset + 0.16);
    });
  } catch (e) {
    /* 同上 */
  }
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    /* 用户拒绝或系统不允许，倒计时照常走，只是屏幕会灭 */
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
}

// 从后台切回来时 Wake Lock 会失效，重新申请
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (restEndAt || cardioEndAt)) acquireWakeLock();
});

// ---- 倒计时 ----
function startRest(seconds, confirms) {
  primeAudio();
  if (seconds <= 0) {
    if (confirms) advanceAfterRest();
    return;
  }
  const zone = document.getElementById('wheel-zone');
  if (!zone) return; // 有氧屏没有组间休息
  restTotal = seconds;
  restEndAt = Date.now() + seconds * 1000;
  restConfirms = confirms;
  acquireWakeLock();
  zone.classList.add('resting');
  // 暂停型休息（不推进）才显示「提前结束训练」——想收工先按暂停缓一缓再决定
  zone.classList.toggle('adjust', !confirms);
  tickRest();
  clearInterval(restTimer);
  restTimer = setInterval(tickRest, 200);
}

function remainingSeconds() {
  return Math.max(0, Math.ceil((restEndAt - Date.now()) / 1000));
}

function tickRest() {
  const left = remainingSeconds();
  const valueEl = document.getElementById('rest-value');
  const circle = document.getElementById('rest-ring-fg');
  if (!valueEl || !circle) return;
  valueEl.textContent = left;
  const ratio = restTotal > 0 ? left / restTotal : 0;
  const CIRC = 2 * Math.PI * 90;
  // 负偏移让缺口从另一端收 —— 顺时针减少
  circle.style.strokeDashoffset = String(-CIRC * (1 - ratio));

  if (left <= 0) finishRest();
}

function finishRest() {
  clearInterval(restTimer);
  restTimer = null;
  restEndAt = null;
  releaseWakeLock();
  const zone = document.getElementById('wheel-zone');
  if (zone) zone.classList.remove('resting');
  beep();
  if (restConfirms) advanceAfterRest();
  restConfirms = false;
}

// 提前结束休息（点圆环）
function skipRest() {
  finishRest();
}

function advanceAfterRest() {
  renderSession();
}

// ---- 选定今天的计划 ----
// 点 A / B 只是提出意向，弹「今天练腿！/今天练背！」确认之后才锁定。
// 锁定后当天不能再改 —— 计划就是用来执行的。
let pendingSplit = null;

function nowDateStr() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} 周${WEEKDAYS[d.getDay()]}`;
}

// 每个项目大约要练多久：力量 = 组数×3 分钟向上取整到 5；有氧 = 设定时长
function estimateMinutes(ex) {
  if (isCardio(ex)) return ex.durationMin ?? 20;
  const sets = (ex.warmupSets || 0) + (ex.workSets || 0);
  return Math.ceil((sets * 3) / 5) * 5;
}

function totalMinutesLabel(list) {
  let total = list.reduce((n, ex) => n + estimateMinutes(ex), 0);
  total += Math.max(0, list.length - 1) * 3; // 项目间的长休息
  total = Math.round(total / 5) * 5;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h${m ? m + 'min' : ''}` : `${m}min`;
}

// 选计划页（Figma 21:21）：大字母 + 该计划四个项目的色点
function renderPlanChooser(body) {
  document.getElementById('session-head').innerHTML = '';
  document.getElementById('session-progress').innerHTML = '';
  const dots = (sp) =>
    exercisesForSplit(sp)
      .slice(0, 4)
      .map((ex, i) => `<span style="background:${EXERCISE_COLORS[i % EXERCISE_COLORS.length]}"></span>`)
      .join('');
  // 4 行网格（Figma layoutGrids：4 行 × 203.5，沟 20）：
  // 标题第 1 行、A 第 2 行、B 第 3 行，第 4 行留空 —— A/B 落在画面中段
  body.innerHTML = `
    <div class="chooser-grid">
      <div class="chooser-head">
        <span class="c-date" id="s-date-label">${nowDateStr()}</span>
        <h2 class="c-title">今天练什么？</h2>
      </div>
      <button class="plan-row" data-split="A">
        <span class="plan-letter">A</span>
        <span class="plan-dotgrid">${dots('A')}</span>
      </button>
      <button class="plan-row" data-split="B">
        <span class="plan-letter">B</span>
        <span class="plan-dotgrid">${dots('B')}</span>
      </button>
      <div class="chooser-spacer"></div>
    </div>`;
}

// 确认页（Figma 21:100 / 21:145）：巨大字母 + 项目清单 + 预计时长 + 开始
function renderPlanConfirm(body) {
  document.getElementById('session-head').innerHTML = '';
  document.getElementById('session-progress').innerHTML = '';
  const list = exercisesForSplit(pendingSplit);
  const rows = list
    .map(
      (ex, i) => `
      <div class="confirm-item">
        <span class="ci-dot" style="background:${EXERCISE_COLORS[i % EXERCISE_COLORS.length]}"></span>
        <span class="ci-name">${esc(ex.name)}</span>
        <span class="ci-min">${estimateMinutes(ex)}min</span>
      </div>`
    )
    .join('');
  // 与选计划页同一套 4 行网格：标题第 1 行底、字母第 2 行居中、
  // 清单/总时长/开始/再想想 从第 3 行顶部起竖排（自然延伸到第 4 行）
  body.innerHTML = `
    <div class="chooser-grid confirm-grid">
      <div class="chooser-head">
        <span class="c-date" id="s-date-label">${nowDateStr()}</span>
        <h2 class="c-title">${pendingSplit === 'A' ? '今天练腿！' : '今天练背！'}</h2>
      </div>
      <div class="confirm-letter">${pendingSplit}</div>
      <div class="confirm-bottom">
        <div class="confirm-list">${rows}</div>
        <div class="confirm-total">需要时间：${totalMinutesLabel(list)}</div>
        <button class="start-btn" id="plan-start">开始</button>
        <button class="rethink-btn" id="plan-rethink">再想想</button>
      </div>
    </div>`;
}

function openPlanConfirm(split) {
  pendingSplit = split;
  renderStrength();
}

function confirmPlan() {
  if (!pendingSplit) return;
  const day = sEnsureDay(strengthDate);
  day.split = pendingSplit;
  day.confirmed = true;
  pendingSplit = null;
  markDirty();
  renderStrength();
}

// ---- 确认一组 ----
function confirmSet() {
  const day = sEnsureDay(strengthDate);
  const list = sessionExercises(day);
  const pos = currentPos(list);
  if (!pos) return;

  const item = list[pos.exIdx];
  const ex = item.ex;
  const rec = ensureRecord(day, ex.id);
  const warmup = isWarmupIdx(ex, pos.setIdx);

  rec.sets.push({
    weight: sessionWeight,
    reps: sessionReps,
    tags: [],
    warmup,
  });
  markDirty();

  const seconds = restSecondsAfter(list, pos.exIdx, pos.setIdx);
  // 先把界面推进到下一组，再盖上倒计时盘
  renderSession();
  startRest(seconds, true);
}

// 「休」：只休息，不确认、不推进
function adjustmentRest() {
  const rest = state.settings.rest || DEFAULT_REST;
  startRest(rest.betweenSets, false);
}

// 「提前结束训练」：随时可以收工，切到档案视图看今天记了什么。
// 这个按钮全程都在，因为想中途退出时（不舒服、器械被占、时间不够），
// 右侧那个「完成」按钮要练到最后一组才出现，那时候你已经不需要它了。
function finishDay() {
  const day = sGetDay(strengthDate);
  const list = sessionExercises(day);
  const left = list.reduce((n, it) => n + Math.max(0, it.planned - it.done), 0);

  if (left === 0) {
    reallyFinishDay();
    return;
  }
  // 浏览器原生 confirm 会跳出手机界面，很出戏 —— 用手机内的弹窗
  document.getElementById('finish-confirm-text').textContent =
    `计划里还有 ${left} 组没做，确定今天就到这里吗？已经记下的组都会保留。`;
  document.getElementById('finish-confirm').style.display = 'flex';
}

function reallyFinishDay() {
  document.getElementById('finish-confirm').style.display = 'none';
  clearInterval(restTimer);
  restTimer = null;
  restEndAt = null;
  releaseWakeLock();
  window.showStrengthForm(true);
  showToast('训练已结束');
}

// ---- 有氧计时 ----
function startCardio() {
  const day = sEnsureDay(strengthDate);
  const list = sessionExercises(day);
  const pos = currentPos(list);
  if (!pos) return;
  const ex = list[pos.exIdx].ex;
  primeAudio();
  cardioEndAt = Date.now() + (ex.durationMin ?? 20) * 60 * 1000;
  acquireWakeLock();
  tickCardio();
  clearInterval(restTimer);
  restTimer = setInterval(tickCardio, 500);
}

function tickCardio() {
  const left = Math.max(0, Math.ceil((cardioEndAt - Date.now()) / 1000));
  const el = document.getElementById('cardio-clock');
  if (el) {
    const m = Math.floor(left / 60);
    const s = left % 60;
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }
  if (left <= 0) finishCardio(true);
}

function finishCardio(auto) {
  clearInterval(restTimer);
  restTimer = null;
  releaseWakeLock();
  const day = sEnsureDay(strengthDate);
  const list = sessionExercises(day);
  const pos = currentPos(list);
  if (pos) {
    const ex = list[pos.exIdx].ex;
    const rec = ensureRecord(day, ex.id);
    delete rec.sets;
    // 提前结束就记实际做了多久，自然走完就记计划时长
    const planned = (ex.durationMin ?? 20) * 60;
    const elapsed = auto ? planned : planned - Math.max(0, Math.ceil((cardioEndAt - Date.now()) / 1000));
    rec.durationSec = Math.max(60, Math.round(elapsed));
    markDirty();
  }
  cardioEndAt = null;
  if (auto) beep();
  renderSession();
}

// ---- 滚轮 ----
function buildWheel() {
  const wheel = document.getElementById('reps-wheel');
  if (wheel.dataset.built) return;
  // 横向滚轮（Figma 25:7）：小数在左、大数在右，向左滑数字变大
  let html = '<div class="wheel-pad"></div>';
  for (let i = REPS_MIN; i <= REPS_MAX; i++) {
    html += `<div class="wheel-item" data-v="${i}">${i}</div>`;
  }
  html += '<div class="wheel-pad"></div>';
  wheel.innerHTML = html;
  wheel.dataset.built = '1';

  // 音频要用户手势才能启动，第一次摸到滚轮就把它唤醒
  wheel.addEventListener('pointerdown', primeAudio, { passive: true });
  wheel.addEventListener('touchstart', primeAudio, { passive: true });

  let raf = null;
  wheel.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const before = sessionReps;
      updateWheelActive();
      // 滚过一个数字，咔哒一声（像 iOS 的拨盘）
      if (sessionReps !== before) wheelTick();
    });
  });
}

// 很短促的一声「咔」：高频方波 30ms 衰减
function wheelTick() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  try {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.type = 'square';
    osc.frequency.value = 1600;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.start(t);
    osc.stop(t + 0.035);
  } catch (e) {
    /* 没声音不影响使用 */
  }
}

// 找到最靠近滚轮中心（横向）的那一项，就是当前值
function updateWheelActive() {
  const wheel = document.getElementById('reps-wheel');
  const center = wheel.scrollLeft + wheel.clientWidth / 2;
  let best = null;
  let bestDist = Infinity;
  wheel.querySelectorAll('.wheel-item').forEach((el) => {
    const mid = el.offsetLeft + el.offsetWidth / 2;
    const dist = Math.abs(mid - center);
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  });
  if (!best) return;
  wheel.querySelectorAll('.wheel-item.active').forEach((el) => el.classList.remove('active'));
  best.classList.add('active');
  sessionReps = Number(best.dataset.v);
}

function scrollWheelTo(value, instant) {
  const wheel = document.getElementById('reps-wheel');
  const el = wheel.querySelector(`.wheel-item[data-v="${value}"]`);
  if (!el) return;
  const left = el.offsetLeft + el.offsetWidth / 2 - wheel.clientWidth / 2;
  wheel.scrollTo({ left, behavior: instant ? 'auto' : 'smooth' });
  sessionReps = value;
  wheel.querySelectorAll('.wheel-item.active').forEach((x) => x.classList.remove('active'));
  el.classList.add('active');
}

// ---- 渲染 ----
function renderProgressBar(list, curIdx) {
  const bar = document.getElementById('session-progress');
  bar.innerHTML = list
    .map((item, i) => {
      const color = EXERCISE_COLORS[i % EXERCISE_COLORS.length];
      const pct = item.planned ? Math.min(100, (item.done / item.planned) * 100) : 0;
      const isCur = i === curIdx;
      return `
        <div class="prog-seg${isCur ? ' current' : ''}">
          <div class="prog-fill" style="width:${pct}%;background:${color}"></div>
        </div>`;
    })
    .join('');
}

// 已做完的组：填色 + 显示次数。热身组用蓝色，正式组用这个动作的颜色。
// 正在做的组：颜色和做完的一样，但不显示数字（还没定下来），靠一圈描边标出位置。
// 还没做的组：灰色小点，只有正常尺寸的 1/3。
function renderDots(item, curSetIdx, color) {
  const dots = [];
  for (let i = 0; i < item.planned; i++) {
    const warm = isWarmupIdx(item.ex, i);
    const done = i < item.done;

    let cls = 'set-dot';
    let style = '';
    let label = '';

    // Ver.1.0.6：所有做完的组都用这个动作的颜色（热身不再单独蓝色）；
    // 没做的（包括正在做的）= 小灰点，当前在哪一组看滚轮。
    if (done) {
      cls += ' done';
      style = `style="background:${color}"`;
      label = item.rec.sets[i].reps;
    } else {
      cls += ' pending';
    }

    dots.push(`<span class="${cls}" ${style}>${label}</span>`);
  }
  return dots.join('');
}

function renderSessionWeight() {
  const el = document.getElementById('session-weight');
  if (!el) return;
  const list = sessionExercises(sGetDay(strengthDate));
  const pos = currentPos(list);
  if (!pos) return;
  const ex = list[pos.exIdx].ex;
  el.textContent = ex.weightMode === 'bodyweight' ? '自重' : weightLabel(ex, sessionWeight);
}

function renderSession() {
  const day = sGetDay(strengthDate);
  const list = sessionExercises(day);
  const pos = currentPos(list);

  const body = document.getElementById('session-body');

  // 完整的一天从选计划开始：选 A/B → 确认页 → 开始。
  // 这两个画面不显示底部栏（Figma 评论）；项目库为空时例外，不然进不了设置。
  const rawDay = state.strength.days[strengthDate];
  const tabBar = document.querySelector('.tab-bar');
  const confirmed = rawDay && rawDay.confirmed;
  if (tabBar) tabBar.style.display = !confirmed && state.strength.catalog.length ? 'none' : '';
  if (!confirmed) {
    if (pendingSplit) renderPlanConfirm(body);
    else renderPlanChooser(body);
    return;
  }

  if (!list.length) {
    document.getElementById('session-progress').innerHTML = '';
    body.innerHTML = `
      <div class="empty-hint"><p>${splitLabel(day.split)}里还没有项目。</p></div>
      <button class="edit-plan-btn primary" id="btn-edit-plan">去设置训练项目</button>`;
    return;
  }

  // 全部练完
  if (!pos) {
    renderProgressBar(list, -1);
    const totals = dayTotals(day);
    body.innerHTML = `
      <div class="session-done">
        <div class="done-check">✓</div>
        <div class="done-title">${splitLabel(day.split)}练完了</div>
        <div class="done-sub">${totals.sets} 组 · ${fmt(totals.volume)} kg·次</div>
        <button class="pill" id="session-edit-btn">查看 / 修改记录</button>
      </div>`;
    return;
  }

  const item = list[pos.exIdx];
  const ex = item.ex;
  const color = EXERCISE_COLORS[pos.exIdx % EXERCISE_COLORS.length];
  renderProgressBar(list, pos.exIdx);

  // 有氧：一个大计时盘，不是滚轮
  if (isCardio(ex)) {
    const mins = ex.durationMin ?? 20;
    body.innerHTML = `
      <div class="wheel-zone">
        <div class="cardio-panel">
          <div class="cardio-clock" id="cardio-clock">${mins}:00</div>
          ${cardioEndAt
            ? '<button class="pill wide" id="cardio-stop">提前结束并记录</button>'
            : `<button class="pill wide primary" id="cardio-start">开始 ${mins} 分钟</button>`}
        </div>
      </div>
      <div class="info-zone">
        <div class="session-exercise-name">${esc(ex.name)}</div>
        <div class="prev-row"><span class="prev-empty">计划 ${mins} 分钟有氧</span></div>
        <button class="finish-btn" id="btn-finish-day">提前结束</button>
      </div>`;
    return;
  }

  sessionWeight = defaultSessionWeight(ex, item.rec);
  const reps = defaultRepsFor(ex, pos.setIdx, item.rec);
  const warm = isWarmupIdx(ex, pos.setIdx);
  const restSec = restSecondsAfter(list, pos.exIdx, pos.setIdx);

  // 上次记录：只写日期 + 每组次数的圆点，不加「上次」标注（看日期就懂）
  const prev = lastSession(ex.id, strengthDate);
  let prevRow = '<div class="prev-row"><span class="prev-empty">第一次记录</span></div>';
  if (prev) {
    const [py, pm, pd] = prev.date.split('-');
    const pdots = prev.sets
      .map((s) => `<span class="pdot" style="background:${color}">${fmt(s.reps)}</span>`)
      .join('');
    prevRow = `
      <div class="prev-row">
        <span class="prev-date">${py}/${Number(pm)}/${Number(pd)}</span>
        <span class="prev-dots">${pdots}</span>
      </div>`;
  }

  // 头部（Figma 21:171）：大写计划字母 + 右侧日期/时间叠放
  document.getElementById('session-head').innerHTML = `
    <span class="head-letter">${day.split}</span>
    <div class="head-dt">
      <span id="s-date-label">${nowDateStr()}</span>
      <b id="s-time-label"></b>
    </div>`;
  updateDateClock();

  // 布局按 Figma Ver.1.0.6：滚轮区块内 60s/暂停横排锚右下、圆点钉底；
  // 下半区：动作名(左)+动作要点(右) / 上次日期+圆点 / 重量行右对齐
  body.innerHTML = `
    <div class="wheel-zone" id="wheel-zone">
      <div class="session-main">
        <div class="reps-wheel" id="reps-wheel"></div>
      </div>
      <div class="rest-buttons">
        <button class="round-btn primary" id="btn-confirm" style="background:${color}">${restSec > 0 ? restSec + 's' : '完成'}</button>
        <button class="round-btn pause" id="btn-adjust-rest" aria-label="调整休息"><span class="pause-glyph"></span></button>
      </div>
      <!-- 倒计时嵌在这个区块里，顺时针；颜色跟当前动作统一 -->
      <div class="rest-inline">
        <div class="rest-ring-wrap" id="rest-ring">
          <svg viewBox="0 0 200 200">
            <circle class="ring-bg" cx="100" cy="100" r="90"></circle>
            <circle class="ring-fg" id="rest-ring-fg" cx="100" cy="100" r="90" style="stroke:${color}"></circle>
          </svg>
          <div class="rest-value" id="rest-value">0</div>
        </div>
        <p class="rest-hint">点圆环可以提前结束休息</p>
        <button id="rest-add-30" aria-label="再加 30 秒">+30<span>秒</span></button>
        <button class="rest-finish" id="btn-finish-day">提前结束训练</button>
      </div>
      <div class="set-dots">${renderDots(item, pos.setIdx, color)}</div>
    </div>

    <div class="info-zone">
      <div class="name-block">
        <span class="session-exercise-name">${esc(ex.name)}${warm ? '<span class="warm-badge">热身</span>' : ''}</span>
        <button class="cue-btn" id="btn-cues">动作要点 <span class="cue-arrow">▶</span></button>
      </div>
      ${prevRow}
      <div class="weight-row">
        <button class="round-btn small" id="btn-weight-down">−</button>
        <div class="weight-value" id="session-weight"></div>
        <button class="round-btn small" id="btn-weight-up">+</button>
      </div>
    </div>`;

  buildWheel();
  scrollWheelTo(reps, true);
  renderSessionWeight();

  // 休息属于「正在进行的这一组」：任何原因触发的重绘（切 tab、缩放）
  // 都必须把休息状态原样接回来，不能把人踢回上一组的画面
  if (restEndAt) {
    const zone = document.getElementById('wheel-zone');
    zone.classList.add('resting');
    zone.classList.toggle('adjust', !restConfirms);
    tickRest();
  }

  if (ex.weightMode === 'bodyweight') {
    document.getElementById('btn-weight-down').disabled = true;
    document.getElementById('btn-weight-up').disabled = true;
  }
}

// 训练页必须一屏装下，不能出滚动条 —— 训练中手上有汗还在喘，
// 需要滚动才能够到按钮是很糟的设计。
// 高度不能靠猜（顶部导航、日期条、tab bar 会随字号和机型变），所以实测：
// 量出 #strength-session 距可视区顶部多远，再减掉底部 tab bar，剩下的就是它能用的高度。
// 一路累加 offsetTop 求出 el 相对 container 的布局位置。
// 不能用 getBoundingClientRect()——它返回缩放后的屏幕坐标，
// 而 clientHeight / offsetHeight 是未缩放的布局尺寸。测试页把手机缩到 72%，
// 两种坐标混用会让算出的高度偏大，内容溢出屏幕、底部按钮被 overflow:hidden 切掉。
function offsetTopWithin(el, container) {
  let y = 0;
  let node = el;
  while (node && node !== container) {
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return y;
}

function fitSessionHeight() {
  const el = document.getElementById('strength-session');
  if (!el || el.style.display === 'none') return;

  // 测试页里 app 装在手机外框（#phone-screen）里；真机上就是整个视口
  const frame = document.getElementById('phone-screen');
  const viewportH = frame ? frame.clientHeight : window.innerHeight;

  // 全程用未缩放的布局像素，量纲一致
  const top = offsetTopWithin(el, frame);
  const tabBar = document.querySelector('.tab-bar');
  const tabH = tabBar ? tabBar.offsetHeight : 0;

  el.style.height = `${Math.max(300, viewportH - top - tabH - 14)}px`;
}

window.addEventListener('resize', fitSessionHeight);
window.addEventListener('orientationchange', () => setTimeout(fitSessionHeight, 120));

// ---- 事件 ----
function initSession() {
  const body = document.getElementById('session-body');

  body.addEventListener('click', (e) => {
    if (e.target.closest('#rest-add-30')) {
      restEndAt += 30000;
      restTotal += 30;
      tickRest();
      return;
    }
    if (e.target.closest('#rest-ring')) {
      skipRest();
      return;
    }
    const planBtn = e.target.closest('.plan-row');
    if (planBtn) {
      openPlanConfirm(planBtn.dataset.split);
      return;
    }
    if (e.target.closest('#plan-start')) {
      confirmPlan();
      return;
    }
    if (e.target.closest('#plan-rethink')) {
      pendingSplit = null;
      renderStrength();
      return;
    }
    if (e.target.closest('#btn-cues')) {
      showToast('动作要点：下个版本做');
      return;
    }
    if (e.target.closest('#btn-confirm')) {
      primeAudio();
      confirmSet();
    } else if (e.target.closest('#btn-adjust-rest')) {
      adjustmentRest();
    } else if (e.target.closest('#btn-weight-down')) {
      adjustWeight(-1);
    } else if (e.target.closest('#btn-weight-up')) {
      adjustWeight(1);
    } else if (e.target.closest('#cardio-start')) {
      startCardio();
    } else if (e.target.closest('#cardio-stop')) {
      finishCardio(false);
    } else if (e.target.closest('#session-edit-btn')) {
      window.showStrengthForm(true);
    } else if (e.target.closest('#btn-finish-day')) {
      finishDay();
    } else if (e.target.closest('#btn-edit-plan')) {
      window.openCatalogPage();
    }
  });

  const finYes = document.getElementById('finish-confirm-yes');
  const finNo = document.getElementById('finish-confirm-no');
  if (finYes) finYes.addEventListener('click', reallyFinishDay);
  if (finNo) finNo.addEventListener('click', () => {
    document.getElementById('finish-confirm').style.display = 'none';
  });

}

window.initSession = initSession;
window.renderSession = renderSession;
window.fitSessionHeight = fitSessionHeight;
window.openPlanConfirm = openPlanConfirm;
