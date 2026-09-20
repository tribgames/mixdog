// Scheduled-slot admission: claim the coalesced queue slot for a cycle and, on
// a successful claim, arm its scheduled task.
export function createScheduledEnqueue({
  getDb,
  getConfig,
  claimAndMarkScheduledCycle,
  scheduledCycle1Signature,
  scheduledCycle2Signature,
  scheduleScheduledCycle1,
  scheduleScheduledCycle2,
}) {
  function periodicCycle1Config() {
    return {
      min_batch: 20,
      session_cap: 4,
      batch_size: 50,
      max_packets: 4,
      concurrency: 4,
      ...(getConfig()?.cycle1 || {}),
    };
  }

  async function claimScheduledSlot(kind, intervalMs, signature, config = {}) {
    const timeoutMs = Math.max(0, Number(config?.timeout) || 600_000);
    const claimLeaseMs = Math.min(intervalMs, Math.max(60_000, timeoutMs + 60_000));
    const claim = await claimAndMarkScheduledCycle(getDb(), kind, intervalMs, signature, {
      reason: 'scheduled',
      spacingMs: claimLeaseMs,
    });
    return claim.claimed === true;
  }

  async function enqueueScheduledCycle1(intervalMs) {
    const config = periodicCycle1Config();
    const signature = scheduledCycle1Signature(config);
    if (await claimScheduledSlot('cycle1', intervalMs, signature, config)) {
      scheduleScheduledCycle1(config, signature);
    }
  }

  async function enqueueScheduledCycle2(intervalMs) {
    const config = getConfig()?.cycle2 || {};
    const signature = scheduledCycle2Signature(config);
    if (await claimScheduledSlot('cycle2', intervalMs, signature, config)) {
      scheduleScheduledCycle2(config, signature);
    }
  }

  return { periodicCycle1Config, enqueueScheduledCycle1, enqueueScheduledCycle2 };
}
