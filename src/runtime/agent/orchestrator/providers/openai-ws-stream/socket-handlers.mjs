import { performance } from 'node:perf_hooks';
import { _parseEvent } from '../openai-ws-events.mjs';
import {
  annotateWsClose,
  chainSocketError,
  frameTooLargeError,
  serverErrorEventError,
  wsClosedError,
} from '../openai-ws-terminal.mjs';
import { markSessionTransportActivity } from '../../session/manager/runtime-liveness.mjs';
import { _captureTurnStateFromEvent, _traceWsHeaderKeys } from './turn-state-headers.mjs';

const WS_TRACE_ENABLED = process.env.MIXDOG_WS_TRACE === '1';

function _incomingFrameByteLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) {
    let total = 0;
    for (const chunk of data) {
      const size = Number(chunk?.byteLength ?? chunk?.length);
      if (!Number.isFinite(size) || size < 0) return null;
      total += size;
    }
    return total;
  }
  const size = Number(data?.byteLength ?? data?.length);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function _writeWsLifecycleTrace(lifecycle) {
  process.stderr.write(`[ws-trace] t=${new Date().toISOString()} lifecycle=${lifecycle}\n`);
}

function _traceFrame(event, text) {
  const type = typeof event.type === 'string' ? event.type : '';
  const empty = type.endsWith('.delta') && (event.delta == null || event.delta === '');
  process.stderr.write(
    `[ws-trace] t=${new Date().toISOString()} type=${type} bytes=${Buffer.byteLength(text)} empty=${empty}\n`
  );
}

// Socket-level handlers for one stream: frame size guard + parse + dispatch,
// close/error/abort → terminal error, liveness pings. attach() returns false
// when the external signal was already aborted (the stream settled at once).
export function createSocketHandlers({
  socket,
  entry,
  externalSignal,
  midState,
  response,
  errLabel,
  maxIncomingFrameBytes,
  watchdogs,
  traceProvider,
  onEvent,
  outcome,
  finish,
}) {
  const closeSocket = (code, reason) => {
    try {
      socket.close(code, reason);
    } catch {}
  };

  function onMessage(data) {
    // Defense in depth: the pool also applies this bound as `maxPayload`
    // before assembly, but injected sockets and test seams reach here first.
    const frameBytes = _incomingFrameByteLength(data);
    if (maxIncomingFrameBytes > 0 && frameBytes != null && frameBytes > maxIncomingFrameBytes) {
      outcome.terminalError = frameTooLargeError(errLabel, frameBytes, maxIncomingFrameBytes);
      midState.wsFrameTooLarge = true;
      closeSocket(1009, 'frame_too_large');
      finish();
      return;
    }
    if (midState.sendSpan && midState.sendStartedAt != null && midState.sendSpanAttemptFirstEvent !== true) {
      midState.sendSpanAttemptFirstEvent = true;
      midState.sendSpan.firstEventMs += performance.now() - midState.sendStartedAt;
    }
    // EVERY received frame — response.created, metadata, rate_limits, and all
    // deltas — keeps the socket alive. Separately, onStreamDelta is NOT called
    // for every frame: metadata/keepalive frames must not reset the agent
    // stall watchdog's lastStreamDeltaAt. Only meaningful output (text delta /
    // tool call) updates that timestamp.
    watchdogs.resetIdle();
    const text = typeof data === 'string' ? data : data.toString('utf-8');
    const event = _parseEvent(text);
    if (!event) return;
    if (WS_TRACE_ENABLED) _traceFrame(event, text);
    markSessionTransportActivity(midState.sessionId);
    _traceWsHeaderKeys(entry, event, midState, traceProvider, response.model);
    _captureTurnStateFromEvent(entry, event);
    if (event.error) {
      outcome.terminalError = serverErrorEventError(event.error, event);
      finish();
      return;
    }
    if (typeof event.type !== 'string') return;
    onEvent(event);
  }

  function onClose(code, reason) {
    if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('close');
    if (outcome.done) return;
    midState.wsCloseCode = code;
    const reasonText = reason?.toString?.('utf-8') || '';
    if (!outcome.terminalError) outcome.terminalError = wsClosedError(code, reasonText);
    else annotateWsClose(outcome.terminalError, code, reasonText);
    finish();
  }

  function onError(err) {
    if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('error');
    if (outcome.done) return;
    const wrapped = err instanceof Error ? err : new Error(String(err));
    // `ws` rejects an over-limit fragmented message before assembly with this
    // typed code. Preserve the same retry classification as the complete-frame
    // check above.
    if (wrapped.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
      try {
        wrapped.wsFrameTooLarge = true;
        wrapped.retryable = true;
        midState.wsFrameTooLarge = true;
      } catch {}
    }
    if (outcome.terminalError) chainSocketError(outcome.terminalError, wrapped);
    else outcome.terminalError = wrapped;
    closeSocket(4001, 'stream_error');
    finish();
  }

  // Was this a user/caller abort, or a watchdog abort? Mid-stream retry must
  // skip user aborts but may retry watchdog aborts. The caller-owned
  // AbortController surfaces through externalSignal; the agent stall watchdog
  // signals via a reason whose name === 'AgentStallAbortError',
  // stream-watchdog via StreamStalledAbortError. Anything else → user.
  function onAbort() {
    if (outcome.done) return;
    const reason = externalSignal.reason;
    outcome.terminalError = reason instanceof Error ? reason : new Error('OpenAI OAuth WS aborted by session close');
    const reasonName = reason?.name || '';
    if (reasonName === 'AgentStallAbortError' || reasonName === 'StreamStalledAbortError') {
      midState.watchdogAbort = reasonName;
    } else {
      midState.userAbort = true;
    }
    closeSocket(4002, 'aborted');
    finish();
  }

  const onPing = () => {
    markSessionTransportActivity(midState.sessionId);
    if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('ping');
  };
  const onPong = () => {
    markSessionTransportActivity(midState.sessionId);
    if (WS_TRACE_ENABLED) _writeWsLifecycleTrace('pong');
  };
  const onOpen = () => _writeWsLifecycleTrace('open');

  function detach() {
    socket.off('message', onMessage);
    socket.off('close', onClose);
    socket.off('error', onError);
    socket.off('open', onOpen);
    socket.off('ping', onPing);
    socket.off('pong', onPong);
    externalSignal?.removeEventListener('abort', onAbort);
  }

  function attach() {
    if (externalSignal) {
      if (externalSignal.aborted) {
        onAbort();
        return false;
      }
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onError);
    socket.on('ping', onPing);
    socket.on('pong', onPong);
    if (WS_TRACE_ENABLED) {
      socket.on('open', onOpen);
      if (socket.readyState === WebSocket.OPEN) _writeWsLifecycleTrace('open');
    }
    return true;
  }

  return { attach, detach };
}
