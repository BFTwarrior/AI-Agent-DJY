/**
 * Undici's `fetch` refuses a fixed set of "bad ports" from the Fetch standard.
 * Windows can hand those ports out from its dynamic range (this host uses
 * 1024-15000), so `app.listen(0)` occasionally returns a port that every
 * `fetch()` in a test rejects with `TypeError: fetch failed` / `bad port`.
 *
 * Retrying the ephemeral bind keeps the assertion surface unchanged: the test
 * still talks HTTP to the real app, just on a port fetch accepts.
 */
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/**
 * @param {{ listen: (port?: number) => Promise<number>, close: () => Promise<void> }} app
 * @param {number} [attempts]
 * @returns {Promise<number>}
 */
export async function listenForFetch(app, attempts = 8) {
  let lastPort;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastPort = await app.listen(0);
    if (!BAD_PORTS.has(lastPort)) return lastPort;
    await app.close();
  }
  throw new Error(`the OS kept assigning fetch-blocked ports (last: ${lastPort})`);
}
