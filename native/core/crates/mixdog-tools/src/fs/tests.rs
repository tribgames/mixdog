//! Golden tests: the file tools against `fixtures/tools/{read,list,glob,find,grep,edit,apply_patch}`.
//! Cases replay in the recorder's order over one in-memory workspace (edits
//! and patches mutate it for the cases after them). `list-meta` needs real
//! mtimes and modes, which the in-memory file service does not carry.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the golden tests build and inspect real work trees with blocking filesystem calls"
)]

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::fs::WritePrecondition;
use mixdog_core_api::domain::fs::WriteRequest;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use tokio_util::sync::CancellationToken;

use super::*;

fn seed() -> Vec<(&'static str, Vec<u8>)> {
    let lines: String = (1..=120).map(|i| format!("line-{i}\n")).collect();
    vec![
        ("README.md", b"# Fixture\n\nalpha beta\ngamma\n".to_vec()),
        ("src/main.mjs", b"import { add } from './lib/math.mjs';\n\nexport function main() {\n  return add(1, 2);\n}\n".to_vec()),
        ("src/lib/math.mjs", b"export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n".to_vec()),
        ("src/lib/notes.txt", b"TODO: first\nplain\nTODO: second\n".to_vec()),
        ("docs/guide.md", b"# Guide\n\n- item one\n- item two\n".to_vec()),
        (".hidden", b"secret-free\n".to_vec()),
        ("data/bin.dat", vec![0x41, 0x00, 0x42, 0x43]),
        ("lines.txt", lines.into_bytes()),
    ]
}

async fn context(root: &AbsPath) -> ToolContext {
    context_over(root, Arc::new(MockFileService::default())).await
}

async fn context_over(root: &AbsPath, files: Arc<dyn FileService>) -> ToolContext {
    let seeds = seed().into_iter().map(|(rel, bytes)| (rel.to_owned(), bytes)).collect();
    context_seeded(root, files, seeds).await
}

async fn context_seeded(root: &AbsPath, files: Arc<dyn FileService>, seeds: Vec<(String, Vec<u8>)>) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    for (rel, bytes) in seeds {
        let path = AbsPath::new(root.as_path().join(rel)).unwrap();
        files
            .create_dir(tokens.durability_io, AbsPath::new(path.as_path().parent().unwrap()).unwrap(), true)
            .await
            .unwrap();
        files
            .write(tokens.durability_io, WriteRequest { path, content: bytes, precondition: WritePrecondition::Unconditional })
            .await
            .unwrap();
    }
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        tool: "fs".into(),
        cwd: root.clone(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        },
        approvals: Arc::new(MockApprovalGate::default()),
        files,
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

/// The recorder's legacy argument names, mapped to the published schemas.
fn schema_args(tool: &str, mut input: JsonValue) -> JsonValue {
    let obj = input.as_object_mut().unwrap();
    if matches!(tool, "read" | "edit") {
        if let Some(p) = obj.shift_remove("path") {
            obj.insert("file_path".into(), p);
        }
    }
    if let Some(h) = obj.shift_remove("head_limit") {
        obj.insert("limit".into(), h);
    }
    if let Some(m) = obj.shift_remove("output_mode") {
        let m = if m == "files_with_matches" { "files".into() } else { m };
        obj.insert("mode".into(), m);
    }
    input
}

fn text_of(outcome: mixdog_core_api::domain::tool::ToolOutcome) -> (bool, String) {
    match outcome {
        Ok(out) => match &out.parts[0] {
            ToolPart::Text(t) => (false, t.clone()),
            _ => panic!("not text"),
        },
        Err(e) => (true, e.message_for_model),
    }
}

const GOLDEN_CASES: [&str; 16] = [
    "read/read-file", "read/read-range", "read/read-binary", "read/read-missing",
    "list/list-root", "list/list-hidden", "list/list-paged",
    "glob/glob-mjs", "find/find-math",
    "grep/grep-files", "grep/grep-content-context", "grep/grep-count",
    "edit/edit-replace", "edit/edit-no-match",
    "apply_patch/patch-update", "apply_patch/patch-stale-dry-run",
];

#[tokio::test]
async fn file_tools_match_golden_fixtures() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-golden").join("ws")).unwrap();
    let ctx = context(&root).await;
    // `apply_patch` hands in-base updates to the patch engine, which writes the real disk: its
    // fixtures run in the on-disk test below.
    let in_memory: Vec<&str> = GOLDEN_CASES.iter().copied().filter(|c| !c.starts_with("apply_patch/")).collect();
    run_golden(&ctx, &root, &in_memory).await;
}

/// The same fixtures over the real file service, plus `list-meta` (real mtimes and modes).
#[tokio::test]
async fn file_tools_match_golden_fixtures_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    let ctx = context_over(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new())).await;
    let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_767_323_045); // 2026-01-02T03:04:05Z
    for rel in ["src/lib", "src/main.mjs"] {
        let mut options = std::fs::OpenOptions::new();
        options.write(true);
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::custom_flags(&mut options, 0x0200_0000); // directories open with backup semantics
        options.open(root.as_path().join(rel)).unwrap().set_modified(stamp).unwrap();
    }
    let mut cases = GOLDEN_CASES.to_vec();
    cases.insert(7, "list/list-meta");
    run_golden(&ctx, &root, &cases).await;
}

/// What Node's `executeBuiltinTool('edit', …)` answers for a target it cannot read (missing, a directory, an over-long
/// name, one that cannot be stat'ed): `fixtures/tool-arg-answers/answers.json` (`record-tool-arg-answers.mjs`),
/// recorded on Windows, where the paths in the texts are written with backslashes.
#[cfg(windows)]
#[tokio::test]
async fn edit_read_failures_are_answered_as_node_answers_them_on_windows() {
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("ws");
    std::fs::create_dir_all(ws.join("sub")).unwrap();
    std::fs::write(ws.join("a.txt"), "hello\n").unwrap();
    let root = AbsPath::new(&ws).unwrap();
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    let answers: JsonValue = serde_json::from_str(
        &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tool-arg-answers/answers.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(answers["platform"], "win32", "the answers compared here are the Windows recording");
    let edit = EditTool::new();
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in answers["cases"].as_array().unwrap().iter().filter(|c| c["tool"] == "edit") {
        let (_, text) = text_of(edit.call(&ctx, schema_args("edit", case["input"].clone())).await);
        let text = text.replace(&ws.to_string_lossy().into_owned(), "<ROOT>");
        if text != case["text"].as_str().unwrap() {
            failures.push(format!("{}:\n  want {:?}\n  got  {text:?}", case["name"], case["text"]));
        }
        compared += 1;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(compared, 9);
}

/// Sets a file's or a directory's modification time.
fn set_mtime(path: &Path, at: std::time::SystemTime) {
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(&mut options, 0x0200_0000); // directories open with backup semantics
    options.open(path).unwrap().set_modified(at).unwrap();
}

/// Node's answers in `fixtures/tools-fs-search/<scenario>.json` (`record-tools-fs-search.mjs`), replayed whole, in order,
/// over the scenario's workspace on disk. As the recorder does, files are dated 2026-01-02T03:04:05Z unless the scenario
/// dates them, and dated directories are dated after their files are written.
/// `wait`'s outcome; a wait past a minute (a call that never ends: a replayed search's hard timer only passes for a
/// call whose server the recording left silent, and the context has no deadline) fails the replay naming `what`.
async fn within<T>(what: impl FnOnce() -> String, wait: impl Future<Output = T>) -> T {
    const LIMIT: std::time::Duration = std::time::Duration::from_secs(60);
    match tokio::time::timeout(LIMIT, wait).await {
        Ok(value) => value,
        Err(_) => panic!("{} did not end within {LIMIT:?}", what()),
    }
}

/// A replayed call that never ends (its hard timer never passes, the context has no deadline) fails the replay after
/// the wait's limit, naming the call, rather than hanging it.
#[tokio::test(start_paused = true)]
#[should_panic(expected = "grep-timeout #6 grep {\"pattern\":\"needle\"} did not end within 60s")]
async fn a_replayed_call_that_never_ends_fails_naming_it() {
    within(|| "grep-timeout #6 grep {\"pattern\":\"needle\"}".to_owned(), std::future::pending::<()>()).await;
}

async fn replay_fs_search(scenario: &str) {
    let fixture: JsonValue = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/tools-fs-search/{scenario}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().join("ws");
    let at = |iso: &str| std::time::SystemTime::from(chrono::DateTime::parse_from_rfc3339(iso).unwrap());
    let files = fixture["files"].as_object().unwrap();
    let mtimes = fixture["mtimes"].as_object().cloned().unwrap_or_default();
    for (rel, text) in files {
        std::fs::create_dir_all(ws.join(rel).parent().unwrap()).unwrap();
        std::fs::write(ws.join(rel), text.as_str().unwrap()).unwrap();
    }
    // Files that are not UTF-8 text, as base64.
    let binary = fixture["filesBase64"].as_object().cloned().unwrap_or_default();
    for (rel, b64) in &binary {
        use base64::Engine as _;
        std::fs::create_dir_all(ws.join(rel).parent().unwrap()).unwrap();
        std::fs::write(ws.join(rel), base64::engine::general_purpose::STANDARD.decode(b64.as_str().unwrap()).unwrap()).unwrap();
    }
    // Files of parts, each a text or a text repeated so many times (a line longer than the search's heap limit).
    let repeated = fixture["filesRepeat"].as_object().cloned().unwrap_or_default();
    for (rel, parts) in &repeated {
        let mut bytes = Vec::new();
        for part in parts.as_array().unwrap() {
            match part.as_str() {
                Some(text) => bytes.extend_from_slice(text.as_bytes()),
                None => bytes.extend_from_slice(part[0].as_str().unwrap().repeat(part[1].as_u64().unwrap() as usize).as_bytes()),
            }
        }
        std::fs::create_dir_all(ws.join(rel).parent().unwrap()).unwrap();
        std::fs::write(ws.join(rel), bytes).unwrap();
    }
    for (rel, target) in fixture["junctions"].as_object().cloned().unwrap_or_default() {
        // mklink reads `/` as a switch: the target is built segment by segment.
        let target = target.as_str().unwrap().split('/').fold(ws.clone(), |path, segment| path.join(segment));
        assert!(link_dir(&ws.join(&rel), &target), "junction {rel}");
    }
    for rel in files.keys().chain(binary.keys()).chain(repeated.keys()) {
        set_mtime(&ws.join(rel), at(mtimes.get(rel).and_then(|v| v.as_str()).unwrap_or("2026-01-02T03:04:05Z")));
    }
    // The bulk files are listed from memory: the cap and its wording are applied by the tool after the file service's
    // walk, so the walk and the stats of the empty files are served as the disk would serve them, without writing tens
    // of thousands of files (minutes on a busy disk). Their directory exists on disk, so a walk from it starts.
    let mut listed = Vec::new();
    if let Some(bulk) = fixture.get("bulk") {
        let dir = ws.join(bulk["dir"].as_str().unwrap());
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..bulk["count"].as_u64().unwrap() {
            listed.push(dir.join(format!("{i:05}{}", bulk["ext"].as_str().unwrap())));
        }
    }
    if let Some(bulk) = fixture.get("bulkDirs") {
        for i in 0..bulk["count"].as_u64().unwrap() {
            std::fs::create_dir_all(ws.join(bulk["dir"].as_str().unwrap()).join(format!("{i:05}"))).unwrap();
        }
    }
    for (rel, iso) in mtimes.iter().filter(|(rel, _)| !files.contains_key(*rel)) {
        set_mtime(&ws.join(rel), at(iso.as_str().unwrap()));
    }
    // The resize service (the extension host's sharp) answers the image bytes it was recorded on as recorded.
    // Bytes the decoder rejected (`invalid`) get no reply, as any other bytes.
    let resizer = fixture.get("resizer").map(|replies| {
        let replies = replies.as_array().unwrap().iter().filter(|r| r["invalid"] != true).map(|r| {
            assert_eq!(r["ext"], "png");
            let reply = &r["reply"];
            let dims = &reply["dimensions"];
            let dim = |k: &str| dims[k].as_u64().unwrap() as u32;
            (r["inputSha256"].as_str().unwrap().to_owned(), mixdog_core_api::domain::ext::ResizedImage {
                data_base64: reply["data"].as_str().unwrap().to_owned(),
                mime: reply["mimeType"].as_str().unwrap().to_owned(),
                original_w: dim("originalWidth"),
                original_h: dim("originalHeight"),
                display_w: dim("displayWidth"),
                display_h: dim("displayHeight"),
            })
        });
        Arc::new(RecordedResizer(replies.collect())) as Arc<dyn mixdog_core_api::domain::ext::ImageResizer>
    });
    let local: Arc<dyn FileService> = Arc::new(mixdog_workspace::localfs::LocalFileService::new());
    let files = if listed.is_empty() { local } else { Arc::new(Listed::new(local, listed, at("2026-01-02T03:04:05Z"))) };
    let mut ctx = within(|| format!("{scenario}: the tool context"), context_seeded(&AbsPath::new(&ws).unwrap(), files, Vec::new())).await;
    if let Some(cwd) = fixture["cwd"].as_str() {
        ctx.cwd = AbsPath::new(ws.join(cwd)).unwrap();
    }
    let raw = ws.to_string_lossy().into_owned();
    let fwd = raw.replace('\\', "/");
    // One instance of each tool for the whole scenario, as one Node process answered it; the arguments go in as
    // recorded and the failure flag is the tool's own outcome.
    let graph_cache = Arc::new(crate::code_graph::GraphCache::new(dir.path().join("graph-cache")));
    // A recorded search deadline (`server`, the stand-in's script) is an input here too: the soft one passes after the
    // same files (`deadline_script`), and the hard one on a timer the replay advances past it for a call whose server
    // never answered (`silent`), as the recording advanced Node's.
    let advanced = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let timer: super::SearchTimer = {
        let advanced = advanced.clone();
        Arc::new(move |_| {
            let passed = advanced.load(std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move {
                if !passed {
                    std::future::pending::<()>().await;
                }
            })
        })
    };
    let tools: [(&str, Box<dyn Tool>); 7] = [
        ("edit", Box::new(EditTool::new())),
        ("list", Box::new(ListTool::new())),
        ("glob", Box::new(GlobTool::new())),
        ("find", Box::new(FindTool::new())),
        ("grep", Box::new(GrepTool::with_timer(timer))),
        ("read", Box::new(ReadTool::new(None, resizer))),
        ("code_graph", Box::new(crate::code_graph::CodeGraphTool::new(Arc::new(NoRoots), graph_cache.clone()))),
    ];
    let tool_of = |name: &str| &tools.iter().find(|(n, _)| *n == name).unwrap_or_else(|| panic!("no replay for {name}")).1;
    let raw_json = serde_json::to_string(&raw).unwrap();
    let args_of = |input: &JsonValue| -> JsonValue {
        serde_json::from_str(&input.to_string().replace("<ROOT>", &fwd).replace("<ROOTW>", &raw_json[1..raw_json.len() - 1])).unwrap()
    };
    for (index, call) in fixture["warmup"].as_array().cloned().unwrap_or_default().iter().enumerate() {
        let tool = call["tool"].as_str().unwrap();
        let what = || format!("{scenario} warmup #{index} {tool} {}", call["input"]);
        let _ = within(what, tool_of(tool).call(&ctx, args_of(&call["input"]))).await;
    }
    // As the recorder drained Node's disk cache: the warmup's graphs are written before the calls.
    if fixture["drainAfterWarmup"] == true {
        graph_cache.flush().unwrap();
    }
    // A burst against the search queue, replayed its own way.
    if fixture.get("burst").is_some() {
        #[cfg(windows)]
        replay_burst(&fixture, &ws, &ctx, &**tool_of("grep"), args_of).await;
        return;
    }
    // Searches past their deadline whose reads ignore their cancel (`stalled.timeouts`, the scenario's first calls): each
    // is held in its read (`Script::Stuck`) and its hard timer passes as Node's did; the call's close gives it up once
    // the grace has passed, and it stays given up, its volume's, until the replay's end.
    let stuck = fixture["stalled"]["timeouts"].as_array().map_or(0, Vec::len);
    let mut failures = Vec::new();
    for (index, call) in fixture["calls"].as_array().unwrap().iter().enumerate() {
        use mixdog_workspace::localfs::deadline_script::Script;
        let tool = call["tool"].as_str().unwrap();
        // The stand-in's script: a deadline after so many files, a server that never answers, a full queue; an empty one
        // leaves the real server to answer.
        let script = call.get("server").and_then(|server| match server["afterFiles"].as_u64() {
            Some(n) => Some(Script::AfterFiles(n as usize)),
            None if server["silent"] == true => Some(Script::Silent),
            None if server["saturated"] == true => Some(Script::QueueFull),
            None => None,
        });
        let script = if index < stuck { Some(Script::Stuck) } else { script };
        mixdog_workspace::localfs::deadline_script::set(&ws, script);
        advanced.store(matches!(script, Some(Script::Silent | Script::Stuck)), std::sync::atomic::Ordering::SeqCst);
        let what = || format!("{scenario} #{index} {tool} {}", call["input"]);
        let outcome = within(what, tool_of(tool).call(&ctx, args_of(&call["input"]))).await;
        // What the tool returned besides its text (`returned`: Node's returned the text alone).
        let text_alone = match &outcome {
            Ok(out) => out.parts.len() == 1 && matches!(out.parts[0], ToolPart::Text(_)),
            Err(_) => true,
        };
        if call.get("returned").is_some_and(|r| r == "string") && !text_alone {
            failures.push(format!("#{index} {tool}: Node's tool returned its text alone, the core's more"));
        }
        let (is_error, text) = recorded_form(outcome);
        mixdog_workspace::localfs::deadline_script::set(&ws, None);
        // The hard timer passes only for the silent call itself, not for a call made beside it.
        advanced.store(false, std::sync::atomic::Ordering::SeqCst);
        // Every search of the call has ended and been joined, a timed-out one included.
        let live = mixdog_workspace::localfs::probe::live_under(&ws);
        if live != 0 {
            failures.push(format!("#{index} {tool}: {live} search(es) still running after the call"));
        }
        // An error message names the workspace behind the prefix it lies under (home, data dir); the recording's
        // workspace lay under none, so that spelling is the workspace too. A rich answer's JSON escapes backslashes.
        let redacted = super::read_paths::redact(&fwd, None);
        let escaped = raw.replace('\\', "\\\\");
        let text = text.replace(&escaped, "<ROOT>").replace(&raw, "<ROOT>").replace(&fwd, "<ROOT>").replace(&redacted, "<ROOT>");
        // A call Node's tool threw is a failed call whose message is the thrown one.
        let (want, want_error) = match call.get("thrown") {
            Some(thrown) => (thrown.as_str().unwrap(), true),
            None => (call["text"].as_str().unwrap(), call["isError"] == true),
        };
        if text != want || is_error != want_error {
            failures.push(format!("#{index} {tool} {}:\n  want ({want_error}) {want:?}\n  got  ({is_error}) {text:?}", call["input"]));
        }
        // A call Node made while this one's stuck search was being given up: answered by the next search, unscripted.
        if let Some(beside) = call.get("beside") {
            let tool = beside["tool"].as_str().unwrap();
            let what = || format!("{scenario} #{index} beside {tool} {}", beside["input"]);
            let (is_error, text) = recorded_form(within(what, tool_of(tool).call(&ctx, args_of(&beside["input"]))).await);
            let text = text.replace(&raw, "<ROOT>").replace(&fwd, "<ROOT>");
            let (want, want_error) = (beside["text"].as_str().unwrap(), beside["isError"] == true);
            if text != want || is_error != want_error {
                failures.push(format!("#{index} beside {tool} {}:\n  want ({want_error}) {want:?}\n  got  ({is_error}) {text:?}", beside["input"]));
            }
        }
    }
    // The held reads end.
    mixdog_workspace::localfs::deadline_script::unstick(&ws);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// `search-queue-burst` (`recordBurst`), replayed whole. Each held call is made once the one before holds: its folder's
/// file is under a batch oplock, as the recorder's lib/oplock-holder.ps1 held it, and the search's open of it broke the
/// oplock and waits. Then each burst call is made once its search was made (queued, or refused). Then the first hold is
/// released and every queued call's answer awaited, then each other hold released and its answer awaited. Compared:
/// every call's answer, and the order the searches answered in (the scheduler's, [`probe::answer_order`]) with the
/// order Node's server answered in.
#[cfg(windows)]
async fn replay_burst(fixture: &JsonValue, ws: &Path, ctx: &ToolContext, grep: &dyn Tool, args_of: impl Fn(&JsonValue) -> JsonValue) {
    use futures::StreamExt as _;
    use mixdog_workspace::localfs::deadline_script::OplockHold;
    use mixdog_workspace::localfs::probe;
    let holds = fixture["burst"]["holds"].as_u64().unwrap() as usize;
    let calls = fixture["calls"].as_array().unwrap();
    // No search of the recording reached its soft deadline; a loaded machine must not make a held one reach it here.
    mixdog_workspace::localfs::deadline_script::set(ws, Some(mixdog_workspace::localfs::deadline_script::Script::Unpassed));
    let mut oplocks: Vec<Option<OplockHold>> =
        (1..=holds).map(|n| Some(OplockHold::new(&ws.join(format!("h{n}")).join("f.ts")).unwrap())).collect();
    let mut numbers = std::collections::HashMap::new();
    let mut outcomes: Vec<Option<(bool, String)>> = vec![None; calls.len()];
    let mut pending = futures::stream::FuturesUnordered::new();
    for (index, call) in calls.iter().enumerate() {
        let number = probe::streams_made();
        numbers.insert(number, index);
        let args = args_of(&call["input"]);
        pending.push(async move { (index, recorded_form(grep.call(ctx, args).await)) });
        let (pending, outcomes) = (&mut pending, &mut outcomes);
        within(|| format!("search-queue-burst #{index}'s search made"), async move {
            loop {
                let made = probe::made().notified();
                let mut made = std::pin::pin!(made);
                made.as_mut().enable();
                if probe::streams_made() > number {
                    return;
                }
                tokio::select! {
                    () = made => {}
                    Some((done, outcome)) = pending.next() => outcomes[done] = Some(outcome),
                }
            }
        })
        .await;
        if let Some(Some(hold)) = oplocks.get(index) {
            let broken = tokio::task::block_in_place(|| hold.wait_broken(std::time::Duration::from_secs(60)));
            assert!(broken, "search-queue-burst hold #{index}'s open within 60 s");
        }
    }
    oplocks[0] = None;
    within(|| "search-queue-burst: every queued call's answer once the first hold is released".to_owned(), async {
        while outcomes.iter().enumerate().any(|(i, answer)| answer.is_none() && !(1..holds).contains(&i)) {
            let (index, outcome) = pending.next().await.expect("a call still pending");
            outcomes[index] = Some(outcome);
        }
    })
    .await;
    for hold in 1..holds {
        oplocks[hold] = None;
        within(|| format!("search-queue-burst: hold #{hold}'s answer"), async {
            while outcomes[hold].is_none() {
                let (index, outcome) = pending.next().await.expect("a call still pending");
                outcomes[index] = Some(outcome);
            }
        })
        .await;
    }
    let raw = ws.to_string_lossy().into_owned();
    let fwd = raw.replace('\\', "/");
    let mut failures = Vec::new();
    for (index, call) in calls.iter().enumerate() {
        let (is_error, text) = outcomes[index].clone().unwrap();
        let text = text.replace(&raw, "<ROOT>").replace(&fwd, "<ROOT>");
        let (want, want_error) = (call["text"].as_str().unwrap(), call["isError"] == true);
        if text != want || is_error != want_error {
            failures.push(format!("#{index} grep {}:\n  want ({want_error}) {want:?}\n  got  ({is_error}) {text:?}", call["input"]));
        }
    }
    // Each call made one search.
    assert_eq!(probe::streams_made(), numbers.len() as u64 + numbers.keys().min().unwrap(), "one search per call");
    let order: Vec<usize> = probe::answer_order().iter().filter_map(|n| numbers.get(n).copied()).collect();
    let want: Vec<usize> = fixture["answerOrder"].as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as usize).collect();
    if order != want {
        let at = order.iter().zip(&want).position(|(a, b)| a != b).unwrap_or(order.len().min(want.len()));
        failures.push(format!("answer order differs at {at}: want {:?}, got {:?}", &want[at..(at + 12).min(want.len())], &order[at..(at + 12).min(order.len())]));
    }
    mixdog_workspace::localfs::deadline_script::set(ws, None);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A call's outcome as the recorder wrote Node's: its text, or for a rich answer (more than one block, an image among
/// them) the JSON of its `{ content }` envelope.
fn recorded_form(outcome: mixdog_core_api::domain::tool::ToolOutcome) -> (bool, String) {
    let parts = match &outcome {
        Ok(out) if out.parts.len() > 1 || out.parts.iter().any(|p| matches!(p, ToolPart::Image { .. })) => &out.parts,
        _ => return text_of(outcome),
    };
    let blocks: Vec<String> = parts
        .iter()
        .map(|part| match part {
            ToolPart::Text(t) => format!(r#"{{"type":"text","text":{}}}"#, serde_json::to_string(t).unwrap()),
            ToolPart::Image { mime, data: ImageData::Bytes(bytes) } => format!(
                r#"{{"type":"image","data":"{}","mimeType":{}}}"#,
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
                serde_json::to_string(mime).unwrap()
            ),
            other => panic!("unexpected part {other:?}"),
        })
        .collect();
    (false, format!(r#"{{"content":[{}]}}"#, blocks.join(",")))
}

use mixdog_core_api::domain::fs::EntryKind;

/// The local file service plus empty files that exist only in memory, all dated `modified`: a walk lists them where the
/// disk walk would (siblings in byte order, depth first), and stating one answers an empty file.
struct Listed {
    inner: Arc<dyn FileService>,
    files: Arc<Vec<std::path::PathBuf>>,
    known: std::collections::HashSet<std::path::PathBuf>,
    modified: std::time::SystemTime,
}

impl Listed {
    fn new(inner: Arc<dyn FileService>, mut files: Vec<std::path::PathBuf>, modified: std::time::SystemTime) -> Self {
        files.sort();
        let known = files.iter().cloned().collect();
        Self { inner, files: Arc::new(files), known, modified }
    }
}

/// A walk's entries merged with the listed files under its root, in the walk's order.
struct MergedWalk {
    inner: Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>>,
    request: mixdog_core_api::domain::fs::WalkRequest,
    files: Arc<Vec<std::path::PathBuf>>,
    merged: Option<std::collections::VecDeque<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>>,
}

#[async_trait::async_trait]
impl mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>> for MergedWalk {
    async fn next(&mut self) -> Option<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>> {
        if self.merged.is_none() {
            let mut all = Vec::new();
            while let Some(item) = self.inner.next().await {
                all.push(item);
            }
            let root = self.request.root.as_path();
            all.extend(
                self.files
                    .iter()
                    .filter(|f| if self.request.recursive { f.starts_with(root) } else { f.parent() == Some(root) })
                    .filter(|f| !self.request.prune.iter().any(|p| f.starts_with(p.as_path())))
                    .map(|f| Ok(mixdog_core_api::domain::fs::DirEntry { path: AbsPath::new(f).unwrap(), kind: EntryKind::File })),
            );
            // Path order is component-wise: a directory's entries follow it, before its next sibling.
            all.sort_by(|a, b| match (a, b) {
                (Ok(a), Ok(b)) => a.path.as_path().cmp(b.path.as_path()),
                _ => std::cmp::Ordering::Equal,
            });
            self.merged = Some(all.into());
        }
        self.merged.as_mut().unwrap().pop_front()
    }

    async fn close(&mut self) {
        self.inner.close().await;
    }
}

#[async_trait::async_trait]
impl FileService for Listed {
    async fn stat(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        if self.known.contains(path.as_path()) {
            return Ok(mixdog_core_api::domain::fs::FileStat {
                kind: EntryKind::File,
                len: 0,
                modified: Some(self.modified),
                ctime: None,
                inode: 0,
                device: 0,
                readonly: false,
            });
        }
        self.inner.stat(lane, path).await
    }
    async fn read(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath, range: mixdog_core_api::domain::fs::ReadRange) -> Result<mixdog_core_api::domain::fs::FileBytes, mixdog_core_api::domain::fs::FsError> {
        self.inner.read(lane, path, range).await
    }
    async fn list_dir(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<Vec<mixdog_core_api::domain::fs::DirEntry>, mixdog_core_api::domain::fs::FsError> {
        let mut entries = self.inner.list_dir(lane, path.clone()).await?;
        entries.extend(
            self.files
                .iter()
                .filter(|f| f.parent() == Some(path.as_path()))
                .map(|f| mixdog_core_api::domain::fs::DirEntry { path: AbsPath::new(f).unwrap(), kind: EntryKind::File }),
        );
        Ok(entries)
    }
    async fn write(&self, lane: mixdog_rt::DurabilityIo, request: WriteRequest) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.inner.write(lane, request).await
    }
    async fn write_batch(&self, lane: mixdog_rt::DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<mixdog_core_api::domain::fs::FileStat>, mixdog_core_api::domain::fs::FsError> {
        self.inner.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.inner.create_dir(lane, path, recursive).await
    }
    async fn rename(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.inner.rename(lane, from, to, overwrite).await
    }
    async fn copy(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.inner.copy(lane, from, to, overwrite).await
    }
    async fn remove(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.inner.remove(lane, path, recursive).await
    }
    fn walk(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::WalkRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>> {
        let inner = self.inner.walk(lane, request.clone());
        Box::new(MergedWalk { inner, request, files: self.files.clone(), merged: None })
    }
    fn search_text(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::SearchRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::SearchMatch, mixdog_core_api::domain::fs::FsError>>> {
        self.inner.search_text(lane, request)
    }
}

/// A scenario recorded under its own environment (`env` in the fixture) replays in a child test process that carries
/// it, so no other test of this process sees the variables. `test` is the calling test's path in the crate.
async fn replay_fs_search_in_env(test: &str, scenario: &str) {
    const CHILD: &str = "MIXDOG_TOOLS_REPLAY_ENV_CHILD";
    if std::env::var_os(CHILD).is_some() {
        replay_fs_search(scenario).await;
        return;
    }
    let fixture: JsonValue = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/tools-fs-search/{scenario}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args([test, "--exact", "--test-threads", "1", "--nocapture"]).env(CHILD, "1");
    for (key, value) in fixture["env"].as_object().unwrap() {
        child.env(key, value.as_str().unwrap());
    }
    let out = child.output().unwrap();
    let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success() && log.contains("1 passed"), "{log}");
}

/// gaps-tools item 12: a glob-shaped `list` path is Node's name search, newest first with size and date columns.
#[tokio::test]
async fn list_answers_a_glob_shaped_path_as_node_does() {
    replay_fs_search("list-glob-path").await;
}

/// gaps-tools item 5: an absolute glob pattern walks from its own static prefix; one that finds
/// nothing is expanded straight off the filesystem, through the junction the walk does not follow.
#[tokio::test]
async fn glob_answers_absolute_patterns_as_node_does() {
    replay_fs_search("glob-absolute").await;
}

/// gaps-tools item 11 through the public call: past 50 000 matches an unbounded glob keeps 50 000 and says the list is
/// incomplete; a bounded one still counts every match.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn glob_past_fifty_thousand_matches_answers_as_node_does() {
    replay_fs_search("glob-past-cap").await;
}

/// A UNC or device-namespace pattern or path is refused before any walk; a backslashed drive pattern
/// expands from its drive root.
#[tokio::test]
async fn glob_refuses_unc_and_expands_from_nodes_root_as_node_does() {
    replay_fs_search("glob-unc").await;
}

/// A glob `path` or `root` that is not a string (an array included) is refused by the argument guard; a null or blank
/// one searches the cwd.
#[tokio::test]
async fn glob_refuses_a_path_that_is_not_a_string_as_node_does() {
    replay_fs_search("glob-path-array").await;
}

/// grep over several paths: each section within its share of the context budget, the assembled text capped at 5 KB
/// with Node's footer and offsets, in content, count, files, explicit and zero context, limit and offset; a missing
/// path among good ones; one path alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grep_over_several_paths_budgets_and_caps_as_node_does() {
    replay_fs_search("grep-path-budget").await;
}

/// grep's rendering for one path and for several: context mode past 40 matches (automatic, explicit, 0), the head/tail
/// selection and its continuation, the bounded anchor stream, long lines, several patterns, binary and invalid UTF-8
/// files, files and count over five paths past the final cap, matches on a file's first and last line, offsets past
/// the end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grep_renders_as_node_does() {
    replay_fs_search("grep-render").await;
}

/// A search that reaches its deadline, the deadline an input as it was in the recording: the soft one passing after a
/// given number of files with matches (one path, several paths, several patterns, before any line, after more lines than
/// the window holds) keeps what was found, with Node's partial notices and warning, a combined pattern scan keeping its
/// sections; the hard one, on a search that never answers, fails the call, and a grep made while that search is given up
/// and one after it answer as usual (Node sends the first again to its next server). No search of a call runs once it
/// returns.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grep_answers_a_search_past_its_deadline_as_node_does() {
    replay_fs_search("grep-timeout").await;
}

/// A line longer than the search's heap limit fails its file's search: none of the file's lines are answered, those
/// before the long line included, and the answer is partial, as Node's search server answers it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grep_answers_a_line_past_the_search_heap_as_node_does() {
    replay_fs_search("grep-heap").await;
}

/// A search-server queue that is full refuses grep's, glob's and find's searches as Node's server does, and each tool
/// answers the refusal as Node's does; with room again the same searches answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn searches_refused_by_a_full_queue_answer_as_node_does() {
    replay_fs_search("search-saturated").await;
}

/// A search on a volume where 8 reads ignored their cancel and were given up is answered at once with the answer Node
/// gives a call whose server was ended for a cancel that did not take (NATIVE_SEARCH_CANCEL_STALLED): grep's failure, a
/// grep over two paths' sections, glob's group failure, find's failure, each the tool's text alone. The 8 are greps past
/// their deadline, answered as Node answers them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_search_on_a_volume_of_given_up_reads_answers_as_node_does() {
    replay_fs_search_in_env("fs::tests::a_search_on_a_volume_of_given_up_reads_answers_as_node_does", "search-cancel-stalled").await;
}

/// Node's real search queue filled by a burst (9 searches held, then 2,060 greps): the same calls are queued or refused
/// as saturated here, and once the holds are released the searches answer in the order Node's server answered them.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_past_the_search_queue_is_refused_and_answered_in_nodes_order() {
    replay_fs_search_in_env("fs::tests::a_burst_past_the_search_queue_is_refused_and_answered_in_nodes_order", "search-queue-burst").await;
}

/// A grep over far more matches than its window: the scan produces exactly the anchor stream's bound (`limit: 10`:
/// `min(4000, max(200, 0 + 10 + 4)) + 1` = 201 of 20,000 matches, no margin), and when the call returns no producer of
/// the search is alive.
#[tokio::test]
async fn a_grep_scan_ends_at_its_window_and_before_the_call_returns() {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(mixdog_workspace::pathguard::canonical(dir.path()).unwrap()).unwrap();
    let body: String = (0..200).map(|i| format!("needle {i}\n")).collect();
    for f in 0..100 {
        std::fs::write(root.join(&format!("f{f:03}.txt")).as_path(), &body).unwrap();
    }
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    let (failed, text) = text_of(GrepTool::new().call(&ctx, serde_json::json!({ "pattern": "needle", "limit": 10 })).await);
    assert!(!failed && text.contains("[warning] anchor output capped at 200 matches"), "{text}");
    let probe = mixdog_workspace::localfs::probe::search(root.as_path());
    assert_eq!(probe, mixdog_workspace::localfs::probe::SearchProbe { found: 201, live: 0 });
}

/// Every non-string path shape (array, number, object, boolean, null, blank, blank-only and nested arrays) at list,
/// find, glob, grep, read, edit and code_graph: refused, read as the cwd, or (grep) taken as several scopes, as Node's
/// argument normalisation and guards answer it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_path_shape_is_answered_as_node_does() {
    replay_fs_search("path-arg-shapes").await;
}

/// A Win32 verbatim path or pattern (`\\?\C:\x`, `\\?\UNC\…`), present or missing, is a UNC/device spelling and
/// refused, as Node with node-fix-glob-verbatim-path.patch refuses it.
#[tokio::test]
async fn glob_refuses_a_verbatim_path_as_node_does() {
    replay_fs_search("glob-verbatim").await;
}

/// The expansion's root is Node's `path.parse(raw).root` (Node v22 `path.win32.parse`, the runtime of b6f10295a).
#[cfg(windows)]
#[test]
fn the_expansion_root_is_nodes_parse_root() {
    for (raw, root) in [
        ("//server/share/j*/x.ts", "//server/share/"),
        ("//server/share", "//server/share"),
        ("//server/share/", "//server/share/"),
        ("//server", "/"),
        ("//./C:/a/*.ts", "//./C:/"),
        ("//?/C:/a/*.ts", "//?/C:/"),
        ("//?/UNC/srv/sh/*.ts", "//?/UNC/"),
        ("C:/a/*.ts", "C:/"),
        ("c:/a/*.ts", "c:/"),
        ("C:", "C:"),
        ("C:a/*", "C:"),
        ("/a/*.ts", "/"),
        ("///x/y/*", "/"),
        ("//server//share/x*", "//server//share/"),
    ] {
        assert_eq!(&raw[..super::search::parse_root_len(raw)], root, "{raw}");
    }
}

/// gaps-tools item 8: a notebook read is Node's extractor's answer, not the raw JSON.
#[tokio::test]
async fn read_answers_a_notebook_as_node_does() {
    replay_fs_search("read-ipynb").await;
}

/// gaps-tools item 10, through the tool's own entry over one cache, as Node's resident graph answers them: a symbol miss
/// names the differently-cased spellings earlier queries looked up in the graph, and a reference scan stops at 200
/// mentions as Node's does (its truncation notice is parsed away before the answer, so the cut shows as missing rows).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_answers_casing_misses_and_capped_references_as_node_does() {
    replay_fs_search("code-graph-refs-casing").await;
}

/// Every code_graph mode, through the tool's entry, whole answers and outcomes as Node's (the replay of the cases
/// fixtures/tools/code_graph held, recorded anew through Node's entry).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_answers_every_mode_as_node_does() {
    replay_fs_search("code-graph-modes").await;
}

/// A sentinel-free cwd spelled in another case than its built graph is not a federation child of itself on Windows
/// (Node with node-fix-code-graph-self-federation.patch).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_never_federates_a_cwd_into_itself_whatever_its_case_as_node_does() {
    replay_fs_search("code-graph-self-case").await;
}

/// The casing hint's looked-up names live with the project root's resident graph, as Node's do: they survive five
/// other roots, and after six more evict the root its rebuilt graph knows no earlier lookup.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_casing_hint_leaves_with_the_evicted_graph_as_node_does() {
    replay_fs_search("code-graph-casing-eviction").await;
}

/// A resident graph's retained bytes are Node's estimate of its records, token index and source caches: at a 1 MB
/// budget the casing hint's lookups are cleared or kept where Node's are.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_memory_budget_counts_retained_bytes_as_node_does() {
    replay_fs_search_in_env("fs::tests::code_graph_memory_budget_counts_retained_bytes_as_node_does", "code-graph-memory-budget").await;
}

/// `REFERENCE_HIT_CAP` read as Node reads it: a fraction, a hex literal, a negative, 0 and a non-number.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_reference_hit_cap_fraction_as_node_does() {
    replay_fs_search_in_env("fs::tests::code_graph_reference_hit_cap_fraction_as_node_does", "code-graph-hit-cap-fraction").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_reference_hit_cap_hex_as_node_does() {
    replay_fs_search_in_env("fs::tests::code_graph_reference_hit_cap_hex_as_node_does", "code-graph-hit-cap-hex").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_reference_hit_cap_negative_as_node_does() {
    replay_fs_search_in_env("fs::tests::code_graph_reference_hit_cap_negative_as_node_does", "code-graph-hit-cap-negative").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_reference_hit_cap_zero_as_node_does() {
    replay_fs_search_in_env("fs::tests::code_graph_reference_hit_cap_zero_as_node_does", "code-graph-hit-cap-zero").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_graph_reference_hit_cap_nan_as_node_does() {
    replay_fs_search_in_env("fs::tests::code_graph_reference_hit_cap_nan_as_node_does", "code-graph-hit-cap-nan").await;
}

/// The public read's `mode`, in both argument forms.
#[tokio::test]
async fn read_honours_mode_as_node_does() {
    replay_fs_search("read-modes").await;
}

/// The read shapes that render a notebook's cells and the ones that refuse them.
#[tokio::test]
async fn read_renders_or_refuses_a_notebook_as_node_does() {
    replay_fs_search("read-shapes").await;
}

/// A notebook image whose base64 is wrapped with line breaks is decoded as Node's `Buffer.from(b64, 'base64')`.
#[tokio::test]
async fn read_decodes_a_wrapped_notebook_image_as_node_does() {
    replay_fs_search("read-ipynb-image").await;
}

/// Characters outside the base64 alphabet in a notebook image are read through their UTF-16 code units' low byte, as
/// Node's `Buffer.from(b64, 'base64')` reads them: some are skipped, some count as letters or as `=`.
#[tokio::test]
async fn read_decodes_non_ascii_in_notebook_base64_as_node_does() {
    replay_fs_search("read-ipynb-base64-junk").await;
}

/// A missing `list` / `grep` path carries Node's recovery hints.
#[tokio::test]
async fn list_and_grep_answer_a_missing_path_as_node_does() {
    replay_fs_search("not-found-hints").await;
}

/// A missing grep path the basename scans could not settle is looked up as a `**/<basename>` glob, as Node's
/// `_suggestIndexedPaths` does; `list` has no such fallback.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn grep_suggests_indexed_paths_for_a_missing_path_as_node_does() {
    replay_fs_search("grep-missing-indexed").await;
}

/// gaps-tools item 6: several content patterns are independent greps, one section each.
#[tokio::test]
async fn grep_answers_several_patterns_as_node_does() {
    replay_fs_search("grep-multi-pattern").await;
}

struct NoRoots;

#[async_trait::async_trait]
impl crate::code_graph::TrustedRoots for NoRoots {
    async fn registered(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }
    async fn selected(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }
}

/// The built-in tools are Node's definition objects, whole (`fixtures/tool-definitions/definitions.json`,
/// `record-tool-definitions.mjs`, through `mixdog_js::fixture_tools`): the description and the `inputSchema`
/// the model is sent, key for key, with the title, trigger and every hint. A delegated agent's `git` is Node's
/// agent variant.
#[test]
fn the_builtin_tools_are_nodes_definitions() {
    let cache_dir = tempfile::tempdir().unwrap();
    let tools: Vec<Box<dyn Tool>> = vec![
        Box::new(crate::code_graph::CodeGraphTool::new(Arc::new(NoRoots), Arc::new(crate::code_graph::GraphCache::new(cache_dir.path().join("cache"))))),
        Box::new(ReadTool::new(None, None)),
        Box::new(ListTool::new()),
        Box::new(GlobTool::new()),
        Box::new(FindTool::new()),
        Box::new(GrepTool::new()),
        Box::new(EditTool::new()),
        Box::new(ApplyPatchTool::new()),
        Box::new(crate::git::GitTool::new()),
        Box::new(crate::github::GithubTool::new(
            mixdog_scm::engine::Scm::new(Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default()), mixdog_rt::testing::tokens().maintenance_io, cache_dir.path().join("scm"))
                .github
                .clone(),
            None,
        )),
    ];
    for tool in &tools {
        let spec = tool.spec();
        let node = mixdog_js::fixture_tools::definition(&spec.name).expect("a Node definition");
        assert_eq!(tool.definition(), node, "{}", spec.name);
        assert_eq!(spec.annotations.to_json().to_string(), node["annotations"].to_string(), "{} annotations", spec.name);
    }
    let node_agent_git = mixdog_js::fixture_tools::definition("git@agent").expect("the agent git");
    let git = crate::git::GitTool::new();
    assert_eq!(git.agent_spec().expect("git has an agent text").definition(), node_agent_git);
}

async fn run_golden(ctx: &ToolContext, root: &AbsPath, cases: &[&str]) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools");
    let tools: Vec<Box<dyn Tool>> = vec![
        Box::new(ReadTool::new(None, None)),
        Box::new(ListTool::new()),
        Box::new(GlobTool::new()),
        Box::new(FindTool::new()),
        Box::new(GrepTool::new()),
        Box::new(EditTool::new()),
        Box::new(ApplyPatchTool::new()),
    ];
    let root_text = root.as_path().to_string_lossy().replace('\\', "/");
    let mut failures = Vec::new();
    for case in cases.iter().copied() {
        let fixture: JsonValue =
            serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{case}.json"))).unwrap()).unwrap();
        let name = fixture["tool"].as_str().unwrap();
        let tool = tools.iter().find(|t| t.spec().name == name).unwrap();
        let mut input = fixture["input"].clone();
        if let Some(b) = input.get_mut("base_path") {
            *b = JsonValue::String(root_text.clone());
        }
        let (is_error, text) = text_of(tool.call(ctx, schema_args(name, input)).await);
        let text = text.replace(&root_text, "<ROOT>");
        let want = fixture["text"].as_str().unwrap();
        if text != want || is_error != fixture["isError"].as_bool().unwrap() {
            failures.push(format!("{case}:\n  want {want:?}\n  got  {text:?} (error={is_error})"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

type Tree = std::collections::BTreeMap<String, Vec<u8>>;

/// A recorded file's bytes: its text, or { b64 } for bytes that are not UTF-8 text.
fn bytes_of(value: &JsonValue) -> Vec<u8> {
    use base64::Engine;
    match value.as_str() {
        Some(text) => text.as_bytes().to_vec(),
        None => base64::engine::general_purpose::STANDARD.decode(value["b64"].as_str().unwrap()).unwrap(),
    }
}

fn tree_of(value: &JsonValue) -> Tree {
    value.as_object().map(|files| files.iter().map(|(k, v)| (k.clone(), bytes_of(v))).collect()).unwrap_or_default()
}

fn snapshot(dir: &Path, base: &Path, out: &mut Tree) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            snapshot(&path, base, out);
        } else {
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            out.insert(rel, std::fs::read(&path).unwrap());
        }
    }
}

/// Cases recorded from Node over the files each one starts with (`golden/record.mjs`): the reply
/// text, the error flag and the resulting tree must all match.
#[tokio::test]
async fn edit_and_apply_patch_match_recorded_node_cases() {
    let cases: Vec<JsonValue> = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/cases.json")).unwrap();
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(EditTool::new()), Box::new(ApplyPatchTool::new())];
    let mut failures = Vec::new();
    for case in &cases {
        // The delete-of-a-missing-file case quotes the recording machine's OS message and its
        // Windows verbatim path.
        let os_message = std::io::Error::from_raw_os_error(2).to_string();
        let want = case["text"].as_str().unwrap().replace("지정된 파일을 찾을 수 없습니다. (os error 2)", &os_message);
        if !cfg!(windows) && want.contains("\\\\?\\") {
            continue;
        }
        let want = want.as_str();
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = AbsPath::new(dir.path().join("ws")).unwrap();
        std::fs::create_dir_all(root.as_path()).unwrap();
        let seeds = tree_of(&case["files"]).into_iter().collect();
        // A second tree outside the workspace, <OUT> in the patch text.
        let out = AbsPath::new(dir.path().join("out")).unwrap();
        std::fs::create_dir_all(out.as_path()).unwrap();
        for (rel, bytes) in tree_of(&case["outside"]) {
            let path = out.as_path().join(&rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        let out_text = out.as_path().to_string_lossy().replace('\\', "/");
        let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), seeds).await;
        // Files another process holds open without delete sharing (recorded on Windows only).
        #[cfg(windows)]
        let _held: Vec<std::fs::File> = {
            use std::os::windows::fs::OpenOptionsExt;
            case["hold"].as_array().into_iter().flatten().map(|rel| std::fs::OpenOptions::new().read(true).share_mode(1).open(root.as_path().join(rel.as_str().unwrap())).unwrap()).collect()
        };
        #[cfg(not(windows))]
        if case.get("hold").is_some() {
            continue;
        }
        let tool_name = case["tool"].as_str().unwrap();
        let tool = tools.iter().find(|t| t.spec().name == tool_name).unwrap();
        let root_text = root.as_path().to_string_lossy().replace('\\', "/");
        let mut input = case["input"].clone();
        if let Some(b) = input.get_mut("base_path") {
            let recorded = b.as_str().unwrap().to_owned();
            *b = JsonValue::String(recorded.replace("<ROOT>", &root_text));
        }
        if let Some(p) = input.get_mut("patch") {
            let recorded = p.as_str().unwrap().to_owned();
            *p = JsonValue::String(recorded.replace("<OUT>", &out_text));
        }
        // `edit` also takes the recorded `path` key as it is.
        let (is_error, text) = text_of(tool.call(&ctx, input).await);
        let text = text
            .replace(&out_text, "<OUT>")
            .replace(&out.as_path().to_string_lossy().into_owned(), "<OUT>")
            .replace(&root_text, "<ROOT>")
            .replace(&root.as_path().to_string_lossy().into_owned(), "<ROOT>");
        let mut after = Tree::new();
        snapshot(root.as_path(), root.as_path(), &mut after);
        let mut after_out = Tree::new();
        snapshot(out.as_path(), out.as_path(), &mut after_out);
        let want_after = tree_of(&case["after"]);
        let want_out = if case.get("after_out").is_some() { tree_of(&case["after_out"]) } else { after_out.clone() };
        if text != want || is_error != case["isError"].as_bool().unwrap() || after != want_after || after_out != want_out {
            let show = |t: &Tree| t.iter().map(|(k, v)| format!("{k}={:?}", String::from_utf8_lossy(v))).collect::<Vec<_>>().join(", ");
            failures.push(format!(
                "{name}:\n  want {want:?}\n  got  {text:?} (error={is_error})\n  want tree {}\n  got  tree {}\n  want out {}\n  got  out {}",
                show(&want_after), show(&after), show(&want_out), show(&after_out)
            ));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.len(), failures.join("\n"));
}

/// Two routes to one file (a symlinked directory and its referent) share a lock: an edit through
/// the link waits for a holder of the referent's own path.
#[tokio::test]
async fn an_edit_through_a_symlink_waits_for_the_referents_lock() {
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    std::fs::write(root.as_path().join("real").join("a.txt"), "one two\n").unwrap();
    let link = root.as_path().join("link");
    // A junction needs no privilege, unlike a Windows symlink; it routes to the file the same way.
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(root.as_path().join("real"))
        .output()
        .map_err(|e| e.to_string())
        .and_then(|o| if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stdout).into_owned()) });
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(root.as_path().join("real"), &link);
    // Creating a symlink needs a privilege some Windows accounts lack; there is nothing to
    // serialise without one.
    if let Err(error) = linked {
        eprintln!("symlink test skipped: {error}");
        return;
    }
    let ctx = Arc::new(
        context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await,
    );
    let referent = std::fs::canonicalize(root.as_path().join("real").join("a.txt")).unwrap();
    let referent = AbsPath::new(referent.to_string_lossy().trim_start_matches(r"\\?\")).unwrap();
    let held = crate::git::path_locks::lock_paths(&[referent.as_path()], &ctx.cancel).await.unwrap();

    let through_link = {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let args = serde_json::json!({ "file_path": "link/a.txt", "old_string": "one", "new_string": "ONE" });
            text_of(EditTool::new().call(&ctx, args).await)
        })
    };
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    assert!(!through_link.is_finished(), "an edit through a symlink ran under its referent's lock");
    drop(held);
    let (is_error, text) = through_link.await.unwrap();
    assert!(!is_error, "{text}");
    assert_eq!(std::fs::read_to_string(root.as_path().join("real").join("a.txt")).unwrap(), "ONE two\n");
}

#[tokio::test]
async fn writes_to_one_path_wait_for_its_path_lock() {
    use std::time::Duration;

    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-lock").join("ws")).unwrap();
    let ctx = Arc::new(context(&root).await);
    let readme = AbsPath::new(root.as_path().join("README.md")).unwrap();

    // A holder of the README lock (a git write in that work tree, or another session's edit).
    let held = crate::git::path_locks::lock_paths(&[readme.as_path()], &ctx.cancel).await.unwrap();

    let spawn_edit = |old: &'static str, new: &'static str, file: &'static str| {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let args = serde_json::json!({ "file_path": file, "old_string": old, "new_string": new });
            text_of(EditTool::new().call(&ctx, args).await)
        })
    };
    let first = spawn_edit("alpha", "ALPHA", "README.md");
    let second = spawn_edit("gamma", "GAMMA", "README.md");
    // A different path is not held up.
    let unrelated = spawn_edit("line-1\n", "LINE-1\n", "lines.txt");
    let (unrelated_error, text) = unrelated.await.unwrap();
    assert!(!unrelated_error, "{text}");

    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    assert!(!first.is_finished() && !second.is_finished(), "edits ran under a held path lock");
    drop(held);

    // Serialized, both land: neither sees the other's write as a stale precondition.
    for task in [first, second] {
        let (is_error, text) = task.await.unwrap();
        assert!(!is_error, "{text}");
    }
    let bytes = ctx.files.read(ctx.io.interactive, readme, Default::default()).await.unwrap().bytes;
    assert_eq!(String::from_utf8(bytes).unwrap(), "# Fixture\n\nALPHA beta\nGAMMA\n");
}

// ---- turn review ----

/// A turn review that keeps the calls it was told about and answers a card diff for each.
#[derive(Default)]
struct FakeReview {
    calls: std::sync::Mutex<Vec<(String, String, String, Vec<mixdog_core_api::turn_review::CallChange>)>>,
}

#[async_trait::async_trait]
impl mixdog_core_api::turn_review::TurnReviewApi for FakeReview {
    async fn record_call(&self, call_id: &str, session_id: &str, base_path: &str, changes: Vec<mixdog_core_api::turn_review::CallChange>) {
        self.calls.lock().unwrap().push((call_id.to_owned(), session_id.to_owned(), base_path.to_owned(), changes));
    }
    async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<mixdog_core_api::turn_review::CallChange>) {}
    fn take_call_diff(&self, call_id: &str) -> Option<String> {
        self.calls.lock().unwrap().iter().any(|c| c.0 == call_id).then(|| format!("card:{call_id}"))
    }
    fn note_change(&self, _: Option<&[String]>) {}
    async fn begin_turn(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::TurnOpen) -> Option<mixdog_core_api::turn_review::TurnToken> {
        None
    }
    async fn complete_turn(&self, _: &str, _: Option<&mixdog_core_api::turn_review::TurnToken>) -> bool {
        false
    }
    fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn mixdog_core_api::turn_review::AgentReview>> {
        None
    }
    fn forget_session(&self, _: &str) {}
    async fn turn_review_diff(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::ReviewRead) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn session_review_diff(&self, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn session_review_file_patch(&self, _: &str, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn turn_review_file_patch(&self, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn turn_changes(&self, _: &str, _: mixdog_core_api::turn_review::ChangesRead) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn clear_change_history(&self, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
}

fn card_of(output: &ToolOutput) -> Option<&str> {
    output.meta.as_ref().and_then(|m| m["uiDiff"].as_str())
}

/// A committed patch joins the turn review with the targets it really changed (a move carries its
/// destination) and hands its card diff back; a dry run, a failed patch and an untouched file
/// record nothing.
#[tokio::test]
async fn committed_writes_join_the_turn_review_and_carry_the_card_diff() {
    use mixdog_core_api::turn_review::CallChange;
    use mixdog_core_api::turn_review::ReviewContent;

    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    std::fs::write(root.as_path().join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(root.as_path().join("old.txt"), "keep\nme\n").unwrap();
    std::fs::write(root.as_path().join("bin.dat"), [0x61u8, 0, 0x62, 0x80, 0, 1]).unwrap();
    let review = Arc::new(FakeReview::default());
    let mut ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    ctx.review = Some(review.clone());
    let path = |name: &str| root.as_path().join(name).to_string_lossy().into_owned();

    // A dry run and a refused patch leave no entry.
    let dry = serde_json::json!({ "patch": "*** Update File: a.txt\n@@\n-one\n+ONE\n", "dry_run": true });
    assert!(card_of(&ApplyPatchTool::new().call(&ctx, dry).await.unwrap()).is_none());
    let stale = serde_json::json!({ "patch": "*** Update File: a.txt\n@@\n-nope\n+X\n" });
    assert!(ApplyPatchTool::new().call(&ctx, stale).await.is_err());
    assert!(review.calls.lock().unwrap().is_empty());

    // A move that also edits: one change carrying both ends.
    let moved = serde_json::json!({ "patch": "*** Update File: a.txt\n*** Move to: b.txt\n@@\n-one\n+ONE\n" });
    let output = ApplyPatchTool::new().call(&ctx, moved).await.unwrap();
    assert_eq!(card_of(&output), Some("card:c"));
    {
        let calls = review.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (call, session, base, changes) = &calls[0];
        assert_eq!((call.as_str(), session.as_str(), base.as_str()), ("c", "t", root.as_path().to_string_lossy().as_ref()));
        assert_eq!(
            changes,
            &vec![CallChange {
                path: path("a.txt"),
                new_path: Some(path("b.txt")),
                before: ReviewContent::bytes(&b"one\ntwo\n"[..]),
                after: ReviewContent::bytes(&b"ONE\ntwo\n"[..]),
            }]
        );
    }

    // A delete of an unreadable-as-text file is listed as omitted, never as empty bytes.
    review.calls.lock().unwrap().clear();
    let gone = serde_json::json!({ "patch": "*** Delete File: bin.dat\n*** Update File: old.txt\n@@\n-keep\n+KEEP\n" });
    ApplyPatchTool::new().call(&ctx, gone).await.unwrap();
    {
        let calls = review.calls.lock().unwrap();
        let changes = &calls[0].3;
        assert_eq!(changes.len(), 2);
        let bin = changes.iter().find(|c| c.path == path("bin.dat")).unwrap();
        assert_eq!(bin.before, ReviewContent::Omitted { size: 6, reason: Some("binary".to_owned()) });
        assert_eq!(bin.after, ReviewContent::Absent);
        let old = changes.iter().find(|c| c.path == path("old.txt")).unwrap();
        assert_eq!((&old.before, &old.after), (&ReviewContent::bytes(&b"keep\nme\n"[..]), &ReviewContent::bytes(&b"KEEP\nme\n"[..])));
    }

    // `edit` records its write too: a replacement, then a created file.
    review.calls.lock().unwrap().clear();
    let edit = serde_json::json!({ "file_path": "old.txt", "old_string": "me", "new_string": "you" });
    let output = EditTool::new().call(&ctx, edit).await.unwrap();
    assert_eq!(card_of(&output), Some("card:c"));
    let create = serde_json::json!({ "file_path": "fresh.txt", "old_string": "", "new_string": "hi\n" });
    EditTool::new().call(&ctx, create).await.unwrap();
    let calls = review.calls.lock().unwrap();
    assert_eq!(calls[0].3[0].before, ReviewContent::bytes(&b"KEEP\nme\n"[..]));
    assert_eq!(calls[0].3[0].after, ReviewContent::bytes(&b"KEEP\nyou\n"[..]));
    assert_eq!(calls[1].3[0].before, ReviewContent::Absent);
    assert_eq!(calls[1].3[0].after, ReviewContent::bytes(&b"hi\n"[..]));
}
// ---- locks, renames, rollback bounds ----

fn link_dir(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().is_ok_and(|o| o.status.success());
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(target, link).is_ok();
    linked
}

fn small_dir() -> (tempfile::TempDir, AbsPath) {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    (dir, root)
}

fn local_ctx_files() -> Arc<dyn FileService> {
    Arc::new(mixdog_workspace::localfs::LocalFileService::new())
}

/// `edit(real/a.txt)` and `apply_patch(alias/a.txt)` reach one file through a junction: run
/// together they serialize and both edits land, whichever way each is spelled.
#[tokio::test]
async fn edit_and_apply_patch_through_a_junction_serialize_and_keep_both_edits() {
    let (_dir, root) = small_dir();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    std::fs::write(root.as_path().join("real").join("a.txt"), "one\ntwo\nthree\n").unwrap();
    if !link_dir(&root.as_path().join("alias"), &root.as_path().join("real")) {
        eprintln!("junction test skipped");
        return;
    }
    let ctx = Arc::new(context_seeded(&root, local_ctx_files(), Vec::new()).await);
    for round in 0..6 {
        std::fs::write(root.as_path().join("real").join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let edit = {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let args = serde_json::json!({ "file_path": "real/a.txt", "old_string": "one", "new_string": "ONE" });
                text_of(EditTool::new().call(&ctx, args).await)
            })
        };
        let patch = {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let args = serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: alias/a.txt\n@@\n-three\n+THREE\n*** End Patch\n" });
                text_of(ApplyPatchTool::new().call(&ctx, args).await)
            })
        };
        for task in [edit, patch] {
            let (is_error, text) = task.await.unwrap();
            assert!(!is_error, "round {round}: {text}");
        }
        assert_eq!(std::fs::read_to_string(root.as_path().join("real").join("a.txt")).unwrap(), "ONE\ntwo\nTHREE\n", "round {round}");
    }
}

/// A holder of the real file's in-process lock holds up a patch aimed at it through a junction.
#[tokio::test]
async fn apply_patch_through_a_junction_waits_for_the_referents_lock() {
    use std::time::Duration;
    let (_dir, root) = small_dir();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    std::fs::write(root.as_path().join("real").join("a.txt"), "one\n").unwrap();
    if !link_dir(&root.as_path().join("alias"), &root.as_path().join("real")) {
        return;
    }
    let ctx = Arc::new(context_seeded(&root, local_ctx_files(), Vec::new()).await);
    let referent = super::advisory::canonical_lock_target(&root.as_path().join("alias").join("a.txt"));
    let held = crate::git::path_locks::lock_paths(&[referent.as_path()], &ctx.cancel).await.unwrap();
    let task = {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let args = serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: alias/a.txt\n@@\n-one\n+ONE\n*** End Patch\n" });
            text_of(ApplyPatchTool::new().call(&ctx, args).await)
        })
    };
    mixdog_rt::time::sleep(Duration::from_millis(150)).await;
    assert!(!task.is_finished(), "a patch through a junction ran under its referent's lock");
    drop(held);
    let (is_error, text) = task.await.unwrap();
    assert!(!is_error, "{text}");
}

/// The advisory lock excludes another holder of the same real file, takes a lock a dead process
/// left, and releases only a lock that still carries its own token.
#[tokio::test]
async fn the_advisory_lock_waits_for_a_live_holder_reclaims_a_dead_one_and_releases_only_its_own() {
    use std::time::Duration;
    let (_dir, root) = small_dir();
    let locks = root.as_path().join("locks");
    let ctx = context(&root).await;
    let target = root.as_path().join("t.txt");
    let (short, poll) = (Duration::from_millis(200), Duration::from_millis(10));

    let first = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], short, poll).await.unwrap();
    let blocked = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], short, poll).await.err().expect("a held lock is not shared");
    let file = super::advisory::lock_file_for(&locks, &target);
    assert_eq!(
        blocked.message_for_model,
        format!("Error: advisory lock timeout: {} ({}) held by pid {}", target.display(), file.display(), std::process::id())
    );
    // The blocked waiter left the holder's token alone, and another file is not held by it.
    let holder_token = std::fs::read_to_string(&file).unwrap();
    assert!(holder_token.starts_with(&format!("{}.", std::process::id())), "{holder_token}");
    let independent = root.as_path().join("independent.md");
    drop(super::advisory::lock_in(&ctx, &locks, &[independent.as_path()], short, poll).await.expect("an independent file is free"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), holder_token);
    drop(first);
    assert!(!file.exists());
    let second = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], short, poll).await.unwrap();
    // Another process took the file over meanwhile: this holder must not delete it.
    std::fs::write(&file, "1.someone-else").unwrap();
    drop(second);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "1.someone-else");

    // A lock whose holder is gone is cleared and taken.
    std::fs::write(&file, "2147483646.deadbeef").unwrap();
    let taken = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], Duration::from_secs(2), poll).await.unwrap();
    assert!(std::fs::read_to_string(&file).unwrap().starts_with(&format!("{}.", std::process::id())));
    drop(taken);
    let left: Vec<_> = std::fs::read_dir(&locks).unwrap().map(|entry| entry.unwrap().file_name()).collect();
    assert!(left.is_empty(), "lock files left after the reclaimed lock was released: {left:?}");
    // One real file under two spellings is one lock, taken once.
    let again = root.as_path().join("sub").join("..").join("t.txt");
    let both = super::advisory::lock_in(&ctx, &locks, &[target.as_path(), again.as_path()], short, poll).await;
    assert!(both.is_ok());
}

/// `edit` and `apply_patch` wait for another process holding the file's advisory lock.
#[tokio::test]
async fn edit_and_apply_patch_wait_for_the_advisory_lock_of_their_file() {
    use std::time::Duration;
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("a.txt"), "one\n").unwrap();
    std::fs::write(root.as_path().join("b.txt"), "two\n").unwrap();
    let ctx = Arc::new(context_seeded(&root, local_ctx_files(), Vec::new()).await);
    for (name, is_edit) in [("a.txt", true), ("b.txt", false)] {
        let lock_file = super::advisory::lock_file_for(&super::advisory::lock_directory(), &root.as_path().join(name));
        std::fs::create_dir_all(lock_file.parent().unwrap()).unwrap();
        std::fs::write(&lock_file, format!("{}.foreign", std::process::id())).unwrap();
        let task = {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let args = if is_edit {
                    serde_json::json!({ "file_path": "a.txt", "old_string": "one", "new_string": "ONE" })
                } else {
                    serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: b.txt\n@@\n-two\n+TWO\n*** End Patch\n" })
                };
                text_of(if is_edit { EditTool::new().call(&ctx, args).await } else { ApplyPatchTool::new().call(&ctx, args).await })
            })
        };
        mixdog_rt::time::sleep(Duration::from_millis(200)).await;
        assert!(!task.is_finished(), "{name} was written under another holder's advisory lock");
        std::fs::remove_file(&lock_file).unwrap();
        let (is_error, text) = task.await.unwrap();
        assert!(!is_error, "{text}");
    }
}

/// The local file service, except that removing `a.txt` fails as a busy file does.
struct BusyRemove(Arc<dyn FileService>);

#[cfg(windows)]
const BUSY: i32 = 32;
#[cfg(unix)]
const BUSY: i32 = libc::EBUSY;

#[async_trait::async_trait]
impl FileService for BusyRemove {
    async fn stat(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.stat(lane, path).await
    }
    async fn read(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath, range: mixdog_core_api::domain::fs::ReadRange) -> Result<mixdog_core_api::domain::fs::FileBytes, mixdog_core_api::domain::fs::FsError> {
        self.0.read(lane, path, range).await
    }
    async fn list_dir(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<Vec<mixdog_core_api::domain::fs::DirEntry>, mixdog_core_api::domain::fs::FsError> {
        self.0.list_dir(lane, path).await
    }
    async fn write(&self, lane: mixdog_rt::DurabilityIo, request: WriteRequest) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.write(lane, request).await
    }
    async fn write_batch(&self, lane: mixdog_rt::DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<mixdog_core_api::domain::fs::FileStat>, mixdog_core_api::domain::fs::FsError> {
        self.0.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.create_dir(lane, path, recursive).await
    }
    async fn rename(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.rename(lane, from, to, overwrite).await
    }
    async fn copy(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.copy(lane, from, to, overwrite).await
    }
    async fn remove(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        if path.as_path().ends_with("a.txt") {
            return Err(mixdog_core_api::domain::fs::FsError::new(mixdog_core_api::domain::fs::FsErrorKind::Io { os_code: Some(BUSY) }, Some(path)));
        }
        self.0.remove(lane, path, recursive).await
    }
    fn walk(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::WalkRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>> {
        self.0.walk(lane, request)
    }
    fn search_text(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::SearchRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::SearchMatch, mixdog_core_api::domain::fs::FsError>>> {
        self.0.search_text(lane, request)
    }
}

/// An ordered rename whose source cannot be removed puts both paths back and fails as its own
/// unit; the unit before it, already on disk, still reaches the review.
#[tokio::test]
async fn a_failed_source_removal_restores_both_paths_and_earlier_units_are_still_reviewed() {
    use mixdog_core_api::turn_review::ReviewContent;
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("c.txt"), "keep\n").unwrap();
    std::fs::write(root.as_path().join("a.txt"), "one\ntwo\n").unwrap();
    let review = Arc::new(FakeReview::default());
    let mut ctx = context_seeded(&root, Arc::new(BusyRemove(local_ctx_files())), Vec::new()).await;
    ctx.review = Some(review.clone());
    let patch = "*** Begin Patch\n*** Update File: c.txt\n@@\n-keep\n+KEEP\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-one\n+ONE\n*** End Patch\n";
    let (is_error, text) = text_of(ApplyPatchTool::new().call(&ctx, serde_json::json!({ "patch": patch, "sequence": true })).await);
    assert!(is_error);
    let a = root.as_path().join("a.txt");
    let (code, description) = if cfg!(windows) { ("EBUSY", "resource busy or locked") } else { ("EBUSY", "resource busy or locked") };
    let why = format!("apply_patch: V4A rename failed for a.txt → b.txt ({code}: {description}, unlink '{}')", a.display());
    assert!(text.contains(&why), "{text}");
    assert!(text.contains("sequence stopped at section 2/2 (a.txt)"), "{text}");
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "one\ntwo\n");
    assert!(!root.as_path().join("b.txt").exists());
    assert_eq!(std::fs::read_to_string(root.as_path().join("c.txt")).unwrap(), "KEEP\n");
    let calls = review.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].3.len(), 1);
    assert_eq!(calls[0].3[0].path, root.as_path().join("c.txt").to_string_lossy());
    assert_eq!(calls[0].3[0].after, ReviewContent::bytes(&b"KEEP\n"[..]));
}

/// A delete-only target keeps the 8 MiB snapshot limit in an ordered patch, so a larger one is
/// reviewed as an omitted state, not read whole.
#[tokio::test]
async fn an_ordered_delete_of_a_file_over_8_mib_is_reviewed_as_omitted() {
    use mixdog_core_api::turn_review::ReviewContent;
    let (_dir, root) = small_dir();
    let big = "x\n".repeat(5 * 1024 * 1024);
    std::fs::write(root.as_path().join("big.txt"), &big).unwrap();
    std::fs::write(root.as_path().join("s.txt"), "one\n").unwrap();
    let review = Arc::new(FakeReview::default());
    let mut ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    ctx.review = Some(review.clone());
    let patch = "*** Begin Patch\n*** Delete File: big.txt\n*** Update File: s.txt\n@@\n-one\n+ONE\n*** End Patch\n";
    let (is_error, text) = text_of(ApplyPatchTool::new().call(&ctx, serde_json::json!({ "patch": patch, "sequence": true })).await);
    assert!(!is_error, "{text}");
    let calls = review.calls.lock().unwrap();
    let change = calls[0].3.iter().find(|c| c.path.ends_with("big.txt")).unwrap();
    assert_eq!(change.before, ReviewContent::Omitted { size: big.len() as u64, reason: Some("oversized".to_owned()) });
    assert_eq!(change.after, ReviewContent::Absent);
}

/// A native failure over a file past 8 MiB carries no nearest-line hints, as Node's bounded read.
#[tokio::test]
async fn native_failure_context_reads_no_more_than_8_mib() {
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("small.txt"), "one\n").unwrap();
    std::fs::write(root.as_path().join("big.txt"), "one\n".repeat(2 * 1024 * 1024 + 1)).unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let stale = |name: &str| serde_json::json!({ "patch": format!("--- a/{name}\n+++ b/{name}\n@@ -1,1 +1,1 @@\n-nope\n+X\n") });
    let (_, small) = text_of(ApplyPatchTool::new().call(&ctx, stale("small.txt")).await);
    assert!(small.contains("nearest line 1: \"one\""), "{small}");
    let (_, big) = text_of(ApplyPatchTool::new().call(&ctx, stale("big.txt")).await);
    assert!(big.starts_with("Error: native patch failed"), "{big}");
    assert!(!big.contains("nearest line") && big.contains("expected first old/context line in big.txt: \"nope\"; use exact"), "{big}");
}
/// A rename between two spellings of one file (a junction alias) is an edit in place: allowed,
/// nothing removed. Node's `renameTargetsSamePhysicalFile` allows it; its own advisory lock set
/// holds both spellings of the one lock file and times out first, so only Rust gets this far.
#[tokio::test]
async fn a_rename_between_two_spellings_of_one_file_edits_it_in_place() {
    let (_dir, root) = small_dir();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    if !link_dir(&root.as_path().join("alias"), &root.as_path().join("real")) {
        return;
    }
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let file = root.as_path().join("real").join("a.txt");
    for extra in [serde_json::json!({}), serde_json::json!({ "sequence": true })] {
        std::fs::write(&file, "one\ntwo\n").unwrap();
        let mut args = serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: real/a.txt\n*** Move to: alias/a.txt\n@@\n-one\n+ONE\n*** End Patch\n" });
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let (is_error, text) = text_of(ApplyPatchTool::new().call(&ctx, args).await);
        assert!(!is_error, "{text}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "ONE\ntwo\n", "{text}");
    }
}
/// A flat-colour 8-bit RGB PNG in stored zlib blocks: the recipe `record_image.mjs` builds, so the
/// bytes can be rebuilt from `image_cases.json` and checked against its recorded hash.
fn flat_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff_u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
        out
    }
    let mut row = vec![0_u8];
    for _ in 0..width {
        row.extend_from_slice(&rgb);
    }
    let raw: Vec<u8> = (0..height).flat_map(|_| row.clone()).collect();
    let (mut a, mut b) = (1_u32, 0_u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65521;
        b = (b + a) % 65521;
    }
    let mut zlib = vec![0x78, 0x01];
    let mut at = 0;
    loop {
        let part = &raw[at..raw.len().min(at + 65535)];
        let last = at + 65535 >= raw.len();
        zlib.push(u8::from(last));
        zlib.extend_from_slice(&(part.len() as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(part.len() as u16)).to_le_bytes());
        zlib.extend_from_slice(part);
        at += 65535;
        if last {
            break;
        }
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &zlib));
    png.extend(chunk(b"IEND", &[]));
    png
}

/// A resizer that answers each recorded source image with what Node's `sharp` made of it (sizes,
/// mime and base64 length are recorded; the bytes are the extension host's own), and rejects any
/// other bytes as the decoder does.
struct RecordedResizer(Vec<(String, mixdog_core_api::domain::ext::ResizedImage)>);

#[async_trait::async_trait]
impl mixdog_core_api::domain::ext::ImageResizer for RecordedResizer {
    async fn resize(
        &self,
        _thread: &ThreadId,
        bytes: &[u8],
        ext: &str,
    ) -> Result<Option<mixdog_core_api::domain::ext::ResizedImage>, mixdog_core_api::domain::ext::ImageResizeError> {
        use sha2::Digest;
        assert_eq!(ext, "png");
        let hash = format!("{:x}", sha2::Sha256::digest(bytes));
        self.0
            .iter()
            .find(|(sha, _)| *sha == hash)
            .map(|(_, image)| Some(image.clone()))
            .ok_or(mixdog_core_api::domain::ext::ImageResizeError::Invalid)
    }
}

/// Node's `read` of an image, replayed from `image_cases.json`: the metadata line, the image block's
/// mime type and size, and the empty and corrupt refusals, each as recorded.
#[tokio::test]
async fn reading_an_image_matches_the_recorded_node_cases() {
    use mixdog_core_api::domain::ext::ResizedImage;
    use sha2::Digest;

    let cases: Vec<JsonValue> = serde_json::from_str(include_str!("golden/image_cases.json")).unwrap();
    let mut resizes = Vec::new();
    let mut files = Vec::new();
    for case in &cases {
        let bytes = match case.get("png") {
            Some(recipe) => {
                let rgb = recipe["rgb"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect::<Vec<_>>();
                let png = flat_png(recipe["width"].as_u64().unwrap() as u32, recipe["height"].as_u64().unwrap() as u32, [rgb[0], rgb[1], rgb[2]]);
                assert_eq!(png.len() as u64, case["sourceBytes"].as_u64().unwrap(), "{}", case["name"]);
                assert_eq!(format!("{:x}", sha2::Sha256::digest(&png)), case["sourceSha256"].as_str().unwrap(), "{}", case["name"]);
                if let Some(image) = case["content"].as_array().unwrap().iter().find(|b| b["type"] == "image") {
                    resizes.push((
                        case["sourceSha256"].as_str().unwrap().to_owned(),
                        ResizedImage {
                            // Data of the recorded length; its content is the host's.
                            data_base64: "A".repeat(image["base64Length"].as_u64().unwrap() as usize),
                            mime: image["mimeType"].as_str().unwrap().to_owned(),
                            original_w: recipe["width"].as_u64().unwrap() as u32,
                            original_h: recipe["height"].as_u64().unwrap() as u32,
                            display_w: image["width"].as_u64().unwrap() as u32,
                            display_h: image["height"].as_u64().unwrap() as u32,
                        },
                    ));
                }
                png
            }
            None => case["bytes"].as_str().unwrap().as_bytes().to_vec(),
        };
        files.push((case["file"].as_str().unwrap().to_owned(), bytes));
        for (rel, text) in case.get("extra").and_then(JsonValue::as_object).into_iter().flatten() {
            files.push((rel.clone(), text.as_str().unwrap().as_bytes().to_vec()));
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), files).await;
    let tool = ReadTool::new(None, Some(Arc::new(RecordedResizer(resizes))));
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let want = case["content"].as_array().unwrap();
        let outcome = tool.call(&ctx, schema_args("read", case["input"].clone())).await;
        // A failed single image read is an error result (Node's isError); a batch is never one.
        assert_eq!(outcome.is_err(), case["isError"].as_bool().unwrap(), "{name}");
        let out = match outcome {
            Ok(out) => out,
            Err(error) => {
                assert!(matches!(error.code, ToolErrorCode::Failed { .. }), "{name}");
                assert_eq!(error.message_for_model, want[0]["text"].as_str().unwrap(), "{name}");
                continue;
            }
        };
        assert_eq!(out.parts.len(), want.len(), "{name}");
        for (part, want) in out.parts.iter().zip(want) {
            match part {
                ToolPart::Text(text) => {
                    assert_eq!(want["type"], "text", "{name}");
                    assert_eq!(text, want["text"].as_str().unwrap(), "{name}");
                    assert_eq!(text.starts_with("Error:"), case["isError"].as_bool().unwrap(), "{name}");
                }
                ToolPart::Image { mime, data: ImageData::Bytes(bytes) } => {
                    assert_eq!(want["type"], "image", "{name}");
                    assert_eq!(mime, want["mimeType"].as_str().unwrap(), "{name}");
                    assert_eq!(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes).len() as u64, want["base64Length"].as_u64().unwrap(), "{name}");
                }
                other => panic!("{name}: unexpected part {other:?}"),
            }
        }
    }
}

/// With no resizer the read is Node without `sharp`: an original over 3,750,000 bytes is refused
/// with Node's text, a smaller one goes through as the bare image block. A resizer whose host
/// failed is a tool error, never that refusal.
#[tokio::test]
async fn an_image_without_a_resizer_keeps_the_inline_cap_and_a_failed_host_is_an_error() {
    struct DeadHost;
    #[async_trait::async_trait]
    impl mixdog_core_api::domain::ext::ImageResizer for DeadHost {
        async fn resize(
            &self,
            _thread: &ThreadId,
            _bytes: &[u8],
            _ext: &str,
        ) -> Result<Option<mixdog_core_api::domain::ext::ResizedImage>, mixdog_core_api::domain::ext::ImageResizeError> {
            Err(mixdog_core_api::domain::ext::ImageResizeError::Host(mixdog_core_api::domain::ext::ExtError::UnknownWorker))
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    let big = flat_png(2000, 1000, [200, 30, 90]);
    let small = flat_png(30, 20, [1, 2, 3]);
    let seeds = vec![("big.png".to_owned(), big.clone()), ("small.PNG".to_owned(), small.clone()), ("held.txt".to_owned(), small.clone())];
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), seeds).await;

    let bare = ReadTool::new(None, None);
    let (is_error, refused) = text_of(bare.call(&ctx, serde_json::json!({ "file_path": "big.png" })).await);
    assert!(is_error);
    assert_eq!(
        refused,
        format!(
            "Error: image \"big.png\" is {} bytes, over the 3750000-byte inline-view cap (image resizing unavailable: install the optional \"sharp\" dependency to auto-downsample). Convert/resize before reading.",
            big.len()
        )
    );
    let out = bare.call(&ctx, serde_json::json!({ "file_path": "small.PNG" })).await.unwrap();
    assert_eq!(out.parts, vec![ToolPart::Image { mime: "image/png".to_owned(), data: ImageData::Bytes(small) }]);
    // An image by content under another extension is not an image to `read`: it is a binary file.
    let (_, text) = text_of(bare.call(&ctx, serde_json::json!({ "file_path": "held.txt" })).await);
    assert!(!text.contains("inline-view"), "{text}");

    let dead = ReadTool::new(None, Some(Arc::new(DeadHost)));
    let error = dead.call(&ctx, serde_json::json!({ "file_path": "big.png" })).await.unwrap_err();
    assert!(matches!(error.code, ToolErrorCode::Unavailable { .. }), "{error:?}");
}

/// Node's `read` for the executor's own `path` spelling (a string, an array, region objects,
/// compact tuples; `limit:0`, a negative `offset`, `line`/`context`, `mode`/`n`, `full`) and for
/// the public form with `null` for what was not sent, replayed from `legacy_read_cases.json`,
/// which `record_legacy_read.mjs` recorded from Node over the workspace of `batch_cases.json`
/// (plus `extraFiles`). A `windowsOnly` case is replayed where Node was recorded: Windows. The
/// guard's own outcomes are checked in `read_legacy`.
#[tokio::test]
async fn the_legacy_path_spelling_reads_as_node_reads() {
    let batch: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/batch_cases.json")).unwrap();
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/legacy_read_cases.json")).unwrap();
    let mut workspace = batch.clone();
    workspace["files"].as_object_mut().unwrap().extend(doc["extraFiles"].as_object().unwrap().clone());
    let dir = tempfile::tempdir().unwrap();
    let (root, ctx) = recorded_workspace(&workspace, dir.path(), true).await;
    let cwd = root.as_path().to_string_lossy().replace('\\', "/");
    let tool = ReadTool::new(None, None);
    // The recorder's spellings of the workspace's own absolute path, and of the roots Node redacts.
    let drive = cwd.chars().next().unwrap().to_ascii_lowercase();
    let tail = cwd.get(2..).unwrap_or_default();
    let mut tokens = vec![("<WSPOSIX>", format!("/{drive}{tail}")), ("<WSCYG>", format!("/cygdrive/{drive}{tail}")), ("<WSMNT>", format!("/mnt/{drive}{tail}"))];
    tokens.extend(pin_legacy_environment());
    let cases = doc["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    let mut ran = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if case["windowsOnly"] == true && !cfg!(windows) {
            continue;
        }
        ran += 1;
        let mut text = case["input"].to_string();
        for (token, spelling) in &tokens {
            text = text.replace(token, &spelling.replace('\\', "\\\\"));
        }
        let input: JsonValue = serde_json::from_str(&text).unwrap();
        let got = summary(&tool.call(&ctx, input).await, &cwd);
        let expected = vec![("text".to_owned(), case["result"]["text"].as_str().unwrap().to_owned())];
        if got != expected {
            failures.push(format!("{name}\n  want {expected:?}\n  got  {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{} of {ran} differ:\n{}", failures.len(), failures.join("\n"));
}
/// The environment Node ran under in the recorder, as far as the paths in its messages go: the
/// home, data, product root and runtime directories. Returns the tokens the recording stands for
/// them with, and the paths they stand for.
fn pin_legacy_environment() -> Vec<(&'static str, String)> {
    static PIN: std::sync::Once = std::sync::Once::new();
    let base = std::env::temp_dir().join("mixdog-legacy-read-env");
    PIN.call_once(|| {
        for (key, name) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("MIXDOG_HOME", "home"),
            ("MIXDOG_DATA_DIR", "data"),
            ("MIXDOG_ROOT", "root"),
            ("MIXDOG_RUNTIME_ROOT", "runtime"),
        ] {
            // SAFETY: set before the test that needs them reads them; the other tests of this crate
            // do not read these variables.
            unsafe { std::env::set_var(key, base.join(name)) };
        }
    });
    let fwd = |name: &str| base.join(name).to_string_lossy().replace('\\', "/");
    vec![("<TESTHOME>", fwd("home")), ("<TESTDATA>", fwd("data")), ("<TESTROOT>", fwd("root")), ("<TESTRUNTIME>", fwd("runtime"))]
}

/// `normalizeErrorMessage` over the recorded messages (quoted paths, `file:///` URIs, the roots).
#[test]
fn error_messages_are_redacted_as_node_redacts_them() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/legacy_read_cases.json")).unwrap();
    let mut tokens = pin_legacy_environment();
    let cwd = std::env::temp_dir().join("mixdog-legacy-read-env").join("ws").to_string_lossy().replace('\\', "/");
    // The workspace with the other case of its drive letter (a Windows host compares paths without case).
    tokens.push(("<WSDRIVELOWER>", format!("{}{}", cwd[..1].to_lowercase(), &cwd[1..])));
    let with = |s: &str| {
        let mut out = s.replace("<WS>", &cwd);
        for (token, path) in &tokens {
            out = out.replace(token, path);
        }
        out
    };
    let back = |s: &str| {
        let mut out = s.replace(&cwd, "<WS>");
        for (token, path) in &tokens {
            out = out.replace(path, token);
        }
        out
    };
    let mut failures = Vec::new();
    for m in doc["messages"].as_array().unwrap() {
        if m["windowsOnly"] == true && !cfg!(windows) {
            continue;
        }
        let input = with(m["input"].as_str().unwrap());
        let got = back(&super::read_paths::normalize_error_message(&input, m["withCwd"].as_bool().unwrap().then_some(cwd.as_str())));
        if got != m["output"].as_str().unwrap() {
            failures.push(format!("{input:?} (cwd {}): want {:?}, got {got:?}", m["withCwd"], m["output"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// `normalizeInputPath` on the spellings of a drive, as a Windows host and as WSL.
#[test]
fn host_path_spellings_are_normalized_as_node_normalizes_them() {
    use super::read_paths::{Host, host_spelling};
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/legacy_read_cases.json")).unwrap();
    let mut failures = Vec::new();
    for s in doc["spellings"].as_array().unwrap() {
        let host = if s["host"] == "windows" { Host::Windows } else { Host::Wsl };
        // Trim and control characters are the part of `normalizeInputPath` that is host-independent.
        let cleaned: String = s["input"].as_str().unwrap().trim().chars().filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}')).collect();
        let got = host_spelling(&cleaned, host);
        if got != s["output"].as_str().unwrap() {
            failures.push(format!("{:?} as {}: want {}, got {got:?}", s["input"], s["host"], s["output"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
/// A workspace file from its recorded recipe (`record_batch.mjs`): a PNG, hex bytes, numbered
/// rows (padded, accented, NUL-ended), or text, each optionally re-encoded as UTF-16 with a BOM.
fn recipe_bytes(f: &JsonValue) -> Vec<u8> {
    if let Some(p) = f.get("png") {
        let rgb: Vec<u8> = p["rgb"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
        return flat_png(p["width"].as_u64().unwrap() as u32, p["height"].as_u64().unwrap() as u32, [rgb[0], rgb[1], rgb[2]]);
    }
    if let Some(h) = f.get("hex") {
        let h = h.as_str().unwrap();
        return (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect();
    }
    let text = if let Some(r) = f.get("rows") {
        let (count, width) = (r[0].as_u64().unwrap(), r[1].as_u64().unwrap() as usize);
        let accent = f.get("accent").and_then(JsonValue::as_bool).unwrap_or(false);
        let mut s = String::new();
        for n in 1..=count {
            let mut row = format!("row-{n}");
            if accent {
                row.push_str(if (n - 1) % 2 == 1 { " é" } else { " ü" });
            }
            while row.chars().count() < width {
                row.push('.');
            }
            s.push_str(&row);
            s.push('\n');
        }
        s
    } else {
        f["text"].as_str().unwrap().to_owned()
    };
    let text = match f.get("repeat").and_then(JsonValue::as_u64) {
        Some(times) => text.repeat(times as usize),
        None => text,
    };
    let mut bytes = match f.get("enc").and_then(JsonValue::as_str) {
        Some(enc) => {
            let little = enc == "utf16le";
            let mut out = if little { vec![0xff, 0xfe] } else { vec![0xfe, 0xff] };
            for unit in text.encode_utf16() {
                out.extend_from_slice(&if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
            }
            out
        }
        None => text.into_bytes(),
    };
    if f.get("nulTail").and_then(JsonValue::as_bool).unwrap_or(false) {
        bytes.push(0);
    }
    bytes
}

/// A workspace built from the recorded recipes, files stamped as the recorder stamped them.
async fn recorded_workspace(doc: &JsonValue, dir: &Path, huge: bool) -> (AbsPath, ToolContext) {
    let root = AbsPath::new(dir.join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    let recipes = doc["files"].as_object().unwrap();
    let is_huge = |f: &JsonValue| f.get("huge").and_then(JsonValue::as_bool).unwrap_or(false);
    let files = recipes.iter().filter(|(_, f)| huge || !is_huge(f)).map(|(rel, f)| (rel.clone(), recipe_bytes(f))).collect();
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), files).await;
    for (n, (rel, f)) in recipes.iter().enumerate() {
        if is_huge(f) {
            continue;
        }
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000 + n as u64 * 1000);
        std::fs::File::options().write(true).open(root.as_path().join(rel)).unwrap().set_modified(at).unwrap();
    }
    (root, ctx)
}

/// The sharp stand-in: the one recorded image result, for the one source image.
struct Fixed(String, mixdog_core_api::domain::ext::ResizedImage);

#[async_trait::async_trait]
impl mixdog_core_api::domain::ext::ImageResizer for Fixed {
    async fn resize(
        &self,
        _t: &ThreadId,
        bytes: &[u8],
        _e: &str,
    ) -> Result<Option<mixdog_core_api::domain::ext::ResizedImage>, mixdog_core_api::domain::ext::ImageResizeError> {
        use sha2::Digest;
        assert_eq!(format!("{:x}", sha2::Sha256::digest(bytes)), self.0);
        Ok(Some(self.1.clone()))
    }
}

fn recorded_resizer(doc: &JsonValue) -> Arc<Fixed> {
    use sha2::Digest;
    let block = doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|c| c["result"]["content"].as_array().into_iter().flatten())
        .find(|b| b["type"] == "image")
        .expect("a recorded image");
    let image = mixdog_core_api::domain::ext::ResizedImage {
        data_base64: "A".repeat(block["base64Length"].as_u64().unwrap() as usize),
        mime: block["mimeType"].as_str().unwrap().to_owned(),
        original_w: 30,
        original_h: 20,
        display_w: block["width"].as_u64().unwrap() as u32,
        display_h: block["height"].as_u64().unwrap() as u32,
    };
    Arc::new(Fixed(format!("{:x}", sha2::Sha256::digest(&flat_png(30, 20, [10, 20, 30]))), image))
}

/// A tool outcome as the recorder summarizes Node's: text parts, and an image as `mime:base64 length`.
fn summary(outcome: &ToolOutcome, cwd: &str) -> Vec<(String, String)> {
    // Node's native errors spell the workspace with the host's separators.
    let fix = |s: &str| s.replace(cwd, "<WS>").replace(&cwd.replace('/', "\\"), "<WS>");
    match outcome {
        Ok(out) => out
            .parts
            .iter()
            .map(|p| match p {
                ToolPart::Text(t) => ("text".to_owned(), fix(t)),
                ToolPart::Image { mime, data: ImageData::Bytes(b) } => {
                    ("image".to_owned(), format!("{mime}:{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b).len()))
                }
                other => ("other".to_owned(), format!("{other:?}")),
            })
            .collect(),
        Err(e) => vec![("text".to_owned(), fix(&e.message_for_model))],
    }
}

fn recorded_result(result: &JsonValue) -> Vec<(String, String)> {
    match result.get("text").and_then(JsonValue::as_str) {
        Some(t) => vec![("text".to_owned(), t.to_owned())],
        None => result["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                if b["type"] == "image" {
                    ("image".to_owned(), format!("{}:{}", b["mimeType"].as_str().unwrap(), b["base64Length"]))
                } else {
                    ("text".to_owned(), b["text"].as_str().unwrap().to_owned())
                }
            })
            .collect(),
    }
}

/// Node's `read`, text and batch forms, replayed from `batch_cases.json` (no session, so no memory).
#[tokio::test]
async fn reading_text_and_batches_matches_the_recorded_node_cases() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/batch_cases.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (root, ctx) = recorded_workspace(&doc, dir.path(), true).await;
    let cwd = root.as_path().to_string_lossy().replace('\\', "/");
    let tool = ReadTool::new(None, Some(recorded_resizer(&doc)));
    let mut failures = Vec::new();
    for case in doc["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let got = summary(&tool.call(&ctx, case["input"].clone()).await, &cwd);
        let expected = recorded_result(&case["result"]);
        if got != expected {
            failures.push(format!("{name}\n  want {expected:?}\n  got  {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), doc["cases"].as_array().unwrap().len(), failures.join("\n"));
}

/// A snapshot store that keeps its files in memory.
#[derive(Default)]
struct MemorySnapshots(std::sync::Mutex<Vec<(String, String)>>);

impl SnapshotPersist for MemorySnapshots {
    fn load(&self, scope: &str) -> Option<String> {
        self.0.lock().unwrap().iter().find(|(s, _)| s == scope).map(|(_, json)| json.clone())
    }
    fn scopes(&self) -> Vec<String> {
        self.0.lock().unwrap().iter().map(|(s, _)| s.clone()).collect()
    }
    fn save(&self, scope: &str, json: Option<&str>) {
        let mut files = self.0.lock().unwrap();
        files.retain(|(s, _)| s != scope);
        if let Some(json) = json {
            files.push((scope.to_owned(), json.to_owned()));
        }
    }
}

/// What the file tools remember between calls, replayed from the recorded sequences: a repeated
/// read, a read after an edit or a patch, another session, a changed file, and a cache that has
/// outlived its 30 seconds (on a clock the test moves).
async fn replay_sequence(name: &str) {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/batch_cases.json")).unwrap();
    let mut failures = Vec::new();
    {
        let sequence = doc["sequences"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no recorded sequence {name}"));
        let dir = tempfile::tempdir().unwrap();
        let (root, mut ctx) = recorded_workspace(&doc, dir.path(), false).await;
        let cwd = root.as_path().to_string_lossy().replace('\\', "/");
        let now = Arc::new(std::sync::atomic::AtomicU64::new(1_000));
        let clock = Arc::clone(&now);
        let store = Arc::new(MemorySnapshots::default());
        let lane = mixdog_rt::testing::tokens().durability_io;
        let persistence = Persistence::new(store.clone(), lane);
        let state = Arc::new(ReadState::with_clock(Some(persistence), Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst))));
        let persisted = |ids: Vec<&str>| -> JsonValue {
            let held = store.scopes();
            JsonValue::Object(ids.into_iter().map(|id| (id.to_owned(), JsonValue::Bool(held.iter().any(|s| s == id)))).collect())
        };
        let ids_of = |step: &JsonValue, key: &str| -> Vec<String> {
            step[key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
        };
        let resizer = recorded_resizer(&doc);
        let remembering = ReadTool::new(None, Some(resizer.clone())).with_state(Arc::clone(&state));
        let forgetting = ReadTool::new(None, Some(resizer));
        let edit = EditTool::new().with_state(Arc::clone(&state));
        let patch = ApplyPatchTool::new().with_state(Arc::clone(&state));
        let mut bump = 0_u64;
        for (n, step) in sequence["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(ms) = step.get("sleepMs").and_then(JsonValue::as_u64) {
                now.fetch_add(ms, std::sync::atomic::Ordering::SeqCst);
                // Node's 500 ms flush timer fires inside a sleep this long.
                if ms >= 500 {
                    state.flush_all().await;
                }
                continue;
            }
            // Which of the named sessions have a persisted snapshot file right now.
            if step.get("files").is_some() {
                state.settle().await;
                let ids = ids_of(step, "files");
                let got = persisted(ids.iter().map(String::as_str).collect());
                if got != step["persisted"] {
                    failures.push(format!("{name} step {n} files\n  want {}\n  got  {got}", step["persisted"]));
                }
                continue;
            }
            // A workspace switch: the session's snapshots go from memory and from disk, and the
            // sessions watched alongside it keep theirs.
            if let Some(session) = step.get("switch").and_then(JsonValue::as_str) {
                let mut ids = vec![session.to_owned()];
                ids.extend(ids_of(step, "watch"));
                let names = || ids.iter().map(String::as_str).collect::<Vec<_>>();
                state.settle().await;
                let before = persisted(names());
                state.forget_session(session);
                state.settle().await;
                let after = persisted(names());
                if before != step["persistedBefore"] || after != step["persistedAfter"] {
                    failures.push(format!(
                        "{name} step {n} switch {session}\n  want {} -> {}\n  got  {before} -> {after}",
                        step["persistedBefore"], step["persistedAfter"]
                    ));
                }
                continue;
            }
            if let Some(path) = step.get("chmod").and_then(JsonValue::as_str) {
                // Only the change time moves: a permission flip keeps mtime and size.
                let p = root.as_path().join(path);
                std::thread::sleep(std::time::Duration::from_millis(50));
                let mut perms = std::fs::metadata(&p).unwrap().permissions();
                perms.set_readonly(true);
                std::fs::set_permissions(&p, perms.clone()).unwrap();
                perms.set_readonly(false);
                std::fs::set_permissions(&p, perms).unwrap();
                continue;
            }
            if let Some(w) = step.get("write") {
                let path = root.as_path().join(w["path"].as_str().unwrap());
                std::fs::write(&path, w["text"].as_str().unwrap()).unwrap();
                bump += 5;
                let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_700_001_000_000 + bump * 1000);
                std::fs::File::options().write(true).open(&path).unwrap().set_modified(at).unwrap();
                continue;
            }
            let session = step["session"].as_str();
            ctx.thread_id = ThreadId::from(session.unwrap_or("none"));
            let input = step["input"].clone();
            let outcome = match (step["tool"].as_str().unwrap(), session) {
                ("read", Some(_)) => remembering.call(&ctx, input).await,
                ("read", None) => forgetting.call(&ctx, input).await,
                ("edit", _) => edit.call(&ctx, input).await,
                ("apply_patch", _) => patch.call(&ctx, input).await,
                (other, _) => panic!("{other}"),
            };
            let got = summary(&outcome, &cwd);
            let expected = recorded_result(&step["result"]);
            // A write's own wording is the write tools' to match; here only what it leaves behind counts.
            if step["tool"] != "read" {
                continue;
            }
            if got != expected {
                failures.push(format!("{name} step {n} {}\n  want {expected:?}\n  got  {got:?}", step["input"]));
            }
        }
    }
    assert!(failures.is_empty(), "{} steps differ:\n{}", failures.len(), failures.join("\n"));
}

/// Every recorded sequence has its own test, because building each one's workspace writes dozens of files through the
/// file service and the sequences are independent.
macro_rules! sequence_tests {
    ($($test:ident => $name:literal,)*) => {
        $(
            #[tokio::test]
            async fn $test() {
                replay_sequence($name).await
            }
        )*
        const SEQUENCE_TESTS: &[&str] = &[$($name),*];
    };
}

sequence_tests! {
    read_twice => "read-twice",
    window_twice => "window-twice",
    ranged_partial => "ranged-partial",
    batch_never_stubs => "batch-never-stubs",
    edit_then_read => "edit-then-read",
    edit_unread => "edit-unread",
    edit_after_partial_read => "edit-after-partial-read",
    patch_then_read => "patch-then-read",
    external_change => "external-change",
    external_then_edit => "external-then-edit",
    cache_lifetime => "cache-lifetime",
    two_sessions => "two-sessions",
    two_files => "two-files",
    over_cache_size => "over-cache-size",
    special_bodies => "special-bodies",
    glob_twice => "glob-twice",
    ctime_only_change => "ctime-only-change",
    switch_rereads_in_full => "switch-rereads-in-full",
    switch_before_the_flush => "switch-before-the-flush",
    switch_keeps_other_sessions => "switch-keeps-other-sessions",
    switch_after_a_ranged_read => "switch-after-a-ranged-read",
    switch_with_nothing_read => "switch-with-nothing-read",
    switch_twice => "switch-twice",
    switch_after_a_patch => "switch-after-a-patch",
    patch_rename => "patch-rename",
    patch_rename_unread => "patch-rename-unread",
    patch_delete => "patch-delete",
    patch_create => "patch-create",
    patch_dry_run => "patch-dry-run",
    patch_rejected_batch => "patch-rejected-batch",
    patch_partial_batch => "patch-partial-batch",
    patch_ordered => "patch-ordered",
    patch_ordered_failure => "patch-ordered-failure",
    patch_unified => "patch-unified",
    patch_unified_ordered => "patch-unified-ordered",
    patch_after_partial_read => "patch-after-partial-read",
    patch_twice => "patch-twice",
    image_twice => "image-twice",
    no_session => "no-session",
}

/// The local file service, except that stating a file with one of `names` fails, one with a name of the third list
/// never answers (a dead mount) and one named in the control's `delays` answers after that many virtual milliseconds.
struct StatFails(Arc<dyn FileService>, &'static [&'static str], &'static [&'static str], Arc<StatControl>);

#[derive(Default)]
struct StatControl {
    /// Signalled as a stat that never answers starts.
    hung: tokio::sync::Notify,
    delays: &'static [(&'static str, u64)],
}

#[async_trait::async_trait]
impl FileService for StatFails {
    async fn stat(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        if self.2.iter().any(|name| path.as_path().ends_with(name)) {
            self.3.hung.notify_one();
            std::future::pending::<()>().await;
        }
        if let Some((_, ms)) = self.3.delays.iter().find(|(name, _)| path.as_path().ends_with(name)) {
            tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
        }
        if self.1.iter().any(|name| path.as_path().ends_with(name)) {
            return Err(mixdog_core_api::domain::fs::FsError::new(mixdog_core_api::domain::fs::FsErrorKind::PermissionDenied, Some(path)));
        }
        self.0.stat(lane, path).await
    }
    async fn read(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath, range: mixdog_core_api::domain::fs::ReadRange) -> Result<mixdog_core_api::domain::fs::FileBytes, mixdog_core_api::domain::fs::FsError> {
        self.0.read(lane, path, range).await
    }
    async fn list_dir(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<Vec<mixdog_core_api::domain::fs::DirEntry>, mixdog_core_api::domain::fs::FsError> {
        self.0.list_dir(lane, path).await
    }
    async fn write(&self, lane: mixdog_rt::DurabilityIo, request: WriteRequest) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.write(lane, request).await
    }
    async fn write_batch(&self, lane: mixdog_rt::DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<mixdog_core_api::domain::fs::FileStat>, mixdog_core_api::domain::fs::FsError> {
        self.0.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.create_dir(lane, path, recursive).await
    }
    async fn rename(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.rename(lane, from, to, overwrite).await
    }
    async fn copy(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.copy(lane, from, to, overwrite).await
    }
    async fn remove(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.remove(lane, path, recursive).await
    }
    fn walk(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::WalkRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>> {
        self.0.walk(lane, request)
    }
    fn search_text(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::SearchRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::SearchMatch, mixdog_core_api::domain::fs::FsError>>> {
        self.0.search_text(lane, request)
    }
}

/// Newest-first `glob`: files whose stat failed cannot be ordered by time, so they follow every
/// stated file (one dated at the epoch included) in walk order, as Node's mtime top-K keeps them
/// (`search-glob-tool.mjs` `_createGlobMtimeTopK`, `serve_search/mtime.rs`; recording `tools-fs-glob-order`).
#[tokio::test]
async fn glob_puts_files_whose_stat_failed_last_in_walk_order() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-fs-glob-order/golden.json")).unwrap();
    let case = &doc["cases"][0];
    assert_eq!(case["case"], "glob orders failed-stat matches last in walk order");
    let (_dir, root) = small_dir();
    let mut failed = Vec::new();
    for entry in case["entries"].as_array().unwrap() {
        let name = entry["path"].as_str().unwrap();
        std::fs::write(root.as_path().join(name), "x\n").unwrap();
        set_mtime(&root.as_path().join(name), std::time::UNIX_EPOCH + std::time::Duration::from_millis(entry["mtimeMs"].as_u64().unwrap()));
        if entry["failed"] == true {
            // StatFails holds its names for the program's life.
            failed.push(&*Box::leak(name.to_owned().into_boxed_str()));
        }
    }
    let failed: &'static [&'static str] = Box::leak(failed.into_boxed_slice());
    let ctx = context_seeded(&root, Arc::new(StatFails(local_ctx_files(), failed, &[], Default::default())), Vec::new()).await;
    let names = |value: &JsonValue| value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    // The whole list, then a page of the recorded bound less one (Node's window holds the page and one more).
    let all = &case["bounded"][0];
    let (is_error, text) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "limit": 0 })).await);
    assert!(!is_error, "{text}");
    assert_eq!(text.lines().map(str::to_owned).collect::<Vec<_>>(), names(&all["values"]));
    let bounded = &case["bounded"][1];
    let page = bounded["bound"].as_u64().unwrap() - 1;
    let (is_error, text) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "limit": page })).await);
    assert!(!is_error, "{text}");
    let want = names(&bounded["values"]);
    assert_eq!(text.lines().take(page as usize).map(str::to_owned).collect::<Vec<_>>(), want[..page as usize]);
}

/// A glob-shaped `list` path bounds each candidate's stat by 1 000 ms, 64 at a time (Node `collectFindMatches`,
/// `statPathsForMtime(…, 64, { deadlineMs: FIND_STAT_DEADLINE_MS })`), not the whole pass: a stat that never answers
/// leaves its row with `-` at its own deadline, a stat that starts late (the 65th, once a slow one ends at 900 ms)
/// still answers 600 ms into its own bound, past 1 000 ms of the pass, and every metadata read stays in the answer.
/// Virtual time moves only by the advances below.
#[tokio::test]
async fn a_glob_shaped_list_bounds_each_stat_and_keeps_what_it_read() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-list-stat").join("ws")).unwrap();
    let mut names = vec!["a-slow.ts".to_owned()];
    names.extend((0..62).map(|i| format!("f{i:02}.ts")));
    names.extend(["hang.ts".to_owned(), "z-late.ts".to_owned()]);
    let seeds = names.iter().map(|n| (n.clone(), b"x\n".to_vec())).collect();
    let control = Arc::new(StatControl { delays: &[("a-slow.ts", 900), ("z-late.ts", 600)], ..StatControl::default() });
    let ctx = context_seeded(&root, Arc::new(StatFails(Arc::new(MockFileService::default()), &[], &["hang.ts"], control.clone())), seeds).await;
    tokio::time::pause();
    let tool = ListTool::new();
    let mut call = Box::pin(tool.call(&ctx, serde_json::json!({ "path": "*.ts", "limit": 0 })));
    // No timer is pending until the stats start, so the clock stands still while the walk runs on its lane.
    tokio::select! {
        biased;
        () = control.hung.notified() => {}
        out = &mut call => panic!("answered before the never-answering stat started: {out:?}"),
    }
    let pending = |poll: std::task::Poll<_>, what: &str| assert!(poll.is_pending(), "answered {what}");
    pending(futures::poll!(&mut call), "with the stats just started");
    tokio::time::advance(std::time::Duration::from_millis(899)).await;
    pending(futures::poll!(&mut call), "before the slow stat ended");
    // tokio rounds a timer up to its next whole millisecond tick; the 65th stat starts here.
    tokio::time::advance(std::time::Duration::from_millis(2)).await;
    pending(futures::poll!(&mut call), "before the late stat started");
    tokio::time::advance(std::time::Duration::from_millis(100)).await;
    pending(futures::poll!(&mut call), "when the never-answering stat reached its deadline, with a later stat in its own bound");
    tokio::time::advance(std::time::Duration::from_millis(501)).await;
    let std::task::Poll::Ready(outcome) = futures::poll!(&mut call) else { panic!("no answer once the late stat answered") };
    let (is_error, text) = text_of(outcome);
    assert!(!is_error, "{text}");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 66, "{text}");
    assert_eq!(lines.iter().filter(|l| l.ends_with("\t-\t-")).copied().collect::<Vec<_>>(), ["hang.ts\t-\t-"], "{text}");
    assert!(lines.iter().any(|l| l.starts_with("z-late.ts\t") && !l.ends_with("\t-\t-")), "{text}");
    assert!(lines.iter().any(|l| l.starts_with("a-slow.ts\t") && !l.ends_with("\t-\t-")), "{text}");
    assert_eq!(lines[65], "... 1 path(s) had no metadata within 1000ms; listed with \"-\" for size/date");
}

/// A glob or find rooted at a POSIX filesystem root walks neither `/proc`, `/sys` nor `/dev`;
/// rooted inside one of them it lists that tree (Node `rootScanIgnoreGlobs`). The filesystem
/// root here is the in-memory service's, the drive root on Windows.
#[tokio::test]
async fn a_scan_of_the_filesystem_root_skips_the_kernel_trees() {
    let root = AbsPath::new(if cfg!(windows) { "C:\\" } else { "/" }).unwrap();
    let seeds = ["proc/1/status", "sys/block/sda/size", "dev/null-ish", "home/u/a.txt", "procfs.txt"]
        .iter()
        .map(|rel| (rel.to_string(), b"x\n".to_vec()))
        .collect();
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let listed = |entries: Vec<mixdog_core_api::domain::fs::DirEntry>| {
        entries.into_iter().map(|e| super::common::display_under(e.path.as_path(), root.as_path())).collect::<Vec<_>>()
    };
    let walked = super::search::walk_entries_pruned(&ctx, &root, false, |_| true, super::search::root_scan_prunes(&root, true), None, None).await.unwrap();
    assert!(walked.complete);
    assert_eq!(listed(walked.entries), ["home/u/a.txt", "procfs.txt"]);
    let proc_root = AbsPath::new(root.as_path().join("proc")).unwrap();
    let walked = super::search::walk_entries_pruned(&ctx, &proc_root, false, |_| true, super::search::root_scan_prunes(&proc_root, true), None, None).await.unwrap();
    assert_eq!(walked.entries.len(), 1);
}

/// Node's `rootScanIgnoreGlobs` answers (recording `tools-fs-glob-order`), each root put under the host's filesystem root.
#[test]
fn root_scan_prunes_are_nodes_root_scan_ignore_globs() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-fs-glob-order/golden.json")).unwrap();
    let case = &doc["cases"][1];
    assert_eq!(case["case"], "root-anchored kernel-tree prunes apply only to a posix filesystem-root scan");
    let fs_root = std::path::PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" });
    for answer in case["answers"].as_array().unwrap() {
        let given = answer["root"].as_str().unwrap();
        // No call reaches the scan without a root: a blank `path` is the cwd.
        if given.is_empty() {
            continue;
        }
        let root = AbsPath::new(given.split('/').filter(|s| !s.is_empty()).fold(fs_root.clone(), |p, s| p.join(s))).unwrap();
        let got: Vec<String> = super::search::root_scan_prunes(&root, answer["platform"] == "linux")
            .iter()
            .map(|p| super::common::fwd(p.as_path().strip_prefix(root.as_path()).unwrap()))
            .collect();
        let want: Vec<String> = answer["globs"].as_array().unwrap().iter().map(|g| g.as_str().unwrap().trim_start_matches('!').trim_end_matches("/**").to_owned()).collect();
        assert_eq!(got, want, "{answer}");
    }
}

/// Past 50 000 files a bounded glob still ranks and counts every match (Node's windowed pass
/// reports its total over the whole scope) and find still scores every file (Node's native
/// inventory has no entry cap); an unbounded glob keeps 50 000 and says the list is incomplete.
#[tokio::test]
async fn glob_and_find_see_files_past_fifty_thousand_entries() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-cap").join("ws")).unwrap();
    let mut seeds: Vec<(String, Vec<u8>)> = (0..50_000).map(|i| (format!("f/{i:05}.txt"), Vec::new())).collect();
    seeds.push(("zz/last-one.txt".to_owned(), Vec::new()));
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let (_, glob) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "**/*.txt" })).await);
    assert!(glob.ends_with("[entries 1-100 of 50001; offset:100 for more]"), "{}", &glob[glob.len().saturating_sub(200)..]);
    let (_, find) = text_of(FindTool::new().call(&ctx, serde_json::json!({ "query": "last-one" })).await);
    assert_eq!(find, "zz/last-one.txt");
    let walked = super::search::walk_entries_pruned(&ctx, &root, false, |_| true, Vec::new(), Some(super::search::GLOB_ACCUM_CAP), None).await.unwrap();
    assert!(walked.capped && walked.entries.len() == 50_000);
}

/// A recorded sequence without a test, or a test without a recorded sequence, fails here.
#[test]
fn every_recorded_sequence_has_its_session_memory_test() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/batch_cases.json")).unwrap();
    let recorded: Vec<&str> = doc["sequences"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(recorded, SEQUENCE_TESTS);
}
