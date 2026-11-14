//! The worker's frame loop over in-memory pipes, as the pool drives it (the 7 cases of `src/ext-host/worker-core.test.mjs`, in the
//! order and with the outcomes that file asserts), the wire layout against `mixdog_exthost::frame`, and the approved-path guard
//! (the 2 cases of `path-scope.test.mjs` and the refusals of `office-run.e2e.test.mjs`).

#![allow(
    clippy::disallowed_methods,
    reason = "a test driver: it makes the folders and the link the path guard is checked against"
)]

use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use mixdog_exthost::frame as pool_frame;
use mixdog_exthost_worker::CodedError;
use mixdog_exthost_worker::Outcome;
use mixdog_exthost_worker::Registry;
use mixdog_exthost_worker::pathguard::approved_path;
use mixdog_exthost_worker::pathguard::is_inside;
use mixdog_exthost_worker::pathguard::resolve;
use mixdog_exthost_worker::serve;
use mixdog_exthost_worker::wire;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::io::DuplexStream;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

const WINDOW: usize = pool_frame::CALL_WINDOW_BYTES as usize;

fn code(n: u8) -> String {
    format!("{:?}", ExitCode::from(n))
}

/// A frame as the pool would write it, or any bytes the test wants the worker to read.
fn raw(kind: u8, id: u32, body: &[u8]) -> Vec<u8> {
    let mut out = ((5 + body.len()) as u32).to_be_bytes().to_vec();
    out.push(kind);
    out.extend(id.to_be_bytes());
    out.extend(body);
    out
}

/// Runs `serve` over in-memory pipes and collects what the worker writes, decoded by the pool's own reader.
struct Harness {
    input: Option<DuplexStream>,
    frames: Arc<Mutex<Vec<pool_frame::Inbound>>>,
    arrived: Arc<Notify>,
    exit: JoinHandle<ExitCode>,
}

impl Harness {
    fn start(registry: Registry) -> Self {
        let (input, worker_in) = tokio::io::duplex(1 << 20);
        let (worker_out, output) = tokio::io::duplex(1 << 20);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let arrived = Arc::new(Notify::new());
        let exit = tokio::spawn(serve(registry, worker_in, worker_out));
        let (sink, wake) = (frames.clone(), arrived.clone());
        tokio::spawn(async move {
            let mut reader = pool_frame::FrameReader::new(output);
            while let Ok(Some(frame)) = reader.next().await {
                sink.lock().unwrap().push(frame);
                wake.notify_waiters();
            }
            wake.notify_waiters();
        });
        Self {
            input: Some(input),
            frames,
            arrived,
            exit,
        }
    }

    async fn send(&mut self, bytes: impl AsRef<[u8]>) {
        let input = self.input.as_mut().expect("the pipe is open");
        input.write_all(bytes.as_ref()).await.unwrap();
    }

    async fn call(&mut self, id: u32, method: &str, params: Value) {
        self.send(pool_frame::call(id, method, &params, &[], "t"))
            .await;
    }

    async fn until(&self, ready: impl Fn(&[pool_frame::Inbound]) -> bool) {
        loop {
            let woken = self.arrived.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if ready(&self.frames.lock().unwrap()) {
                return;
            }
            woken.await;
        }
    }

    /// The RESULT of call `id` as the JSON the worker wrote.
    async fn result(&self, id: u32) -> Value {
        self.until(|frames| {
            frames
                .iter()
                .any(|f| matches!(f, pool_frame::Inbound::Result { call, .. } if *call == id))
        })
        .await;
        let frames = self.frames.lock().unwrap();
        frames
            .iter()
            .find_map(|frame| match frame {
                pool_frame::Inbound::Result { call, pin, outcome } if *call == id => Some(match outcome {
                    Ok(value) => json!({"ok": value, "pin": pin}),
                    Err(error) => json!({"err": {"code": error.code, "message": error.message}, "pin": pin}),
                }),
                _ => None,
            })
            .unwrap()
    }

    fn chunk_sizes(&self) -> Vec<usize> {
        let frames = self.frames.lock().unwrap();
        frames
            .iter()
            .filter_map(|f| match f {
                pool_frame::Inbound::Chunk { bytes, .. } => Some(bytes.len()),
                _ => None,
            })
            .collect()
    }

    fn sent(&self) -> usize {
        self.chunk_sizes().iter().sum()
    }

    fn count(&self, wanted: impl Fn(&pool_frame::Inbound) -> bool) -> usize {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter(|f| wanted(f))
            .count()
    }

    fn has_result(&self) -> bool {
        self.count(|f| matches!(f, pool_frame::Inbound::Result { .. })) > 0
    }

    async fn need_browser(&self) {
        self.until(|frames| {
            frames
                .iter()
                .any(|f| matches!(f, pool_frame::Inbound::NeedBrowser { .. }))
        })
        .await;
    }

    /// The worker's exit once it has left.
    async fn exit_code(self) -> String {
        format!("{:?}", self.exit.await.unwrap())
    }

    fn close_pipe(&mut self) {
        self.input = None;
    }
}

async fn hold(ctx: mixdog_exthost_worker::CallCtx) -> Result<Outcome, CodedError> {
    ctx.cancel.cancelled().await;
    Ok(Outcome::value(json!("late")))
}

fn page_registry() -> Registry {
    let mut registry = Registry::new();
    registry.register("page", |ctx| async move {
        Ok(Outcome::value(json!(ctx.request_browser().await?)))
    });
    registry
}

#[tokio::test]
async fn announces_itself_and_runs_a_call_to_its_result() {
    let mut registry = Registry::new();
    registry.register("echo", |ctx| async move {
        Ok(Outcome::pinned(
            json!({"params": ctx.params, "thread": ctx.thread}),
        ))
    });
    let mut h = Harness::start(registry);
    h.until(|frames| frames.first() == Some(&pool_frame::Inbound::Ready))
        .await;
    h.call(5, "echo", json!({"a": 1})).await;
    assert_eq!(
        h.result(5).await,
        json!({"ok": {"params": {"a": 1}, "thread": "t"}, "pin": true})
    );
}

#[tokio::test]
async fn a_call_reaches_its_handler_whole() {
    let mut registry = Registry::new();
    registry.register("whole", |ctx| async move {
        Ok(Outcome::value(json!([
            ctx.id, ctx.method, ctx.params, ctx.paths, ctx.thread, ctx.cwd
        ])))
    });
    let mut h = Harness::start(registry);
    let body = br#"{"method":"whole","params":null,"paths":["/a","/b"],"thread":"th","cwd":"/w"}"#;
    h.send(raw(1, 9, body)).await;
    assert_eq!(
        h.result(9).await,
        json!({"ok": [9, "whole", null, ["/a", "/b"], "th", "/w"], "pin": false})
    );
}

#[tokio::test]
async fn an_unknown_method_and_a_failing_handler_are_results_not_crashes() {
    let mut registry = Registry::new();
    registry.register("boom", |_| async { Err(CodedError::new("E_BAD", "bad")) });
    registry.register("plain", |_| async {
        Err(CodedError::failed("plain failure"))
    });
    let mut h = Harness::start(registry);
    h.call(1, "missing", json!(null)).await;
    assert_eq!(
        h.result(1).await,
        json!({"err": {"code": "unknown_method", "message": "unknown ext-host method missing"}, "pin": false})
    );
    h.call(2, "boom", json!(null)).await;
    assert_eq!(
        h.result(2).await,
        json!({"err": {"code": "E_BAD", "message": "bad"}, "pin": false})
    );
    h.call(3, "plain", json!(null)).await;
    assert_eq!(h.result(3).await["err"]["code"], "failed");
    assert!(!h.exit.is_finished());
}

#[tokio::test]
async fn chunks_stop_at_the_window_and_resume_on_credit() {
    let mut registry = Registry::new();
    registry.register("big", |ctx| async move {
        ctx.emit(&vec![1u8; WINDOW * 2]).await?;
        Ok(Outcome::value(json!("done")))
    });
    let mut h = Harness::start(registry);
    h.call(1, "big", json!(null)).await;
    h.until(|frames| {
        frames
            .iter()
            .map(|f| match f {
                pool_frame::Inbound::Chunk { bytes, .. } => bytes.len(),
                _ => 0,
            })
            .sum::<usize>()
            == WINDOW
    })
    .await;
    // Nothing more comes while the credit is spent: give the worker every chance to send.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert_eq!(h.sent(), WINDOW, "the worker waits for credit");
    assert!(!h.has_result());
    h.send(pool_frame::credit(1, WINDOW as u32)).await;
    assert_eq!(h.result(1).await, json!({"ok": "done", "pin": false}));
    assert_eq!(h.sent(), WINDOW * 2);
}

#[tokio::test]
async fn chunks_are_at_most_64_kib_and_keep_their_bytes_in_order() {
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let mut registry = Registry::new();
    let payload = data.clone();
    registry.register("data", move |ctx| {
        let payload = payload.clone();
        async move {
            ctx.emit(&payload).await?;
            Ok(Outcome::value(json!(payload.len())))
        }
    });
    let mut h = Harness::start(registry);
    h.call(1, "data", json!(null)).await;
    assert_eq!(h.result(1).await["ok"], 300_000);
    let sizes = h.chunk_sizes();
    assert!(
        sizes.iter().all(|n| *n <= wire::MAX_CHUNK_BYTES && *n > 0),
        "{sizes:?}"
    );
    let frames = h.frames.lock().unwrap();
    let joined: Vec<u8> = frames
        .iter()
        .flat_map(|f| match f {
            pool_frame::Inbound::Chunk { bytes, .. } => bytes.to_vec(),
            _ => Vec::new(),
        })
        .collect();
    assert_eq!(joined, data);
}

#[tokio::test]
async fn credit_smaller_than_a_chunk_is_spent_in_smaller_chunks() {
    let mut registry = Registry::new();
    registry.register("big", |ctx| async move {
        ctx.emit(&vec![2u8; WINDOW + 10]).await?;
        Ok(Outcome::value(json!("done")))
    });
    let mut h = Harness::start(registry);
    h.call(1, "big", json!(null)).await;
    h.until(|frames| {
        frames
            .iter()
            .any(|f| matches!(f, pool_frame::Inbound::Chunk { .. }))
    })
    .await;
    h.send(pool_frame::credit(1, 10)).await;
    assert_eq!(h.result(1).await, json!({"ok": "done", "pin": false}));
    assert!(h.chunk_sizes().contains(&10));
    assert_eq!(h.sent(), WINDOW + 10);
}

#[tokio::test]
async fn cancel_cancels_the_call_and_the_answer_is_cancelled() {
    let mut registry = Registry::new();
    registry.register("hold", hold);
    let mut h = Harness::start(registry);
    h.call(1, "hold", json!(null)).await;
    h.send(pool_frame::cancel(1)).await;
    assert_eq!(
        h.result(1).await,
        json!({"err": {"code": "cancelled", "message": "call cancelled"}, "pin": false})
    );
}

#[tokio::test]
async fn a_cancelled_call_answers_with_the_pin_its_handler_reported() {
    let mut registry = Registry::new();
    registry.register("hold_pinned", |ctx| async move {
        ctx.cancel.cancelled().await;
        Ok(Outcome::pinned(json!("late")))
    });
    let mut h = Harness::start(registry);
    h.call(1, "hold_pinned", json!(null)).await;
    h.send(pool_frame::cancel(1)).await;
    assert_eq!(
        h.result(1).await,
        json!({"err": {"code": "cancelled", "message": "call cancelled"}, "pin": true})
    );
}

#[tokio::test]
async fn a_cancel_or_a_credit_for_another_call_does_nothing() {
    let mut registry = Registry::new();
    registry.register("hold", hold);
    let mut h = Harness::start(registry);
    h.send(pool_frame::cancel(8)).await;
    h.send(pool_frame::credit(8, 5)).await;
    h.call(1, "hold", json!(null)).await;
    h.send(pool_frame::cancel(2)).await;
    h.send(pool_frame::cancel(1)).await;
    assert_eq!(h.result(1).await["err"]["code"], "cancelled");
}

#[tokio::test]
async fn a_cancel_stops_a_call_that_waits_for_the_shared_browser() {
    let mut h = Harness::start(page_registry());
    h.call(1, "page", json!(null)).await;
    h.need_browser().await;
    h.send(pool_frame::cancel(1)).await;
    assert_eq!(h.result(1).await["err"]["code"], "cancelled");
}

#[tokio::test]
async fn a_cancel_stops_a_call_that_waits_for_credit() {
    let mut registry = Registry::new();
    registry.register("big", |ctx| async move {
        ctx.emit(&vec![1u8; WINDOW * 2]).await?;
        Ok(Outcome::value(json!("done")))
    });
    let mut h = Harness::start(registry);
    h.call(1, "big", json!(null)).await;
    h.until(|frames| {
        frames
            .iter()
            .any(|f| matches!(f, pool_frame::Inbound::Chunk { .. }))
    })
    .await;
    h.send(pool_frame::cancel(1)).await;
    assert_eq!(h.result(1).await["err"]["code"], "cancelled");
}

#[tokio::test]
async fn the_browser_endpoint_the_pool_answers_reaches_the_handler() {
    let mut h = Harness::start(page_registry());
    h.call(1, "page", json!(null)).await;
    h.need_browser().await;
    h.send(pool_frame::browser(1, &Ok("ws://x/y".to_owned())))
        .await;
    assert_eq!(h.result(1).await, json!({"ok": "ws://x/y", "pin": false}));

    let mut refused = Harness::start(page_registry());
    refused.call(2, "page", json!(null)).await;
    refused.need_browser().await;
    refused
        .send(pool_frame::browser(2, &Err("no chrome".to_owned())))
        .await;
    assert_eq!(
        refused.result(2).await,
        json!({"err": {"code": "browser_unavailable", "message": "no chrome"}, "pin": false})
    );
}

#[tokio::test]
async fn the_browser_is_asked_for_once_per_call_and_a_stray_answer_is_ignored() {
    let mut registry = Registry::new();
    registry.register("twice", |ctx| async move {
        let first = ctx.request_browser().await?;
        let second = ctx.request_browser().await?;
        Ok(Outcome::value(json!([first, second])))
    });
    let mut h = Harness::start(registry);
    // No call is waiting: the answer is dropped, not an error.
    h.send(pool_frame::browser(4, &Ok("ws://stray".to_owned())))
        .await;
    h.call(1, "twice", json!(null)).await;
    h.need_browser().await;
    h.send(pool_frame::browser(1, &Ok("ws://a".to_owned())))
        .await;
    assert_eq!(
        h.result(1).await,
        json!({"ok": ["ws://a", "ws://a"], "pin": false})
    );
    assert_eq!(
        h.count(|f| matches!(f, pool_frame::Inbound::NeedBrowser { .. })),
        1
    );
}

#[tokio::test]
async fn bye_and_a_closed_pipe_end_the_process_and_a_second_call_while_busy_is_a_protocol_error() {
    let mut bye = Harness::start(Registry::new());
    bye.send(pool_frame::bye()).await;
    assert_eq!(bye.exit_code().await, code(0));

    let mut closed = Harness::start(Registry::new());
    closed.close_pipe();
    assert_eq!(closed.exit_code().await, code(0));

    let mut registry = Registry::new();
    registry.register("hold", hold);
    let mut busy = Harness::start(registry);
    busy.call(1, "hold", json!(null)).await;
    busy.call(2, "hold", json!(null)).await;
    assert_eq!(busy.exit_code().await, code(2));
}

#[tokio::test]
async fn frames_that_cannot_be_read_are_protocol_errors() {
    for bad in [
        vec![0, 0, 0, 4, 1, 0, 0, 0],
        ((wire::MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec(),
        raw(99, 0, &[]),
        raw(1, 1, b"{not json"),
        raw(3, 1, &[0, 1]),
    ] {
        let mut h = Harness::start(Registry::new());
        h.send(&bad).await;
        assert_eq!(h.exit_code().await, code(2), "{bad:?}");
    }
}

#[tokio::test]
async fn a_panicking_handler_is_answered_and_the_worker_serves_on() {
    let mut registry = Registry::new();
    registry.register("panic", |_| async move {
        let nothing: Option<Outcome> = None;
        Ok(nothing.expect("handler went wrong"))
    });
    registry.register_blocking("panic_blocking", |_| {
        let nothing: Option<Outcome> = None;
        Ok(nothing.expect("blocking handler went wrong"))
    });
    registry.register("echo", |ctx| async move { Ok(Outcome::value(ctx.params)) });
    let mut h = Harness::start(registry);
    h.call(1, "panic", json!(null)).await;
    let first = h.result(1).await;
    assert_eq!(first["err"]["code"], "failed");
    assert!(
        first["err"]["message"]
            .as_str()
            .unwrap()
            .contains("handler went wrong"),
        "{first}"
    );
    h.call(2, "panic_blocking", json!(null)).await;
    let second = h.result(2).await;
    assert_eq!(second["err"]["code"], "failed");
    assert!(
        second["err"]["message"]
            .as_str()
            .unwrap()
            .contains("blocking handler went wrong"),
        "{second}"
    );
    h.call(3, "echo", json!(3)).await;
    assert_eq!(h.result(3).await, json!({"ok": 3, "pin": false}));
    assert!(!h.exit.is_finished());
}

#[tokio::test]
async fn a_cpu_bound_handler_polls_the_cancel_while_the_loop_keeps_reading() {
    let mut registry = Registry::new();
    registry.register_blocking("crunch", |ctx| {
        while !ctx.cancel.is_cancelled() {
            std::thread::yield_now();
        }
        Ok(Outcome::value(json!("stopped")))
    });
    let mut h = Harness::start(registry);
    h.call(1, "crunch", json!(null)).await;
    h.send(pool_frame::cancel(1)).await;
    assert_eq!(h.result(1).await["err"]["code"], "cancelled");
}

#[tokio::test]
async fn the_exit_hook_runs_before_the_process_leaves() {
    let ran = Arc::new(AtomicBool::new(false));
    let mut registry = Registry::new();
    let flag = ran.clone();
    registry.on_exit(move || {
        let flag = flag.clone();
        async move { flag.store(true, Ordering::SeqCst) }
    });
    let mut h = Harness::start(registry);
    h.send(pool_frame::bye()).await;
    assert_eq!(h.exit_code().await, code(0));
    assert!(ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn the_frames_the_worker_writes_decode_with_the_pools_reader() {
    // Every kind the worker encodes, read by `mixdog_exthost::frame::FrameReader`.
    let mut bytes = wire::ready().to_vec();
    bytes.extend(wire::chunk(7, b"abc"));
    bytes.extend(wire::result(7, &json!({"ok": {"a": 1}, "pin": true})));
    bytes.extend(wire::result(
        8,
        &json!({"err": {"code": "x", "message": "m"}, "pin": false}),
    ));
    bytes.extend(wire::need_browser(9));
    let mut reader = pool_frame::FrameReader::new(&bytes[..]);
    let mut got = Vec::new();
    while let Some(frame) = reader.next().await.unwrap() {
        got.push(frame);
    }
    assert_eq!(
        got,
        vec![
            pool_frame::Inbound::Ready,
            pool_frame::Inbound::Chunk {
                call: 7,
                bytes: Bytes::from_static(b"abc")
            },
            pool_frame::Inbound::Result {
                call: 7,
                pin: true,
                outcome: Ok(json!({"a": 1}))
            },
            pool_frame::Inbound::Result {
                call: 8,
                pin: false,
                outcome: Err(pool_frame::WireError {
                    code: "x".into(),
                    message: "m".into()
                })
            },
            pool_frame::Inbound::NeedBrowser { call: 9 },
        ]
    );
}

#[tokio::test]
async fn the_frames_the_pool_writes_decode_with_the_workers_reader() {
    // Every kind the worker decodes, written by the pool's encoders.
    let params = json!({"k": [1, 2]});
    let mut bytes = pool_frame::call(7, "m", &params, &["/p".to_owned()], "th").to_vec();
    bytes.extend(pool_frame::cancel(7));
    bytes.extend(pool_frame::credit(7, 4096));
    bytes.extend(pool_frame::browser(7, &Ok("ws://h".to_owned())));
    bytes.extend(pool_frame::browser(7, &Err("why".to_owned())));
    bytes.extend(pool_frame::bye());
    let mut reader = wire::FrameReader::new(&bytes[..]);
    let mut got = Vec::new();
    while let Some(frame) = reader.next().await.unwrap() {
        got.push(frame);
    }
    assert_eq!(
        got,
        vec![
            wire::Inbound::Call {
                id: 7,
                request: wire::CallRequest {
                    method: "m".into(),
                    params,
                    paths: vec!["/p".into()],
                    thread: "th".into(),
                    cwd: String::new(),
                }
            },
            wire::Inbound::Cancel { id: 7 },
            wire::Inbound::Credit { id: 7, bytes: 4096 },
            wire::Inbound::Browser {
                id: 7,
                body: Bytes::from_static(br#"{"ws":"ws://h"}"#)
            },
            wire::Inbound::Browser {
                id: 7,
                body: Bytes::from_static(br#"{"error":"why"}"#)
            },
            wire::Inbound::Bye,
        ]
    );
}

#[test]
fn the_limits_are_the_pools() {
    assert_eq!(wire::HEADER_BYTES, pool_frame::HEADER_BYTES);
    assert_eq!(wire::MAX_FRAME_BYTES, pool_frame::MAX_FRAME_BYTES);
    assert_eq!(wire::CALL_WINDOW_BYTES, pool_frame::CALL_WINDOW_BYTES);
    assert_eq!(wire::MAX_CHUNK_BYTES, 64 * 1024);
}

// ---- the approved-path guard ------------------------------------------------------------------------------------------

#[test]
fn is_inside_tells_traversal_from_a_name_that_starts_with_dots() {
    let root = resolve(Path::new("scope-root"));
    assert!(is_inside(&root, &root));
    assert!(is_inside(&root, &root.join("..notes.docx")));
    assert!(is_inside(&root, &root.join("...").join("x")));
    assert!(is_inside(&root, &root.join("a").join("..b")));
    assert!(!is_inside(&root, &resolve(&root.join("..").join("x"))));
    assert!(!is_inside(&root, &resolve(&root.join(".."))));
    assert!(!is_inside(
        &root,
        Path::new(&format!("{}-sibling", root.display()))
    ));
}

fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    let outside = temp.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    (temp, root, outside)
}

fn roots(root: &Path) -> Vec<String> {
    vec![root.to_string_lossy().into_owned()]
}

fn refused(result: Result<PathBuf, CodedError>) -> String {
    let error = result.unwrap_err();
    assert_eq!(error.code, "path_not_approved");
    error.message
}

/// A directory link: a junction on Windows (no privilege needed), a symlink elsewhere.
fn link_dir(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink failed");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[test]
fn a_path_inside_an_approved_root_is_returned_as_resolved_and_a_missing_tail_is_kept() {
    let (_temp, root, _outside) = dirs();
    std::fs::write(root.join("here.docx"), b"x").unwrap();
    let approved = roots(&root);
    let target = approved_path(&approved, root.join("here.docx").to_str().unwrap(), "").unwrap();
    assert_eq!(target, root.join("here.docx"));
    // Nothing of the tail exists yet.
    let missing = root.join("a").join("b").join("c.docx");
    assert_eq!(
        approved_path(&approved, missing.to_str().unwrap(), "").unwrap(),
        missing
    );
    // A relative path is resolved against the base, and `..` is settled before the check.
    let relative = approved_path(&approved, "sub/../inside.docx", root.to_str().unwrap()).unwrap();
    assert_eq!(relative, root.join("inside.docx"));
}

#[test]
fn a_relative_path_needs_a_base_and_the_refusal_names_the_path_as_given() {
    let (_temp, root, _outside) = dirs();
    let message = refused(approved_path(&roots(&root), "rel.docx", ""));
    assert_eq!(message, "path must be absolute: rel.docx");
}

#[test]
fn a_space_prefixed_outside_path_is_not_turned_into_a_workspace_one() {
    let (_temp, root, outside) = dirs();
    let spaced = format!(" {}", outside.join("spaced.docx").display());
    let message = refused(approved_path(
        &roots(&root),
        &spaced,
        root.to_str().unwrap(),
    ));
    assert!(
        message.starts_with("path is not approved for this call: "),
        "{message}"
    );
    assert!(message.ends_with("spaced.docx"), "{message}");
}

#[test]
fn a_link_out_of_the_approved_root_is_refused() {
    let (_temp, root, outside) = dirs();
    link_dir(&root.join("link"), &outside);
    let approved = roots(&root);
    refused(approved_path(
        &approved,
        "link/escaped.docx",
        root.to_str().unwrap(),
    ));
    refused(approved_path(
        &approved,
        root.join("link").to_str().unwrap(),
        "",
    ));
    // A plain workspace path still works.
    assert!(approved_path(&approved, "inside.docx", root.to_str().unwrap()).is_ok());
}

#[test]
fn a_link_into_the_approved_root_is_approved_by_its_real_path() {
    let (_temp, root, outside) = dirs();
    link_dir(&outside.join("door"), &root);
    // Approved through the link's real path, however it is spelled.
    let via_link = outside.join("door").join("file.docx");
    assert_eq!(
        approved_path(&roots(&root), via_link.to_str().unwrap(), "").unwrap(),
        via_link
    );
    // The root named through the link approves the same place.
    let through = vec![outside.join("door").to_string_lossy().into_owned()];
    assert!(approved_path(&through, root.join("file.docx").to_str().unwrap(), "").is_ok());
}

#[test]
fn a_dotted_name_inside_the_root_is_served_and_a_parent_escape_is_refused() {
    let (_temp, root, _outside) = dirs();
    let approved = roots(&root);
    let dotted = root.join("..notes.pdf");
    assert_eq!(
        approved_path(&approved, dotted.to_str().unwrap(), "").unwrap(),
        dotted
    );
    refused(approved_path(
        &approved,
        "../outside/x.pdf",
        root.to_str().unwrap(),
    ));
    // Approved only for a sub folder: the dotted name beside it is outside.
    std::fs::create_dir(root.join("sub")).unwrap();
    refused(approved_path(
        &roots(&root.join("sub")),
        dotted.to_str().unwrap(),
        "",
    ));
}

#[test]
fn nothing_approved_approves_nothing() {
    let (_temp, root, _outside) = dirs();
    refused(approved_path(
        &[],
        root.join("a.docx").to_str().unwrap(),
        "",
    ));
}

#[cfg(windows)]
#[test]
fn windows_paths_compare_without_regard_to_case() {
    let (_temp, root, _outside) = dirs();
    let shouted = root.join("CASE.docx").to_string_lossy().to_uppercase();
    let approved = roots(&root);
    assert!(approved_path(&approved, &shouted, "").is_ok(), "{shouted}");
    assert!(!is_inside(
        Path::new(r"C:\Work"),
        Path::new(r"D:\Work\x.docx")
    ));
}
