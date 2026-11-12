//! Replay of Node's K1 recordings `fixtures/store-summary-workspace-cases` and `fixtures/store-summary-visibility-cases`
//! (`record-store-summary-*-cases.mjs`, b6f10295a): the catalog row the store builds ([`catalog_row`], the one builder of the live upsert
//! and of `project_index`) from the session documents the Node tests built, `workspaceSummary`, and the visibility of
//! agent-owned rows. Every value is compared whole, in recorded order, with Node's.
//!
//! The message-derived fields come from [`MessageRow`], the product's per-message projection. The recorded `storageMtimeMs` and
//! `storageSize` of a listed row are the file stat Node's reader added; the store's header carries them the same way.

use mixdog_testkit::Exact;
use serde_json::{Map, Value};

use crate::message_state::MessageRow;
use crate::summary::{CatalogHead, MessageStats, catalog_row, session_visibility, workspace_summary};

const WORKSPACE: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/store-summary-workspace-cases/golden.json");
const VISIBILITY: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/store-summary-visibility-cases/golden.json");

fn case(golden: &str, name: &str) -> Exact {
    let value: Value = serde_json::from_str(golden).expect("golden is JSON");
    let recorded = Exact::decode(&value).expect("golden decodes");
    recorded
        .get("cases")
        .as_array()
        .iter()
        .find(|c| c.get("case").as_str() == name)
        .unwrap_or_else(|| panic!("no recorded case {name:?}"))
        .get("observed")
        .clone()
}

fn plain(value: &Exact) -> Value {
    value.to_plain().expect("recorded value holds no tagged part")
}

/// The stats the product's per-message projection gives the messages of a session document.
fn stats(messages: &[Value]) -> MessageStats {
    let rows: Vec<MessageRow> = messages.iter().map(MessageRow::of).collect();
    let last = rows.iter().rev().find(|r| !r.line.is_empty());
    MessageStats {
        count: rows.iter().filter(|r| r.counted).count() as u64,
        real: rows.iter().filter(|r| r.real).count() as u64,
        incoming: None,
        preview: rows.iter().find(|r| !r.preview.is_empty()).map(|r| r.preview.clone()).unwrap_or_default(),
        last: last.map(|r| r.line.clone()).unwrap_or_default(),
        last_routine: last.map(|r| serde_json::from_str(&r.routine).expect("routine text")).unwrap_or(Value::Null),
    }
}

/// The summary of a session document as the store's catalog row holds it.
fn summary_of(document: &Value, extra: &[(&str, Value)]) -> Value {
    let mut header = document.as_object().expect("a session document").clone();
    let messages = header.remove("messages").map(|m| m.as_array().cloned().unwrap_or_default()).unwrap_or_default();
    for (key, value) in extra {
        header.insert((*key).to_owned(), value.clone());
    }
    let id = header.get("id").and_then(Value::as_str).expect("a session id").to_owned();
    let head = CatalogHead { session: id, log_id: String::new(), base_session: None, header };
    serde_json::from_str(&catalog_row(&head, &stats(&messages), 0.0).summary).expect("the summary is JSON")
}

fn same(actual: &Value, expected: &Exact, what: &str) {
    if let Some(difference) = Exact::plain(actual).difference(expected) {
        panic!("{what}: {difference}");
    }
}

#[test]
fn workspace_summary_carries_the_whole_workspace_record_and_requires_both_paths() {
    let recorded = case(&WORKSPACE, "workspaceSummary carries the whole workspace record and requires both paths");
    for (index, entry) in recorded.get("results").as_array().iter().enumerate() {
        let input = plain(entry.get("input"));
        let actual = workspace_summary(Some(&input)).unwrap_or(Value::Null);
        same(&actual, entry.get("result"), &format!("result {index} for {input}"));
    }
}

#[test]
fn summary_rows_expose_the_workspace_while_grouping_stays_on_the_project() {
    let recorded = case(&WORKSPACE, "summary rows expose the workspace while grouping stays on the project");
    let summary = summary_of(&plain(recorded.get("session")), &[]);
    same(&summary, recorded.get("summary"), "the summary row");
    // the index's normalised row is the row itself (its desktop session carries the project grouping)
    let indexed = recorded.get("normalizedIndex").get("rows").as_array();
    assert_eq!(indexed.len(), 1);
    same(&summary, &indexed[0], "the indexed row");
}

#[test]
fn a_session_without_a_workspace_record_has_no_workspace_field() {
    let recorded = case(&WORKSPACE, "a session without a workspace record has no workspace field");
    let summary = summary_of(&plain(recorded.get("session")), &[]);
    same(&summary, recorded.get("summary"), "the summary row");
    assert!(summary.get("workspace").is_none());
}

#[test]
fn summary_visibility_is_durable_and_classifies_legacy_agent_owned_children() {
    let recorded = case(&VISIBILITY, "summary visibility is durable and classifies legacy Agent-owned children");
    for (input, summaries) in [
        ("legacyInput", &["legacySummary", "normalizedWithoutVisibility"][..]),
        ("nestedInput", &["nestedSummary", "normalizedNested"][..]),
        ("rootLeadInput", &["rootLeadSummary"][..]),
    ] {
        let summary = summary_of(&plain(recorded.get(input)), &[]);
        for name in summaries {
            same(&summary, recorded.get(name), name);
        }
        let header: Map<String, Value> = plain(recorded.get(input)).as_object().unwrap().clone();
        assert_eq!(Value::from(session_visibility(&header)), summary["visibility"], "{input}");
    }
}

#[test]
fn catalogs_expose_agent_sessions_while_preserving_their_presentation_classification() {
    let recorded = case(&VISIBILITY, "catalogs expose agent sessions while preserving their presentation classification");
    let records = recorded.get("records").as_array();
    let listed = recorded.get("internalSummaries").as_array();
    assert_eq!(records.len(), listed.len());
    let mut rows = Vec::new();
    for expected in listed {
        let id = expected.get("id").as_str();
        let record = records.iter().find(|r| r.get("id").as_str() == id).expect("a recorded record per listed row");
        let stat = [("storageMtimeMs", plain(expected.get("storageMtimeMs"))), ("storageSize", plain(expected.get("storageSize")))];
        let summary = summary_of(&plain(record), &stat);
        same(&summary, expected, id);
        rows.push(summary);
    }
    // the ordinary listing holds every row, agent-only ones included
    let ordinary = recorded.get("ordinarySummaries").as_array();
    assert_eq!(ordinary.len(), rows.len());
    for (row, expected) in rows.iter().zip(ordinary) {
        assert_eq!(row["id"], plain(expected.get("id")));
        assert_eq!(row["visibility"], plain(expected.get("visibility")), "{}", row["id"]);
    }
    same(&rows[1], recorded.get("durableLegacyChild"), "the durable row of the legacy child");
}
