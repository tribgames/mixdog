import { isGeminiFamilyModel } from './gemini-family.mjs';

const SYNTHETIC_TOOL_SIGNATURE = 'skip_thought_signature_validator';

// Gemini models that validate thought signatures check the first functionCall
// in every step of the current turn. Foreign/interrupted histories may not have
// a native signature for that call. Preserve real signatures and unsigned
// siblings of a signed parallel batch. The validator-bypass token is a Gemini
// wire token: it is only fabricated for the Gemini family, because the other
// families an Antigravity gateway serves reject it.
export function ensureGeminiToolCallSignatures(contents, model) {
  if (!isGeminiFamilyModel(model)) return contents;
  let activeTurnStart = 0;
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index];
    if (
      content?.role === 'user' &&
      content.parts?.some((part) => part && !part.functionResponse) &&
      !content.parts?.some((part) => part?.functionResponse)
    ) {
      activeTurnStart = index;
      break;
    }
  }
  return contents.map((content, index) => {
    if (index < activeTurnStart || content?.role !== 'model' || !Array.isArray(content.parts)) return content;
    const callIndex = content.parts.findIndex((part) => part?.functionCall);
    if (callIndex < 0) return content;
    const firstCall = content.parts[callIndex];
    if (
      [firstCall.thoughtSignature, firstCall.thought_signature].some(
        (signature) => typeof signature === 'string' && signature.length > 0
      )
    )
      return content;
    const parts = content.parts.slice();
    parts[callIndex] = { ...firstCall, thoughtSignature: SYNTHETIC_TOOL_SIGNATURE };
    return { ...content, parts };
  });
}
