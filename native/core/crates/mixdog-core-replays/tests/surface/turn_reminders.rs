//! The reminder block against Node's recording (`fixtures/turn-reminders/twin.json`, recorded by
//! `benchmarks/rust-core/recorders/record-turn-reminders.mjs`): every case is a session record and the user turn Node
//! built from it. The turn is built again here from the same record and must be the message Node sent, carry the
//! revisions Node carried, and, acknowledged as an accepted turn, leave the record as Node left it.

use mixdog_core_session::session::goal_reminder;
use mixdog_core_session::session::reminders as staged;
use mixdog_js::time::Tz;
use mixdog_js::time::with_local_zone;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_protocol::message_class::user_text::ReadError;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;

use mixdog_core::run_host::turn_reminders::*;
use mixdog_core::replay_access::turn_reminders::{clock, deferred, listing};
use mixdog_core_session::session::prompt_notice::Revisions;
use mixdog_core_session::session::thread_switches::mode_notice_text;
use mixdog_store::schema::record::Header;

/// The attachment store as Node's read left it for each reference the case names.
struct Store<'a>(&'a Value);

impl Blobs for Store<'_> {
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        let blob = &self.0[hex];
        match blob["state"].as_str() {
            Some("text") => Ok(Some(blob["text"].as_str().expect("text").to_owned()).filter(|text| text.len() as u64 <= max_bytes)),
            Some("missing") => Err(ReadError::Missing),
            _ => Err(ReadError::Other),
        }
    }
}

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/turn-reminders/twin.json")).expect("twin.json")
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

/// Node trailed a delegated agent's brief with a hidden reminder to make a todo list (`todoStartReminder`). The core
/// sends none: the shared rules say when a list is set (`rules/shared/25-plan.md`), for the Lead and every agent. So a
/// recorded message is compared without that one part of its block.
fn without_todo_start(message: &Value) -> Value {
    const OPEN: &str = "\n\n<system-reminder>\nIf this brief has three or more steps";
    const CLOSE: &str = "</system-reminder>";
    let mut out = message.clone();
    let Some(suffix) = message.pointer("/meta/runtimeUserContext/suffix").and_then(Value::as_str) else { return out };
    let Some(from) = suffix.find(OPEN) else { return out };
    let to = from + suffix[from..].find(CLOSE).expect("the reminder closes") + CLOSE.len();
    let kept = format!("{}{}", &suffix[..from], &suffix[to..]);
    let text = out["content"].as_str().expect("a text message").strip_suffix(suffix).expect("the suffix ends the text").to_owned();
    out["content"] = Value::String(format!("{text}{kept}"));
    if kept.is_empty() {
        let meta = out["meta"].as_object_mut().expect("meta");
        meta.shift_remove("runtimeUserContext");
        if meta.is_empty() {
            out.as_object_mut().expect("message").shift_remove("meta");
        }
    } else {
        out["meta"]["runtimeUserContext"]["suffix"] = Value::String(kept);
    }
    out
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
    prompt_text: String,
}

fn turn_of(case: &Value, now: i64) -> Turn {
    let (header, prior) = split(&case["session"]);
    let recorded = &case["turn"];
    let todo = mixdog_core_ports::ports::todo_list::list_of(&header);
    let (goal, snapshot) = goal_reminder::snapshot(&header, None, &todo, now);
    // The host answers `orchestrationInstructions(mode)` for the mode a pending notice needs it for.
    let instructions = carried_mode(&header).map(|_| recorded["modeInstructions"].as_str().expect("the recorded instructions").to_owned());
    let prompt_text = clock::prompt_content_text(&recorded["prompt"], &Store(&case["blobs"])).expect("the prompt reads");
    Turn { agents: entries(&recorded["currentAgents"]), genuine: recorded["turnPromptSource"].is_null(), prompt_text, header, prior, instructions, goal, snapshot }
}

fn built(turn: &Turn, now: i64) -> Reminders {
    let facts = Facts {
        header: &turn.header,
        prior: &turn.prior,
        prompt_text: &turn.prompt_text,
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
    for case in cases.iter().filter(|case| case["error"].is_null()) {
        let name = case["name"].as_str().expect("name");
        let turn = turn_of(case, now);
        let reminders = with_local_zone(Tz::Asia__Seoul, || built(&turn, now));
        let (base, expected) = (plain(&case["message"]), without_todo_start(&case["message"]));
        let sent = match reminders.carry(&base) {
            Some(sent) => sent,
            // Nothing but the todo start reminder trailed this message in Node: here it is sent as it is.
            None if expected == base => base,
            None => panic!("{name}: the message carries the block"),
        };
        assert_eq!(sent, expected, "{name}: the message the model is sent");

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
    for case in twin["cases"].as_array().expect("cases").iter().filter(|case| case["error"].is_null()) {
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
    for case in twin["cases"].as_array().expect("cases").iter().filter(|case| case["error"].is_null()) {
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
        let prompt = row["prompt"].as_str().expect("prompt");
        let got = with_local_zone(zone, || clock::block(prompt, now));
        assert_eq!(got, row["block"].as_str().expect("block"), "{} {}", row["zone"], row["prompt"]);
    }
}

#[test]
fn a_prompt_whose_attachment_cannot_be_read_fails_the_turn_as_it_failed_in_node() {
    let twin = twin();
    let failed: Vec<&Value> = twin["cases"].as_array().expect("cases").iter().filter(|case| !case["error"].is_null()).collect();
    assert!(!failed.is_empty());
    for case in failed {
        let got = clock::prompt_content_text(&case["turn"]["prompt"], &Store(&case["blobs"]));
        assert!(got.is_err(), "{}: Node failed with {}", case["name"], case["error"]);
    }

}

#[test]
fn a_retried_turn_resends_its_message_and_acknowledges_only_its_settings_notice() {
    let twin = twin();
    let retained = twin["retained"].as_array().expect("retained");
    assert!(retained.len() > 5);
    for case in retained {
        let name = case["name"].as_str().expect("name");
        let (header, rows) = split(&case["session"]);
        let index = case["index"].as_u64().expect("index") as usize;
        // `index` counts the system rows; the history before the message is what the retry sees.
        let skipped = case["session"]["messages"].as_array().expect("messages").iter().filter(|message| message["role"] == "system").count();
        let (prior, message) = (&rows[..index - skipped], &rows[index - skipped]);
        let agents = entries(&case["currentAgents"]);
        let (resent, revisions) = resubmit(message, &header, prior, agents.as_deref()).unwrap_or_else(|text| panic!("{name}: {text}"));
        assert_eq!(&resent, &case["resent"], "{name}: the message the retry sends");
        assert_eq!(revisions, Revisions { settings: case["settings"].as_i64(), ..Revisions::default() }, "{name}: only the settings notice is acknowledged");
    }
}