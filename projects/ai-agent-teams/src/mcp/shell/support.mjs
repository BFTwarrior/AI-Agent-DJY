export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function runtimeError(id, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message } };
}

export function errorResponse(message, text) {
  const id = message?.id ?? null;
  if (message?.method === 'tools/call') {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32603, message: text } };
}
