import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The host provider config has appeared in two shapes across ZCode builds.
 * Keep both readers in one place so the daemon's bridge decision and the
 * worker-home rewrite can never disagree.
 * @param {any} provider
 * @returns {any[]}
 */
export function providerRules(provider) {
  const nested = provider?.config?.providerConfigRules?.providerRules;
  if (Array.isArray(nested)) return nested;
  const flat = provider?.config?.providers;
  return Array.isArray(flat) ? flat : [];
}

/**
 * @param {any} rule
 * @returns {string|undefined}
 */
export function providerIdOf(rule) {
  return rule?.providerId ?? rule?.id;
}

/**
 * @param {any} rule
 * @returns {any|undefined}
 */
export function providerApi(rule) {
  return rule?.config?.api ?? rule?.api;
}

/**
 * @param {any} provider
 * @param {string} providerId
 * @returns {any|undefined}
 */
export function providerRuleFor(provider, providerId) {
  if (!providerId) return undefined;
  return providerRules(provider).find((rule) => providerIdOf(rule) === providerId);
}

/**
 * Read the selected provider base URL from a host profile. Returns undefined
 * for a missing/invalid file, an unknown provider, or a non-string base URL.
 * @param {string} homeSeed
 * @param {string} providerId
 * @returns {string|undefined}
 */
export function selectedProviderBaseUrl(homeSeed, providerId) {
  if (!homeSeed || !providerId) return undefined;
  try {
    const provider = JSON.parse(readFileSync(join(homeSeed, 'provider_config.json'), 'utf8'));
    const api = providerApi(providerRuleFor(provider, providerId));
    return typeof api?.baseUrl === 'string' ? api.baseUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Point the selected provider at a container-reachable bridge. Only that one
 * provider is changed; the host's own provider_config.json is never modified.
 * @param {any} provider
 * @param {string} providerId
 * @param {string} baseUrl
 * @returns {{ rewritten: boolean, reason?: string }}
 */
export function rewriteProviderBaseUrl(provider, providerId, baseUrl) {
  if (!providerId) return { rewritten: false, reason: 'no worker provider selected' };
  if (!baseUrl) return { rewritten: false, reason: 'no container provider URL supplied' };
  const rule = providerRuleFor(provider, providerId);
  if (!rule) return { rewritten: false, reason: `provider ${providerId} was not found in provider_config.json` };
  const api = providerApi(rule);
  if (!api || typeof api.baseUrl !== 'string') {
    return { rewritten: false, reason: `provider ${providerId} has no api.baseUrl` };
  }
  api.baseUrl = baseUrl;
  return { rewritten: true };
}
