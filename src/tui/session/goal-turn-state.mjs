// A steering handoff cancels a turn, not its durable Goal. Record the explicit
// abort path against its turn epoch instead of guessing intent from error text.
export function abortGoalTurn(runtime, flags, hasPendingSteering) {
  const previous = flags.goalSteeringAbortEpoch;
  const epoch = flags.leadTurnEpoch;
  flags.goalSteeringAbortEpoch = hasPendingSteering ? epoch : null;
  try {
    const result = runtime.abort(hasPendingSteering ? 'interrupt' : 'user-cancel');
    if (result === false) flags.goalSteeringAbortEpoch = previous;
    return result;
  } catch (error) {
    flags.goalSteeringAbortEpoch = previous;
    throw error;
  }
}

export function preserveGoalStateAfterTurn({
  cancelled = false,
  stale = false,
  pendingSessionReset = false,
  disposed = false,
  interruptedForSteering = false,
} = {}) {
  return cancelled === true
    && (stale === true || pendingSessionReset === true || disposed === true || interruptedForSteering === true);
}
