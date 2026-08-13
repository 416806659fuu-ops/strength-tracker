// ---- 设置页 ----
function initSettings() {
  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-input').addEventListener('change', importData);
  document.getElementById('clear-btn').addEventListener('click', clearData);
  document.getElementById('reset-api-btn').addEventListener('click', () => {
    // 只删自己那份（键名定义在 app.js）。裸键归另外两个 app 用，不能碰
    localStorage.removeItem(API_URL_KEY);
    localStorage.removeItem(API_TOKEN_KEY);
    location.reload();
  });
  document.getElementById('restart-plan-btn').addEventListener('click', restartTodayPlan);
  document.getElementById('restart-wipe-btn').addEventListener('click', () => {
    document.getElementById('restart-confirm').style.display = 'flex';
  });
  document.getElementById('restart-confirm-no').addEventListener('click', () => {
    document.getElementById('restart-confirm').style.display = 'none';
  });
  document.getElementById('restart-confirm-yes').addEventListener('click', () => {
    document.getElementById('restart-confirm').style.display = 'none';
    restartTodayWipe();
  });
}

// 「重新选择今日计划」：软重置，今天已经记的组原样保留，只是重新弹一次
// A/B 选择——用于「今天练第二次」，选完新计划后 currentPos() 会自动跳过
// 已经练完的动作，接着练没做完的部分，不用另外搬数据。
function restartTodayPlan() {
  const day = sEnsureDay(todayKey());
  day.confirmed = false;
  pendingSplit = null;
  markDirty();
  showToast('已重新打开今日计划选择');
  if (window.renderStrength) window.renderStrength();
}

// 「清空今天的记录，重新开始」：硬重置，今天记的组全部清空——用于误记了
// 空记录/记错了想整个重来。顺手清掉可能还在走的休息倒计时状态，
// 跟「提前结束训练」的收尾方式一致（session.js 的 reallyFinishDay）。
function restartTodayWipe() {
  const day = sEnsureDay(todayKey());
  day.confirmed = false;
  day.exercises = [];
  pendingSplit = null;
  clearRestState();
  markDirty();
  showToast('今天的记录已清空');
  if (window.renderStrength) window.renderStrength();
}

// 整份 state 被换掉之后（导入/清空），把每个页面都重画一遍
function renderAllViews() {
  renderSettings();
  if (window.renderStrength) window.renderStrength();
}

function renderSettings() {
  // 目前设置页只有数据管理/后端连接两块，没有需要回填的字段
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `重训记录备份-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出备份文件');
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.settings || !parsed.strength) throw new Error('格式不对');
      if (!confirm('导入将覆盖服务器上当前所有数据，确定继续吗？')) return;
      state = mergeIntoDefaults(parsed);
      renderAllViews();
      await syncToServer();
      showToast('导入成功，已保存到服务器');
    } catch (err) {
      alert('文件格式不正确，导入失败');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function clearData() {
  if (!confirm('将清空服务器上保存的所有重训记录和动作库，且无法恢复，确定吗？')) return;
  state = defaultState();
  renderAllViews();
  await syncToServer();
  showToast('已清空全部数据');
}

window.initSettings = initSettings;
window.renderSettings = renderSettings;
