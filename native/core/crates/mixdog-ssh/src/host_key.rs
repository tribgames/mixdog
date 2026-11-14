//! Host-key pre-check. The ssh options used for the real connection check host keys strictly
//! (`StrictHostKeyChecking=yes`), so a new key can only get into known_hosts through this module: before the first
//! connection the server's key (and the key of every ProxyJump hop on the way) is read, compared with Mixdog's own,
//! the user's and the system-wide known_hosts, and shown. The connection only follows once the user has confirmed a
//! new key, and that exact key is written to known_hosts first, so ssh then checks the server against what was shown.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mixdog_app_protocol::v2::connections::{SshConfigSummary, SshHopKey, SshHopRole, SshHopStatus, SshHostKeyCheck, SshMissing};
use mixdog_fsio::Unlaned;
use regex::Regex;

use crate::binary::{client_install_command, is_missing_message, missing_client_message, ssh_tool_command};
use crate::command::{parse_ssh_target, FailureClass, SshError, SshTarget};
use crate::context::{AttemptContext, SshEnv, ToolOutput};
use crate::diagnostics::{describe_argv, DiagnosticKind};
use crate::known_hosts::{host_field_matches, key_fingerprint, known_hosts_spec, parse, KnownHostEntry, KnownHostMarker};
use crate::mixdog_config::{append_text, word, MixdogSshConfig};
use crate::private_dir::{create_private_dir, join_name};

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

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn error(message: impl Into<String>) -> SshError {
    SshError::new(message, FailureClass::Transient)
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
    let mut args = vec!["-G".to_owned()];
    if let Some(port) = destination.port {
        args.extend(["-p".to_owned(), port.to_string()]);
    }
    args.extend(["--".to_owned(), destination.destination.clone()]);
    let dump = run_tool(env, ctx, "ssh", &args, TOOL_TIMEOUT).await?;
    let host = if dump.exit_code == Some(0) { parse_ssh_config_dump(&dump.stdout, env) } else { None };
    host.ok_or_else(|| {
        let reason = dump.stderr.trim();
        error(if reason.is_empty() { "ssh could not read its configuration for this address." } else { reason })
    })
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

/// Key(s) to save once the user confirms an unknown key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    /// One known_hosts line per server whose key is shown (newline separated).
    pub line: String,
    pub file: PathBuf,
}

/// A changed key: what replacing it removes and then pins (after the user typed the host name).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Replace {
    pub spec: String,
    pub file: PathBuf,
    pub line: String,
    pub host: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HostKeyInspection {
    /// Every server on the way (each ProxyJump hop, then the target); empty when the route could not be read.
    pub hops: Vec<HopKey>,
    pub check: HostKeyCheck,
    pub pin: Option<Pin>,
    pub replace: Option<Replace>,
    pub summary: Option<SshConfigSummary>,
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
/// such a PC gets a random folder under a per-user ProgramData folder. Both are locked to the user (Windows OpenSSH
/// refuses a config that other accounts can write).
async fn private_scan_dir(env: &SshEnv) -> std::io::Result<PathBuf> {
    let tmp = ["TMPDIR", "TMP", "TEMP"].iter().find_map(|name| env.var(name).filter(|value| !value.is_empty())).map_or_else(std::env::temp_dir, PathBuf::from);
    let user: String = ["USERNAME", "USER", "LOGNAME"]
        .iter()
        .find_map(|name| env.var(name).filter(|value| !value.is_empty()))
        .unwrap_or("user")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let name = format!("mixdog-ssh-scan-{user}");
    let root = if env.platform.is_windows() && tmp.to_string_lossy().contains(char::is_whitespace) {
        PathBuf::from(join_name(env.platform, env.var("ProgramData").unwrap_or(r"C:\ProgramData"), &name))
    } else {
        tmp.join(name)
    };
    create_private_dir(env, &root, "mxk-").await
}

/// Reads the key of one server behind ProxyJump / ProxyCommand: ssh dials through the route with a throwaway
/// known_hosts. The server being read gets no login at all (no authentication method, no keys, no passwords) and its
/// key is accepted unseen so it can be recorded; every hop on the way is checked strictly against the keys already
/// trusted. The remote command is a plain `true`, and nothing is trusted until the user confirms.
pub async fn scan_through_ssh(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, scope: &ScanScope) -> Result<ScanOutput, SshError> {
    if scope.open != "*" && !safe_host(&scope.open) {
        return Err(error("The host name cannot be read through a proxy."));
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
}

#[derive(Clone)]
struct KnownEntry {
    entry: KnownHostEntry,
    file: String,
}

fn entries_for<'a>(known: &'a [KnownEntry], spec: &str) -> Vec<&'a KnownEntry> {
    known.iter().filter(|candidate| host_field_matches(&candidate.entry.hosts, spec)).collect()
}

enum Verdict {
    Trusted { authority: Option<String> },
    Unreadable,
    Pending,
    Revoked { fingerprint: String, key_type: String },
    Unknown { best: HostKeyLine },
    Changed { old: KnownEntry, current: HostKeyLine },
}

fn judge(endpoint: &Endpoint, scanned: &[HostKeyLine], known: &[KnownEntry]) -> Verdict {
    let configured: Vec<&str> = endpoint.host.host_key_algorithms.iter().map(String::as_str).collect();
    let order: &[&str] = if configured.is_empty() { &DEFAULT_ALGORITHM_ORDER } else { &configured };
    let rank = |key_type: &str| order.iter().position(|candidate| *candidate == key_type).unwrap_or(order.len());
    let mut by_rank: Vec<&HostKeyLine> = scanned.iter().collect();
    by_rank.sort_by_key(|line| rank(&line.key_type));
    let matching = entries_for(known, &endpoint.spec);
    let plain: Vec<&KnownEntry> = matching.iter().copied().filter(|candidate| candidate.entry.marker == KnownHostMarker::None).collect();
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
    if plain.is_empty() {
        if let Some(authority) = matching.iter().find(|candidate| candidate.entry.marker == KnownHostMarker::CertAuthority) {
            return Verdict::Trusted { authority: Some(key_fingerprint(&authority.entry.key)) };
        }
    }
    Verdict::Unknown { best: first.clone() }
}

fn unreachable(env: &SshEnv, text: &str, summary: Option<SshConfigSummary>) -> HostKeyInspection {
    let ssh_missing = is_missing_message(text).then(|| SshMissing { command: client_install_command(env.platform).map(str::to_owned) });
    HostKeyInspection {
        hops: Vec::new(),
        check: HostKeyCheck::Unreachable { message: text.to_owned(), ssh_missing },
        pin: None,
        replace: None,
        summary,
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
async fn scan_endpoints(endpoints: &[Endpoint], host: &ResolvedHost, known: &[KnownEntry], scanner: &mut Scanner<'_>) -> (BTreeMap<String, Vec<HostKeyLine>>, Vec<usize>) {
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
                .flat_map(|earlier| entries_for(known, &earlier.spec))
                .map(|candidate| format!("{}{} {} {}", marker_prefix(candidate.entry.marker), candidate.entry.hosts, candidate.entry.key_type, candidate.entry.key))
                .collect::<Vec<_>>()
                .join("\n");
            let lines = if index == 0 && !endpoint.host.proxied {
                scanner.keyscan(endpoint).await
            } else {
                let scope = ScanScope {
                    open: endpoint.host.hostname.clone(),
                    via: (index > 0).then(|| endpoints[..index].iter().map(|earlier| earlier.part.clone()).collect()),
                    trusted: Some(trusted),
                };
                scanner.read_through(endpoint, &scope).await
            };
            scanned.insert(endpoint.spec.clone(), lines);
            let settled = scanned.get(&endpoint.spec).map_or(&[][..], Vec::as_slice);
            if !matches!(judge(endpoint, settled, known), Verdict::Trusted { .. }) {
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

/// Every server on the way (each ProxyJump hop, then the target), resolved; or why one could not be read.
async fn route_endpoints(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, host: &ResolvedHost) -> Result<Vec<Endpoint>, String> {
    let mut endpoints = Vec::new();
    if let Some(jump) = &host.proxy_jump {
        for part in jump.split(',') {
            let written = part.trim();
            let bare = written.strip_prefix("ssh://").unwrap_or(written);
            let hop_target = parse_ssh_target(bare).map_err(|failure| format!("The jump host {written} could not be read: {}", failure.0))?;
            let resolved = resolve_host(env, ctx, &hop_target).await.map_err(|failure| format!("The jump host {written} could not be read: {}", failure.message))?;
            let spec = known_hosts_spec(&resolved.hostname, resolved.port);
            endpoints.push(Endpoint { dest: hop_target, part: bare.to_owned(), name: written.to_owned(), role: SshHopRole::Jump, host: resolved, spec });
        }
    }
    endpoints.push(Endpoint {
        dest: target.clone(),
        part: target.display.clone(),
        name: target.label().to_owned(),
        role: SshHopRole::Target,
        host: host.clone(),
        spec: known_hosts_spec(&host.hostname, host.port),
    });
    Ok(endpoints)
}

fn default_known_hosts(env: &SshEnv) -> String {
    join_name(env.platform, &join_name(env.platform, &env.home.to_string_lossy(), ".ssh"), "known_hosts")
}

/// The inspection of a server whose key differs from the one known; replaceable only when the old key is in
/// Mixdog's own known_hosts.
fn changed_inspection(env: &SshEnv, old: &KnownEntry, current: &HostKeyLine, endpoint: &Endpoint, own_file: Option<&str>, chain: Option<Vec<HopKey>>) -> (HostKeyCheck, Option<Replace>) {
    let spec = &endpoint.spec;
    let file_option = if old.file == default_known_hosts(env) { String::new() } else { format!(" -f \"{}\"", old.file) };
    // Only Mixdog's own known_hosts is edited from here; a key in the user's file is theirs to remove.
    let editable = own_file == Some(old.file.as_str());
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
        file: PathBuf::from(&old.file),
        line: format!("{spec} {} {}", current.key_type, current.key),
        host: endpoint.host.hostname.clone(),
    });
    (check, replace)
}

/// Compares the key(s) a server presents with what is known, using Mixdog's own known_hosts (see
/// [`MixdogSshConfig::current`]) as the file pins go to.
pub async fn inspect_host_key(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget) -> Result<HostKeyInspection, SshError> {
    let own = MixdogSshConfig::current();
    inspect_with(env, ctx, target, own.as_deref()).await
}

async fn inspect_with(env: &SshEnv, ctx: &AttemptContext, target: &SshTarget, own: Option<&MixdogSshConfig>) -> Result<HostKeyInspection, SshError> {
    let host = match resolve_host(env, ctx, target).await {
        Ok(host) => host,
        Err(failure) => return Ok(unreachable(env, &failure.message, None)),
    };
    let summary = Some(summarize(&host));
    let endpoints = match route_endpoints(env, ctx, target, &host).await {
        Ok(endpoints) => endpoints,
        Err(reason) => return Ok(unreachable(env, &reason, summary)),
    };

    let own_file = own.map(|config| config.known_hosts_file().to_string_lossy().into_owned());
    let user_files: Vec<String> = endpoints.iter().flat_map(|endpoint| endpoint.host.known_hosts_files.iter().cloned()).collect();
    if let Some(config) = own {
        config.register_user_known_hosts(&user_files).map_err(|failure| error(failure.to_string()))?;
    }
    let mut files: Vec<String> = Vec::new();
    for file in own_file.iter().chain(&user_files).chain(&host.global_known_hosts_files) {
        if !files.contains(file) {
            files.push(file.clone());
        }
    }
    let mut known: Vec<KnownEntry> = Vec::new();
    for file in files {
        if let Some(text) = env.files.read_text(Path::new(&file)).filter(|text| !text.is_empty()) {
            known.extend(parse(&text).into_iter().map(|entry| KnownEntry { entry, file: file.clone() }));
        }
    }

    let mut scanner = Scanner { env, ctx, error: String::new() };
    let (scanned, unread) = scan_endpoints(&endpoints, &host, &known, &mut scanner).await;
    let scan_error = scanner.error;
    let verdicts: Vec<Verdict> = endpoints
        .iter()
        .enumerate()
        .map(|(index, endpoint)| if unread.contains(&index) { Verdict::Pending } else { judge(endpoint, scanned.get(&endpoint.spec).map_or(&[][..], Vec::as_slice), &known) })
        .collect();
    let hops = hop_keys(&endpoints, &verdicts);
    let chain = (endpoints.len() > 1).then(|| hops.clone());
    let done = |check: HostKeyCheck, pin: Option<Pin>, replace: Option<Replace>| HostKeyInspection { hops: hops.clone(), check, pin, replace, summary: summary.clone() };

    if let Some((index, Verdict::Revoked { fingerprint, .. })) = verdicts.iter().enumerate().find(|(_, verdict)| matches!(verdict, Verdict::Revoked { .. })) {
        return Ok(done(HostKeyCheck::Revoked { fingerprint: fingerprint.clone(), host: endpoints[index].host.hostname.clone() }, None, None));
    }
    if let Some((index, Verdict::Changed { old, current })) = verdicts.iter().enumerate().find(|(_, verdict)| matches!(verdict, Verdict::Changed { .. })) {
        let (check, replace) = changed_inspection(env, old, current, &endpoints[index], own_file.as_deref(), chain);
        return Ok(done(check, None, replace));
    }
    if let Some(index) = verdicts.iter().position(|verdict| matches!(verdict, Verdict::Unreadable)) {
        let detail = scan_error.lines().filter(|line| !line.starts_with('#')).collect::<Vec<_>>().join("\n");
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
    if let Some((shown, _)) = unknown.last() {
        let file = own_file.clone().or_else(|| host.known_hosts_files.first().cloned()).unwrap_or_else(|| default_known_hosts(env));
        let check = HostKeyCheck::Unknown { fingerprint: key_fingerprint(&shown.key), key_type: key_type_label(&shown.key_type), hops: chain };
        let line = unknown.iter().map(|(best, spec)| format!("{spec} {} {}", best.key_type, best.key)).collect::<Vec<_>>().join("\n");
        return Ok(done(check, Some(Pin { line, file: PathBuf::from(file) }), None));
    }
    let authority = verdicts.iter().find_map(|verdict| match verdict {
        Verdict::Trusted { authority } => authority.clone(),
        _ => None,
    });
    Ok(done(HostKeyCheck::Trusted { authority, hops: chain }, None, None))
}

/// Appends the confirmed key(s) to known_hosts.
pub fn pin_host_key(env: &SshEnv, inspection: &HostKeyInspection) -> Result<(), SshError> {
    let pin = inspection.pin.as_ref().ok_or_else(|| error("There is no key to save."))?;
    append_text(env.files.as_ref(), &pin.file, &format!("{}\n", pin.line)).map_err(|failure| error(failure.to_string()))
}

/// Forgets the old key (`ssh-keygen -R` keeps a `.old` copy) and pins the one the server presents now.
pub async fn replace_host_key(env: &SshEnv, inspection: &HostKeyInspection) -> Result<(), SshError> {
    let replace = inspection.replace.as_ref().ok_or_else(|| error("There is no key to replace."))?;
    let args = ["-R".to_owned(), replace.spec.clone(), "-f".to_owned(), replace.file.to_string_lossy().into_owned()];
    let removed = run_tool(env, &AttemptContext::default(), "ssh-keygen", &args, TOOL_TIMEOUT).await?;
    if removed.exit_code != Some(0) {
        let reason = removed.stderr.trim();
        return Err(error(if reason.is_empty() { "ssh-keygen could not remove the old key." } else { reason }));
    }
    append_text(env.files.as_ref(), &replace.file, &format!("{}\n", replace.line)).map_err(|failure| error(failure.to_string()))
}

#[cfg(test)]
#[path = "host_key_tests.rs"]
mod host_key_tests;
