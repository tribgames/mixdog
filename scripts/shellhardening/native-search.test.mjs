import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventEmitter,
  resolve,
  delay,
  _bindNativeSearchServerLifecycle,
  _ackNativeSearchCancellationForTest,
  _requestNativeForTest,
  _softDeadlineMsForTest,
  _runReadOnlyIoWithDeadlineForTest,
} from './_shared.mjs';


test('resident native search consumes asynchronous stdin EPIPE', () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    let observed = null;
    _bindNativeSearchServerLifecycle(child, {
        onError: (error) => { observed = error; },
        onExit: () => {},
    });
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    child.stdin.emit('error', error);
    assert.equal(observed, error);
});

test('native search request timeout cancels only that request', async () => {
    const writes = [];
    let killed = false;
    // Transport-shaped stub: the client speaks the JSONL protocol and never
    // learns whether an addon or a child process is attached.
    const transport = {
        write: (line) => { writes.push(String(line)); },
        kill: () => { killed = true; },
        ref: () => {},
        unref: () => {},
    };
    const server = {
        transport,
        pending: new Map(),
        sequence: 1,
        stderrTail: '',
    };
    const keepAlive = setTimeout(() => {}, 50);
    try {
        await assert.rejects(
            _requestNativeForTest(
                server,
                { id: 1, cwd: '.', fuzzy: 'needle', limit: 5 },
                {},
                5,
            ),
            (error) => error?.code === 'NATIVE_SEARCH_TIMEOUT'
                && /complete file inventory/.test(error.message),
        );
    } finally {
        clearTimeout(keepAlive);
    }
    assert.equal(killed, false);
    assert.equal(server.pending.size, 0);
    assert.equal(writes.some((line) => /"cancel":1/.test(line)), true);
});

test('native search cancellation acknowledgement disarms forced recycle', async () => {
    const previous = process.env.MIXDOG_SEARCH_CANCEL_GRACE_MS;
    process.env.MIXDOG_SEARCH_CANCEL_GRACE_MS = '10';
    let killed = false;
    const transport = {
        write: () => {},
        kill: () => { killed = true; },
        ref: () => {},
        unref: () => {},
    };
    const server = {
        transport,
        pending: new Map(),
        cancelWatchdogs: new Map(),
        sequence: 1,
        stderrTail: '',
    };
    const keepAlive = setTimeout(() => {}, 50);
    try {
        await assert.rejects(
            _requestNativeForTest(
                server,
                { id: 1, cwd: '.', args: ['--files', '.'], limit: 5 },
                {},
                2,
            ),
            (error) => error?.code === 'NATIVE_SEARCH_TIMEOUT',
        );
        assert.equal(server.cancelWatchdogs.has(1), true);
        _ackNativeSearchCancellationForTest(server, 1);
        await delay(20);
        assert.equal(killed, false);
    } finally {
        clearTimeout(keepAlive);
        if (previous === undefined) delete process.env.MIXDOG_SEARCH_CANCEL_GRACE_MS;
        else process.env.MIXDOG_SEARCH_CANCEL_GRACE_MS = previous;
    }
});

test('native search soft deadline reserves response-processing grace', () => {
    assert.equal(_softDeadlineMsForTest(20_000), 18_500);
    assert.equal(_softDeadlineMsForTest(10_000), 9_250);
    assert.equal(_softDeadlineMsForTest(100), 1);
});

test('read-only I/O deadline returns non-empty cancellation partials with a warning', async () => {
    const previous = process.env.MIXDOG_IO_TOOL_TIMEOUT_MS;
    process.env.MIXDOG_IO_TOOL_TIMEOUT_MS = '5';
    let aborted = false;
    try {
        const result = await _runReadOnlyIoWithDeadlineForTest(
            'grep',
            null,
            (signal) => new Promise((resolve) => {
                signal.addEventListener('abort', () => {
                    aborted = true;
                    resolve('cancelled');
                }, { once: true });
            }),
        );
        assert.match(result, /^cancelled\n\[warning\].*PARTIAL results shown/);
        assert.equal(aborted, true);
    } finally {
        if (previous === undefined) delete process.env.MIXDOG_IO_TOOL_TIMEOUT_MS;
        else process.env.MIXDOG_IO_TOOL_TIMEOUT_MS = previous;
    }
});

test('read-only I/O deadline still rejects when cancellation yields no partial', async () => {
    const previous = process.env.MIXDOG_IO_TOOL_TIMEOUT_MS;
    process.env.MIXDOG_IO_TOOL_TIMEOUT_MS = '5';
    try {
        await assert.rejects(
            _runReadOnlyIoWithDeadlineForTest('grep', null, (signal) => new Promise((resolve) => {
                signal.addEventListener('abort', () => resolve(''), { once: true });
            })),
            (error) => error?.code === 'READ_ONLY_IO_TIMEOUT',
        );
    } finally {
        if (previous === undefined) delete process.env.MIXDOG_IO_TOOL_TIMEOUT_MS;
        else process.env.MIXDOG_IO_TOOL_TIMEOUT_MS = previous;
    }
});
