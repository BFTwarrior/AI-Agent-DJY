/**
 * Label mapping for the MCP Apps panel (`ui-src/team-panel.js`).
 *
 * The daemon stores English enums; these helpers turn them into source
 * stable source labels and pass each fixed label through the injected translator.
 * Kept in their own module so the mapping (including the retired
 * `budget_paused` control) is unit-testable without a DOM or a host.
 */

/**
 * @param {unknown} phase team phase from the snapshot
 * @param {unknown} control team control value from the snapshot
 * @param {(source: string, values?: any) => string} t translator
 * @returns {string} localized phase label
 */
export function phaseLabel(phase, control, t) {
  const key = String(phase ?? '').toLowerCase();
  const phases = {
    draft: '草稿', staged: '待批准', running: '运行中', completed: '已完成', archived: '已归档',
  };
  if (key === 'running' && control && control !== 'active') {
    // `budget_paused` is a retired control value that can still sit in a
    // snapshot written by an older daemon; label it instead of letting it fall
    // through to "running", which would misreport a paused team.
    const controlLabel = { halted: '已停止', escalated: '升级处理', budget_paused: '预算暂停' }[String(control).toLowerCase()];
    return controlLabel ? t(controlLabel) : t('运行中');
  }
  return phases[key] ? t(phases[key]) : (key ? t(key) : t('运行中'));
}

/**
 * @param {unknown} status task status from the snapshot
 * @param {(source: string, values?: any) => string} t translator
 * @returns {string} localized task status label
 */
export function taskStatusLabel(status, t) {
  const key = String(status ?? '').toLowerCase();
  const labels = {
    pending: '等待', claimed: '已领取', in_progress: '进行中',
    completed: '已完成', failed: '失败', cancelled: '已取消', done: '已完成', merged: '已合并',
  };
  return labels[key] ? t(labels[key]) : (key ? t(key) : t('等待'));
}

/**
 * @param {unknown} name team name from the snapshot
 * @param {unknown} id team id from the snapshot
 * @param {(source: string, values?: any) => string} t translator
 * @returns {string} localized team label
 */
export function teamLabel(name, id, t) {
  const key = String(id ?? '').toLowerCase();
  const text = String(name ?? '');
  if (key === 'alpha' || text.toLowerCase().startsWith('alpha')) return t('A队');
  if (key === 'beta' || text.toLowerCase().startsWith('beta')) return t('B队');
  return text || key;
}
