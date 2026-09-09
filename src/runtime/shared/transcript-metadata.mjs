// Transcript route identity is separate from the human-readable model label.
// These pure helpers keep live rows, persisted messages and restored rows on
// the same field contract without rewriting older display-only transcripts.
import { displayModelName } from '../../ui/model-display.mjs';

export function transcriptRouteMetadataFields(value) {
  if (!value || typeof value !== 'object') return {};
  return {
    ...(typeof value.modelId === 'string' && value.modelId ? { modelId: value.modelId } : {}),
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
    ...(typeof value.agent === 'string' && value.agent ? { agent: value.agent } : {}),
  };
}

export function createTranscriptRouteMetadata(session, route = {}, at = Date.now()) {
  const provider = String(session?.provider || route.provider || '').trim();
  const modelId = String(session?.model || route.model || '').trim();
  const model = displayModelName(modelId, provider);
  const agent = String(route.workflow?.name || route.workflow?.id || '').trim();
  return { at, ...transcriptRouteMetadataFields({ modelId, model, provider, agent }) };
}

export function persistedUserTranscriptMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...(Number.isFinite(Number(value.at)) ? { at: Number(value.at) } : {}),
    ...transcriptRouteMetadataFields(value),
    ...(typeof value.sender === 'string' && value.sender ? { sender: value.sender } : {}),
  };
}

export function persistedAssistantTranscriptMetadata(value, fallbackAt = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const candidateAt = Number(value.assistantAt);
  const assistantAt = Number.isFinite(candidateAt) && candidateAt > 0 ? candidateAt : fallbackAt;
  value.assistantAt = assistantAt;
  return { at: assistantAt, ...transcriptRouteMetadataFields(value) };
}
