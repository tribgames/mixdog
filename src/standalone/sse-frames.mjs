// Parsing the daemon's server-sent event streams (channel notifies, session
// frames): feed text chunks, get each parsed `data:` payload. `: ka` keepalive
// comments and unparsable payloads are skipped.
export function createSseFrameParser(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        let msg = null;
        try {
          msg = JSON.parse(json);
        } catch {
          continue;
        }
        onMessage(msg);
      }
      idx = buf.indexOf('\n\n');
    }
  };
}
