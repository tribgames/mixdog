//! The ssh config Mixdog's own ssh invocations (probe, exec, tunnel) run with, built per target from what `ssh -G`
//! resolves for it: every resolved option of the host and of each ProxyJump hop, except what forwards something
//! (ports, agent, X11, local commands), and without including the user's config. A hop's ssh reads the same file
//! (`-F` is passed on to it), so each hop gets its own `Host` block. Mixdog's known_hosts is listed first, then the
//! user's files. The file is checked by resolving the target through it and comparing: when it does not say the same,
//! nothing stays written for the target and the caller falls back to the generic config that includes the user's
//! file (and tells the user which forwards then apply).

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mixdog_fsio::Unlaned;
use sha2::{Digest, Sha256};

use crate::binary::ssh_tool_command;
use crate::command::{parse_ssh_target, SshTarget};
use crate::context::{AttemptContext, SshConfigFiles, SshEnv, ToolOutput};
use crate::diagnostics::{describe_argv, DiagnosticKind};
use crate::host_key::{parse_ssh_config_dump, ResolvedHost};
use crate::mixdog_config::{word, MixdogSshConfig};

const TOOL_TIMEOUT: Duration = Duration::from_millis(8_000);
const MAX_CHAIN: usize = 6;
const MAX_FORWARDS: usize = 8;

/// What forwards something or runs a local command: never carried into Mixdog's config.
const FORWARDING_KEYS: [&str; 13] = [
    "localforward",
    "remoteforward",
    "dynamicforward",
    "clearallforwardings",
    "forwardagent",
    "forwardx11",
    "forwardx11trusted",
    "forwardx11timeout",
    "gatewayports",
    "tunnel",
    "tunneldevice",
    "permitlocalcommand",
    "localcommand",
];
/// Lines that would open another block, or are written by Mixdog itself.
const SKIPPED_KEYS: [&str; 5] = ["host", "match", "include", "userknownhostsfile", "globalknownhostsfile"];
/// Values that are file names: quoted when they hold spaces, which some ssh builds print bare.
const PATH_KEYS: [&str; 7] =
    ["identityfile", "certificatefile", "controlpath", "identityagent", "revokedhostkeys", "pkcs11provider", "securitykeyprovider"];

/// One `ssh -G` line: lower-cased key and its value.
pub type DumpLine = (String, String);

/// The lines of an `ssh -G` dump.
pub fn parse_dump(stdout: &str) -> Vec<DumpLine> {
    stdout
        .lines()
        .filter_map(|line| line.trim().split_once(char::is_whitespace).map(|(key, value)| (key.to_lowercase(), value.trim().to_owned())))
        .collect()
}

fn is_forwarding(key: &str) -> bool {
    FORWARDING_KEYS.contains(&key)
}

fn is_skipped(key: &str) -> bool {
    SKIPPED_KEYS.contains(&key)
}

/// What a faithful config must reproduce: the resolved options that are neither forwarding nor Mixdog's own, order and
/// path separators aside.
fn comparable(lines: &[DumpLine]) -> Vec<String> {
    let mut kept: Vec<String> = lines
        .iter()
        .filter(|(key, _)| !is_forwarding(key) && !is_skipped(key))
        .map(|(key, value)| format!("{key} {}", value.replace('\\', "/").replace('"', "")))
        .collect();
    kept.sort();
    kept
}

/// One server of the route: what `ssh -G` said about it.
struct Block {
    target: SshTarget,
    pattern: String,
    lines: Vec<DumpLine>,
    host: ResolvedHost,
}

fn host_part(target: &SshTarget) -> String {
    target.destination.rsplit('@').next().unwrap_or_default().to_owned()
}

/// One `Host` block for a resolved server.
pub fn resolved_block_text(pattern: &str, lines: &[DumpLine], host: &ResolvedHost, own_known_hosts: &str) -> String {
    let user_files = std::iter::once(own_known_hosts).chain(host.known_hosts_files.iter().map(String::as_str));
    let mut out = vec![format!("Host {}", word(pattern)), format!("  UserKnownHostsFile {}", user_files.map(word).collect::<Vec<_>>().join(" "))];
    if !host.global_known_hosts_files.is_empty() {
        out.push(format!("  GlobalKnownHostsFile {}", host.global_known_hosts_files.iter().map(|file| word(file)).collect::<Vec<_>>().join(" ")));
    }
    for (key, value) in lines {
        if is_forwarding(key) || is_skipped(key) {
            continue;
        }
        let bare_path_with_space = PATH_KEYS.contains(&key.as_str()) && value.contains(char::is_whitespace) && !value.starts_with('"');
        out.push(format!("  {key} {}", if bare_path_with_space { word(value) } else { value.clone() }));
    }
    out.join("\n")
}

/// ssh -G prints characters the console code page lacks as `?`: a path that went through that is not the user's path
/// any more, and the config cannot carry it faithfully.
fn is_lossy(block: &Block) -> bool {
    let lossy = |text: &str| text.contains(['?', '\u{FFFD}']);
    block.lines.iter().any(|(key, value)| PATH_KEYS.contains(&key.as_str()) && lossy(value))
        || block.host.known_hosts_files.iter().chain(&block.host.global_known_hosts_files).any(|file| lossy(file))
}

fn port_args(target: &SshTarget) -> Vec<String> {
    target.port.map(|port| vec!["-p".to_owned(), port.to_string()]).unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// `ssh` with `args` to the end, written to the attempt's diagnostics ring; None when it could not run.
async fn run_ssh(env: &SshEnv, ctx: &AttemptContext, args: &[String]) -> Option<ToolOutput> {
    env.diagnostics.record(ctx.diagnostics_key.as_deref(), DiagnosticKind::Ssh, &describe_argv("ssh", args), now_ms());
    env.tools.run(&ssh_tool_command("ssh", env), args, TOOL_TIMEOUT).await.ok()
}

/// The dump of one destination of the route, resolved through the user's own config.
async fn resolve_one(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget) -> Option<(Vec<DumpLine>, ResolvedHost)> {
    let mut args = vec!["-G".to_owned()];
    args.extend(port_args(target));
    args.extend(["--".to_owned(), target.destination.clone()]);
    let dump = run_ssh(env, ctx, &args).await.filter(|dump| dump.exit_code == Some(0))?;
    let host = parse_ssh_config_dump(&dump.stdout, env)?;
    Some((parse_dump(&dump.stdout), host))
}

/// The target and, depth first, every ProxyJump hop behind it; None when any of them cannot be read or the route is
/// longer than [`MAX_CHAIN`] servers.
async fn resolve_chain(env: &SshEnv, ctx: &AttemptContext, root: &SshTarget) -> Option<Vec<Block>> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut blocks: Vec<Block> = Vec::new();
    let mut pending = vec![root.clone()];
    while let Some(target) = pending.pop() {
        let pattern = host_part(&target);
        if seen.contains(&pattern) {
            continue;
        }
        if seen.len() >= MAX_CHAIN {
            return None;
        }
        let (lines, host) = resolve_one(env, ctx, &target).await?;
        seen.insert(pattern.clone());
        let mut hops = Vec::new();
        if let Some(jump) = &host.proxy_jump {
            for part in jump.split(',') {
                let part = part.trim();
                hops.push(parse_ssh_target(part.strip_prefix("ssh://").unwrap_or(part)).ok()?);
            }
        }
        pending.extend(hops.into_iter().rev());
        blocks.push(Block { target, pattern, lines, host });
    }
    Some(blocks)
}

/// A target's own generated config.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedConfig {
    /// The file every ssh of the target runs with (`-F`).
    pub file: PathBuf,
    /// The forwards of the user's config for this connection and its hops that the file leaves out: none of them
    /// applies.
    pub forwards: Vec<String>,
}

/// The target keeps the generic config, which includes the user's file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Unresolved {
    /// The forwards the user's config applies to this connection (and its hops), at most 8; empty when the route
    /// could not be read at all.
    pub forwards: Vec<String>,
}

/// Destination and port as typed: what the generated files are told apart by.
fn key_of(destination: &str, port: &str) -> String {
    format!("{destination}\u{0}{port}")
}

/// The generated configs of the targets resolved so far, and Mixdog's generic config for everything else. Where Mixdog's ssh folder
/// could not be prepared there is no config of its own: no target resolves and no generic config is named, so ssh reads the user's
/// own files.
pub struct ResolvedConfigs {
    config: Option<Arc<MixdogSshConfig>>,
    files: Mutex<BTreeMap<String, PathBuf>>,
}

impl ResolvedConfigs {
    pub fn new(config: Arc<MixdogSshConfig>) -> Arc<Self> {
        Arc::new(Self { config: Some(config), files: Mutex::new(BTreeMap::new()) })
    }

    /// For a machine whose Mixdog ssh folder could not be prepared.
    pub fn without_config() -> Arc<Self> {
        Arc::new(Self { config: None, files: Mutex::new(BTreeMap::new()) })
    }

    fn files(&self) -> MutexGuard<'_, BTreeMap<String, PathBuf>> {
        self.files.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Builds and verifies the generated config for `target` and makes it the one [`SshConfigFiles::for_args`]
    /// returns for the target's ssh arguments. `Err` means the generic config stays in use.
    pub async fn resolve_for_target(&self, env: &SshEnv, ctx: &AttemptContext, target: &SshTarget) -> Result<ResolvedConfig, Unresolved> {
        let Some(config) = &self.config else { return Err(Unresolved::default()) };
        let key = key_of(&target.destination, &target.port.map(|port| port.to_string()).unwrap_or_default());
        self.files().remove(&key);
        let own = config.known_hosts_file().to_string_lossy().into_owned();
        let Some(blocks) = resolve_chain(env, ctx, target).await else { return Err(Unresolved::default()) };
        let mut forwards: Vec<String> = Vec::new();
        for forward in blocks.iter().flat_map(|block| block.host.forwards.iter().cloned()) {
            if !forwards.contains(&forward) {
                forwards.push(forward);
            }
        }
        forwards.truncate(MAX_FORWARDS);
        let unresolved = Unresolved { forwards };
        if blocks.iter().any(is_lossy) {
            return Err(unresolved);
        }
        let digest = Sha256::digest(key.as_bytes());
        let name: String = digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect();
        let file = config.dir().join(format!("t-{name}.conf"));
        let mut text = vec!["# Written by Mixdog from what ssh resolves for this server; forwards are left out.".to_owned()];
        text.extend(blocks.iter().map(|block| resolved_block_text(&block.pattern, &block.lines, &block.host, &own)));
        text.push(String::new());
        if let Err(failure) = mixdog_fsio::write(&Unlaned, &file, text.join("\n")) {
            let note = format!("the ssh config of the target could not be written: {failure}");
            env.diagnostics.record(ctx.diagnostics_key.as_deref(), DiagnosticKind::Log, &note, now_ms());
            return Err(unresolved);
        }
        // The file must say what ssh resolved, for the server and for every hop.
        for block in &blocks {
            let mut args = vec!["-G".to_owned(), "-F".to_owned(), file.to_string_lossy().into_owned()];
            args.extend(port_args(&block.target));
            args.extend(["--".to_owned(), block.target.destination.clone()]);
            let again = run_ssh(env, ctx, &args).await.filter(|check| check.exit_code == Some(0)).map(|check| comparable(&parse_dump(&check.stdout)));
            if again.as_ref() != Some(&comparable(&block.lines)) {
                let _ = mixdog_fsio::remove_file(&Unlaned, &file);
                return Err(unresolved);
            }
        }
        self.files().insert(key, file.clone());
        Ok(ResolvedConfig { file, forwards: unresolved.forwards })
    }
}

impl SshConfigFiles for ResolvedConfigs {
    /// The generated config of the target an argument list is for (`... -p N -- destination ...`), if one was built.
    fn for_args(&self, args: &[String]) -> Option<PathBuf> {
        let dash = args.iter().position(|arg| arg == "--")?;
        let destination = args.get(dash + 1).filter(|destination| !destination.is_empty())?;
        let port = args[..dash].iter().rposition(|arg| arg == "-p").map_or("", |at| args.get(at + 1).map_or("", String::as_str));
        self.files().get(&key_of(destination, port)).cloned()
    }

    fn generic(&self) -> Option<PathBuf> {
        self.config.as_ref()?.generic()
    }
}

#[cfg(test)]
#[path = "resolved_config_tests.rs"]
mod resolved_config_tests;
