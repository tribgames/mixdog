//! The run loop of the terminal UI (`src/tui/index.jsx` runTui): the boot sequence, the event loop and the teardown.
//!
//! Boot, in Node's order: refuse without a TTY on stdin (two lines, exit 1); install the stderr guard; enter the alternate screen
//! and the modes at once; paint the boot splash; connect the session store (ensure the core, start or resume the thread with the
//! CLI options); apply the theme and write the terminal background before the first frame; touch the project (best effort);
//! resolve the onboarding verdict; mount; turn mouse tracking on unless `MIXDOG_TUI_MOUSE` says no; run.
//!
//! The loop waits on one channel that carries the decoded terminal reads, the resizes and the store's events, and on the next
//! deadline of any timer (the application's panel timers, the decoder's lone-ESC flush, the resize settle, the frame pacer, the
//! store tick). A frame is drawn at most once per [`TUI_FRAME_MS`]; every flushed frame is the render acknowledgement the store's
//! frame-batched publication waits for.
//!
//! It ends through the application's exit flow (`/exit`, `/quit`), a signal, a dead stdio or a panic. The normal teardown is
//! Node's: the reader stops, the store is disposed within `MIXDOG_TUI_EXIT_WAIT_MS` (2500 ms by default), the terminal is
//! restored, the stderr guard is released, and the hard-exit timer is armed. `MIXDOG_BOOT_PROFILE` (1, true, yes or on) writes a
//! line per boot phase to the stderr log under Node's phase names.

use std::io::{IsTerminal, Write, stdin, stdout};
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use mixdog_launch::ensure_core::{EnsureOptions, client_error_line, ensure_core};
use mixdog_session_view::store::{SessionStore, StoreError, StoreEvent, StoreOptions};
use mixdog_term::console::{RawConsole, terminal_size};
use mixdog_term::frame::{FrameWriter, PacedFrames, TUI_FRAME_MS};
use mixdog_term::guard::{
    CleanupConfig, ExitSettings, SignalCleanup, StderrGuard, StdioEvent, StdioSource, TerminalGuard, TerminalRestorer, install_panic_hook, schedule_hard_exit,
};
use mixdog_term::modes::{BRACKETED_PASTE_ON, ModeEnv, TerminalModes, screen_entry_sequence};
use mixdog_term::reader::{ReaderHandle, TermEvent, spawn_reader};
use mixdog_term::{Decoder, InputEvent};
use mixdog_tui_style::color::Styler;
use mixdog_tui_style::color_level::ColorEnvironment;
use mixdog_tui_style::theme::{current_palette, set_theme, terminal_background_sequence};
use serde_json::{Value, json};
use tokio::runtime::{Builder, Handle, Runtime};
use tokio::sync::broadcast::error::RecvError;

use crate::app::clock::Clock;
use crate::app::store::{AppStore, SessionStoreIo};
use crate::app::{AppOptions, AppState};
use crate::handlers::exit::{EXIT_RESTORE_SEQUENCE, ExitStep};
use crate::view::welcome::{boot_splash, windows_like_terminal};

/// How the terminal UI is started (the CLI options of `mixdog`).
#[derive(Clone, Debug, Default)]
pub struct TuiOptions {
    pub cwd: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    pub web_search: bool,
    /// `toolMode` of the session options.
    pub tool_mode: Option<String>,
    /// The core is another machine's.
    pub remote: bool,
    /// `--onboarding`: the first-run wizard runs again.
    pub force_onboarding: bool,
    /// `--worktree [name]` / `--no-worktree`; none follows the worktree settings default (`{ mode: 'default' }`).
    pub worktree: Option<Value>,
    /// A stored session to resume.
    pub resume: Option<String>,
    /// The footer's renderer (`initialStatusLine` and the hook of `StatusLine`); none paints no statusline text.
    pub statusline: Option<crate::footer::StatuslineRenderer>,
}

/// The two lines printed when stdin is not a terminal.
pub const NO_TTY_MESSAGE: &str = "mixdog: the TUI needs an interactive terminal (TTY).\nRun it directly in a terminal, or use --plain for the readline REPL.\n";

/// How long the loop sleeps at most while the session is idle: the store publishes only when asked (once per frame) and does not
/// say when it changed.
const STORE_POLL_IDLE_MS: u64 = 33;

/// `/^(1|true|yes|on)$/i`.
fn is_on_word(value: &str) -> bool {
    ["1", "true", "yes", "on"].iter().any(|word| value.eq_ignore_ascii_case(word))
}

/// The boot-phase lines of `MIXDOG_BOOT_PROFILE`: `[mixdog-boot] +<ms>ms tui:<event> key=value ...`.
#[derive(Clone, Copy, Debug)]
pub struct BootProfile {
    enabled: bool,
    start: Instant,
}

impl BootProfile {
    pub fn new(enabled: bool, start: Instant) -> Self {
        Self { enabled, start }
    }

    pub fn from_vars(var: impl Fn(&str) -> Option<String>, start: Instant) -> Self {
        Self::new(var("MIXDOG_BOOT_PROFILE").is_some_and(|value| is_on_word(&value)), start)
    }

    /// The line of a phase, `None` when profiling is off; a field with no value is left out and white space in a value is `_`.
    pub fn line(&self, event: &str, fields: &[(&str, Option<String>)], now: Instant) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let elapsed = now.saturating_duration_since(self.start).as_secs_f64() * 1000.0;
        let mut line = format!("[mixdog-boot] +{elapsed:.1}ms tui:{event}");
        for (key, value) in fields {
            if let Some(value) = value.as_deref().filter(|value| !value.is_empty()) {
                let compact = value.split_whitespace().collect::<Vec<_>>().join("_");
                line.push_str(&format!(" {key}={compact}"));
            }
        }
        Some(line)
    }

    /// Writes the line to stderr (the stderr guard sends it to the log).
    pub fn log(&self, event: &str, fields: &[(&str, Option<String>)]) {
        if let Some(line) = self.line(event, fields, Instant::now()) {
            eprintln!("{line}");
        }
    }
}

/// What the loop waits on.
enum LoopEvent {
    Term(TermEvent),
    Store(StoreEvent),
    /// The store's disposal finished (in time or not).
    Disposed,
    /// A worker finished a read the application waits for (a paste); the turn after it takes the answer.
    Wake,
}

/// The store and the runtime that serves it, for the thread a signal runs the cleanup on.
type SharedStore = Arc<Mutex<Option<(Arc<SessionStore>, Handle)>>>;

fn held<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The signal and stdio-death cleanup: the terminal is restored first, then the session is disposed within the exit wait.
fn install_cleanup(settings: &ExitSettings, restorer: &TerminalRestorer, shared: &SharedStore) -> SignalCleanup {
    let mut config = CleanupConfig::new("mixdog-tui");
    config.timeout = settings.cleanup_timeout();
    config.before_cleanup = Some(restorer.hook());
    config.restore_terminal = Some(restorer.hook());
    config.after_cleanup = Some(restorer.hook());
    let slot = Arc::clone(shared);
    config.cleanup = Some(Arc::new(move |reason: &str| {
        let taken = held(&slot).take();
        if let Some((store, handle)) = taken {
            handle.block_on(store.dispose(reason));
        }
    }));
    SignalCleanup::install(config)
}

/// The text a failed boot prints: the protocol's line for a refused connection, else `mixdog: <message>`.
fn boot_error_line(error: &StoreError) -> String {
    match error {
        StoreError::Client(client) => client_error_line(client),
        other => format!("mixdog: {other}"),
    }
}

/// `Date`-free elapsed milliseconds with one decimal, as the boot profile prints them.
fn elapsed_ms(since: Instant) -> Option<String> {
    Some(format!("{:.1}", since.elapsed().as_secs_f64() * 1000.0))
}

/// Forwards the store's events into the loop's channel.
fn spawn_store_forwarder(runtime: &Runtime, store: &Arc<SessionStore>, tx: Sender<LoopEvent>) {
    let mut events = store.subscribe();
    runtime.spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if tx.send(LoopEvent::Store(event)).is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Starts the terminal reader and a forwarder of its events into the loop's channel.
fn start_reader(tx: Sender<LoopEvent>) -> ReaderHandle {
    let (term_tx, term_rx) = mpsc::channel::<TermEvent>();
    let handle = spawn_reader(term_tx);
    // The forwarder ends when the reader's sender is dropped with the reader.
    let _ = std::thread::Builder::new().name("mixdog-tui-input".to_owned()).spawn(move || {
        while let Ok(event) = term_rx.recv() {
            if tx.send(LoopEvent::Term(event)).is_err() {
                break;
            }
        }
    });
    handle
}

/// The event loop's state.
struct Driver {
    app: AppState,
    clock: Clock,
    start: Instant,
    env: ModeEnv,
    restorer: TerminalRestorer,
    store: Arc<SessionStore>,
    runtime: Handle,
    tx: Sender<LoopEvent>,
    decoder: Decoder,
    frames: PacedFrames<std::io::Stdout>,
    size: (u16, u16),
    dirty: bool,
    disposing: bool,
    frame_due: Option<u64>,
    turns: u8,
    cleanup: SignalCleanup,
    was_busy: bool,
}

impl Driver {
    #[allow(clippy::too_many_arguments)]
    fn new(
        app: AppState,
        clock: Clock,
        env: &ModeEnv,
        restorer: TerminalRestorer,
        store: Arc<SessionStore>,
        runtime: Handle,
        tx: Sender<LoopEvent>,
        size: (u16, u16),
        cleanup: SignalCleanup,
    ) -> Self {
        // Windows builds that run this program all pass colour-support's truecolor threshold; the release string stands for that.
        let release = cfg!(windows).then(|| "10.0.19041".to_owned());
        let level = ColorEnvironment::from_process(stdout().is_terminal(), release).level();
        let ack_store = Arc::clone(&store);
        // The render acknowledgement: a flushed frame is the store's next publication boundary.
        let frames = PacedFrames::new(FrameWriter::new(stdout(), level), move |_ack| {
            ack_store.tick();
        });
        Self { app, clock, start: Instant::now(), env: *env, restorer, store, runtime, tx, decoder: Decoder::new(), frames, size, dirty: true, disposing: false, frame_due: None, turns: 0, cleanup, was_busy: false }
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// The loop; the process exit code.
    fn run(&mut self, rx: &Receiver<LoopEvent>) -> i32 {
        if let Some(sequence) = self.app.chrome.extended_keys_once(true, &self.env) {
            let _ = self.restorer.write(&sequence);
        }
        loop {
            let now = self.now_ms();
            self.clock.set(now);
            let wait = self.wait_ms(now);
            let mut next = match rx.recv_timeout(Duration::from_millis(wait)) {
                Ok(event) => Some(event),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return 0,
            };
            self.clock.set(self.now_ms());
            // Everything already waiting is handled before the next frame.
            while let Some(event) = next.take().or_else(|| rx.try_recv().ok()) {
                if let Some(code) = self.handle(event) {
                    return code;
                }
            }
            if let Some(code) = self.turn() {
                return code;
            }
        }
    }

    /// How long the loop may sleep: until the nearest deadline, never past the store poll.
    fn wait_ms(&self, now: u64) -> u64 {
        let mut wait = if self.store_busy() { TUI_FRAME_MS } else { STORE_POLL_IDLE_MS };
        let mut consider = |due: Option<u64>| {
            if let Some(due) = due {
                wait = wait.min(due.saturating_sub(now));
            }
        };
        consider(self.app.next_deadline());
        consider(self.app.mouse_deadline());
        consider(self.app.statusline_wake_in_ms().map(|wait| now + wait.ceil() as u64));
        consider(self.frame_due);
        let until = |instant: Instant| u64::try_from(instant.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(0);
        consider(self.decoder.next_deadline().map(|at| now + until(at)));
        consider(self.app.chrome.next_due().map(|due| due.max(0.0) as u64));
        wait.max(1)
    }

    fn store_busy(&self) -> bool {
        let state = self.store.state();
        state.get("busy") == Some(&Value::Bool(true)) || state.get("commandBusy") == Some(&Value::Bool(true))
    }

    /// One event; `Some(code)` ends the loop.
    fn handle(&mut self, event: LoopEvent) -> Option<i32> {
        match event {
            LoopEvent::Term(TermEvent::Bytes(bytes)) => {
                for input in self.decoder.feed(&bytes, Instant::now()) {
                    self.input(input);
                }
                self.dirty = true;
            }
            LoopEvent::Term(TermEvent::Resize(columns, rows)) => {
                self.size = (columns, rows);
                if self.app.chrome.on_resize_event(self.now_ms() as f64) {
                    self.apply_size();
                }
            }
            LoopEvent::Term(TermEvent::Closed) => {
                // The input is gone: the teardown a signal runs, with code 1 (it ends the process).
                self.cleanup.stdio_dead(StdioSource::Stdin, StdioEvent::Ended);
                return Some(1);
            }
            LoopEvent::Store(event) => {
                self.app.on_store_event(&event);
                self.dirty = true;
            }
            LoopEvent::Disposed => self.app.dispose_settled(),
            LoopEvent::Wake => {}
        }
        None
    }

    fn apply_size(&mut self) {
        if self.app.chrome.update(usize::from(self.size.0), usize::from(self.size.1)) {
            self.frames.writer_mut().resize();
            self.dirty = true;
        }
    }

    /// One decoded input: a key goes through the global handler, the picker on screen, the tool approval and the prompt; the mouse
    /// and a bracketed paste to their handlers.
    fn input(&mut self, input: InputEvent) {
        match input {
            InputEvent::Key { input, key } => self.app.on_key(&input, &key),
            InputEvent::Mouse(report) => self.app.on_mouse(&report),
            InputEvent::Paste(text) => self.app.prompt_paste(&text),
            InputEvent::Focus(_) => {}
        }
    }

    /// The work after the events of one wake-up: the timers, one item of background work, the store's publication, the exit
    /// flow and the frame. `Some(code)` ends the loop.
    fn turn(&mut self) -> Option<i32> {
        let now = self.now_ms();
        self.clock.set(now);
        for input in self.decoder.flush_due(Instant::now()) {
            self.input(input);
            self.dirty = true;
        }
        if self.app.chrome.poll(now as f64) {
            self.apply_size();
        }
        self.app.on_timers();
        self.app.on_mouse_timers();
        self.app.apply_published_override();
        let busy = self.store_busy();
        if busy != self.was_busy {
            self.was_busy = busy;
            self.app.on_busy_flip();
        }
        if self.app.take_frame_request() {
            self.dirty = true;
        }
        if self.app.statusline_turn(usize::from(self.size.0), usize::from(self.size.1)) {
            self.dirty = true;
        }
        if self.app.background_pending() {
            self.app.run_background();
            self.dirty = true;
        }
        if self.store.tick() {
            self.app.on_state_published();
            self.dirty = true;
        }
        match self.app.exit_step() {
            ExitStep::Wait => {}
            ExitStep::Dispose => self.dispose_in_background(),
            ExitStep::Exit => {
                self.draw();
                return Some(0);
            }
            ExitStep::HardExit => {
                let _ = self.restorer.write(EXIT_RESTORE_SEQUENCE);
                self.restorer.restore();
                std::process::exit(0);
            }
        }
        if self.dirty || self.frame_due.is_some() {
            self.draw();
        }
        if self.turns < 2 {
            self.turns += 1;
            if self.turns == 1 {
                // One poll of the loop has passed: the keys the OS buffered during setup were read while the prompt was disabled.
                self.app.chrome.tick_after_mount();
                self.dirty = true;
            }
        }
        None
    }

    /// Draws a frame when the pacer allows, else remembers when.
    fn draw(&mut self) {
        let now = self.now_ms();
        let size = self.app.chrome.resize_state();
        let (columns, rows) = (u16::try_from(size.columns).unwrap_or(80), u16::try_from(size.rows).unwrap_or(24));
        if self.app.take_repaint_request() {
            let _ = self.frames.force_full_repaint(now);
        }
        let wait = if self.dirty {
            let (grid, cursor) = self.app.render_frame(columns, rows);
            self.dirty = false;
            let wait = self.frames.draw(grid, cursor, now);
            self.app.after_frame();
            wait
        } else {
            self.frames.poll(now)
        };
        // A terminal that does not take the frame is gone: the same teardown a dead stdio runs (a would-block is ignored).
        if let Err(error) = &wait {
            self.cleanup.stdio_dead(StdioSource::Stdout, StdioEvent::Error(error));
        }
        self.frame_due = wait.ok().flatten().map(|wait| now + wait);
    }

    /// The store's disposal, off the loop: the exit flow races it against its own short limit.
    fn dispose_in_background(&mut self) {
        if self.disposing {
            return;
        }
        self.disposing = true;
        let store = Arc::clone(&self.store);
        let handle = self.runtime.clone();
        let tx = self.tx.clone();
        let _ = std::thread::Builder::new().name("mixdog-tui-dispose".to_owned()).spawn(move || {
            handle.block_on(store.dispose("cli-react-exit"));
            let _ = tx.send(LoopEvent::Disposed);
        });
    }

    /// The end of a normal run: the final frame is flushed, and the store is released within the exit wait.
    fn shutdown(&mut self, rx: &Receiver<LoopEvent>, settings: &ExitSettings) {
        let _ = self.frames.flush(self.now_ms());
        if !self.disposing {
            self.dispose_in_background();
        }
        let limit = Instant::now() + settings.wait_timeout;
        loop {
            match rx.recv_timeout(limit.saturating_duration_since(Instant::now())) {
                Ok(LoopEvent::Disposed) => break,
                Ok(_) => {}
                Err(_) => {
                    eprintln!("mixdog-tui dispose timed out after {}ms", settings.wait_timeout.as_millis());
                    break;
                }
            }
        }
        let _ = self.frames.writer_mut().finish();
        let _ = stdout().flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_boot_profile_names_phases_with_the_node_prefix_and_leaves_empty_fields_out() {
        let start = Instant::now();
        let profile = BootProfile::from_vars(|name| (name == "MIXDOG_BOOT_PROFILE").then(|| "On".to_owned()), start);
        let line = profile
            .line("run:start", &[("provider", Some("open ai".to_owned())), ("model", None), ("remote", Some(String::new()))], start)
            .expect("profiling is on");
        assert_eq!(line, "[mixdog-boot] +0.0ms tui:run:start provider=open_ai");
        let off = BootProfile::from_vars(|_| None, start);
        assert!(off.line("run:start", &[], start).is_none());
        let word_off = BootProfile::from_vars(|_| Some("0".to_owned()), start);
        assert!(word_off.line("run:start", &[], start).is_none());
    }

    #[test]
    fn the_refusal_without_a_terminal_is_the_two_lines_of_node() {
        assert_eq!(NO_TTY_MESSAGE.lines().count(), 2);
        assert!(NO_TTY_MESSAGE.starts_with("mixdog: the TUI needs an interactive terminal (TTY).\n"));
        assert!(NO_TTY_MESSAGE.ends_with("use --plain for the readline REPL.\n"));
    }
}


/// Runs the terminal UI until it exits and returns the process exit code.
pub fn run_tui(options: TuiOptions) -> ExitCode {
    let start = Instant::now();
    let profile = BootProfile::from_vars(|name| std::env::var(name).ok(), start);
    profile.log(
        "run:start",
        &[("provider", options.provider.clone()), ("model", options.model.clone()), ("remote", options.remote.then(|| "true".to_owned()))],
    );
    if !stdin().is_terminal() {
        eprint!("{NO_TTY_MESSAGE}");
        return ExitCode::from(1);
    }
    let settings = ExitSettings::from_process();
    let mut stderr_guard = StderrGuard::install();
    let env = ModeEnv::from_process();
    let modes = TerminalModes::new(env);
    let raw = match RawConsole::enable() {
        Ok(raw) => raw,
        Err(error) => {
            stderr_guard.restore();
            eprintln!("mixdog: {error}");
            return ExitCode::from(1);
        }
    };
    let guard = TerminalGuard::new(Arc::clone(&modes), Some(raw));
    let restorer = guard.restorer();
    install_panic_hook(restorer.clone());
    // The alternate screen and the modes come first: no stale shell rows show while the session boots.
    let _ = restorer.write(&format!("{}{BRACKETED_PASTE_ON}", screen_entry_sequence()));

    let shared: SharedStore = Arc::new(Mutex::new(None));
    let cleanup = install_cleanup(&settings, &restorer, &shared);
    let code = match Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => run_session(&options, &profile, &settings, &env, &restorer, &cleanup, &shared, &runtime),
        Err(error) => {
            restorer.restore();
            eprintln!("mixdog: {error}");
            1
        }
    };
    cleanup.uninstall();
    restorer.restore();
    drop(guard);
    stderr_guard.restore();
    if code == 0 {
        schedule_hard_exit(&settings, 0);
    }
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
#[allow(clippy::too_many_arguments)]
fn run_session(
    options: &TuiOptions,
    profile: &BootProfile,
    settings: &ExitSettings,
    env: &ModeEnv,
    restorer: &TerminalRestorer,
    cleanup: &SignalCleanup,
    shared: &SharedStore,
    runtime: &Runtime,
) -> i32 {
    let started = Instant::now();
    let (columns, rows) = terminal_size().unwrap_or((80, 24));
    let cwd = options
        .cwd
        .clone()
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or_else(|| std::env::current_dir().map(|dir| dir.display().to_string()).unwrap_or_default());
    let version = env!("CARGO_PKG_VERSION");
    // The splash keeps the seconds between the alternate screen and the first frame from being a blank void; the first frame
    // overprints it in place.
    let windows_like = windows_like_terminal(|name| std::env::var(name).ok());
    let _ = restorer.write(&boot_splash(usize::from(columns), windows_like, &cwd, version, Styler::process()));

    let store_options = StoreOptions {
        provider: options.provider.clone(),
        model: options.model.clone(),
        tool_mode: options.tool_mode.clone(),
        remote: options.remote,
        worktree: Some(options.worktree.clone().unwrap_or_else(|| json!({ "mode": "default" }))),
        cwd: Some(cwd.clone()),
        resume: options.resume.clone(),
    };
    let connecting = runtime.spawn(async move {
        ensure_core(EnsureOptions::default()).await.map_err(|error| format!("mixdog: {error}"))?;
        SessionStore::connect(store_options).await.map_err(|error| boot_error_line(&error))
    });
    let store = match runtime.block_on(connecting) {
        Ok(Ok(store)) => Arc::new(store),
        Ok(Err(line)) => {
            restorer.restore();
            eprintln!("{line}");
            return 1;
        }
        Err(error) => {
            restorer.restore();
            eprintln!("mixdog: {error}");
            return 1;
        }
    };
    *held(shared) = Some((Arc::clone(&store), runtime.handle().clone()));
    let mut io = SessionStoreIo::new(Arc::clone(&store), runtime.handle().clone());
    // The persisted theme is applied before the first frame, and the terminal's background follows the palette.
    if let Ok(Value::String(id)) = io.call("getTheme", &[]) {
        set_theme(&id);
    }
    let _ = restorer.write(&terminal_background_sequence(&current_palette()));
    // Launching inside a registered folder is an "open" too: best-effort recency.
    let _ = io.call("touchProjectSelected", &[json!(cwd)]);
    if let Some(effort) = &options.effort {
        let _ = io.call("setEffort", &[json!(effort)]);
    }
    profile.log("store:ready", &[("ms", elapsed_ms(started))]);
    // The verdict is read once, here: an unreadable status counts as completed.
    let onboarding_completed = io.onboarding_completed();

    let clock = Clock::new(0);
    let mut app = AppState::new(
        Box::new(io),
        clock.clone(),
        AppOptions { cwd, version: version.to_owned(), force_onboarding: options.force_onboarding, onboarding_completed: Some(onboarding_completed) },
    );
    let (tx, rx) = mpsc::channel::<LoopEvent>();
    spawn_store_forwarder(runtime, &store, tx.clone());
    let reader = start_reader(tx.clone());
    app.chrome.update(usize::from(columns), usize::from(rows));
    app.set_terminal(restorer.clone());
    let wake_tx = tx.clone();
    app.set_wake(Arc::new(move || {
        let _ = wake_tx.send(LoopEvent::Wake);
    }));
    app.mount();
    if let Some(renderer) = options.statusline.clone() {
        app.set_statusline(renderer, None);
    }
    profile.log("render:mounted", &[("ms", elapsed_ms(started))]);

    let mut driver = Driver::new(app, clock, env, restorer.clone(), Arc::clone(&store), runtime.handle().clone(), tx, (columns, rows), cleanup.clone());
    // Mouse tracking comes on once the session is ready, unless the environment turned it off.
    let _ = restorer.write(&env.mouse_on());
    let code = driver.run(&rx);

    // Teardown: the reader stops, the store is released within the exit wait, then the terminal and stderr are given back.
    drop(reader);
    driver.shutdown(&rx, settings);
    code
}
