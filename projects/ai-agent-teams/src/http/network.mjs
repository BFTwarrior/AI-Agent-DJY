/**
 * Accept only loopback peer addresses when exposing local process metadata or UI access.
 * @param {string|undefined} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (!address) return false;
  return address === '::1' || /^127\./.test(address) || address === '::ffff:127.0.0.1';
}
