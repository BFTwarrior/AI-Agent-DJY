import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  providerRuleFor,
  rewriteProviderBaseUrl,
  selectedProviderBaseUrl,
} from '../src/session/provider-config.mjs';

test('provider config reads both known shapes and rewrites only the selected provider', () => {
  const nested = {
    config: {
      providerConfigRules: {
        providerRules: [
          { providerId: 'local', config: { api: { baseUrl: 'http://127.0.0.1:8787/v1' } } },
          { providerId: 'remote', config: { api: { baseUrl: 'https://example.test/v1' } } },
        ],
      },
    },
  };
  assert.equal(providerRuleFor(nested, 'local').providerId, 'local');
  const rewrite = rewriteProviderBaseUrl(nested, 'local', 'http://192.0.2.10:49152/v1');
  assert.equal(rewrite.rewritten, true);
  assert.equal(nested.config.providerConfigRules.providerRules[0].config.api.baseUrl, 'http://192.0.2.10:49152/v1');
  assert.equal(nested.config.providerConfigRules.providerRules[1].config.api.baseUrl, 'https://example.test/v1');
  assert.match(rewriteProviderBaseUrl(nested, 'missing', 'http://x').reason, /not found/);
  assert.match(rewriteProviderBaseUrl(nested, '', 'http://x').reason, /no worker provider/);

  const flat = { config: { providers: [{ id: 'local', api: { baseUrl: 'http://127.0.0.1:8787/v1' } }] } };
  const flatRewrite = rewriteProviderBaseUrl(flat, 'local', 'http://192.0.2.10:49152/v1');
  assert.equal(flatRewrite.rewritten, true);
  assert.equal(flat.config.providers[0].api.baseUrl, 'http://192.0.2.10:49152/v1');
});

test('selectedProviderBaseUrl returns only the selected provider URL', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-agent-teams-provider-config-'));
  try {
    const seed = join(root, 'seed');
    mkdirSync(seed);
    writeFileSync(join(seed, 'provider_config.json'), JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: 'local', config: { api: { baseUrl: 'http://127.0.0.1:8787/ap/v1' } } },
            { providerId: 'remote', config: { api: { baseUrl: 'https://example.test/v1' } } },
          ],
        },
      },
    }));
    const raw = JSON.parse(readFileSync(join(seed, 'provider_config.json'), 'utf8'));
    assert.equal(raw.config.providerConfigRules.providerRules.length, 2);
    assert.equal(selectedProviderBaseUrl(seed, 'local'), 'http://127.0.0.1:8787/ap/v1');
    assert.equal(selectedProviderBaseUrl(seed, 'remote'), 'https://example.test/v1');
    assert.equal(selectedProviderBaseUrl(seed, 'missing'), undefined);
    assert.equal(selectedProviderBaseUrl(join(root, 'missing'), 'local'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
