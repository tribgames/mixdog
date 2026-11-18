//! Whole call sequences over delimited files through the Office tool.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::support::{Harness, find};

fn session_of(answer: &Value) -> String {
    answer["session"].as_str().unwrap_or_else(|| panic!("no session in {answer}")).to_owned()
}

#[test]
fn describe_lists_the_actions_and_a_misspelled_operation_names_the_nearest() {
    let office = Harness::new();
    let answer = office.call(json!({ "action": "describe" }));
    let actions: Vec<&str> = answer["actions"].as_array().expect("actions").iter().map(|name| name.as_str().expect("name")).collect();
    assert_eq!(
        actions,
        [
            "detect", "transactions", "recover", "describe", "author", "create", "attach", "open", "secure", "begin", "snapshot", "get", "query", "batch",
            "diff", "commit", "rollback", "issues", "qa", "validate", "render", "save", "finalize", "close"
        ]
    );
    let unknown = office.call(json!({ "action": "describe", "format": "xlsx", "operation": "add_chrt" }));
    assert_eq!(
        unknown["error"],
        "Error: Unknown XLSX operation \"add_chrt\". Did you mean: add_chart? Call describe with format:\"xlsx\" to list operations."
    );
}

#[test]
fn a_call_cancelled_before_it_starts_answers_cancelled_and_does_nothing() {
    let office = Harness::new();
    let text = office.text_of(json!({ "action": "create", "path": "never.csv", "format": "csv" }), true);
    let answer: Value = serde_json::from_str(&text).expect("json");
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["code"], "cancelled");
    assert_eq!(answer["message"], "Office Use operation was cancelled");
    assert!(!office.docs.join("never.csv").exists());
}

#[test]
fn creating_a_delimited_file_with_initial_operations_writes_them_and_opens_an_owned_session() {
    let office = Harness::new();
    let answer = office.call(json!({ "action": "create", "path": "table.csv", "operations": [{ "op": "append_row", "values": ["original"] }] }));
    assert_eq!(answer["mode"], "portable");
    assert_eq!(answer["backend"], "mixdog-tabular");
    assert_eq!(answer["fileKind"], "csv");
    assert_eq!(answer["ownership"], "owned");
    assert_eq!(answer["batch"]["ok"], true);
    assert!(office.read("table.csv").contains("original"));
}

#[test]
fn opening_with_an_output_edits_a_copy_and_leaves_the_source_alone() {
    let office = Harness::new();
    office.put("table.csv", "name,n\nrow,1\n");
    let answer = office.call(json!({ "action": "open", "path": "table.csv", "output": "edited.csv", "mode": "portable", "operations": [{ "op": "append_row", "values": ["edited", 2] }] }));
    assert_eq!(answer["backend"], "mixdog-tabular");
    assert_eq!(office.read("table.csv"), "name,n\nrow,1\n", "the source is untouched");
    let edited = office.read("edited.csv").replace("\r\n", "\n");
    assert!(edited.starts_with("name,n\nrow,1"), "{edited}");
    assert!(edited.contains("edited,2"), "{edited}");
}

#[test]
fn a_portable_open_works_on_a_copy_beside_the_source() {
    let office = Harness::new();
    office.put("hubs.csv", "a,b\n1,2\n");
    let opened = office.call(json!({ "action": "open", "path": "hubs.csv", "mode": "portable" }));
    let output = opened["output"].as_str().expect("output").replace('\\', "/");
    assert!(output.ends_with("/hubs.mixdog-edit.csv"), "{output}");
    let session = session_of(&opened);
    office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "cell": "A1", "value": "changed" }] }));
    assert_eq!(office.read("hubs.csv"), "a,b\n1,2\n");
    assert!(office.read("hubs.mixdog-edit.csv").starts_with("changed,b"));
}

#[test]
fn the_issues_of_a_delimited_file_name_ragged_rows_and_values_a_spreadsheet_would_execute() {
    let office = Harness::new();
    office.put("hubs.csv", "지점,출고,비고\n대전,48210,정상\n광주,31880\n부산,40120,=HYPERLINK(\"http://example.com\",\"확인\")\n");
    let session = session_of(&office.call(json!({ "action": "open", "path": "hubs.csv", "mode": "portable" })));
    let answer = office.call(json!({ "action": "issues", "session": session }));
    assert_eq!(answer["issueCount"], 3);
    let issues = answer["issues"].as_array().expect("issues");
    assert_eq!(issues[0]["code"], "ragged_row");
    assert_eq!(issues[0]["path"], "/row[3]");
    assert_eq!(issues[0]["message"], "Row has 2 column(s); the file's rows are 3 wide.");
    assert_eq!(issues[1]["path"], "/row[4]");
    assert_eq!(issues[2]["code"], "formula_like_value");
    assert_eq!(issues[2]["path"], "/sheet[hubs]/cell[C4]");
    assert_eq!(issues[2]["message"], "Value may execute as a formula when opened by spreadsheet software.");
}

#[test]
fn a_rolled_back_transaction_restores_the_file_and_the_cell() {
    let office = Harness::new();
    let session = session_of(&office.call(json!({ "action": "create", "path": "table.csv", "operations": [{ "op": "set_range", "range": "A1:B2", "values": [["name", "n"], ["row", 1]] }] })));
    let target = "/sheet[table]/cell[A1]";
    assert_eq!(office.call(json!({ "action": "get", "session": session, "target": target }))["element"]["value"], "name");
    office.call(json!({ "action": "begin", "session": session }));
    let changed = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "sheet": "table", "cell": "A1", "value": "temporary" }] }));
    assert_eq!(changed["ok"], true);
    assert_eq!(office.call(json!({ "action": "get", "session": session, "target": target }))["element"]["value"], "temporary");
    let rolled = office.call(json!({ "action": "rollback", "session": session }));
    assert_eq!(rolled["rolledBack"], true);
    assert_eq!(rolled["fingerprintRestored"], true);
    assert_eq!(office.call(json!({ "action": "get", "session": session, "target": target }))["element"]["value"], "name");
    assert!(office.read("table.csv").starts_with("name,n"));
}

#[test]
fn a_snapshot_is_read_in_pages_by_cursor_and_a_cursor_goes_stale_when_the_document_changes() {
    let office = Harness::new();
    let rows: Vec<Value> = (1..=2505).map(|n| json!([format!("row-{n}")])).collect();
    let session = session_of(&office.call(json!({ "action": "create", "path": "large.csv", "operations": [{ "op": "set_range", "range": "A1:A2505", "values": rows }] })));
    let first = office.call(json!({ "action": "snapshot", "session": session, "limit": 1000 }));
    let cells = first["document"]["sheets"][0]["cells"].as_array().expect("cells");
    assert!(cells.len() <= 1000 && !cells.is_empty());
    assert_eq!(cells[0]["ref"], "A1");
    let cursor = find(&first, "nextCursor").and_then(Value::as_str).expect("a continuation").to_owned();
    let second = office.call(json!({ "action": "snapshot", "session": session, "cursor": cursor }));
    let next = second["document"]["sheets"][0]["cells"].as_array().expect("cells");
    assert_eq!(next[0]["ref"], format!("A{}", cells.len() + 1), "the next page starts where the first stopped");
    let later = find(&second, "nextCursor").and_then(Value::as_str).expect("another continuation").to_owned();
    office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "sheet": "large", "cell": "A1", "value": "changed" }] }));
    let stale = office.call(json!({ "action": "snapshot", "session": session, "cursor": later }));
    assert_eq!(stale["error"], "Error: Office snapshot cursor is stale because the document changed");
}

#[test]
fn finalizing_a_delimited_session_saves_closes_and_reviews_it() {
    let office = Harness::new();
    let session = session_of(&office.call(json!({ "action": "create", "path": "table.csv", "operations": [{ "op": "set_range", "range": "A1:B2", "values": [["name", "n"], ["row", 1]] }] })));
    let done = office.call(json!({ "action": "finalize", "session": session }));
    assert_eq!(done["ok"], true);
    assert_eq!(done["finalized"], true);
    assert_eq!(done["closed"], true);
    let after = office.call(json!({ "action": "get", "session": session, "target": "/sheet[table]/cell[A1]" }));
    assert!(after["error"].is_string(), "a closed session answers with an error: {after}");
}

#[test]
fn calls_made_together_each_from_its_own_thread_all_answer() {
    let office = Harness::new();
    let engine = Arc::clone(&office.engine);
    let answers = Arc::new(Mutex::new(Vec::new()));
    let threads: Vec<_> = (0..12)
        .map(|_| {
            let (engine, answers, docs, data) = (Arc::clone(&engine), Arc::clone(&answers), office.docs.clone(), office.data.clone());
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
                let (result, _) = runtime.block_on(engine.execute(json!({ "action": "describe", "format": "csv" }), docs, Some(data), None, mixdog_rt::CancellationToken::new()));
                answers.lock().expect("lock").push(result["content"][0]["text"].as_str().expect("text").to_owned());
            })
        })
        .collect();
    for thread in threads {
        thread.join().expect("a call that answered");
    }
    let answers = answers.lock().expect("lock");
    assert_eq!(answers.len(), 12);
    assert!(answers.iter().all(|text| text == &answers[0]));
}

fn csv_session(office: &Harness) -> String {
    session_of(&office.call(json!({ "action": "create", "path": "table.csv", "operations": [{ "op": "set_range", "range": "A1:B2", "values": [["name", "n"], ["row", 1]] }] })))
}

#[test]
fn a_committed_transaction_keeps_its_edit_and_the_diff_before_it_names_the_change() {
    let office = Harness::new();
    let session = csv_session(&office);
    office.call(json!({ "action": "begin", "session": session }));
    office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "sheet": "table", "cell": "A2", "value": "edited" }] }));
    let diff = office.call(json!({ "action": "diff", "session": session }));
    assert_eq!(find(&diff, "modified").and_then(Value::as_u64), Some(1), "{diff}");
    let committed = office.call(json!({ "action": "commit", "session": session }));
    assert_eq!(committed["ok"], true, "{committed}");
    assert!(office.read("table.csv").replace("\r\n", "\n").contains("edited,1"));
}

/// The rule: after every operation of a transaction the session remembers the document's fingerprint and its read; commit and
/// rollback read the document again first and refuse when the fingerprint is not the remembered one, so that a change made
/// outside is never overwritten. The refusal carries both fingerprints and the diff of the remembered read against the new one.
#[test]
fn a_document_changed_by_another_program_during_a_transaction_blocks_commit_and_rollback_and_names_the_cells() {
    let office = Harness::new();
    let session = csv_session(&office);
    let begun = office.call(json!({ "action": "begin", "session": session }));
    let transaction = begun["transaction"]["id"].as_str().expect("a transaction id").to_owned();
    office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "sheet": "table", "cell": "A2", "value": "mine" }] }));
    office.put("table.csv", "name,n\nsomeone else,9\n");
    for action in ["commit", "rollback"] {
        let blocked = office.call(json!({ "action": action, "session": session }));
        assert_eq!(blocked["ok"], false, "{action}: {blocked}");
        assert_eq!(blocked["code"], "transaction_conflict", "{action}");
        assert_eq!(blocked["session"], session);
        assert_eq!(blocked["transaction"], transaction);
        assert_eq!(
            blocked["message"],
            "The document changed outside Mixdog after the last transaction operation. Commit and rollback are blocked to avoid overwriting user edits."
        );
        assert_ne!(blocked["expectedFingerprint"], blocked["actualFingerprint"]);
        assert!(blocked["actualFingerprint"].is_string());
        let diff = &blocked["externalDiff"];
        assert_eq!(diff["summary"]["modified"], 2, "{diff}");
        let changes = diff["changes"].as_array().expect("changes");
        let paths: Vec<&str> = changes.iter().map(|change| change["path"].as_str().expect("path")).collect();
        assert_eq!(paths, ["/sheet[table]/cell[A2]", "/sheet[table]/cell[B2]"]);
        assert!(changes.iter().all(|change| change["kind"] == "modified"));
    }
    assert!(office.read("table.csv").contains("someone else"), "the other program's text is not overwritten");
}
