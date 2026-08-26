import { parentPort } from 'node:worker_threads';
import { frameAndParseSse } from './lib/sse-framing.mjs';

if (!parentPort) throw new Error('provider stream JSON worker requires parentPort');

parentPort.on('message', (message) => {
    const id = Number(message?.id);
    if (message?.kind === 'sse') {
        // Whole-chunk SSE work: line framing AND per-record JSON parsing run
        // here, so the owner event loop only receives the ordered event list.
        try {
            const framed = frameAndParseSse(String(message.text || ''), String(message.event || ''));
            parentPort.postMessage({
                id,
                ok: true,
                kind: 'sse',
                events: framed.events,
                event: framed.currentEvent,
            });
        } catch (error) {
            parentPort.postMessage({
                id,
                ok: false,
                kind: 'sse',
                error: {
                    name: String(error?.name || 'Error'),
                    message: String(error?.message || error || 'sse framing failed'),
                },
            });
        }
        return;
    }
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
