import { writeSse } from './sse-write.mjs';

export function createSseRegistry({ maxTeamStreams, maxUiStreams, sendError }) {
  const streams = new Map();
  const uiStreams = new Set();

  function broadcast(event) {
    const clients = streams.get(event.teamId);
    if (clients) {
      for (const client of [...clients]) {
        if (!writeSse(client, `event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`)) clients.delete(client);
      }
      if (clients.size === 0) streams.delete(event.teamId);
    }
    for (const client of [...uiStreams]) {
      if (!writeSse(client, 'event: refresh\ndata: {"type":"refresh"}\n\n')) uiStreams.delete(client);
    }
  }

  function openUiStream(req, res) {
    if (uiStreams.size >= maxUiStreams) {
      sendError(res, 429, 'E_TOO_MANY_STREAMS', `UI stream limit reached (${maxUiStreams})`);
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const timer = setInterval(() => {
      if (!writeSse(res, ': ping\n\n')) clearInterval(timer);
    }, 15000);
    const dispose = () => {
      clearInterval(timer);
      uiStreams.delete(res);
    };
    uiStreams.add(res);
    req.on('close', dispose);
    if (!writeSse(res, ': connected\n\n')) dispose();
    return true;
  }

  function openTeamStream(teamId, req, res) {
    const current = streams.get(teamId);
    if (current && current.size >= maxTeamStreams) {
      sendError(res, 429, 'E_TOO_MANY_STREAMS', `team stream limit reached (${maxTeamStreams})`);
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    if (!streams.has(teamId)) streams.set(teamId, new Set());
    const clients = streams.get(teamId);
    const timer = setInterval(() => {
      if (!writeSse(res, ': ping\n\n')) clearInterval(timer);
    }, 15000);
    const dispose = () => {
      clearInterval(timer);
      clients.delete(res);
      if (clients.size === 0 && streams.get(teamId) === clients) streams.delete(teamId);
    };
    clients.add(res);
    req.on('close', dispose);
    if (!writeSse(res, ': connected\n\n')) dispose();
    return true;
  }

  return { broadcast, openUiStream, openTeamStream };
}
