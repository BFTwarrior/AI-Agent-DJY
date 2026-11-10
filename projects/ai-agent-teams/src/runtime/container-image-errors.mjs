const MISSING_IMAGE_PATTERNS = [
  /^\s*(?:Error response from daemon:\s*)?No such image:\s*\S+\s*$/im,
  /^\s*(?:Error:\s*)?unable to inspect\s+["']?[^"'\s]+["']?:\s*failed to find image\s+[^\r\n]+:\s*image not known\s*$/im,
  /^\s*(?:Error:\s*)?unable to find image\s+["']?[^"'\s]+["']?\s*$/im,
];

export function isMissingContainerImageError(output) {
  return MISSING_IMAGE_PATTERNS.some((pattern) => pattern.test(String(output ?? '')));
}

export function containerInspectError(runtime, image, result) {
  const output = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`.trim();
  if (isMissingContainerImageError(output)) return `worker image not found: ${image}`;
  const detail = result?.error?.message || output || `exit code ${String(result?.status)}`;
  return `${runtime} image inspect failed: ${detail.slice(0, 500)}`;
}
