// Replaying one relayed request against the LOCAL webhook HTTP server and
// answering the relay with the response (or the failure) over the leg.
import * as http from 'node:http';
import { LOCAL_TIMEOUT_MS, MAX_TUNNEL_BODY_BYTES } from './limits.mjs';

export function respondOverLeg(ws, id, status, headers, bodyBuffer) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(
      JSON.stringify({
        type: 'http-response',
        id,
        status,
        headers: headers || {},
        body: bodyBuffer?.length ? bodyBuffer.toString('base64') : '',
      })
    );
  } catch {
    /* relay vanished; it times the request out */
  }
}

export function respondJsonError(ws, id, status, error) {
  respondOverLeg(
    ws,
    id,
    status,
    { 'content-type': 'application/json' },
    Buffer.from(JSON.stringify({ error: String(error?.message || error) }))
  );
}

function collectLocalResponse(ws, frame, response) {
  const chunks = [];
  let total = 0;
  let overflow = false;
  response.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_TUNNEL_BODY_BYTES) {
      overflow = true;
      response.destroy(new Error('local webhook response exceeds limit'));
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => {
    if (overflow) return;
    respondOverLeg(
      ws,
      frame.id,
      response.statusCode || 502,
      { 'content-type': response.headers['content-type'] || 'application/json' },
      Buffer.concat(chunks)
    );
  });
  response.on('error', () => respondOverLeg(ws, frame.id, 502, {}, null));
}

export function forwardFrameToLocal(frame, ws, getLocalPort) {
  const port = getLocalPort();
  if (!port) {
    respondOverLeg(
      ws,
      frame.id,
      503,
      { 'content-type': 'application/json' },
      Buffer.from('{"error":"webhook server not listening"}')
    );
    return;
  }
  let request;
  try {
    request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        timeout: LOCAL_TIMEOUT_MS,
      },
      (response) => collectLocalResponse(ws, frame, response)
    );
  } catch (err) {
    respondJsonError(ws, frame.id, 400, err);
    return;
  }
  request.on('timeout', () => request.destroy(new Error('local webhook timeout')));
  request.on('error', (err) => respondJsonError(ws, frame.id, 502, err));
  if (frame.body?.length) request.write(frame.body);
  request.end();
}
