#!/usr/bin/env node
/**
 * One-shot real-model prompt through ZCode app-server.
 *
 * The ZCode CLI has no --model flag. This wrapper uses the Protocol
 * session/create + session/setModel path instead, so a provider/model and
 * reasoning level can be selected without touching the CLI's default provider.
 *
 * Examples:
 *   node scripts/zcode-real.mjs --model provider-b/model-x --reasoning max --prompt "Reply OK"
 *   npm run zcode:real -- --model provider/model --reasoning max --prompt "..."
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ProtocolSessionAdapter } from '../src/session/protocol.mjs';
import { resolveCli } from '../src/session/cli.mjs';

function usage() {
  console.error(`Usage: node scripts/zcode-real.mjs --model <providerId>/<modelId> [options] [prompt]

Options:
  --prompt <text>       Prompt text; alternatively pass it positionally.
  --model <id>          Required providerId/modelId (or ZCODE_MODEL).
  --reasoning <level>   Optional reasoning level, e.g. max (or ZCODE_REASONING).
  --cwd <path>          Workspace directory; defaults to the current directory.
  --mode <mode>         build|edit|plan|yolo|guarded; default build.
  --cli <path>          ZCode CLI path; defaults to the normal resolver.
  --timeout <ms>        Response timeout; default 300000.
  --disallowed-tools    Comma-separated tool names to deny (e.g. Edit,Write,Bash).
  --json                Print { response, usage } as JSON.
  --help                Show this help.

This wrapper is for manual one-shot calls. The Ai-Agent-Teams-Zcode daemon already
uses app-server automatically when defaultModel/defaultReasoning are set.`);
}

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: 'string', short: 'p' },
    model: { type: 'string' },
    reasoning: { type: 'string' },
    cwd: { type: 'string' },
    mode: { type: 'string', default: 'build' },
    cli: { type: 'string' },
    timeout: { type: 'string' },
    'disallowed-tools': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (parsed.values.help) {
  usage();
  process.exit(0);
}

const prompt = parsed.values.prompt ?? parsed.positionals.join(' ');
const model = parsed.values.model ?? process.env.ZCODE_MODEL;
const reasoning = parsed.values.reasoning ?? process.env.ZCODE_REASONING;
const cwd = resolve(parsed.values.cwd ?? process.cwd());
const timeoutMs = Number(parsed.values.timeout ?? 300000);

if (!prompt?.trim()) {
  usage();
  console.error('ERROR: prompt is required');
  process.exit(2);
}
if (!model) {
  usage();
  console.error('ERROR: --model (or ZCODE_MODEL) is required; ZCode CLI has no --model flag');
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error('ERROR: --timeout must be a positive number');
  process.exit(2);
}
if (!['build', 'edit', 'plan', 'yolo', 'guarded'].includes(parsed.values.mode)) {
  console.error('ERROR: --mode must be build|edit|plan|yolo|guarded');
  process.exit(2);
}

const adapter = new ProtocolSessionAdapter({
  cliPath: parsed.values.cli ?? resolveCli(),
  cwd,
  mode: parsed.values.mode,
});
const disallowedTools = (parsed.values['disallowed-tools'] ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

let sessionId;
try {
  const created = await adapter.create({
    teamId: 'oneshot',
    memberName: 'oneshot',
    cwd,
    prompt: '',
    model,
    reasoning,
    mode: parsed.values.mode,
    disallowedTools,
  });
  sessionId = created.sessionId;
  if (created.warning) console.error(`WARN: ${created.warning}`);
  const result = await adapter.send({
    sessionId,
    message: prompt,
    wait: true,
    timeoutMs,
  });
  if (!result.ok) throw new Error(result.warning ?? 'model request failed');
  if (parsed.values.json) {
    console.log(JSON.stringify({ response: result.response, usage: result.usage ?? null }));
  } else {
    console.log(result.response);
  }
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await adapter.close({ sessionId }); } catch { /* best effort */ }
  }
  await adapter.shutdown();
}
