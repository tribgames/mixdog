//! The diagnostics of a saved server: its connection log, the text the user copies into a bug report (this PC's ssh version and
//! what ssh resolves for the address, the log redacted), and the tail of the server's `daemon.log` read over ssh.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{SshLogView, SshServerLog};
use mixdog_ssh::binary::ssh_tool_command;
use mixdog_ssh::command::{parse_ssh_target, SshError, SshTarget};
use mixdog_ssh::context::{AttemptContext, SshEnv};
use mixdog_ssh::diagnostics::{
    diagnostics_key_for, os_label, redact_secrets, redact_server, server_names, Diagnostics, DiagnosticsInput, DIAGNOSTICS_MAX_ENTRIES,
};
use mixdog_ssh::host_key::{parse_ssh_config_dump, ResolvedHost};
use mixdog_ssh::spawn::{ssh_exec, ExecOptions};

use crate::attempts::AttemptError;
use crate::host_store::{SshHostRecord, SshHostStore};
use crate::restore::attempt_context;

const SSH_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const SSH_CONFIG_TIMEOUT: Duration = Duration::from_secs(8);
const DAEMON_LOG_TIMEOUT: Duration = Duration::from_secs(20);
const DAEMON_LOG_COMMAND: &str = "tail -n 200 \"$HOME/.mixdog-remote/daemon.log\" 2>&1 || true";
const EMPTY_LOG: &str = "(daemon.log is empty or does not exist yet)";
const UNRESOLVED: &str = "(ssh could not resolve this address)";

/// Who asks: this PC's own window may ask about any saved server id or address, a server's window only about its own server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Asker {
    ThisPc,
    Server(String),
}

/// What the diagnostics read of the machine.
#[async_trait]
pub trait DiagnosticsMachine: Send + Sync {
    /// The first line `ssh -V` prints; empty when it cannot be run.
    async fn ssh_version(&self) -> String;
    /// What `ssh -G` resolves for the address; `None` when it cannot.
    async fn resolved_host(&self, target: &SshTarget) -> Option<ResolvedHost>;
    /// The tail of the server's `daemon.log`, read over ssh inside `context`.
    async fn daemon_log(&self, target: &SshTarget, context: AttemptContext) -> Result<String, SshError>;
    /// `win32 10.0.26100 (x64)`.
    fn os(&self) -> String;
    fn diagnostics(&self) -> Arc<Diagnostics>;
}

/// This PC: its OpenSSH and its connection logs. `os_release` is the operating system's release as the report names it.
pub struct EnvDiagnostics {
    pub env: Arc<SshEnv>,
    pub os_release: String,
}

#[async_trait]
impl DiagnosticsMachine for EnvDiagnostics {
    async fn ssh_version(&self) -> String {
        let version = self.env.tools.run(&ssh_tool_command("ssh", &self.env), &["-V".to_owned()], SSH_VERSION_TIMEOUT).await;
        version.map_or_else(
            |_| String::new(),
            |output| {
                let text = if output.stderr.is_empty() { output.stdout } else { output.stderr };
                text.trim().lines().next().unwrap_or("").to_owned()
            },
        )
    }

    async fn resolved_host(&self, target: &SshTarget) -> Option<ResolvedHost> {
        let mut args = vec!["-G".to_owned()];
        if let Some(port) = target.port {
            args.extend(["-p".to_owned(), port.to_string()]);
        }
        args.extend(["--".to_owned(), target.destination.clone()]);
        let dump = self.env.tools.run(&ssh_tool_command("ssh", &self.env), &args, SSH_CONFIG_TIMEOUT).await.ok()?;
        if dump.exit_code == Some(0) { parse_ssh_config_dump(&dump.stdout, &self.env) } else { None }
    }

    async fn daemon_log(&self, target: &SshTarget, context: AttemptContext) -> Result<String, SshError> {
        let options = ExecOptions {
            target: target.clone(),
            command: DAEMON_LOG_COMMAND.to_owned(),
            input: None,
            timeout: DAEMON_LOG_TIMEOUT,
            context: Some(context),
        };
        ssh_exec(&self.env, options).await.map(|output| output.stdout)
    }

    fn os(&self) -> String {
        os_label(&self.os_release)
    }

    fn diagnostics(&self) -> Arc<Diagnostics> {
        self.env.diagnostics.clone()
    }
}

/// A jump hop without its user and port: the host the report redacts.
fn hop_host(hop: &str) -> &str {
    let host = hop.rfind('@').map_or(hop, |at| &hop[at + 1..]);
    match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) => name,
        _ => host,
    }
}

/// The config lines worth copying, and the names the report redacts besides the target's own.
fn config_of(host: Option<&ResolvedHost>) -> (Vec<String>, Vec<String>) {
    let Some(host) = host else { return (vec![UNRESOLVED.to_owned()], Vec::new()) };
    let mut config =
        vec![format!("HostName {}", host.hostname), format!("User {}", host.user.as_deref().unwrap_or("")), format!("Port {}", host.port)];
    if let Some(jump) = &host.proxy_jump {
        config.push(format!("ProxyJump {jump}"));
    }
    if host.proxy_command {
        config.push("ProxyCommand (set)".to_owned());
    }
    let mut names = vec![host.hostname.clone(), host.user.clone().unwrap_or_default()];
    if let Some(jump) = &host.proxy_jump {
        for hop in jump.split(',') {
            names.push(hop.to_owned());
            names.push(hop_host(hop).to_owned());
        }
    }
    (config, names)
}

/// The server a diagnostics call is about.
struct Subject {
    record: Option<SshHostRecord>,
    target: SshTarget,
}

pub struct DiagnosticsOps {
    hosts: Arc<SshHostStore>,
    machine: Arc<dyn DiagnosticsMachine>,
}

impl DiagnosticsOps {
    pub fn new(hosts: Arc<SshHostStore>, machine: Arc<dyn DiagnosticsMachine>) -> Self {
        Self { hosts, machine }
    }

    fn subject(&self, asker: &Asker, reference: &str) -> Result<Subject, AttemptError> {
        let parse = |raw: &str| parse_ssh_target(raw).map_err(|error| AttemptError::new(error.to_string()));
        match asker {
            Asker::ThisPc => {
                if reference.is_empty() {
                    return Err(AttemptError::new("ref must be a non-empty string."));
                }
                let record = self.hosts.get(reference);
                let target = parse(record.as_ref().map_or(reference, |record| record.target.as_str()))?;
                Ok(Subject { record, target })
            }
            Asker::Server(route) => {
                let record = self.hosts.get(route).ok_or_else(|| AttemptError::new("This window has no SSH server log."))?;
                let target = parse(&record.target)?;
                Ok(Subject { record: Some(record), target })
            }
        }
    }

    /// `connections/ssh/diagnosticsLog`: the connection log of the server and the same text redacted for copying.
    pub fn log(&self, asker: &Asker, reference: &str) -> Result<SshLogView, AttemptError> {
        let Subject { target, .. } = self.subject(asker, reference)?;
        let lines = self.machine.diagnostics().lines(&diagnostics_key_for(&target), DIAGNOSTICS_MAX_ENTRIES);
        let copy_text = redact_server(&lines.join("\n"), &server_names(&target, &[]));
        Ok(SshLogView { lines, copy_text })
    }

    /// `connections/ssh/diagnosticsCopy`: the text for a bug report. `app_version` is the version the asking window's
    /// `initialize` announced.
    pub async fn copy(&self, asker: &Asker, reference: &str, app_version: &str) -> Result<String, AttemptError> {
        let Subject { target, .. } = self.subject(asker, reference)?;
        let ssh_version = self.machine.ssh_version().await;
        let (config, extra_names) = config_of(self.machine.resolved_host(&target).await.as_ref());
        let key = diagnostics_key_for(&target);
        Ok(self.machine.diagnostics().report(&DiagnosticsInput {
            key: &key,
            target: &target,
            app_version,
            ssh_version: &ssh_version,
            os: &self.machine.os(),
            config: &config,
            extra_names: &extra_names,
            lines: None,
        }))
    }

    /// `connections/ssh/serverLog`: the tail of the server's `daemon.log`. A server that cannot be reached is a `Failed` answer.
    pub async fn server_log(&self, asker: &Asker, reference: &str) -> Result<SshServerLog, AttemptError> {
        let Subject { record, target } = self.subject(asker, reference)?;
        let key = diagnostics_key_for(&target);
        let context = match &record {
            Some(record) => attempt_context(record),
            None => AttemptContext { diagnostics_key: Some(key.clone()), ..AttemptContext::default() },
        };
        let diagnostics = self.machine.diagnostics();
        Ok(match self.machine.daemon_log(&target, context).await {
            Ok(output) => {
                let cleaned = redact_secrets(&output).trim_end().to_owned();
                let cleaned = if cleaned.is_empty() { EMPTY_LOG.to_owned() } else { cleaned };
                diagnostics.log(Some(&key), &format!("server log fetched ({} lines)", cleaned.split('\n').count()));
                let copy_text = redact_server(&cleaned, &server_names(&target, &[]));
                SshServerLog::text(cleaned, copy_text)
            }
            Err(error) => {
                diagnostics.log(Some(&key), &format!("server log failed: {}", error.message));
                SshServerLog::failed(error.message)
            }
        })
    }
}
