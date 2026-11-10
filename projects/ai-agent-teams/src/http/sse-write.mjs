/**
 * Drop a slow SSE client instead of allowing its socket buffer to grow without bound.
 * @param {import('node:http').ServerResponse} res
 * @param {string} chunk
 * @returns {boolean} true when the chunk was accepted
 */
export function writeSse(res, chunk) {
  if (!res || res.destroyed || res.writableEnded) return false;
  try {
    if (res.write(chunk) === false) {
      try { res.destroy?.(); } catch { /* already gone */ }
      return false;
    }
    return true;
  } catch {
    try { res.destroy?.(); } catch { /* already gone */ }
    return false;
  }
}
