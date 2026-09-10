// Invocation success, request fulfillment, and command exit are separate facts.
export function classifyToolOutcome(item, shellExitCode = null) {
  const output = String(item?.output ?? '');
  if (item?.status === 'skipped') return 'skipped';
  if (item?.status === 'failed' || /^Error\b/.test(output)) return 'tool-failure';
  if (item?.name === 'load_tool') {
    let value;
    try { value = JSON.parse(output); } catch { /* Native summaries are text. */ }
    if (value?.error) return 'tool-failure';
    if (value?.missing?.length || value?.blocked?.length
      || /^(?:missing|blocked):\s*\S/im.test(output)) return 'unfulfilled';
  }
  if (item?.name === 'shell') {
    const marker = output.match(/^\[exit code:\s*(-?\d+)\]/);
    const exit = shellExitCode ?? (marker ? Number(marker[1]) : null);
    if (exit !== null && exit !== 0) return 'command-failure';
  }
  return 'ok';
}
