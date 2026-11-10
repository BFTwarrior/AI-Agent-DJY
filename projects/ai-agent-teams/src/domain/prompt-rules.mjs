/**
 * Model-facing instruction strings shared by the MCP `initialize` response and
 * the SessionStart hook.
 *
 * They live in one module so the two surfaces cannot drift: a model that reads
 * `initialize.instructions` and a model that reads the hook's
 * `additionalContext` must receive the same rule. Both are English only; the
 * prompt language never follows `zcode.locale` (see docs/guides/LOCALIZATION.md).
 */

/** Env var that opts a session into the automatic panel rule. */
export const AUTO_PANEL_ENV = 'AI_AGENT_TEAMS_AUTO_PANEL';

/**
 * Startup rule injected when `AI_AGENT_TEAMS_AUTO_PANEL=1`.
 *
 * The first sentence names the opt-in, the second says what to call, the third
 * prevents repetition, the fourth keeps a broken tool from blocking the user's
 * task (the hook case) and the last keeps ordinary work out of the panel.
 */
export const PANEL_STARTUP_RULE = 'Session startup rule: this session was explicitly opened as a captain/UI session (AI_AGENT_TEAMS_AUTO_PANEL=1). Call `agent_teams_view` once with no arguments before other work so the live Ai-Agent-Teams-Zcode panel appears in the ZCode side pane. Do not call it repeatedly unless the user asks to view the team again. If the tool is unavailable or the call fails, ignore this rule and continue the user\'s task. Never open the panel for an ordinary test, Q&A, or one-shot coding task.';
