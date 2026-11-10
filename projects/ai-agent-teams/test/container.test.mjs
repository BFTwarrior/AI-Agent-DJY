import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContainerArgs, containerSelfTest, detectContainerHostAddress, detectContainerRuntime, ensureContainerRuntime, runtimeCandidates } from '../src/runtime/container.mjs';
import { prepareContainerImage } from '../src/runtime/container-image.mjs';
import { prepareContainerWorker } from '../src/runtime/container-startup.mjs';
import { ContainerCliSessionAdapter } from '../src/session/container-cli.mjs';


test('worker image preparation skips pulls by default', () => {
  const calls = [];
  const result = prepareContainerImage({
    image: 'worker:test',
    runner: (...args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.deepEqual(result, { ready: true, runtime: 'docker', image: 'worker:test', pulled: false, skipped: true });
  assert.equal(calls.length, 0);
});

test('worker image preparation pulls missing images under if-missing for Docker and Podman', () => {
  const cases = [
    {
      runtime: 'podman',
      command: 'podman-custom',
      error: 'Error: unable to inspect "registry.example/worker:stable": failed to find image registry.example/worker:stable: image not known',
    },
    { runtime: 'docker', error: 'Error response from daemon: No such image: registry.example/worker:stable' },
  ];
  for (const { runtime, command, error } of cases) {
    const calls = [];
    const result = prepareContainerImage({
      runtime,
      command,
      image: 'registry.example/worker:stable',
      pullPolicy: 'if-missing',
      runner: (_command, args) => {
        calls.push(args);
        return args[0] === 'image'
          ? { status: 1, stdout: '', stderr: error }
          : { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(calls, [['image', 'inspect', 'registry.example/worker:stable'], ['pull', 'registry.example/worker:stable']]);
    assert.equal(result.ready, true);
    assert.equal(result.pulled, true);
    if (command) assert.equal(result.command, command);
  }
});

test('container worker preparation rejects a non-Git workspace before runtime or image operations', () => {
  const calls = [];
  const result = prepareContainerWorker({
    cwd: 'D:/scratch/no-repo',
    runtime: 'docker',
    image: 'worker:test',
    pullPolicy: 'always',
    ensureRuntime: () => { calls.push('runtime'); return { available: true, runtime: 'docker', command: 'docker' }; },
    prepareImage: () => { calls.push('image'); return { ready: true, pulled: true }; },
    selfTest: () => { calls.push('self-test'); return { ready: true }; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.stage, 'workspace');
  assert.match(result.reason, /requires a git workspace/);
  assert.deepEqual(calls, []);
});

test('worker image preparation does not treat runtime or permission inspect errors as missing images', () => {
  for (const stderr of ['Cannot connect to the Podman socket', 'permission denied']) {
    const calls = [];
    const result = prepareContainerImage({
      image: 'registry.example/worker:stable',
      pullPolicy: 'if-missing',
      runner: (_command, args) => {
        calls.push(args);
        return { status: 125, stdout: '', stderr };
      },
    });
    assert.equal(result.ready, false);
    assert.match(result.reason, /image inspect failed/);
    assert.ok(result.reason.includes(stderr), `inspect error detail should include: ${stderr}`);
    assert.deepEqual(calls, [['image', 'inspect', 'registry.example/worker:stable']]);
  }
});

test('worker image preparation does not pull when inspect errors only mention missing-image phrases', () => {
  const messages = [
    'Error response from daemon: inspect failed; diagnostic context says No such image: registry.example/worker:stable was not the cause',
    'Error: inspect failed; unable to inspect "registry.example/worker:stable": failed to find image registry.example/worker:stable: image not known was not the cause',
    'Error: registry lookup failed; unable to find image registry.example/worker:stable was only quoted in a hint',
  ];
  for (const stderr of messages) {
    const calls = [];
    const result = prepareContainerImage({
      runtime: 'docker',
      image: 'registry.example/worker:stable',
      pullPolicy: 'if-missing',
      runner: (_command, args) => {
        calls.push(args);
        return { status: 1, stdout: '', stderr };
      },
    });
    assert.equal(result.ready, false, stderr);
    assert.match(result.reason, /image inspect failed/);
    assert.deepEqual(calls, [['image', 'inspect', 'registry.example/worker:stable']]);
  }
});

test('worker image preparation always pulls before self-test', () => {
  const calls = [];
  const result = prepareContainerImage({
    runtime: 'docker',
    image: 'registry.example/worker:stable',
    pullPolicy: 'always',
    runner: (_command, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.deepEqual(calls, [['pull', 'registry.example/worker:stable']]);
  assert.equal(result.pulled, true);
});

test('worker image preparation fails closed when a requested pull fails', () => {
  const result = prepareContainerImage({
    image: 'registry.example/worker:stable',
    pullPolicy: 'always',
    runner: () => ({ status: 1, stdout: '', stderr: 'registry unavailable' }),
  });
  assert.equal(result.ready, false);
  assert.match(result.reason, /failed to pull/);
});

test('worker image preparation rejects an unknown policy and missing image', () => {
  assert.equal(prepareContainerImage({}).ready, false);
  assert.equal(prepareContainerImage({ image: 'worker:test', pullPolicy: 'sometimes' }).ready, false);
});

test('container args are hardened and mount only worktree/home', () => {
  const args = buildContainerArgs({ image: 'worker:test', worktree: 'D:/w', home: 'D:/h', network: 'gateway-only' });
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('--security-opt'));
  assert.ok(args.includes('no-new-privileges'));
  assert.equal(args[args.indexOf('--entrypoint') + 1], '');
  assert.ok(args.includes('--user'));
  assert.match(args[args.indexOf('--user') + 1], /^\d+:\d+$/);
  assert.ok(args.includes('D:/w:/workspace'));
  assert.ok(args.includes('D:/h:/home/zcode'));
  assert.ok(!args.some((item) => item.includes('/opt/agent-teams')));
  assert.ok(args.includes('--network'));
  assert.equal(args[args.indexOf('--network') + 1], 'bridge');
  assert.equal(args.at(-1), 'bash');
});

test('container invocation clears an image entrypoint before passing the worker command', () => {
  const args = buildContainerArgs({ image: 'worker:test', worktree: 'D:/w', home: 'D:/h', command: ['zcode', '--version'] });
  const entrypointIndex = args.indexOf('--entrypoint');
  assert.ok(entrypointIndex > 0);
  assert.equal(args[entrypointIndex + 1], '');
  assert.deepEqual(args.slice(-3), ['worker:test', 'zcode', '--version']);
});

test('container args mount the package manifest read-only for the member MCP server', () => {
  const args = buildContainerArgs({
    image: 'worker:test',
    worktree: 'D:/w',
    home: 'D:/h',
    packageRoot: 'D:/pkg',
  });
  assert.ok(args.includes('D:/pkg/src:/opt/agent-teams/src:ro'));
  assert.ok(args.includes('D:/pkg/package.json:/opt/agent-teams/package.json:ro'));
  assert.ok(args.includes('D:/pkg/assets:/opt/agent-teams/assets:ro'));
  assert.ok(!args.includes('D:/pkg:/opt/agent-teams:ro'));
  const packageMounts = args.filter((item) => item.startsWith('D:/pkg/'));
  assert.deepEqual(packageMounts, [
    'D:/pkg/src:/opt/agent-teams/src:ro',
    'D:/pkg/package.json:/opt/agent-teams/package.json:ro',
    'D:/pkg/assets:/opt/agent-teams/assets:ro',
  ]);
});

test('container args keep secret env values out of the command line', () => {
  const args = buildContainerArgs({
    image: 'worker:test',
    worktree: 'D:/w',
    home: 'D:/h',
    env: { AGENT_TEAMS_TOKEN: 'super-secret', AGENT_TEAMS_URL: 'http://host:8779' },
  });
  assert.ok(args.includes('AGENT_TEAMS_TOKEN'));
  assert.ok(!args.includes('AGENT_TEAMS_TOKEN=super-secret'));
  assert.ok(args.includes('AGENT_TEAMS_URL=http://host:8779'));
});

test('runtime detection returns a boolean without throwing', () => {
  const result = detectContainerRuntime();
  assert.equal(typeof result.available, 'boolean');
  if (result.available) assert.equal(typeof result.command, 'string');
});

test('runtime detection never substitutes a different runtime', () => {
  const result = detectContainerRuntime('docker');
  if (result.available) assert.equal(result.runtime, 'docker');
});

test('Windows runtime candidates include the standard Podman and Docker paths', () => {
  const podman = runtimeCandidates('podman', 'win32');
  const docker = runtimeCandidates('docker', 'win32');
  assert.ok(podman.includes('podman'));
  assert.ok(podman.some((item) => item.endsWith('podman.exe')));
  assert.ok(docker.some((item) => item.endsWith('docker.exe')));
  assert.deepEqual(runtimeCandidates('podman', 'linux'), ['podman']);
});

test('container host detection returns an IPv4 address or undefined', () => {
  const host = detectContainerHostAddress();
  assert.ok(host === undefined || /^\d{1,3}(\.\d{1,3}){3}$/.test(host));
});

test('Podman Windows startup initializes and starts a missing machine', () => {
  const calls = [];
  const detected = { available: true, runtime: 'podman', command: 'podman' };
  let started = false;
  const result = ensureContainerRuntime('podman', {
    platform: 'win32',
    detect: () => detected,
    runner: (_command, args) => {
      calls.push(args);
      if (args[0] === 'info') return { status: started ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'machine' && args[1] === 'list') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'machine' && args[1] === 'init') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'machine' && args[1] === 'start') { started = true; return { status: 0, stdout: '', stderr: '' }; }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls[0], ['info']);
  assert.deepEqual(calls[1], ['machine', 'list', '--format', '{{.Name}}']);
  assert.deepEqual(calls[2], ['machine', 'init']);
  assert.deepEqual(calls[3], ['machine', 'start']);
  assert.equal(result.available, true);
  assert.equal(result.machineStarted, true);
});

test('Podman Windows startup starts an existing stopped machine', () => {
  const calls = [];
  const detected = { available: true, runtime: 'podman', command: 'podman' };
  let started = false;
  const result = ensureContainerRuntime('podman', {
    platform: 'win32',
    detect: () => detected,
    runner: (_command, args) => {
      calls.push(args);
      if (args[0] === 'info') return { status: started ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'machine' && args[1] === 'list') return { status: 0, stdout: 'podman-machine-default\n', stderr: '' };
      if (args[0] === 'machine' && args[1] === 'start') { started = true; return { status: 0, stdout: '', stderr: '' }; }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls[0], ['info']);
  assert.deepEqual(calls[1], ['machine', 'list', '--format', '{{.Name}}']);
  assert.deepEqual(calls[2], ['machine', 'start']);
  assert.equal(result.available, true);
  assert.equal(result.machineStarted, true);
});

test('Podman Windows startup does not start a healthy machine', () => {
  const calls = [];
  const result = ensureContainerRuntime('podman', {
    platform: 'win32',
    detect: () => ({ available: true, runtime: 'podman', command: 'podman' }),
    runner: (_command, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.deepEqual(calls, [['info']]);
  assert.equal(result.machineStarted, undefined);
});

test('Podman machine start failure is returned instead of pretending readiness', () => {
  const result = ensureContainerRuntime('podman', {
    platform: 'win32',
    detect: () => ({ available: true, runtime: 'podman', command: 'podman' }),
    runner: (_command, args) => {
      if (args[0] === 'info') return { status: 1, stdout: '', stderr: 'machine stopped' };
      if (args[0] === 'machine' && args[1] === 'list') return { status: 0, stdout: 'm\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'start failed' };
    },
  });
  assert.equal(result.available, false);
  assert.equal(result.machineStarted, false);
  assert.match(result.machineStartError, /start failed/);
});

test('Docker engine failure is not reported as a missing worker image', () => {
  const result = ensureContainerRuntime('docker', {
    platform: 'win32',
    detect: () => ({ available: true, runtime: 'docker', command: 'docker' }),
    runner: (_command, args) => (args[0] === 'info'
      ? { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }
      : { status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(result.available, false);
  assert.equal(result.engineUnavailable, true);
  assert.match(result.engineError, /Docker daemon|Cannot connect/i);
});

test('container self-test uses the resolved runtime command', () => {
  const calls = [];
  const result = containerSelfTest({
    runtime: 'podman',
    command: 'C:/Program Files/RedHat/Podman/podman.exe',
    image: 'worker:test',
    runner: (command) => {
      calls.push(command);
      return { status: 0, stdout: '0.1.2\n', stderr: '' };
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.command, 'C:/Program Files/RedHat/Podman/podman.exe');
  assert.deepEqual([...new Set(calls)], ['C:/Program Files/RedHat/Podman/podman.exe']);
});

test('container self-test distinguishes missing images from runtime inspect failures', () => {
  const missing = containerSelfTest({
    image: 'worker:test',
    runner: () => ({ status: 1, stdout: '', stderr: 'Error response from daemon: No such image: worker:test' }),
  });
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /worker image not found/);

  const inspectFailure = containerSelfTest({
    runtime: 'docker',
    image: 'worker:test',
    runner: () => ({ status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon: permission denied' }),
  });
  assert.equal(inspectFailure.ready, false);
  assert.match(inspectFailure.reason, /docker image inspect failed/);
  assert.match(inspectFailure.reason, /permission denied/);

  const brokenCli = containerSelfTest({
    image: 'worker:test',
    runner: (_command, args) => ({ status: args[0] === 'image' ? 0 : 127, stdout: '', stderr: 'zcode: not found' }),
  });
  assert.equal(brokenCli.ready, false);
  assert.match(brokenCli.reason, /not runnable/);

  const ready = containerSelfTest({
    image: 'worker:test',
    runner: () => ({ status: 0, stdout: '0.1.2\n', stderr: '' }),
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.version, '0.1.2');
});

test('container CLI adapter mounts only worktree, home and read-only package files', () => {
  const adapter = new ContainerCliSessionAdapter({
    runtime: 'docker',
    image: 'worker:test',
    packageRoot: 'D:/pkg',
    containerBaseUrl: 'http://host.docker.internal:8779',
    memoryMb: 2048,
    pidsLimit: 512,
  });
  assert.equal(adapter.toContainerUrl('http://127.0.0.1:8779'), 'http://host.docker.internal:8779');
  const env = adapter.envFor({ memberName: 'm', token: 'mt_member-token', teamId: 'alpha' });
  assert.equal(env.AGENT_TEAMS_URL, 'http://host.docker.internal:8779');
  assert.equal(env.AGENT_TEAMS_MEMBER, 'm');
  // A container worker must never run the captain-panel SessionStart hook.
  assert.equal(env.AI_AGENT_TEAMS_WORKER, '1');
  const args = adapter.buildArgs({
    name: 'worker-1',
    worktree: 'D:/w',
    home: 'D:/h',
    env,
    command: ['zcode', '--version'],
  });
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop'));
  assert.ok(args.includes('--security-opt'));
  assert.ok(args.includes('D:/w:/workspace'));
  assert.ok(args.includes('D:/h:/home/zcode'));
  assert.ok(args.includes('D:/pkg/src:/opt/agent-teams/src:ro'));
  assert.ok(args.includes('D:/pkg/package.json:/opt/agent-teams/package.json:ro'));
  assert.ok(!args.includes('D:/pkg:/opt/agent-teams:ro'));
  assert.ok(args.includes('--name'));
  assert.equal(args.at(-1), '--version');
});

test('container CLI adapter creates and resumes a session through the runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-container-cli-'));
  const home = join(root, 'home');
  try {
    const calls = [];
    const runner = async ({ args }) => {
      calls.push(args);
      if (args.includes('--resume')) return JSON.stringify({ response: 'done', usage: { totalTokens: 2 } });
      return JSON.stringify({ sessionId: 'sess_container_1', response: 'created', usage: { totalTokens: 1 } });
    };
    const adapter = new ContainerCliSessionAdapter({
      runtime: 'docker',
      // Fail container removal deterministically: the session record and its
      // container names must survive for a later retry.
      runtimeCommand: 'definitely-missing-container-runtime',
      image: 'worker:test',
      packageRoot: 'D:/pkg',
      containerBaseUrl: 'http://host.docker.internal:8779',
      runner,
    });
    const created = await adapter.create({
      teamId: 'alpha',
      memberName: 'm',
      cwd: 'D:/w',
      home,
      prompt: 'do work',
      token: 'mt_member-token',
    });
    assert.equal(created.sessionId, 'sess_container_1');
    assert.ok(calls[0].includes('worker:test'));
    assert.ok(calls[0].includes('D:/w:/workspace'));
    assert.ok(calls[0].includes(`${home}:/home/zcode`));
    assert.ok(calls[0].includes('D:/pkg/src:/opt/agent-teams/src:ro'));
    assert.ok(calls[0].includes('D:/pkg/package.json:/opt/agent-teams/package.json:ro'));
    assert.ok(calls[0].includes('AGENT_TEAMS_URL=http://host.docker.internal:8779'));
    assert.equal(calls[0][calls[0].indexOf('--mode') + 1], 'yolo');
    const config = JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
    const server = config.mcp.servers['agent-teams-member'];
    assert.equal(server.env.AGENT_TEAMS_TOKEN, 'mt_member-token');
    assert.equal(server.env.AGENT_TEAMS_TEAM, 'alpha');
    assert.equal(server.env.AGENT_TEAMS_MEMBER, 'm');

    const sent = await adapter.send({ sessionId: 'sess_container_1', message: 'next step' });
    assert.equal(sent.ok, true);
    assert.equal(sent.response, 'done');
    assert.ok(calls[1].includes('--resume'));
    assert.equal(calls[1][calls[1].indexOf('--mode') + 1], 'yolo');
    assert.ok(existsSync(join(home, '.zcode', 'cli', 'config.json')));
    const closed = await adapter.close({ sessionId: 'sess_container_1' });
    assert.equal(closed.ok, false);
    assert.match(closed.warning, /failed to remove container/);
    assert.equal(adapter.sessions.has('sess_container_1'), true,
      'the container names must survive a failed removal so cleanup can be retried');
    assert.equal(adapter.sessions.get('sess_container_1').containerName.length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('container CLI adapter writes no member MCP config for an ephemeral contractor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-container-ephemeral-'));
  const home = join(root, 'home');
  try {
    const adapter = new ContainerCliSessionAdapter({
      runtime: 'docker',
      image: 'worker:test',
      containerBaseUrl: 'http://host.docker.internal:8779',
      runner: async () => JSON.stringify({ sessionId: 'sess_ephemeral_1', response: 'created', usage: {} }),
    });
    await adapter.create({
      teamId: 'alpha',
      memberName: 'contractor',
      cwd: 'D:/w',
      home,
      prompt: 'one shot',
      ephemeral: true,
    });
    assert.equal(existsSync(join(home, '.zcode', 'cli', 'config.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('container CLI adapter warns but keeps the session when the member MCP config cannot be written', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-container-mcp-fail-'));
  const home = join(root, 'home');
  try {
    mkdirSync(join(home, '.zcode'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'cli'), 'not a directory');
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
    const adapter = new ContainerCliSessionAdapter({
      runtime: 'docker',
      image: 'worker:test',
      containerBaseUrl: 'http://host.docker.internal:8779',
      runner: async () => JSON.stringify({ sessionId: 'sess_mcp_fail_1', response: 'created', usage: {} }),
    });
    const created = await adapter.create({
      teamId: 'alpha',
      memberName: 'm',
      cwd: 'D:/w',
      home,
      prompt: 'work',
      token: 'mt_member-token',
    });
    assert.equal(created.sessionId, 'sess_mcp_fail_1');
    assert.ok(warnings.some((line) => line.includes('member MCP config was not written')));
    assert.equal(existsSync(join(home, '.zcode', 'cli', 'config.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
