//! The watchdog child (`mixdog-computer --cursor-watchdog <parent_pid>`,
//! MixCursorTheme.Watch, CursorTheme.cs:286-355). It keeps the cursor lease
//! and the ownership receipt of the helper that started it, and ends them on
//! its own when the person touches the input, its parent exits, or its 60 s
//! run out. The protocol runs over its stdin and stdout.

use super::lease::{CursorApi, Lease, WinCursorApi, ROLES};
use super::Line;
use crate::config;
use crate::observer::Observer;
use std::io::{BufRead, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CreateMutexW, OpenProcess, ReleaseMutex, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

/// The mutex one watchdog per desktop session holds; a second exits without READY.
const MUTEX_NAME: &str = "Local\\MixdogCursorTheme";
/// How long the host has to send its activation after READY.
const ACTIVATION_WAIT: Duration = Duration::from_secs(5);
/// The longest a lease lasts without an END.
const LEASE_MAX_MS: u64 = 60_000;
const POLL_MS: u64 = 25;
const RESTORE_ATTEMPTS: u32 = 3;
const RESTORE_PAUSE_MS: u64 = 50;

/// What the input observation says now.
#[derive(Clone, Copy)]
pub struct Observation {
    pub ready: bool,
    pub sequence: i64,
}

/// What the watchdog reads and does outside its own logic.
pub trait Env {
    fn read_line(&mut self, within: Duration) -> Line;
    /// Whether the host ended the lease (an END line, or its side closed).
    fn poll_command(&mut self) -> bool;
    fn write(&mut self, line: &str);
    fn parent_alive(&self) -> bool;
    fn observation(&self) -> Observation;
    /// Whether the input desktop is open (not locked, no secure prompt).
    fn desktop_ready(&self) -> bool;
    fn now_ms(&self) -> u64;
    fn sleep_ms(&mut self, ms: u64);
    /// Lets go of the keys and buttons the parent left down.
    fn release_input(&mut self) -> Result<(), String>;
}

/// Whether the lease must end now: the host asked, the parent is gone, the
/// time is up, or the person's input moved the observation.
fn lease_over<E: Env>(env: &mut E, baseline: Observation, started: u64) -> bool {
    if env.poll_command() || !env.parent_alive() || env.now_ms().saturating_sub(started) >= LEASE_MAX_MS {
        return true;
    }
    let current = env.observation();
    !current.ready || current.sequence != baseline.sequence || !env.desktop_ready()
}

/// One lease from READY to RESTORED.
pub fn watch<E: Env, A: CursorApi>(env: &mut E, api: A) {
    let baseline = env.observation();
    if !baseline.ready || !env.desktop_ready() {
        return;
    }
    env.write("READY");
    let Line::Text(activation) = env.read_line(ACTIVATION_WAIT) else { return };
    let decorate = activation == "ACTIVATE";
    if (!decorate && activation != "ACTIVATE_QUIET") || !env.parent_alive() {
        return;
    }
    // A quiet activation still watches this session's input so a killed
    // worker cannot leave a key down; it only leaves the person's cursor
    // artwork alone.
    let mut lease = None;
    let mut active = true;
    if decorate {
        match Lease::new(api, &ROLES) {
            Ok(mut held) => {
                active = held.activate().is_ok();
                lease = Some(held);
            }
            Err(_) => active = false,
        }
    }
    if active {
        env.write("ACTIVE");
        let started = env.now_ms();
        while !lease_over(env, baseline, started) {
            env.sleep_ms(POLL_MS);
        }
    }
    // The watchdog outlives a killed input worker. Never release keys while
    // the worker is still alive and may be finishing its gesture.
    let input_released = env.parent_alive() || env.release_input().is_ok();
    let restored = match lease.as_mut() {
        Some(held) => (0..RESTORE_ATTEMPTS).any(|_| {
            let restored = held.dispose().is_ok();
            if !restored {
                env.sleep_ms(RESTORE_PAUSE_MS);
            }
            restored
        }),
        None => true,
    };
    env.write(if restored && input_released { "RESTORED" } else { "RESTORE_FAILED" });
}

/// The live process behind `Env`.
struct Live {
    commands: Receiver<String>,
    parent: HANDLE,
    shared: std::sync::Arc<crate::observer::Shared>,
    marker: i64,
    started: Instant,
}

impl Env for Live {
    fn read_line(&mut self, within: Duration) -> Line {
        match self.commands.recv_timeout(within) {
            Ok(text) => Line::Text(text),
            Err(mpsc::RecvTimeoutError::Timeout) => Line::Empty,
            Err(mpsc::RecvTimeoutError::Disconnected) => Line::Closed,
        }
    }

    fn poll_command(&mut self) -> bool {
        !matches!(self.commands.try_recv(), Err(mpsc::TryRecvError::Empty))
    }

    fn write(&mut self, line: &str) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    fn parent_alive(&self) -> bool {
        // SAFETY: the handle is open for the life of self.
        unsafe { WaitForSingleObject(self.parent, 0) != WAIT_OBJECT_0 }
    }

    fn observation(&self) -> Observation {
        let snapshot = self.shared.read();
        Observation { ready: snapshot.ready, sequence: snapshot.sequence }
    }

    fn desktop_ready(&self) -> bool {
        super::super::input::desktop_ready()
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn sleep_ms(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn release_input(&mut self) -> Result<(), String> {
        super::super::input::release_owned(self.marker)
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        // SAFETY: the process handle was opened by `run` and is closed once.
        unsafe {
            let _ = CloseHandle(self.parent);
        }
    }
}

/// The single-watchdog mutex; an owner that died holding it counts as gone.
struct Single(HANDLE);

impl Single {
    fn take() -> Option<Single> {
        let name: Vec<u16> = MUTEX_NAME.encode_utf16().chain(Some(0)).collect();
        // SAFETY: the name is NUL-terminated; the handle is closed on drop.
        let mutex = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }.ok()?;
        // SAFETY: the handle was just created.
        match unsafe { WaitForSingleObject(mutex, 0) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Some(Single(mutex)),
            _ => {
                // SAFETY: the handle was just created and is not held.
                unsafe {
                    let _ = CloseHandle(mutex);
                }
                None
            }
        }
    }
}

impl Drop for Single {
    fn drop(&mut self) {
        // SAFETY: this process owns the mutex and the handle, and releases them once.
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}

/// `--cursor-watchdog <parent_pid>`: the process exit code.
pub fn run(parent_pid: &str) -> i32 {
    let Ok(parent_pid) = parent_pid.trim().parse::<u32>() else { return 2 };
    let marker = config::input_marker();
    let Some(_single) = Single::take() else { return 0 };
    // Opens the receipt the parent keeps its input in, and watches the
    // person's keys from here on, so a killed parent's keys are released and
    // the person's are not (InitializeOwnership, BeginOwnershipObservation).
    let _receipt = super::super::input::Sender::new(marker);
    let observer = Observer::new();
    super::super::observe::start(observer.shared.clone(), marker);
    // SAFETY: a plain open; the handle is closed by Live.
    let Ok(parent) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) }) else { return 1 };
    let (lines, commands) = mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    let mut live = Live { commands, parent, shared: observer.shared.clone(), marker, started: Instant::now() };
    watch(&mut live, WinCursorApi);
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    type Log = Rc<RefCell<Vec<String>>>;

    /// A scripted watchdog environment: lines it will read, how long the
    /// parent lives (in polls), and a log of everything it does.
    struct Script {
        log: Log,
        lines: VecDeque<Line>,
        /// The command (END) arrives once this many polls have passed; None never.
        end_after: Option<u32>,
        /// The parent has exited once this many polls have passed; None never.
        parent_dies_after: Option<u32>,
        /// The observation sequence moves on this poll; None never.
        input_after: Option<u32>,
        polls: u32,
        clock: u64,
        release: Result<(), String>,
    }

    impl Script {
        fn new(log: &Log, lines: &[&str]) -> Script {
            Script {
                log: log.clone(),
                lines: lines.iter().map(|line| Line::Text((*line).into())).collect(),
                end_after: None,
                parent_dies_after: None,
                input_after: None,
                polls: 0,
                clock: 0,
                release: Ok(()),
            }
        }
    }

    impl Env for Script {
        fn read_line(&mut self, _: Duration) -> Line {
            self.lines.pop_front().unwrap_or(Line::Empty)
        }
        fn poll_command(&mut self) -> bool {
            self.polls += 1;
            self.end_after.is_some_and(|after| self.polls > after)
        }
        fn write(&mut self, line: &str) {
            self.log.borrow_mut().push(format!("write {line}"));
        }
        fn parent_alive(&self) -> bool {
            !self.parent_dies_after.is_some_and(|after| self.polls > after)
        }
        fn observation(&self) -> Observation {
            let moved = self.input_after.is_some_and(|after| self.polls > after);
            Observation { ready: true, sequence: if moved { 8 } else { 7 } }
        }
        fn desktop_ready(&self) -> bool {
            true
        }
        fn now_ms(&self) -> u64 {
            self.clock
        }
        fn sleep_ms(&mut self, ms: u64) {
            self.clock += ms;
        }
        fn release_input(&mut self) -> Result<(), String> {
            self.log.borrow_mut().push("release input".into());
            self.release.clone()
        }
    }

    /// A cursor table that logs into the same log.
    struct Cursors {
        log: Log,
        fail_restore: u32,
        restores: std::cell::Cell<u32>,
        scheme_ok: bool,
    }

    impl CursorApi for Cursors {
        fn save(&self, _: u32) -> Option<super::super::lease::Backup> {
            Some(1)
        }
        fn apply(&self, _: u32) -> Result<(), String> {
            self.log.borrow_mut().push("apply".into());
            Ok(())
        }
        fn restore(&self, _: u32, _: super::super::lease::Backup) -> bool {
            self.log.borrow_mut().push("restore".into());
            let seen = self.restores.get();
            self.restores.set(seen + 1);
            seen >= self.fail_restore
        }
        fn reset_configured_scheme(&self) -> bool {
            self.log.borrow_mut().push("scheme".into());
            self.scheme_ok
        }
        fn free(&self, _: super::super::lease::Backup) {}
    }

    fn cursors(log: &Log) -> Cursors {
        Cursors { log: log.clone(), fail_restore: 0, restores: Default::default(), scheme_ok: true }
    }

    fn written(log: &Log) -> Vec<String> {
        log.borrow().iter().filter_map(|entry| entry.strip_prefix("write ").map(str::to_string)).collect()
    }

    #[test]
    fn an_end_from_the_host_restores_the_cursors_and_says_so() {
        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE"]);
        env.end_after = Some(2);
        watch(&mut env, cursors(&log));
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORED"]);
        let calls = log.borrow();
        assert_eq!(calls.iter().filter(|call| *call == "apply").count(), ROLES.len());
        assert_eq!(calls.iter().filter(|call| *call == "restore").count(), ROLES.len());
        assert!(!calls.iter().any(|call| call == "release input"), "a live parent keeps its input");
    }

    #[test]
    fn a_quiet_activation_applies_no_artwork_and_still_answers() {
        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE_QUIET"]);
        env.end_after = Some(1);
        watch(&mut env, cursors(&log));
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORED"]);
        let calls = log.borrow();
        assert!(!calls.iter().any(|call| call == "apply" || call == "restore"), "{calls:?}");
    }

    #[test]
    fn the_parents_exit_releases_its_input_before_the_cursors_come_back() {
        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE"]);
        env.parent_dies_after = Some(1);
        watch(&mut env, cursors(&log));
        let calls = log.borrow();
        let release = calls.iter().position(|call| call == "release input").expect("released");
        let first_restore = calls.iter().position(|call| call == "restore").expect("restored");
        assert!(release < first_restore, "{calls:?}");
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORED"]);
    }

    #[test]
    fn an_input_release_that_fails_is_a_failed_restoration() {
        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE_QUIET"]);
        env.parent_dies_after = Some(0);
        env.release = Err("input_cleanup_unconfirmed: nope".into());
        watch(&mut env, cursors(&log));
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORE_FAILED"]);
    }

    #[test]
    fn the_persons_input_ends_the_lease() {
        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE"]);
        env.input_after = Some(2);
        watch(&mut env, cursors(&log));
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORED"]);
        assert!(env.polls <= 4, "the lease ended on the first poll after the input");
    }

    #[test]
    fn a_lease_without_an_end_stops_after_sixty_seconds() {
        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE"]);
        watch(&mut env, cursors(&log));
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORED"]);
        assert!(env.clock >= LEASE_MAX_MS && env.clock < LEASE_MAX_MS + 100, "{}", env.clock);
    }

    #[test]
    fn a_restore_that_fails_resets_the_scheme_and_a_stuck_one_is_retried_three_times() {
        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE"]);
        env.end_after = Some(0);
        let stuck = Cursors { fail_restore: 100, scheme_ok: false, ..cursors(&log) };
        watch(&mut env, stuck);
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORE_FAILED"]);
        let schemes = log.borrow().iter().filter(|call| *call == "scheme").count();
        assert_eq!(schemes, 3, "one scheme reset per attempt");
        assert_eq!(env.clock, 3 * RESTORE_PAUSE_MS);

        let log = Log::default();
        let mut env = Script::new(&log, &["ACTIVATE"]);
        env.end_after = Some(0);
        let flaky = Cursors { fail_restore: 1, scheme_ok: true, ..cursors(&log) };
        watch(&mut env, flaky);
        assert_eq!(written(&log), ["READY", "ACTIVE", "RESTORED"]);
        assert!(log.borrow().iter().any(|call| call == "scheme"), "the last resort recovered it");
    }

    #[test]
    fn an_unknown_or_missing_activation_leaves_without_a_lease() {
        for lines in [vec!["NOPE"], vec![]] {
            let log = Log::default();
            let mut env = Script::new(&log, &lines);
            watch(&mut env, cursors(&log));
            assert_eq!(written(&log), ["READY"]);
            assert!(!log.borrow().iter().any(|call| call == "apply"));
        }
    }
}
