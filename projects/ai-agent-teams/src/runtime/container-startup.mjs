import { containerSelfTest, detectContainerHostAddress, ensureContainerRuntime } from './container.mjs';
import { prepareContainerImage } from './container-image.mjs';

/** @typedef {{ available: true, runtime: 'docker'|'podman', command: string, version?: string, machineStarted?: boolean } | { available: false, runtime?: 'docker'|'podman', command?: string, machineStarted?: boolean, engineUnavailable?: boolean, engineError?: string, machineStartError?: string }} ContainerRuntimeResult */
/** @typedef {{ ready: true, runtime: 'docker'|'podman', command: string, image: string, pulled?: boolean, skipped?: boolean } | { ready: false, runtime?: 'docker'|'podman', command?: string, image?: string, pulled?: boolean, reason: string }} ContainerImagePreparationResult */
/** @typedef {{ ready: true, runtime: 'docker'|'podman', command: string, image: string, version?: string } | { ready: false, runtime?: 'docker'|'podman', command?: string, image?: string, reason: string }} ContainerSelfTestResult */
/** @typedef {{ cwd: string, repoRoot?: string, runtime: 'docker'|'podman', image: string, pullPolicy?: import('../domain/container-image-policy.mjs').ContainerImagePullPolicy, cliPath?: string, hostAddress?: string, platform?: string, ensureRuntime?: (runtime: 'docker'|'podman') => ContainerRuntimeResult, prepareImage?: (input: { runtime: 'docker'|'podman', command?: string, image: string, pullPolicy?: import('../domain/container-image-policy.mjs').ContainerImagePullPolicy }) => ContainerImagePreparationResult, detectHostAddress?: (options: { strict: boolean }) => string|undefined, selfTest?: (input: { runtime: 'docker'|'podman', command?: string, image: string, cliPath?: string }) => ContainerSelfTestResult }} PrepareContainerWorkerInput */
/** @typedef {{ ready: true, detectedRuntime: ContainerRuntimeResult, containerHost?: string, pulled: boolean } | { ready: false, stage: 'workspace'|'runtime'|'image'|'self-test', reason: string, detectedRuntime?: ContainerRuntimeResult, containerHost?: string }} PrepareContainerWorkerResult */

/**
 * Validate and prepare a container worker before daemon startup proceeds.
 * @param {PrepareContainerWorkerInput} input
 * @returns {PrepareContainerWorkerResult}
 */
export function prepareContainerWorker({
  cwd,
  repoRoot,
  runtime,
  image,
  pullPolicy,
  cliPath,
  hostAddress,
  platform = process.platform,
  ensureRuntime = ensureContainerRuntime,
  prepareImage = prepareContainerImage,
  detectHostAddress = detectContainerHostAddress,
  selfTest = containerSelfTest,
} = {}) {
  if (!repoRoot) {
    return {
      ready: false,
      stage: 'workspace',
      reason: `isolation.mode=container requires a git workspace, but ${cwd ?? 'the configured workspace'} is not inside a git worktree.`,
    };
  }

  const detectedRuntime = ensureRuntime(runtime);
  if (!detectedRuntime.available) {
    const detail = detectedRuntime.machineStartError ?? detectedRuntime.engineError;
    return {
      ready: false,
      stage: 'runtime',
      detectedRuntime,
      reason: `isolation.mode=container requires ${runtime}, but it is not available${detail ? `: ${detail}` : ''}. Run "node src/install-wizard.mjs --install-hard --execute" or install it manually.`,
    };
  }

  const imagePreparation = prepareImage({
    runtime: detectedRuntime.runtime,
    command: detectedRuntime.command,
    image,
    pullPolicy,
  });
  if (!imagePreparation.ready) {
    return {
      ready: false,
      stage: 'image',
      detectedRuntime,
      reason: imagePreparation.reason,
    };
  }

  const containerHost = hostAddress ?? detectHostAddress({ strict: platform === 'win32' });
  const result = selfTest({
    runtime: detectedRuntime.runtime,
    command: detectedRuntime.command,
    image,
    cliPath,
  });
  if (!result.ready) {
    return {
      ready: false,
      stage: 'self-test',
      detectedRuntime,
      containerHost,
      reason: result.reason,
    };
  }

  return {
    ready: true,
    detectedRuntime,
    containerHost,
    pulled: imagePreparation.pulled === true,
  };
}
