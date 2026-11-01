/**
 * Every routine (schedule and webhook) one bot owns, deleted as its bot is
 * deleted. One statement over both stores, keyed by the rows' current owner:
 * it removes all of them with their run state (on the rows) and the webhooks'
 * delivery logs, or — failing — none; a row moved to another bot is never
 * matched.
 */
import { openSchedulesDb } from './schedules-db.mjs';
import { openWebhooksDb } from './webhooks-db.mjs';

/** Resolves `{ schedules, webhooks }`: the names removed. */
export async function deleteRoutinesOwnedBy(ownerAgentId, { dataDir } = {}) {
  if (typeof ownerAgentId !== 'string' || !ownerAgentId) throw new Error('deleteRoutinesOwnedBy: an owner is required');
  // Both stores' tables exist before the one statement names them.
  const [db] = await Promise.all([openSchedulesDb({ dataDir }), openWebhooksDb({ dataDir })]);
  const { rows } = await db.query(
    `WITH schedules AS (
       DELETE FROM scheduler.schedules WHERE owner_agent_id = $1 RETURNING name
     ), endpoints AS (
       DELETE FROM webhooks.endpoints WHERE owner_agent_id = $1 RETURNING name
     ), deliveries AS (
       DELETE FROM webhooks.deliveries WHERE endpoint IN (SELECT name FROM endpoints)
     )
     SELECT 'schedule' AS kind, name FROM schedules
     UNION ALL
     SELECT 'webhook' AS kind, name FROM endpoints`,
    [ownerAgentId]
  );
  const names = (kind) =>
    rows
      .filter((row) => row.kind === kind)
      .map((row) => row.name)
      .sort();
  return { schedules: names('schedule'), webhooks: names('webhook') };
}
