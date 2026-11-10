import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import { isStandalone } from './panel-host.js';
import * as labels from './panel-labels.js';

const app = new App(
  { name: 'ai-agent-teams', version: '__PACKAGE_VERSION__' },
  { tools: {} },
  { autoResize: true, strict: false },
);

const root = document.getElementById('content');
const status = document.getElementById('status');
const updated = document.getElementById('updated');
const refreshButton = document.getElementById('refresh');
const openTasksButton = document.getElementById('openTasks');
const fullButton = document.getElementById('full');
let currentViewUrl = '';
let refreshing = false;

const i18n = typeof window !== 'undefined' ? window.AGT_I18N : null;
const t = (source, values) => {
  if (i18n) return i18n.t(source, values);
  if (values == null) return String(source);
  const list = Array.isArray(values) ? values : [values];
  return String(source).replace(/\{(\d+)\}/g, (token, index) => (Number(index) < list.length ? String(list[Number(index)]) : token));
};
const localize = (scope) => {
  try { i18n?.localize(scope); } catch { /* localization is best-effort */ }
};
const clock = (date) => {
  if (i18n) return i18n.formatTime(date, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
localize(document);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusClass(value) {
  const text = String(value ?? '').toLowerCase();
  if (['completed', 'done', 'merged'].includes(text)) return 'ok';
  if (['failed', 'cancelled', 'blocked'].includes(text)) return 'bad';
  if (['in_progress', 'active', 'claimed', 'running'].includes(text)) return 'run';
  return 'wait';
}

// The daemon stores English enums; map them to localized labels. The mapping
// (including the retired `budget_paused` control) lives in panel-labels.js so
// it is unit-testable without a DOM.
const teamLabel = (name, id) => labels.teamLabel(name, id, t);
const phaseLabel = (phase, control) => labels.phaseLabel(phase, control, t);
const taskStatusLabel = (status) => labels.taskStatusLabel(status, t);

function taskRow(task) {
  return `<li class="task"><span class="dot ${statusClass(task.status)}"></span><span class="task-name" data-i18n-skip title="${escapeHtml(task.subject)}">${escapeHtml(task.subject)}</span><span class="task-state">${escapeHtml(taskStatusLabel(task.status))}</span></li>`;
}

function teamCard(team) {
  const tasks = Array.isArray(team.tasks) ? team.tasks : [];
  const members = Array.isArray(team.members) ? team.members : [];
  const completed = tasks.filter((task) => ['completed', 'done', 'merged'].includes(String(task.status).toLowerCase())).length;
  const active = tasks.filter((task) => ['in_progress', 'active', 'claimed', 'running'].includes(String(task.status).toLowerCase())).length;
  const percent = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const visibleTasks = tasks
    .filter((task) => !['completed', 'cancelled'].includes(String(task.status).toLowerCase()))
    .slice(0, 4);
  if (visibleTasks.length === 0 && tasks.length > 0) visibleTasks.push(...tasks.slice(-2));
  return `
    <section class="team">
      <div class="team-head">
        <div><b>${escapeHtml(teamLabel(team.name, team.id))}</b><span class="phase">${escapeHtml(phaseLabel(team.phase, team.control))}</span></div>
        <span class="team-count">${t('{0} 成员 · {1} 进行中', [members.length, active])}</span>
      </div>
      <div class="progress"><span style="width:${percent}%"></span></div>
      <div class="meta"><span>${t('{0}/{1} 任务完成', [completed, tasks.length])}</span><span>${t('{0} 临时工', [team.contractors?.length ?? 0])}</span></div>
      <ul class="tasks">${visibleTasks.map(taskRow).join('') || `<li class="empty">${t('暂无任务')}</li>`}</ul>
    </section>`;
}

function render(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.teams)) {
    status.textContent = t('等待团队快照…');
    return;
  }
  currentViewUrl = snapshot.viewUrl || currentViewUrl;
  const teams = snapshot.teams;
  const tasks = teams.flatMap((team) => team.tasks ?? []);
  const members = teams.flatMap((team) => team.members ?? []);
  const completed = tasks.filter((task) => ['completed', 'done', 'merged'].includes(String(task.status).toLowerCase())).length;
  const active = members.filter((member) => ['working', 'busy'].includes(String(member.status ?? member.workState).toLowerCase())).length;
  status.innerHTML = `<span class="live-dot"></span>${t('实时 · {0} 支队伍 · {1} 成员 · {2} 工作中', [teams.length, members.length, active])}`;
  root.innerHTML = `
    <div class="summary">
      <div><strong>${completed}</strong><span>${t('任务完成')}</span></div>
      <div><strong>${tasks.length}</strong><span>${t('任务总数')}</span></div>
      <div><strong>${members.length}</strong><span>${t('成员')}</span></div>
    </div>
    ${teams.map(teamCard).join('')}`;
  updated.textContent = t('更新于 {0}', [clock(new Date())]);
  localize(root);
  localize(updated);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshButton.disabled = true;
  try {
    const result = await app.callServerTool({ name: 'agent_teams_view_snapshot', arguments: {} });
    if (result?.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? t('刷新失败'));
    const data = result?.structuredContent ?? JSON.parse(result?.content?.find((item) => item.type === 'text')?.text ?? '{}');
    render(data);
  } catch (error) {
    status.textContent = t('刷新失败：{0}', [error instanceof Error ? error.message : String(error)]);
    localize(status);
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
  }
}

function handleToolResult(params) {
  try {
    const data = params?.structuredContent ?? JSON.parse(params?.content?.find((item) => item.type === 'text')?.text ?? '{}');
    render(data);
  } catch (error) {
    status.textContent = t('数据解析失败：{0}', [error instanceof Error ? error.message : String(error)]);
    localize(status);
  }
}

app.ontoolresult = handleToolResult;
app.onhostcontextchanged = () => {
  if (document.documentElement.dataset.theme !== app.getHostContext()?.theme) {
    document.documentElement.dataset.theme = app.getHostContext()?.theme ?? 'dark';
  }
};
async function openView() {
  if (!currentViewUrl) return;
  try {
    const result = await app.openLink({ url: currentViewUrl });
    if (result?.isError) status.textContent = t('浏览器打开失败，请手动访问 {0}', [currentViewUrl]);
  } catch {
    status.textContent = t('请手动访问 {0}', [currentViewUrl]);
  }
}

refreshButton.addEventListener('click', refresh);
openTasksButton?.addEventListener('click', openView);
fullButton.addEventListener('click', openView);

(async () => {
  if (isStandalone(window)) {
    // Standalone preview: there is no MCP Apps host to answer callServerTool.
    // Keep the real host path untouched and explain how to open the panel.
    refreshButton.disabled = true;
    status.textContent = t('请在 ZCode 中打开此面板；独立浏览器无法连接宿主。');
    localize(status);
    return;
  }
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    document.documentElement.dataset.theme = app.getHostContext()?.theme ?? 'dark';
    // The tool result asks the host for fullscreen/side-pane placement. Do not
    // override it with pip; an inline card is only the fallback for old hosts.
    refresh();
    setInterval(refresh, 5000);
  } catch (error) {
    status.textContent = t('连接宿主失败：{0}', [error instanceof Error ? error.message : String(error)]);
    localize(status);
  }
})();
