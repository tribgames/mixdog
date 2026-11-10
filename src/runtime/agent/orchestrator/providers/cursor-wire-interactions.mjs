const REJECT_REASON = 'This Cursor-side interaction is unavailable. Use the Mixdog tools instead.';

function response(name, value) {
  return {
    handled: true,
    action: `${name}_rejected`,
    message: { interactionResponse: value },
  };
}

const rejected = () => ({ rejected: { reason: REJECT_REASON } });

// [query field, action name, response field, rejection payload], in match priority order.
const REJECTED_QUERIES = [
  ['webSearchRequestQuery', 'web_search', 'webSearchRequestResponse', rejected],
  ['exaSearchRequestQuery', 'exa_search', 'exaSearchRequestResponse', rejected],
  ['exaFetchRequestQuery', 'exa_fetch', 'exaFetchRequestResponse', rejected],
  ['switchModeRequestQuery', 'switch_mode', 'switchModeRequestResponse', rejected],
  ['askQuestionInteractionQuery', 'ask_question', 'askQuestionInteractionResponse', () => ({ result: rejected() })],
  [
    'createPlanRequestQuery',
    'create_plan',
    'createPlanRequestResponse',
    () => ({ result: { error: { error: REJECT_REASON } } }),
  ],
];

export function buildCursorInteractionResponse(query = {}) {
  const id = Number(query.id) || 0;
  for (const [queryField, name, responseField, payload] of REJECTED_QUERIES) {
    if (query[queryField]) return response(name, { id, [responseField]: payload() });
  }
  if (query.setupVmEnvironmentArgs) {
    return {
      handled: true,
      action: 'setup_vm_acknowledged',
      message: { interactionResponse: { id, setupVmEnvironmentResult: { success: {} } } },
    };
  }
  if (query.$unknown?.some((field) => field.no === 9)) {
    return response('web_fetch', { id, webFetchRequestResponse: rejected() });
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
