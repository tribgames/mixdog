/**
 * src/tui/session/live-share/wire.mjs - newline-delimited JSON framing shared
 * by the owner pipe server and the viewer client.
 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function frameLine(frame) {
  return `${JSON.stringify(frame)}\n`;
}

export function destroyQuietly(socket) {
  try {
    socket.destroy();
  } catch {
    /* already gone */
  }
}

export function attachLineReader(socket, onFrame, onOverflow) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      buffer = '';
      onOverflow?.();
      return;
    }
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame = null;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame && typeof frame === 'object') onFrame(frame);
    }
  });
}
