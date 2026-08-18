import cron from 'node-cron';

export function validateScheduleCron(value) {
  const expression = String(value || '').trim();
  const fields = expression.split(/\s+/).filter(Boolean);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error(`invalid cron expression "${expression}": expected 5 or 6 fields`);
  }
  if (!cron.validate(expression)) {
    throw new Error(`invalid cron expression "${expression}"`);
  }
  return expression;
}

export function resolveScheduleTimezone(value) {
  const timezone = String(
    value || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  ).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid schedule timezone "${timezone}"`);
  }
  return timezone;
}
