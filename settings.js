// ---- 设置页 ----
function initSettings() {
  document.getElementById('export-btn').addEventListener('click', exportData);
  document.getElementById('import-input').addEventListener('change', importData);
  document.getElementById('clear-btn').addEventListener('click', clearData);
  document.getElementById('reset-api-btn').addEventListener('click', () => {
    localStorage.removeItem('api_url');
    localStorage.removeItem('api_token');
    location.reload();
  });
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
