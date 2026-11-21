export function parsePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Positive-integer pid that `process.kill(pid, 0)` can address; EPERM (another user's process) counts as alive. */
export function isPidAlive(value) {
  const pid = parsePid(value);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Destructive operations require proof of death, not merely a failed probe. */
export function isPidAliveOrUnknown(value) {
  const pid = parsePid(value);
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}
