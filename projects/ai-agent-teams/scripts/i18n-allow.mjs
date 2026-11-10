/**
 * Exemptions for the i18n coverage scan (`scripts/i18n-coverage.mjs`).
 *
 * Every rule needs a reason so an accidental new exemption is visible in
 * review. Keep this list minimal: demo fixtures already sit inside
 * `i18n-allowlist-start/end` ranges, so a broad team-label rule would only
 * hide a real untranslated UI label. Only the non-UI regex literal stays exempt.
 */

const RULES = [
  {
    pattern: /^(A队|B队) [AB]-T$/u,
    reason: 'regex replacement prefix for demo task references, not standalone UI text',
  },
];

/**
 * @param {string} value normalized source text
 * @param {(entry: {value: string, reason: string}) => void} [onHit] diagnostics sink
 * @returns {boolean} true when the value is a deliberate non-UI exemption
 */
export function isAllowlisted(value, onHit) {
  for (const rule of RULES) {
    if (rule.pattern.test(value)) {
      if (onHit) onHit({ value, reason: rule.reason });
      return true;
    }
  }
  return false;
}

export const ALLOW_RULES = RULES;
