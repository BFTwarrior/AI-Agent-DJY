/**
 * Localized plugin metadata.
 *
 * Three places show the plugin to a user and must agree:
 * `.zcode-plugin/plugin.json` (installed manifest), the repository
 * `marketplace.json`, and the marketplace entry `scripts/package.mjs` writes
 * into the release ZIP. The two JSON files are static, so they are read and
 * compared by `test/manifest.test.mjs`; the packaged entry is built here so it
 * cannot fall back to a single language.
 *
 * Key convention follows the host and the official pdf plugin: `description_i18n`
 * uses the bare language code `en`, while a UI surface title uses full locales
 * (`en-US`). User-visible metadata is translated; model-facing text
 * (prompts, tool descriptions) stays English.
 * See docs/guides/LOCALIZATION.md "Plugin manifest metadata".
 */

export const PLUGIN_NAME = 'ai-agent-teams';
export const PLUGIN_DESCRIPTION = 'Team control plane for ZCode: captain, two teams, tasks, attempts, mailbox, quality gates.';
/** Product name; never translated. */
export const DISPLAY_NAME = 'Ai-Agent-Teams-Zcode';
export const CATEGORY = 'developer-tools';

/** The host falls back to `displayName`, so only real translations appear here. */
export const DISPLAY_NAME_I18N = Object.freeze({
  'zh-CN': 'AI 智能体团队',
});

/** Long marketplace description. `en` is the host's key for English. */
export const DESCRIPTION_I18N = Object.freeze({
  en: PLUGIN_DESCRIPTION,
  'zh-CN': '一个队长、两支队伍、任务/尝试/邮箱/质量门禁的 ZCode 团队控制平面。',
  'ja-JP': 'ZCode 向けチーム制御プレーン：captain、2チーム、タスク、試行、メールボックス、品質ゲート。',
  'ko-KR': 'ZCode용 팀 제어 플레인: captain, 2개 팀, 태스크, 시도, 메일박스, 품질 게이트.',
});

/** Side-pane surface title, keyed by full locale. */
export const SURFACE_TITLE_I18N = Object.freeze({
  'zh-CN': '智能体团队',
  'en-US': 'Agent Teams',
  'ja-JP': 'エージェントチーム',
  'ko-KR': '에이전트 팀',
});

/**
 * One marketplace plugin entry.
 * @param {{ source?: string, version: string, icon?: string }} input
 * @returns {Record<string, unknown>}
 */
export function marketplacePluginEntry({ source = './', version, icon } = {}) {
  return {
    name: PLUGIN_NAME,
    source,
    version,
    description: PLUGIN_DESCRIPTION,
    displayName: DISPLAY_NAME,
    displayName_i18n: { ...DISPLAY_NAME_I18N },
    ...(icon ? { icon } : {}),
    description_i18n: { ...DESCRIPTION_I18N },
    category: CATEGORY,
  };
}

/**
 * A complete marketplace document with one plugin entry.
 * @param {{ version: string, source?: string, icon?: string, name?: string }} input
 * @returns {Record<string, unknown>}
 */
export function marketplaceDocument({ version, source = './', icon, name = 'ai-agent-teams-local' } = {}) {
  return {
    name,
    plugins: [marketplacePluginEntry({ source, version, icon })],
  };
}
