/**
 * The structured twin of a `visualize` result (the tool result's `toolMeta`,
 * kept with the stored message and restored onto its transcript item): the
 * desktop host ran the call for another session's work (a sub-agent, a room
 * member) and keeps its tabs in that owner conversation's panel. Chat cards
 * read the owner from here, never from the result text.
 */
export const VISUALIZE_OWNER_META_CODE = 'visualize_owner';

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A session id fit for `toolMeta.ownerSessionId`; '' for anything else. */
export function visualizeOwnerMetaSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : '';
}

/** The `toolMeta` of a result run for `ownerSessionId`'s panel; undefined when
 *  the id is not a session id. */
export function visualizeOwnerToolMeta(ownerSessionId) {
  const id = visualizeOwnerMetaSessionId(ownerSessionId);
  return id ? { code: VISUALIZE_OWNER_META_CODE, missing: [], ownerSessionId: id } : undefined;
}
