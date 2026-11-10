//! Debug builds only: what a replay of Node's recordings needs over a built daemon. A release build has none of it: every type here
//! is then empty and every function a constant, so there is no log, no listener and no clock to move.
//!
//! The replay names a listener in `MIXDOG_SCM_DEBUG_CLOCK` (`host:port`); the first `Exec` of the process connects to it. Over that
//! one connection:
//!  - the replay sends `advance <ms>`: the crate's virtual clock moves by that much and no more. It starts at 0 and moves only
//!    when told, so nothing here waits out a real minute. Two things read it: the remote-list cache (`cache_clock`) and the run
//!    limit of every child that has one (a `Deadline`, which fires once the clock has advanced by the limit since the child's
//!    start). The answer is `{"event":"advanced","total":ms,"fired":[child..],"armed":[child..]}`, the children whose limit that
//!    advance reached and those still counting;
//!  - the crate sends one event per fact as it happens: `begin` (an attempt to start a program, at the moment the attempt is made,
//!    so concurrent attempts are in the order they were issued), `spawned` (whether it started), `armed` (its run limit is counting)
//!    and `done` (how it ended: the exit code, or `ETIMEDOUT` / `EMAXBUFFER` / `cancelled`).
//!
//! `MIXDOG_SCM_DEBUG_IDENTITY_ROOT` names the folder of a recording's scratch repositories: the identity of a work-tree file under
//! it (`worktree_revision`: modify time, change time, file id) is the scripted one the Node recording was made with, derived from
//! the file's content and its place under that folder, so a recorded revision is byte-comparable. Its size is the real one.

use std::time::Duration;
use std::time::Instant;

#[cfg(debug_assertions)]
mod debug {
    use std::io::BufRead;
    use std::io::BufReader;
    use std::io::Write;
    use std::net::TcpStream;
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::time::Instant;

    use tokio::sync::oneshot;

    struct Waiter {
        deadline_ms: u64,
        child: serde_json::Value,
        fire: oneshot::Sender<()>,
    }

    struct State {
        advanced_ms: u64,
        waiters: Vec<Waiter>,
        out: Option<TcpStream>,
        next_seq: u64,
    }

    static STATE: Mutex<State> = Mutex::new(State { advanced_ms: 0, waiters: Vec::new(), out: None, next_seq: 0 });
    static BASE: OnceLock<Instant> = OnceLock::new();
    static ENABLED: OnceLock<bool> = OnceLock::new();

    fn state() -> std::sync::MutexGuard<'static, State> {
        STATE.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start() {
        ENABLED.get_or_init(|| {
            let Some(address) = std::env::var_os("MIXDOG_SCM_DEBUG_CLOCK") else { return false };
            let stream = TcpStream::connect(address.to_string_lossy().as_ref()).expect("MIXDOG_SCM_DEBUG_CLOCK names a listener");
            let reader = stream.try_clone().expect("clone the clock connection");
            BASE.get_or_init(Instant::now);
            state().out = Some(stream);
            std::thread::Builder::new()
                .name("scm-debug-clock".into())
                .spawn(move || {
                    // Blocks on the replay's next command: an explicit signal, never a poll.
                    for line in BufReader::new(reader).lines().map_while(Result::ok) {
                        if let Some(ms) = line.strip_prefix("advance ").and_then(|ms| ms.trim().parse::<u64>().ok()) {
                            advance(ms);
                        } else if line.trim() == "sync" {
                            // Every event written before this line is ahead of this answer on the connection.
                            emit(&serde_json::json!({ "event": "synced" }));
                        }
                    }
                })
                .expect("start the clock thread");
            true
        });
    }

    pub fn enabled() -> bool {
        *ENABLED.get().unwrap_or(&false)
    }

    pub fn emit(event: &serde_json::Value) {
        let mut state = state();
        if let Some(out) = state.out.as_mut() {
            let _ = writeln!(out, "{event}");
        }
    }

    pub fn now() -> Instant {
        let base = *BASE.get().expect("the clock is enabled");
        base + std::time::Duration::from_millis(state().advanced_ms)
    }

    fn advance(ms: u64) {
        let mut state = state();
        state.advanced_ms += ms;
        let total = state.advanced_ms;
        // A child that already ended dropped its limit: it is neither counting nor reached.
        let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut state.waiters)
            .into_iter()
            .filter(|waiter| !waiter.fire.is_closed())
            .partition(|waiter| waiter.deadline_ms <= total);
        state.waiters = waiting;
        let armed: Vec<_> = state.waiters.iter().map(|waiter| waiter.child.clone()).collect();
        let fired: Vec<_> = due.iter().map(|waiter| waiter.child.clone()).collect();
        for waiter in due {
            let _ = waiter.fire.send(());
        }
        let event = serde_json::json!({ "event": "advanced", "total": total, "fired": fired, "armed": armed });
        if let Some(out) = state.out.as_mut() {
            let _ = writeln!(out, "{event}");
        }
    }

    pub fn next_seq() -> u64 {
        let mut state = state();
        state.next_seq += 1;
        state.next_seq
    }

    /// A child's run limit starts counting now, on the virtual clock.
    pub fn arm(limit_ms: u64, child: serde_json::Value) -> oneshot::Receiver<()> {
        let (fire, fired) = oneshot::channel();
        let mut state = state();
        let deadline_ms = state.advanced_ms + limit_ms;
        let event = serde_json::json!({ "event": "armed", "child": child, "limitMs": limit_ms });
        state.waiters.push(Waiter { deadline_ms, child, fire });
        if let Some(out) = state.out.as_mut() {
            let _ = writeln!(out, "{event}");
        }
        fired
    }
}

/// Connects to the replay's listener when the process was started with one. Idempotent.
pub(crate) fn start() {
    #[cfg(debug_assertions)]
    debug::start();
}

/// The moment the remote-list cache reads: the real one, or in a replay the virtual clock's.
pub(crate) fn cache_clock() -> Instant {
    #[cfg(debug_assertions)]
    if debug::enabled() {
        return debug::now();
    }
    Instant::now()
}

/// The run limit of a child with one: the process manager's own, or in a replay a virtual one the clock's advance fires.
pub(crate) struct Deadline {
    #[cfg(debug_assertions)]
    fire: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl Deadline {
    /// Completes when the virtual limit is reached; never when there is none.
    pub(crate) async fn fired(&mut self) {
        #[cfg(debug_assertions)]
        if let Some(fire) = self.fire.as_mut() {
            let _ = fire.await;
            return;
        }
        std::future::pending::<()>().await;
    }
}

/// How an attempt to start a program went, as the replay is told.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub(crate) enum Ended {
    Code(Option<i32>),
    TimedOut,
    TooLarge,
    Cancelled,
}

/// One attempt to start a program (`pty` for the sign-in's terminal child).
pub(crate) struct Attempt {
    #[cfg(debug_assertions)]
    seq: u64,
    #[cfg(debug_assertions)]
    started: std::sync::atomic::AtomicBool,
    #[cfg(debug_assertions)]
    child: serde_json::Value,
}

/// The attempt is being made now: told to the replay at this moment, so attempts issued side by side are in the order they were issued.
pub(crate) fn attempt_begin(
    program: &str,
    args: &[String],
    pty: bool,
    cwd: &std::path::Path,
    env_set: &[(String, String)],
    env_remove: &[String],
) -> Attempt {
    #[cfg(debug_assertions)]
    {
        let seq = if debug::enabled() { debug::next_seq() } else { 0 };
        let child = serde_json::json!({ "program": program, "args": args, "pty": pty });
        if debug::enabled() {
            // The directory the child starts in and the variables the request sets or removes on top of the inherited ones.
            debug::emit(&serde_json::json!({
                "event": "begin", "seq": seq, "program": program, "args": args, "pty": pty,
                "cwd": cwd.to_string_lossy(), "envSet": env_set, "envRemove": env_remove,
            }));
        }
        Attempt { seq, started: std::sync::atomic::AtomicBool::new(false), child }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (program, args, pty, cwd, env_set, env_remove);
        Attempt {}
    }
}

impl Attempt {
    /// Whether the program started.
    pub(crate) fn spawned(&self, started: bool) {
        #[cfg(debug_assertions)]
        if debug::enabled() {
            self.started.store(started, std::sync::atomic::Ordering::Relaxed);
            debug::emit(&serde_json::json!({ "event": "spawned", "seq": self.seq, "started": started }));
        }
        #[cfg(not(debug_assertions))]
        let _ = started;
    }

    /// How a program that started ended. Nothing is told for one that did not start.
    pub(crate) fn done(&self, ended: &Ended) {
        #[cfg(debug_assertions)]
        if debug::enabled() && self.started.load(std::sync::atomic::Ordering::Relaxed) {
            let result = match ended {
                Ended::Code(code) => serde_json::json!({ "code": code }),
                Ended::TimedOut => serde_json::json!({ "error": "ETIMEDOUT" }),
                Ended::TooLarge => serde_json::json!({ "error": "EMAXBUFFER" }),
                Ended::Cancelled => serde_json::json!({ "error": "cancelled" }),
            };
            debug::emit(&serde_json::json!({ "event": "done", "seq": self.seq, "result": result }));
        }
        #[cfg(not(debug_assertions))]
        let _ = ended;
    }
}

/// The run limit a child is started with. In a replay the limit is not handed to the process manager: it is the returned
/// [Deadline], counting on the virtual clock from this moment, and the caller kills the child when it fires.
pub(crate) fn run_limit(own: Option<Duration>, attempt: &Attempt) -> (Option<Duration>, Deadline) {
    #[cfg(debug_assertions)]
    if debug::enabled()
        && let Some(limit) = own
    {
        let fire = debug::arm(limit.as_millis() as u64, attempt.child.clone());
        return (None, Deadline { fire: Some(fire) });
    }
    #[cfg(not(debug_assertions))]
    let _ = attempt;
    (own, Deadline {
        #[cfg(debug_assertions)]
        fire: None,
    })
}

/// A work-tree file's identity as a recording's scratch repositories scripted it (see the module doc), or the real one.
#[allow(clippy::disallowed_methods, reason = "debug builds only: a recording's scripted identity, read where the caller has just read the file's real one")]
pub(crate) fn file_identity(path: &std::path::Path, real: (i128, i128, u64)) -> (i128, i128, u64) {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("MIXDOG_SCM_DEBUG_IDENTITY_ROOT")
        && let Ok(content) = std::fs::read(path)
    {
        let text = path.to_string_lossy().replace('/', "\\");
        let root = root.to_string_lossy().into_owned();
        if text.len() > root.len() && text[..root.len()].eq_ignore_ascii_case(&root) {
            let fnv = |bytes: &[u8]| bytes.iter().fold(0x811c_9dc5_u64, |hash, byte| ((hash ^ u64::from(*byte)).wrapping_mul(0x0100_0193)) & 0xffff_ffff);
            let time = 1_767_323_045_000_000_000_i128 + i128::from(fnv(&content));
            return (time, time, fnv(text[root.len()..].as_bytes()));
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = path;
    real
}