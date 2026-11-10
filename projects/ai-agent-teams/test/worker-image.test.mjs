import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(new URL('../deploy/worker.Dockerfile', import.meta.url), 'utf8');

test('worker image configures a pinned upstream Linux ZCode CLI build', () => {
  assert.match(dockerfile, /^FROM node:24\.14\.0-bookworm-slim AS zcode-build$/m);
  assert.match(dockerfile, /WORKDIR \/src/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends git ca-certificates tar xz-utils/);
  assert.match(dockerfile, /git fetch --depth 1 origin a9fe401eede6e6e5e01be9048679c206fe6f02d9/);
  assert.ok(dockerfile.includes('RUN pnpm install --frozen-lockfile'));
  assert.match(dockerfile, /pnpm --dir apps\/zcode-cli build:sea/);
  assert.match(dockerfile, /SEA_TARGET=linux-x64/);
  assert.match(dockerfile, /SEA_TARGET=linux-arm64/);
  assert.match(dockerfile, /dpkg --print-architecture/);
  assert.match(dockerfile, /install -D -m 0755 "apps\/zcode-cli\/packages\/cli\/dist\/zcode-\$SEA_TARGET" \/out\/zcode/);
  assert.match(dockerfile, /COPY --from=zcode-build --chmod=0755 \/out\/zcode \/usr\/local\/bin\/zcode/);
  assert.match(dockerfile, /THIRD-PARTY-NOTICES\.md/);
  assert.match(dockerfile, /Unsupported worker architecture/);
});

test('worker image verifies the CLI as the non-root user and has no entrypoint override', () => {
  assert.match(dockerfile, /useradd --uid 10001 --create-home --shell \/bin\/bash zcode/);
  assert.match(dockerfile, /USER zcode\s+RUN zcode --version/m);
  assert.doesNotMatch(dockerfile, /^ENTRYPOINT\s/m);
});
