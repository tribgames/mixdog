//! Tests of the base modules: binary, known_hosts, user_config, diagnostics (cases of the desktop's ssh-binary,
//! host-key known-hosts, ssh-config and ssh-diagnostics tests).

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::binary::{client_install_command, is_missing_message, missing_client_message, resolve_ssh_tool, ssh_tool_command};
use crate::command::parse_ssh_target;
use crate::context::{ConfigFiles, Platform, PreparedSpawn, SshChild, SshConfigFiles, SshEnv, SshSpawner, ToolOutput, ToolRunner};
use crate::diagnostics::{
    describe_argv, diagnostics_key_for, redact_secrets, redact_server, server_names, DiagnosticKind, Diagnostics, DiagnosticsInput,
    DIAGNOSTICS_MAX_ENTRIES,
};
use crate::known_hosts::{entries_for, host_field_matches, key_fingerprint, known_hosts_spec, parse, KnownHostMarker};
use crate::user_config::{config_hosts, expand_includes, parse_config_hosts};

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// An in-memory file system: path text to file text.
#[derive(Default)]
struct MemFiles(BTreeMap<String, String>);

impl MemFiles {
    fn with(entries: &[(PathBuf, &str)]) -> Self {
        Self(entries.iter().map(|(path, text)| (normalized(path), (*text).to_owned())).collect())
    }
}

impl ConfigFiles for MemFiles {
    fn read_text(&self, path: &Path) -> Option<String> {
        self.0.get(&normalized(path)).cloned()
    }

    fn list_names(&self, directory: &Path) -> Vec<String> {
        let prefix = format!("{}/", normalized(directory));
        self.0.keys().filter_map(|key| key.strip_prefix(&prefix)).filter(|rest| !rest.contains('/')).map(str::to_owned).collect()
    }

    fn is_file(&self, path: &Path) -> bool {
        self.0.contains_key(&normalized(path))
    }
}

/// Files that are matched by their exact text (Windows paths on any host).
struct ExactFiles(Vec<String>);

impl ConfigFiles for ExactFiles {
    fn read_text(&self, _path: &Path) -> Option<String> {
        None
    }

    fn list_names(&self, _directory: &Path) -> Vec<String> {
        Vec::new()
    }

    fn is_file(&self, path: &Path) -> bool {
        self.0.contains(&path.to_string_lossy().into_owned())
    }
}

struct NoTools;

#[async_trait]
impl ToolRunner for NoTools {
    async fn run(&self, _command: &Path, _args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
        Err(io::Error::other("not used"))
    }
}

struct NoSpawn;

impl SshSpawner for NoSpawn {
    fn spawn(&self, _prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
        Err(io::Error::other("not used"))
    }
}

struct NoConfig;

impl SshConfigFiles for NoConfig {
    fn for_args(&self, _args: &[String]) -> Option<PathBuf> {
        None
    }

    fn generic(&self) -> Option<PathBuf> {
        None
    }
}

fn env_with(platform: Platform, vars: &[(&str, &str)], files: &[&str]) -> SshEnv {
    SshEnv {
        platform,
        env: vars.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect(),
        home: PathBuf::from("/home/tester"),
        askpass_helper: None,
        server_cores_dir: None,
        files: Arc::new(ExactFiles(files.iter().map(|file| (*file).to_owned()).collect())),
        config_files: Arc::new(NoConfig),
        tools: Arc::new(NoTools),
        spawner: Arc::new(NoSpawn),
        diagnostics: Arc::new(Diagnostics::new()),
    }
}

// ---- binary ----

#[test]
fn windows_looks_on_path_first_then_in_system32_openssh() {
    let vars = [("Path", r#"C:\Tools;"C:\Program Files\OpenSSH""#), ("SystemRoot", r"C:\Windows")];
    let env = env_with(
        Platform::Windows,
        &vars,
        &[r"C:\Program Files\OpenSSH\ssh.exe", r"C:\Windows\System32\OpenSSH\ssh.exe"],
    );
    assert_eq!(resolve_ssh_tool("ssh", &env), Some(PathBuf::from(r"C:\Program Files\OpenSSH\ssh.exe")));
    for tool in ["ssh", "ssh-keygen", "ssh-keyscan", "ssh-add"] {
        let file = format!(r"C:\Windows\System32\OpenSSH\{tool}.exe");
        let env = env_with(Platform::Windows, &[("Path", r"C:\Tools"), ("SystemRoot", r"C:\Windows")], &[file.as_str()]);
        assert_eq!(resolve_ssh_tool(tool, &env), Some(PathBuf::from(&file)));
    }
    let none = env_with(Platform::Windows, &[("Path", r"C:\Tools"), ("SystemRoot", r"C:\Windows")], &[]);
    assert_eq!(resolve_ssh_tool("ssh", &none), None);
}

#[test]
fn a_profile_or_install_folder_with_spaces_or_non_ascii_characters_is_returned_as_one_path() {
    let path = r"D:\도구 모음\Open SSH\ssh-keygen.exe";
    let env = env_with(Platform::Windows, &[("Path", r"D:\도구 모음\Open SSH")], &[path]);
    assert_eq!(resolve_ssh_tool("ssh-keygen", &env), Some(PathBuf::from(path)));
}

#[test]
fn the_windows_variable_names_match_without_regard_to_case() {
    let env = env_with(Platform::Windows, &[("PATH", r"C:\Tools"), ("WINDIR", r"C:\Win")], &[r"C:\Win\System32\OpenSSH\ssh.exe"]);
    assert_eq!(resolve_ssh_tool("ssh", &env), Some(PathBuf::from(r"C:\Win\System32\OpenSSH\ssh.exe")));
}

#[test]
fn macos_and_linux_use_path_only() {
    let linux = env_with(Platform::Linux, &[("PATH", "/bin:/usr/bin")], &["/usr/bin/ssh"]);
    assert_eq!(resolve_ssh_tool("ssh", &linux), Some(PathBuf::from("/usr/bin/ssh")));
    let mac = env_with(Platform::MacOs, &[("PATH", "/usr/bin")], &["/opt/x/ssh"]);
    assert_eq!(resolve_ssh_tool("ssh", &mac), None);
}

#[test]
fn a_missing_tool_is_spawned_by_its_bare_name_and_other_commands_pass_through() {
    let env = env_with(Platform::Linux, &[("PATH", "/usr/bin")], &["/usr/bin/ssh"]);
    assert_eq!(ssh_tool_command("ssh", &env), PathBuf::from("/usr/bin/ssh"));
    assert_eq!(ssh_tool_command("ssh-add", &env), PathBuf::from("ssh-add"));
    assert_eq!(ssh_tool_command("icacls", &env), PathBuf::from("icacls"));
}

#[test]
fn the_missing_client_message_is_recognised_and_windows_has_the_capability_command() {
    assert!(is_missing_message("The OpenSSH client (ssh-keyscan) was not found on PATH."));
    assert!(is_missing_message(&missing_client_message("ssh")));
    assert!(!is_missing_message("Permission denied"));
    assert_eq!(missing_client_message("ssh"), "The OpenSSH client (ssh) was not found on PATH.");
    assert_eq!(client_install_command(Platform::Windows), Some("Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"));
    assert_eq!(client_install_command(Platform::Linux), None);
}

// ---- known_hosts ----

fn key_of(label: &str) -> String {
    STANDARD.encode(format!("key-{label}"))
}

#[test]
fn known_hosts_matching_plain_wildcard_negated_and_hashed_host_fields_markers_are_kept_apart() {
    assert!(host_field_matches("10.0.0.1,gpu.example.com", "gpu.example.com"));
    assert!(host_field_matches("*.example.com,!bad.example.com", "gpu.example.com"));
    assert!(!host_field_matches("*.example.com,!bad.example.com", "bad.example.com"));
    assert!(host_field_matches("[10.0.0.1]:2202", "[10.0.0.1]:2202"));
    assert!(!host_field_matches("10.0.0.1", "[10.0.0.1]:2202"));
    let salt = b"salty-salt-salty-sal";
    let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
    mac.update(b"vps.example.com");
    let hash = STANDARD.encode(mac.finalize().into_bytes());
    let field = format!("|1|{}|{hash}", STANDARD.encode(salt));
    assert!(host_field_matches(&field, "vps.example.com"));
    assert!(!host_field_matches(&field, "other.example.com"));
    let text = format!(
        "@revoked * ssh-rsa {}\n@cert-authority *.example.com ssh-ed25519 {} comment\nhost ssh-ed25519 {}\n@bogus x y z\n",
        key_of("r"),
        key_of("ca"),
        key_of("p")
    );
    let entries = parse(&text);
    let markers: Vec<KnownHostMarker> = entries.iter().map(|entry| entry.marker).collect();
    assert_eq!(markers, [KnownHostMarker::Revoked, KnownHostMarker::CertAuthority, KnownHostMarker::None]);
    assert_eq!(entries_for(&entries, "gpu.example.com").len(), 2);
}

#[test]
fn known_hosts_parsing_skips_comments_bad_keys_and_short_lines_and_reads_crlf() {
    let text = format!("# c\r\n\r\nhost ssh-rsa {}\r\nhost ssh-rsa not*base64\r\nonlyhost\r\n", key_of("a"));
    let entries = parse(&text);
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].hosts.as_str(), entries[0].key_type.as_str()), ("host", "ssh-rsa"));
}

#[test]
fn an_entry_matches_a_host_and_port_the_way_ssh_names_it() {
    let entries = parse(&format!("[10.0.0.1]:2202,gpu ssh-ed25519 {}\nplain ssh-ed25519 {}\n", key_of("a"), key_of("b")));
    assert!(entries[0].matches("10.0.0.1", 2202));
    assert!(!entries[0].matches("10.0.0.1", 22));
    assert!(entries[1].matches("plain", 22));
    assert!(!entries[1].matches("plain", 2200));
    assert_eq!(known_hosts_spec("h", 22), "h");
    assert_eq!(known_hosts_spec("h", 2200), "[h]:2200");
}

#[test]
fn the_fingerprint_is_sha256_unpadded_base64() {
    let expected = format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(b"key-ed")));
    assert_eq!(key_fingerprint(&key_of("ed")), expected);
    assert!(!expected.ends_with('='));
}

// ---- user_config ----

#[test]
fn host_aliases_come_with_the_user_host_port_they_resolve_to_wildcard_patterns_are_skipped() {
    let hosts = parse_config_hosts(
        "
# my servers
Host gpu-box
  HostName 10.0.0.21
  User jae

Host vps-main vps-backup
    HostName=vps.example.com
    User root
    Port 2202

Host *
  ServerAliveInterval 30

Host !internal web-?? plain
  Port 22

Match host foo
  User ignored
",
    );
    let pairs: Vec<(&str, &str)> = hosts.iter().map(|host| (host.alias.as_str(), host.detail.as_str())).collect();
    assert_eq!(
        pairs,
        [
            ("gpu-box", "jae@10.0.0.21"),
            ("vps-main", "root@vps.example.com:2202"),
            ("vps-backup", "root@vps.example.com:2202"),
            ("plain", "plain"),
        ]
    );
}

#[test]
fn an_alias_already_listed_is_not_repeated() {
    let details: Vec<String> =
        parse_config_hosts("Host a\n  HostName x\nHost a\n  HostName y\n").into_iter().map(|host| host.detail).collect();
    assert_eq!(details, ["x"]);
}

fn aliases(text: &str) -> Vec<String> {
    parse_config_hosts(text).into_iter().map(|host| host.alias).collect()
}

#[test]
fn include_pulls_in_relative_tilde_and_wildcard_files_so_their_aliases_reach_the_picker() {
    let home = PathBuf::from("/home/김 철수");
    let ssh = home.join(".ssh");
    let files = MemFiles::with(&[
        (
            ssh.join("config"),
            "Include work/*.conf\nInclude ~/extra/hosts \"~/extra/spaced name\"\nHost top\n  HostName top.example.com\n",
        ),
        (ssh.join("work").join("a.conf"), "Host work-a\n  HostName a.example.com\n  User ann\n"),
        (ssh.join("work").join("b.conf"), "Host work-b\n  HostName b.example.com\n"),
        (ssh.join("work").join("readme.txt"), "Host ignored\n"),
        (home.join("extra").join("hosts"), "Host extra\n"),
        (home.join("extra").join("spaced name"), "Host spaced\n"),
    ]);
    let summary = config_hosts(&home, &files);
    let names: Vec<&str> = summary.hosts.iter().map(|host| host.alias.as_str()).collect();
    assert_eq!(names, ["work-a", "work-b", "extra", "spaced", "top"]);
    assert_eq!(summary.hosts[0].detail, "ann@a.example.com");
}

#[test]
fn a_missing_config_file_gives_no_hosts() {
    assert!(config_hosts(Path::new("/home/nobody"), &MemFiles::default()).hosts.is_empty());
}

#[test]
fn include_loops_and_chains_deeper_than_the_limit_are_cut_a_missing_file_is_skipped() {
    let home = PathBuf::from("/home/tester");
    let ssh = home.join(".ssh");
    let looped = MemFiles::with(&[(ssh.join("a"), "Host a\nInclude b\n"), (ssh.join("b"), "Host b\nInclude a\n")]);
    let text = expand_includes("Include a\nInclude nothing-here\n", &home, &looped, 0, &BTreeSet::new());
    assert_eq!(aliases(&text), ["a", "b"]);

    let deep_files: Vec<(PathBuf, String)> = (0..20).map(|i| (ssh.join(format!("f{i}")), format!("Host h{i}\nInclude f{}\n", i + 1))).collect();
    let deep = MemFiles::with(&deep_files.iter().map(|(path, text)| (path.clone(), text.as_str())).collect::<Vec<_>>());
    let found = aliases(&expand_includes("Include f0\n", &home, &deep, 0, &BTreeSet::new()));
    assert!((5..=9).contains(&found.len()), "{found:?}");
}

// ---- diagnostics ----

const TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn texts(diagnostics: &Diagnostics, key: &str, kind: DiagnosticKind) -> Vec<String> {
    diagnostics.entries(key).into_iter().filter(|entry| entry.kind == kind).map(|entry| entry.text).collect()
}

#[test]
fn secrets_never_enter_the_ring_tokens_passwords_bearer_headers_and_long_secret_looking_values() {
    let diagnostics = Diagnostics::new();
    for line in [
        format!("daemon token={TOKEN}"),
        format!("MIXDOG_REMOTE_TOKEN={TOKEN} node x"),
        "password: hunter2".to_owned(),
        format!("Authorization: Bearer {TOKEN}"),
        format!("raw {TOKEN}"),
    ] {
        diagnostics.record(Some("k"), DiagnosticKind::Log, &line, 0);
    }
    let joined = texts(&diagnostics, "k", DiagnosticKind::Log).join("\n");
    assert!(!joined.contains(TOKEN));
    assert!(!joined.contains("hunter2"));
    assert!(joined.contains("<redacted>"));
    assert_eq!(redact_secrets("plain text stays"), "plain text stays");
}

#[test]
fn the_ring_keeps_the_newest_entries_per_server() {
    let diagnostics = Diagnostics::new();
    for index in 0..DIAGNOSTICS_MAX_ENTRIES + 25 {
        diagnostics.record(Some("a"), DiagnosticKind::Log, &format!("line {index}"), 0);
    }
    diagnostics.record(Some("b"), DiagnosticKind::Log, "other server", 0);
    let a = diagnostics.entries("a");
    assert_eq!(a.len(), DIAGNOSTICS_MAX_ENTRIES);
    assert_eq!(a[0].text, "line 25");
    assert_eq!(texts(&diagnostics, "b", DiagnosticKind::Log), ["other server"]);
    assert_eq!(diagnostics.lines("b", 400), ["00:00:00.000 log    other server"]);
}

#[test]
fn a_spawned_ssh_is_recorded_argv_without_the_long_remote_script_stderr_bootstrap_results_exit_and_timing() {
    let diagnostics = Arc::new(Diagnostics::new());
    let script = format!("echo {}", "ab cd ".repeat(1_000));
    let args: Vec<String> = ["-T", "--", "ops@gate", script.as_str()].iter().map(|arg| (*arg).to_owned()).collect();
    let mut trace = diagnostics.trace_spawn(r"C:\Windows\System32\OpenSSH\ssh.exe", &args, Some("k"), 1_000);
    trace.stderr(b"Warning: Permanently added\nconnect to host gate port 22: refused\n", 1_100);
    trace.stdout(b"noise\nMIXDOG_RESULT {\"ok\":true}\nMIXDO", 1_200);
    trace.stdout(b"G_ERROR partial", 1_300);
    trace.closed(Some(255), None, 1_450);
    let entries = diagnostics.entries("k");
    assert_eq!(entries[0].kind, DiagnosticKind::Ssh);
    assert!(entries[0].text.starts_with("ssh.exe -T -- ops@gate echo ab cd ab cd"), "{}", entries[0].text);
    assert!(entries[0].text.ends_with("…(6005 chars)"), "{}", entries[0].text);
    assert_eq!(texts(&diagnostics, "k", DiagnosticKind::Stderr), ["Warning: Permanently added", "connect to host gate port 22: refused"]);
    assert_eq!(
        texts(&diagnostics, "k", DiagnosticKind::Result),
        ["MIXDOG_RESULT {\"ok\":true}", "MIXDOG_ERROR partial"],
        "a result line that was still open at exit is kept"
    );
    assert_eq!(entries.last().map(|entry| entry.text.as_str()), Some("code 255 after 450 ms"));
    assert!(!describe_argv("ssh", &["-o".to_owned(), format!("Token={TOKEN}")]).contains(TOKEN));
}

#[test]
fn the_tunnels_starts_and_exits_are_logged_so_restarts_show() {
    let diagnostics = Arc::new(Diagnostics::new());
    let args: Vec<String> = ["-N", "-L", "1:2:3", "--", "ops@gate"].iter().map(|arg| (*arg).to_owned()).collect();
    for code in [255, 255] {
        let mut trace = diagnostics.trace_spawn("ssh", &args, Some("k"), 0);
        trace.closed(Some(code), None, 0);
    }
    let tunnel: Vec<String> =
        texts(&diagnostics, "k", DiagnosticKind::Tunnel).iter().map(|text| text.split(' ').next().unwrap_or("").to_owned()).collect();
    assert_eq!(tunnel, ["start", "exited", "start", "exited"]);
}

#[test]
fn a_tool_that_could_not_start_and_a_signal_exit_are_recorded() {
    let diagnostics = Arc::new(Diagnostics::new());
    let mut trace = diagnostics.trace_spawn("ssh", &["-T".to_owned()], Some("k"), 0);
    trace.start_failed("program not found", 5);
    trace.closed(None, Some("SIGKILL"), 9);
    assert_eq!(texts(&diagnostics, "k", DiagnosticKind::Exit), ["could not start: program not found", "signal SIGKILL after 9 ms"]);
}

#[test]
fn copied_text_replaces_the_servers_user_and_host_with_server_short_names_only_next_to_an_at() {
    let target = parse_ssh_target("deploy@vps.example.com:2202").unwrap();
    let names = server_names(&target, &["203.0.113.7".to_owned()]);
    assert_eq!(
        redact_server("deploy@vps.example.com failed; VPS.example.com resolved to 203.0.113.7 as user deploy; port 2202", &names),
        "<server> failed; <server> resolved to <server> as user <server>; port 2202"
    );
    let short = parse_ssh_target("me@box").unwrap();
    assert_eq!(server_names(&short, &[]), ["me@box", "box", "me"]);
    assert_eq!(
        redact_server("me@box failed; login me@other and git@box; the box was on a boxed memo for me", &server_names(&short, &[])),
        "<server> failed; login <server>@other and git@<server>; the box was on a boxed memo for me",
        "a user or host of 3 characters or fewer is replaced as user@host, never as an ordinary word"
    );
    let diagnostics = Diagnostics::new();
    let key = diagnostics_key_for(&target);
    diagnostics.record(
        Some(&key),
        DiagnosticKind::Stderr,
        &format!("ssh: connect to host vps.example.com port 2202: Connection refused token={TOKEN}"),
        0,
    );
    let config: Vec<String> = ["HostName 203.0.113.7", "User deploy", "Port 2202"].iter().map(|line| (*line).to_owned()).collect();
    let extra = ["203.0.113.7".to_owned()];
    let report = diagnostics.report(&DiagnosticsInput {
        key: &key,
        target: &target,
        app_version: "1.2.3",
        ssh_version: "OpenSSH_9.9",
        os: "win32 10.0 (x64)",
        config: &config,
        extra_names: &extra,
        lines: None,
    });
    assert!(
        report.starts_with(
            "Mixdog SSH diagnostics\nApp: 1.2.3\nOS: win32 10.0 (x64)\nssh: OpenSSH_9.9\nConfig:\n  HostName <server>\n  User <server>\n  Port 2202\nLog (last 100 lines):\n"
        ),
        "{report}"
    );
    assert!(report.contains("connect to host <server> port 2202: Connection refused token=<redacted>"));
    for secret in ["vps.example.com", "deploy", "203.0.113.7", TOKEN] {
        assert!(!report.contains(secret), "{secret}");
    }
}

#[test]
fn the_report_holds_only_the_last_n_lines() {
    let diagnostics = Diagnostics::new();
    let target = parse_ssh_target("ops@gateway").unwrap();
    let key = diagnostics_key_for(&target);
    for index in 0..150 {
        diagnostics.record(Some(&key), DiagnosticKind::Log, &format!("entry {index}"), 0);
    }
    let report = diagnostics.report(&DiagnosticsInput {
        key: &key,
        target: &target,
        app_version: "v",
        ssh_version: "",
        os: "linux 6 (x64)",
        config: &[],
        extra_names: &[],
        lines: Some(5),
    });
    assert_eq!(report.split('\n').filter(|line| line.contains("entry ")).count(), 5);
    assert!(report.contains("entry 149"));
    assert!(!report.contains("entry 144"));
    assert!(report.contains("ssh: unknown"));
}
