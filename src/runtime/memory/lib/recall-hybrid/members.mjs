/**
 * src/runtime/memory/lib/recall-hybrid/members.mjs - attach member turns to
 * the root rows of the final page.
 */
import { recallReadQuery } from '../memory-recall-read-query.mjs';

/** Expands only the final page, not every candidate considered. */
export async function attachMembers(db, page, matchedMembersByRoot) {
  const rootIds = page.filter((row) => row.is_root === 1).map((row) => Number(row.id));
  if (rootIds.length === 0) return;
  const { rows: memberRows } = await recallReadQuery(
    db,
    `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, project_id, chunk_root
         FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
         ORDER BY ts ASC, id ASC`,
    [rootIds]
  );
  const membersByRoot = new Map();
  for (const member of memberRows) {
    const id = Number(member.chunk_root);
    if (!membersByRoot.has(id)) membersByRoot.set(id, []);
    membersByRoot.get(id).push(member);
  }
  for (const row of page) {
    if (row.is_root !== 1) continue;
    const allMembers = membersByRoot.get(Number(row.id)) ?? [];
    const matched = matchedMembersByRoot.get(Number(row.id));
    // Preserve complete matched turns, without flooding a member hit with
    // unrelated siblings. Root hits keep their full original expansion.
    const kept = matched?.size ? allMembers.filter((member) => matched.has(Number(member.id))) : [];
    row.members = kept.length > 0 ? kept : allMembers;
  }
}
