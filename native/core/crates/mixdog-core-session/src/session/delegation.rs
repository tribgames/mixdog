//! The bot chain a session acts in and the delegation a sub-agent works under, as Node keeps them.
//!
//! - The turn state (`runtime/shared/bot-hops.mjs`): `turnHop` and `turnBotChain` are stamped on
//!   the session when a turn is prepared from its submission (`stampTurnHop`, called by
//!   `ask-turn-execute.mjs:171`), raised when a bot's message is steered into the running turn
//!   (`raiseTurnHop`, `loop/steering.mjs:145`), and read by `delegationChainOf`
//!   (`session-runtime/bot-chain.mjs:21`) and the send tools. They live on the in-memory session
//!   and are never persisted; here they are the [`TurnState`] of the session's control cell.
//! - The `delegation` record (`human-gate/delegation.mjs`): `{ rootSessionId, via, path }`, written
//!   to the new session's record at creation (`session-record.mjs:114`, [`delegation_for_new_session`])
//!   and re-bound, with the `run` stamp, when another session sends it work
//!   ([`rebind_patch`], `rebindDelegation`, delegation.mjs:196). The record is the session header,
//!   so the stored fields are `delegation` and `run`.

use std::collections::HashSet;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::{agent_id_of_home_session, room_member_of_session};
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_run::run_host::route_chain::resolve_session_mode;
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use super::run_stamps::{Records, run_stamp_of};

/// `MAX_PATH` and `MAX_SUBMISSION_CHAINS`.
const MAX_PATH: usize = 32;
const MAX_SUBMISSION_CHAINS: usize = 1000;

/// `hopOf(value)`: a positive integer, else 0.
pub fn hop_of(value: Option<&Value>) -> u32 {
    value.and_then(Value::as_u64).filter(|hop| *hop > 0).map_or(0, |hop| u32::try_from(hop).unwrap_or(u32::MAX))
}

/// `botChainOf(value)`: the non-empty string ids, first occurrence kept.
pub fn bot_chain_of<'a>(ids: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| !id.is_empty() && seen.insert(*id)).map(str::to_owned).collect()
}

fn chain_value(value: Option<&Value>) -> Vec<String> {
    bot_chain_of(value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str))
}

#[derive(Default)]
struct Turn {
    hop: u32,
    bots: Vec<String>,
}

/// `chainsBySubmission` (bot-hops.mjs): module-global in Node, oldest first (a JS `Map` keeps the
/// place of a key set again).
static SUBMISSIONS: Mutex<Vec<(String, Vec<String>)>> = Mutex::new(Vec::new());

fn submissions() -> std::sync::MutexGuard<'static, Vec<(String, Vec<String>)>> {
    SUBMISSIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `rememberSubmissionBotChain(submissionId, chain)`: submission `submission_id` starts or joins
/// a turn of `chain`.
pub fn remember_submission(submission_id: &str, chain: &[String]) {
    let id = mixdog_js::js_trim(submission_id);
    let bots = bot_chain_of(chain.iter().map(String::as_str));
    if id.is_empty() || bots.is_empty() {
        return;
    }
    let mut known = submissions();
    match known.iter_mut().find(|(known, _)| known == id) {
        Some(entry) => entry.1 = bots,
        None => known.push((id.to_owned(), bots)),
    }
    while known.len() > MAX_SUBMISSION_CHAINS {
        known.remove(0);
    }
}

/// `submissionBotChain(transcriptMeta)`: the chain the meta carries, else the one recorded for
/// its ids (`checkpointId`, then the merged `submissionIds`).
fn submission_chain(meta: Option<&Value>) -> Vec<String> {
    let carried = chain_value(meta.and_then(|m| m.get("botChain")));
    if !carried.is_empty() {
        return carried;
    }
    let text = |value: Option<&Value>| match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::value_to_string(value),
    };
    let mut ids = vec![text(meta.and_then(|m| m.get("checkpointId")))];
    ids.extend(meta.and_then(|m| m.get("submissionIds")).and_then(Value::as_array).into_iter().flatten().map(|id| text(Some(id))));
    let known = submissions();
    let recorded: Vec<&str> = ids
        .iter()
        .flat_map(|id| known.iter().filter(move |(name, _)| name == id).flat_map(|(_, bots)| bots.iter().map(String::as_str)))
        .collect();
    bot_chain_of(recorded)
}

/// `turnHop` / `turnBotChain` of one loaded session (in memory, never persisted).
#[derive(Default)]
pub struct TurnState {
    inner: Mutex<Turn>,
}

impl TurnState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Turn> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `stampTurnHop(session, transcriptMeta)`: the hop and bot chain of the submission that
    /// starts the turn (else 0 and none).
    pub fn stamp(&self, meta: Option<&Value>) {
        *self.lock() = Turn { hop: hop_of(meta.and_then(|m| m.get("hop"))), bots: submission_chain(meta) };
    }

    /// `raiseTurnHop(session, transcriptMeta)`: a bot's message steered into the running turn
    /// raises the turn's hop and joins its chain.
    pub fn raise(&self, meta: Option<&Value>) {
        let (hop, chain) = (hop_of(meta.and_then(|m| m.get("hop"))), submission_chain(meta));
        let mut turn = self.lock();
        if hop > turn.hop {
            turn.hop = hop;
        }
        if !chain.is_empty() {
            let merged = bot_chain_of(turn.bots.iter().map(String::as_str).chain(chain.iter().map(String::as_str)));
            turn.bots = merged;
        }
    }

    /// `turnHopOf(session)`.
    pub fn hop(&self) -> u32 {
        self.lock().hop
    }

    /// `turnBotChainOf(session)`.
    pub fn bots(&self) -> Vec<String> {
        self.lock().bots.clone()
    }
}

/// `delegationChainOf(sessionId, getSession)` (`bot-chain.mjs:21`): the chain the session acts
/// in, oldest first, ending with the agent it acts as. Walks `parentSessionId` / `ownerSessionId`
/// up from it; each session contributes its current turn's chain (`turn_bots`), then the agent it
/// acts as. The visited set ends a malformed cycle.
pub fn delegation_chain(session_id: &str, get_session: &dyn Fn(&str) -> Option<Value>, turn_bots: &dyn Fn(&str) -> Vec<String>) -> Vec<String> {
    let mut chain: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut id = clean_str(session_id);
    while !id.is_empty() && seen.insert(id.clone()) {
        let session = get_session(&id);
        let acting = acting_agent_of(session.as_ref(), &id);
        let mut part = turn_bots(&id);
        if !acting.is_empty() {
            part.push(acting);
        }
        part.extend(chain);
        chain = part;
        id = session.as_ref().map(parent_link).unwrap_or_default();
    }
    bot_chain_of(chain.iter().map(String::as_str))
}

fn clean_str(value: &str) -> String {
    mixdog_js::js_trim(value).to_owned()
}

/// `clean(value)` of `delegation.mjs`: a string trimmed, anything else empty.
fn clean(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(clean_str).unwrap_or_default()
}

/// `session.parentSessionId || session.ownerSessionId`, cleaned.
fn parent_link(session: &Value) -> String {
    let parent = clean_any(session.get("parentSessionId"));
    if parent.is_empty() { clean_any(session.get("ownerSessionId")) } else { parent }
}

/// `String(value ?? '').trim()` (`bot-chain.mjs` `clean`).
fn clean_any(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => clean_str(&mixdog_js::value_to_string(value)),
    }
}

/// `actingAgentOf(session, sessionId)`: `resolveSessionMode({ session, sessionId }).agentId ||
/// session.agent`.
pub fn acting_agent_of(session: Option<&Value>, session_id: &str) -> String {
    let mut shown = session.and_then(Value::as_object).cloned().unwrap_or_default();
    if clean_any(shown.get("id")).is_empty() {
        shown.insert("id".into(), Value::String(session_id.to_owned()));
    }
    let (_, agent) = resolve_session_mode(&Value::Object(shown));
    if agent.is_empty() { clean_any(session.and_then(|s| s.get("agent"))) } else { agent }
}

// ---- the stored delegation ------------------------------------------------------------------

fn agent_owned(record: &Header) -> bool {
    clean(record.get("owner")).to_lowercase() == "agent" || clean(record.get("visibility")).to_lowercase() == "agent-only"
}

/// `parentOf(record)`: the session that spawned an agent-owned `record`, else empty.
fn parent_of(record: &Header) -> String {
    if !agent_owned(record) {
        return String::new();
    }
    let parent = clean(record.get("parentSessionId"));
    if parent.is_empty() { clean(record.get("ownerSessionId")) } else { parent }
}

/// `stepOf(record)`.
fn step_of(record: &Header) -> Value {
    json!({ "kind": "agent", "agent": clean(record.get("agent")) })
}

/// `validDelegation(value)`: a recorded delegation, or `None` when it is malformed or carries a
/// step that is not an agent.
fn valid_delegation(value: Option<&Value>) -> Option<Map<String, Value>> {
    let value = value?.as_object()?;
    if clean(value.get("rootSessionId")).is_empty() || !matches!(value.get("via").and_then(Value::as_str), Some("coding" | "bot")) {
        return None;
    }
    let path = value.get("path")?.as_array()?;
    if path.is_empty() || path.len() > MAX_PATH || !path.iter().all(|step| step.get("kind").and_then(Value::as_str) == Some("agent")) {
        return None;
    }
    Some(value.clone())
}

/// `viaOf(sessionId, record)`.
fn via_of(session: &str, record: Option<&Header>) -> Option<&'static str> {
    if room_member_of_session(session).is_some() || agent_id_of_home_session(session).is_some() {
        return Some("bot");
    }
    record.filter(|r| !agent_owned(r)).map(|_| "coding")
}

/// `rootFrom(parent, record, step)`.
fn root_from(parent: &str, record: Option<&Header>, step: Value) -> Option<Map<String, Value>> {
    let via = via_of(parent, record)?;
    Some(json!({ "rootSessionId": parent, "via": via, "path": [step] }).as_object().cloned().unwrap_or_default())
}

fn extended(inherited: &Map<String, Value>, step: Value) -> Option<Map<String, Value>> {
    let mut path = inherited.get("path").and_then(Value::as_array).cloned().unwrap_or_default();
    if path.len() >= MAX_PATH {
        return None;
    }
    path.push(step);
    let mut next = inherited.clone();
    next.insert("path".into(), Value::Array(path));
    Some(next)
}

type Boxed<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// `delegationOfRecord(id, record, depth)`: the recorded delegation, else its legacy backfill.
fn delegation_of_record<'a>(id: &'a str, record: &'a Header, depth: usize, records: &'a dyn Records) -> Boxed<'a, Option<Map<String, Value>>> {
    Box::pin(async move {
        match valid_delegation(record.get("delegation")) {
            Some(valid) => Some(valid),
            None => backfill_of(id, record, depth, records).await,
        }
    })
}

/// `backfillOf(id, record, depth)`: derived now from the parent.
fn backfill_of<'a>(id: &'a str, record: &'a Header, depth: usize, records: &'a dyn Records) -> Boxed<'a, Option<Map<String, Value>>> {
    Box::pin(async move {
        let parent = parent_of(record);
        if parent.is_empty() || parent == id || depth >= MAX_PATH {
            return None;
        }
        let parent_record = records.record(&parent).await;
        let step = step_of(record);
        match parent_record.as_ref().filter(|r| !parent_of(r).is_empty()) {
            Some(parent_record) => {
                let inherited = delegation_of_record(&parent, parent_record, depth + 1, records).await?;
                extended(&inherited, step)
            }
            None => root_from(&parent, parent_record.as_ref(), step),
        }
    })
}

/// `delegationUnder(parent, step)`: the delegation of a session taking `step` under `parent`.
async fn delegation_under(parent: &str, step: Value, records: &dyn Records) -> Option<Map<String, Value>> {
    let record = records.record(parent).await;
    match record.as_ref().filter(|r| !parent_of(r).is_empty()) {
        Some(record) => {
            let inherited = delegation_of_record(parent, record, 0, records).await?;
            extended(&inherited, step)
        }
        None => root_from(parent, record.as_ref(), step),
    }
}

/// `delegationForNewSession(opts)`: the `delegation` to record on a session being created with
/// header `opts`; none for a top-level session or one whose parent's root cannot be established.
pub async fn delegation_for_new_session(opts: &Header, id: &str, records: &dyn Records) -> Option<Value> {
    let parent = parent_of(opts);
    if parent.is_empty() || parent == clean_str(id) {
        return None;
    }
    delegation_under(&parent, step_of(opts), records).await.map(Value::Object)
}

/// What `rebindDelegation(sessionId, callerSessionId)` writes to the record, or `None` when
/// nothing applies (no record, closed, neither a sub-agent nor a task session, no or the same
/// caller, nothing different). `caller_run` is `runOfSession(caller)`; `turn_in_flight` whether
/// the session's turn runs (a turn already running is never made a run mid-turn). The returned
/// map is set on the header: `delegation` when re-rooted, `run` (null = attended).
pub async fn rebind_patch(
    session: &str,
    caller: &str,
    caller_run: Option<Value>,
    turn_in_flight: bool,
    records: &dyn Records,
) -> Option<Map<String, Value>> {
    let (id, caller) = (clean_str(session), clean_str(caller));
    let record = records.record(&id).await?;
    if record.get("closed") == Some(&Value::Bool(true)) || caller.is_empty() || caller == id {
        return None;
    }
    let delegated = !parent_of(&record).is_empty();
    if !delegated && !truthy(record.get("taskOrigin")) {
        return None;
    }
    let next = if delegated { delegation_under(&caller, step_of(&record), records).await } else { None };
    let current = run_stamp_of(&id, records).await;
    let same = |a: Option<&Value>, b: Option<&Value>| a.unwrap_or(&Value::Null) == b.unwrap_or(&Value::Null);
    let recorded = valid_delegation(record.get("delegation")).map(Value::Object);
    let reroot = next.is_some() && !same(recorded.as_ref(), next.clone().map(Value::Object).as_ref());
    if !reroot && same(current.as_ref(), caller_run.as_ref()) {
        return None;
    }
    if caller_run.is_some() && current.is_none() && turn_in_flight {
        return None;
    }
    let mut patch = Map::new();
    if reroot && let Some(next) = next {
        patch.insert("delegation".into(), Value::Object(next));
    }
    if caller_run.is_some() || current.is_some() {
        patch.insert("run".into(), caller_run.unwrap_or(Value::Null));
    }
    Some(patch)
}

// ---- where a sub-agent's approval cards show ---------------------------------------------------

/// `LEAD_NAME` (`human-gate/gate.mjs`): the chain token the desktop translates (`approvalChainLabel`).
const LEAD_NAME: &str = "Lead";

/// `agentDisplayName(agentId)`: the name a bot goes by in the envelope of its messages.
#[async_trait]
pub trait AgentNames: Send + Sync {
    async fn name(&self, agent_id: &str) -> String;
}

/// What `approvalSurface(sessionId)` answers: the top-level chat a sub-agent's approval cards also show in, and who asks,
/// from there down to the asker (`['Lead', 'Reviewer']`, `['사무관', 'Worker']`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalSurface {
    pub session_id: String,
    pub chain: Vec<String>,
}

/// Where a session's own requests are shown when it is a room seat: the room's log, which carries the member's `toolApproval`
/// (`agent-room-turn.ts:278`). `None` for any other session, which is its own surface.
pub fn room_log_surface(session: &str) -> Option<mixdog_core_api::ids::ThreadId> {
    let member = mixdog_core_base::rooms::ids::room_member_of_session(session)?;
    mixdog_core_base::rooms::ids::room_session_id(&member.room_id).map(mixdog_core_api::ids::ThreadId::from)
}

/// `approvalSurface(sessionId)` (`human-gate/gate.mjs:155`) over `delegationOf`: the delegation's root, named by its bot
/// (a home chat or room seat reached `via: 'bot'`) or `Lead`, then each agent on its path. `None` for a top-level session, one
/// with no record, or one with a parent link and no derivable root.
pub async fn approval_surface(session: &str, records: &dyn Records, names: &dyn AgentNames) -> Option<ApprovalSurface> {
    let id = clean_str(session);
    let record = records.record(&id).await?;
    let parent = parent_of(&record);
    if parent.is_empty() || parent == id {
        return None;
    }
    let delegation = delegation_of_record(&id, &record, 0, records).await?;
    let root = clean(delegation.get("rootSessionId"));
    // `ownBoundAgentId(rootSessionId)`: a `bot` root is a room seat or a home chat, which names its agent.
    let bot = match delegation.get("via").and_then(Value::as_str) {
        Some("bot") => room_member_of_session(&root).map(|member| member.agent_id).or_else(|| agent_id_of_home_session(&root)).unwrap_or_default(),
        _ => String::new(),
    };
    let mut chain = vec![if bot.is_empty() { LEAD_NAME.to_owned() } else { names.name(&bot).await }];
    for step in delegation.get("path").and_then(Value::as_array).into_iter().flatten() {
        chain.push(names.name(&clean(step.get("agent"))).await);
    }
    Some(ApprovalSurface { session_id: root, chain })
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;

    struct Fixed(Value);

    #[async_trait]
    impl Records for Fixed {
        async fn record(&self, session: &str) -> Option<Header> {
            self.0.get(session).and_then(Value::as_object).cloned()
        }
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// `bot-hops.mjs`: the stamp replaces, the raise only raises, a recorded submission chain is
    /// found by its ids.
    #[test]
    fn a_turn_takes_the_hop_and_chain_of_its_submission() {
        let turn = TurnState::default();
        turn.stamp(Some(&json!({ "hop": 2, "botChain": ["a", "a", "b"] })));
        assert_eq!((turn.hop(), turn.bots()), (2, strings(&["a", "b"])));
        turn.raise(Some(&json!({ "hop": 1, "botChain": ["c"] })));
        assert_eq!((turn.hop(), turn.bots()), (2, strings(&["a", "b", "c"])));
        turn.stamp(Some(&json!({ "device": "PC" })));
        assert_eq!((turn.hop(), turn.bots()), (0, Vec::<String>::new()));
        remember_submission("delegation-test-sub", &strings(&["x"]));
        turn.stamp(Some(&json!({ "checkpointId": "delegation-test-sub" })));
        assert_eq!(turn.bots(), strings(&["x"]));
    }

    /// `delegationChainOf`: the ancestry's turn chains and acting agents, oldest first.
    #[test]
    fn the_chain_walks_the_ancestry_and_ends_at_the_acting_agent() {
        let sessions = json!({
            "child": { "owner": "agent", "agent": "worker", "parentSessionId": "sess_home_b" },
            "sess_home_b": { "id": "sess_home_b" },
        });
        let get = |id: &str| sessions.get(id).cloned();
        let bots = |id: &str| if id == "child" { strings(&["a"]) } else { Vec::new() };
        assert_eq!(delegation_chain("child", &get, &bots), strings(&["b", "a", "worker"]));
    }

    #[tokio::test]
    async fn a_sub_agent_is_rooted_under_its_parent_and_rebinds_to_a_new_caller() {
        let records = Fixed(json!({
            "lead": { "sourceType": "lead" },
            "w1": { "owner": "agent", "agent": "worker", "parentSessionId": "lead", "run": null },
            "other": { "sourceType": "lead" },
        }));
        let made = delegation_for_new_session(records.0["w1"].as_object().unwrap(), "w1", &records).await.unwrap();
        assert_eq!(made, json!({ "rootSessionId": "lead", "via": "coding", "path": [{ "kind": "agent", "agent": "worker" }] }));
        let patch = rebind_patch("w1", "other", None, false, &records).await.unwrap();
        assert_eq!(patch.get("delegation").unwrap()["rootSessionId"], "other");
        assert!(!patch.contains_key("run"), "attended to attended writes no run");
        assert!(rebind_patch("w1", "w1", None, false, &records).await.is_none());
        let run = json!({ "kind": "schedule", "agentId": "bot", "name": "n" });
        assert!(rebind_patch("w1", "other", Some(run.clone()), true, &records).await.is_none(), "never a run mid-turn");
        assert_eq!(rebind_patch("w1", "other", Some(run.clone()), false, &records).await.unwrap()["run"], run);
    }

    struct Names;

    #[async_trait]
    impl AgentNames for Names {
        async fn name(&self, agent_id: &str) -> String {
            match agent_id {
                "worker" => "Worker".into(),
                "reviewer" => "Reviewer".into(),
                "mailer" => "사무관".into(),
                other => other.into(),
            }
        }
    }

    /// `approvalSurface` (delegated-approval.test.mjs:230-277): the root, then the names from it down to the asker; a legacy
    /// record's delegation is derived from its parent; a top-level session has none.
    #[tokio::test]
    async fn a_sub_agent_surfaces_in_its_root_with_the_names_down_to_it() {
        let records = Fixed(json!({
            "lead": { "sourceType": "lead" },
            "w1": { "owner": "agent", "agent": "worker", "parentSessionId": "lead", "delegation": { "rootSessionId": "lead", "via": "coding", "path": [{ "kind": "agent", "agent": "worker" }] } },
            "r1": { "owner": "agent", "agent": "reviewer", "parentSessionId": "w1" },
            "sess_home_mailer": {},
            "b1": { "visibility": "agent-only", "agent": "worker", "parentSessionId": "sess_home_mailer" },
        }));
        let surface = |session_id: &str, chain: &[&str]| Some(ApprovalSurface { session_id: session_id.into(), chain: strings(chain) });
        assert_eq!(approval_surface("w1", &records, &Names).await, surface("lead", &["Lead", "Worker"]));
        assert_eq!(approval_surface("r1", &records, &Names).await, surface("lead", &["Lead", "Worker", "Reviewer"]));
        assert_eq!(approval_surface("b1", &records, &Names).await, surface("sess_home_mailer", &["사무관", "Worker"]));
        for top in ["lead", "sess_home_mailer", "unknown"] {
            assert_eq!(approval_surface(top, &records, &Names).await, None, "{top}");
        }
    }

    /// A room seat's requests show in the room's log, any other session is its own surface.
    #[test]
    fn a_room_seat_surfaces_in_its_rooms_log() {
        let room = "ab12cd";
        let seat = mixdog_core_base::rooms::ids::room_member_session_id(room, "mailer").expect("seat id");
        let log = mixdog_core_base::rooms::ids::room_session_id(room).expect("log id");
        assert_eq!(room_log_surface(&seat).map(|id| id.as_str().to_owned()), Some(log));
        assert_eq!(room_log_surface("lead"), None);
    }
}
