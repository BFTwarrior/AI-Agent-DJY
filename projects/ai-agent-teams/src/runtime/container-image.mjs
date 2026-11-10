import { spawnSync } from 'node:child_process';
import { CONTAINER_IMAGE_PULL_POLICIES } from '../domain/container-image-policy.mjs';
import { containerInspectError, isMissingContainerImageError } from './container-image-errors.mjs';

/**
 * Optionally pull the configured worker image before the CLI self-test.
 * Pull failures are fatal; a stale local image is never used as a fallback.
 * @param {{ runtime?: 'docker'|'podman', command?: string, image?: string, pullPolicy?: 'never'|'if-missing'|'always', runner?: Function }} input
 * @returns {{ ready: boolean, runtime?: string, command?: string, image?: string, pulled?: boolean, skipped?: boolean, reason?: string }}
 */
export function prepareContainerImage({
  runtime = 'docker',
  command,
  image,
  pullPolicy = 'never',
  runner = spawnSync,
} = {}) {
  if (!image) return { ready: false, reason: 'isolation.image is required' };
  if (!CONTAINER_IMAGE_PULL_POLICIES.includes(pullPolicy)) {
    return { ready: false, runtime, image, reason: `unsupported image pull policy: ${String(pullPolicy)}` };
  }
  if (pullPolicy === 'never') return { ready: true, runtime, image, pulled: false, skipped: true };

  const bin = command ?? runtime;
  if (pullPolicy === 'if-missing') {
    const inspect = runner(bin, ['image', 'inspect', image], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    if (inspect.status === 0) return { ready: true, runtime, command: bin, image, pulled: false };
    if (!isMissingContainerImageError(`${inspect.stderr ?? ''}\n${inspect.stdout ?? ''}`)) {
      return {
        ready: false,
        runtime,
        command: bin,
        image,
        pulled: false,
        reason: containerInspectError(runtime, image, inspect),
      };
    }
  }

  const pull = runner(bin, ['pull', image], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600000,
  });
  if (pull.status !== 0) {
    return {
      ready: false,
      runtime,
      command: bin,
      image,
      pulled: false,
      reason: `${runtime} failed to pull the configured worker image under the ${pullPolicy} policy`,
    };
  }
  return { ready: true, runtime, command: bin, image, pulled: true };
}
