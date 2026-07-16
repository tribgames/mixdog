const [webSocketUrl, projectPath] = process.argv.slice(2);
if (!webSocketUrl || !projectPath) {
  throw new Error('Usage: node scripts/cdp-smoke.mjs <webSocketUrl> <projectPath>');
}

const socket = new WebSocket(webSocketUrl);
const response = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP smoke timed out')), 60_000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(async () => {
        const timing = {};
        const api = window.mixdogDesktop;
        if (!api) throw new Error('preload bridge missing');
        const methods = ['startProject', 'getSnapshot', 'submit', 'resolveToolApproval', 'dispose'];
        if (!methods.every((name) => typeof api[name] === 'function')) {
          throw new Error('preload bridge incomplete');
        }
        let startedAt = performance.now();
        const started = await api.startProject(${JSON.stringify(projectPath)});
        timing.projectMs = performance.now() - startedAt;
        startedAt = performance.now();
        const submitted = await api.submit('/help');
        timing.chatMs = performance.now() - startedAt;
        await new Promise((done) => setTimeout(done, 250));
        const snapshot = await api.getSnapshot();
        startedAt = performance.now();
        const approvalRoutingResult = await api.resolveToolApproval(
          '__packaging_smoke__',
          { approved: false, reason: 'acceptance-smoke' },
        );
        timing.approvalRoutingMs = performance.now() - startedAt;
        await api.dispose();
        return {
          bridge: true,
          projectStarted: started !== null,
          chatSubmitted: submitted,
          snapshotAvailable: snapshot !== null,
          approvalRoutingResult,
          timing,
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    },
  })));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.result?.exceptionDetails) {
      reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
    } else {
      resolve(message.result.result.value);
    }
  });
  socket.addEventListener('error', () => reject(new Error('CDP websocket failed')));
});

socket.close();
console.log(JSON.stringify(response));
