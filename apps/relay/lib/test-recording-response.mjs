// Recording HTTP response double shared by the relay unit tests: every
// writeHead/end pair lands in `recorded` for assertions.
export function recordingResponse() {
  const recorded = [];
  return {
    recorded,
    writeHead(status, headers) {
      recorded.push({ status, headers });
      return this;
    },
    end(body) {
      recorded.at(-1).body = body;
    },
  };
}
