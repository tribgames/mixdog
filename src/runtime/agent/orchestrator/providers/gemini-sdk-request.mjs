/**
 * One SDK (`@google/generative-ai`) streaming attempt and the request
 * controller lifetime around it: the parent-abort link that lives for the
 * FULL stream, the connect-phase first-byte timer that is dropped once bytes
 * arrive, and the text-leak guard both transports build from the same turn
 * inputs. Frame consumption itself stays in gemini-stream.mjs.
 */
import {
  GEMINI_FIRST_BYTE_TIMEOUT_MS,
  geminiTimeoutError,
  createGeminiTextLeakGuard,
  consumeGeminiSdkStream,
  stampGeminiRpcError,
} from './gemini-stream.mjs';

export function geminiTextLeakGuardFor({ tools, callbacks }) {
  return createGeminiTextLeakGuard({
    knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
    onTextDelta: callbacks.onTextDelta,
    onToolCall: callbacks.onToolCall,
    onStreamDelta: callbacks.onStreamDelta,
  });
}

// Mirrors the REST branch's signal lifetime: the request controller stays
// linked to the parent (attemptSignal) for the FULL stream — connect AND
// body — so a parent / client / gateway abort after first byte still
// cancels the underlying SDK request (the SSE idle watchdog is off by
// default). The first-byte timer only bounds the connect phase and is
// cleared once the stream starts, so it can never kill a live,
// still-producing stream.
function linkSdkRequestController(attemptSignal) {
  const controller = new AbortController();
  let parentAbortListener = null;
  let firstByteTimer = null;
  const detachParent = () => {
    if (parentAbortListener && attemptSignal) {
      try {
        attemptSignal.removeEventListener('abort', parentAbortListener);
      } catch {}
      parentAbortListener = null;
    }
  };
  const clearConnectTimer = () => {
    if (firstByteTimer) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
  };
  if (attemptSignal) {
    if (attemptSignal.aborted) {
      try {
        controller.abort(attemptSignal.reason);
      } catch {}
    } else {
      parentAbortListener = () => {
        try {
          controller.abort(attemptSignal.reason);
        } catch {}
      };
      attemptSignal.addEventListener('abort', parentAbortListener, { once: true });
    }
  }
  firstByteTimer = setTimeout(() => {
    try {
      controller.abort(geminiTimeoutError('Gemini SDK first byte', GEMINI_FIRST_BYTE_TIMEOUT_MS));
    } catch {}
  }, GEMINI_FIRST_BYTE_TIMEOUT_MS);
  if (firstByteTimer.unref) firstByteTimer.unref();
  return { controller, detachParent, clearConnectTimer };
}

export async function streamGeminiSdkAttempt(genModel, stream, attemptSignal) {
  const { contents, callbacks } = stream;
  const link = linkSdkRequestController(attemptSignal);
  const { controller } = link;
  try {
    let streamResult;
    try {
      streamResult = await genModel.generateContentStream({ contents }, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : err;
      }
      throw stampGeminiRpcError(err);
    }
    // First byte / headers received: drop the connect-phase timer but KEEP
    // the parent link attached so a later abort during streaming still
    // reaches the request.
    link.clearConnectTimer();
    const textLeakGuard = geminiTextLeakGuardFor(stream);
    const response = await consumeGeminiSdkStream(streamResult, {
      signal: attemptSignal,
      onStreamDelta: callbacks.onStreamDelta,
      onTextDelta: callbacks.onTextDelta,
      textLeakGuard,
      label: 'Gemini SDK streamGenerateContent',
      cancelGeneration: (reason) => {
        if (!controller.signal.aborted) controller.abort(reason);
      },
    });
    return { response, textLeakGuard };
  } finally {
    link.clearConnectTimer();
    link.detachParent();
  }
}
