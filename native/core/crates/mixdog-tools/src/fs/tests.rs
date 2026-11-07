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

/// The built-in tools are Node's definition objects, whole (`fixtures/tool-defs/definitions.json`,
/// `record-tool-definitions.mjs`): the description and the `inputSchema` the model is sent, key for
/// key, with the title, trigger and every hint. A delegated agent's `git` is Node's agent variant.
#[test]
fn the_builtin_tools_are_nodes_definitions() {
    let golden: JsonValue = serde_json::from_str(include_str!("../../../../fixtures/tool-defs/definitions.json")).expect("the golden is JSON");
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
        Box::new(crate::github::GithubTool::new()),
    ];
    for tool in &tools {
        let spec = tool.spec();
        let node = golden["definitions"].as_array().expect("definitions").iter().find(|def| def["name"] == spec.name.as_str()).expect("a Node definition");
        assert_eq!(&tool.definition(), node, "{}", spec.name);
        assert_eq!(spec.annotations.to_json().to_string(), node["annotations"].to_string(), "{} annotations", spec.name);
    }
    let node_agent_git = golden["variants"].as_array().expect("variants").iter().find(|row| row["name"] == "git" && row["surface"] == "agent").expect("the agent git");
    let git = crate::git::GitTool::new();
    assert_eq!(&git.agent_spec().expect("git has an agent text").definition(), &node_agent_git["definition"]);
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
    let cases: Vec<JsonValue> = serde_json::from_str(include_str!("golden/cases.json")).unwrap();
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
    tokio::time::sleep(Duration::from_millis(100)).await;
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

    tokio::time::sleep(Duration::from_millis(50)).await;
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
    tokio::time::sleep(Duration::from_millis(150)).await;
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
        tokio::time::sleep(Duration::from_millis(200)).await;
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

/// Cases of `legacy_read_cases.json` this tool does not answer as Node does, each with why. They
/// are the forms Node serves through readers this port does not have.
const LEGACY_UNPORTED: &[(&str, &str)] = &[
    ("coordinate-missing-file", "Node's Windows-path guard (NTFS ADS suffix) judges `nope.txt:5`; the guard is not ported"),
    ("array-json-string", "the message holds the recording host's absolute path"),
    ("array-json-one", "the message holds the recording host's absolute path"),
    ("array-json-object-string", "Node's Windows-path guard (NTFS ADS suffix) judges the JSON text; the guard is not ported"),
    ("mode-head-glob", "a glance mode over a glob survey"),
    ("region-and-string", "a batch entry without a path (`(missing-path)` entry)"),
    ("region-empty-path", "a batch entry without a path (`(missing-path)` entry)"),
    ("tuple-mixed", "a batch entry without a path (`(missing-path)` entry)"),
    ("region-mode-head", "a glance mode on a batch entry"),
    ("region-mode-count", "a glance mode on a batch entry"),
    ("region-mode-hex", "a glance mode on a batch entry"),
    ("region-mode-summary", "a glance mode on a batch entry"),
    ("region-negative-offset", "a glance mode on a batch entry"),
    ("region-negative-offset-mode", "a glance mode on a batch entry"),
    ("region-full", "`full` on a batch entry"),
    ("array-full", "`full` on a batch entry"),
    ("array-mode-head", "a glance mode on a batch entry"),
    ("array-mode-tail", "a glance mode on a batch entry"),
    ("array-mode-count", "a glance mode on a batch entry"),
    ("array-mode-summary", "a glance mode on a batch entry"),
    ("array-mode-hex", "a glance mode on a batch entry"),
    ("array-mode-with-window", "a glance mode on a batch entry"),
    ("array-mode-missing", "a glance mode on a batch entry"),
    ("array-mode-repeat", "a glance mode on a batch entry"),
];

/// Node's `read` for the executor's own `path` spelling (a string, an array, region objects,
/// compact tuples; `limit:0`, a negative `offset`, `line`/`context`, `mode`/`n`, `full`), replayed
/// from `legacy_read_cases.json`, which `record_legacy_read.mjs` recorded from Node over the
/// workspace of `batch_cases.json` (plus `extraFiles`). The guard's own outcomes are checked in
/// `read_legacy`.
#[tokio::test]
async fn the_legacy_path_spelling_reads_as_node_reads() {
    let batch: JsonValue = serde_json::from_str(include_str!("golden/batch_cases.json")).unwrap();
    let doc: JsonValue = serde_json::from_str(include_str!("golden/legacy_read_cases.json")).unwrap();
    let mut workspace = batch.clone();
    workspace["files"].as_object_mut().unwrap().extend(doc["extraFiles"].as_object().unwrap().clone());
    let dir = tempfile::tempdir().unwrap();
    let (root, ctx) = recorded_workspace(&workspace, dir.path(), false).await;
    let cwd = root.as_path().to_string_lossy().replace('\\', "/");
    let tool = ReadTool::new(None, None);
    let cases = doc["cases"].as_array().unwrap();
    for (name, _) in LEGACY_UNPORTED {
        assert!(cases.iter().any(|c| c["name"] == *name), "{name} is not a recorded case");
    }
    let mut failures = Vec::new();
    let mut ran = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if LEGACY_UNPORTED.iter().any(|(n, _)| *n == name) {
            continue;
        }
        ran += 1;
        let got = summary(&tool.call(&ctx, case["input"].clone()).await, &cwd);
        let expected = vec![("text".to_owned(), case["result"]["text"].as_str().unwrap().to_owned())];
        if got != expected {
            failures.push(format!("{name}\n  want {expected:?}\n  got  {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{} of {ran} differ:\n{}", failures.len(), failures.join("\n"));
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
    let fix = |s: &str| s.replace(cwd, "<WS>");
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
    let doc: JsonValue = serde_json::from_str(include_str!("golden/batch_cases.json")).unwrap();
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
#[tokio::test]
async fn the_session_memory_answers_repeated_reads_as_node_does() {
    let doc: JsonValue = serde_json::from_str(include_str!("golden/batch_cases.json")).unwrap();
    let mut failures = Vec::new();
    for sequence in doc["sequences"].as_array().unwrap() {
        let name = sequence["name"].as_str().unwrap();
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