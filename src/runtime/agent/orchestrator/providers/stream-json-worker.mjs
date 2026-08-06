import { parentPort } from 'node:worker_threads';

if (!parentPort) throw new Error('provider stream JSON worker requires parentPort');

parentPort.on('message', (message) => {
    const id = Number(message?.id);
    const payloads = Array.isArray(message?.payloads) ? message.payloads : [];
    try {
        const values = payloads.map((payload) => JSON.parse(String(payload)));
        parentPort.postMessage({ id, ok: true, values });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            error: {
                name: String(error?.name || 'SyntaxError'),
                message: String(error?.message || error || 'invalid JSON'),
            },
        });
    }
});
