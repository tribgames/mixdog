import { FETCH_BLOCKED_PORTS, FETCH_SAFE_ATTEMPTS } from './fetch-safe-listen.mjs';

// One loopback listener owns each bind attempt, its event handlers, and stop.
export function createLoopbackListener({
  server,
  basePort = 0,
  maxPort = basePort,
  onListening: reportListening,
  onError: reportError,
}) {
  let current = null;
  let closing = null;

  // close() drops only the keep-alive sockets idle at that moment; one whose
  // in-flight response ends later would hold the close for the server's whole
  // keepAliveTimeout (~5 s). Drop each as its response settles while stopping.
  server.on('request', (_req, res) => {
    res.once('close', () => {
      if (closing) server.closeIdleConnections();
    });
  });

  function start() {
    if (closing) return Promise.reject(new Error('HTTP listener is stopping'));
    if (current) return current.promise;

    const { promise, resolve, reject } = Promise.withResolvers();
    const controller = new AbortController();
    const attempt = {
      promise,
      reject,
      controller,
      port: basePort,
      bound: false,
      blockedRetries: FETCH_SAFE_ATTEMPTS,
      detach,
    };
    current = attempt;

    function detach() {
      server.off('listening', onListening);
      server.off('error', onError);
    }

    function onListening() {
      if (current !== attempt) return;
      const boundPort = server.address().port;
      // An OS-assigned port can be one fetch clients refuse ("bad port"):
      // close it and take another, a bounded number of times.
      if (attempt.port === 0 && FETCH_BLOCKED_PORTS.has(boundPort)) {
        const exhausted = attempt.blockedRetries <= 0;
        attempt.blockedRetries -= 1;
        server.close(() => {
          if (current !== attempt) return;
          if (exhausted) onError(new Error('no fetch-safe loopback port was assigned'));
          else listen();
        });
        return;
      }
      server.off('listening', onListening);
      attempt.bound = true;
      reportListening(boundPort);
      resolve(boundPort);
    }

    function listen() {
      try {
        server.listen({ port: attempt.port, host: '127.0.0.1', signal: controller.signal });
      } catch (error) {
        onError(error);
      }
    }

    function onError(error) {
      if (current !== attempt) return;
      if (attempt.bound) {
        reportError(error, false);
        return;
      }
      if (error.code === 'EADDRINUSE' && attempt.port !== 0) {
        // Preserve the fixed-port range, then ask the OS for one free port.
        attempt.port = attempt.port < maxPort ? attempt.port + 1 : 0;
        listen();
        return;
      }
      reportError(error, true);
      current = null;
      detach();
      reject(error);
    }

    server.on('error', onError);
    server.on('listening', onListening);
    listen();
    return promise;
  }

  function stop() {
    if (closing) return closing;
    const attempt = current;
    if (!attempt) return Promise.resolve();
    current = null;
    attempt.reject(new Error('HTTP listener stopped'));
    // Abort also cancels a pending bind; close() alone can run before listening.
    attempt.controller.abort();
    closing = new Promise((resolve) => {
      const done = () => {
        attempt.detach();
        resolve();
      };
      try {
        server.close(done);
      } catch {
        done();
      }
    }).finally(() => {
      closing = null;
    });
    return closing;
  }

  return { start, stop };
}
