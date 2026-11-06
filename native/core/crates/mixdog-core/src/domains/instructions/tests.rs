//! Replays the scenario of `goldens/instructions.json`, which
//! `tools/gen-instructions-golden.mjs` recorded from the 1.4.5 Node API over the same shipped
//! files (`goldens/instructions-shipped`).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::domains::support::testing::request;
use crate::domains::support::testing::scopes;
use crate::domains::support::testing::value;
use crate::domains::support::testing::with_op;

const GOLDEN: &str = include_str!("../goldens/instructions.json");

/// [`write_atomic`] as a durability-lane job.
fn write_on_lane(path: &std::path::Path, bytes: &[u8], backup: bool) -> Result<(), crate::domains::support::FsFailure> {
    use mixdog_rt::LaneToken;
    let (path, bytes) = (path.to_owned(), bytes.to_vec());
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
        mixdog_rt::testing::tokens()
            .durability_io
            .submit(&tokio_util::sync::CancellationToken::new(), move |lane| write_atomic(lane, &path, &bytes, backup))
            .unwrap()
            .await
            .unwrap()
    })
}

struct Modes(Mutex<String>);

#[async_trait]
impl InstructionFilesMode for Modes {
    async fn set(&self, mode: &str) -> Result<Value, ToolModulesError> {
        if !["all", "agents", "claude", "off"].contains(&mode) {
            return Err(ToolModulesError::InvalidArgument(
                "Instruction files must be one of all, agents, claude, off.".to_owned(),
            ));
        }
        *self.0.lock().unwrap() = mode.to_owned();
        Ok(json!({ "instructionFiles": mode }))
    }

    async fn current(&self) -> Value {
        json!({ "instructionFiles": *self.0.lock().unwrap() })
    }
}

#[derive(Default)]
struct Announced(Mutex<usize>);

#[async_trait]
impl InstructionsChanged for Announced {
    async fn changed(&self) {
        *self.0.lock().unwrap() += 1;
    }
}

struct Rig {
    service: Arc<InstructionsService>,
    announced: Arc<Announced>,
    modes: Arc<Modes>,
    data: tempfile::TempDir,
    next_op: u64,
}

async fn rig() -> Rig {
    let data = tempfile::tempdir().unwrap();
    let shipped = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/domains/goldens/instructions-shipped");
    let announced = Arc::new(Announced::default());
    let modes = Arc::new(Modes(Mutex::new("off".into())));
    let service = InstructionsService::new(
        InstructionPaths {
            shipped_orchestration: shipped.join("orchestration"),
            shipped_output_styles: shipped.join("output-styles"),
            data_dir: data.path().to_owned(),
        },
        modes.clone(),
        announced.clone(),
        scopes(data.path(), "instructions").await,
        &mixdog_rt::testing::tokens(),
    );
    Rig {
        service,
        announced,
        modes,
        data,
        next_op: 1,
    }
}

impl Rig {
    async fn call(&mut self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let mutating = !method.contains("list") && !method.contains("get");
        let (params, op) = if mutating {
            self.next_op += 1;
            (with_op(params, self.next_op), Some(self.next_op))
        } else {
            (params, None)
        };
        value(&*self.service, request(method, params, op)).await
    }

    fn user(&self, rel: &str, text: &str) {
        let path = self.data.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}

/// The code and the message of a refusal, as the wire carries them.
fn refusal(error: CoreError) -> (Option<String>, String) {
    match error {
        CoreError::DomainError {
            code,
            message: Some(message),
            detail: None,
            ..
        } => (code.map(|c| c.to_string()), message.to_string()),
        other => panic!("unexpected error {other:?}"),
    }
}

/// `<DATA>` for the data dir and `/` separators, as the golden is written.
fn normal(value: Value, data: &std::path::Path) -> Value {
    let text = value
        .to_string()
        .replace(&data.to_string_lossy().replace('\\', "\\\\"), "<DATA>")
        .replace("\\\\", "/");
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn the_scenario_answers_what_the_node_api_answered() {
    let steps: Vec<Value> = serde_json::from_str(GOLDEN).unwrap();
    let mut rig = rig().await;
    let shipped_balanced = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/domains/goldens/instructions-shipped/orchestration/balanced.md"),
    )
    .unwrap();
    for step in &steps {
        let name = step["name"].as_str().unwrap();
        if name == "list with problems" {
            rig.user("orchestration/focused.md", " \n\t\n");
            rig.user(
                "output-styles/minimal.md",
                "---\nname: other\n---\n\nBody\n",
            );
            rig.user(
                "output-styles/detailed.md",
                "---\nname: detailed\ntitle: Mine\n---\n\nMy detailed\r\nbody  \r\n",
            );
        }
        let save = |group: &str, id: &str, body: &str| json!({ "input": { "group": group, "id": id, "body": body } });
        let result = match name {
            "list" | "list with problems" => {
                rig.call("instructions/listInstructionFiles", json!({}))
                    .await
            }
            "get balanced" => {
                rig.call(
                    "instructions/getInstructionFile",
                    json!({ "group": "delegation", "id": "balanced" }),
                )
                .await
            }
            "save crlf" => {
                rig.call(
                    "instructions/saveInstructionFile",
                    save("delegation", "balanced", "  Hello\r\nWorld  \r\n"),
                )
                .await
            }
            "save style" => {
                rig.call(
                    "instructions/saveInstructionFile",
                    save("outputStyle", "simple", "Short answers only."),
                )
                .await
            }
            "save equal to shipped" => {
                rig.call(
                    "instructions/saveInstructionFile",
                    save("delegation", "balanced", &shipped_balanced),
                )
                .await
            }
            "save stale revision" => {
                let mut params = save("delegation", "swarm", "x");
                params["input"]["expectedRevision"] = json!("nope");
                rig.call("instructions/saveInstructionFile", params).await
            }
            "save null revision" => {
                let mut params = save("delegation", "swarm", "x");
                params["input"]["expectedRevision"] = Value::Null;
                rig.call("instructions/saveInstructionFile", params).await
            }
            "save nel" => {
                rig.call(
                    "instructions/saveInstructionFile",
                    save("delegation", "focused", "\u{85}Keep\u{85}"),
                )
                .await
            }
            "save current revision" => {
                let current = rig
                    .call(
                        "instructions/getInstructionFile",
                        json!({ "group": "delegation", "id": "swarm" }),
                    )
                    .await
                    .unwrap();
                let mut params = save("delegation", "swarm", "Swarm text");
                params["input"]["expectedRevision"] = current["revision"].clone();
                rig.call("instructions/saveInstructionFile", params).await
            }
            "save empty" => {
                rig.call(
                    "instructions/saveInstructionFile",
                    save("delegation", "none", " \r\n "),
                )
                .await
            }
            "save nul" => {
                rig.call(
                    "instructions/saveInstructionFile",
                    save("delegation", "none", "a\0b"),
                )
                .await
            }
            "reset without override" => {
                rig.call(
                    "instructions/resetInstructionFile",
                    json!({ "group": "delegation", "id": "none" }),
                )
                .await
            }
            "reset" => {
                rig.call(
                    "instructions/resetInstructionFile",
                    json!({ "group": "delegation", "id": "swarm" }),
                )
                .await
            }
            "reset stale" => {
                rig.call(
                    "instructions/resetInstructionFile",
                    json!({ "group": "outputStyle", "id": "simple", "expectedRevision": "nope" }),
                )
                .await
            }
            "reset null revision" => {
                rig.call(
                    "instructions/resetInstructionFile",
                    json!({ "group": "outputStyle", "id": "simple", "expectedRevision": null }),
                )
                .await
            }
            "bad mode" => {
                rig.call(
                    "instructions/getInstructionFile",
                    json!({ "group": "delegation", "id": "wild" }),
                )
                .await
            }
            "bad style" => {
                rig.call(
                    "instructions/getInstructionFile",
                    json!({ "group": "outputStyle", "id": "loud" }),
                )
                .await
            }
            "bad group" => {
                rig.call(
                    "instructions/getInstructionFile",
                    json!({ "group": "prompts", "id": "x" }),
                )
                .await
            }
            "save too large" => {
                rig.call(
                    "instructions/saveInstructionFile",
                    save("delegation", "none", &"a".repeat(262_144)),
                )
                .await
            }
            other => panic!("unknown step {other}"),
        };
        match (result, step.get("ok")) {
            (Ok(got), Some(want)) => {
                assert_eq!(
                    normal(got, rig.data.path()),
                    normal(want.clone(), std::path::Path::new("<none>")),
                    "step {name}"
                );
            }
            (Err(got), None) => {
                let (code, message) = refusal(got);
                assert_eq!(
                    message,
                    step["error"].as_str().unwrap(),
                    "message of step {name}"
                );
                // Node sets a code on the conflict only; the other refusals are plain errors.
                assert_eq!(code.as_deref(), step["code"].as_str(), "code of step {name}");
            }
            (got, _) => panic!("step {name}: {got:?}"),
        }
    }
    // Every successful save and reset announced; reads and refusals did not.
    assert_eq!(*rig.announced.0.lock().unwrap(), 6);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mutation_waits_for_the_lock_of_its_file() {
    let rig = rig().await;
    let user = rig.data.path().join("orchestration/none.md");
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let lock = path_lock(&user);
        let _held = lock.lock().unwrap();
        held_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    held_rx.recv().unwrap();
    let service = rig.service.clone();
    let mut save = tokio::spawn(async move {
        let params = with_op(
            json!({ "input": { "group": "delegation", "id": "none", "body": "Locked" } }),
            3,
        );
        value(
            &*service,
            request("instructions/saveInstructionFile", params, Some(3)),
        )
        .await
    });
    // The check and the write of another mutation of the same file are in progress.
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut save)
            .await
            .is_err()
    );
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    assert_eq!(save.await.unwrap().unwrap()["body"], "Locked");
}

#[test]
fn writers_of_one_file_never_collide_on_a_temp_name() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("orchestration").join("none.md");
    let barrier = Arc::new(std::sync::Barrier::new(16));
    let writers: Vec<_> = (0..16)
        .map(|n| {
            let (path, barrier) = (path.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                (0..25).try_for_each(|i| {
                    write_on_lane(&path, format!("writer {n} round {i}\n").as_bytes(), true)
                })
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap().unwrap();
    }
    assert!(
        std::fs::read_to_string(&path)
            .unwrap()
            .starts_with("writer ")
    );
    let mut names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["none.md", "none.md.bak"]);
}

#[tokio::test]
async fn a_replayed_result_too_large_to_store_is_read_on_the_lane() {
    let rig = rig().await;
    let params = with_op(
        json!({ "input": { "group": "delegation", "id": "none", "body": "a".repeat(20_000) } }),
        4,
    );
    value(
        &*rig.service,
        request("instructions/saveInstructionFile", params.clone(), Some(4)),
    )
    .await
    .unwrap();
    // The lane drops a job whose caller is gone before it starts; a read made on the runtime
    // worker instead would not notice.
    let duplicate = request("instructions/saveInstructionFile", params, Some(4));
    duplicate.ctx.cancel.cancel();
    let error = value(&*rig.service, duplicate).await.unwrap_err();
    assert!(matches!(error, CoreError::Cancelled { .. }), "{error:?}");
}

#[tokio::test]
async fn a_repeated_op_changes_once_and_answers_the_same() {
    let mut rig = rig().await;
    let params = with_op(
        json!({ "input": { "group": "delegation", "id": "none", "body": "Once" } }),
        9,
    );
    let first = value(
        &*rig.service,
        request("instructions/saveInstructionFile", params.clone(), Some(9)),
    )
    .await
    .unwrap();
    let again = value(
        &*rig.service,
        request("instructions/saveInstructionFile", params, Some(9)),
    )
    .await
    .unwrap();
    assert_eq!(first, again);
    assert_eq!(*rig.announced.0.lock().unwrap(), 1);
    let _ = &mut rig;
}

#[tokio::test]
async fn the_mode_is_validated_and_stored_by_the_tool_modules() {
    let mut rig = rig().await;
    let set = rig
        .call(
            "instructions/setInstructionFiles",
            json!({ "mode": "claude" }),
        )
        .await
        .unwrap();
    assert_eq!(set, json!({ "instructionFiles": "claude" }));
    assert_eq!(*rig.modes.0.lock().unwrap(), "claude");
    let refused = rig
        .call(
            "instructions/setInstructionFiles",
            json!({ "mode": "everything" }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        refusal(refused).1,
        "Instruction files must be one of all, agents, claude, off."
    );
}

/// The text of an `fs` failure is Node's `<errno>: <description>, <syscall> '<path>'` with the
/// syscall of the step Node's own code path fails at. The one difference from Node is the temp
/// file's name: Node and Rust each draw their own 8 random bytes (`<name>.mixdog-tmp-<16 hex>`),
/// so that part is compared by shape, never by value.
#[test]
fn a_failed_write_reads_as_the_node_error_of_the_same_step() {
    use crate::domains::support::FsFailure;
    use crate::domains::support::FsStep;
    use crate::domains::support::io_failure;

    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("none.md");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("inner"), "x").unwrap();
    // Node: `rename '<tmp>' -> '<target>'`, EPERM on Windows (libuv's ACCESS_DENIED), EISDIR
    // elsewhere, over a directory that holds a file.
    let failure = write_on_lane(&target, b"text", false).unwrap_err();
    let (code, description) = if cfg!(windows) {
        ("EPERM", "operation not permitted")
    } else {
        ("EISDIR", "illegal operation on a directory")
    };
    let (got_code, message) = refusal(io_failure("instructions", &failure));
    assert_eq!(got_code.as_deref(), Some(code));
    let shape = regex::Regex::new(&format!(
        "^{code}: {description}, rename '{}\\.mixdog-tmp-[0-9a-f]{{16}}' -> '{}'$",
        regex::escape(&target.display().to_string()),
        regex::escape(&target.display().to_string()),
    ))
    .unwrap();
    assert!(shape.is_match(&message), "{message}");
    // No temp file is left behind.
    let left: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left, ["none.md"]);

    // The other steps, with the syscall each is in Node.
    let denied = |step| FsFailure {
        error: std::io::ErrorKind::NotFound.into(),
        step,
    };
    let said = |step| refusal(io_failure("instructions", &denied(step))).1;
    let p = || std::path::PathBuf::from("/d/none.md");
    assert_eq!(
        said(FsStep::Mkdir(p())),
        "ENOENT: no such file or directory, mkdir '/d/none.md'"
    );
    assert_eq!(
        said(FsStep::Open(p())),
        "ENOENT: no such file or directory, open '/d/none.md'"
    );
    assert_eq!(
        said(FsStep::Read),
        "ENOENT: no such file or directory, read"
    );
    assert_eq!(
        said(FsStep::Write),
        "ENOENT: no such file or directory, write"
    );
    assert_eq!(
        said(FsStep::Fsync),
        "ENOENT: no such file or directory, fsync"
    );
    assert_eq!(
        said(FsStep::Unlink(p())),
        "ENOENT: no such file or directory, unlink '/d/none.md'"
    );
    assert_eq!(
        said(FsStep::Rename(p(), "/d/b".into())),
        "ENOENT: no such file or directory, rename '/d/none.md' -> '/d/b'"
    );
}

/// Node's `rmSync` refuses a directory with `ERR_FS_EISDIR` before any syscall.
#[test]
fn removing_a_directory_is_refused_as_node_refuses_it() {
    let dir = tempfile::tempdir().unwrap();
    let failure = crate::domains::support::remove_file_forced(dir.path()).unwrap_err();
    let (code, message) = refusal(crate::domains::support::io_failure(
        "instructions",
        &failure,
    ));
    assert_eq!(code.as_deref(), Some("ERR_FS_EISDIR"));
    assert_eq!(
        message,
        format!(
            "Path is a directory: rm returned EISDIR (is a directory) {}",
            dir.path().display()
        )
    );
}
