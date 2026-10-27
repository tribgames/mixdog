// Whether the representative bot (Mixy) exists: the one rule. The desktop
// answers from it (getLeadStatus `exists`, main/mixy-first.ts), and so do
// Mixy's routines (routine-owner.mjs `no-mixy`), her heartbeat and the
// heartbeat reports queued for her chat (mixy-heartbeat.mjs,
// agent-home-delivery.mjs), all through routine-owner.mjs readMixyExists.
//
// `created: false` (Mixy's agent.json) is no. Otherwise she exists on
// evidence that the user made or uses her:
//   - a name (the 대표 에이전트 dialog always sets one; her profile can);
//   - a message the user wrote in her thread (`homeChatted`,
//     agent-kind.mjs homeThreadEvidence);
//   - a schedule or webhook she owns (`ownsRoutines`): the user set it up,
//     and since v1.3.0 it ran for her whether or not she was named.
// Without any of them she does not exist: v1.3.0's untouched automatic
// `{"created": true}`, and an undecided profile (`created` null). Her own
// posts in her thread, heartbeat reports and routine results, are no
// evidence. `ownsRoutines` is read only when nothing else decides.
export async function mixyExists(status, ownsRoutines) {
  if (status?.created === false) return false;
  if (String(status?.name ?? '').trim() || status?.homeChatted === true) return true;
  return (await ownsRoutines()) === true;
}
