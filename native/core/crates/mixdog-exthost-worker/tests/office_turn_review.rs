use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_fsio::Unlaned;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

fn pool() -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(mixdog_testkit::bin_exe!("ext_worker_dev")),
        args: Vec::new(),
        workers: 1,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig {
            command: None,
            profile_root: std::env::temp_dir().join("mixdog-exthost-worker-office-review-tests"),
            no_sandbox: false,
        },
    })
    .expect("the pool starts")
}

/// One side of a written file as the review takes it.
#[derive(Debug, PartialEq)]
enum Side {
    Absent,
    Bytes(Vec<u8>),
}

#[derive(Debug)]
struct Write {
    path: PathBuf,
    before: Side,
    after: Side,
}

/// The receipts of a call: each `{bytes: n}` side takes its `n` bytes from the chunk stream, in the order sent.
fn receipts(writes: &Value, stream: &[u8]) -> Vec<Write> {
    let mut at = 0;
    let mut side = |spec: &Value| match spec.get("bytes").and_then(Value::as_u64) {
        Some(count) => {
            let end = at + usize::try_from(count).expect("a size");
            let bytes = stream[at..end].to_vec();
            at = end;
            Side::Bytes(bytes)
        }
        None => {
            assert!(spec.is_null(), "an uncaptured side is not expected here: {spec}");
            Side::Absent
        }
    };
    let writes = writes
        .as_array()
        .expect("writes")
        .iter()
        .map(|write| {
            let before = side(&write["before"]);
            let after = side(&write["after"]);
            Write { path: PathBuf::from(write["path"].as_str().expect("a path")), before, after }
        })
        .collect();
    assert_eq!(at, stream.len(), "every chunk byte belongs to a receipt");
    writes
}

struct Turn {
    pool: ExtHostPool,
    root: PathBuf,
    data: PathBuf,
}

impl Turn {
    fn call(&self, args: Value) -> ExtCall {
        ExtCall {
            thread: ThreadId::from("review"),
            method: "office.run".to_owned(),
            params: json!({"args": args, "cwd": self.root.to_string_lossy(), "dataDir": self.data.to_string_lossy()}),
            paths: vec![AbsPath::new(self.root.clone()).expect("an absolute folder")],
        }
    }

    /// The answer and the receipts of a call that has been started.
    async fn finish(mut stream: Box<dyn EventSource<ExtFrame>>) -> (Value, Vec<Write>) {
        let mut bytes = Vec::new();
        loop {
            match stream.next().await.expect("the stream ends with Done") {
                ExtFrame::Chunk(chunk) => bytes.extend(chunk),
                ExtFrame::Done(outcome) => {
                    let value = outcome.expect("the call succeeds");
                    assert!(value["result"]["isError"].is_null(), "the tool answered an error: {value}");
                    let writes = receipts(&value["writes"], &bytes);
                    return (value, writes);
                }
            }
        }
    }

    async fn run(&self, args: Value) -> (Value, Vec<Write>) {
        let stream = self.pool.call(self.call(args)).expect("the call is accepted");
        Self::finish(stream).await
    }
}

fn read(path: &Path) -> Vec<u8> {
    mixdog_fsio::read(&Unlaned, path).expect("the file")
}

fn put(path: &Path, text: &str) {
    mixdog_fsio::write(&Unlaned, path, text.as_bytes()).expect("the file is written");
}

fn session_of(value: &Value) -> String {
    let text = value["result"]["content"][0]["text"].as_str().expect("a text block");
    let created: Value = serde_json::from_str(text).expect("JSON");
    created["session"].as_str().expect("a session").to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_written_files_are_the_calls_own_changes_a_sibling_is_not_and_undo_restores_exact_bytes() {
    let scratch = tempfile::tempdir().expect("scratch");
    let root = dunce::canonicalize(scratch.path()).expect("the scratch folder").join("repo");
    mixdog_fsio::create_dir_all(&Unlaned, &root).expect("folder");
    let turn = Turn { pool: pool(), data: root.parent().expect("a parent").join("data"), root: root.clone() };
    put(&root.join("notes.txt"), "notes\n");
    put(&root.join("report-notes.txt"), "notes beside the report\n");

    // Written before the turn, by no turn: the original.
    let (made, _) = turn
        .run(json!({"action": "create", "path": "report.docx", "mode": "portable", "operations": [{"op": "append_text", "text": "First paragraph."}]}))
        .await;
    let session = session_of(&made);
    let original = read(&root.join("report.docx"));

    // The turn: an edit of the document, with a sibling named after it changing while the edit runs.
    let edit = turn
        .pool
        .call(turn.call(json!({"action": "batch", "session": session, "save": true, "operations": [{"op": "append_text", "text": "Second paragraph."}]})))
        .expect("accepted");
    put(&root.join("report-notes.txt"), "concurrent edit\n");
    let (_, edited) = Turn::finish(edit).await;
    let (_, created) = turn
        .run(json!({"action": "create", "path": "budget.xlsx", "mode": "portable", "operations": [{"op": "set_range", "sheet": "Sheet1", "range": "A1:B1", "values": [["Item", "Cost"]]}]}))
        .await;
    // Read-only calls write nothing.
    let (_, read_only) = turn.run(json!({"action": "snapshot", "session": session})).await;
    assert!(read_only.is_empty());

    assert_eq!(edited.len(), 1, "{edited:?}");
    assert_eq!(edited[0].path, root.join("report.docx"));
    assert_eq!(edited[0].before, Side::Bytes(original.clone()), "the receipt holds the exact bytes before the edit");
    let now = read(&root.join("report.docx"));
    assert_ne!(now, original);
    assert_eq!(edited[0].after, Side::Bytes(now));
    assert_eq!(created.len(), 1, "{created:?}");
    assert_eq!(created[0].path, root.join("budget.xlsx"));
    assert_eq!(created[0].before, Side::Absent);
    assert_eq!(created[0].after, Side::Bytes(read(&root.join("budget.xlsx"))));

    // Undo: each file's first "before" put back.
    let mut changed: Vec<&Write> = Vec::new();
    for write in edited.iter().chain(&created) {
        if !changed.iter().any(|seen| seen.path == write.path) {
            changed.push(write);
        }
    }
    let paths: Vec<String> = changed.iter().map(|write| write.path.file_name().expect("a name").to_string_lossy().into_owned()).collect();
    assert_eq!(paths, ["report.docx", "budget.xlsx"], "a sibling no Office route wrote is not the turn's");
    for write in changed {
        match &write.before {
            Side::Bytes(bytes) => mixdog_fsio::write(&Unlaned, &write.path, bytes).expect("restored"),
            Side::Absent => mixdog_fsio::remove_file(&Unlaned, &write.path).expect("removed"),
        }
    }
    assert_eq!(read(&root.join("report.docx")), original);
    assert!(!mixdog_fsio::exists(&Unlaned, &root.join("budget.xlsx")).expect("readable"));
    assert_eq!(read(&root.join("notes.txt")), b"notes\n");
    assert_eq!(read(&root.join("report-notes.txt")), b"concurrent edit\n");
    turn.pool.close().await;
}
