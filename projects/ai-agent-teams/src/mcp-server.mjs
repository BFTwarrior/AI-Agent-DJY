import { runShell } from './mcp/shell.mjs';

// Stable entry point: keep this file tiny. The host session keeps talking to
// this process, while `src/mcp/shell.mjs` swaps the replaceable runtime behind
// `runtime/current.json` (falling back to `src/mcp/runtime-entry.mjs`).
await runShell();
