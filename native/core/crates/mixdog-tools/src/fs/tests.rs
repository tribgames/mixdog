//! Golden tests: the file tools against `fixtures/tools/{read,list,glob,find,grep,edit,apply_patch}`.
//! Cases replay in the recorder's order over one in-memory workspace (edits
//! and patches mutate it for the cases after them). `list-meta` needs real
//! mtimes and modes, which the in-memory file service does not carry.

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
    let files = Arc::new(MockFileService::default());
    let tokens = mixdog_rt::testing::tokens();
    for (rel, bytes) in seed() {
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
        if let Some(p) = obj.remove("path") {
            obj.insert("file_path".into(), p);
        }
    }
    if let Some(h) = obj.remove("head_limit") {
        obj.insert("limit".into(), h);
    }
    if let Some(m) = obj.remove("output_mode") {
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

#[tokio::test]
async fn file_tools_match_golden_fixtures() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-golden").join("ws")).unwrap();
    let ctx = context(&root).await;
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools");
    let cases = [
        "read/read-file", "read/read-range", "read/read-binary", "read/read-missing",
        "list/list-root", "list/list-hidden", "list/list-paged",
        "glob/glob-mjs", "find/find-math",
        "grep/grep-files", "grep/grep-content-context", "grep/grep-count",
        "edit/edit-replace", "edit/edit-no-match",
        "apply_patch/patch-update", "apply_patch/patch-stale-dry-run",
    ];
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
    for case in cases {
        let fixture: JsonValue =
            serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{case}.json"))).unwrap()).unwrap();
        let name = fixture["tool"].as_str().unwrap();
        let tool = tools.iter().find(|t| t.spec().name == name).unwrap();
        let mut input = fixture["input"].clone();
        if let Some(b) = input.get_mut("base_path") {
            *b = JsonValue::String(root_text.clone());
        }
        let (is_error, text) = text_of(tool.call(&ctx, schema_args(name, input)).await);
        let text = text.replace(&root_text, "<ROOT>");
        let want = fixture["text"].as_str().unwrap();
        if text != want || is_error != fixture["isError"].as_bool().unwrap() {
            failures.push(format!("{case}:\n  want {want:?}\n  got  {text:?} (error={is_error})"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
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
