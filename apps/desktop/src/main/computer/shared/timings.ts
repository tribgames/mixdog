/** Numeric-only timing boundary shared by replies and persisted diagnostics. */
export function computerTimings(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries([
    'total_ms', 'execution_ms', 'steps_ms', 'delivery_ms', 'before_windows_ms',
    'after_windows_ms', 'settle_ms', 'post_capture_ms', 'recovery_ms',
    'target_resolution_ms', 'accessibility_ms', 'screenshot_ms', 'ocr_ms',
    'backend_ms', 'backend_roundtrip_ms', 'settle_credit_ms',
  ].flatMap((key) => {
    const duration = source[key];
    return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
      ? [[key, duration]] : [];
  }));
}

/** At most six executed steps; never copy input, errors, or skipped timings. */
export function computerStepTimings(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((row, index) => {
    if (!row || typeof row !== 'object'
      || !['succeeded', 'failed'].includes(row.status)) return [];
    return [{
      index: index + 1,
      status: row.status,
      timings_ms: computerTimings(row.timings_ms),
    }];
  });
}
