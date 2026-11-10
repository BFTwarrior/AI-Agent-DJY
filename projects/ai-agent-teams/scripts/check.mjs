import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { validateConfig } from '../src/config.mjs';

const required = [
  'SPEC.md', 'README.md', 'docs/guides/INSTALL.md', 'docs/guides/INSTALL-WITH-AI.md', 'docs/guides/START-HERE.md',
  'AGENTS.md', 'docs/guides/CONSTRAINTS.md', 'docs/guides/LOCALIZATION.md', 'docs/status/STATUS.md', 'docs/status/HANDOFF.md',
  'marketplace.json', 'eslint.config.mjs',
  'llms.txt', 'CHANGELOG.md', 'docs/guides/CONTRIBUTING.md', 'LICENSE', 'package.json',
  'config/schema.json', 'config/example.two-teams.json', 'config/example.minimal.json', 'config/example.v06.json',
  'config/roster.two-teams.json', 'config/README.md', 'examples/tasks.sample.json',
  'docs/decisions.md', 'docs/contracts.md', 'docs/roadmap.md', 'docs/verification.md',
  'docs/known-limits.md', 'docs/glossary.md', 'docs/test-matrix.md', 'docs/review-2026-10-26.md',
  'prompts/handoff.md', 'prompts/captain.md', 'prompts/team-lead.md', 'prompts/member.md',
  'prompts/reviewer.md', 'prompts/delivery-auditor.md', 'prompts/shadow.md',
  'src/config.mjs', 'src/i18n.mjs', 'src/domain/types.mjs', 'src/domain/scheduler.mjs', 'src/domain/task-graph-validation.mjs', 'src/domain/task-graph-policy.mjs', 'src/domain/gates.mjs',
  'src/domain/gates/policy.mjs', 'src/domain/gates/findings.mjs', 'src/domain/gates/identity.mjs',
  'src/domain/gates/members.mjs', 'src/domain/gates/completion.mjs', 'src/domain/gates/completion-review.mjs',
  'src/domain/gates/completion-fanout.mjs', 'src/domain/gates/review-repair.mjs',
  'src/domain/gates/follow-up.mjs', 'src/domain/gates/delivery-audit.mjs',
  'src/domain/artifacts.mjs', 'src/domain/attempts.mjs', 'src/domain/lifecycle.mjs', 'src/domain/changes.mjs', 'src/domain/repair-scope.mjs', 'src/domain/team-tools.mjs', 'src/domain/provider-errors.mjs', 'src/domain/workspace.mjs', 'src/domain/prompt-rules.mjs', 'src/plugin-metadata.mjs', 'src/cli.mjs', 'src/panel.mjs', 'src/discovery.mjs',
  'src/service/capacity-state.mjs', 'src/service/contractor-slots.mjs', 'src/service/control-sessions.mjs', 'src/service/closed-loop.mjs', 'src/service/restart-recovery.mjs', 'src/service/task-transitions.mjs', 'src/service/merge-workflow.mjs', 'src/service/tick-workflow.mjs', 'src/service/merge-repair.mjs', 'src/service/merge-review-result.mjs', 'src/service/prompts.mjs', 'src/service/roles.mjs', 'src/service/session-occupancy.mjs',
  'src/service/patrol-lifecycle.mjs', 'src/service/patrol-run.mjs',
  'src/service/task-completion-validation.mjs', 'src/service/task-completion-evidence.mjs',
  'src/service/task-completion-phases.mjs', 'src/service/task-completion-closeout.mjs',
  'src/service/task-completion-follow-up.mjs',
  'src/domain/delivery-review.mjs', 'src/domain/publication-intent.mjs', 'src/domain/rate-limit.mjs',
  'src/host-model.mjs', 'src/native-agent-model.mjs', 'src/team-policy.mjs', 'src/service/contractor-cleanup.mjs',
  'agents/team-worker.md', 'test/native-agent-model.test.mjs', 'test/native-model-policy.test.mjs',
  'src/service/native-model-dispatch.mjs', 'test/native-model-dispatch.test.mjs', 'test/native-model-send-paths.test.mjs',
  'src/service/delivery-intents.mjs', 'src/service/phase0-epochs.mjs', 'src/service/phase0-normalize.mjs',
  'src/session/process-tree.mjs', 'src/session/retry-after.mjs',
  'src/service/red-review.mjs', 'src/service/task-dispatch.mjs', 'src/service/task-dispatch-session.mjs', 'src/service/turn-recovery.mjs',
  'src/hot-update.mjs', 'src/hot-update/build.mjs', 'src/hot-update/health.mjs',
  'src/hot-update/install-copy.mjs', 'src/hot-update/lock.mjs', 'src/hot-update/manifest.mjs',
  'src/hot-update/operations.mjs', 'src/hot-update/package-files.mjs', 'src/hot-update/pointer.mjs',
  'src/hot-update/publish.mjs', 'src/hot-update/support.mjs', 'src/hot-update/versions.mjs',
  'src/service/delivery-receipts.mjs', 'src/service/publication-recovery.mjs', 'src/service/pending-adoption.mjs', 'src/service/model-policy.mjs', 'src/service/contractors.mjs',
  'src/fs-permissions.mjs', 'src/store.mjs', 'src/scheduler-service.mjs', 'src/daemon.mjs', 'src/git/worktree-reclaim.mjs',
  'assets/team-view.html', 'assets/team-view.css', 'assets/team-view.light.css', 'assets/team-view.dark.css',
  'src/session/adapter.mjs', 'src/session/cli.mjs', 'src/session/worker-home.mjs', 'src/session/container-cli.mjs', 'src/session/provider-config.mjs',
  'src/http/server.mjs', 'src/http/auth.mjs', 'src/http/network.mjs', 'src/http/response.mjs',
  'src/http/sse-write.mjs', 'src/http/sse.mjs', 'src/http/ui-routes.mjs', 'src/http/ui-snapshot.mjs', 'src/http/ui-console.mjs',
  'src/gates/verify.mjs', 'src/git/worktree.mjs', 'src/git/merge-queue.mjs', 'src/git/worktree-fence.mjs',
  'src/git-bootstrap.mjs',
  'src/git-bootstrap/contract.mjs', 'src/git-bootstrap/errors.mjs', 'src/git-bootstrap/fs-primitives.mjs',
  'src/git-bootstrap/inspect.mjs', 'src/git-bootstrap/patterns.mjs', 'src/git-bootstrap/secret-scan.mjs',
  'src/git-bootstrap/atomic-write.mjs', 'src/git-bootstrap/gitignore.mjs', 'src/git-bootstrap/plan.mjs',
  'src/git-bootstrap/git-command.mjs', 'src/git-bootstrap/repository.mjs', 'src/git-bootstrap/lock.mjs',
  'src/git-bootstrap/marker.mjs', 'src/git-bootstrap/rollback.mjs', 'src/git-bootstrap/bootstrap.mjs',
  'src/domain/container-image-policy.mjs', 'src/runtime/container.mjs', 'src/runtime/container-image.mjs', 'src/runtime/container-image-errors.mjs', 'src/runtime/container-startup.mjs', 'src/runtime/loopback-bridge.mjs', 'deploy/worker.Dockerfile', 'deploy/README.md',
  'src/mcp-server.mjs', 'src/mcp/handler.mjs', 'src/mcp/api-client.mjs', 'src/mcp/tool-access.mjs', 'src/mcp/tool-definitions.mjs', 'src/mcp/tool-handlers.mjs', 'src/mcp/workspace-selection.mjs', 'src/mcp/shell.mjs', 'src/mcp/shell/protocol.mjs', 'src/mcp/shell/runtime-supervisor.mjs', 'src/mcp/shell/runtime-target.mjs', 'src/mcp/shell/pointer-watcher.mjs', 'src/mcp/shell/support.mjs', 'src/mcp/runtime-entry.mjs', 'src/workspace-target.mjs', 'src/team-cli.mjs', 'open-panel.cmd',
  'src/bootstrap.mjs', 'src/session/protocol.mjs', 'src/installer.mjs', 'src/install-wizard.mjs',
  '.zcode-plugin/plugin.json', 'skills/agent-teams/SKILL.md', 'skills/install-agent-teams/SKILL.md', 'commands/agent-teams.md',
  'commands/team-view.md', 'commands/install-teams.md', 'assets/team-panel.html',
  'assets/team-view-theme-boot.js', 'assets/team-view-live.js', 'assets/team-view-app.js',
  'assets/team-view-patrol.js', 'assets/team-view-stream.js', 'assets/team-view-theme.js',
  'ui-src/team-panel.js', 'ui-src/team-panel.css', 'ui-src/panel-host.js', 'ui-src/panel-labels.js',
  'scripts/build-ui.mjs', 'scripts/i18n-coverage.mjs', 'scripts/i18n-allow.mjs',
  'test/ui-i18n.test.mjs', 'test/ui-panel-boot.test.mjs', 'test/i18n-allow.test.mjs', 'test/scheduler-service-boundaries.test.mjs', 'test/turn-recovery-boundaries.test.mjs',
  'test/config.test.mjs', 'test/i18n.test.mjs', 'test/scheduler.test.mjs', 'test/task-graph-module-boundaries.test.mjs', 'test/session-occupancy.test.mjs', 'test/control-sessions-boundaries.test.mjs', 'test/gates.test.mjs', 'test/repair-scope.test.mjs', 'test/artifacts.test.mjs',
  'test/attempts.test.mjs', 'test/store.test.mjs', 'test/service.test.mjs', 'test/http.test.mjs', 'test/gates-module-boundaries.test.mjs',
  'test/cli.test.mjs', 'test/verify.test.mjs', 'test/worktree.test.mjs', 'test/worktree-reclaim.test.mjs', 'test/mcp.test.mjs', 'test/mcp-shell.test.mjs', 'test/mcp-shell-boundaries.test.mjs', 'test/protocol.test.mjs', 'test/panel.test.mjs', 'test/discovery.test.mjs',
  'test/process-v15.test.mjs', 'test/service-v06.test.mjs', 'test/dispatch-recovery.test.mjs',
  'test/merge-queue.test.mjs', 'test/merge-review-boundaries.test.mjs', 'test/container.test.mjs', 'test/worker-image.test.mjs', 'test/worker-home.test.mjs', 'test/loopback-bridge.test.mjs', 'test/provider-config.test.mjs',
  'test/lifecycle.test.mjs', 'test/api-v06.test.mjs', 'test/changes.test.mjs', 'test/installer.test.mjs', 'test/task-completion-boundaries.test.mjs',
  'test/install-wizard.test.mjs', 'test/rate-limit.test.mjs', 'test/retry-after.test.mjs', 'test/manifest.test.mjs',
  'test/prompt-language.test.mjs',
  'scripts/load-test.mjs',
  'scripts/real-load.mjs',
  'scripts/daemon-supervisor.mjs',
  'scripts/supervisor-log.mjs',
  'scripts/register-daemon-task.ps1',
  'scripts/package.mjs',
  'hooks/hooks.json',
  'scripts/session-start.mjs',
  'test/hook.test.mjs', 'test/workspace-target.test.mjs', 'test/shadow-agent.test.mjs', 'test/patrol.test.mjs', 'test/team-lead.test.mjs',
  'test/ui-task-tree-layout.test.mjs',
  'test/bootstrap-version.test.mjs',
  'test/auto-retry.test.mjs', 'test/bootstrap.test.mjs', 'test/closed-loop.test.mjs', 'test/contractor-cleanup.test.mjs',
  'test/contractor.test.mjs', 'test/delivery-intents.test.mjs', 'test/delivery-review.test.mjs', 'test/git-bootstrap.test.mjs',
  'test/home-safety.test.mjs', 'test/hot-update.test.mjs', 'test/model-follow.test.mjs', 'test/phase0-epochs.test.mjs',
  'test/phase0-normalize.test.mjs', 'test/port.test.mjs', 'test/process-error.test.mjs', 'test/publication-intent.test.mjs',
  'test/red-auto-review.test.mjs', 'test/team-policy.test.mjs', 'test/team-tools.test.mjs', 'test/ui-console-live.test.mjs',
  'test/ui-console.test.mjs', 'test/ui-refresh.test.mjs', 'test/pending-adoption-boundaries.test.mjs', 'test/worktree-fence.test.mjs', 'test/support/child-daemon.mjs',
  'test/support/listen.mjs',
  'test/support/cleanup.mjs', 'test/support/tmp-root.mjs', 'test/tmp-root.test.mjs',
];

const failures = [];
for (const file of required) {
  if (!existsSync(file)) failures.push(`missing file: ${file}`);
}

// Keep source modules and tests explicitly registered so an extraction cannot
// silently disappear from the structural gate.
const requiredSet = new Set(required);
function checkSourceRegistration(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) checkSourceRegistration(relPath);
    else if (entry.isFile() && entry.name.endsWith('.mjs') && !requiredSet.has(relPath)) {
      failures.push(`unregistered source file: ${relPath}`);
    }
  }
}
checkSourceRegistration('src');
for (const entry of readdirSync('test', { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.test.mjs')) continue;
  const relPath = `test/${entry.name}`;
  if (!requiredSet.has(relPath)) failures.push(`unregistered test file: ${relPath}`);
}
for (const entry of readdirSync('test/support', { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
  const relPath = `test/support/${entry.name}`;
  if (!requiredSet.has(relPath)) failures.push(`unregistered test helper: ${relPath}`);
}

// The package script copies every root entry. Catch stray shell-created
// files (typically 0-byte names from an unquoted heredoc) before they ship.
const runtimeEntries = new Set([
  'dist', 'node_modules', '.git', '.tmp', '.ai-agent-teams', '.zcode-agent-teams',
  '.agent-teams', '.agent-teams-worktrees', '.agent-teams-homes',
  '文档', '逻辑图', '历史', '归档', '参考',
]);
for (const entry of readdirSync('.')) {
  if (runtimeEntries.has(entry)) continue;
  const info = statSync(entry);
  if (info.isFile() && info.size === 0) failures.push(`empty root file: ${entry}`);
  if (!/^[\x20-\x7E]+$/.test(entry)) failures.push(`non-ASCII root entry: ${entry}`);
}

const migration = readFileSync('docs/guides/MIGRATION.md', 'utf8');

// Keep the root scannable: prose lives under docs/ (guides/status) and only
// the files a tool or a newcomer expects at the repository root stay there.
// A deliberate new root .md/.json must be added to these allowlists.
const rootMarkdown = new Set(['readme.md', 'agents.md', 'spec.md', 'changelog.md']);
const rootJson = new Set(['package.json', 'package-lock.json', 'marketplace.json']);
for (const entry of readdirSync('.', { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const name = entry.name.toLowerCase();
  if (name.endsWith('.md') && !rootMarkdown.has(name)) {
    failures.push(`markdown outside docs/: ${entry.name} (add it to the allowlist in scripts/check.mjs if intentional)`);
  }
  if (name.endsWith('.json') && !rootJson.has(name)) {
    failures.push(`unexpected root json: ${entry.name} (add it to the allowlist in scripts/check.mjs if intentional)`);
  }
}

if (migration.includes('C:' + String.fromCharCode(92) + 'Users')) failures.push('docs/guides/MIGRATION.md contains an absolute Windows user path');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = readFileSync('VERSION', 'utf8').trim();
if (pkg.version !== version) failures.push('package.json and VERSION disagree');
const panelSource = readFileSync('ui-src/team-panel.js', 'utf8');
if (!panelSource.includes("version: '__PACKAGE_VERSION__'")) failures.push('panel version must use the package version placeholder');
const panelBuild = readFileSync('scripts/build-ui.mjs', 'utf8');
if (!panelBuild.includes("replaceAll('__PACKAGE_VERSION__', version)")) failures.push('panel build does not inject the package version');
const panelHtml = readFileSync('assets/team-panel.html', 'utf8');
if (!panelHtml.includes(`version:"${version}"`)) failures.push('built team panel version does not match package.json');
for (const path of ['文档/__git-trackability-check__.md', '逻辑图/__git-trackability-check__.md']) {
  try {
    const ignored = execFileSync('git', ['check-ignore', '--no-index', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (ignored) failures.push(`${path} is ignored by Git`);
  } catch (error) {
    if (error.status !== 1) failures.push(`could not verify Git tracking for ${path}: ${error.message}`);
  }
}

const spec = readFileSync('SPEC.md', 'utf8');
const sections = spec.match(/^## \d+\./gm) ?? [];
if (sections.length < 19) failures.push(`SPEC.md should have 19 numbered sections, found ${sections.length}`);
for (const term of ['INV-001', 'INV-050', 'R-01', 'R-12', 'T-56']) {
  if (!spec.includes(term)) failures.push(`SPEC.md missing ${term}`);
}

const agents = readFileSync('AGENTS.md', 'utf8');
for (const term of ['INV-001', 'INV-050', 'docs/status/HANDOFF.md', '1 captain, 2 teams']) {
  if (!agents.includes(term)) failures.push(`AGENTS.md missing ${term}`);
}

const llms = readFileSync('llms.txt', 'utf8');
for (const term of ['SPEC.md', 'AGENTS.md', 'docs/status/HANDOFF.md', 'config/schema.json']) {
  if (!llms.includes(term)) failures.push(`llms.txt missing ${term}`);
}

for (const path of ['config/example.two-teams.json', 'config/example.minimal.json', 'config/example.v06.json']) {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    const result = validateConfig(config);
    if (!result.ok) failures.push(`${path}: ${result.errors.join('; ')}`);
    for (const warning of result.warnings) console.warn(`WARN ${path}: ${warning}`);
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

JSON.parse(readFileSync('config/schema.json', 'utf8'));
const plugin = JSON.parse(readFileSync('.zcode-plugin/plugin.json', 'utf8'));
for (const entry of readdirSync('.')) {
  if (entry.endsWith('.db') || entry === '.zcode-agent-teams') failures.push(`state artifact in package root: ${entry}`);
}
if (plugin.name !== 'ai-agent-teams') failures.push('plugin manifest name mismatch');
if (plugin.version !== version) failures.push('plugin.json and VERSION disagree');
if (!plugin.mcpServers?.['agent-teams']) failures.push('plugin manifest has no agent-teams MCP server');
const marketplace = JSON.parse(readFileSync('marketplace.json', 'utf8'));
const marketplacePlugin = marketplace.plugins?.find((entry) => entry.name === 'ai-agent-teams');
if (!marketplacePlugin) failures.push('marketplace.json has no ai-agent-teams entry');
if (marketplacePlugin?.version !== version) failures.push('marketplace.json version does not match VERSION');
const mcpSource = readFileSync('src/mcp/handler.mjs', 'utf8');
if (!mcpSource.includes('version: PACKAGE_VERSION')) failures.push('MCP serverInfo version is not read from package.json');
const mcpToolsSource = readFileSync('src/mcp/tool-definitions.mjs', 'utf8');
if (!mcpToolsSource.includes('ui://ai-agent-teams/panel.html')) failures.push('MCP tool definitions have no team-panel UI resource');
const httpSource = readFileSync('src/http/server.mjs', 'utf8');
if (!httpSource.includes('version = PACKAGE_VERSION')) failures.push('HTTP createApp default version is not read from package.json');
const roster = JSON.parse(readFileSync('config/roster.two-teams.json', 'utf8'));
const rosterNames = new Set();
for (const [teamId, list] of Object.entries(roster.teams ?? {})) {
  if (!Array.isArray(list) || list.length !== 16) failures.push(`${teamId} roster must have 16 members`);
  for (const member of list) {
    if (typeof member.name !== 'string' || !member.name) failures.push(`${teamId} roster member without a name`);
    if (rosterNames.has(member.name)) failures.push(`duplicate roster member: ${member.name}`);
    rosterNames.add(member.name);
  }
}

const example = JSON.parse(readFileSync('config/example.two-teams.json', 'utf8'));
for (const team of example.teams) {
  if (!(roster.teams?.[team.id] ?? []).some((member) => member.name === team.lead)) {
    failures.push(`${team.id} lead ${team.lead} is missing from the roster`);
  }
}
if (example.teams.length !== 2) failures.push('canonical example must have 2 teams');
for (const team of example.teams) {
  if (team.defaultMembers !== 16) failures.push(`${team.id}: defaultMembers must be 16`);
  if (team.maxMembers !== 32) failures.push(`${team.id}: maxMembers must be 32`);
}
if (example.scheduler.activeWorkerSlots !== 6) failures.push('activeWorkerSlots must be 6');
if (example.scheduler.maxActivePerTeam !== 3) failures.push('maxActivePerTeam must be 3');

const tasks = JSON.parse(readFileSync('examples/tasks.sample.json', 'utf8')).tasks;
if (!Array.isArray(tasks) || tasks.length === 0) failures.push('example tasks must be a non-empty array');
for (const task of tasks) {
  if (task.assignee && !rosterNames.has(task.assignee)) failures.push(`sample task ${task.id} has unknown assignee ${task.assignee}`);
}

const matrix = readFileSync('docs/test-matrix.md', 'utf8');
// T-51 was removed; keep the remaining acceptance ids stable.
const matrixIds = Array.from({ length: 56 }, (_, index) => `T-${String(index + 1).padStart(2, '0')}`)
  .filter((id) => id !== 'T-51');
for (const id of matrixIds) {
  if (!matrix.includes(id)) failures.push(`test matrix missing ${id}`);
}

if (failures.length > 0) {
  console.error('CHECK FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`CHECK OK (${required.length} files, ${sections.length} SPEC sections, ${tasks.length} example tasks)`);
