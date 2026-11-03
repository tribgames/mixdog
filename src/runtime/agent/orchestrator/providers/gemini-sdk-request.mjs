/**
 * The text-leak guard every Gemini-shaped REST transport builds from the same
 * turn inputs. (The module name predates the removal of the legacy SDK; the
 * Vertex and OpenCode Go engines import the guard from here.)
 */
import { createGeminiTextLeakGuard } from './gemini-stream.mjs';

export function geminiTextLeakGuardFor({ tools, callbacks }) {
  return createGeminiTextLeakGuard({
    knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
    onTextDelta: callbacks.onTextDelta,
    onToolCall: callbacks.onToolCall,
    onStreamDelta: callbacks.onStreamDelta,
    deferToolCalls: true,
  });
}
