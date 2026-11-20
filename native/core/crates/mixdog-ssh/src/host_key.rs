//! Host-key pre-check. The ssh options used for the real connection check host keys strictly
//! (`StrictHostKeyChecking=yes`), so a new key can only get into known_hosts through this module: before the first
//! connection the server's key (and the key of every ProxyJump hop on the way) is read, compared with Mixdog's own,
//! the user's and the system-wide known_hosts, and shown. The connection only follows once the user has confirmed a
//! new key, and that exact key is written to known_hosts first, so ssh then checks the server against what was shown.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use mixdog_app_protocol::v2::connections::{SshConfigSummary, SshHopKey, SshHopRole, SshHopStatus, SshHostKeyCheck, SshMessage, SshMissing};
use mixdog_fsio::Unlaned;
use regex::Regex;

use crate::binary::{client_install_command, is_missing_message, missing_client_message, ssh_tool_command};
use crate::command::{parse_ssh_target, FailureClass, SshError, SshTarget};
use crate::context::{AttemptContext, ReviewedConfig, SshEnv, ToolOutput};
use crate::resolved_config::{Block, ResolvedConfigs, Route};
use crate::diagnostics::{describe_argv, DiagnosticKind};
use crate::known_hosts::{host_field_matches, key_fingerprint, known_hosts_spec, parse, KnownHostEntry, KnownHostMarker};
use crate::pins::{can_rotate, commit_claims, owner_of, rotate_claim, Claim, EndpointTrust, KnownEntry};
use crate::mixdog_config::{account, word, MixdogSshConfig};
use crate::private_dir::{create_private_dir, join_name, make_temp_dir};
use crate::spawn::now_ms;

const SCAN_TIMEOUT: Duration = Duration::from_millis(12_000);
const PROXY_SCAN_TIMEOUT: Duration = Duration::from_millis(30_000);
const TOOL_TIMEOUT: Duration = Duration::from_millis(8_000);
const MAX_FORWARDS: usize = 8;

const DEFAULT_ALGORITHM_ORDER: [&str; 5] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"];

/// One server on the way, as the protocol shows it.
pub type HopKey = SshHopKey;
/// What the server's key looks like against known_hosts.
pub type HostKeyCheck = SshHostKeyCheck;

/// `host type base64`: a key a server presented.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostKeyLine {
    /// known_hosts host field (plain, hashed or a comma list).
    pub hosts: String,
    pub key_type: String,
    pub key: String,
}

/// `host type base64` lines; comments and `@cert-authority` / `@revoked` markers are skipped.
pub fn parse_key_lines(text: &str) -> Vec<HostKeyLine> {
    parse(text)
        .into_iter()
        .filter(|entry| entry.marker == KnownHostMarker::None)
        .map(|entry| HostKeyLine { hosts: entry.hosts, key_type: entry.key_type, key: entry.key })
        .collect()
}

fn key_type_label(key_type: &str) -> String {
    let label = match key_type {
        "ssh-ed25519" => "ED25519",
        "ssh-rsa" => "RSA",
        "ssh-dss" => "DSA",
        other if other.starts_with("ecdsa-") => "ECDSA",
        other if other.starts_with("sk-ssh-ed25519") => "ED25519-SK",
        other if other.starts_with("sk-ecdsa-") => "ECDSA-SK",
        other => other,
    };
    label.to_owned()
}

/// HostKeyAlgorithms as key types: certificate and rsa-sha2 variants fold into their key type, order kept.
fn normalize_algorithms(list: &[&str]) -> Vec<String> {
    let mut types: Vec<String> = Vec::new();
    for algorithm in list {
        let base = algorithm.strip_suffix("-cert-v01@openssh.com").unwrap_or(algorithm);
        let kind = if matches!(base, "rsa-sha2-256" | "rsa-sha2-512") { "ssh-rsa" } else { base };
        if !types.iter().any(|known| known == kind) {
            types.push(kind.to_owned());
        }
    }
    types
}

/// What `ssh -G` says about a destination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedHost {
    pub hostname: String,
    pub port: u16,
    pub user: Option<String>,
    pub known_hosts_files: Vec<String>,
    pub global_known_hosts_files: Vec<String>,
    /// Key types in the order ssh will try them.
    pub host_key_algorithms: Vec<String>,
    pub proxy_jump: Option<String>,
    pub proxy_command: bool,
    pub proxied: bool,
    /// LocalForward / RemoteForward / DynamicForward lines of the resolved config (`local <spec>`...), at most 8.
    pub forwards: Vec<String>,
}

/// `~` or `~/x` in front of a path is this user's home folder.
fn expand_home(env: &SshEnv, path: &str) -> String {
    let home = env.home.to_string_lossy();
    if path == "~" {
        return home.into_owned();
    }
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => {
            let rest = rest.trim_start_matches(['/', '\\']);
            let rest = if env.platform.is_windows() { rest.replace('/', "\\") } else { rest.to_owned() };
            join_name(env.platform, &home, &rest)
        }
        None => path.to_owned(),
    }
}

static PATH_WORD: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r#""([^"]*)"|(\S+)"#).ok());
static PATH_START: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^(~|/|[A-Za-z]:[\\/]|%|\.{1,2}[\\/]|none$|__PROGRAMDATA__)").ok());

/// Splits an `ssh -G` list of file paths. ssh prints them space-separated and, on some builds, without quotes even
/// when a path has spaces (a profile folder named "John Doe"): a word that does not look like the start of a path
/// belongs to the path before it.
fn split_paths(value: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    let (Some(words), Some(start)) = (PATH_WORD.as_ref(), PATH_START.as_ref()) else { return paths };
    for captures in words.captures_iter(value) {
        let quoted = captures.get(1).is_some();
        let word = captures.get(1).or_else(|| captures.get(2)).map_or("", |part| part.as_str());
        if quoted || start.is_match(word) || paths.is_empty() {
            paths.push(word.to_owned());
        } else if let Some(last) = paths.last_mut() {
            last.push(' ');
            last.push_str(word);
        }
    }
    paths
}

/// What `ssh -G` says about the destination: the real host name and port (after ~/.ssh/config), the known_hosts
/// files, the key types it will try and any proxy. None when the dump names no host.
pub fn parse_ssh_config_dump(stdout: &str, env: &SshEnv) -> Option<ResolvedHost> {
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    let mut forwards: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let Some((key, rest)) = line.trim().split_once(char::is_whitespace) else { continue };
        let key = key.to_lowercase();
        let value = rest.trim();
        if let Some(kind) = key.strip_suffix("forward").filter(|kind| matches!(*kind, "local" | "remote" | "dynamic")) {
            forwards.push(format!("{kind} {value}"));
        }
        values.entry(key).or_insert_with(|| value.to_owned());
    }
    let hostname = values.get("hostname").filter(|name| !name.is_empty())?.clone();
    let port = match values.get("port") {
        Some(text) => text.parse::<u16>().ok()?,
        None => 22,
    };
    let files = |list: &str| split_paths(list).into_iter().filter(|file| file != "none").collect::<Vec<_>>();
    let proxy_jump = values.get("proxyjump").filter(|jump| !jump.is_empty() && *jump != "none").cloned();
    let proxy_command = values.get("proxycommand").is_some_and(|command| !command.is_empty() && command != "none");
    let program_data = env.var("ProgramData").or_else(|| env.var("ALLUSERSPROFILE")).unwrap_or(r"C:\ProgramData");
    let global = files(values.get("globalknownhostsfile").map_or("", String::as_str))
        .into_iter()
        .map(|file| match file.strip_prefix("__PROGRAMDATA__") {
            Some(rest) => format!("{program_data}{rest}"),
            None => file,
        })
        .collect();
    let algorithms: Vec<&str> = values.get("hostkeyalgorithms").map_or("", String::as_str).split(',').filter(|name| !name.is_empty()).collect();
    forwards.truncate(MAX_FORWARDS);
    Some(ResolvedHost {
        hostname,
        port,
        user: values.get("user").cloned(),
        known_hosts_files: files(values.get("userknownhostsfile").map_or("~/.ssh/known_hosts", String::as_str)).into_iter().map(|file| expand_home(env, &file)).collect(),
        global_known_hosts_files: global,
        host_key_algorithms: normalize_algorithms(&algorithms),
        proxied: proxy_jump.is_some() || proxy_command,
        proxy_jump,
        proxy_command,
        forwards,
    })
}

fn error(message: impl Into<String>) -> SshError {
    SshError::new(message, FailureClass::Transient)
}

fn said(said: mixdog_app_protocol::message::Said) -> SshError {
    SshError::said(said, FailureClass::Transient)
}

fn state_error(failure: crate::pins::StateError) -> SshError {
    said(failure.said())
}

/// Runs one OpenSSH tool to the end, writing the run to the attempt's diagnostics ring. A tool that is not
/// installed fails with the message the connect dialog explains.
async fn run_tool(env: &SshEnv, ctx: &AttemptContext, name: &str, args: &[String], timeout: Duration) -> Result<ToolOutput, SshError> {
    let command = ssh_tool_command(name, env);
    env.diagnostics.record(ctx.diagnostics_key.as_deref(), DiagnosticKind::Ssh, &describe_argv(name, args), now_ms());
    env.tools.run(&command, args, timeout).await.map_err(|failure| {
        if failure.kind() == std::io::ErrorKind::NotFound { error(missing_client_message(name)) } else { error(format!("{name} failed to start: {failure}")) }
    })
}

/// `ssh -G` of one destination.
pub async fn resolve_host(env: &SshEnv, ctx: &AttemptContext, destination: &SshTarget) -> Result<ResolvedHost, SshError> {
    resolve_dump(env, ctx, destination).await.map(|(_, host)| host)
}

/// `ssh -G` of one destination: what it printed, and the host read from it.
async fn resolve_dump(env: &SshEnv, ctx: &AttemptContext, destination: &SshTarget) -> Result<(String, ResolvedHost), SshError> {
    let mut args = vec!["-G".to_owned()];
    if let Some(port) = destination.port {
        args.extend(["-p".to_owned(), port.to_string()]);
    }
    args.extend(["--".to_owned(), destination.destination.clone()]);
    let dump = run_tool(env, ctx, "ssh", &args, TOOL_TIMEOUT).await?;
    let host = if dump.exit_code == Some(0) { parse_ssh_config_dump(&dump.stdout, env) } else { None };
    match host {
        Some(host) => Ok((dump.stdout, host)),
        None => {
            let reason = dump.stderr.trim();
            Err(if reason.is_empty() { said(crate::said::SSH_CONFIG_UNREADABLE.plain()) } else { error(reason) })
        }
    }
}

fn summarize(host: &ResolvedHost) -> SshConfigSummary {
    SshConfigSummary {
        host_name: host.hostname.clone(),
        user: host.user.clone(),
        port: host.port,
        proxy_jump: host.proxy_jump.clone(),
        proxy_command: host.proxy_command,
        forwards: None,
    }
}

/// Key(s) to save once the user confirms an unknown key: the keys this server accepts, each held in its name. There is no pin
/// without an owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    pub file: PathBuf,
    pub claims: Vec<Claim>,
    /// The entries for every endpoint of the route in the known_hosts files its ssh consults, as the user was shown them: the
    /// commit reads those files again and is refused unless the entries for each endpoint are unchanged, also for an endpoint it
    /// writes nothing for (a hop trusted through the user's own file), so a key revoked since the inspection is never saved.
    pub shown: Vec<EndpointTrust>,
}

impl Pin {
    pub fn new(file: PathBuf, claims: Vec<Claim>, shown: Vec<EndpointTrust>) -> Self {
        Self { file, claims, shown }
    }

    /// The known_hosts lines this pin writes, as the user's file would show them.
    pub fn text(&self) -> String {
        self.claims.iter().map(Claim::line).collect::<Vec<_>>().join("\n")
    }
}

/// A changed key: what replacing it removes and then pins (after the user typed the host name).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replace {
    pub spec: String,
    pub file: PathBuf,
    /// The new key, held in the name of the server that confirms the replacement (the old pin keeps its mark as written).
    pub claim: Claim,
    pub host: String,
    /// The key the user reviewed being replaced (base64 of the pin's blob, with `claim.key_type`): the commit replaces exactly
    /// that pin, so a pin another desktop already rotated is not overwritten.
    pub old_key: String,
    /// See [`Pin::shown`].
    pub shown: Vec<EndpointTrust>,
}

impl Replace {
    pub fn line(&self) -> String {
        self.claim.line()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HostKeyInspection {
    /// Every server on the way (each ProxyJump hop, then the target); empty when the route could not be read.
    pub hops: Vec<HopKey>,
    pub check: HostKeyCheck,
    pub pin: Option<Pin>,
    pub replace: Option<Replace>,
    pub summary: Option<SshConfigSummary>,
    /// The config the files were judged by, published for the target: the attempt's ssh runs with it. None where no config
    /// was prepared (the server could not be read, or no configs were given).
    pub reviewed: Option<ReviewedConfig>,
}

/// What a through-the-proxy read of one server may do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanScope {
    /// The jump hosts to dial through instead of the configured route: the hops before the one being read (already
    /// trusted). None: the configured route.
    pub via: Option<Vec<String>>,
    /// The host name ssh resolves the server to; its login is switched off and its key accepted unseen. `*`: the
    /// whole route (a ProxyCommand).
    pub open: String,
    /// known_hosts lines of the hops already trusted, so a changed key on the way stops the read.
    pub trusted: Option<String>,
}

/// What a through-the-proxy read found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanOutput {
    pub entries: Vec<KnownHostEntry>,
    /// What ssh reported on stderr.
    pub error: String,
}

fn safe_host(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "._:%[]-".contains(c))
}

/// A folder only this user can use, for the throwaway ssh config. ssh starts the jump host's own ssh with
/// `-F <that config>` as one unquoted word, so on Windows a temp folder under a profile like "John Doe" breaks it:
/// such a PC gets a random folder under a per-user ProgramData folder, locked to the user (Windows OpenSSH refuses a
/// config that other accounts can write). Any other temp folder gets a plain `mkdtemp`-style subfolder, with no
/// second lock run: the temp folder is already the user's own.
async fn private_scan_dir(env: &SshEnv) -> std::io::Result<PathBuf> {
    let tmp = ["TMPDIR", "TMP", "TEMP"].iter().find_map(|name| env.var(name).filter(|value| !value.is_empty())).map_or_else(std::env::temp_dir, PathBuf::from);
    if !env.platform.is_windows() || !tmp.to_string_lossy().contains(char::is_whitespace) {
        return make_temp_dir(&tmp, "mxk-");
    }
    let user: String = account(env)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let root = PathBuf::from(join_name(env.platform, env.var("ProgramData").unwrap_or(r"C:\ProgramData"), &format!("mixdog-ssh-scan-{user}")));
    create_private_dir(env, &root, "mxk-").await
}

/// Reads the key of one server behind ProxyJump / ProxyCommand: ssh dials through the route with a throwaway
/// known_hosts. The server being read gets no login at all (no authentication method, no keys, no passwords) and its
/// key is accepted unseen so it can be recorded; every hop on the way is checked strictly against the keys already
/// trusted. The remote command is a plain `true`, and nothing is trusted until the user confirms.
pub async fn scan_through_ssh(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, scope: &ScanScope) -> Result<ScanOutput, SshError> {
    if scope.open != "*" && !safe_host(&scope.open) {
        return Err(said(crate::said::PROXY_HOST_UNREADABLE.plain()));
    }
    let dir = private_scan_dir(env).await.map_err(|failure| error(failure.to_string()))?;
    let outcome = scan_in(env, ctx, target, scope, &dir).await;
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    outcome
}

async fn scan_in(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, scope: &ScanScope, dir: &Path) -> Result<ScanOutput, SshError> {
    let write = |path: &Path, text: String| mixdog_fsio::write(&Unlaned, path, text).map_err(|failure| error(failure.to_string()));
    let known = dir.join("known_hosts");
    let config = dir.join("config");
    write(&known, scope.trusted.as_ref().map_or_else(String::new, |trusted| format!("{trusted}\n")))?;
    let no_login = [
        "  PreferredAuthentications none",
        "  PubkeyAuthentication no",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  StrictHostKeyChecking no",
    ];
    let head = if scope.open == "*" { "Host *".to_owned() } else { format!("Match host \"{}\"", scope.open) };
    let mut lines: Vec<String> = vec![head];
    lines.extend(no_login.iter().map(|line| (*line).to_owned()));
    lines.extend(["Host *".to_owned(), format!("  UserKnownHostsFile {}", word(&known.to_string_lossy()))]);
    lines.extend(
        ["  GlobalKnownHostsFile none", "  StrictHostKeyChecking yes", "  HashKnownHosts no", "  BatchMode yes", "  ForwardAgent no", "  ClearAllForwardings yes", "  LogLevel ERROR", ""]
            .iter()
            .map(|line| (*line).to_owned()),
    );
    lines.push(format!("Include {}", word(&env.home.join(".ssh").join("config").to_string_lossy())));
    lines.push(String::new());
    write(&config, lines.join("\n"))?;
    let mut args = vec!["-F".to_owned(), config.to_string_lossy().into_owned(), "-o".to_owned(), "ConnectTimeout=10".to_owned()];
    if let Some(via) = &scope.via {
        args.extend(["-o".to_owned(), format!("ProxyJump={}", if via.is_empty() { "none".to_owned() } else { via.join(",") })]);
    }
    args.push("-T".to_owned());
    if let Some(port) = target.port {
        args.extend(["-p".to_owned(), port.to_string()]);
    }
    args.extend(["--".to_owned(), target.destination.clone(), "true".to_owned()]);
    let result = run_tool(env, ctx, "ssh", &args, PROXY_SCAN_TIMEOUT).await?;
    let text = mixdog_fsio::read(&Unlaned, &known).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
    Ok(ScanOutput { entries: parse(&text), error: result.stderr.trim().to_owned() })
}

struct Endpoint {
    /// What ssh is told to dial (a ProxyJump entry as written, or the target).
    dest: SshTarget,
    part: String,
    name: String,
    role: SshHopRole,
    host: ResolvedHost,
    spec: String,
    /// The entries for this endpoint in the files its own ssh consults: it is judged by these alone.
    trust: EndpointTrust,
}

enum Verdict {
    Trusted { authority: Option<String> },
    Unreadable,
    Pending,
    Revoked { fingerprint: String, key_type: String },
    Unknown { best: HostKeyLine },
    Changed { old: KnownEntry, current: HostKeyLine },
}

fn judge(endpoint: &Endpoint, scanned: &[HostKeyLine]) -> Verdict {
    let configured: Vec<&str> = endpoint.host.host_key_algorithms.iter().map(String::as_str).collect();
    let order: &[&str] = if configured.is_empty() { &DEFAULT_ALGORITHM_ORDER } else { &configured };
    let rank = |key_type: &str| order.iter().position(|candidate| *candidate == key_type).unwrap_or(order.len());
    let mut by_rank: Vec<&HostKeyLine> = scanned.iter().collect();
    by_rank.sort_by_key(|line| rank(&line.key_type));
    let matching = &endpoint.trust.entries;
    let plain: Vec<&KnownEntry> = matching.iter().filter(|candidate| candidate.entry.marker == KnownHostMarker::None).collect();
    let Some(first) = by_rank.first().copied() else {
        return if plain.is_empty() { Verdict::Unreadable } else { Verdict::Trusted { authority: None } };
    };
    // ssh refuses a revoked key whatever else it knows about the server.
    if let Some(revoked) = by_rank.iter().copied().find(|line| matching.iter().any(|candidate| candidate.entry.marker == KnownHostMarker::Revoked && candidate.entry.key == line.key)) {
        return Verdict::Revoked { fingerprint: key_fingerprint(&revoked.key), key_type: key_type_label(&revoked.key_type) };
    }
    if by_rank.iter().any(|line| plain.iter().any(|candidate| candidate.entry.key_type == line.key_type && candidate.entry.key == line.key)) {
        return Verdict::Trusted { authority: None };
    }
    for line in by_rank.iter().copied() {
        if let Some(old) = plain.iter().copied().find(|candidate| candidate.entry.key_type == line.key_type) {
            return Verdict::Changed { old: old.clone(), current: line.clone() };
        }
    }
    if plain.is_empty()
        && let Some(authority) = matching.iter().find(|candidate| candidate.entry.marker == KnownHostMarker::CertAuthority)
    {
        return Verdict::Trusted { authority: Some(key_fingerprint(&authority.entry.key)) };
    }
    Verdict::Unknown { best: first.clone() }
}

/// What a failed read of the host key says: ssh-keyscan's lines without its `#` banners, each once. It dials once per key type,
/// so a server that is down reports the same line for every type.
fn scan_failure_lines(scan_error: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in scan_error.lines().filter(|line| !line.starts_with('#')) {
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    lines.join("\n")
}

#[cfg(test)]
#[path = "host_key_lines_tests.rs"]
mod host_key_lines_tests;

fn unreachable(env: &SshEnv, text: &str, summary: Option<SshConfigSummary>) -> HostKeyInspection {
    unreachable_said(env, text, None, summary)
}

fn unreachable_said(env: &SshEnv, text: &str, notice: Option<SshMessage>, summary: Option<SshConfigSummary>) -> HostKeyInspection {
    let ssh_missing = is_missing_message(text).then(|| SshMissing { command: client_install_command(env.platform).map(str::to_owned) });
    HostKeyInspection {
        hops: Vec::new(),
        check: HostKeyCheck::Unreachable { message: text.to_owned(), notice, ssh_missing },
        pin: None,
        replace: None,
        summary,
        reviewed: None,
    }
}

fn keyscan_types(algorithms: &[String]) -> String {
    let mut wanted: Vec<&str> = Vec::new();
    for key_type in algorithms {
        let kind = if key_type == "ssh-ed25519" {
            "ed25519"
        } else if key_type.starts_with("ecdsa-") {
            "ecdsa"
        } else if key_type == "ssh-rsa" {
            "rsa"
        } else {
            continue;
        };
        if !wanted.contains(&kind) {
            wanted.push(kind);
        }
    }
    if wanted.is_empty() { "ed25519,ecdsa,rsa".to_owned() } else { wanted.join(",") }
}

/// Reads the keys servers present: a plain ssh-keyscan, or one server through the route.
struct Scanner<'a> {
    env: &'a SshEnv,
    ctx: &'a AttemptContext,
    /// What the last read reported on stderr, or why it failed.
    error: String,
}

impl Scanner<'_> {
    /// The keys a plain ssh-keyscan of the server returns.
    async fn keyscan(&mut self, endpoint: &Endpoint) -> Vec<HostKeyLine> {
        let args: Vec<String> = [
            "-T".to_owned(),
            "8".to_owned(),
            "-p".to_owned(),
            endpoint.host.port.to_string(),
            "-t".to_owned(),
            keyscan_types(&endpoint.host.host_key_algorithms),
            "--".to_owned(),
            endpoint.host.hostname.clone(),
        ]
        .into();
        match run_tool(self.env, self.ctx, "ssh-keyscan", &args, SCAN_TIMEOUT).await {
            Ok(scan) => {
                self.error = scan.stderr.trim().to_owned();
                parse_key_lines(&scan.stdout)
            }
            Err(failure) => {
                self.error = failure.message;
                Vec::new()
            }
        }
    }

    /// Reads one server through the route, keeping only the entries for it.
    async fn read_through(&mut self, endpoint: &Endpoint, scope: &ScanScope) -> Vec<HostKeyLine> {
        match scan_through_ssh(self.env, self.ctx, &endpoint.dest, scope).await {
            Ok(scan) => {
                self.error = scan.error;
                scan.entries
                    .into_iter()
                    .filter(|entry| entry.marker == KnownHostMarker::None && host_field_matches(&entry.hosts, &endpoint.spec))
                    .map(|entry| HostKeyLine { hosts: endpoint.spec.clone(), key_type: entry.key_type, key: entry.key })
                    .collect()
            }
            Err(failure) => {
                self.error = failure.message;
                Vec::new()
            }
        }
    }
}

fn marker_prefix(marker: KnownHostMarker) -> &'static str {
    match marker {
        KnownHostMarker::None => "",
        KnownHostMarker::Revoked => "@revoked ",
        KnownHostMarker::CertAuthority => "@cert-authority ",
    }
}

/// The keys each server presents, by known_hosts spec; the returned set holds the endpoints left for the next check.
async fn scan_endpoints(endpoints: &[Endpoint], host: &ResolvedHost, scanner: &mut Scanner<'_>) -> (BTreeMap<String, Vec<HostKeyLine>>, Vec<usize>) {
    let mut scanned: BTreeMap<String, Vec<HostKeyLine>> = BTreeMap::new();
    let mut unread: Vec<usize> = Vec::new();
    if !host.proxied {
        let lines = scanner.keyscan(&endpoints[0]).await;
        scanned.insert(endpoints[0].spec.clone(), lines);
    } else if host.proxy_jump.is_none() {
        // ProxyCommand: the whole route is the target's, and nothing logs in to it.
        let lines = scanner.read_through(&endpoints[0], &ScanScope { via: None, open: "*".to_owned(), trusted: None }).await;
        scanned.insert(endpoints[0].spec.clone(), lines);
    } else {
        // ProxyJump, hop by hop: a server is read through the hops before it only once they are trusted (their keys
        // are checked strictly on the way, and no login is made to the server being read). The first hop that needs
        // the user's confirmation ends the reading; the ones behind it wait for the next check.
        for (index, endpoint) in endpoints.iter().enumerate() {
            let trusted = endpoints[..index]
                .iter()
                .flat_map(|earlier| &earlier.trust.entries)
                .map(|candidate| format!("{}{} {} {}", marker_prefix(candidate.entry.marker), candidate.entry.hosts, candidate.entry.key_type, candidate.entry.key))
                .collect::<Vec<_>>()
                .join("\n");
            let lines = if index == 0 && !endpoint.host.proxied {
                scanner.keyscan(endpoint).await
            } else {
                let scope = ScanScope {
                    open: endpoint.host.hostname.clone(),
                    via: (index > 0).then(|| endpoints[..index].iter().map(|earlier| earlier.part.clone()).collect()),
                    trusted: Some(trusted).filter(|lines| !lines.is_empty()),
                };
                scanner.read_through(endpoint, &scope).await
            };
            scanned.insert(endpoint.spec.clone(), lines);
            let settled = scanned.get(&endpoint.spec).map_or(&[][..], Vec::as_slice);
            if !matches!(judge(endpoint, settled), Verdict::Trusted { .. }) {
                unread.extend(index + 1..endpoints.len());
                break;
            }
        }
    }
    (scanned, unread)
}

/// What each server on the way shows the user.
fn hop_keys(endpoints: &[Endpoint], verdicts: &[Verdict]) -> Vec<HopKey> {
    endpoints
        .iter()
        .zip(verdicts)
        .map(|(endpoint, verdict)| {
            let (status, fingerprint, key_type) = match verdict {
                Verdict::Unknown { best } => (SshHopStatus::Unknown, Some(key_fingerprint(&best.key)), Some(key_type_label(&best.key_type))),
                Verdict::Changed { current, .. } => (SshHopStatus::Changed, Some(key_fingerprint(&current.key)), Some(key_type_label(&current.key_type))),
                Verdict::Revoked { fingerprint, key_type } => (SshHopStatus::Revoked, Some(fingerprint.clone()), Some(key_type.clone())),
                Verdict::Unreadable => (SshHopStatus::Unreadable, None, None),
                Verdict::Pending => (SshHopStatus::Pending, None, None),
                Verdict::Trusted { .. } => (SshHopStatus::Trusted, None, None),
            };
            HopKey { name: endpoint.name.clone(), role: endpoint.role, status, fingerprint, key_type }
        })
        .collect()
}

/// The entries for each endpoint in the files its ssh consults, each file read once: Mixdog's own file and the endpoint's own
/// resolved ones (what the config written for the attempt names for it), or the user's alone where Mixdog has no folder, and the
/// endpoint's system-wide files.
fn fill_trust(env: &SshEnv, endpoints: &mut [Endpoint], own: Option<&Path>) {
    let mut texts: BTreeMap<PathBuf, Option<String>> = BTreeMap::new();
    for endpoint in endpoints {
        let host = &endpoint.host;
        let user: Vec<PathBuf> = own.map(Path::to_path_buf).into_iter().chain(host.known_hosts_files.iter().map(PathBuf::from)).collect();
        let global: Vec<PathBuf> = host.global_known_hosts_files.iter().map(PathBuf::from).collect();
        let listed = EndpointTrust { spec: endpoint.spec.clone(), user, global, entries: Vec::new() };
        for file in listed.files() {
            texts.entry(file.clone()).or_insert_with(|| env.files.read_text(&file));
        }
        endpoint.trust = EndpointTrust::of(&listed.spec, listed.user, listed.global, own, |file| texts.get(file).cloned().flatten());
    }
}

/// The ProxyJump entries of a server, as written and without `ssh://`.
fn jump_parts(host: &ResolvedHost) -> Vec<(String, String)> {
    let Some(jump) = &host.proxy_jump else { return Vec::new() };
    jump.split(',').map(str::trim).map(|written| (written.to_owned(), written.strip_prefix("ssh://").unwrap_or(written).to_owned())).collect()
}

/// `ssh -G` of the route, once: the target, every ProxyJump hop of it (the inspection reads each one, so one that cannot be read
/// fails it), then the hops behind those (only a config written out needs them; one that cannot be read leaves the route
/// incomplete).
pub(crate) async fn resolve_route(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget) -> Result<Route, SshError> {
    let (dump, host) = resolve_dump(env, ctx, target).await?;
    let mut route = Route { blocks: vec![Block::new(target.clone(), &dump, host)], complete: true };
    let jump_host = |written: &str, reason: &str| error(format!("The jump host {written} could not be read: {reason}"));
    for (written, bare) in jump_parts(&route.blocks[0].host) {
        let hop = parse_ssh_target(&bare).map_err(|failure| jump_host(&written, &failure.0))?;
        if route.holds(&hop) {
            continue;
        }
        let (dump, host) = resolve_dump(env, ctx, &hop).await.map_err(|failure| jump_host(&written, &failure.message))?;
        route.blocks.push(Block::new(hop, &dump, host));
    }
    let mut pending: Vec<String> = route.blocks[1..].iter().flat_map(|block| jump_parts(&block.host)).map(|(_, bare)| bare).collect();
    while let Some(bare) = pending.pop() {
        let Ok(hop) = parse_ssh_target(&bare) else {
            route.complete = false;
            break;
        };
        if route.holds(&hop) {
            continue;
        }
        let read = if route.is_full() { None } else { resolve_dump(env, ctx, &hop).await.ok() };
        let Some((dump, host)) = read else {
            route.complete = false;
            break;
        };
        pending.extend(jump_parts(&host).into_iter().map(|(_, bare)| bare));
        route.blocks.push(Block::new(hop, &dump, host));
    }
    Ok(route)
}

/// Every server on the way (each ProxyJump hop, then the target), as the route resolved them.
fn route_endpoints(target: &SshTarget, route: &Route) -> Vec<Endpoint> {
    let host = &route.blocks[0].host;
    let mut endpoints = Vec::new();
    for (written, bare) in jump_parts(host) {
        let Some((hop, resolved)) = parse_ssh_target(&bare).ok().and_then(|hop| route.host_of(&hop).cloned().map(|resolved| (hop, resolved))) else { continue };
        let spec = known_hosts_spec(&resolved.hostname, resolved.port);
        endpoints.push(Endpoint { dest: hop, part: bare, name: written, role: SshHopRole::Jump, host: resolved, spec, trust: EndpointTrust::default() });
    }
    endpoints.push(Endpoint {
        dest: target.clone(),
        part: target.display.clone(),
        name: target.label().to_owned(),
        role: SshHopRole::Target,
        host: host.clone(),
        spec: known_hosts_spec(&host.hostname, host.port),
        trust: EndpointTrust::default(),
    });
    endpoints
}

fn default_known_hosts(env: &SshEnv) -> String {
    join_name(env.platform, &join_name(env.platform, &env.home.to_string_lossy(), ".ssh"), "known_hosts")
}

/// What a changed key's replacement needs to know.
struct RotationOf<'a> {
    env: &'a SshEnv,
    own: Option<&'a Path>,
    /// The server that confirms the replacement.
    owner: &'a str,
    /// The entries for every endpoint of the route in the files its ssh consults, as the user was shown them.
    shown: &'a [EndpointTrust],
}

/// The inspection of a server whose key differs from the one known; replaceable only when the old key is one unambiguous pin
/// Mixdog wrote in its own known_hosts (no entry of the user's, no hashed, wildcard or listed entry names the endpoint too).
fn changed_inspection(rotation: &RotationOf<'_>, old: &KnownEntry, current: &HostKeyLine, endpoint: &Endpoint, chain: Option<Vec<HopKey>>) -> (HostKeyCheck, Option<Replace>) {
    let (env, own_file) = (rotation.env, rotation.own);
    let spec = &endpoint.spec;
    let file_option = if old.file == Path::new(&default_known_hosts(env)) { String::new() } else { format!(" -f \"{}\"", old.file.display()) };
    let held = if own_file == Some(old.file.as_path()) { env.files.read_text(&old.file) } else { None };
    let editable = held.as_deref().is_some_and(|text| can_rotate(text.as_bytes(), spec, &current.key_type));
    let check = HostKeyCheck::Changed {
        previous: key_fingerprint(&old.entry.key),
        current: key_fingerprint(&current.key),
        key_type: key_type_label(&current.key_type),
        host: endpoint.host.hostname.clone(),
        remove_command: format!("ssh-keygen -R \"{spec}\"{file_option}"),
        replaceable: editable,
        hops: chain,
    };
    let replace = editable.then(|| Replace {
        spec: spec.clone(),
        file: old.file.clone(),
        claim: Claim::new(rotation.owner.to_owned(), spec.clone(), current.key_type.clone(), current.key.clone()),
        host: endpoint.host.hostname.clone(),
        old_key: old.entry.key.clone(),
        shown: rotation.shown.to_vec(),
    });
    (check, replace)
}

/// Compares the key(s) a server presents with what is known, using Mixdog's own known_hosts (see
/// [`MixdogSshConfig::current`]) as the file pins go to.
///
/// The route is resolved once; the servers are judged by the files each one's ssh consults under it. Only once the server could be
/// read is the config the attempt runs with written from that same route (and named in the inspection), and the user's files
/// registered with the generic config: nothing is written for a server that is unreachable.
pub async fn inspect_host_key(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, configs: &ResolvedConfigs) -> Result<HostKeyInspection, SshError> {
    inspect_with(env, ctx, target, MixdogSshConfig::current(), Some(configs)).await
}

/// A failure of this PC's own ssh state, said by code: shown the way an unreadable server is, never as bare text.
fn state_unreachable(env: &SshEnv, failure: &SshError, summary: Option<SshConfigSummary>) -> HostKeyInspection {
    unreachable_said(env, &failure.message, failure.notice.as_deref().cloned(), summary)
}

async fn inspect_with(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, own: Option<Arc<MixdogSshConfig>>, configs: Option<&ResolvedConfigs>) -> Result<HostKeyInspection, SshError> {
    // Read before the route, so the config written from it is the user's config the route was resolved through, or older.
    let user_config = env.files.read_text(&env.home.join(".ssh").join("config"));
    let route = match resolve_route(env, ctx, target).await {
        Ok(route) => route,
        Err(failure) => return Ok(unreachable_said(env, &failure.message, failure.notice.as_deref().cloned(), None)),
    };
    let mut inspection = judge_route(env, ctx, target, own.as_deref(), &route).await?;
    let Some(configs) = configs else { return Ok(inspection) };
    if matches!(inspection.check, HostKeyCheck::Unreachable { .. }) {
        return Ok(inspection);
    }
    let not_updated = |failure: std::io::Error| said(crate::said::SSH_SETTINGS_NOT_UPDATED.said([("error", failure.to_string())]));
    // The generic config, which an ssh of no inspection (a restore) runs with, also reads the user's files of the route.
    if let Some(config) = own.as_deref() {
        let user_files: Vec<String> = route.blocks.iter().flat_map(|block| block.host.known_hosts_files.iter().cloned()).collect();
        if let Err(failure) = config.register_user_known_hosts(&user_files).await {
            return Ok(state_unreachable(env, &not_updated(failure), inspection.summary));
        }
    }
    match configs.write_reviewed(env, ctx, target, &route, user_config.as_deref()).await {
        Ok((reviewed, forwards)) => {
            // Where the route's own options could not be written out, the user's config and its forwards apply: they are listed.
            if let Some(summary) = inspection.summary.as_mut().filter(|_| !forwards.is_empty()) {
                summary.forwards = Some(forwards);
            }
            inspection.reviewed = Some(reviewed);
        }
        Err(failure) => return Ok(state_unreachable(env, &not_updated(failure), inspection.summary)),
    }
    Ok(inspection)
}

/// The verdict on the route read.
async fn judge_route(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, own: Option<&MixdogSshConfig>, route: &Route) -> Result<HostKeyInspection, SshError> {
    let owner = owner_of(target);
    let host = &route.blocks[0].host;
    let summary = Some(summarize(host));
    let own_file = own.map(MixdogSshConfig::known_hosts_file);
    let mut endpoints = route_endpoints(target, route);
    fill_trust(env, &mut endpoints, own_file);
    let shown: Vec<EndpointTrust> = endpoints.iter().map(|endpoint| endpoint.trust.clone()).collect();

    let mut scanner = Scanner { env, ctx, error: String::new() };
    let (scanned, unread) = scan_endpoints(&endpoints, host, &mut scanner).await;
    let scan_error = scanner.error;
    let verdicts: Vec<Verdict> = endpoints
        .iter()
        .enumerate()
        .map(|(index, endpoint)| if unread.contains(&index) { Verdict::Pending } else { judge(endpoint, scanned.get(&endpoint.spec).map_or(&[][..], Vec::as_slice)) })
        .collect();
    let hops = hop_keys(&endpoints, &verdicts);
    let chain = (endpoints.len() > 1).then(|| hops.clone());
    let done = |check: HostKeyCheck, pin: Option<Pin>, replace: Option<Replace>| HostKeyInspection { hops: hops.clone(), check, pin, replace, summary: summary.clone(), reviewed: None };

    if let Some((index, Verdict::Revoked { fingerprint, .. })) = verdicts.iter().enumerate().find(|(_, verdict)| matches!(verdict, Verdict::Revoked { .. })) {
        return Ok(done(HostKeyCheck::Revoked { fingerprint: fingerprint.clone(), host: endpoints[index].host.hostname.clone() }, None, None));
    }
    if let Some((index, Verdict::Changed { old, current })) = verdicts.iter().enumerate().find(|(_, verdict)| matches!(verdict, Verdict::Changed { .. })) {
        let rotation = RotationOf { env, own: own_file, owner: &owner, shown: &shown };
        let (check, replace) = changed_inspection(&rotation, old, current, &endpoints[index], chain);
        return Ok(done(check, None, replace));
    }
    if let Some(index) = verdicts.iter().position(|verdict| matches!(verdict, Verdict::Unreadable)) {
        let detail = scan_failure_lines(&scan_error);
        let detail = detail.trim();
        let name = if endpoints.len() > 1 { endpoints[index].name.as_str() } else { target.display.as_str() };
        let message = if detail.is_empty() { format!("Could not read the host key of {name}.") } else { detail.to_owned() };
        return Ok(unreachable(env, &message, summary));
    }
    let unknown: Vec<(&HostKeyLine, &str)> = verdicts
        .iter()
        .zip(&endpoints)
        .filter_map(|(verdict, endpoint)| match verdict {
            Verdict::Unknown { best } => Some((best, endpoint.spec.as_str())),
            _ => None,
        })
        .collect();
    if let Some((key, _)) = unknown.last() {
        let check = HostKeyCheck::Unknown { fingerprint: key_fingerprint(&key.key), key_type: key_type_label(&key.key_type), hops: chain };
        // The keys asked to be confirmed. Without Mixdog's own known_hosts nothing is ever written into the user's file: the key is
        // shown and cannot be confirmed.
        let claims = unknown.iter().map(|(line, spec)| Claim::new(owner.clone(), (*spec).to_owned(), line.key_type.clone(), line.key.clone())).collect();
        let pin = own.map(|config| Pin::new(config.known_hosts_file().to_path_buf(), claims, shown));
        return Ok(done(check, pin, None));
    }
    let authority = verdicts.iter().find_map(|verdict| match verdict {
        Verdict::Trusted { authority } => authority.clone(),
        _ => None,
    });
    Ok(done(HostKeyCheck::Trusted { authority, hops: chain }, None, None))
}

/// Writes the confirmed keys to Mixdog's known_hosts as one transaction, refused when the entries for an endpoint of the route in
/// the files its ssh consults are no longer the ones the user was shown.
pub async fn pin_host_key(inspection: &HostKeyInspection) -> Result<(), SshError> {
    let pin = inspection.pin.as_ref().ok_or_else(|| said(crate::said::NO_KEY_TO_SAVE.plain()))?;
    commit_claims(&pin.file, pin.shown.clone(), pin.claims.clone()).await.map_err(state_error)
}

/// Replaces the changed key of a pin in place (never with `ssh-keygen -R`, which would remove every entry that names the host,
/// hashed ones included). The old key must be one unambiguous pin Mixdog wrote; otherwise the entry is for the user to review.
pub async fn replace_host_key(inspection: &HostKeyInspection) -> Result<(), SshError> {
    let replace = inspection.replace.as_ref().ok_or_else(|| said(crate::said::NO_KEY_TO_REPLACE.plain()))?;
    rotate_claim(&replace.file, replace.shown.clone(), replace.claim.clone(), replace.old_key.clone()).await.map_err(state_error)
}

#[cfg(test)]
#[path = "host_key_tests.rs"]
mod host_key_tests;
