//! Goldens of the turn review against Node's real functions (fixtures under
//! `fixtures/turn-review/`), and the behaviour of the component around them.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and a real git")]

use std::path::Path;
use std::path::PathBuf;

use base64::Engine;
use mixdog_core_api::turn_review::AgentReview;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;
use serde_json::json;
use serde_json::Value;

use super::call_diff::measure_call_changes;
use super::call_diff::patch_header_path_for_resolved;
use super::call_diff::CardDiffs;
use super::call_diff::TrackedChange;
use super::line_diff::unified_hunks_body;
use super::line_diff::Hunk;
use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::nodepath;
use super::nodepath::Style;
use super::review_diff;
use super::testing::review_at;

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-review").join(name);
    serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        spec => generate(spec),
    }
}

/// The recorder's recipes for inputs too large to keep in the fixture.
fn generate(spec: &Value) -> String {
    if spec["gen"] == "numbered" {
        let n = spec["n"].as_u64().unwrap();
        let text: String = (0..n).map(|i| format!("line {i}\n")).collect();
        return match spec.get("replace") {
            Some(pair) => text.replacen(pair[0].as_str().unwrap(), pair[1].as_str().unwrap(), 1),
            None => text,
        };
    }
    let rows = spec["rows"].as_u64().unwrap();
    let width = spec["width"].as_usize();
    let change = spec.get("change").and_then(Value::as_u64);
    let width = width.unwrap();
    let mut out = String::new();
    for i in 0..rows {
        let (head, fill) = if Some(i) == change { ("changed".to_owned(), 'y') } else { (i.to_string(), 'x') };
        out.push_str(&head);
        out.extend(std::iter::repeat_n(fill, width.saturating_sub(head.len())));
        out.push('\n');
    }
    out
}

trait AsUsize {
    fn as_usize(&self) -> Option<usize>;
}

impl AsUsize for Value {
    fn as_usize(&self) -> Option<usize> {
        self.as_u64().map(|n| n as usize)
    }
}

fn hunk_json(hunk: &Hunk) -> Value {
    json!({"oldStart": hunk.old_start, "oldLines": hunk.old_lines, "newStart": hunk.new_start, "newLines": hunk.new_lines, "lines": hunk.lines})
}

#[test]
fn line_diffs_match_node() {
    let golden = fixture("line-diff.json");
    let differ = LineDiffer::new();
    for case in golden["diffs"].as_array().unwrap() {
        let (old, new) = (text_of(&case["old"]), text_of(&case["new"]));
        let mut budget = LineDiffBudget::new(10_000_000.0);
        let set = differ.hunks(&old, &new, &mut budget, [None, None]);
        let name = &case["name"];
        assert_eq!(Value::Array(set.hunks.iter().map(hunk_json).collect()), case["hunks"], "{name}");
        assert_eq!(Value::Bool(set.exact), case["exact"], "{name}");
        assert_eq!(Value::String(unified_hunks_body("a/f", "b/f", &set.hunks)), case["body"], "{name}");
    }
}

#[test]
fn spent_budget_gives_the_replacement_hunk() {
    let golden = fixture("line-diff.json");
    let case = &golden["budgets"][0];
    let differ = LineDiffer::new();
    let mut budget = LineDiffBudget::new(case["totalMs"].as_f64().unwrap());
    for result in case["results"].as_array().unwrap() {
        let set = differ.hunks(result["old"].as_str().unwrap(), result["new"].as_str().unwrap(), &mut budget, [None, None]);
        assert_eq!(Value::Array(set.hunks.iter().map(hunk_json).collect()), result["hunks"]);
        assert_eq!(Value::Bool(set.exact), result["exact"]);
    }
}

#[test]
fn patch_headers_match_node() {
    let golden = fixture("line-diff.json");
    for case in golden["headers"].as_array().unwrap() {
        let hunks = if case["noHunks"] == true {
            Vec::new()
        } else {
            let mut budget = LineDiffBudget::new(10_000_000.0);
            LineDiffer::new().hunks("a\nb\n", "a\nc\n", &mut budget, [None, None]).hunks.clone()
        };
        let body = unified_hunks_body(case["oldHeader"].as_str().unwrap(), case["newHeader"].as_str().unwrap(), &hunks);
        assert_eq!(Value::String(body), case["body"], "{}", case["oldHeader"]);
    }
}

#[test]
fn review_bounds_match_node() {
    let golden = fixture("review-diff.json");
    for case in golden["bound"].as_array().unwrap() {
        let (patch, truncated) = review_diff::bound_review_patch(case["input"].as_str().unwrap(), case["max"].as_u64().unwrap() as usize);
        assert_eq!((Value::String(patch), Value::Bool(truncated)), (case["patch"].clone(), case["truncated"].clone()), "{}", case["name"]);
    }
    let mut budget = review_diff::ReviewPatchBudget::new(2_000_000);
    for step in golden["admit"].as_array().unwrap() {
        assert_eq!(budget.admit(step["bytes"].as_u64().unwrap() as usize), step["admitted"].as_bool().unwrap());
        assert_eq!(budget.remaining() as u64, step["remaining"].as_u64().unwrap());
    }
    for case in golden["filePatch"].as_array().unwrap() {
        let reply = review_diff::file_patch_reply(case["path"].as_str().unwrap(), case["patch"].as_str().unwrap(), case["max"].as_u64().unwrap() as usize);
        assert_eq!(Value::Object(reply), case["reply"], "{}", case["name"]);
    }
}

#[test]
fn call_diffs_match_node() {
    let golden = fixture("call-diff.json");
    let differ = LineDiffer::new();
    for case in golden["measure"].as_array().unwrap() {
        let changes = case["changes"].as_array().unwrap().iter().map(tracked).collect();
        let mut budget = LineDiffBudget::new(10_000_000.0);
        let (diff, measured) = measure_call_changes(&differ, changes, &mut budget);
        assert_eq!(Value::String(diff), case["diff"], "{}", case["name"]);
        let counts: Vec<Value> = measured.iter().map(|c| json!({"additions": c.additions.unwrap_or(0), "deletions": c.deletions.unwrap_or(0)})).collect();
        assert_eq!(Value::Array(counts), case["counts"], "{}", case["name"]);
    }
}

#[test]
fn card_registry_is_bounded_oldest_first() {
    let golden = fixture("call-diff.json");
    let cards = CardDiffs::default();
    for i in 0..70 {
        cards.register(&format!("c{i}"), "d");
    }
    let mut taken = Vec::new();
    for id in ["c0", "c5", "c6", "c69", "c69", "nope", ""] {
        taken.push(json!({"id": id, "found": cards.take(id).is_some()}));
    }
    for i in 0..64 {
        cards.register(&format!("r{i}"), "x");
    }
    cards.register("r10", "again");
    cards.register("extra", "e");
    for id in ["r0", "r1", "r10", "extra"] {
        taken.push(json!({"id": id, "found": cards.take(id).is_some()}));
    }
    assert_eq!(Value::Array(taken), golden["registry"]["taken"]);
    assert_eq!(cards.take("r10"), None);
}

fn content_of(spec: &Value) -> ReviewContent {
    if spec.is_null() {
        return ReviewContent::Absent;
    }
    if let Some(text) = spec.get("text") {
        return ReviewContent::bytes(text.as_str().unwrap().as_bytes().to_vec());
    }
    if let Some(b64) = spec.get("b64") {
        return ReviewContent::bytes(base64::engine::general_purpose::STANDARD.decode(b64.as_str().unwrap()).unwrap());
    }
    let omitted = &spec["omitted"];
    ReviewContent::Omitted { size: omitted["size"].as_u64().unwrap(), reason: omitted["reason"].as_str().map(str::to_owned) }
}

fn tracked(spec: &Value) -> TrackedChange {
    let display = spec["displayPath"].as_str().unwrap();
    let new_display = spec.get("newDisplayPath").and_then(Value::as_str);
    TrackedChange {
        path: format!("/virtual/{display}"),
        display_path: display.to_owned(),
        new_path: new_display.map(|d| format!("/virtual/{d}")),
        new_display_path: new_display.map(str::to_owned),
        before: content_of(&spec["before"]),
        after: content_of(&spec["after"]),
        additions: None,
        deletions: None,
    }
}

#[test]
fn node_paths_match_node() {
    let golden = fixture("nodepath.json");
    for (key, style) in [("win32", Style::Win32), ("posix", Style::Posix)] {
        for case in golden[key].as_array().unwrap() {
            let args: Vec<&str> = case["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
            let got = match case["fn"].as_str().unwrap() {
                "isAbsolute" => Value::Bool(nodepath::is_absolute(style, args[0])),
                "resolve" => Value::String(nodepath::resolve(style, &args)),
                _ => Value::String(nodepath::relative(style, args[0], args[1])),
            };
            assert_eq!(got, case["out"], "{key} {}", case["args"]);
        }
    }
}

#[test]
fn header_paths_are_relative_to_the_base() {
    assert_eq!(patch_header_path_for_resolved("/ws", "/ws/a/b.txt"), "a/b.txt");
}

// ── whole turns ─────────────────────────────────────────────────────────────

pub(super) fn plain(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches(r"\\?\").to_owned()
}

/// The persisted bytes of a session's file in one store directory (`""` = the turn index), clocks
/// zeroed and the scenario's directories tokenized, as the recorder's `persistedText`.
fn persisted_text(data: &Path, sub: &str, session: &str, ws: &str, data_text: &str) -> Value {
    use sha2::Digest;
    let digest: String = sha2::Sha256::digest(session.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let file = data.join("turn-snapshots").join(sub).join(format!("{}.json", &digest[..24]));
    let Ok(text) = std::fs::read_to_string(&file) else { return Value::Null };
    let clocks = regex::Regex::new(r#""(at|touched|createdAt|updatedAt|clearedAt|incompleteAt|foldedAt)":[0-9.e+-]+"#).unwrap();
    let mut text = clocks.replace_all(&text, r#""$1":0"#).into_owned();
    text = regex::Regex::new(r"\[[0-9.e+-]+,").unwrap().replace_all(&text, "[0,").into_owned();
    text = regex::Regex::new(r#""baselineTree":"[0-9a-f]+""#).unwrap().replace_all(&text, r#""baselineTree":"<tree>""#).into_owned();
    let parent = Path::new(ws).parent().unwrap().to_string_lossy().into_owned();
    for (dir, token) in [(data_text, "<data>"), (ws, "<ws>"), (parent.as_str(), "<sc>")] {
        for form in [dir.to_owned(), dir.to_lowercase()] {
            let escaped = serde_json::to_string(&form).unwrap();
            text = text.replace(&escaped[1..escaped.len() - 1], token);
        }
    }
    Value::String(text)
}

/// Node's normalisation of a result: the scenario directories become tokens, clocks zero.
fn normalize(value: &Value, ws: &str, data: &str) -> Value {
    let mut text = value.to_string();
    let parent = Path::new(ws).parent().unwrap().to_string_lossy().into_owned();
    for (dir, token) in [(data, "<data>"), (ws, "<ws>"), (parent.as_str(), "<sc>")] {
        for form in [dir.replace('\\', "\\\\"), dir.replace('\\', "/"), dir.to_owned()] {
            text = text.replace(&form, token);
        }
        let lower = dir.to_lowercase();
        for form in [lower.replace('\\', "\\\\"), lower.replace('\\', "/"), lower.clone()] {
            text = text.replace(&form, token);
        }
    }
    let re = regex::Regex::new(r#""(createdAt|updatedAt|clearedAt)":\d+(\.\d+)?"#).unwrap();
    let text = re.replace_all(&text, r#""$1":0"#).into_owned();
    serde_json::from_str(&text).unwrap()
}

fn error_json(error: &mixdog_core_api::turn_review::ReviewError) -> Value {
    json!({"error": {"name": if error.type_error { "TypeError" } else { "Error" }, "message": error.message}})
}

fn wrap(result: Result<serde_json::Map<String, Value>, mixdog_core_api::turn_review::ReviewError>) -> Value {
    match result {
        Ok(reply) => json!({"ok": reply}),
        Err(error) => error_json(&error),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn scenarios_match_node() {
    let golden = fixture("scenarios.json");
    for scenario in golden.as_array().unwrap() {
        if scenario["platform"] != std::env::consts::OS.replace("windows", "win32") {
            continue;
        }
        let name = scenario["name"].as_str().unwrap();
        run_scenario(name, scenario).await;
    }
}

async fn run_scenario(name: &str, scenario: &Value) {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let (ws, data) = (base.join("ws"), base.join("data"));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let (ws_text, data_text) = (plain(&ws), plain(&data));
    let mut review = review_at(&data);
    let mut tokens: std::collections::HashMap<String, TurnToken> = Default::default();
    let mut handles: std::collections::HashMap<String, Box<dyn AgentReview>> = Default::default();
    let mut known: std::collections::HashMap<String, String> = Default::default();
    let mut revisions: std::collections::HashMap<String, f64> = Default::default();
    let mut actual: Vec<(usize, Value)> = Vec::new();
    let full = |path: &str| PathBuf::from(nodepath::resolve_host(&[&plain(&ws), path]));
    let read_disk = |path: &str| match std::fs::read(ws.join(path)) {
        Ok(bytes) => ReviewContent::bytes(bytes),
        Err(_) => ReviewContent::Absent,
    };
    for (index, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
        let session = op.get("session").and_then(Value::as_str).unwrap_or("s1");
        let path = op.get("path").and_then(Value::as_str).unwrap_or("");
        let checkpoint = op.get("checkpoint").and_then(Value::as_str).unwrap_or("");
        match op["op"].as_str().unwrap() {
            "git" => {
                let status = std::process::Command::new("git").args(["init", "-q"]).current_dir(&ws).status().unwrap();
                assert!(status.success());
            }
            "file" => {
                std::fs::create_dir_all(full(path).parent().unwrap()).unwrap();
                let ReviewContent::Bytes(bytes) = content_of(&op["content"]) else { unreachable!() };
                std::fs::write(full(path), bytes).unwrap();
            }
            "remove" => {
                let _ = std::fs::remove_file(full(path));
            }
            "begin" => {
                let open = TurnOpen { checkpoint_id: checkpoint.to_owned(), continue_turn: op["continue"] == true };
                let token = review.begin_turn(&ws_text, session, open).await;
                actual.push((index, json!({"token": token.as_ref().map(|t| json!({"generation": t.generation, "checkpointId": t.checkpoint_id}))})));
                // The replaced turn's seal is fire-and-forget; Node's recorder reads after it landed.
                let prefix = format!("{session}\0");
                while review.inner.reg().pending_freezes.keys().any(|k| k.starts_with(&prefix)) {
                    tokio::task::yield_now().await;
                }
                if let Some(token) = token {
                    tokens.insert(session.to_owned(), token);
                }
            }
            "complete" => {
                let stale = TurnToken { generation: 99, checkpoint_id: String::new() };
                let token = if op["stale"] == true { Some(&stale) } else { tokens.get(session) };
                actual.push((index, json!({"completed": review.complete_turn(session, token).await})));
            }
            "edit" => {
                let target = full(path);
                let before = if op.get("before").is_some() { content_of(&op["before"]) } else { read_disk(path) };
                let mut change = CallChange { path: plain(&target), new_path: None, before: before.clone(), after: ReviewContent::Absent };
                if let Some(to) = op.get("to").and_then(Value::as_str) {
                    std::fs::create_dir_all(full(to).parent().unwrap()).unwrap();
                    std::fs::rename(&target, full(to)).unwrap();
                    let mut after = if op.get("after").is_some() { content_of(&op["after"]) } else { before };
                    if op.get("content").is_some() {
                        let ReviewContent::Bytes(bytes) = content_of(&op["content"]) else { unreachable!() };
                        std::fs::write(full(to), &bytes).unwrap();
                        after = ReviewContent::Bytes(bytes);
                    }
                    change.new_path = Some(plain(&full(to)));
                    change.after = after;
                } else if op["content"].is_null() {
                    let _ = std::fs::remove_file(&target);
                } else {
                    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                    let ReviewContent::Bytes(bytes) = content_of(&op["content"]) else { unreachable!() };
                    std::fs::write(&target, &bytes).unwrap();
                    change.after = if op.get("after").is_some() { content_of(&op["after"]) } else { ReviewContent::Bytes(bytes) };
                }
                match op.get("card").and_then(Value::as_str) {
                    Some(call) if op.get("to").is_none() => review.record_call(call, session, &ws_text, vec![change]).await,
                    _ => review.record_tool_changes(session, &ws_text, vec![change]).await,
                }
            }
            "card" => actual.push((index, json!({"diff": review.take_call_diff(op["call"].as_str().unwrap())}))),
            "review" => {
                let known_tag = match op.get("known").and_then(Value::as_str) {
                    Some("@last") => known.get(session).cloned(),
                    other => other.map(str::to_owned),
                };
                let read = ReviewRead { known: known_tag, summary: op["summary"] == true };
                let reply = review.turn_review_diff(&ws_text, session, read).await;
                if let Some(etag) = reply.get("etag").and_then(Value::as_str) {
                    known.insert(session.to_owned(), etag.to_owned());
                }
                actual.push((index, Value::Object(reply)));
            }
            "filePatch" => actual.push((index, Value::Object(review.turn_review_file_patch(&ws_text, session, op["file"].as_str().unwrap()).await))),
            "revert" => {
                let result = match op.get("file").and_then(Value::as_str) {
                    Some(file) => review.revert_turn_review_file(&ws_text, session, file, checkpoint).await,
                    None => review.revert_turn_review(&ws_text, session, checkpoint).await,
                };
                actual.push((index, wrap(result)));
            }
            "changes" => {
                let read = ChangesRead { checkpoint_id: checkpoint.to_owned(), patch: op["patch"] == true, file: op.get("file").and_then(Value::as_str).map(str::to_owned) };
                let result = review.turn_changes(session, read).await;
                if let Ok(reply) = &result {
                    revisions.insert(checkpoint.to_owned(), reply["revision"].as_f64().unwrap());
                }
                actual.push((index, wrap(result)));
            }
            kind @ ("undo" | "redo") => {
                let revision = match &op["revision"] {
                    Value::String(_) => revisions[checkpoint],
                    number => number.as_f64().unwrap(),
                };
                let file = op.get("file").and_then(Value::as_str);
                let result = if kind == "undo" {
                    review.revert_turn_changes(session, checkpoint, file, revision).await
                } else {
                    review.reapply_turn_changes(session, checkpoint, file, revision).await
                };
                if let Ok(reply) = &result {
                    revisions.insert(checkpoint.to_owned(), reply["revision"].as_f64().unwrap());
                }
                actual.push((index, wrap(result)));
            }
            "clearHistory" => actual.push((index, wrap(review.clear_change_history(session).await))),
            "restart" => {
                // The process is gone; the files stay. Its queued baseline writes land first.
                review.inner.baselines.settle().await;
                review = review_at(&data);
                tokens.clear();
            }
            "agentBegin" => {
                let handle = review.begin_agent_review(op["owner"].as_str().unwrap(), op["child"].as_str().unwrap(), op["agent"].as_str().unwrap(), op["tag"].as_str().unwrap());
                actual.push((index, json!({"handle": handle.is_some()})));
                if let Some(handle) = handle {
                    handles.insert(op["handle"].as_str().unwrap().to_owned(), handle);
                }
            }
            "agentComplete" => {
                let patches = op.get("patches").and_then(Value::as_array).map(|a| a.iter().map(|p| p.as_str().unwrap().to_owned()).collect()).unwrap_or_default();
                actual.push((index, json!({"joined": handles[op["handle"].as_str().unwrap()].complete(patches)})));
            }
            "forget" => review.inner.forget_session(session),
            "sessionReview" => actual.push((index, Value::Object(review.session_review_diff(&ws_text, session).await))),
            "sessionFile" => actual.push((
                index,
                Value::Object(review.session_review_file_patch(&ws_text, session, op["file"].as_str().unwrap(), op.get("oldPath").and_then(Value::as_str).unwrap_or("")).await),
            )),
            "disk" => {
                let text = match read_disk(path) {
                    ReviewContent::Bytes(bytes) => Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
                    _ => Value::Null,
                };
                actual.push((index, json!({"text": text})));
            }
            "cleared" => {
                let cleared = review.store().session_change_history_cleared(session).await;
                actual.push((index, json!({"cleared": cleared, "file": persisted_text(&data, "cleared", session, &ws_text, &data_text)})));
            }
            "baselineIndex" => actual.push((index, json!({"text": persisted_text(&data, "baselines", session, &ws_text, &data_text)}))),
            "records" => {
                let records = review.store().load_turn_change_records(session).await;
                let records: Vec<Value> = records.iter().cloned().map(Value::Object).collect();
                actual.push((index, json!({"records": records, "file": persisted_text(&data, "changes", session, &ws_text, &data_text)})));
            }
            "snapshotRecord" => {
                let mut o = serde_json::Map::new();
                if let Some(found) = review.store().load_turn_snapshot_record(session).await {
                    for key in ["generation", "checkpointId", "root", "toolFiles", "sealed"] {
                        if let Some(v) = found.get(key) {
                            o.insert(key.into(), v.clone());
                        }
                    }
                }
                o.insert("file".into(), persisted_text(&data, "", session, &ws_text, &data_text));
                actual.push((index, Value::Object(o)));
            }
            other => panic!("{name}: unknown op {other}"),
        }
    }
    let expected: Vec<(usize, Value)> = scenario["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["op"].as_u64().unwrap() as usize, r["result"].clone()))
        .collect();
    let expected: Vec<(usize, Value)> = expected
        .into_iter()
        .map(|(i, v)| if scenario["ops"][i]["op"] == "agentBegin" { (i, json!({"handle": !v["handle"].is_null()})) } else { (i, v) })
        .collect();
    let actual: Vec<(usize, Value)> = actual.into_iter().map(|(i, v)| (i, normalize(&v, &ws_text, &data_text))).collect();
    // Compared as text: key order is part of what is persisted and published.
    for (want, got) in expected.iter().zip(actual.iter()) {
        assert_eq!(want.1.to_string(), got.1.to_string(), "{name}: op {} ({})", want.0, scenario["ops"][want.0]["op"]);
    }
    assert_eq!(expected.len(), actual.len(), "{name}: result count");
}

/// Every file under `dir` with its bytes' length and a cheap checksum, for before/after comparison.
fn tree_listing(dir: &Path) -> Vec<(String, u64, u64)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, u64, u64)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                let sum = bytes.iter().fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(*b as u64));
                out.push((path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), bytes.len() as u64, sum));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// Where a review starts is recorded where the turn's snapshot is taken: the turn's own tree under its
/// checkpoint, the thread's first tree for the session, the durable record again after a restart, and
/// nothing once the thread is forgotten.
#[tokio::test(flavor = "multi_thread")]
async fn review_starts_are_recorded_at_the_snapshot_and_forgotten_with_the_thread() {
    use mixdog_app_protocol::v2::domain::ReviewScope;
    use mixdog_scm::service::ReviewBases;

    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let (ws, data) = (base.join("ws"), base.join("data"));
    std::fs::create_dir_all(&ws).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&ws).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    let ws_text = plain(&ws);
    let thread = mixdog_protocol::ThreadId::from("s1");
    let (review, bases) = super::testing::review_with_bases(&data);
    let token = review.begin_turn(&ws_text, "s1", TurnOpen { checkpoint_id: "cp1".into(), continue_turn: false }).await;
    let first = bases.base(&thread, ReviewScope::Turn, Some("cp1")).await.expect("the turn's start");
    assert_eq!(nodepath::resolve_host(&[&plain(&first.0)]), nodepath::resolve_host(&[&ws_text]));
    assert!(!first.1.0.is_empty());
    assert_eq!(bases.base(&thread, ReviewScope::Session, None).await.map(|b| b.1.0), Some(first.1.0.clone()), "the session starts at its first turn");
    std::fs::write(ws.join("a.txt"), "one\n2\n").unwrap();
    let change = CallChange { path: plain(&ws.join("a.txt")), new_path: None, before: ReviewContent::bytes(b"one\ntwo\n".to_vec()), after: ReviewContent::bytes(b"one\n2\n".to_vec()) };
    review.record_tool_changes("s1", &ws_text, vec![change]).await;
    assert!(review.complete_turn("s1", token.as_ref()).await);
    review.begin_turn(&ws_text, "s1", TurnOpen { checkpoint_id: "cp2".into(), continue_turn: false }).await;
    let second = bases.base(&thread, ReviewScope::Turn, Some("cp2")).await.expect("the second turn's start");
    assert_ne!(second.1.0, first.1.0, "the second turn starts from the edited tree");
    assert_eq!(bases.base(&thread, ReviewScope::Session, None).await.map(|b| b.1.0), Some(first.1.0.clone()), "the session start does not move");
    // A restarted process holds none; the sealed turn's durable record gives its start back.
    let (restarted, fresh) = super::testing::review_with_bases(&data);
    assert!(fresh.base(&thread, ReviewScope::Turn, Some("cp1")).await.is_none());
    assert!(restarted.restore_bases(&thread).await);
    assert_eq!(fresh.base(&thread, ReviewScope::Turn, Some("cp1")).await.map(|b| b.1.0), Some(first.1.0.clone()));
    TurnReviewApi::forget_session(&review, "s1");
    assert!(bases.base(&thread, ReviewScope::Turn, Some("cp1")).await.is_none() && bases.base(&thread, ReviewScope::Session, None).await.is_none());
}

/// The baseline tree and tool baselines live in the shadow repository (borrowing the user's
/// objects through `objects/info/alternates`): the user's `.git` gains no object, no ref and no
/// index change from a whole turn, its session review and its undo.
#[tokio::test(flavor = "multi_thread")]
async fn user_repository_is_never_written() {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let (ws, data) = (base.join("ws"), base.join("data"));
    std::fs::create_dir_all(&ws).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&ws).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    let before = tree_listing(&ws.join(".git"));
    let ws_text = plain(&ws);
    let review = review_at(&data);
    let token = review.begin_turn(&ws_text, "s1", TurnOpen { checkpoint_id: "cp1".into(), continue_turn: false }).await;
    std::fs::write(ws.join("a.txt"), "one\n2\n").unwrap();
    std::fs::write(ws.join("b.txt"), "new\n").unwrap();
    let change = |path: &str, before: ReviewContent, after: &str| CallChange { path: plain(&ws.join(path)), new_path: None, before, after: ReviewContent::bytes(after.as_bytes().to_vec()) };
    review.record_tool_changes("s1", &ws_text, vec![change("a.txt", ReviewContent::bytes(b"one\ntwo\n".to_vec()), "one\n2\n"), change("b.txt", ReviewContent::Absent, "new\n")]).await;
    let reply = review.turn_review_diff(&ws_text, "s1", ReviewRead::default()).await;
    assert_eq!(reply["files"].as_array().unwrap().len(), 2);
    assert!(review.complete_turn("s1", token.as_ref()).await);
    review.session_review_diff(&ws_text, "s1").await;
    review.revert_turn_review(&ws_text, "s1", "cp1").await.unwrap();
    assert_eq!(tree_listing(&ws.join(".git")), before, "the user's .git changed");
    // The baseline lives in the shadow repository: one directory under the snapshot store, with
    // the user's objects borrowed.
    let shadows: Vec<PathBuf> = std::fs::read_dir(data.join("turn-worktree-snapshots-v1")).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(shadows.len(), 1);
    let name = shadows[0].file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.len() == 24 && name.bytes().all(|b| b.is_ascii_hexdigit()), "{name}");
    let alternates = std::fs::read_to_string(shadows[0].join("objects").join("info").join("alternates")).unwrap();
    assert!(alternates.lines().any(|l| nodepath::resolve_host(&[l]) == nodepath::resolve_host(&[&plain(&ws.join(".git").join("objects"))])), "{alternates}");
    assert!(shadows[0].join("objects").read_dir().unwrap().count() > 2, "the baseline objects are in the shadow repository");
}
