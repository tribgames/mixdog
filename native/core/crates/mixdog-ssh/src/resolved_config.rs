use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mixdog_fsio::Unlaned;

use crate::binary::ssh_tool_command;
use crate::command::SshTarget;
use crate::context::{AttemptContext, ConfigFile, ReviewedConfig, SshConfigFiles, SshEnv, ToolOutput};
use crate::diagnostics::{DiagnosticKind, describe_argv};
use crate::host_key::ResolvedHost;
use crate::mixdog_config::{MixdogSshConfig, word};
use crate::pins::owner_of;

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
const SKIPPED_KEYS: [&str; 7] = ["host", "match", "include", "userknownhostsfile", "globalknownhostsfile", "updatehostkeys", "stricthostkeychecking"];
const GENERATED_HEADER: &str = "# Written by Mixdog from what ssh resolves for this server; forwards are left out.";
/// The header of a config that is the user's own, as it was read, behind Mixdog's known_hosts settings.
const SNAPSHOT_HEADER: &str = "# Written by Mixdog for one connection: the user's ssh config as it was read, behind Mixdog's known_hosts settings.";
/// Values that are file names: quoted when they hold spaces, which some ssh builds print bare.
const PATH_KEYS: [&str; 7] = ["identityfile", "certificatefile", "controlpath", "identityagent", "revokedhostkeys", "pkcs11provider", "securitykeyprovider"];

/// One `ssh -G` line: lower-cased key and its value.
pub type DumpLine = (String, String);

/// The lines of an `ssh -G` dump.
pub fn parse_dump(stdout: &str) -> Vec<DumpLine> {
    stdout.lines().filter_map(|line| line.trim().split_once(char::is_whitespace).map(|(key, value)| (key.to_lowercase(), value.trim().to_owned()))).collect()
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
pub(crate) struct Block {
    pub(crate) target: SshTarget,
    pattern: String,
    lines: Vec<DumpLine>,
    pub(crate) host: ResolvedHost,
}

impl Block {
    pub(crate) fn new(target: SshTarget, dump: &str, host: ResolvedHost) -> Self {
        Self { pattern: host_part(&target), lines: parse_dump(dump), target, host }
    }
}

/// What `ssh -G` resolved for a route, once per inspection: the inspection judges its servers by it and the config the attempt
/// runs with is written from it.
pub(crate) struct Route {
    /// The target, then the ProxyJump hops behind it (each server once).
    pub(crate) blocks: Vec<Block>,
    /// Every hop of the hops was read too, within [`MAX_CHAIN`] servers: only then can the route's own options be written out.
    pub(crate) complete: bool,
}

impl Route {
    /// The server `target` names, as resolved.
    pub(crate) fn host_of(&self, target: &SshTarget) -> Option<&ResolvedHost> {
        let pattern = host_part(target);
        self.blocks.iter().find(|block| block.pattern == pattern).map(|block| &block.host)
    }

    pub(crate) fn holds(&self, target: &SshTarget) -> bool {
        self.host_of(target).is_some()
    }

    /// Has the route reached [`MAX_CHAIN`] servers?
    pub(crate) fn is_full(&self) -> bool {
        self.blocks.len() >= MAX_CHAIN
    }

    /// The forwards the user's config sets for this connection and its hops, each once, at most 8.
    fn forwards(&self) -> Vec<String> {
        let mut forwards: Vec<String> = Vec::new();
        for forward in self.blocks.iter().flat_map(|block| block.host.forwards.iter().cloned()) {
            if !forwards.contains(&forward) {
                forwards.push(forward);
            }
        }
        forwards.truncate(MAX_FORWARDS);
        forwards
    }
}

fn host_part(target: &SshTarget) -> String {
    target.destination.rsplit('@').next().unwrap_or_default().to_owned()
}

/// The head of a server's `Host` block: the known_hosts files its ssh consults (Mixdog's own first, then the ones resolved for
/// it), and nothing a connection does may write the shared trust file or accept a key unseen.
fn known_hosts_head(pattern: &str, host: &ResolvedHost, own_known_hosts: &str) -> Vec<String> {
    let user_files = std::iter::once(own_known_hosts).chain(host.known_hosts_files.iter().map(String::as_str));
    let global = if host.global_known_hosts_files.is_empty() {
        "none".to_owned()
    } else {
        host.global_known_hosts_files.iter().map(|file| word(file)).collect::<Vec<_>>().join(" ")
    };
    vec![
        format!("Host {}", word(pattern)),
        "  UpdateHostKeys no".to_owned(),
        "  StrictHostKeyChecking yes".to_owned(),
        format!("  UserKnownHostsFile {}", user_files.map(word).collect::<Vec<_>>().join(" ")),
        format!("  GlobalKnownHostsFile {global}"),
    ]
}

/// One `Host` block for a resolved server.
pub fn resolved_block_text(pattern: &str, lines: &[DumpLine], host: &ResolvedHost, own_known_hosts: &str) -> String {
    let mut out = known_hosts_head(pattern, host, own_known_hosts);
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

/// The `SshTarget::key()` of the destination an ssh argument list addresses (`... -p N -- destination ...`).
pub(crate) fn args_target_key(args: &[String]) -> Option<String> {
    let dash = args.iter().position(|arg| arg == "--")?;
    let destination = args.get(dash + 1).filter(|destination| !destination.is_empty())?;
    let port = args[..dash].iter().rposition(|arg| arg == "-p").and_then(|at| args.get(at + 1)).and_then(|port| port.parse::<u16>().ok());
    Some(SshTarget { destination: destination.clone(), port, display: destination.clone() }.key())
}

/// At the start of a process, when the ssh state is first opened: nothing is selected and no attempt holds a file yet, so every
/// config written for an inspection (`t-….conf`, of this version or an earlier one) and every candidate an earlier build left
/// (`t-….cand`) that carries Mixdog's header is removed. Any other file is left. Called inside a transaction.
pub(crate) fn purge_unselected_target_configs(dir: &Path) -> std::io::Result<()> {
    for entry in mixdog_fsio::read_dir(&Unlaned, dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let generated_name = name.starts_with("t-") && (name.ends_with(".conf") || name.ends_with(".cand"));
        let ours = |bytes: &[u8]| bytes.starts_with(GENERATED_HEADER.as_bytes()) || bytes.starts_with(SNAPSHOT_HEADER.as_bytes());
        if generated_name && mixdog_fsio::read(&Unlaned, entry.path()).is_ok_and(|bytes| ours(&bytes)) {
            mixdog_fsio::remove_file(&Unlaned, entry.path())?;
        }
    }
    Ok(())
}

/// The config the last inspection of each target reviewed (what an ssh of no attempt, a restore or a reconnect, runs with), and
/// Mixdog's generic config for everything else. Where Mixdog's ssh folder could not be prepared there is no config of its own:
/// nothing is written and no generic config is named, so ssh reads the user's own files.
pub struct ResolvedConfigs {
    config: Option<Arc<MixdogSshConfig>>,
    files: Mutex<BTreeMap<String, Arc<ConfigFile>>>,
}

impl ResolvedConfigs {
    pub fn new(config: Arc<MixdogSshConfig>) -> Arc<Self> {
        Arc::new(Self { config: Some(config), files: Mutex::new(BTreeMap::new()) })
    }

    /// For a machine whose Mixdog ssh folder could not be prepared.
    pub fn without_config() -> Arc<Self> {
        Arc::new(Self { config: None, files: Mutex::new(BTreeMap::new()) })
    }

    fn files(&self) -> MutexGuard<'_, BTreeMap<String, Arc<ConfigFile>>> {
        self.files.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Writes the config the inspection of `target` reviewed, for it alone, from the route it read: the route's resolved options
    /// without forwards where a file can say them faithfully, else `user_config` (the user's ssh config as it was read before the
    /// route) with Mixdog's known_hosts settings for every server of the route ahead of it. Either way each server's ssh consults
    /// the files the inspection judged it by. The file becomes the one later ssh runs of the target find. Gives the forwards of the
    /// user's config that then apply (none for the route's own options).
    pub(crate) async fn write_reviewed(
        &self,
        env: &SshEnv,
        ctx: &AttemptContext,
        target: &SshTarget,
        route: &Route,
        user_config: Option<&str>,
    ) -> std::io::Result<(ReviewedConfig, Vec<String>)> {
        let key = target.key();
        let Some(config) = &self.config else { return Ok((ReviewedConfig { target_key: key, file: None }, Vec::new())) };
        let own = config.known_hosts_file().to_string_lossy().into_owned();
        let owner = owner_of(target);
        let fresh = || ConfigFile::new(config.dir().join(format!("t-v2-{owner}-{:016x}.conf", rand::random::<u64>())));
        if route.complete && !route.blocks.iter().any(is_lossy) {
            let file = fresh();
            let mut text = vec![GENERATED_HEADER.to_owned()];
            text.extend(route.blocks.iter().map(|block| resolved_block_text(&block.pattern, &block.lines, &block.host, &own)));
            text.push(String::new());
            mixdog_fsio::write(&Unlaned, file.path(), text.join("\n"))?;
            if says_what_was_resolved(env, ctx, route, file.path()).await {
                return Ok((self.select(key, file), Vec::new()));
            }
        }
        let file = fresh();
        let mut text = vec![SNAPSHOT_HEADER.to_owned()];
        text.extend(route.blocks.iter().map(|block| known_hosts_head(&block.pattern, &block.host, &own).join("\n")));
        text.push(crate::mixdog_config::generic_block(&own, &[]));
        text.extend(user_config.map(str::to_owned));
        mixdog_fsio::write(&Unlaned, file.path(), text.join("\n"))?;
        Ok((self.select(key, file), route.forwards()))
    }

    fn select(&self, key: String, file: ConfigFile) -> ReviewedConfig {
        let file = Arc::new(file);
        self.files().insert(key.clone(), Arc::clone(&file));
        ReviewedConfig { target_key: key, file: Some(file) }
    }
}

/// Does the file say what ssh resolved, for the server and for every hop?
async fn says_what_was_resolved(env: &SshEnv, ctx: &AttemptContext, route: &Route, file: &Path) -> bool {
    for block in &route.blocks {
        let mut args = vec!["-G".to_owned(), "-F".to_owned(), file.to_string_lossy().into_owned()];
        args.extend(port_args(&block.target));
        args.extend(["--".to_owned(), block.target.destination.clone()]);
        let again = run_ssh(env, ctx, &args).await.filter(|check| check.exit_code == Some(0)).map(|check| comparable(&parse_dump(&check.stdout)));
        if again.as_ref() != Some(&comparable(&block.lines)) {
            return false;
        }
    }
    true
}

impl SshConfigFiles for ResolvedConfigs {
    /// The config the last inspection of the target an argument list is for reviewed, if any.
    fn for_args(&self, args: &[String]) -> Option<PathBuf> {
        let key = args_target_key(args)?;
        self.files().get(&key).map(|file| file.path().to_path_buf())
    }

    fn generic(&self) -> Option<PathBuf> {
        self.config.as_ref()?.generic()
    }
}

#[cfg(test)]
#[path = "resolved_config_tests.rs"]
mod resolved_config_tests;
