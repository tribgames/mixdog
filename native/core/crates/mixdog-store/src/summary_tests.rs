//! The catalog row the store builds from a session header ([`catalog_row`], the one builder of the live upsert and of
//! `project_index`): the workspace record it carries and the visibility it gives an agent-owned session.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::summary::CatalogHead;
use crate::summary::MessageStats;
use crate::summary::catalog_row;
use crate::summary::session_visibility;
use crate::summary::workspace_summary;

fn header(value: Value) -> Map<String, Value> {
    value.as_object().expect("a header object").clone()
}

fn row(header: Map<String, Value>) -> (crate::sqlite::CatalogRow, Value) {
    let id = header.get("id").and_then(Value::as_str).expect("an id").to_owned();
    let head = CatalogHead { session: id, log_id: String::new(), base_session: None, header };
    let row = catalog_row(&head, &MessageStats::default(), 0.0);
    let summary = serde_json::from_str(&row.summary).expect("the summary is JSON");
    (row, summary)
}

#[test]
fn a_workspace_needs_a_project_path_and_a_working_directory() {
    assert_eq!(workspace_summary(None), None);
    assert_eq!(workspace_summary(Some(&json!("not an object"))), None);
    for incomplete in [
        json!({"cwd": "/w"}),
        json!({"projectPath": "/p"}),
        json!({"projectPath": "  ", "cwd": "/w"}),
        json!({"projectPath": "/p", "cwd": 7}),
        json!({"projectPath": "/p\u{0}x", "cwd": "/w"}),
        json!({"projectPath": "/p", "cwd": "/w\u{0}"}),
    ] {
        assert_eq!(workspace_summary(Some(&incomplete)), None, "{incomplete}");
    }
}

#[test]
fn a_workspace_summary_carries_the_whole_record_trimmed_with_blank_fields_null() {
    let workspace = json!({
        "projectPath": " /p ", "repoCommonDir": "/p/.git", "cwd": "/p/wt", "worktreeId": "wt1", "branch": "feat",
        "baseCommit": "abc123", "mergeTarget": "main", "revision": 4,
        "transition": {"state": "switching", "txId": " tx-9 "},
    });
    assert_eq!(
        workspace_summary(Some(&workspace)),
        Some(json!({
            "projectPath": "/p", "repoCommonDir": "/p/.git", "cwd": "/p/wt", "worktreeId": "wt1", "branch": "feat",
            "baseCommit": "abc123", "mergeTarget": "main", "revision": 4,
            "transition": {"state": "switching", "txId": "tx-9"},
        }))
    );
    assert_eq!(
        workspace_summary(Some(&json!({"projectPath": "/p", "cwd": "/w", "branch": "  "}))),
        Some(json!({
            "projectPath": "/p", "repoCommonDir": null, "cwd": "/w", "worktreeId": null, "branch": null, "baseCommit": null,
            "mergeTarget": null, "revision": 0, "transition": {"state": "idle", "txId": null},
        }))
    );
}

#[test]
fn an_unknown_transition_or_a_bad_revision_falls_back_to_idle_and_zero() {
    let base = |extra: Value| {
        let mut workspace = json!({"projectPath": "/p", "cwd": "/w"});
        workspace.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        workspace_summary(Some(&workspace)).unwrap()
    };
    for revision in [json!(-1), json!(1.5), json!("3"), json!(null)] {
        assert_eq!(base(json!({ "revision": revision }))["revision"], 0, "{revision}");
    }
    assert_eq!(base(json!({"transition": {"state": "exploding", "txId": "t"}}))["transition"], json!({"state": "idle", "txId": null}));
    // An idle transition drops its id; a busy one without an id keeps the state's fallback.
    assert_eq!(base(json!({"transition": {"state": "idle", "txId": "t"}}))["transition"], json!({"state": "idle", "txId": null}));
    assert_eq!(base(json!({"transition": {"state": "removing", "txId": ""}}))["transition"], json!({"state": "idle", "txId": null}));
    for state in ["provisioning", "switching", "removing", "recovery"] {
        assert_eq!(base(json!({"transition": {"state": state, "txId": "t"}}))["transition"], json!({"state": state, "txId": "t"}));
    }
}

#[test]
fn the_row_exposes_the_workspace_while_grouping_stays_on_the_project() {
    let (row, summary) = row(header(json!({
        "id": "s1", "cwd": "/p/wt", "desktopSession": {"classification": "project", "projectPath": "/p"},
        "workspace": {"projectPath": "/p", "cwd": "/p/wt", "branch": "feat"},
    })));
    assert_eq!(summary["workspace"]["cwd"], "/p/wt");
    assert_eq!(summary["workspace"]["branch"], "feat");
    assert_eq!(summary["desktopSession"], json!({"classification": "project", "projectPath": "/p"}));
    assert_eq!(row.project_path.as_deref(), Some("/p"), "the project the session is grouped under is not the worktree");
    assert_eq!(row.cwd.as_deref(), Some("/p/wt"));
}

#[test]
fn a_session_without_a_usable_workspace_record_has_no_workspace_field() {
    for header_json in [json!({"id": "s1"}), json!({"id": "s1", "workspace": {"cwd": "/w"}})] {
        let (_, summary) = row(header(header_json));
        assert!(summary.get("workspace").is_none(), "{summary}");
    }
}

#[test]
fn a_root_lead_and_an_ordinary_session_are_ordinary() {
    for h in [
        json!({"id": "s1", "agent": "Lead"}),
        json!({"id": "s1", "agent": "lead", "ownerSessionId": "s1"}),
        json!({"id": "s1", "agent": "lead", "owner": "agent", "parentSessionId": "s1"}),
        json!({"id": "s1"}),
        json!({"id": "s1", "owner": "user", "parentSessionId": "p"}),
    ] {
        assert_eq!(session_visibility(&header(h.clone())), "ordinary", "{h}");
    }
}

#[test]
fn a_session_an_agent_owns_under_another_session_is_agent_only() {
    for h in [
        json!({"id": "c", "owner": "agent", "parentSessionId": "p"}),
        json!({"id": "c", "owner": "Agent", "ownerSessionId": "p"}),
        json!({"id": "c", "visibility": "agent-only"}),
        json!({"id": "c", "sessionVisibility": " Agent-Only "}),
        json!({"id": "c", "agent": "lead", "owner": "agent", "parentSessionId": "p"}),
    ] {
        assert_eq!(session_visibility(&header(h.clone())), "agent-only", "{h}");
    }
    // A parent link that is not a stored session id is no parent.
    assert_eq!(session_visibility(&header(json!({"id": "c", "owner": "agent", "parentSessionId": "not an id"}))), "ordinary");
}

#[test]
fn the_row_keeps_the_visibility_and_the_owner_link_of_a_legacy_agent_child() {
    let (row, summary) = row(header(json!({"id": "c", "owner": "agent", "parentSessionId": "p", "agent": "worker"})));
    assert_eq!(summary["visibility"], "agent-only");
    assert_eq!(row.visibility.as_deref(), Some("agent-only"));
    assert_eq!(summary["parentSessionId"], "p");
    assert_eq!(summary["ownerSessionId"], "p", "the parent stands in when no owner is recorded");
    assert_eq!(row.owner_session_id.as_deref(), Some("p"));

    let (_, root) = row_of(json!({"id": "r", "agent": "lead"}));
    assert_eq!(root["visibility"], "ordinary");
    assert_eq!(root["owner"], "user", "an unowned session is the user's");
}

fn row_of(h: Value) -> (crate::sqlite::CatalogRow, Value) {
    row(header(h))
}

#[test]
fn a_catalog_cursor_names_the_activity_and_id_of_a_row_and_refuses_anything_else() {
    use crate::sqlite::lead::decode_catalog_cursor;
    use crate::sqlite::lead::encode_catalog_cursor;
    // The activity is the last use when there is one, else the last update; the cursor is base64url of `[activity,id]`.
    let used = header(json!({"id": "e", "updatedAt": 1, "lastUsedAt": 40}));
    assert_eq!(encode_catalog_cursor(&used), "WzQwLCJlIl0");
    let cursor = decode_catalog_cursor(Some("WzQwLCJlIl0")).unwrap().unwrap();
    assert_eq!((cursor.activity, cursor.id.as_str()), (40.0, "e"));
    assert_eq!(encode_catalog_cursor(&header(json!({"id": "e", "updatedAt": 40}))), "WzQwLCJlIl0");
    // Extra elements are ignored; no cursor is none.
    let extra = decode_catalog_cursor(Some("WzMwLjUsImIiLCJleHRyYSJd")).unwrap().unwrap();
    assert_eq!((extra.activity, extra.id.as_str()), (30.5, "b"));
    assert!(decode_catalog_cursor(None).unwrap().is_none() && decode_catalog_cursor(Some("")).unwrap().is_none());
    for bad in ["not base64!!", "e30", "WyJ4IiwiaWQiXQ", "WzFd"] {
        assert!(decode_catalog_cursor(Some(bad)).is_err(), "{bad}");
    }
}

#[test]
fn the_lead_list_shows_the_users_and_leads_sessions_and_hides_scratch_and_exec_runs() {
    use crate::sqlite::lead::is_lead_visible_row;
    let visible = |row: Value| is_lead_visible_row(&header(row));
    assert!(visible(json!({"id": "a", "preview": "hi", "messageCount": 1})), "an unattributed user session");
    assert!(visible(json!({"id": "a", "agent": "Lead", "sourceType": "other", "preview": "x"})));
    for source in ["lead", "cli", "schedule", "webhook"] {
        assert!(visible(json!({"id": "a", "sourceType": source, "preview": "x"})), "{source}");
    }
    assert!(visible(json!({"id": "c", "owner": "agent", "parentSessionId": "p", "preview": "x"})), "an agent's session is listed");
    assert!(!visible(json!({"id": "a", "preview": "", "messageCount": 0})), "no preview, no messages, no title: scratch");
    assert!(visible(json!({"id": "a", "preview": "", "messageCount": 0, "title": "named"})));
    assert!(!visible(json!({"id": "a", "sourceType": "exec", "agent": "lead", "preview": "x"})));
    assert!(!visible(json!({"id": "a", "owner": "plugin", "preview": "x"})), "another owner's session");
    assert!(!visible(json!({"id": "a", "sourceType": "bridge", "preview": "x"})), "a session of some other source");
    assert!(!visible(json!({"id": "a", "sourceName": "bot", "preview": "x"})), "a named source that is not the user's");
}
