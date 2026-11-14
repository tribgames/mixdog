/** User control is unmeasured, never a passing or retryable scenario result. */
export function isScenarioUserControl(code: unknown): boolean {
  return (
    code === 'user_input_active' ||
    code === 'computer_user_control_active' ||
    code === 'computer_user_intervention_pending'
  );
}

/** Which check refused, from the reply alone: the readback after the native
 *  call carries its verdict as `input_recovery`; a refusal raised during the
 *  native call carries none, and one the core's user-control gate
 *  (`computer/userControl`) raised before dispatch carries a different code. */
export function userControlDetail(reply: Record<string, unknown>): string {
  const recovery = reply.input_recovery as Record<string, unknown> | undefined;
  const where = recovery
    ? `the readback after the native call: ${JSON.stringify(recovery)}`
    : reply.code === 'user_input_active'
      ? 'a check during the native call'
      : 'the core user-control gate';
  return `${String(reply.code)} from ${where}${reply.message ? `; ${String(reply.message)}` : ''}`;
}
