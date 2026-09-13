// One loopback listener owns each bind attempt, its event handlers, and stop.
export function createLoopbackListener({
  server,
  basePort = 0,
  maxPort = basePort,
  onListening: reportListening,
  onError: reportError,
}) {
  let current = null
  let closing = null

  function start() {
    if (closing) return Promise.reject(new Error('HTTP listener is stopping'))
    if (current) return current.promise

    let resolve
    let reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const controller = new AbortController()
    const attempt = { promise, reject, controller, port: basePort, bound: false, detach }
    current = attempt

    function detach() {
      server.off('listening', onListening)
      server.off('error', onError)
    }

    function onListening() {
      if (current !== attempt) return
      const boundPort = server.address().port
      attempt.bound = true
      reportListening(boundPort)
      resolve(boundPort)
    }

    function listen() {
      try {
        server.listen({ port: attempt.port, host: '127.0.0.1', signal: controller.signal })
      } catch (error) {
        onError(error)
      }
    }

    function onError(error) {
      if (current !== attempt) return
      if (attempt.bound) {
        reportError(error, false)
        return
      }
      if (error.code === 'EADDRINUSE' && attempt.port !== 0) {
        // Preserve the fixed-port range, then ask the OS for one free port.
        attempt.port = attempt.port < maxPort ? attempt.port + 1 : 0
        listen()
        return
      }
      reportError(error, true)
      current = null
      detach()
      reject(error)
    }

    server.on('error', onError)
    server.once('listening', onListening)
    listen()
    return promise
  }

  function stop() {
    if (closing) return closing
    const attempt = current
    if (!attempt) return Promise.resolve()
    current = null
    attempt.reject(new Error('HTTP listener stopped'))
    // Abort also cancels a pending bind; close() alone can run before listening.
    attempt.controller.abort()
    closing = new Promise((resolve) => {
      const done = () => { attempt.detach(); resolve() }
      try { server.close(done) } catch { done() }
    }).finally(() => { closing = null })
    return closing
  }

  return { start, stop }
}
