export const IMPLICIT_APPROVAL_MODE = 'implicit';
export const IMPLICIT_APPROVAL_CONTEXT =
    'Non-interactive execution: treat the initial user request as the approved plan and proceed without requesting approval.';

export function workflowContextForApprovalMode(workflowContext, approvalMode) {
    if (approvalMode !== IMPLICIT_APPROVAL_MODE) return workflowContext || null;
    const workflow = typeof workflowContext === 'string' ? workflowContext.trim() : '';
    return [workflow, IMPLICIT_APPROVAL_CONTEXT].filter(Boolean).join('\n\n');
}
