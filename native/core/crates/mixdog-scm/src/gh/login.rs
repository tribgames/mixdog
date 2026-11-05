//! GitHub sign-in as a [`LoginFlow`] (DS §5.4): `gh auth login --web` under a PTY (gh insists
//! on a TTY), its device code and URL read from the output, the account verified and git's
//! credential helper set up when it exits 0. Progress is the flow's state; the scoped feed
//! `login:<flowId>` and the snapshot read are the core's, built on [`LoginSession`].
//!
//! No timer decides the outcome: a device code the user never enters ends when gh exits (its
//! own expiry), and the user cancels when they give up.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::TaskClass;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::desktop::home_dir;
use crate::gh::client::GhClient;

const HOSTNAME: &str = "github.com";
const OUTPUT_KEEP_CHARS: usize = 20_000;
const DEFAULT_DEVICE_URL: &str = "https://github.com/login/device";

/// A command that exits 0 and ignores the URL argument: gh never opens a browser itself, the
/// client opens the device page on the browser the user actually sits at.
fn no_op_browser() -> &'static str {
    if cfg!(windows) { "cmd /c exit 0" } else { "true" }
}

/// Removes terminal control sequences and carriage returns from PTY output.
pub fn strip_control(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {}
            '\u{1b}' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if next.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if next == '\u{7}' {
                            break;
                        }
                    }
                }
                _ => {}
            },
            other => out.push(other),
        }
    }
    out
}

/// "First copy your one-time code: XXXX-XXXX" or "One-time code (XXXX-XXXX) copied to
/// clipboard" (gh's own clipboard option).
pub fn find_device_code(output: &str) -> Option<String> {
    let lower = output.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("one-time code") {
        let rest = &output[from + at + "one-time code".len()..];
        let after = if let Some(rest) = rest.strip_prefix(':') {
            Some(rest.trim_start())
        } else {
            rest.trim_start().strip_prefix('(')
        };
        if let Some(after) = after {
            let code: String = after
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            if code.len() >= 6 {
                return Some(code);
            }
        }
        from += at + 1;
    }
    None
}

pub fn find_device_url(output: &str) -> Option<String> {
    let at = output.find("https://github.com/login/device")?;
    Some(output[at..].split_whitespace().next()?.to_owned())
}

struct Shared {
    state: watch::Sender<LoginState>,
    receiver: tokio::sync::Mutex<watch::Receiver<LoginState>>,
    delivered_terminal: std::sync::atomic::AtomicBool,
    handle: ProcessHandle,
    processes: Arc<dyn ProcessManager>,
}

impl Shared {
    /// Moves to `next` unless the flow already ended.
    fn advance(&self, next: LoginState) {
        self.state.send_if_modified(|current| {
            if current.is_terminal() {
                return false;
            }
            *current = next;
            true
        });
    }
}

struct Session(Arc<Shared>);

#[async_trait]
impl LoginSession for Session {
    fn state(&self) -> LoginState {
        self.0.state.borrow().clone()
    }

    async fn next(&self) -> Option<LoginState> {
        if self.0.delivered_terminal.load(Ordering::Acquire) {
            return None;
        }
        let mut receiver = self.0.receiver.lock().await;
        if receiver.changed().await.is_err() {
            return None;
        }
        let state = receiver.borrow_and_update().clone();
        if state.is_terminal() {
            self.0.delivered_terminal.store(true, Ordering::Release);
        }
        Some(state)
    }

    async fn provide(&self, _input: LoginInput) -> Result<(), LoginError> {
        if self.0.state.borrow().is_terminal() {
            Err(LoginError::Finished)
        } else {
            // gh's device flow takes no pasted code.
            Err(LoginError::InputNotExpected)
        }
    }

    fn cancel(&self) {
        self.0.advance(LoginState::Cancelled);
        let _ = self.0.processes.kill(&self.0.handle);
    }
}

pub struct GithubLogin {
    processes: Arc<dyn ProcessManager>,
    client: Arc<GhClient>,
    program: Arc<dyn Fn() -> String + Send + Sync>,
    current: Mutex<Option<Arc<Shared>>>,
    sequence: AtomicU64,
    target: LoginTarget,
}

impl GithubLogin {
    pub fn new(
        processes: Arc<dyn ProcessManager>,
        client: Arc<GhClient>,
        program: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            processes,
            client,
            program,
            current: Mutex::new(None),
            sequence: AtomicU64::new(0),
            target: LoginTarget::Github,
        }
    }
}

#[async_trait]
impl LoginFlow for GithubLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let home = AbsPath::new(home_dir()).ok_or(LoginError::Failed(LoginFailure::Failed {
            code: "home".into(),
            message: "The home directory is not absolute.".into(),
        }))?;
        // One login at a time: a fresh start supersedes (and kills) the earlier flow.
        if let Some(previous) = self.current.lock().expect("login flow").take() {
            previous.advance(LoginState::Cancelled);
            let _ = previous.processes.kill(&previous.handle);
        }
        let handle = ProcessHandle(format!(
            "scm-login-{}-{}",
            std::process::id(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        ));
        let request = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv {
                program: (self.program)(),
                args: ["auth", "login", "--hostname", HOSTNAME, "--web"]
                    .iter()
                    .map(|arg| (*arg).to_owned())
                    .collect(),
            },
            cwd: home,
            env: EnvSpec {
                inherit: true,
                // Prompts are disabled so gh never asks the git-protocol / git-credentials
                // questions (and skips its press-Enter stop).
                set: vec![
                    ("GH_PROMPT_DISABLED".into(), "1".into()),
                    ("BROWSER".into(), no_op_browser().into()),
                    ("GH_BROWSER".into(), no_op_browser().into()),
                ],
                remove: Vec::new(),
            },
            pty: Some(PtySize { cols: 120, rows: 30 }),
            stdin_piped: false,
            output: OutputMode::Merged,
            owner: ProcessOwner::Internal,
            time_limit: None,
        };
        match self.processes.spawn(request).await {
            Ok(_) => {}
            Err(ProcessError::ProgramNotFound { .. }) => {
                return Err(LoginError::Failed(LoginFailure::Unavailable { capability: "gh".into() }));
            }
            Err(other) => {
                return Err(LoginError::Failed(LoginFailure::Failed {
                    code: "spawn".into(),
                    message: format!("{other:?}"),
                }));
            }
        }
        let events = self
            .processes
            .subscribe(&handle, Some(0))
            .map_err(|error| LoginError::Failed(LoginFailure::Failed { code: "subscribe".into(), message: format!("{error:?}") }))?;
        let (sender, receiver) = watch::channel(LoginState::Starting);
        let shared = Arc::new(Shared {
            state: sender,
            receiver: tokio::sync::Mutex::new(receiver),
            delivered_terminal: std::sync::atomic::AtomicBool::new(false),
            handle,
            processes: self.processes.clone(),
        });
        *self.current.lock().expect("login flow") = Some(shared.clone());
        let driven = shared.clone();
        let client = self.client.clone();
        mixdog_rt::spawn("scm-login", TaskClass::Work, async move {
            drive(driven, events, client).await;
        });
        Ok(Box::new(Session(shared)))
    }
}

async fn drive(shared: Arc<Shared>, mut events: Box<dyn EventSource<ProcessEvent>>, client: Arc<GhClient>) {
    let mut output = String::new();
    let mut url: Option<String> = None;
    let exit = loop {
        match events.next().await {
            Some(ProcessEvent::Output { bytes, .. }) => {
                output.push_str(&strip_control(&String::from_utf8_lossy(&bytes)));
                if output.chars().count() > OUTPUT_KEEP_CHARS {
                    let skip = output.chars().count() - OUTPUT_KEEP_CHARS;
                    output = output.chars().skip(skip).collect();
                }
                url = url.or_else(|| find_device_url(&output));
                if matches!(*shared.state.borrow(), LoginState::Starting) {
                    if let Some(code) = find_device_code(&output) {
                        shared.advance(LoginState::DeviceCode {
                            user_code: code,
                            verification_uri: url.clone().unwrap_or_else(|| DEFAULT_DEVICE_URL.into()),
                            expires_at: None,
                        });
                    }
                }
            }
            Some(ProcessEvent::Exited { exit, .. }) => break Some(exit),
            None => break None,
        }
    };
    if shared.state.borrow().is_terminal() {
        return;
    }
    let Some(exit) = exit else {
        shared.advance(LoginState::Failed(LoginFailure::Failed {
            code: "gh-exit".into(),
            message: "gh ended without an exit status.".into(),
        }));
        return;
    };
    if exit.killed == Some(KillReason::Requested) {
        shared.advance(LoginState::Cancelled);
        return;
    }
    let succeeded = matches!(exit.status, mixdog_core_api::domain::process::ExitStatus::Code(0));
    if !succeeded {
        let tail: Vec<&str> = output.trim().lines().filter(|line| !line.is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(3)..].join(" ");
        let message = if tail.is_empty() {
            match exit.status {
                mixdog_core_api::domain::process::ExitStatus::Code(code) => format!("gh exited with code {code}"),
                mixdog_core_api::domain::process::ExitStatus::Signal(signal) => format!("gh ended by signal {signal}"),
            }
        } else {
            tail
        };
        shared.advance(LoginState::Failed(LoginFailure::Failed { code: "gh-exit".into(), message }));
        return;
    }
    let home = home_dir();
    let cancel = CancellationToken::new();
    let verdict = async {
        let status = client
            .output(&home, &cancel, &["auth", "status", "--hostname", HOSTNAME, "--active"])
            .await?;
        if !status.success() {
            return Ok(Err(LoginFailure::Failed {
                code: "not-signed-in".into(),
                message: "gh finished, but no account is signed in.".into(),
            }));
        }
        // Non-interactive login skips gh's git-credentials step; wire it up here.
        let setup = client
            .output(&home, &cancel, &["auth", "setup-git", "--hostname", HOSTNAME])
            .await?;
        if !setup.success() {
            let detail = setup.stderr.trim();
            return Ok(Err(LoginFailure::Failed {
                code: "setup-git".into(),
                message: format!(
                    "Signed in to GitHub, but Git could not be set up to use it: {}",
                    if detail.is_empty() { format!("gh auth setup-git exited with code {}", setup.code.unwrap_or(-1)) } else { detail.to_owned() }
                ),
            }));
        }
        Ok::<_, crate::error::ScmFailure>(Ok(crate::gh::account::login_from_auth_output(&status.combined())))
    }
    .await;
    shared.advance(match verdict {
        Ok(Ok(login)) => LoginState::Done {
            account: (!login.is_empty()).then_some(login),
        },
        Ok(Err(failure)) => LoginState::Failed(failure),
        Err(crate::error::ScmFailure::Unavailable { .. }) => {
            LoginState::Failed(LoginFailure::Unavailable { capability: "gh".into() })
        }
        Err(other) => LoginState::Failed(LoginFailure::Failed {
            code: "verify".into(),
            message: other.to_string(),
        }),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_code_and_url_are_read_from_gh_output() {
        let text = strip_control("\u{1b}[1mFirst copy your one-time code: ABCD-1234\u{1b}[0m\r\nOpen https://github.com/login/device now\n");
        assert_eq!(find_device_code(&text).as_deref(), Some("ABCD-1234"));
        assert_eq!(find_device_url(&text).as_deref(), Some("https://github.com/login/device"));
        assert_eq!(
            find_device_code("! One-time code (WXYZ-9876) copied to clipboard").as_deref(),
            Some("WXYZ-9876")
        );
        assert_eq!(find_device_code("one-time code: abc"), None);
    }
}
