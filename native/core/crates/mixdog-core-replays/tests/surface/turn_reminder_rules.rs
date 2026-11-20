//! The reminder block of a user turn: which staged reminders a turn carries, in which order, what each one
//! acknowledges once the turn is accepted, and when the current time is added.

use mixdog_core::run_host::turn_reminders::Facts;
use mixdog_core::run_host::turn_reminders::Reminders;
use mixdog_core::run_host::turn_reminders::build;
use mixdog_core::run_host::turn_reminders::carried_mode;
use mixdog_core::run_host::turn_reminders::resubmit;
use mixdog_core_session::session::reminders as staged;
use mixdog_js::time::Tz;
use mixdog_js::time::with_local_zone;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

/// 2023-11-14T22:13:20.000Z.
const NOW: i64 = 1_700_000_000_000;

fn header(session: Value) -> Header {
    session.as_object().expect("a session object").clone()
}

/// A session that has every staged reminder pending, each with its own revision.
fn staged_session() -> Header {
    header(json!({
        "workflowSwitch": { "revision": 1, "from": { "name": "Team" }, "to": { "id": "solo", "name": "Solo" } },
        "workflowOverlay": { "workflow": { "id": "solo" }, "content": "WORKFLOW-TEXT" },
        "promptSettingsNotice": { "revision": 3, "content": "SETTINGS-TEXT" },
        "orchestrationModeSwitch": { "revision": 2, "to": "plan" },
        "orchestrationModeOverlay": { "mode": "plan", "content": "MODE-TEXT" },
        "workspaceReroot": { "revision": 5, "seen": { "cwd": "/old" }, "target": { "cwd": "/new" } },
        "pendingSetupNotice": { "revision": 4, "content": "SETUP-TEXT" },
    }))
}

fn facts<'a>(header: &'a Header, prompt: &'a str) -> Facts<'a> {
    Facts {
        header,
        prior: &[],
        prompt_text: prompt,
        genuine: true,
        current_agents: None,
        mode_instructions: None,
        goal: None,
        hidden_agent: false,
        now_ms: NOW as f64,
    }
}

fn built(facts: &Facts<'_>) -> Reminders {
    with_local_zone(Tz::Asia__Seoul, || build(facts)).expect("the reminders build")
}

#[test]
fn a_turn_carries_every_pending_reminder_in_a_fixed_order_joined_by_a_blank_line() {
    let session = staged_session();
    let mut turn = facts(&session, "what time is it");
    turn.goal = Some("GOAL-TEXT");
    let reminders = built(&turn);
    let order = ["WORKFLOW-TEXT", "SETTINGS-TEXT", "MODE-TEXT", "# Working Folder Changed", "SETUP-TEXT", "# Current Time", "GOAL-TEXT"];
    let at: Vec<usize> = order.iter().map(|marker| reminders.block.find(marker).unwrap_or_else(|| panic!("{marker} is in the block"))).collect();
    assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "workflow, settings, mode, folder, setup, time, goal: {at:?}");
    assert!(
        reminders
            .block
            .starts_with("WORKFLOW-TEXT\n\nSETTINGS-TEXT\n\nMODE-TEXT\n\n<system-reminder>\n# Working Folder Changed\nThe working folder is now /new.")
    );
    assert!(reminders.block.ends_with("\n\nGOAL-TEXT"));
    assert_eq!(reminders.agent_listing, None);
}

#[test]
fn each_reminder_reports_the_revision_the_turn_must_acknowledge() {
    let session = staged_session();
    let revisions = built(&facts(&session, "hello")).revisions;
    assert_eq!(
        (revisions.workflow, revisions.settings, revisions.orchestration, revisions.workspace, revisions.setup, revisions.deferred),
        (Some(1), Some(3), Some(2), Some(5), Some(4), None)
    );
}

#[test]
fn a_session_with_nothing_pending_carries_no_block_and_leaves_the_message_as_it_is() {
    let session = header(json!({}));
    let reminders = built(&facts(&session, "hello"));
    assert_eq!(reminders.block, "");
    let message = json!({ "role": "user", "content": "hello" });
    assert_eq!(reminders.carry(&message), Some(message));
}

#[test]
fn a_message_carries_the_block_as_its_trailing_suffix_and_the_meta_a_retry_needs() {
    let session = staged_session();
    let reminders = built(&facts(&session, "hello"));
    let suffix = format!("\n\n{}", reminders.block);
    let text = reminders.carry(&json!({ "role": "user", "content": "hello" })).expect("text content carries");
    assert_eq!(text["content"], json!(format!("hello{suffix}")));
    assert_eq!(text["meta"]["runtimeUserContext"], json!({ "prefix": "", "suffix": suffix }));
    assert_eq!(text["meta"]["promptSettingsNoticeRevision"], 3);

    let parts = reminders.carry(&json!({ "role": "user", "content": [{ "type": "text", "text": "hello" }] })).expect("blocks carry");
    assert_eq!(parts["content"], json!([{ "type": "text", "text": "hello" }, { "type": "text", "text": suffix }]));
}

#[test]
fn the_current_time_is_added_in_the_machine_zone_and_utc_only_when_the_prompt_asks_for_it() {
    let session = header(json!({}));
    let asked = built(&facts(&session, "what time is it now?")).block;
    assert_eq!(
        asked,
        "<system-reminder>\n# Current Time\nLocal: 2023-11-15 07:13:20 Asia/Seoul (UTC+09:00)\nUTC: 2023-11-14T22:13:20.000Z\n</system-reminder>"
    );
    assert_eq!(built(&facts(&session, "오늘 며칠이야")).block, asked, "a Korean date word asks too");
    assert_eq!(built(&facts(&session, "refactor the parser")).block, "");
}

#[test]
fn a_mode_switch_the_prompt_already_caught_up_with_needs_the_hosts_instructions() {
    let session = header(json!({ "orchestrationModeSwitch": { "revision": 2, "to": "plan" } }));
    assert_eq!(carried_mode(&session).as_deref(), Some("plan"));
    let turn = facts(&session, "hello");
    assert!(build(&turn).is_err(), "no overlay holds the text and the host supplied none");
    let mut supplied = facts(&session, "hello");
    supplied.mode_instructions = Some("PLAN-INSTRUCTIONS");
    let block = built(&supplied).block;
    assert!(block.contains("# Orchestration Mode Changed") && block.contains("PLAN-INSTRUCTIONS"), "{block}");

    let overlaid = staged_session();
    assert_eq!(carried_mode(&overlaid), None, "an overlay holds the text");
}

#[test]
fn an_agent_enabled_since_the_conversation_was_told_is_listed_and_recorded_in_the_message_meta() {
    use mixdog_core::run_host::turn_reminders::AgentEntry;
    let session = header(json!({}));
    let agents = [AgentEntry { id: "a".into(), name: "worker".into(), line: "- worker (a)".into() }];
    let mut turn = facts(&session, "hello");
    turn.current_agents = Some(&agents);
    let reminders = built(&turn);
    assert!(reminders.block.contains("# Available Agents Changed"), "{}", reminders.block);
    assert!(reminders.block.contains("New agents are now available to delegate to with `agent`:\n- worker (a)"), "{}", reminders.block);
    let carried = reminders.carry(&json!({ "role": "user", "content": "hello" })).expect("carries");
    assert_eq!(Some(&carried["meta"]["agentListing"]), reminders.agent_listing.as_ref());
}

#[test]
fn the_start_reminder_is_added_to_a_delegated_brief_with_no_open_list_and_only_for_a_genuine_prompt() {
    let session = header(json!({ "owner": "agent", "tools": [{ "name": "todo" }] }));
    let genuine = built(&facts(&session, "do the work")).block;
    assert!(genuine.starts_with("<system-reminder>") && genuine.ends_with("</system-reminder>"), "{genuine}");
    let mut notification = facts(&session, "do the work");
    notification.genuine = false;
    assert_eq!(built(&notification).block, "", "a goal turn or a task notification is not a brief");
    let mut hidden = facts(&session, "do the work");
    hidden.hidden_agent = true;
    assert_eq!(built(&hidden).block, "");
    let lead = header(json!({ "owner": "lead", "tools": [{ "name": "todo" }] }));
    assert_eq!(built(&facts(&lead, "do the work")).block, "");
}

#[test]
fn an_accepted_turn_clears_what_it_carried_and_a_newer_revision_staged_meanwhile_stays() {
    let mut session = staged_session();
    session.shift_remove("promptSettingsNotice");
    let reminders = built(&facts(&session, "hello"));
    let change = staged::acknowledge(&session, &reminders.revisions, NOW).expect("the turn carried pending reminders");
    let mut unset = change.unset.clone();
    unset.sort();
    assert_eq!(unset, ["orchestrationModeSwitch", "pendingSetupNotice", "workflowSwitch"]);
    // The folder change stays recorded, now as what the model has seen.
    assert_eq!(change.set["workspaceReroot"]["seen"]["cwd"], "/new");

    let mut newer = reminders.revisions;
    for revision in [&mut newer.workflow, &mut newer.orchestration, &mut newer.workspace, &mut newer.setup] {
        *revision = revision.map(|revision| revision + 100);
    }
    assert!(staged::acknowledge(&session, &newer, NOW).is_none(), "a revision staged after the turn started is not acknowledged");
}

#[test]
fn a_retried_turn_resends_its_message_and_acknowledges_only_its_settings_notice() {
    let message = json!({
        "role": "user",
        "content": "hello\n\nSETTINGS-TEXT",
        "meta": { "promptSettingsNoticeRevision": 3, "transcript": { "previousCompletions": [] } },
    });
    let session = staged_session();
    let (resent, revisions) = resubmit(&message, &session, &[], None).expect("the retry builds");
    assert_eq!(resent, message, "no agent list change: the message goes again as it was");
    assert_eq!(
        (revisions.settings, revisions.workflow, revisions.orchestration, revisions.workspace, revisions.setup, revisions.deferred),
        (Some(3), None, None, None, None, None)
    );
}
