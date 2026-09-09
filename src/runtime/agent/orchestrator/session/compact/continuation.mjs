import {
    isProtectedContextAckMessage,
    latestActualUserInstructionIndex,
} from './messages.mjs';

export const ACTIVE_TURN_CONTINUATION_SOURCE = 'compact-active-turn-continuation';
export const ACTIVE_TURN_CONTINUATION_ANCHOR = '<active-turn-continuation>';

function isExistingContinuation(message) {
    return message?.role === 'user'
        && (
            String(message?.meta?.source || '') === ACTIVE_TURN_CONTINUATION_SOURCE
            || (
                typeof message.content === 'string'
                && message.content.includes(ACTIVE_TURN_CONTINUATION_ANCHOR)
            )
        );
}

function isExecutionActivity(message) {
    if (message?.role === 'tool') return true;
    return message?.role === 'assistant' && !isProtectedContextAckMessage(message);
}

function makeActiveTurnContinuationMessage() {
    return {
        role: 'user',
        content: [
            '<system-reminder>',
            ACTIVE_TURN_CONTINUATION_ANCHOR,
            'The latest real user request was already in progress when Compact ran.',
            'The handoff and retained execution records above describe progress so far. A plan is not evidence that a tool succeeded; use the recorded outcomes.',
            'Continue from that state without repeating progress messages or completed tool calls.',
            'Use tools only for incomplete or failed work, or to recover missing evidence from an execution archive.',
            '</active-turn-continuation>',
            '</system-reminder>',
        ].join('\n'),
        meta: {
            source: ACTIVE_TURN_CONTINUATION_SOURCE,
            synthetic: true,
        },
    };
}

export function activeTurnContinuationMessage(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const latestUserIndex = latestActualUserInstructionIndex(list);
    if (latestUserIndex < 0) return null;
    const afterLatestUser = list.slice(latestUserIndex + 1);
    if (!afterLatestUser.some(isExistingContinuation)
        && !afterLatestUser.some(isExecutionActivity)) {
        return null;
    }
    return makeActiveTurnContinuationMessage();
}
