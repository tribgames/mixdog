type RecordValue = Record<string, unknown>;

/** `prioritizeQueued`'s answer: Node's `{ count, ids, priority }`, or the core's `turn/steer` answer
 *  `{ accepted: true, queuedId }`. */
export function wasPrioritized(value: RecordValue | undefined): boolean {
  return Boolean(value) && (value?.accepted === true || Number(value?.count) >= 1);
}
