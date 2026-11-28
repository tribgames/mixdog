//! The plain REPL of the native `mixdog` binary (`mixdog --plain`): a styled inline terminal loop over a session of the core.
//!
//! * [`repl`]: the loop, the input pipeline and the terminal output.
//! * [`line_editor`]: prompt, emacs keys, history of the session, bracketed paste.
//! * [`stream_sink`]: the live assistant stream.
//! * [`turn_output`]: what is printed once a turn has settled, and the fold of the session's state into a turn's steps.
//! * [`slash`]: the REPL's `/command` table.
//!
//! The session is the store of `mixdog-session-view`; [`run`] ensures the core serves (`mixdog_launch::ensure_core`), connects,
//! and runs the REPL on the process's terminal.

use std::io::BufRead;
use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_launch::ensure_core::EnsureOptions;
use mixdog_launch::ensure_core::client_error_line;
use mixdog_launch::ensure_core::ensure_core;
use mixdog_session_view::store::SessionStore;
use mixdog_session_view::store::StoreError;
use mixdog_session_view::store::StoreEvent;
use mixdog_session_view::store::StoreOptions;
use mixdog_term::console::RawConsole;
use mixdog_term::guard::CleanupConfig;
use mixdog_term::guard::Hook;
use mixdog_term::guard::SignalCleanup;
use mixdog_term::reader::ReaderHandle;
use mixdog_term::reader::spawn_reader;
use mixdog_tui_style::color::Styler;
use serde_json::Value;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::mpsc::unbounded_channel;

pub mod line_editor;
pub mod repl;
pub mod slash;
pub mod stream_sink;
pub mod turn_output;

pub use repl::InputMsg;
pub use repl::Repl;
pub use repl::ReplConfig;
pub use repl::StdoutOut;
pub use stream_sink::Out;
pub use turn_output::Footer;

/// The session the REPL follows: what it reads and does of the store, as one trait so a test can play a session.
#[async_trait::async_trait]
pub trait Session: Send + Sync {
    /// The last published state.
    fn state(&self) -> Arc<Value>;
    /// One frame: publishes the state if anything changed.
    fn tick(&self) -> bool;
    /// The store's events (the connection's, the session's loss).
    fn subscribe(&self) -> broadcast::Receiver<StoreEvent>;
    /// Hands a prompt to the session (`ask`); the turn it starts is followed through the state.
    async fn submit(&self, prompt: &str) -> Result<(), String>;
    /// A session action (`clear`, `compact`, `setRoute`, ...), answered with its result or the error text.
    async fn call(&self, action: &str, args: &[Value]) -> Result<Value, String>;
    /// Closes the session (`closeRuntime(reason)`); a second close does nothing.
    async fn dispose(&self, reason: &str);
}

#[async_trait::async_trait]
impl Session for SessionStore {
    fn state(&self) -> Arc<Value> {
        SessionStore::state(self)
    }

    fn tick(&self) -> bool {
        SessionStore::tick(self)
    }

    fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
        SessionStore::subscribe(self)
    }

    async fn submit(&self, prompt: &str) -> Result<(), String> {
        SessionStore::submit(self, &json!(prompt), &json!({})).await.map(|_| ()).map_err(|error| error.to_string())
    }

    async fn call(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        SessionStore::call(self, action, args).await.map_err(|error| error.to_string())
    }

    async fn dispose(&self, reason: &str) {
        SessionStore::dispose(self, reason).await;
    }
}

/// How the REPL is started (the options of `mixdog --plain`).
#[derive(Clone, Debug)]
pub struct ReplOptions {
    pub provider: Option<String>,
    pub model: Option<String>,
    /// `full` or `readonly`.
    pub tool_mode: String,
    /// The working folder; the process's when not named.
    pub cwd: Option<String>,
}

impl Default for ReplOptions {
    fn default() -> Self {
        Self { provider: None, model: None, tool_mode: "full".to_owned(), cwd: None }
    }
}

/// How long the cleanup of a signal may take (`timeoutMs: 6500`).
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(6500);

/// Turns bracketed paste on or off on a terminal.
const PASTE_ON: &str = "\x1b[?2004h";
const PASTE_OFF: &str = "\x1b[?2004l";

/// Runs the plain REPL on the process's terminal and returns the exit code: `0` for a quit or the end of input, `130` for
/// Ctrl+C, `1` when the core cannot be reached or the terminal fails. `footer` is the statusline renderer the process built.
pub fn run(options: ReplOptions, footer: Arc<dyn Footer>) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("mixdog: {error}");
            return ExitCode::FAILURE;
        }
    };
    let code = runtime.block_on(run_process(options, footer, runtime.handle().clone()));
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

fn connect_failure(error: &StoreError) -> String {
    match error {
        StoreError::Client(error) => client_error_line(error),
        other => format!("mixdog: {other}"),
    }
}

/// A step of the signal cleanup.
fn hook(step: impl Fn(&str) + Send + Sync + 'static) -> Hook {
    Arc::new(step)
}

/// Makes a panic, on any thread, run `restore` before the hooks installed earlier, the entry's among them, which ends the process:
/// no drop runs after a panic in the shipped build (`panic = "abort"`), nor after that hook.
fn restore_on_panic(restore: Hook) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore("panic");
        previous(info);
    }));
}

fn spawn_input(interactive: bool, tx: UnboundedSender<InputMsg>) -> Option<ReaderHandle> {
    if interactive {
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = spawn_reader(sender);
        std::thread::spawn(move || {
            for event in receiver {
                if tx.send(InputMsg::Term(event)).is_err() {
                    return;
                }
            }
        });
        return Some(reader);
    }
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if tx.send(InputMsg::Line(line)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(InputMsg::Eof);
    });
    None
}

async fn run_process(options: ReplOptions, footer: Arc<dyn Footer>, handle: tokio::runtime::Handle) -> i32 {
    // The core serves before the session connects, as the terminal UI does.
    if let Err(error) = ensure_core(EnsureOptions::default()).await {
        eprintln!("mixdog: {error}");
        return 1;
    }
    let cwd = options.cwd.clone().or_else(|| std::env::current_dir().ok().map(|dir| dir.to_string_lossy().into_owned())).unwrap_or_default();
    let store_options = StoreOptions {
        provider: options.provider.clone(),
        model: options.model.clone(),
        tool_mode: Some(options.tool_mode.clone()),
        cwd: Some(cwd.clone()),
        ..StoreOptions::default()
    };
    let store = match SessionStore::connect(store_options).await {
        Ok(store) => Arc::new(store),
        Err(error) => {
            eprintln!("{}", connect_failure(&error));
            return 1;
        }
    };

    let mut out = StdoutOut::new();
    // readline's `terminal` follows the output: a terminal on both ends is edited in raw mode; with the output piped the
    // terminal's own line discipline echoes and the lines are read as they come.
    let interactive = std::io::stdin().is_terminal() && out.is_terminal();
    let (tx, mut rx) = unbounded_channel();
    // Raw mode and the reader thread of a terminal; the lines of a pipe otherwise.
    let raw = if interactive {
        match RawConsole::enable() {
            Ok(raw) => Some(Arc::new(Mutex::new(raw))),
            Err(error) => {
                eprintln!("mixdog: the terminal cannot be read: {error}");
                store.dispose("cli-exit").await;
                return 1;
            }
        }
    } else {
        None
    };
    let paste = interactive;
    let mut reader = spawn_input(interactive, tx);
    if paste {
        let _ = Out::write_str(&mut out, PASTE_ON);
    }

    // SIGINT, SIGTERM and the closing of the console: a newline, the terminal's own modes back, the session closed.
    let before = {
        let raw = raw.clone();
        hook(move |_| {
            if let Some(raw) = &raw {
                raw.lock().unwrap_or_else(std::sync::PoisonError::into_inner).restore();
            }
            let mut text = String::from("\n");
            if paste {
                text.push_str(PASTE_OFF);
            }
            let _ = Out::write_str(&mut StdoutOut::new(), &text);
        })
    };
    if interactive {
        restore_on_panic(Arc::clone(&before));
    }
    let close = {
        let store = Arc::clone(&store);
        hook(move |reason| handle.block_on(Session::dispose(&*store, reason)))
    };
    let mut cleanup = CleanupConfig::new("mixdog-repl");
    cleanup.timeout = CLEANUP_TIMEOUT;
    cleanup.before_cleanup = Some(before);
    cleanup.cleanup = Some(close);
    let signals = SignalCleanup::install(cleanup);

    let config = ReplConfig { provider: options.provider, model: options.model, tool_mode: options.tool_mode, cwd, styler: Styler::process(), interactive };
    let code = Repl::new(&*store, &*footer, &config, &mut out, &mut rx).run().await;

    signals.uninstall();
    if let Some(reader) = reader.as_mut() {
        reader.stop();
    }
    if let Some(raw) = &raw {
        raw.lock().unwrap_or_else(std::sync::PoisonError::into_inner).restore();
    }
    if paste {
        let _ = Out::write_str(&mut out, PASTE_OFF);
    }
    code
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use super::hook;
    use super::restore_on_panic;

    /// A panic in `--plain` ends the process in the hook the entry installed first (mixdog-entry `end_on_panic`), before any unwind:
    /// the terminal's own modes are back by then.
    #[test]
    fn a_panic_restores_the_terminal_before_the_hook_that_ends_the_process() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let ends = Arc::clone(&seen);
        std::panic::set_hook(Box::new(move |_| ends.lock().unwrap().push("end".to_owned())));
        let restores = Arc::clone(&seen);
        restore_on_panic(hook(move |reason| restores.lock().unwrap().push(format!("restore {reason}"))));
        let panicked = std::thread::spawn(|| panic!("a turn failed")).join();
        drop(std::panic::take_hook());
        assert!(panicked.is_err());
        assert_eq!(*seen.lock().unwrap(), ["restore panic", "end"]);
    }
}
