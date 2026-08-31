const REJECT_REASON = 'This Cursor-side interaction is unavailable. Use the Mixdog tools instead.';

function response(name, value) {
    return {
        handled: true,
        action: `${name}_rejected`,
        message: { interactionResponse: value },
    };
}

export function buildCursorInteractionResponse(query = {}) {
    const id = Number(query.id) || 0;
    if (query.webSearchRequestQuery) {
        return response('web_search', {
            id,
            webSearchRequestResponse: { rejected: { reason: REJECT_REASON } },
        });
    }
    if (query.exaSearchRequestQuery) {
        return response('exa_search', {
            id,
            exaSearchRequestResponse: { rejected: { reason: REJECT_REASON } },
        });
    }
    if (query.exaFetchRequestQuery) {
        return response('exa_fetch', {
            id,
            exaFetchRequestResponse: { rejected: { reason: REJECT_REASON } },
        });
    }
    if (query.switchModeRequestQuery) {
        return response('switch_mode', {
            id,
            switchModeRequestResponse: { rejected: { reason: REJECT_REASON } },
        });
    }
    if (query.askQuestionInteractionQuery) {
        return response('ask_question', {
            id,
            askQuestionInteractionResponse: { result: { rejected: { reason: REJECT_REASON } } },
        });
    }
    if (query.createPlanRequestQuery) {
        return response('create_plan', {
            id,
            createPlanRequestResponse: { result: { error: { error: REJECT_REASON } } },
        });
    }
    if (query.setupVmEnvironmentArgs) {
        return {
            handled: true,
            action: 'setup_vm_acknowledged',
            message: { interactionResponse: { id, setupVmEnvironmentResult: { success: {} } } },
        };
    }
    if (query.$unknown?.some((field) => field.no === 9)) {
        return response('web_fetch', {
            id,
            webFetchRequestResponse: { rejected: { reason: REJECT_REASON } },
        });
    }
    const field = query.$unknown?.[0]?.no;
    return {
        handled: false,
        action: 'unsupported',
        queryCase: field ? `field_${field}` : 'unknown',
        message: null,
    };
}

export function buildCursorExecThrow(exec = {}, detail = 'Unsupported Cursor exec') {
    return {
        execClientControlMessage: {
            throw: {
                id: Number(exec.id) || 0,
                error: `${detail}. Use a Mixdog tool instead.`,
            },
        },
    };
}
