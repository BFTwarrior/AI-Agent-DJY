/**
 * Normalize a provider retry hint into milliseconds.
 * Accepts common millisecond/second field names and HTTP-date strings.
 *
 * @param {unknown} error
 * @returns {number | undefined}
 */
export function retryAfterMsFrom(error) {
  const source = error && typeof error === 'object' ? error : {};
  const direct = Number(source.retryAfterMs ?? source.retry_after_ms);
  if (Number.isFinite(direct) && direct > 0) return Math.trunc(direct);
  const seconds = Number(source.retryAfterSeconds ?? source.retry_after_seconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.trunc(seconds * 1000);
  const raw = source.retryAfter ?? source.retry_after;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw * 1000);
  if (typeof raw === 'string' && raw.trim()) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return Math.trunc(numeric * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}
