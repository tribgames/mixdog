//! Replay of Node's K1 recordings `fixtures/hook-ask-grants-cases` and `fixtures/session-grants-cases`
//! (`record-hook-ask-grants-cases.mjs`, `record-session-grants-cases.mjs`, b6f10295a): one interpreter for the recorded logs.
//!
//! Each step drives the product's entry: a `decide` runs the call through [`ToolPolicy::authorize`] as a turn does (the recorded
//! PreToolUse hook, the session's facts and settings from [`SessionGate`], the tool's own `outbound_kind`, the session's grants in
//! the process registry [`SessionGrantRegistry`]) until it shows the client a card in the client's [`ApprovalBook`] or ends; the
//! verdict it acted on is read through the development-only `policy-observer`, and a call it let run is rendered from the call it
//! passed on. A `choose` or `answer` is a client's response to that card, sent as recorded (with the recorded gate) through
//! [`ApprovalBook::validate`] and resolved into the waiting pipeline, which audits it and stores its grant; a card no longer
//! pending is the call asked again. The grants, audit and permission views are [`FileGrantStore`] and [`AgentPermissions`]
//! on a real directory. Every wait has a deadline. The store's clock is the recording's held `Date.now`; a session grant has no clock (it has no time limit),
//! so a recorded advance does nothing. A card is what a client is shown for the
//! request ([`tool_approval`] of the approval book's request), compared on the fields `humanRequestFields` defines.
//!
//! A decision is the core's verdict written as Node's `{ decision, request, gate, remembered }`: the decision as the
//! hooks left it (an answered `ask` runs as `allow`, or `modify` when the hook rewrote the call), the request the card
//! presents and the audit identity its answer is recorded under.
//!
//! A recorded `answer` carries the gate Node's `recordHumanDecision(gate, approval)` was called with. Node's gate is the
//! server's, never a client's, and so is the core's ([`GateAudit`] of the pipeline's ask). Where the recorded gate is not the
//! one the decided call showed (forged by the recorder), the replay hands it to the pipeline in place of its own ask's
//! (development-only `policy-observer`: the audit identity and the scopes the card offers), re-asks the call and sends the
//! recorded approval through the client's book: the pipeline's own `record_decision` then answers under the forged gate.
//! The forged answers:
//!
//! | case (steps) | forged in the answer | Node's outcome | the replay's assertion |
//! |---|---|---|---|
//! | H6 (1, 2, 5, 6) | `gate.action` `"tool:mcp__stripe__create_payment"` / `"tool:mcp__drive__delete_permanently"` (the shown gate has none) and `gate.remember` `["once","session","always"]` (shown: none); answered `remember` `session`, then `always` | nothing honoured: the decides of steps 3, 7, 9 (after a stored `always` grant) and 11, 12 (Allow all actions) still ask with `["once"]`; no grants or audit step recorded | the forged gate reaches `record_decision` (the card offers its scopes); steps 3, 7, 9, 11, 12 compared whole in `hook_ask_6_…` |
//! | H8 (4) | `gate.remember` `["once","session","always"]` (shown: `["once"]`); answered `remember` `session` while the Lead session is a schedule run | no session grant: step 7 (after the run ends and the life resets) asks with `["once","session","always"]` | not exercisable: a granted run never shows a card (`ToolPolicy::ask`, run branch), so no client answer exists to carry the gate, in the core as in Node's product. `answer` asserts the response reaches no card (`Ok(None)`); step 7 compared whole in `hook_ask_8_…` |
//! | S5 (7) | `gate.remember` `["once","session"]` (shown: `["once","agent"]`); answered `remember` `session` while the home session is a schedule run | no session grant: step 9 (after the run ends) asks with `["once","session","agent"]` | not exercisable, for H8's reason; `answer` asserts no card was answered; step 9 compared whole in `session_5_…` |
//! | S6 (1, 2, 5, 6) | `gate.remember` `["once","session","agent"]` (shown: `["once"]`), then `undefined` (Node offers every scope, `gate.mjs:383`); answered `remember` `session`, then `agent`, for a payment and a permanent delete | no grant: `grants` at step 8 is `[]`; steps 3, 7, 10, 11 ask with `["once"]` | the forged gate reaches `record_decision`; step 8's grants and the decides compared whole in `session_6_…` |

std::thread_local! {
    /// The case being replayed, for a failure the comparison does not report (a test's runtime is one thread).
    static CASE: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}
