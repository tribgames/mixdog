//! The warm PowerShell standby (Node's `shell-warm-standby.mjs`): one PowerShell started ahead of its use, parked in
//! [`POWERSHELL_BOOTSTRAP`] reading its script from stdin, so the next PowerShell command skips the process start. It is
//! taken by a command whose shell and environment (less the session scratch variables, set by the hand-off prelude) are
//! the ones it was started with, at most two minutes after it started; each take starts the next one. A standby runs
//! exactly one script, the one it is fed, and then exits, so no command ever runs in a process another command used. A
//! drifted standby is ended when found, an idle one after its time, and the parked one at shutdown.
//! `MIXDOG_SHELL_WARM_STANDBY=0` turns it off; `MIXDOG_SHELL_WARM_STANDBY_IDLE_MS` (100 ms at least) sets the time.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::TaskClass;

use super::invocation::POWERSHELL_BOOTSTRAP;

/// The session scratch variables: they differ between sessions by design, so they stay out of the reuse signature and
/// are set by the hand-off prelude (`SCRATCH_ENV_KEYS`).
const SCRATCH_KEYS: [&str; 3] = ["TEMP", "TMP", "TMPDIR"];

fn disabled() -> bool {
    std::env::var("MIXDOG_SHELL_WARM_STANDBY").as_deref() == Ok("0")
}

/// `STANDBY_TTL_MS`: how long a standby may wait for its command.
fn idle_limit() -> Duration {
    let configured = std::env::var("MIXDOG_SHELL_WARM_STANDBY_IDLE_MS").ok().and_then(|ms| ms.trim().parse::<f64>().ok());
    match configured {
        Some(ms) if ms.is_finite() && ms >= 100.0 => Duration::from_millis(ms.floor() as u64),
        _ => Duration::from_secs(120),
    }
}

/// `envSignature`: the environment a standby can serve, less the scratch variables.
fn signature(env: &EnvSpec) -> String {
    let mut set: Vec<String> =
        env.set.iter().filter(|(key, _)| !SCRATCH_KEYS.contains(&key.as_str())).map(|(key, value)| format!("{key}={value}")).collect();
    set.sort();
    let mut removed: Vec<&str> = env.remove.iter().map(String::as_str).filter(|key| !SCRATCH_KEYS.contains(key)).collect();
    removed.sort_unstable();
    format!("{}\n{}\n-{}", env.inherit, set.join("\n"), removed.join("\n"))
}

/// `psStringExpr`: a PowerShell expression yielding `value`, which travels as UTF-8 Base64 (PowerShell quoting has no
/// safe form for typographic apostrophes and the like).
fn ps_string(value: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
    format!("[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{encoded}'))")
}

/// The value `key` has in the environment `env` gives a process.
fn value_in(env: &EnvSpec, key: &str) -> Option<String> {
    if let Some((_, value)) = env.set.iter().rev().find(|(k, _)| k == key) {
        return Some(value.clone());
    }
    (env.inherit && !env.remove.iter().any(|k| k == key)).then(|| std::env::var(key).ok()).flatten()
}

/// What is fed ahead of the command's script (`feed`): the command's own scratch variables (set, or cleared when it has
/// none), then its working directory for PowerShell and for .NET.
pub fn hand_off_prelude(env: &EnvSpec, cwd: &str) -> String {
    let mut prelude: String = SCRATCH_KEYS
        .iter()
        .map(|key| match value_in(env, key) {
            Some(value) => format!("$env:{key} = {}; ", ps_string(&value)),
            None => format!("Remove-Item -LiteralPath 'Env:{key}' -ErrorAction SilentlyContinue; "),
        })
        .collect();
    if !cwd.is_empty() {
        prelude.push_str(&format!(
            "$__mixdogCwd = {}; Set-Location -LiteralPath $__mixdogCwd; [System.Environment]::CurrentDirectory = $__mixdogCwd; ",
            ps_string(cwd)
        ));
    }
    prelude
}

struct Parked {
    handle: ProcessHandle,
    processes: Arc<dyn ProcessManager>,
    shell: String,
    env: String,
    started: tokio::time::Instant,
    idle: tokio::task::AbortHandle,
}

impl Parked {
    fn alive(&self) -> bool {
        self.processes.list().iter().any(|info| info.handle == self.handle && info.exit.is_none())
    }

    fn end(self) {
        self.idle.abort();
        let _ = self.processes.kill(&self.handle);
    }
}

#[derive(Default)]
struct State {
    parked: Option<Parked>,
    /// A standby is being started: no second one is started beside it.
    warming: bool,
    /// Shutdown: nothing is parked any more.
    closed: bool,
}

/// The parked standby of one runtime.
#[derive(Default)]
pub struct Standby {
    state: Mutex<State>,
    seq: AtomicU64,
}

impl Standby {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `takeWarmShellStandby`: the parked standby's handle when it can run a command of `shell` with `env`, `None` on
    /// any miss. A standby that drifted is ended; either way the next one is started.
    pub fn take(self: &Arc<Self>, processes: &Arc<dyn ProcessManager>, shell: &str, env: &EnvSpec) -> Option<ProcessHandle> {
        if disabled() {
            return None;
        }
        let wanted = signature(env);
        let mut state = self.state();
        let taken = match state.parked.take() {
            Some(parked) if !parked.alive() => {
                parked.end();
                None
            }
            Some(parked) if parked.shell != shell || parked.started.elapsed() > idle_limit() || parked.env != wanted => {
                parked.end();
                None
            }
            Some(parked) => {
                parked.idle.abort();
                Some(parked.handle)
            }
            None => None,
        };
        self.refill(&mut state, processes, shell, env);
        taken
    }

    /// `ensureWarmShellStandby`: starts the next standby beside the command, unless one is starting.
    fn refill(self: &Arc<Self>, state: &mut State, processes: &Arc<dyn ProcessManager>, shell: &str, env: &EnvSpec) {
        if state.warming || state.closed || state.parked.is_some() {
            return;
        }
        // Spawned where the daemon runs, not in the command's folder, which a parked process would hold open.
        let Some(cwd) = std::env::current_dir().ok().and_then(|dir| AbsPath::new(&dir)) else { return };
        state.warming = true;
        let handle = ProcessHandle(format!("shell-standby-{}", self.seq.fetch_add(1, Ordering::Relaxed) + 1));
        let request = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Shell { script: POWERSHELL_BOOTSTRAP.to_owned(), shell: Some(shell.to_owned()) },
            cwd,
            env: env.clone(),
            pty: None,
            stdin_piped: true,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit: None,
        };
        let (standby, processes, shell, env) = (Arc::clone(self), Arc::clone(processes), shell.to_owned(), signature(env));
        mixdog_rt::spawn("shell-standby", TaskClass::Work, async move {
            let spawned = processes.spawn(request).await.is_ok();
            let mut state = standby.state();
            state.warming = false;
            if !spawned {
                return;
            }
            if state.closed {
                let _ = processes.kill(&handle);
                return;
            }
            let idle = standby.end_when_idle(handle.clone());
            state.parked = Some(Parked { handle, processes, shell, env, started: tokio::time::Instant::now(), idle });
        });
    }

    /// Ends the standby `handle` once it has waited its time, if it is still the parked one.
    fn end_when_idle(self: &Arc<Self>, handle: ProcessHandle) -> tokio::task::AbortHandle {
        let standby = Arc::downgrade(self);
        mixdog_rt::spawn("shell-standby-idle", TaskClass::Work, async move {
            tokio::time::sleep(idle_limit()).await;
            let Some(standby) = standby.upgrade() else { return };
            let mut state = standby.state();
            if state.parked.as_ref().is_some_and(|parked| parked.handle == handle) {
                let parked = state.parked.take().expect("the parked standby");
                drop(state);
                parked.processes.kill(&parked.handle).ok();
            }
        })
        .abort_handle()
    }

    /// Shutdown: the parked standby is ended and none is parked after it.
    pub fn end(&self) {
        let mut state = self.state();
        state.closed = true;
        if let Some(parked) = state.parked.take() {
            drop(state);
            parked.end();
        }
    }

    /// The parked standby's handle, for tests.
    pub fn parked(&self) -> Option<ProcessHandle> {
        self.state().parked.as_ref().map(|parked| parked.handle.clone())
    }
}
