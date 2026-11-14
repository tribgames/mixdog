//! `process/*`: spawn a process and stream its output on `process:<handle>`, kill it, resize its
//! PTY, write its stdin. Interactive input arrives as the `process/input` notification, which is
//! never dropped: a full input queue pauses the sending connection's reader instead.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_app_protocol::ProcessInputParams;
use mixdog_app_protocol::v2::domain::ProcessSpawnParams;
use mixdog_app_protocol::v2::params::ProcessKillParams;
use mixdog_app_protocol::v2::params::ProcessResizePtyParams;
use mixdog_app_protocol::v2::params::ProcessWriteStdinParams;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_protocol::TerminalTabId;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use serde_json::Value;
use serde_json::json;

use super::decode;
use super::feeds::ProcessFeeds;
use super::invalid_params;
use super::process_failure;
use crate::manager::LocalProcessManager;

pub struct ProcessService {
    manager: LocalProcessManager,
    feeds: Arc<ProcessFeeds>,
}

impl ProcessService {
    pub fn new(manager: LocalProcessManager, feeds: Arc<ProcessFeeds>) -> Arc<Self> {
        Arc::new(Self { manager, feeds })
    }
}

fn text<'a>(value: &'a Value, key: &str, path: &str) -> Result<&'a str, CoreError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params(path, format!("`{key}` must be a string")))
}

/// `tool{threadId,toolCallId}` | `terminalTab{tabId}` | `lsp{root,lang}` | `internal`: as an
/// object with a `kind`, or as a single-key object, or the bare string `"internal"`.
fn owner_of(value: &Value) -> Result<ProcessOwner, CoreError> {
    let (kind, body) = match value {
        Value::String(kind) => (kind.as_str(), value),
        Value::Object(map) => match map.get("kind").and_then(Value::as_str) {
            Some(kind) => (kind, value),
            None if map.len() == 1 => {
                let (kind, body) = map.iter().next().expect("one entry");
                (kind.as_str(), body)
            }
            None => return Err(invalid_params("owner", "an owner has a `kind`")),
        },
        _ => return Err(invalid_params("owner", "an owner is a string or an object")),
    };
    match kind {
        "internal" => Ok(ProcessOwner::Internal),
        "tool" => Ok(ProcessOwner::Tool {
            thread_id: ThreadId::from(text(body, "threadId", "owner.threadId")?),
            tool_call_id: ToolCallId::from(text(body, "toolCallId", "owner.toolCallId")?),
        }),
        "terminalTab" => Ok(ProcessOwner::TerminalTab {
            tab_id: TerminalTabId::from(text(body, "tabId", "owner.tabId")?),
        }),
        "lsp" => Ok(ProcessOwner::Lsp {
            root: AbsPath::new(text(body, "root", "owner.root")?)
                .ok_or_else(|| invalid_params("owner.root", "an absolute path"))?,
            language: text(body, "lang", "owner.lang")?.to_owned(),
        }),
        other => Err(invalid_params("owner.kind", format!("unknown owner `{other}`"))),
    }
}

fn spawn_request(params: ProcessSpawnParams) -> Result<SpawnRequest, CoreError> {
    let command = match (params.argv, params.shell) {
        (Some(argv), None) => {
            let mut argv = argv.into_iter();
            let program = argv
                .next()
                .filter(|program| !program.is_empty())
                .ok_or_else(|| invalid_params("argv", "a program"))?;
            CommandSpec::Argv {
                program,
                args: argv.collect(),
            }
        }
        (None, Some(script)) => CommandSpec::Shell { script, shell: None },
        _ => return Err(invalid_params("argv", "exactly one of `argv` and `shell`")),
    };
    let cwd = match params.cwd {
        Some(cwd) => AbsPath::new(cwd).ok_or_else(|| invalid_params("cwd", "an absolute path"))?,
        None => std::env::current_dir()
            .ok()
            .and_then(AbsPath::new)
            .ok_or_else(|| invalid_params("cwd", "an absolute path"))?,
    };
    let output = match params.output_mode.as_deref() {
        None | Some("merged") => OutputMode::Merged,
        Some("separate") => OutputMode::Separate,
        Some(other) => return Err(invalid_params("outputMode", format!("`merged` or `separate`, not `{other}`"))),
    };
    let env: BTreeMap<String, String> = params.env.unwrap_or_default();
    Ok(SpawnRequest {
        handle: params.process_handle,
        command,
        cwd,
        env: EnvSpec {
            inherit: true,
            set: env.into_iter().collect(),
            remove: Vec::new(),
        },
        pty: params.pty.map(|size| PtySize {
            cols: size.cols,
            rows: size.rows,
        }),
        stdin_piped: true,
        output,
        owner: owner_of(&params.owner)?,
        time_limit: params.timeout_ms.map(Duration::from_millis),
    })
}

fn bytes_of(encoded: &str) -> Result<Vec<u8>, CoreError> {
    STANDARD
        .decode(encoded)
        .map_err(|_| invalid_params("bytesB64", "base64"))
}

#[async_trait]
impl DomainService for ProcessService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "process/spawn" => {
                let request = spawn_request(decode::<ProcessSpawnParams>(&req.params)?)?;
                let handle = request.handle.clone();
                let spawned = self.manager.spawn(request).await.map_err(process_failure)?;
                Ok(Reply::Subscribe(Subscribe {
                    result: json!({ "processHandle": spawned.handle, "pid": spawned.pid }),
                    feed: self.feeds.feed(handle.as_str(), false),
                    window: Window::Fixed,
                    resume_from: None,
                }))
            }
            "process/kill" => {
                let params: ProcessKillParams = decode(&req.params)?;
                self.manager.kill(&params.process_handle).map_err(process_failure)?;
                Ok(Reply::Value(json!({})))
            }
            "process/resizePty" => {
                let params: ProcessResizePtyParams = decode(&req.params)?;
                let size = PtySize {
                    cols: params.cols,
                    rows: params.rows,
                };
                self.manager.resize_pty(&params.process_handle, size).map_err(process_failure)?;
                Ok(Reply::Value(json!({})))
            }
            "process/writeStdin" => {
                let params: ProcessWriteStdinParams = decode(&req.params)?;
                let bytes = bytes_of(&params.bytes_b64)?;
                if !bytes.is_empty() {
                    self.manager
                        .write_stdin(&params.process_handle, bytes)
                        .await
                        .map_err(process_failure)?;
                }
                if params.close_stdin == Some(true) {
                    self.manager.close_stdin(&params.process_handle).map_err(process_failure)?;
                }
                Ok(Reply::Value(json!({})))
            }
            other => Err(invalid_params("method", format!("a method of process, not {other}"))),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["process/spawn", "process/kill", "process/resizePty", "process/writeStdin", "process/input"]
    }

    fn notify(&self, method: Method, params: Value, _from: ConnectionId) -> Admit {
        if method.as_str() != "process/input" {
            return Admit::Accepted;
        }
        // A malformed notification has nobody to answer: it is dropped.
        let Ok(params) = serde_json::from_value::<ProcessInputParams>(params) else {
            return Admit::Accepted;
        };
        let Ok(bytes) = bytes_of(&params.bytes_b64) else {
            return Admit::Accepted;
        };
        match self.manager.write_input(&params.process_handle, bytes.clone()) {
            Err(mixdog_core_api::domain::process::ProcessError::Overloaded { .. }) => {
                let manager = self.manager.clone();
                Admit::Pause(Box::pin(async move {
                    let _ = manager.write_input_wait(&params.process_handle, bytes).await;
                }))
            }
            _ => Admit::Accepted,
        }
    }
}
