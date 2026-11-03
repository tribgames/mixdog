/** Desktop event (service → window and paired devices): a turn review may read
 *  differently now (a tool or command boundary stamped a worktree, or a
 *  capture such as the turn's end changed what it shows). Open reviews read
 *  again; the payload carries nothing. */
export const TURN_REVIEW_CHANGED_EVENT = 'turn-review-changed';
