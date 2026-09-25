// Primitive fields are immutable; object fields still need their complete
// projection checked so in-place provider replay/tool-call edits stay visible.
const absent = Object.freeze({ value: undefined, snapshot: '\0[]' });
const empty = Object.freeze({ value: null, snapshot: '\0[]' });
const FINGERPRINT_FIELDS = Object.freeze([
  'content',
  'toolCalls',
  'thinkingBlocks',
  'assistantBlocks',
  'reasoningItems',
  'providerMetadata',
  'providerReplay',
]);

export function createContextFingerprinter({ nativeBlocksEstimateText, contentImageDescriptors }) {
  function valueFingerprint(value, previous) {
    if (value === undefined) return absent;
    if (value === null) return empty;
    if (previous && typeof value !== 'object' && previous.value === value) return previous;
    const snapshot =
      typeof value === 'string'
        ? value
        : `${nativeBlocksEstimateText(value)}\0${JSON.stringify(contentImageDescriptors(value))}`;
    return previous && previous.value === value && previous.snapshot === snapshot ? previous : { value, snapshot };
  }

  function contextMessageFingerprint(message, previous) {
    const value = message && typeof message === 'object' ? message : null;
    const role = value?.role;
    const content = valueFingerprint(value ? value.content : '', previous?.content);
    const toolCalls = valueFingerprint(value ? value.toolCalls : null, previous?.toolCalls);
    const thinkingBlocks = valueFingerprint(value ? value.thinkingBlocks : null, previous?.thinkingBlocks);
    const assistantBlocks = valueFingerprint(value ? value.assistantBlocks : null, previous?.assistantBlocks);
    const reasoningItems = valueFingerprint(value ? value.reasoningItems : null, previous?.reasoningItems);
    const providerMetadata = valueFingerprint(value ? value.providerMetadata : null, previous?.providerMetadata);
    const providerReplay = valueFingerprint(value ? value.providerReplay : null, previous?.providerReplay);
    const toolCallId = value?.toolCallId || null;
    if (
      previous &&
      previous.role === role &&
      previous.content === content &&
      previous.toolCalls === toolCalls &&
      previous.thinkingBlocks === thinkingBlocks &&
      previous.assistantBlocks === assistantBlocks &&
      previous.reasoningItems === reasoningItems &&
      previous.providerMetadata === providerMetadata &&
      previous.providerReplay === providerReplay &&
      previous.toolCallId === toolCallId
    )
      return previous;
    return {
      role,
      content,
      toolCalls,
      thinkingBlocks,
      assistantBlocks,
      reasoningItems,
      providerMetadata,
      providerReplay,
      toolCallId,
    };
  }

  function sameValue(a, b) {
    return a === b || (!!a && !!b && a.value === b.value && a.snapshot === b.snapshot);
  }
  function sameContextMessageFingerprint(a, b) {
    return (
      a === b ||
      (!!a &&
        a.role === b.role &&
        sameValue(a.content, b.content) &&
        sameValue(a.toolCalls, b.toolCalls) &&
        sameValue(a.thinkingBlocks, b.thinkingBlocks) &&
        sameValue(a.assistantBlocks, b.assistantBlocks) &&
        sameValue(a.reasoningItems, b.reasoningItems) &&
        sameValue(a.providerMetadata, b.providerMetadata) &&
        sameValue(a.providerReplay, b.providerReplay) &&
        a.toolCallId === b.toolCallId)
    );
  }
  // Reference-only check against a message's last full fingerprint: true when
  // every estimator-visible field still holds the value that was measured.
  // It does not look inside object values; callers reserve it for settled
  // transcript entries, whose nested payloads are replaced, never mutated.
  function contextMessageFieldsUnchanged(message, fingerprint) {
    if (
      !fingerprint ||
      !message ||
      typeof message !== 'object' ||
      message.role !== fingerprint.role ||
      (message.toolCallId || null) !== fingerprint.toolCallId
    ) {
      return false;
    }
    // Indexed loop: this runs per settled message on every sync, and a
    // callback allocated a closure each time.
    for (let i = 0; i < FINGERPRINT_FIELDS.length; i += 1) {
      const field = FINGERPRINT_FIELDS[i];
      if (message[field] !== fingerprint[field].value) return false;
    }
    return true;
  }
  return { contextMessageFingerprint, sameContextMessageFingerprint, contextMessageFieldsUnchanged };
}
