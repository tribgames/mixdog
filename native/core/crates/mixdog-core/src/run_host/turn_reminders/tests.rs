//! The reminder block against Node's recording (`fixtures/turn-reminders/twin.json`, recorded by
//! `benchmarks/rust-core/recorders/record-turn-reminders.mjs`): every case is a session record and the user turn Node
//! built from it. The turn is built again here from the same record and must be the message Node sent, carry the
//! revisions Node carried, and, acknowledged as an accepted turn, leave the record as Node left it.

use mixdog_core_session::session::goal_reminder;
use mixdog_core_session::session::reminders as staged;
use mixdog_js::time::Tz;
use mixdog_js::time::with_local_zone;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;

use super::*;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/turn-reminders/twin.json")).expect("twin.json")
}

fn now_ms(twin: &Value) -> i64 {
    chrono::DateTime::parse_from_rfc3339(twin["now"].as_str().expect("now")).expect("an instant").timestamp_millis()
}

/// The header and the stored rows of a recorded session: Node keeps its system prefix and its conversation in one
/// `messages` array.
fn split(session: &Value) -> (Header, Vec<Value>) {
    let mut header = session.as_object().expect("a session").clone();
    let messages = header.shift_remove("messages").expect("messages");
    let prior = messages.as_array().expect("an array").iter().filter(|message| message["role"] != "system").cloned().collect();
    (header, prior)
}

fn apply(header: &mut Header, change: &HeaderChange) {
    for key in &change.unset {
        header.shift_remove(key);
    }
    for (key, value) in &change.set {
        header.insert(key.clone(), value.clone());
    }
}

/// The message before its reminders: the suffix and the meta the reminders left come off.
fn plain(message: &Value) -> Value {
    let mut plain = message.clone();
    let Some(context) = message.pointer("/meta/runtimeUserContext") else { return plain };
    let suffix = context["suffix"].as_str().expect("suffix");
    match &mut plain["content"] {
        Value::String(text) => {
            let kept = text.strip_suffix(suffix).expect("the suffix ends the text").len();
            text.truncate(kept);
        }
        Value::Array(parts) => {
            parts.pop();
        }
        other => panic!("content {other}"),
    }
    let meta = plain["meta"].as_object_mut().expect("meta");
    for key in ["runtimeUserContext", "agentListing", "promptSettingsNoticeRevision"] {
        meta.shift_remove(key);
    }
    if meta.is_empty() {
        plain.as_object_mut().expect("message").shift_remove("meta");
    }
    plain
}

fn entries(value: &Value) -> Option<Vec<AgentEntry>> {
    let list = value.as_array()?;
    Some(list.iter().map(|entry| AgentEntry { id: entry["id"].as_str().expect("id").to_owned(), name: entry["name"].as_str().expect("name").to_owned(), line: entry["line"].as_str().expect("line").to_owned() }).collect())
}

fn hidden(header: &Header) -> bool {
    header.get("agent").and_then(Value::as_str).is_some_and(|agent| mixdog_core_config::config::hidden_agents::hidden_agents().contains(agent))
}

/// What the host and the actor supply a turn with, read from the recorded turn.
struct Turn {
    header: Header,
    prior: Vec<Value>,
    agents: Option<Vec<AgentEntry>>,
    instructions: Option<String>,
    goal: Option<goal_reminder::GoalReminder>,
    snapshot: HeaderChange,
    genuine: bool,
    prompt: Value,
}

fn turn_of(case: &Value, now: i64) -> Turn {
    let (header, prior) = split(&case["session"]);
    let recorded = &case["turn"];
    let todo = mixdog_core_ports::ports::todo_list::list_of(&header);
    let (goal, snapshot) = goal_reminder::snapshot(&header, None, &todo, now);
    // The host answers `orchestrationInstructions(mode)` for the mode a pending notice needs it for.
    let instructions = carried_mode(&header).map(|_| recorded["modeInstructions"].as_str().expect("the recorded instructions").to_owned());
    Turn { agents: entries(&recorded["currentAgents"]), genuine: recorded["turnPromptSource"].is_null(), prompt: recorded["prompt"].clone(), header, prior, instructions, goal, snapshot }
}

fn built(turn: &Turn, now: i64) -> Reminders {
    let facts = Facts {
        header: &turn.header,
        prior: &turn.prior,
        prompt: &turn.prompt,
        genuine: turn.genuine,
        current_agents: turn.agents.as_deref(),
        mode_instructions: turn.instructions.as_deref(),
        goal: turn.goal.as_ref().map(|goal| goal.content.as_str()),
        hidden_agent: hidden(&turn.header),
        now_ms: now as f64,
    };
    build(&facts).expect("the reminders build")
}

#[test]
fn every_recorded_turn_carries_the_reminders_node_sent_in_node_order() {
    let twin = twin();
    let now = now_ms(&twin);
    let cases = twin["cases"].as_array().expect("cases");
    assert!(cases.len() > 20);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let turn = turn_of(case, now);
        let reminders = with_local_zone(Tz::Asia__Seoul, || built(&turn, now));
        let sent = reminders.carry(&plain(&case["message"])).unwrap_or_else(|| panic!("{name}: the message carries the block"));
        assert_eq!(sent, case["message"], "{name}: the message the model is sent");

        let revisions = &reminders.revisions;
        let got = json!({
            "deferred": revisions.deferred,
            "goal": turn.goal.as_ref().map(|goal| goal.revision),
            "workflow": revisions.workflow,
            "settings": revisions.settings,
            "orchestration": revisions.orchestration,
            "workspace": revisions.workspace,
            "setup": revisions.setup,
        });
        assert_eq!(got, case["revisions"], "{name}: the revision of each reminder");
    }
}

#[test]
fn each_reminder_reads_what_node_read() {
    let twin = twin();
    let now = now_ms(&twin);
    for case in twin["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let turn = turn_of(case, now);
        let text = |content: Option<String>| content.map_or(Value::Null, Value::String);
        let contents = &case["contents"];
        assert_eq!(text(staged::workflow_notice(&turn.header).map(|notice| notice.content)), contents["workflow"], "{name}: workflow");
        let mode = staged::orchestration_notice(&turn.header).map(|mode| match mode.overlay {
            Some(content) => content,
            None => mode_notice_text(&mode.mode, true, &[], turn.instructions.as_deref().expect("instructions")),
        });
        assert_eq!(text(mode), contents["orchestration"], "{name}: orchestration");
        let listing = listing::notice(&turn.header, &turn.prior, turn.agents.as_deref()).map_or(Value::Null, |notice| json!({ "content": notice.content, "meta": notice.meta }));
        assert_eq!(listing, contents["agentListing"], "{name}: agent list");
        assert_eq!(text(staged::workspace_notice(&turn.header).map(|notice| notice.content)), contents["workspace"], "{name}: working folder");
        assert_eq!(text(deferred::notice(&turn.header).map(|notice| notice.content)), contents["deferred"], "{name}: deferred delta");
        assert_eq!(turn.goal.as_ref().map(|goal| goal.content.clone()).map_or(Value::Null, Value::String), contents["goal"], "{name}: goal");
    }
}

#[test]
fn an_accepted_turn_acknowledges_what_it_carried_and_leaves_the_record_as_node_did() {
    let twin = twin();
    let now = now_ms(&twin);
    let ignored: Vec<&str> = twin["ignored"].as_array().expect("ignored").iter().map(|key| key.as_str().expect("key")).collect();
    let without = |mut record: Header| {
        for key in &ignored {
            record.shift_remove(*key);
        }
        Value::Object(record)
    };
    for case in twin["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let turn = turn_of(case, now);
        let reminders = with_local_zone(Tz::Asia__Seoul, || built(&turn, now));
        let mut record = turn.header.clone();
        apply(&mut record, &turn.snapshot);
        // The settle: the deferred delta, the Goal, then the rest (`ask-turn-settle.mjs:148-164`).
        if let Some(change) = staged::acknowledge(&record, &reminders.revisions, now) {
            apply(&mut record, &change);
        }
        if let Some(goal) = &turn.goal
            && let Some(change) = goal_reminder::acknowledge(&record, goal.revision, now)
        {
            apply(&mut record, &change);
        }
        let (expected, _) = split(&case["after"]);
        assert_eq!(without(record), without(expected), "{name}: the record after the accepted turn");

        // A newer revision staged meanwhile is not the one the turn carried: it stays.
        let newer = |revision: Option<i64>| revision.map(|revision| revision + 100);
        let stale = Revisions {
            settings: newer(reminders.revisions.settings),
            workflow: newer(reminders.revisions.workflow),
            orchestration: newer(reminders.revisions.orchestration),
            workspace: newer(reminders.revisions.workspace),
            setup: newer(reminders.revisions.setup),
            deferred: newer(reminders.revisions.deferred),
        };
        assert!(staged::acknowledge(&turn.header, &stale, now).is_none(), "{name}: a stale revision acknowledges nothing");
    }
}

#[test]
fn the_current_time_reminder_reads_the_zone_as_node_did() {
    let twin = twin();
    let now = now_ms(&twin) as f64;
    let rows = twin["clock"].as_array().expect("clock");
    assert!(rows.len() > 30);
    for row in rows {
        let zone: Tz = row["zone"].as_str().expect("zone").parse().expect("a zone");
        let prompt = json!(row["prompt"].as_str().expect("prompt"));
        let got = with_local_zone(zone, || clock::block(&prompt, now));
        assert_eq!(got, row["block"].as_str().expect("block"), "{} {}", row["zone"], row["prompt"]);
    }
}
