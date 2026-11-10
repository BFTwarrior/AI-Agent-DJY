/**
 * True when the panel is not inside an MCP Apps host iframe.
 *
 * A browser tab opened directly on the panel has `window.parent === window`,
 * so there is no host to answer `callServerTool`; the panel must not attempt
 * `app.connect` and instead explains how to open it from ZCode. Pure function
 * so the branch is unit-testable without a DOM.
 *
 * @param {any} win a `window`-like object (or null)
 * @returns {boolean}
 */
export function isStandalone(win) {
  if (!win) return true;
  const parent = win.parent;
  if (!parent) return true;
  return parent === win;
}
