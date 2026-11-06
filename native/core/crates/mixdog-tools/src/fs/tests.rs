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

async fn run_golden(ctx: &ToolContext, root: &AbsPath, cases: &[&str]) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools");
    let tools: Vec<Box<dyn Tool>> = vec![
        Box::new(ReadTool::new(None)),
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

fn snapshot(dir: &Path, base: &Path, out: &mut std::collections::BTreeMap<String, String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            snapshot(&path, base, out);
        } else {
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            out.insert(rel, String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned());
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
        let seeds = case["files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(rel, text)| (rel.clone(), text.as_str().unwrap().as_bytes().to_vec()))
            .collect();
        let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), seeds).await;
        let tool_name = case["tool"].as_str().unwrap();
        let tool = tools.iter().find(|t| t.spec().name == tool_name).unwrap();
        let root_text = root.as_path().to_string_lossy().replace('\\', "/");
        let mut input = case["input"].clone();
        if let Some(b) = input.get_mut("base_path") {
            *b = JsonValue::String(root_text.clone());
        }
        // `edit` also takes the recorded `path` key as it is.
        let (is_error, text) = text_of(tool.call(&ctx, input).await);
        let text = text.replace(&root_text, "<ROOT>").replace(&root.as_path().to_string_lossy().into_owned(), "<ROOT>");
        let mut after = std::collections::BTreeMap::new();
        snapshot(root.as_path(), root.as_path(), &mut after);
        let want_after: std::collections::BTreeMap<String, String> = case["after"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
            .collect();
        if text != want || is_error != case["isError"].as_bool().unwrap() || after != want_after {
            failures.push(format!("{name}:\n  want {want:?}\n  got  {text:?} (error={is_error})\n  want tree {want_after:?}\n  got  tree {after:?}"));
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
