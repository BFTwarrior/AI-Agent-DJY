# Localization

This guide is the contract for the locale and time-zone layer. It covers what
is localized, how a locale is chosen, where the concrete value is stored, the
message-catalog format, and the boundary that keeps internal prompts in
English.

## Supported languages

| Locale | Language | Notes |
|--------|----------|-------|
| `zh-CN` | Simplified Chinese | source language of the message catalog |
| `ja-JP` | Japanese | |
| `ko-KR` | Korean | |
| `en-US` | English | fallback for every unresolved or unsupported value |

`SUPPORTED_LOCALES` in `src/i18n.mjs` is the single source of truth. The core
accepts common spellings and canonicalizes them:

| Input | Resolved |
|-------|----------|
| `zh`, `zh-CN`, `zh-Hans`, `zh-Hans-CN`, `zh_CN.UTF-8` | `zh-CN` |
| `ja`, `ja-JP`, `ja_JP.UTF-8` | `ja-JP` |
| `ko`, `ko-KR`, `ko_KR.UTF-8` | `ko-KR` |
| `en`, `en-US`, `en_GB.UTF-8`, `en-GB`, `en-AU` (a two-letter region) | `en-US` |
| `C`, `POSIX`, `C.UTF-8` | no preference: skipped, not `en-US` |
| `zh-TW`, `zh-Hant`, `de-DE`, empty, non-string | unsupported |

POSIX suffixes are stripped before matching: `.codeset` (for example
`.UTF-8`) and `@modifier` (for example `@euro`). `zh-TW`/`zh-Hant` stay
unsupported instead of silently receiving Simplified text.

Only a two-letter region suffix is accepted after `en-`: `en-GB` and `en-AU`
map to `en-US`, while a longer or numeric subtag (`en-Latn-US`, `en-001`) is
unsupported and falls through to the next source. `C`/`POSIX` mean "no locale
preference" — a `LANG=C` server on a Chinese desktop still resolves `zh-CN`
from the platform locale.

## Detection order

`detectSystemLocale({ env, intl })` checks, in order:

1. `AGENT_TEAMS_LOCALE`
2. `ZCODE_LOCALE`
3. `LC_ALL`
4. `LC_MESSAGES`
5. `LANG`
6. `Intl.DateTimeFormat().resolvedOptions().locale`
7. `en-US`

An unsupported value is skipped, not fatal: the next source is tried. An
emptied variable (`LC_ALL=`) is skipped the same way.

`detectSystemTimeZone({ env, intl })` checks, in order:

1. `AGENT_TEAMS_TIMEZONE`
2. `TZ` (a leading `:` is stripped)
3. `Intl.DateTimeFormat().resolvedOptions().timeZone`
4. `UTC`

Every candidate is validated by constructing
`new Intl.DateTimeFormat('en-US', { timeZone })`; invalid zones are skipped
and the next source is tried. `normalizeTimeZone` returns the canonical name
(for example `asia/shanghai` becomes `Asia/Shanghai`).

Both functions are pure and accept injected `env`/`intl`, so tests and callers
never depend on the process globals.

## Configuration keys

`src/config.mjs`, `config/schema.json` and `config/README.md` define two keys
under `zcode`:

| Key | Default | Accepted |
|-----|---------|----------|
| `locale` | `auto` | `auto`, `zh-CN`, `ja-JP`, `ko-KR`, `en-US` |
| `timezone` | `auto` | `auto` or any valid IANA name (for example `Asia/Shanghai`) |

Rules:

- `validateConfig` rejects an empty locale string (`""` fails the
  `auto|zh-CN|ja-JP|ko-KR|en-US` enum) and an invalid time zone
  (`Not/AZone`, `GMT+8`, empty string). Only a missing key (`undefined`/`null`,
  filled with `auto` by `applyDefaults`) or the literal `auto` means "detect".
  An explicit value is never silently replaced.
- `loadConfig` validates first, then resolves `auto` through detection and
  returns `config.zcode.locale` / `config.zcode.timezone` as concrete values.
  The raw preference is not copied onto the returned config, so re-validating a
  loaded config stays clean (no unknown-key error).
- `resolveLocale`/`resolveTimeZone` return `{ locale|timeZone, source,
  warning }` with `source` = `detected`, `explicit` or `fallback`. They treat
  `auto`, an empty string and `undefined`/`null` alike (detect), so a
  programmatic caller that passes `''` gets detection while the same value in a
  config file is a validation error. An unsupported programmatic value falls
  back to detection with a warning instead of throwing; config-file validation
  remains the strict entry point.
- `loadConfig` never rewrites the file on disk. Changing the location means
  editing `config/local.json` or re-running the install wizard.

## Time zone

- Times are persisted as epoch milliseconds (INV-044); the time zone affects
  display only.
- `formatDateTime(value, { locale, timeZone, ... })` accepts a `Date`, epoch
  milliseconds or an ISO string. Both options are optional and independent:
  an omitted (or `auto`/`''`) `locale`/`timeZone` is resolved by **detection**
  (`detectSystemLocale`/`detectSystemTimeZone`, i.e. the env chain and then the
  host `Intl`), not by reading `config/local.json`. Callers that want the
  configured value pass it explicitly (the patrol report does). The function
  honors extra `Intl.DateTimeFormat` options and returns `''` for unusable
  input or conflicting options so a bad row cannot crash a projection.
- Naming component options (`hour`, `minute`, ...) replaces the default
  date+time field set; use `dateStyle`/`timeStyle` for a preset shape.
- The patrol report and the web console use the resolved values; a patrol
  report is generated in the locale/time zone configured for the workspace.

## First install

`src/installer.mjs` (`buildInstallPlan`) is the single place that generates a
`config/local.json`. It writes concrete values, never `auto`:

- an explicit caller value (`locale`, `timezone` arguments) wins and is
  canonicalized; an invalid explicit value fails the plan;
- otherwise `detectSystemLocale()` / `detectSystemTimeZone()` is called once
  at install time.

`applyPreset` in `src/install-wizard.mjs` forwards optional `locale` and
`timezone` arguments to the same plan, so the wizard CLI and the installer CLI
produce the same shape. Both CLIs accept the same two flags:

```bash
# Installer: plan (and optionally write) a config with explicit values.
node src/installer.mjs --plan --locale ja-JP --timezone Asia/Tokyo
node src/installer.mjs --plan --write config/local.json --locale zh_CN.UTF-8

# Wizard: finish the verified flow with explicit values.
node src/install-wizard.mjs --apply --preset balanced --locale ja-JP --timezone Asia/Tokyo
```

An omitted flag means detection at install time; an unsupported value fails the
command (`unsupported locale for local.json: de-DE`) and writes nothing.
Existing installs keep their stored values; re-running the wizard is the
supported way to change them.

The web console reads the resolved config and returns
`localization: { locale, timeZone }` from `buildUiConsole`; a missing or
invalid value falls back to detection.

## Message catalog format

User-visible strings live in `locales/<locale>.json`, one file per supported
locale. `locales/zh-CN.json` is the source; the other files are translations.

```json
{
  "locale": "ja-JP",
  "name": "日本語",
  "strings": {
    "巡检报告": "巡回レポート",
    "正在执行": "実行中"
  },
  "patterns": [
    { "source": "已运行 {0}", "target": "実行時間 {0}" },
    { "source": "窗口 {0}–{1}", "target": "期間 {0}–{1}" }
  ]
}
```

Rules:

- `locale` is the catalog's canonical locale and `name` is the language name
  shown in a language picker (in that language).
- `locales/zh-CN.json` is the source catalog: every entry maps the source text
  to itself. `strings` maps the exact Chinese source text to its translation.
  Keys are source strings, not generated ids, so a missing key is obvious in
  review.
- `patterns` is an array of `{ "source": "...{0}...", "target": "...{0}..." }`
  entries for strings with runtime values; `{0}`, `{1}`, ... are positional
  placeholders and must survive translation unchanged.
- Never translate keys, placeholder indexes, tool names, config keys, file
  paths, `文档/`, `逻辑图/` or `归档/历史/文档/`.
- Add a key in `zh-CN.json` first, then translate it into the other catalogs in
  the same change. A catalog with a different key set from the source is a
  drift error.
- Do not put model-facing text in a catalog. See the boundary below.

`node scripts/build-i18n.mjs` embeds the catalogs into the packaged panel. It
writes the runtime to three places and they are not interchangeable:

- `assets/team-view-i18n.js` — the standalone runtime file the UI build reads.
- `assets/team-view-live.js` — the runtime is inlined between the
  `BEGIN/END GENERATED I18N` markers, because the daemon serves the live view
  from a fixed asset list and `/ui` has to stay offline.
- `assets/team-view.html` — only an empty placeholder between the
  `<!-- BEGIN GENERATED I18N -->` and `<!-- END GENERATED I18N -->` markers;
  the panel script loads the runtime from `team-view-live.js`, so do not expect
  the catalog JSON in the HTML file.

All three are build output: never hand-edit them, and re-run the builder after
changing a catalog. `npm run check:i18n` fails if the packaged panel does not
carry every locale `name` or if it tries to `fetch()` locale JSON at runtime.

## Web console language selector

The browser console (`assets/team-view.html`, served at `/ui`) has a runtime
that is separate from the core resolver above: it cannot read the daemon's
environment, so it resolves from browser-visible sources only.

- The control is `<select id="locale-select">` on the settings page, with one
  `<option>` per supported locale. `assets/team-view-app.js` wires `change` to
  `window.AGT_I18N.setLocale(next)`; a rejected value (a name outside the
  whitelist) returns `false` and the handler calls `syncLocaleSelect()` to put
  the select back on the active locale.
- `setLocale` switches immediately (no reload), rewrites
  `document.documentElement.lang`, localizes the current document (text nodes
  and the `title` / `aria-label` / `placeholder` / `alt` attributes), persists
  the choice and dispatches `agent-teams:locale-changed`. `team-view-app.js`
  listens for that event and re-renders the parts it builds in JS (nav
  breadcrumb, live pill, member/workforce/team cards, static panels, demo task
  cards, counters, graph labels, task detail, merge queue, run mode, overview).
- Persistence key: `agent-teams-locale-v1` in `localStorage`, defined once as
  `LOCALE_STORAGE_KEY` in the runtime template of `scripts/build-i18n.mjs` and
  embedded in `assets/team-view-i18n.js` and `assets/team-view-live.js`. It has
  no path suffix, unlike the theme key (`agent-teams-theme-v1:<pathname>`) and
  the static-preview capacity key (`agent-teams-worker-capacity-v1:<pathname>`):
  every console page on the same origin shares one language choice.
- Resolution order in the runtime: `?lang=` preview parameter → stored value →
  `console.localization.locale` (the resolved `zcode.locale` exposed by
  `buildUiConsole`) → `<html lang>` → `navigator.language` → `en-US`. The
  `?lang=` preview is not written back to storage and outranks a selection in
  the same URL, so a refresh keeps the preview until the parameter is removed.
- Clearing site data removes only the stored override. The fallback chain then
  lands on the configured locale for a daemon-served `/ui`, and on the static
  document's `<html lang="zh-CN">` when `assets/team-view.html` is opened
  directly from disk (no bootstrap is injected there). `zh-TW`/`zh-Hant` are
  unsupported in both cases: they fall through instead of rendering Simplified
  text.

### Team display names

`alpha`/`beta` are rendered from a fixed vocabulary, not from user data.
`teamLabel` in `assets/team-view-live.js` maps the team id (or a name starting
with `alpha`/`beta`) to the catalog keys `A队`/`B队`; any other team name is
returned verbatim.

| Key | zh-CN | en-US | ja-JP | ko-KR |
|-----|-------|-------|-------|-------|
| `A队` | A队 | A team | Aチーム | A팀 |
| `B队` | B队 | B team | Bチーム | B팀 |
| `双队` | 双队 | Two teams | 2チーム | 2팀 |
| `单队` | 单队 | Single team | 1チーム | 단일 팀 |

Colour words are a visual cue only (member avatars and team marks use the
amber/mint/violet/indigo palette); they are never the system name for a team.
The catalogs still carry `蓝队`, `绿队`,
`蓝队 + 绿队`, `蓝队等待` and related keys as compatibility aliases whose values
are `A队`/`B队`/`A队 + B队` in every locale, so an old snapshot or an old code
path cannot leak a colour name. `test/ui-i18n.test.mjs` asserts both the
rendered values and the catalogs: no `蓝队/绿队/Blue team/ブルーチーム/블루 팀`
in any of the four locales, while the legacy keys still resolve to A/B.

### Demo fixtures versus live data

The static/demo view and the live view translate different things:

- Demo tasks are keyed by stable ids. `demoTaskCopy` (`t1..t12`, `b1..b12`)
  supplies a translatable `title`/`sub`, `demoTaskTeam(id)` supplies the
  localized `A队`/`B队` prefix, and `displayTaskSubject` only takes that path
  when `LIVE_MODEL` is absent and the id is in `demoTaskCopy`. Demo merge rows
  carry `titleId` + `titleKey`, and `mergeTitle` translates only rows with a
  `titleKey`.
- Live data stays verbatim. A live task `subject`, `displayId`, owner, member
  name, session content, path, commit, branch and event id are user data or
  identifiers: they are rendered with `data-i18n-skip` (or built after the
  runtime walk) and are never looked up in the catalog — even when the text
  happens to equal a dictionary key. `displayMemberName` returns the original
  name; `ownerLabel` translates only `captain`, the role vocabulary and the
  `已移除成员`/`未分配` sentinels; `roleLabel` and `kindLabel` map fixed
  vocabulary through `tr()`.
- Graph node titles use the localized demo copy on the demo path and the raw
  subject on the live path. `stripTeamPrefix` knows the rendered prefixes
  (`A队`, `B队`, `A team`, `B team`, `Aチーム`, `Bチーム`, `A팀`, `B팀`), and
  `truncateTitle` truncates by measured pixel width (`NODE_TITLE_BUDGET_PX =
  nodeW - 20`, `nodeW = 124`) so a Latin title keeps more glyphs than a CJK one
  and no script overflows the node.
- The runtime recognises `data-i18n-skip` only. A bare `data-i18n="..."`
  attribute is not read; entries are matched by their source text or pattern.
  Add a catalog entry instead of expecting an attribute binding.

### Value-level regression requirements

Key-presence checks are not enough: a catalog can keep every key and still
render a colour name or an untranslated string. A change to the console language
layer is accepted only when these pass:

- `node scripts/build-ui.mjs` (`npm run build:ui`) — rebuilds
  `assets/team-view-i18n.js`, refreshes the generated block in
  `assets/team-view-live.js` and `assets/team-view.html`, and repackages
  `assets/team-panel.html`. Skipping it leaves a stale embedded catalog and
  `test/ui-i18n.test.mjs` fails the stale-build assertion.
- `npm run check:i18n` — must end with `I18N COVERAGE OK`, with every extracted
  string covered and zero allowlisted items. At the 2026-11-10 local checkpoint
  it reported 1443 extracted / 1443 covered / 0 allowlisted / 705 strings / 114
  patterns; counts change when UI copy or source patterns change. Any new
  user-visible Chinese literal needs a catalog entry or pattern. The scan only
  skips what is marked as data:
  `data-i18n-skip` subtrees, the demo-fixture `i18n-allowlist-start/end` ranges,
  and the single documented regex literal in `scripts/i18n-allow.mjs`.
- `npm test` — includes the value-level guards in `test/ui-i18n.test.mjs`
  (persistence and preview priority, whitelist including `zh-TW` rejection,
  no colour names in any locale, no Han characters in en/ko values, demo versus
  live mutation guard, packaged-panel freshness) and the layout guards in
  `test/ui-task-tree-layout.test.mjs` (locale control and A/B labels at
  1280×720, 1920×1080, 2560×1440 and 3840×2160; longest-locale copy; title cards
  that shrink instead of overlapping badges).

Historical local gate checkpoint (this branch, 2026-11-08, package version 0.1.9; not current source acceptance):
`npm test` reports 1104 tests, 1101 pass, 3 skipped, 0 fail; `check:i18n` reports
1444 extracted / 1444 covered / 0 allowlisted / 699 strings / 114 patterns;
`check` reports 167 files.

The stat-card sweep (6 resolutions × 4 locales × 2 themes = 48 runs over the
overview, dual-team and member pages, 12 cards each) plus a continuous
420–1400 px width sweep at 20 px steps in all four locales (200 runs) reports
zero clipped and zero overflowing labels or badges, zero horizontal scroll, and
zero spread in the number baseline within each grid row. Measurement activates
each page through its real nav button and uses `Range.getClientRects()` for
glyph-accurate clipping; an inactive page is `display:none`, where every rect is
0x0 and any clipping assertion passes silently.

The stat grid falls back to two columns at 1240 px. Four columns below that leave
each card narrower than the intrinsic width of the longest English badge
("On duty / concurrency limit" needs ~178 px by itself). The theme stylesheets
switch to two columns at 1080 px, so a 980 px breakpoint left 1081–1230 px
unprotected — including 1152 px, the CSS width of a 1440 px screen at 125%
Windows scaling — and the badge was cut mid-glyph with no ellipsis there.
Below 560 px the badge text wraps inside the pill, because two columns still
leave each card narrower than the longest English badge.

At 1280×720 the label row of two cards wraps: the badge moves to its own row
rather than the label losing words. An earlier attempt kept one line and relied
on `text-overflow: ellipsis` on the badge, which never painted anything because
`.badge` is `display: inline-flex`; that variant shrank `현재 멤버` to `현재 `
and clipped `concurrenc|`. A second attempt wrapped the row but left the label at
its natural height, so wrapped and unwrapped cards differed by 21–34 px in the
`.stat-value` baseline. The accepted fix reserves `min-height: 50px` on the label
row, lets `.stat-foot` absorb the leftover height, and keeps `.stat-value` at
`margin-top: 0`, so all four cards in a row share one baseline. Below 1240 px the
grid drops to two columns because four columns leave less width than a single
long English label. The regression test asserts wrapping, the reserved height,
the span-level ellipsis guard, the foot's `flex: 1`, and that no `text-overflow`
returns to the flex pill.

## AI translation prompt template

Use this template when a model produces a catalog. Fill in the target locale and
the source JSON; require JSON-only output. The `name` field is mandatory:
`scripts/build-i18n.mjs` reads it for the language picker and fails with
`<file>: name is required` when it is missing or blank.

### Terminology (fixed translations)

Every catalog uses these translations. They are not suggestions: a different
word for the same concept is a review finding. Where the concept already appears
in `locales/*.json` (`队长`, `组长`, `成员`, `审核员`, `巡检`, `合并`, `外包`,
`双队`, `单队`, `审计`, `交付`, `验收`, `工作树`, `任务`), the table quotes the
existing value verbatim; the other rows fix the word before a source string
needs it.

| Concept | zh-CN | ja-JP | ko-KR | en-US |
|---------|-------|-------|-------|-------|
| captain | 队长 | captain | captain | captain |
| lead (team lead) | 组长 | チームリード | 팀 리드 | Team lead |
| member | 成员 | メンバー | 멤버 | Members |
| reviewer | 审核员 | レビュアー | 검토자 | Reviewer |
| patrol | 巡检 | パトロール | 순찰 | Patrol |
| attempt | 尝试 | 試行 | 시도 | Attempt |
| gate | 门禁 | ゲート | 게이트 | Gate |
| merge | 合并 | マージ | 병합 | Merge |
| contractor | 外包 | コントラクター | 계약 인력 | Contractor |
| team | 团队 | チーム | 팀 | Team |
| session | 会话 | セッション | 세션 | Session |
| task | 任务 | タスク | 태스크 | Tasks |
| audit | 审计 | 監査 | 감사 | Audit |
| delivery | 交付 | 納品 | 납품 | Delivery |
| acceptance | 验收 | 受け入れ | 인수 기준 | Acceptance |
| worktree | 工作树 | ワークツリー | 워크트리 | Worktree |
| two teams | 双队 | 2チーム | 2팀 | Two teams |
| single team | 单队 | 1チーム | 단일 팀 | Single team |

`captain` deliberately stays the English word in Japanese and Korean; do not
replace it with a local title. The protocol continue token `继续` is not a
catalog entry at all (it is model-facing, see the boundary below): a UI button
labelled 继续 may translate to `再開`/`재개`/`Resume`, but the message the daemon
sends to a session still carries the literal `继续`.

### Template

```text
You are translating the user-visible message catalog for Ai-Agent-Teams-Zcode
from Simplified Chinese (zh-CN) to <target locale>.

Rules:
1. Return one JSON object with exactly the same shape and the same keys as the
   source:
   {"locale":"<target locale>","name":"<language name in that language>","strings":{...},"patterns":[{"source":"...","target":"..."}, ...]}
   The `name` value is the language's own name as a speaker writes it (for
   example 日本語, 한국어, English, 简体中文); it is required and must not be
   empty.
2. Translate values only. Never translate or reorder keys, and never add or
   drop keys.
3. Preserve every placeholder ({0}, {1}, ...), escape sequence and Markdown
   marker exactly.
4. Keep tool names, config keys, file paths, commands, product names and the
   real directories 文档/, 逻辑图/, 归档/ and 归档/历史/文档/ verbatim. Keep the continue
   token 继续 verbatim.
5. Use the terminology table you were given for every concept it lists, even
   when a longer synonym would read better. Then keep the wording short: the
   panel is narrow, so a translation should not be much longer than the source.
6. Do not add commentary, code fences or extra text. Output JSON only.

Terminology (use exactly these):
<the terminology table above, copied verbatim>

Source (zh-CN):
<source JSON>
```

If a sentence is ambiguous, translate it the way the surrounding UI uses it
rather than inventing a new term.

## Acceptance checklist

Before a catalog is accepted:

- [ ] The file is valid JSON and declares the right `locale`.
- [ ] `name` is a non-empty string in the target language; without it
      `node scripts/build-i18n.mjs` throws `<file>: name is required`.
- [ ] `strings` and `patterns` key sets equal `locales/zh-CN.json` exactly.
- [ ] No placeholder (`{0}`, `{1}`, ...) was renamed, renumbered or dropped.
- [ ] Tool names, config keys, commands, paths and the real directories
      `文档/`, `逻辑图/`, `归档/`, `归档/历史/文档/` are unchanged.
- [ ] Build and coverage pass together: `node scripts/build-i18n.mjs` succeeds
      (it also validates the key sets and placeholders) and `npm run check:i18n`
      ends with `I18N COVERAGE OK`.
- [ ] Every concept in the terminology table uses the listed translation:
      search the catalog for the zh-CN source of that concept and compare the
      target value with the other catalogs, for example
      `node -e "const c=require('./locales/ja-JP.json');console.log(c.strings['合并'])"`
      must print `マージ`.
- [ ] A native speaker or a second model review of accuracy and tone is pending
      manual confirmation; this checklist does not claim the review happened.
- [ ] The UI is checked with the locale forced
      (`AGENT_TEAMS_LOCALE=<locale>` or `zcode.locale`), including one long
      string and one pattern with two placeholders.
- [ ] `npm test` and `npm run check` pass; `config` tests still show concrete
      locale/time zone values.

## Plugin manifest metadata

The plugin browser and marketplace render metadata, not the panel, so this is a
user-visible surface and is translated. Two files must agree, and
`test/manifest.test.mjs` keeps them agreeing:

| Location | Field | Keys |
|----------|-------|------|
| `.zcode-plugin/plugin.json` | `description_i18n` | `en`, `zh-CN`, `ja-JP`, `ko-KR` |
| `.zcode-plugin/plugin.json` | `ui.surfaces[].title` | `zh-CN`, `en-US`, `ja-JP`, `ko-KR` |
| `marketplace.json` | `description_i18n` | `en`, `zh-CN`, `ja-JP`, `ko-KR` |
| `marketplace.json` | `displayName_i18n` | `zh-CN` plus any language whose name differs |
| packaged `marketplace.json` (from `scripts/package.mjs`) | `description_i18n` | the same four, from `src/plugin-metadata.mjs` |

Rules:

- `description_i18n` uses the bare language code `en`; a UI surface `title`
  uses a full locale (`en-US`). Both follow the host and the official plugins.
- `en` repeats the top-level `description` verbatim, so a host that ignores
  `_i18n` shows the same sentence.
- `Ai-Agent-Teams-Zcode`, `ZCode` and `captain` are never translated. Japanese
  and Korean copy keeps `captain` as-is, matching `locales/*.json`.
- `scripts/package.mjs` builds its marketplace entry with
  `marketplaceDocument()` from `src/plugin-metadata.mjs`, so a release ZIP can
  never regress to one language. Edit the module, not the generated block.

Not supported: per-language plugin agent files. This source has
`agents/team-worker.md` as a single shared native worker-model preference entry;
it is not a prompt or a native row for every roster member. Runtime team members
are materialized by the scheduler from role templates (`src/service/roles.mjs`,
`prompts/member.md`). The host reads one `name`/`description` per agent file and
does not accept `description_i18n`, so the agent description stays English under
the internal-material rule above. The four-language experience lives in the
plugin metadata and the panel UI.

Reference implementation: the official pdf plugin,
`~/.zcode/cli/plugins/cache/zcode-plugins-official/pdf/0.2.2/.zcode-plugin/plugin.json`,
which declares `description_i18n` with `en` + `zh-CN` and `ui.surfaces[0].title`
with `zh-CN` + `en-US`.

## Boundary: what is never localized

Internal material stays English in every version, including work resumed in a
new conversation:

- `prompts/*.md`, `src/service/prompts.mjs`, the patrol report text
  (`src/service/patrol-run.mjs`), `initialize.instructions`, MCP
  tool descriptions/examples, and skill/command files (`skills/*/SKILL.md`,
  `commands/*.md`).
- Model-facing messages assembled in code: the `PANEL_STARTUP_RULE` shared by
  `src/mcp/handler.mjs` and the SessionStart hook
  (`src/domain/prompt-rules.mjs`), the hook's `additionalContext`
  (`scripts/session-start.mjs`), and scheduled message bodies such as
  `redReviewEscalationText` in `src/domain/scheduler.mjs`.
- The language of a prompt does not follow `zcode.locale`; a workspace running
  in `ja-JP` still sends English instructions to its models.
- Real directory names and literal protocol values are data, not prose: keep
  `文档/`, `逻辑图/`, `归档/`, `归档/历史/文档/`, the `继续` continue token and the
  `[自动继续审查上报]` escalation title verbatim. The title is an identifier
  that `prompts/captain.md` and the panel match on; the body around it is
  English.

`test/prompt-language.test.mjs` checks selected generated prompts and quality-gate source text; it does not scan every static prompt, skill, command or MCP description listed above. Review those static files manually and extend the test when adding model-facing text.

The rule is recorded in `AGENTS.md` and `docs/guides/CONSTRAINTS.md` and is part
of the definition of done for future changes.
