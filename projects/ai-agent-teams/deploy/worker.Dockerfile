# Build the ZCode CLI from a pinned upstream source commit.
FROM node:24.14.0-bookworm-slim AS zcode-build

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tar xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@10.33.2

WORKDIR /src
RUN git init \
 && git remote add origin https://github.com/zai-org/ZCode.git \
 && git fetch --depth 1 origin a9fe401eede6e6e5e01be9048679c206fe6f02d9 \
 && git checkout --detach a9fe401eede6e6e5e01be9048679c206fe6f02d9

RUN pnpm install --frozen-lockfile \
 && case "$(dpkg --print-architecture)" in \
      amd64) SEA_TARGET=linux-x64 ;; \
      arm64) SEA_TARGET=linux-arm64 ;; \
      *) echo "Unsupported worker architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && pnpm --dir apps/zcode-cli build:sea \
 && install -D -m 0755 "apps/zcode-cli/packages/cli/dist/zcode-$SEA_TARGET" /out/zcode \
 && install -D -m 0644 apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md /out/THIRD-PARTY-NOTICES.md

# Keep the runtime image lean while providing the worker's required tools.
FROM node:24.14.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home --shell /bin/bash zcode

COPY --from=zcode-build --chmod=0755 /out/zcode /usr/local/bin/zcode
COPY --from=zcode-build /out/THIRD-PARTY-NOTICES.md /usr/share/doc/zcode/THIRD-PARTY-NOTICES.md

# Mount points:
#   /workspace  -> one task worktree
#   /home/zcode -> per-member persistent home volume
# Keep the image entrypoint unset; the runtime supplies the worker command.
WORKDIR /workspace
USER zcode
RUN zcode --version
