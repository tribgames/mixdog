//! `execution-tail.test.mjs` (every case after :21): Node's recorded outputs
//! (`fixtures/execution-tail/golden.json`, `benchmarks/rust-core/recorders/record-execution-tail.mjs`) against the
//! core's own compaction over the same stored rows: each row read as the run reads it (`message_of`, registered in
//! the run's `StoredRows`), compacted by `build_execution_tail` / `fresh_context_compact_messages` (or the session's
//! compactor) over the data dir's tool-result archive, and written back as the commit writes it (`row_of`). The
//! whole output of each step and every archive file it reaches are compared. A data dir is written `<DATA>` and a
//! content hash `<Hn>` (numbered in order of appearance), since both follow the host's temp dir.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::execution_tail::{TailContext, TailOptions, build_execution_tail, tool_history_budget};
use mixdog_agent::compact::fresh::{FreshContext, FreshOptions, fresh_context_compact_messages};
use mixdog_agent::compact::summary_run::{SummaryFailure, SummarySender};
use mixdog_agent::env::{CompactRequest, CompactTrigger};
use mixdog_agent::message::AgentMessage;
use mixdog_agent::offload::ArtifactStore;
use mixdog_ai::providers::openai::input::{LowerOptions, ToolSearchReplay, lower};
use mixdog_core_session::session::StoredRows;
use mixdog_protocol::ProviderId;
use serde_json::{Value, json};

use super::compaction_node_harness::{NoAttachments, NoSummary, World, archive, media, session_compactor};
use super::compactors::CompactionRows;
use super::message_row::{message_of, row_of};
use super::summary_routes::{MaintainerRoute, SessionRoute, SummaryHost};

const GOLDEN: &str = include_str!("../../../../fixtures/execution-tail/golden.json");

/// The run's messages of `rows`, each registered as read from its stored row.
fn messages_of(rows: &[Value], stored: &StoredRows) -> Vec<AgentMessage> {
    rows.iter()
        .map(|row| {
            let message = message_of(row).unwrap_or_else(|e| panic!("{e}: {row}"));
            stored.record(&message, row.clone());
            message
        })
        .collect()
}

fn rows_of(messages: &[AgentMessage]) -> Vec<Value> {
    messages.iter().map(row_of).collect()
}

/// What a step was given: its own rows, or the previous step's output (plus appended rows).
fn input_rows(input: &Value, previous: &[Value]) -> Vec<Value> {
    match input {
        Value::Array(rows) => rows.clone(),
        Value::Null => Vec::new(),
        Value::String(text) if text == "<previous>" => previous.to_vec(),
        Value::Object(o) if o.get("previous") == Some(&json!(true)) => previous.iter().chain(o["append"].as_array().unwrap()).cloned().collect(),
        other => panic!("input {other}"),
    }
}

/// The session the stub route of :302 runs on: the conversation's own model, never asked.
struct StubHost;
#[async_trait]
impl SummaryHost for StubHost {
    fn session(&self) -> SessionRoute {
        SessionRoute { provider: "stub".into(), model: "stub-model".into(), context_window: Some(500_000) }
    }
    fn maintainer_route(&self) -> Option<MaintainerRoute> {
        None
    }
    async fn provider_ready(&self, _: &str, _: bool) -> Result<bool, SummaryFailure> {
        Ok(true)
    }
    fn whole_window(&self, _: &str, _: &str) -> u64 {
        500_000
    }
    fn calibration(&self, _: &str, _: &str) -> f64 {
        1.0
    }
    fn sender(&self, _: &str) -> Arc<dyn SummarySender> {
        Arc::new(NoSummary)
    }
    async fn saved_catalog(&self, _: &str) -> Option<Vec<Value>> {
        None
    }
}

struct Replay {
    data: PathBuf,
    previous: Vec<Value>,
}

impl Replay {
    /// A recorded text with each `<DATA>/…` path written back as the path Node wrote (native separators).
    fn restored(&self, text: &str) -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(at) = rest.find("<DATA>/") {
            out.push_str(&rest[..at]);
            let tail = &rest[at + "<DATA>/".len()..];
            let end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || "_.-/".contains(c))).unwrap_or(tail.len());
            let path = tail[..end].split('/').fold(self.data.clone(), |p, s| p.join(s));
            out.push_str(&path.to_string_lossy());
            rest = &tail[end..];
        }
        out.push_str(rest);
        out
    }

    /// A recorded body: a JSON body has its strings restored and is written back as Node's `JSON.stringify` wrote it.
    fn restored_text(&self, text: &str) -> String {
        fn walk(r: &Replay, v: Value) -> Value {
            match v {
                Value::String(s) => Value::String(r.restored(&s)),
                Value::Array(items) => Value::Array(items.into_iter().map(|v| walk(r, v)).collect()),
                Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, walk(r, v))).collect()),
                other => other,
            }
        }
        match serde_json::from_str::<Value>(text) {
            Ok(value @ (Value::Object(_) | Value::Array(_))) => mixdog_js::json_stringify(&walk(self, value)),
            _ => self.restored(text),
        }
    }

    fn data_dir(&self, options: &Value) -> PathBuf {
        match options["dataDir"].as_str() {
            Some(dir) => {
                let path = self.data.join(dir.trim_start_matches("<DATA>/"));
                std::fs::write(&path, "occupied").unwrap();
                path
            }
            None => self.data.clone(),
        }
    }

    async fn step(&mut self, op: &str, input: &Value, o: &Value) -> Value {
        let session = o["sessionId"].as_str().unwrap_or_default();
        if op == "persist" {
            let artifact = archive(&self.data, session).persist(&self.restored_text(input.as_str().unwrap())).await.expect("persisted");
            return json!({ "path": artifact.path });
        }
        if op == "prune" {
            // `pruneOffloadSession(sessionId, () => transcripts)` after the recorder aged every file an hour: the
            // sweep runs an hour later instead. Its output is the data dir's listing afterwards.
            let rows: Vec<Value> = input_rows(input, &self.previous)
                .into_iter()
                .map(|mut row| {
                    if let Some(Value::String(content)) = row.get_mut("content") {
                        *content = self.restored(content);
                    }
                    row
                })
                .collect();
            let transcripts = mixdog_js::json_stringify(&Value::Array(rows));
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
            let store = archive(&self.data, session);
            let candidates = store.prune_candidates().await;
            store.prune(candidates, transcripts, now + 3_600_000).await;
            let mut listing = Vec::new();
            listed(&self.data, &mut listing);
            listing.sort();
            return json!(listing);
        }
        let stored = Arc::new(StoredRows::new());
        let rows = input_rows(input, &self.previous);
        let messages = messages_of(&rows, &stored);
        let stored = CompactionRows(stored);
        let lowering = media(session, "");
        let owner = ProviderId::from("");
        let meter = MessageMeter { media: &*lowering, replay_owner: &owner };
        let archive = archive(&self.data_dir(o), session);
        let tail = TailContext { meter: &meter, rows: &stored, archive: &archive, preview: false };
        let out = match op {
            "budget" => json!(tool_history_budget(o["contextWindow"].as_u64().unwrap())),
            "tail" => {
                let options = TailOptions { context_window: o["contextWindow"].as_u64().unwrap(), preserve_conversation: o["preserveConversation"] == json!(true) };
                match build_execution_tail(&tail, &messages, &options).await {
                    Ok(t) => {
                        self.previous = rows_of(&t.messages);
                        json!({ "messages": self.previous, "toolTokens": t.tool_tokens, "toolBudget": t.tool_budget, "retainedGroups": t.retained_groups, "omittedGroups": t.omitted_groups })
                    }
                    Err(error) => json!({ "error": error }),
                }
            }
            "fresh" => {
                let options = FreshOptions {
                    context_window: o["contextWindow"].as_u64().unwrap_or(0),
                    handoff_text: o["handoffText"].as_str().unwrap_or_default().to_owned(),
                    active_turn: o["activeTurn"] == json!(true),
                    force: o["force"] == json!(true),
                    latest_user_prefix: o["latestUserPrefix"].as_str().unwrap_or_default().to_owned(),
                    ..FreshOptions::default()
                };
                let ctx = FreshContext { tail, attachments: &NoAttachments };
                match fresh_context_compact_messages(&ctx, &messages, o["budget"].as_u64().unwrap(), &options).await {
                    Ok(r) => {
                        self.previous = rows_of(&r.messages);
                        json!({ "messages": self.previous })
                    }
                    Err(error) => json!({ "error": error.message() }),
                }
            }
            "session" => {
                let Value::Object(header) = json!({ "provider": "stub", "model": "stub-model" }) else { unreachable!() };
                let settings = CompactSettings { context_window: o["contextWindow"].as_u64(), token_calibration: 1.0, ..CompactSettings::default() };
                let world = World::unsaved("stub", Arc::new(StubHost), None);
                let rows = Arc::new(StoredRows::new());
                let messages = messages_of(&input_rows(input, &self.previous), &rows);
                let compactor = session_compactor(world, session, &header, settings, rows, &self.data).await;
                compactor.prepare(&messages).await;
                let request = CompactRequest {
                    messages: &messages,
                    budget_tokens: o["budget"].as_u64().unwrap(),
                    trigger: CompactTrigger::Auto,
                    require_reduction: false,
                    reference_latest_attachments: false,
                    latest_user_prefix: "",
                };
                match compactor.compact(request).await {
                    Ok(output) => {
                        self.previous = rows_of(&output.messages);
                        json!({ "messages": self.previous, "providerCalls": 0, "toolHistoryBudget": tool_history_budget(o["contextWindow"].as_u64().unwrap()) })
                    }
                    Err(error) => json!({ "error": format!("{error:?}") }),
                }
            }
            "wire" => {
                let messages: Vec<_> = messages.iter().map(|m| m.message.clone()).collect();
                let options = LowerOptions {
                    replay_owner: ProviderId::from("openai-responses"),
                    codex_parity: false,
                    native_tool_search: true,
                    custom_tools: true,
                    replay_reasoning: o["replayEncryptedReasoning"] == json!(true),
                    tool_search_replay: ToolSearchReplay::Verbatim,
                    phase: false,
                    system_in_input: false,
                };
                json!(lower(&messages, &options))
            }
            other => json!({ "unsupported": other }),
        };
        out
    }
}

/// `<DATA>` for the data dir, `/` for the separators of a path under it, `<Hn>` for a 64-digit hash.
struct Canon {
    roots: Vec<String>,
    hashes: HashMap<String, String>,
}

impl Canon {
    fn new(root: Option<&Path>) -> Self {
        let roots = root
            .map(|r| {
                let raw = r.to_string_lossy().into_owned();
                let slashed = raw.replace('\\', "/");
                let display = match slashed.split_once(':') {
                    Some((drive, rest)) if drive.len() == 1 => format!("{}:{rest}", drive.to_ascii_uppercase()),
                    _ => slashed.clone(),
                };
                vec![raw.replace('\\', "\\\\"), raw, display, slashed]
            })
            .unwrap_or_default();
        Self { roots, hashes: HashMap::new() }
    }

    /// The text with the data dir written `<DATA>` and each path under it with `/`.
    fn rooted(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for root in &self.roots {
            out = out.replace(root.as_str(), "<DATA>");
        }
        let mut fixed = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(at) = rest.find("<DATA>") {
            fixed.push_str(&rest[..at + 6]);
            rest = &rest[at + 6..];
            let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || "_.-/\\".contains(c))).unwrap_or(rest.len());
            fixed.push_str(&rest[..end].replace("\\\\", "/").replace('\\', "/"));
            rest = &rest[end..];
        }
        fixed.push_str(rest);
        fixed
    }

    fn hashed(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
            if hex(bytes[i]) {
                let start = i;
                while i < bytes.len() && hex(bytes[i]) {
                    i += 1;
                }
                let run = &text[start..i];
                if run.len() == 64 {
                    let n = self.hashes.len() + 1;
                    out.push_str(self.hashes.entry(run.to_owned()).or_insert_with(|| format!("<H{n}>")));
                } else {
                    out.push_str(run);
                }
            } else {
                let ch = text[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
        out
    }

    fn rooted_value(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.rooted(s)),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.rooted_value(v)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), self.rooted_value(v))).collect()),
            other => other.clone(),
        }
    }

    /// Strings in key order, so both sides number the hashes alike.
    fn hashed_value(&mut self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.hashed(s)),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.hashed_value(v)).collect()),
            Value::Object(o) => {
                let sorted: BTreeMap<_, _> = o.iter().collect();
                Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), self.hashed_value(v))).collect())
            }
            other => other.clone(),
        }
    }
}

const ARCHIVE_DIR: &str = "<DATA>/tool-results/";

/// Archive paths a text names, in order.
fn archive_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(ARCHIVE_DIR) {
        let tail = &rest[at..];
        let end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || "_.-/<>".contains(c))).unwrap_or(tail.len());
        let path = &tail[..end];
        if path.ends_with(".txt") {
            out.push(path.to_owned());
        }
        rest = &tail[ARCHIVE_DIR.len()..];
    }
    out
}

fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
        Value::Object(o) => o.iter().collect::<BTreeMap<_, _>>().into_values().for_each(|v| strings(v, out)),
        _ => {}
    }
}

/// The steps' outputs and every archive file they reach (breadth first), canonical.
fn canonical(mut canon: Canon, outputs: &[Value], file: impl Fn(&str) -> Option<String>, file_count: usize) -> Value {
    let outputs: Vec<Value> = outputs.iter().map(|o| canon.rooted_value(o)).collect();
    let mut texts = Vec::new();
    outputs.iter().for_each(|o| strings(o, &mut texts));
    let mut queue: VecDeque<String> = texts.iter().flat_map(|t| archive_paths(t)).collect();
    let mut seen = Vec::<(String, String)>::new();
    while let Some(path) = queue.pop_front() {
        if seen.iter().any(|(p, _)| *p == path) {
            continue;
        }
        let content = file(&path).map(|c| canon.rooted(&c)).unwrap_or_else(|| "<missing>".to_owned());
        queue.extend(archive_paths(&content));
        seen.push((path, content));
    }
    let steps: Vec<Value> = outputs.iter().map(|o| canon.hashed_value(o)).collect();
    // A JSONL dump compares line by line as JSON: key order within a line is not part of the contract.
    let as_lines = |text: String| -> Value {
        let lines: Option<Vec<Value>> = text.lines().map(|l| serde_json::from_str(l).ok()).collect();
        match lines {
            Some(lines) if text.ends_with('\n') => Value::Array(lines),
            _ => Value::String(text),
        }
    };
    let files: Vec<Value> = seen.iter().map(|(p, c)| json!([canon.hashed(p), as_lines(canon.hashed(c))])).collect();
    json!({ "steps": steps, "files": files, "fileCount": file_count })
}

/// Every file under `dir`, as its displayed path.
fn listed(dir: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.path().is_dir() {
            listed(&entry.path(), out);
        } else {
            out.push(entry.path().to_string_lossy().replace('\\', "/"));
        }
    }
}

fn files_under(dir: &Path) -> usize {
    std::fs::read_dir(dir).map_or(0, |entries| {
        entries.flatten().map(|e| if e.path().is_dir() { files_under(&e.path()) } else { 1 }).sum()
    })
}

/// What Node's recording asserts beyond the replayed output: its diagnostics.
fn without_diagnostics(output: &Value) -> Value {
    let mut output = output.clone();
    if let Some(o) = output.as_object_mut() {
        o.remove("diagnostics");
    }
    output
}

/// The recorder's data root (`DATA_ROOT`, relative to the working directory): its paths are counted in the token
/// figures the cases record, so the replay writes under the same string.
const DATA_ROOT: &str = "mixdog-et-data";

/// The data root, emptied on creation and removed on drop.
struct DataRoot(PathBuf);

impl DataRoot {
    fn new() -> Self {
        let _ = std::fs::remove_dir_all(DATA_ROOT);
        std::fs::create_dir(DATA_ROOT).unwrap();
        Self(PathBuf::from(DATA_ROOT))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for DataRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn replay(case: &Value) -> (Value, Value) {
    let dir = DataRoot::new();
    let mut run = Replay { data: dir.path().to_path_buf(), previous: Vec::new() };
    let mut got = Vec::new();
    for step in case["steps"].as_array().unwrap() {
        got.push(run.step(step["op"].as_str().unwrap(), &step["input"], &step["options"]).await);
    }
    let want_steps: Vec<Value> = case["steps"].as_array().unwrap().iter().map(|s| without_diagnostics(&s["output"])).collect();
    let recorded = case["files"].as_object().unwrap();
    let want = canonical(Canon::new(None), &want_steps, |p| recorded.get(p).and_then(Value::as_str).map(str::to_owned), recorded.len());
    let data = dir.path().to_path_buf();
    let got = canonical(
        Canon::new(Some(&data)),
        &got,
        |p| std::fs::read_to_string(data.join(p.trim_start_matches("<DATA>/"))).ok(),
        files_under(&data),
    );
    (got, want)
}

#[tokio::test]
async fn execution_tail_cases_equal_node() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let mut replayed = 0;
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let test = case["test"].as_str().unwrap();
        let name = format!("{test} {}", case["name"].as_str().unwrap());
        let (got, want) = replay(case).await;
        if let Ok(dir) = std::env::var("MIXDOG_REPLAY_DIFF_DIR") {
            let stem = format!("{}-{index}", test.trim_start_matches(':'));
            std::fs::write(Path::new(&dir).join(format!("{stem}.got.json")), serde_json::to_string_pretty(&got).unwrap()).unwrap();
            std::fs::write(Path::new(&dir).join(format!("{stem}.want.json")), serde_json::to_string_pretty(&want).unwrap()).unwrap();
        }
        assert_eq!(got, want, "{name}");
        replayed += 1;
    }
    assert_eq!(replayed, 25, "every recorded case is replayed");
}
