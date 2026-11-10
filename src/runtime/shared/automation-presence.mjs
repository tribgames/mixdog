// Automation presence: any enabled schedule that has not finished, or any
// enabled webhook endpoint. The channel worker boots only while one exists,
// so this is also what tells a stopped worker apart from an idle one.
export function hasEnabledAutomation({ schedules = [], webhooks = [] } = {}) {
  return (
    schedules.some((entry) => entry?.enabled !== false && entry?.status !== 'done') ||
    webhooks.some((entry) => entry?.enabled !== false)
  );
}
