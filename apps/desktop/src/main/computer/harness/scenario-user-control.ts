/** User control is unmeasured, never a passing or retryable scenario result. */
export function isScenarioUserControl(code: unknown): boolean {
  return (
    code === 'user_input_active' ||
    code === 'computer_user_control_active' ||
    code === 'computer_user_intervention_pending'
  );
}

/** Which check refused, from the reply alone: the host's readback after the
 *  native call carries its verdict as `input_recovery`; a refusal raised
 *  during the native call carries none. */
export function userControlDetail(reply: Record<string, unknown>): string {
  const recovery = reply.input_recovery as Record<string, unknown> | undefined;
  let where = 'the host coordinator';
  if (recovery) where = `the host's readback after the native call: ${JSON.stringify(recovery)}`;
  else if (reply.code === 'user_input_active') where = 'a check during the native call';
  return `${String(reply.code)} from ${where}${reply.message ? `; ${String(reply.message)}` : ''}`;
}
