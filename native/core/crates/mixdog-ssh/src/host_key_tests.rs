//! Tests of the host-key check and Mixdog's ssh config (cases of the desktop's `host-key.test.mjs` and
//! `mixdog-ssh-config.test.mjs`, and the import of the desktop's old known_hosts). The OpenSSH tools are scripted:
//! nothing here starts a process.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use sha2::{Digest, Sha256};

use super::*;
use crate::context::{ConfigFiles, LaneFiles, Platform, PreparedSpawn, SshChild, SshConfigFiles, SshSpawner, ToolRunner};
use crate::diagnostics::Diagnostics;
use crate::mixdog_config::mixdog_ssh_config_text;
use crate::pins::owner_of;

const HOME: &str = "/home/tester";
const USER_FILE: &str = "/home/tester/.ssh/known_hosts";
const GLOBAL_FILE: &str = "/etc/ssh/ssh_known_hosts";
const DUMP: &str = "user root\nhostname 10.0.0.1\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\n";

fn key_of(label: &str) -> String {
    STANDARD.encode(format!("key-{label}"))
}

fn fingerprint_of(label: &str) -> String {
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(format!("key-{label}"))))
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// An in-memory file system: path text to file text.
#[derive(Default)]
struct MemFiles(Mutex<BTreeMap<String, String>>);

impl MemFiles {
    fn with(entries: &[(&str, String)]) -> Arc<Self> {
        Arc::new(Self(Mutex::new(entries.iter().map(|(path, text)| (normalized(Path::new(path)), text.clone())).collect())))
    }
}

impl ConfigFiles for MemFiles {
    fn read_text(&self, path: &Path) -> Option<String> {
        self.0.lock().ok()?.get(&normalized(path)).cloned()
    }

    fn list_names(&self, _directory: &Path) -> Vec<String> {
        Vec::new()
    }

    fn is_file(&self, path: &Path) -> bool {
        self.read_text(path).is_some()
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

struct NoSpawn;

impl SshSpawner for NoSpawn {
    fn spawn(&self, _prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
        Err(io::Error::other("not used"))
    }
}

type Script = Box<dyn Fn(&str, &[String]) -> io::Result<ToolOutput> + Send + Sync>;

/// Tool stand-ins: a script answers by tool name and arguments; every call is kept.
struct Tools {
    script: Script,
    calls: Mutex<Vec<Vec<String>>>,
}

impl Tools {
    fn new(script: impl Fn(&str, &[String]) -> io::Result<ToolOutput> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { script: Box::new(script), calls: Mutex::new(Vec::new()) })
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().map(|calls| calls.clone()).unwrap_or_default()
    }

    fn named(&self, name: &str) -> Vec<Vec<String>> {
        self.calls().into_iter().filter(|call| call[0] == name).collect()
    }
}

#[async_trait]
impl ToolRunner for Tools {
    async fn run(&self, command: &Path, args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
        let name = command.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(std::iter::once(name.clone()).chain(args.iter().cloned()).collect());
        }
        (self.script)(&name, args)
    }
}

fn out(stdout: &str, stderr: &str) -> io::Result<ToolOutput> {
    Ok(ToolOutput { exit_code: Some(0), stdout: stdout.to_owned(), stderr: stderr.to_owned() })
}

/// What a scripted PC knows: the `ssh -G` text and the `ssh-keyscan` text per destination.
#[derive(Default, Clone)]
struct Network {
    dump: String,
    dumps: BTreeMap<String, String>,
    scan: String,
    scans: BTreeMap<String, String>,
    scan_fails: bool,
}

impl Network {
    fn plain(scan: &str) -> Self {
        Self { dump: DUMP.to_owned(), scan: scan.to_owned(), ..Self::default() }
    }

    fn script(self) -> impl Fn(&str, &[String]) -> io::Result<ToolOutput> + Send + Sync + 'static {
        move |name, args| {
            let last = args.last().map(String::as_str).unwrap_or_default();
            if name == "ssh" {
                return out(self.dumps.get(last).unwrap_or(&self.dump), "");
            }
            if self.scan_fails {
                return out("", "# 10.0.0.1:22 SSH-2.0-x\nconnect to host 10.0.0.1 port 22: Connection refused\n");
            }
            out(self.scans.get(last).unwrap_or(&self.scan), "")
        }
    }
}

fn env_with(platform: Platform, vars: &[(&str, &str)], files: Arc<dyn ConfigFiles + Send + Sync>, tools: Arc<Tools>) -> SshEnv {
    SshEnv {
        platform,
        env: vars.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect(),
        home: PathBuf::from(HOME),
        askpass_helper: None,
        server_cores_dir: None,
        files,
        config_files: Arc::new(NoConfig),
        tools,
        spawner: Arc::new(NoSpawn),
        diagnostics: Arc::new(Diagnostics::new()),
    }
}

fn linux(files: Arc<MemFiles>, tools: Arc<Tools>) -> SshEnv {
    env_with(Platform::Linux, &[], files, tools)
}

async fn inspect(target: &str, env: &SshEnv, own: Option<&Arc<MixdogSshConfig>>) -> HostKeyInspection {
    let target = parse_ssh_target(target).expect("a valid target");
    inspect_with(env, &AttemptContext::default(), &target, own.cloned(), None).await.expect("an inspection")
}

fn hop(name: &str, role: SshHopRole, status: SshHopStatus, key: Option<&str>) -> HopKey {
    HopKey { name: name.to_owned(), role, status, fingerprint: key.map(fingerprint_of), key_type: key.map(|_| "ED25519".to_owned()) }
}

fn ed(label: &str) -> String {
    format!("10.0.0.1 ssh-ed25519 {}\n", key_of(label))
}

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().expect("a temporary folder")
}

/// The owner a saved server `target` claims its pins under.
fn owner_for(target: &str) -> String {
    owner_of(&parse_ssh_target(target).expect("a valid target"))
}

fn claim_of(target: &str, spec: &str, key_type: &str, label: &str) -> Claim {
    Claim::new(owner_for(target), spec.to_owned(), key_type.to_owned(), key_of(label))
}

/// Mixdog's own ssh folder, prepared in a real temporary folder (its files are real; the OpenSSH tools stay scripted).
async fn configured_own() -> (tempfile::TempDir, Arc<MixdogSshConfig>) {
    let folder = temp();
    let vars = [("MIXDOG_DATA_DIR", folder.path().to_str().expect("a path"))];
    let configured = MixdogSshConfig::configure(&env_with(Platform::Linux, &vars, MemFiles::with(&[]), quiet())).await.expect("configured");
    (folder, configured)
}

/// A real folder tree: files are read and written for real, the OpenSSH tools are scripted.
fn on_disk(vars: &[(&str, &str)], tools: Arc<Tools>) -> SshEnv {
    env_with(Platform::Linux, vars, Arc::new(LaneFiles(&mixdog_fsio::Unlaned)), tools)
}

fn text(path: &Path) -> String {
    String::from_utf8_lossy(&mixdog_fsio::read(&mixdog_fsio::Unlaned, path).expect("a readable file")).into_owned()
}

fn quiet() -> Arc<Tools> {
    Tools::new(|_, _| out("", ""))
}

// ---- key lines, ssh -G ----

#[test]
fn key_lines_and_fingerprints_follow_the_sha256_unpadded_base64_form() {
    let lines = parse_key_lines(&format!("# comment\n10.0.0.1 ssh-ed25519 {}\n@revoked 10.0.0.1 ssh-rsa {}\n", key_of("a"), key_of("b")));
    assert_eq!(lines, vec![HostKeyLine { hosts: "10.0.0.1".into(), key_type: "ssh-ed25519".into(), key: key_of("a") }]);
    assert_eq!(key_fingerprint(&key_of("a")), fingerprint_of("a"));
    assert!(!key_fingerprint(&key_of("a")).contains('='));
}

#[test]
fn ssh_g_resolves_the_real_host_port_known_hosts_files_key_types_and_any_proxy() {
    let env = env_with(Platform::Linux, &[("ProgramData", "D:\\PD")], MemFiles::with(&[]), quiet());
    let dump = [
        "user deploy",
        "hostname vps.example.com",
        "port 2202",
        "userknownhostsfile \"~/my keys/known_hosts\" ~/.ssh/known_hosts2",
        "globalknownhostsfile __PROGRAMDATA__/ssh/ssh_known_hosts",
        "hostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ecdsa-sha2-nistp256",
        "proxyjump bastion,second",
        "",
    ]
    .join("\n");
    let resolved = parse_ssh_config_dump(&dump, &env).expect("a host");
    assert_eq!(resolved.hostname, "vps.example.com");
    assert_eq!(resolved.port, 2202);
    assert_eq!(resolved.user.as_deref(), Some("deploy"));
    assert_eq!(resolved.known_hosts_files, vec!["/home/tester/my keys/known_hosts", "/home/tester/.ssh/known_hosts2"]);
    assert_eq!(resolved.global_known_hosts_files, vec!["D:\\PD/ssh/ssh_known_hosts"]);
    assert_eq!(resolved.host_key_algorithms, vec!["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"]);
    assert_eq!(resolved.proxy_jump.as_deref(), Some("bastion,second"));
    assert!(resolved.proxied);
    assert_eq!(parse_ssh_config_dump("nothing useful", &env), None);
    let none = parse_ssh_config_dump("hostname h\nport 22\nuserknownhostsfile none\nproxyjump none\nproxycommand none\n", &env).expect("a host");
    assert_eq!((none.known_hosts_files, none.proxied), (Vec::<String>::new(), false));
}

#[test]
fn ssh_g_paths_with_spaces_and_non_ascii_characters_stay_in_one_piece_quoted_or_not() {
    let env = env_with(Platform::Linux, &[], MemFiles::with(&[]), quiet());
    let dump = |list: &str| {
        format!("hostname h\nport 22\nuserknownhostsfile {list}\nglobalknownhostsfile C:/Program Data/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2\n")
    };
    let plain = parse_ssh_config_dump(&dump("C:/Users/John Doe/.ssh/known_hosts ~/.ssh/known_hosts2 D:/키 폴더/known_hosts"), &env).expect("a host");
    assert_eq!(plain.known_hosts_files, vec!["C:/Users/John Doe/.ssh/known_hosts", "/home/tester/.ssh/known_hosts2", "D:/키 폴더/known_hosts"]);
    assert_eq!(plain.global_known_hosts_files, vec!["C:/Program Data/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"]);
    assert_eq!(parse_ssh_config_dump(&dump("\"/a b/k\" \"/c d/k\""), &env).expect("a host").known_hosts_files, vec!["/a b/k", "/c d/k"]);
}

#[test]
fn forwards_the_ssh_config_defines_are_collected_from_ssh_g_all_of_them() {
    let env = env_with(Platform::Linux, &[], MemFiles::with(&[]), quiet());
    let host = parse_ssh_config_dump(
        "hostname h\nport 22\nlocalforward [127.0.0.1]:8080 [127.0.0.1]:80\nremoteforward [0.0.0.0]:9 [127.0.0.1]:9\ndynamicforward [127.0.0.1]:1080\n",
        &env,
    )
    .expect("a host");
    assert_eq!(host.forwards, vec!["local [127.0.0.1]:8080 [127.0.0.1]:80", "remote [0.0.0.0]:9 [127.0.0.1]:9", "dynamic [127.0.0.1]:1080"]);
    assert!(parse_ssh_config_dump("hostname h\nport 22\n", &env).expect("a host").forwards.is_empty());
}

// ---- the comparison ----

#[tokio::test]
async fn an_unknown_server_shows_the_key_ssh_would_negotiate_first_and_offers_it_for_pinning() {
    let tools = Tools::new(Network::plain(&format!("10.0.0.1 ssh-rsa {}\n{}", key_of("rsa"), ed("ed"))).script());
    let result = inspect("root@10.0.0.1", &linux(MemFiles::with(&[]), tools.clone()), None).await;
    assert_eq!(result.check, HostKeyCheck::Unknown { fingerprint: fingerprint_of("ed"), key_type: "ED25519".into(), hops: None });
    // Without Mixdog's own known_hosts nobody could own a pin, and nothing is ever written into the user's file: no pin is offered.
    assert_eq!(result.pin, None);
    let (_folder, own) = configured_own().await;
    let owned = inspect(
        "root@10.0.0.1",
        &linux(MemFiles::with(&[]), Tools::new(Network::plain(&format!("10.0.0.1 ssh-rsa {}\n{}", key_of("rsa"), ed("ed"))).script())),
        Some(&own),
    )
    .await;
    let pin = owned.pin.expect("a pin");
    assert_eq!(pin.claims, vec![claim_of("root@10.0.0.1", "10.0.0.1", "ssh-ed25519", "ed")]);
    assert_eq!(pin.file, own.known_hosts_file());
    let summary = result.summary.expect("a summary");
    assert_eq!(
        (summary.host_name.as_str(), summary.user.as_deref(), summary.port, summary.proxy_jump, summary.proxy_command),
        ("10.0.0.1", Some("root"), 22, None, false)
    );
    assert_eq!(tools.calls()[0][..2], ["ssh".to_owned(), "-G".to_owned()]);
    // HostKeyAlgorithms from the user's config decides which key is shown and pinned.
    let rsa_first = Network {
        dump: format!("{DUMP}hostkeyalgorithms rsa-sha2-512,ssh-ed25519\n"),
        scan: format!("{}10.0.0.1 ssh-rsa {}\n", ed("ed"), key_of("rsa")),
        ..Network::default()
    };
    let tools = Tools::new(rsa_first.script());
    let pinned = inspect("root@10.0.0.1", &linux(MemFiles::with(&[]), tools.clone()), Some(&own)).await;
    assert!(matches!(&pinned.check, HostKeyCheck::Unknown { key_type, .. } if key_type == "RSA"));
    assert_eq!(pinned.pin.expect("a pin").claims, vec![claim_of("root@10.0.0.1", "10.0.0.1", "ssh-rsa", "rsa")]);
    let scan = &tools.named("ssh-keyscan")[0];
    let at = scan.iter().position(|arg| arg == "-t").expect("a -t");
    assert_eq!(scan[at + 1], "rsa,ed25519");
}

#[tokio::test]
async fn a_key_in_the_user_known_hosts_or_only_in_the_system_wide_one_is_trusted_and_a_port_is_looked_up_as_host_port() {
    let network = Network {
        dump: "hostname 10.0.0.1\nport 2202\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\n".to_owned(),
        scan: format!("[10.0.0.1]:2202 ssh-ed25519 {}\n", key_of("ed")),
        ..Network::default()
    };
    let at = |path: &str, line: String| linux(MemFiles::with(&[(path, line)]), Tools::new(network.clone().script()));
    let known = format!("[10.0.0.1]:2202 ssh-ed25519 {}\n", key_of("ed"));
    let user = inspect("root@10.0.0.1:2202", &at(USER_FILE, known.clone()), None).await;
    assert_eq!(user.check, HostKeyCheck::Trusted { authority: None, hops: None });
    assert_eq!(user.pin, None);
    assert_eq!(inspect("root@10.0.0.1:2202", &at(GLOBAL_FILE, known), None).await.check, HostKeyCheck::Trusted { authority: None, hops: None });
    let wrong_port = inspect("root@10.0.0.1:2202", &at(USER_FILE, ed("other")), None).await;
    assert!(matches!(wrong_port.check, HostKeyCheck::Unknown { .. }), "an entry for port 22 says nothing about port 2202");
}

#[tokio::test]
async fn a_changed_key_shows_both_fingerprints_the_exact_ssh_keygen_r_command_and_is_replaceable_only_from_mixdogs_own_file() {
    let network = Network::plain(&ed("new"));
    let result = inspect("root@10.0.0.1", &linux(MemFiles::with(&[(USER_FILE, ed("old"))]), Tools::new(network.clone().script())), None).await;
    assert_eq!(
        result.check,
        HostKeyCheck::Changed {
            previous: fingerprint_of("old"),
            current: fingerprint_of("new"),
            key_type: "ED25519".into(),
            host: "10.0.0.1".into(),
            remove_command: "ssh-keygen -R \"10.0.0.1\"".into(),
            replaceable: false,
            hops: None,
        }
    );
    assert_eq!(result.pin, None, "a changed key is never offered for pinning");
    // A key in the user's own known_hosts is never edited by Mixdog: only the command is shown.
    assert_eq!(result.replace, None);
    // A pin Mixdog wrote itself (here another saved server's) can be replaced from here.
    let (_folder, configured) = configured_own().await;
    let own_file = normalized(configured.known_hosts_file());
    let managed = format!("{}\n", claim_of("ops@other", "10.0.0.1", "ssh-ed25519", "old").line());
    let env = linux(MemFiles::with(&[(own_file.as_str(), managed)]), Tools::new(network.clone().script()));
    let own = inspect("root@10.0.0.1", &env, Some(&configured)).await;
    assert!(matches!(&own.check, HostKeyCheck::Changed { replaceable: true, remove_command, .. } if remove_command.contains(" -f ")));
    let replace = own.replace.expect("a replacement");
    assert_eq!((replace.spec.as_str(), replace.host.as_str()), ("10.0.0.1", "10.0.0.1"));
    assert_eq!(normalized(&replace.file), own_file);
    assert_eq!(replace.claim, claim_of("root@10.0.0.1", "10.0.0.1", "ssh-ed25519", "new"));
    // A pin from before the mark existed is not the app's own: it is for the user to review, never replaced from here.
    let legacy_env = linux(MemFiles::with(&[(own_file.as_str(), ed("old"))]), Tools::new(network.clone().script()));
    let legacy = inspect("root@10.0.0.1", &legacy_env, Some(&configured)).await;
    assert!(matches!(&legacy.check, HostKeyCheck::Changed { replaceable: false, .. }));
    assert_eq!(legacy.replace, None);
    // A key from the system file cannot be edited by the user: the command names the file, no replace.
    let system = inspect("root@10.0.0.1", &linux(MemFiles::with(&[(GLOBAL_FILE, ed("old"))]), Tools::new(network.script())), None).await;
    assert!(
        matches!(&system.check, HostKeyCheck::Changed { remove_command, .. } if *remove_command == format!("ssh-keygen -R \"10.0.0.1\" -f \"{GLOBAL_FILE}\""))
    );
    assert_eq!(system.replace, None);
}

#[tokio::test]
async fn a_revoked_key_is_refused_and_a_certificate_authority_is_shown_not_pinned() {
    let network = Network::plain(&ed("ed"));
    let revoked =
        inspect("root@10.0.0.1", &linux(MemFiles::with(&[(USER_FILE, format!("@revoked {}", ed("ed")))]), Tools::new(network.clone().script())), None).await;
    assert_eq!(revoked.check, HostKeyCheck::Revoked { fingerprint: fingerprint_of("ed"), host: "10.0.0.1".into() });
    assert_eq!(revoked.pin, None);
    // Revoked everywhere (`*`), even when the same key is also listed as known.
    let files = MemFiles::with(&[(GLOBAL_FILE, format!("@revoked * ssh-ed25519 {}\n", key_of("ed"))), (USER_FILE, ed("ed"))]);
    let everywhere = inspect("root@10.0.0.1", &linux(files, Tools::new(network.script())), None).await;
    assert!(matches!(everywhere.check, HostKeyCheck::Revoked { .. }));
    let authority =
        Network { dump: DUMP.replace("10.0.0.1", "gpu.example.com"), scan: format!("gpu.example.com ssh-ed25519 {}\n", key_of("ed")), ..Network::default() };
    let files = MemFiles::with(&[(USER_FILE, format!("@cert-authority *.example.com ssh-ed25519 {}\n", key_of("ca")))]);
    let shown = inspect("root@10.0.0.1", &linux(files, Tools::new(authority.script())), None).await;
    assert_eq!(shown.check, HostKeyCheck::Trusted { authority: Some(fingerprint_of("ca")), hops: None });
    assert_eq!(shown.pin, None);
}

#[tokio::test]
async fn an_unreadable_server_is_unreachable_unless_known_hosts_already_has_it() {
    let network = Network { dump: DUMP.to_owned(), scan_fails: true, ..Network::default() };
    let blocked = inspect("root@10.0.0.1", &linux(MemFiles::with(&[]), Tools::new(network.clone().script())), None).await;
    assert!(matches!(&blocked.check, HostKeyCheck::Unreachable { message, .. } if message.contains("Connection refused") && !message.contains('#')));
    let known = inspect("root@10.0.0.1", &linux(MemFiles::with(&[(USER_FILE, ed("ed"))]), Tools::new(network.script())), None).await;
    assert_eq!(known.check, HostKeyCheck::Trusted { authority: None, hops: None });
}

#[tokio::test]
async fn a_missing_openssh_client_is_reported_with_the_windows_install_command() {
    let missing = || Tools::new(|_, _| Err(io::Error::new(io::ErrorKind::NotFound, "gone")));
    let windows = inspect("root@10.0.0.1", &env_with(Platform::Windows, &[], MemFiles::with(&[]), missing()), None).await;
    assert!(matches!(
        &windows.check,
        HostKeyCheck::Unreachable { ssh_missing: Some(SshMissing { command: Some(command) }), .. } if command == "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"
    ));
    let other = inspect("root@10.0.0.1", &linux(MemFiles::with(&[]), missing()), None).await;
    assert!(matches!(&other.check, HostKeyCheck::Unreachable { ssh_missing: Some(SshMissing { command: None }), .. }));
}

// ---- behind a proxy ----

const BASTION_SPEC: &str = "[bastion.example.com]:2200";

fn bastion_line() -> String {
    format!("{BASTION_SPEC} ssh-ed25519 {}", key_of("bastion"))
}

/// The jump-host PC: `ssh -G` per destination, ssh-keyscan of the bastion, and a through-the-proxy read whose
/// throwaway known_hosts receives the target's key (what ssh does with StrictHostKeyChecking=no) unless it is blocked.
fn jump_network(blocked: bool) -> Arc<Tools> {
    let dumps = BTreeMap::from([
        ("jump-target".to_owned(), "hostname 10.1.0.5\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\nproxyjump ops@bastion.example.com:2200\n".to_owned()),
        ("ops@bastion.example.com".to_owned(), "hostname bastion.example.com\nport 2200\nuserknownhostsfile ~/.ssh/known_hosts\n".to_owned()),
    ]);
    Tools::new(move |name, args| {
        if name == "ssh-keyscan" {
            return out(&format!("{}\n", bastion_line()), "");
        }
        let Some(config) = args.iter().position(|arg| arg == "-F").map(|at| PathBuf::from(&args[at + 1])) else {
            return out(dumps.get(args.last().map_or("", String::as_str)).map_or("", String::as_str), "");
        };
        if blocked {
            return out("", "ssh: connect to host 10.1.0.5 port 22: Connection timed out\n");
        }
        let known = config.with_file_name("known_hosts");
        let seeded = String::from_utf8_lossy(&mixdog_fsio::read(&mixdog_fsio::Unlaned, &known)?).into_owned();
        mixdog_fsio::write(&mixdog_fsio::Unlaned, &known, format!("{seeded}10.1.0.5 ssh-ed25519 {}\n", key_of("target")))?;
        out("", "")
    })
}

fn scan_calls(tools: &Tools) -> Vec<Vec<String>> {
    tools.named("ssh").into_iter().filter(|call| call.iter().any(|arg| arg == "-F")).collect()
}

#[tokio::test]
async fn behind_proxyjump_the_servers_are_read_hop_by_hop_and_a_hop_is_dialed_through_only_once_the_ones_before_it_are_trusted() {
    let folder = temp();
    let vars = [("TMPDIR", folder.path().to_str().expect("a path"))];
    let files = |known: Option<String>| -> Arc<MemFiles> { MemFiles::with(&known.map(|line| vec![(USER_FILE, line)]).unwrap_or_default()) };
    let env = |tools: Arc<Tools>, known: Option<String>| env_with(Platform::Linux, &vars, files(known), tools);
    let (_own_folder, own) = configured_own().await;
    let own = Some(&own);

    // Nothing trusted yet: the first hop is read directly (no login, no proxy), the target waits.
    let tools = jump_network(false);
    let both = inspect("jump-target", &env(tools.clone(), None), own).await;
    assert!(scan_calls(&tools).is_empty(), "a server behind an untrusted hop is not dialed");
    assert!(matches!(&both.check, HostKeyCheck::Unknown { fingerprint, hops: Some(_), .. } if *fingerprint == fingerprint_of("bastion")));
    let expected = vec![
        hop("ops@bastion.example.com:2200", SshHopRole::Jump, SshHopStatus::Unknown, Some("bastion")),
        hop("jump-target", SshHopRole::Target, SshHopStatus::Pending, None),
    ];
    assert_eq!(both.hops, expected);
    assert!(matches!(&both.check, HostKeyCheck::Unknown { hops: Some(hops), .. } if *hops == expected));
    assert_eq!(both.pin.expect("a pin").claims, vec![claim_of("jump-target", BASTION_SPEC, "ssh-ed25519", "bastion")], "only the key that was read is offered");
    assert_eq!(both.summary.expect("a summary").proxy_jump.as_deref(), Some("ops@bastion.example.com:2200"));

    // Hop trusted: the target is read through it, with the hop's key seeded so it is checked strictly on the way.
    let tools = jump_network(false);
    let hop_known = inspect("jump-target", &env(tools.clone(), Some(format!("{}\n", bastion_line()))), own).await;
    let scans = scan_calls(&tools);
    let [scan] = &scans[..] else { panic!("one read through the hop") };
    assert!(scan.join(" ").contains("-o ProxyJump=ops@bastion.example.com:2200"));
    assert_eq!(&scan[scan.len() - 3..], ["--", "jump-target", "true"]);
    assert_eq!(hop_known.hops.iter().map(|hop| hop.status).collect::<Vec<_>>(), vec![SshHopStatus::Trusted, SshHopStatus::Unknown]);
    // The hop is trusted by the user's own file: that trust is not copied into a pin of this server's.
    assert_eq!(hop_known.pin.expect("a pin").claims, vec![claim_of("jump-target", "10.1.0.5", "ssh-ed25519", "target")]);

    // A changed hop blocks the whole connection and the target is never dialed.
    let tools = jump_network(false);
    let old = format!("{BASTION_SPEC} ssh-ed25519 {}\n", key_of("old-bastion"));
    let hop_changed = inspect("jump-target", &env(tools.clone(), Some(old)), own).await;
    assert!(scan_calls(&tools).is_empty());
    assert!(
        matches!(&hop_changed.check, HostKeyCheck::Changed { host, remove_command, .. } if host == "bastion.example.com" && remove_command == "ssh-keygen -R \"[bastion.example.com]:2200\"")
    );

    // The target could not be read through a trusted hop: nothing is offered for pinning.
    let tools = jump_network(true);
    let blocked = inspect("jump-target", &env(tools, Some(format!("{}\n", bastion_line()))), own).await;
    assert!(matches!(&blocked.check, HostKeyCheck::Unreachable { message, .. } if message.contains("Connection timed out")));
    assert_eq!(blocked.pin, None);
}

#[tokio::test]
async fn a_revocation_added_to_a_jump_hosts_own_system_wide_file_after_the_review_refuses_the_confirmation() {
    let folder = temp();
    let path = |name: &str| normalized(&folder.path().join(name));
    let (hop_global, target_global) = (path("hop_global"), path("target_global"));
    let dumps = BTreeMap::from([
        (
            "jump-target".to_owned(),
            format!(
                "hostname 10.1.0.5\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile {target_global}\nproxyjump ops@bastion.example.com:2200\n"
            ),
        ),
        (
            "ops@bastion.example.com".to_owned(),
            format!("hostname bastion.example.com\nport 2200\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile {hop_global}\n"),
        ),
    ]);
    let tools = Tools::new(move |name, args| {
        if name == "ssh-keyscan" {
            return out(&format!("{}\n", bastion_line()), "");
        }
        let Some(config) = args.iter().position(|arg| arg == "-F").map(|at| PathBuf::from(&args[at + 1])) else {
            return out(dumps.get(args.last().map_or("", String::as_str)).map_or("", String::as_str), "");
        };
        let known = config.with_file_name("known_hosts");
        let seeded = String::from_utf8_lossy(&mixdog_fsio::read(&mixdog_fsio::Unlaned, &known)?).into_owned();
        mixdog_fsio::write(&mixdog_fsio::Unlaned, &known, format!("{seeded}10.1.0.5 ssh-ed25519 {}\n", key_of("target")))?;
        out("", "")
    });
    let (data, scans) = (path("data"), path("scans"));
    std::fs::create_dir_all(&scans).expect("a folder");
    let mut env = on_disk(&[("MIXDOG_DATA_DIR", data.as_str()), ("TMPDIR", scans.as_str())], tools);
    env.home = folder.path().join("home");
    std::fs::create_dir_all(env.home.join(".ssh")).expect("a folder");
    // The hop is trusted through the user's own file; the target is read through it.
    std::fs::write(env.home.join(".ssh").join("known_hosts"), format!("{}\n", bastion_line())).expect("written");
    let own = MixdogSshConfig::configure(&env).await.expect("configured");

    let inspection = inspect("jump-target", &env, Some(&own)).await;
    assert!(matches!(inspection.check, HostKeyCheck::Unknown { .. }));
    std::fs::write(&hop_global, format!("@revoked {}\n", bastion_line())).expect("the hop's key revoked after the review, where only the hop's ssh reads it");
    let refused = pin_host_key(&inspection).await.expect_err("the hop's revocation is part of what was confirmed");
    assert_eq!(refused.message, crate::said::HOST_KEY_REVOKED_WHILE_CONFIRMING.plain().english);
    assert_eq!(text(own.known_hosts_file()), "", "the target is not pinned behind a revoked hop");
}

#[tokio::test]
async fn a_file_only_the_jump_hosts_ssh_reads_neither_trusts_nor_refuses_the_target() {
    let folder = temp();
    let path = |name: &str| normalized(&folder.path().join(name));
    let hop_global = path("hop_global");
    let dumps = BTreeMap::from([
        (
            "jump-target".to_owned(),
            "hostname 10.1.0.5\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile none\nproxyjump ops@bastion.example.com:2200\n".to_owned(),
        ),
        (
            "ops@bastion.example.com".to_owned(),
            format!("hostname bastion.example.com\nport 2200\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile {hop_global}\n"),
        ),
    ]);
    let tools = Tools::new(move |name, args| {
        if name == "ssh-keyscan" {
            return out(&format!("{}\n", bastion_line()), "");
        }
        let Some(config) = args.iter().position(|arg| arg == "-F").map(|at| PathBuf::from(&args[at + 1])) else {
            return out(dumps.get(args.last().map_or("", String::as_str)).map_or("", String::as_str), "");
        };
        let known = config.with_file_name("known_hosts");
        let seeded = String::from_utf8_lossy(&mixdog_fsio::read(&mixdog_fsio::Unlaned, &known)?).into_owned();
        mixdog_fsio::write(&mixdog_fsio::Unlaned, &known, format!("{seeded}10.1.0.5 ssh-ed25519 {}\n", key_of("target")))?;
        out("", "")
    });
    let (data, scans) = (path("data"), path("scans"));
    std::fs::create_dir_all(&scans).expect("a folder");
    let mut env = on_disk(&[("MIXDOG_DATA_DIR", data.as_str()), ("TMPDIR", scans.as_str())], tools);
    env.home = folder.path().join("home");
    std::fs::create_dir_all(env.home.join(".ssh")).expect("a folder");
    std::fs::write(env.home.join(".ssh").join("known_hosts"), format!("{}\n", bastion_line())).expect("the hop is trusted");
    // The target's very key, in a file the target's own ssh never reads.
    let target_line = format!("10.1.0.5 ssh-ed25519 {}", key_of("target"));
    std::fs::write(&hop_global, format!("{target_line}\n")).expect("written");
    let own = MixdogSshConfig::configure(&env).await.expect("configured");

    let inspection = inspect("jump-target", &env, Some(&own)).await;
    assert!(matches!(&inspection.check, HostKeyCheck::Unknown { fingerprint, .. } if *fingerprint == fingerprint_of("target")), "{:?}", inspection.check);
    // Revoked there after the review: still nothing the target's ssh consults, so the confirmation stands.
    std::fs::write(&hop_global, format!("@revoked {target_line}\n")).expect("written");
    pin_host_key(&inspection).await.expect("pinned");
    assert_eq!(text(own.known_hosts_file()), format!("{}\n", claim_of("jump-target", "10.1.0.5", "ssh-ed25519", "target").line()));
}

#[tokio::test]
async fn an_unreachable_server_gets_no_config_and_registers_no_file_and_a_reachable_one_both() {
    let (_folder, own) = configured_own().await;
    let configs = ResolvedConfigs::new(Arc::clone(&own));
    let dump = "hostname 10.0.0.1\nport 22\nuserknownhostsfile ~/.ssh/known_hosts /home/tester/custom_known_hosts\n".to_owned();
    let generic = || text(own.config_file());
    let written = || {
        mixdog_fsio::read_dir(&mixdog_fsio::Unlaned, own.dir())
            .expect("a folder")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("t-"))
            .count()
    };
    let before = generic();
    let inspect_at = |network: Network| {
        let env = linux(MemFiles::with(&[]), Tools::new(network.script()));
        let (own, configs) = (Arc::clone(&own), &configs);
        async move {
            inspect_with(&env, &AttemptContext::default(), &parse_ssh_target("root@10.0.0.1").expect("a target"), Some(own), Some(configs))
                .await
                .expect("an inspection")
        }
    };

    let down = inspect_at(Network { dump: dump.clone(), scan_fails: true, ..Network::default() }).await;
    assert!(matches!(down.check, HostKeyCheck::Unreachable { .. }), "{:?}", down.check);
    assert_eq!(down.reviewed, None);
    assert_eq!((generic(), written()), (before.clone(), 0), "nothing is written for a server that could not be read");

    let up = inspect_at(Network { dump, scan: ed("ed"), ..Network::default() }).await;
    assert!(matches!(up.check, HostKeyCheck::Unknown { .. }), "{:?}", up.check);
    assert!(up.reviewed.as_ref().and_then(|reviewed| reviewed.file.as_ref()).is_some_and(|file| file.path().is_file()));
    assert!(generic().contains("custom_known_hosts") && written() == 1);
}
#[tokio::test]
async fn the_proxy_read_switches_the_login_off_for_the_server_being_read_only_and_checks_the_hops_before_it_strictly() {
    let folder = temp();
    let seen: Arc<Mutex<Vec<(Vec<String>, String, String)>>> = Arc::default();
    let record = Arc::clone(&seen);
    let tools = Tools::new(move |_, args| {
        let config = PathBuf::from(&args[args.iter().position(|arg| arg == "-F").expect("a -F") + 1]);
        let read = |path: &Path| String::from_utf8_lossy(&mixdog_fsio::read(&mixdog_fsio::Unlaned, path).expect("a file")).into_owned();
        if let Ok(mut seen) = record.lock() {
            seen.push((args.to_vec(), read(&config), read(&config.with_file_name("known_hosts"))));
        }
        out("", "")
    });
    let env = on_disk(&[("TMPDIR", folder.path().to_str().expect("a path"))], tools);
    let ctx = AttemptContext::default();
    let target = parse_ssh_target("jump-target").expect("a target");
    let scope = ScanScope { via: Some(vec!["ops@bastion:2200".into()]), open: "10.1.0.5".into(), trusted: Some("bastion ssh-ed25519 AAAA".into()) };
    scan_through_ssh(&env, &ctx, &target, &scope).await.expect("a scan");
    let behind = ScanScope { via: None, open: "*".into(), trusted: None };
    scan_through_ssh(&env, &ctx, &parse_ssh_target("behind-command").expect("a target"), &behind).await.expect("a scan");
    let refused = ScanScope { via: None, open: "a\"b".into(), trusted: None };
    let failure = scan_through_ssh(&env, &ctx, &target, &refused).await.expect_err("refused");
    assert!(failure.message.contains("cannot be read through a proxy"));

    let seen = seen.lock().expect("the record");
    let (hop_args, hop_text, hop_known) = &seen[0];
    assert!(hop_text.starts_with(
        "Match host \"10.1.0.5\"\n  PreferredAuthentications none\n  PubkeyAuthentication no\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  StrictHostKeyChecking no\n"
    ));
    assert!(hop_text.contains("Host *\n  UserKnownHostsFile \""));
    assert!(hop_text.contains("\n  GlobalKnownHostsFile none\n  StrictHostKeyChecking yes\n"));
    assert!(hop_text.contains("\nInclude \"/home/tester/.ssh/config\"\n"));
    assert_eq!(hop_known, "bastion ssh-ed25519 AAAA\n", "the trusted hops are seeded");
    assert!(hop_args.join(" ").contains("-o ProxyJump=ops@bastion:2200"));
    let (command_args, command_text, _) = &seen[1];
    assert!(
        command_text
            .starts_with("Host *\n  PreferredAuthentications none\n  PubkeyAuthentication no\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no")
    );
    assert!(!command_args.iter().any(|arg| arg.starts_with("ProxyJump=")), "the configured route is used");
    drop(seen);
    // A plain temp folder gets mkdtemp-style `mxk-` subfolders directly (no per-user root); nothing of them is left.
    let left: Vec<String> = mixdog_fsio::read_dir(&mixdog_fsio::Unlaned, folder.path())
        .expect("the temp folder")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("mxk-"))
        .collect();
    assert!(left.is_empty(), "the throwaway folders are removed: {left:?}");
}

#[tokio::test]
async fn proxycommand_reads_the_target_through_the_same_ssh_based_scan() {
    let folder = temp();
    let tools = Tools::new(|name, args| {
        if name == "ssh" && args.iter().any(|arg| arg == "-F") {
            let known = PathBuf::from(&args[args.iter().position(|arg| arg == "-F").unwrap_or(0) + 1]).with_file_name("known_hosts");
            mixdog_fsio::write(&mixdog_fsio::Unlaned, known, ed("ed"))?;
            return out("", "");
        }
        out(&format!("{DUMP}proxycommand nc -X 5 -x proxy:1080 10.0.0.1 22\n"), "")
    });
    let env = env_with(Platform::Linux, &[("TMPDIR", folder.path().to_str().expect("a path"))], MemFiles::with(&[]), tools.clone());
    let result = inspect("root@10.0.0.1", &env, None).await;
    let scans = scan_calls(&tools);
    let [scan] = &scans[..] else { panic!("one read through the proxy") };
    assert!(!scan.iter().any(|arg| arg.starts_with("ProxyJump=")), "no login is made to a target behind a proxy command");
    assert_eq!(result.check, HostKeyCheck::Unknown { fingerprint: fingerprint_of("ed"), key_type: "ED25519".into(), hops: None });
    assert!(result.hops.len() == 1 && result.summary.expect("a summary").proxy_command);
}

#[tokio::test]
async fn known_hosts_in_a_profile_folder_with_spaces_and_non_ascii_characters_is_read_and_written() {
    let folder = temp();
    let home = folder.path().join("mixdog 홈 폴더");
    let data = folder.path().join("data");
    let mut env = on_disk(&[("MIXDOG_DATA_DIR", data.to_str().expect("a path"))], Tools::new(Network::plain(&ed("ed")).script()));
    env.home = home.clone();
    let own = MixdogSshConfig::configure(&env).await.expect("configured");
    let first = inspect("root@10.0.0.1", &env, Some(&own)).await;
    assert!(matches!(first.check, HostKeyCheck::Unknown { .. }));
    assert_eq!(first.pin.as_ref().expect("a pin").file, own.known_hosts_file());
    pin_host_key(&first).await.expect("pinned");
    let second = inspect("root@10.0.0.1", &env, Some(&own)).await;
    assert_eq!(second.check, HostKeyCheck::Trusted { authority: None, hops: None });
    assert_eq!(text(own.known_hosts_file()), format!("{}\n", claim_of("root@10.0.0.1", "10.0.0.1", "ssh-ed25519", "ed").line()));
    assert!(!home.join(".ssh").join("known_hosts").exists(), "the user's own file is never written");
}

// ---- writes ----

/// A pin of `spec` and `key` for the server `root@10.0.0.1`, of an inspection that read nothing about the route.
fn pin_of(file: &Path, spec: &str, key: &str) -> HostKeyInspection {
    let owner = owner_for("root@10.0.0.1");
    HostKeyInspection {
        hops: Vec::new(),
        check: HostKeyCheck::Trusted { authority: None, hops: None },
        pin: Some(Pin::new(file.to_owned(), vec![Claim::new(owner, spec.to_owned(), "ssh-ed25519".to_owned(), key.to_owned())], Vec::new())),
        replace: None,
        summary: None,
        reviewed: None,
    }
}

fn pin_line(spec: &str, key: &str) -> String {
    Claim::new(owner_for("root@10.0.0.1"), spec.to_owned(), "ssh-ed25519".to_owned(), key.to_owned()).line()
}

#[tokio::test]
async fn pinning_appends_the_confirmed_key_on_its_own_line_creating_the_folder() {
    let folder = temp();
    let file = folder.path().join(".ssh").join("known_hosts");
    pin_host_key(&pin_of(&file, "10.0.0.1", &key_of("a"))).await.expect("pinned");
    let mut handle = mixdog_fsio::OpenOptions::new();
    handle.append(true);
    io::Write::write_all(&mut handle.open(&mixdog_fsio::Unlaned, &file).expect("opened"), format!("10.0.0.9 ssh-ed25519 {}", key_of("b")).as_bytes())
        .expect("written");
    pin_host_key(&pin_of(&file, "10.0.0.2", &key_of("c"))).await.expect("pinned");
    // The file the user left without a final newline ends without one again, behind the pin that took its last place.
    assert_eq!(
        text(&file).split('\n').collect::<Vec<_>>(),
        vec![pin_line("10.0.0.1", &key_of("a")), format!("10.0.0.9 ssh-ed25519 {}", key_of("b")), pin_line("10.0.0.2", &key_of("c"))]
    );
    assert!(pin_host_key(&HostKeyInspection { pin: None, ..pin_of(&file, "x", "y") }).await.is_err(), "nothing to pin");
}

#[tokio::test]
async fn replacing_a_key_rewrites_its_pin_in_place_and_keeps_its_mark() {
    let folder = temp();
    let file = folder.path().join("known_hosts");
    let other = owner_for("ops@other");
    let old = Claim::new(other.clone(), "10.0.0.1".into(), "ssh-ed25519".into(), key_of("old"));
    mixdog_fsio::write(&mixdog_fsio::Unlaned, &file, format!("{}\n", old.line())).expect("written");
    let owner = owner_for("root@10.0.0.1");
    let replace = Replace {
        spec: "10.0.0.1".into(),
        file: file.clone(),
        claim: Claim::new(owner, "10.0.0.1".into(), "ssh-ed25519".into(), key_of("new")),
        host: "10.0.0.1".into(),
        old_key: key_of("old"),
        shown: Vec::new(),
    };
    let inspection = HostKeyInspection { replace: Some(replace), ..pin_of(&file, "x", "y") };
    replace_host_key(&inspection).await.expect("replaced");
    assert_eq!(text(&file), format!("10.0.0.1 ssh-ed25519 {} mixdog-pin-v1={other}\n", key_of("new")));
    // An entry Mixdog did not write is for the user to review.
    mixdog_fsio::write(&mixdog_fsio::Unlaned, &file, ed("old")).expect("written");
    let failure = replace_host_key(&inspection).await.expect_err("refused");
    assert!(failure.message.contains("by hand"), "{}", failure.message);
    assert_eq!(text(&file), ed("old"));
}

#[cfg(windows)]
#[tokio::test]
async fn the_jump_host_key_scan_runs_from_a_folder_without_spaces_a_windows_temp_folder_with_spaces_falls_back_to_a_locked_down_programdata_folder() {
    let folder = temp();
    let program_data = folder.path().to_str().expect("a path").to_owned();
    let tools = quiet();
    let vars = [("ProgramData", program_data.as_str()), ("TMP", "C:\\Users\\John Doe\\AppData\\Local\\Temp"), ("USERNAME", "John Doe")];
    let env = env_with(Platform::Windows, &vars, MemFiles::with(&[]), tools.clone());
    let dir = private_scan_dir(&env).await.expect("a folder");
    assert!(dir.starts_with(Path::new(&program_data).join("mixdog-ssh-scan-John_Doe")));
    assert!(!dir.to_string_lossy()[program_data.len()..].contains(char::is_whitespace));
    // The shared parent is locked first, then the random folder, before anything is written into it.
    let lock =
        |path: &Path| vec!["icacls".to_owned(), path.to_string_lossy().into_owned(), "/inheritance:r".into(), "/grant:r".into(), "John Doe:(OI)(CI)F".into()];
    assert_eq!(tools.calls(), vec![lock(dir.parent().expect("a parent")), lock(&dir)]);
    let denied = Tools::new(|_, _| Ok(ToolOutput { exit_code: Some(5), stdout: String::new(), stderr: "Access is denied.".into() }));
    let refused = env_with(Platform::Windows, &vars, MemFiles::with(&[]), denied);
    assert!(private_scan_dir(&refused).await.expect_err("locked out").to_string().contains("Access is denied"));
}

#[tokio::test]
async fn the_jump_host_key_scan_in_a_temp_folder_without_spaces_makes_a_plain_subfolder_and_runs_no_lock() {
    let folder = temp();
    let tmp = folder.path().to_str().expect("a path").to_owned();
    let tools = quiet();
    let env = env_with(Platform::Windows, &[("TMP", tmp.as_str()), ("USERNAME", "jdoe")], MemFiles::with(&[]), tools.clone());
    let dir = private_scan_dir(&env).await.expect("a folder");
    assert_eq!(dir.parent(), Some(folder.path()));
    assert!(dir.file_name().expect("a name").to_string_lossy().starts_with("mxk-"));
    assert!(dir.is_dir());
    assert_eq!(tools.calls(), Vec::<Vec<String>>::new(), "no icacls: the temp folder is already the user's");
}

// ---- Mixdog's own ssh config ----

fn data_vars(folder: &Path) -> Vec<(String, String)> {
    vec![("MIXDOG_DATA_DIR".to_owned(), folder.to_string_lossy().into_owned())]
}

fn disk_env(folder: &Path, extra: &[(&str, &str)]) -> SshEnv {
    let mut vars: Vec<(String, String)> = data_vars(folder);
    vars.extend(extra.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())));
    let refs: Vec<(&str, &str)> = vars.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    let mut env = on_disk(&refs, quiet());
    env.home = folder.join("home");
    env
}

#[tokio::test]
async fn mixdog_keeps_its_own_known_hosts_new_pins_land_there_and_the_config_lists_it_before_the_users_files() {
    let folder = temp();
    let env = disk_env(folder.path(), &[]);
    let configured = MixdogSshConfig::configure(&env).await.expect("configured");
    assert_eq!(configured.known_hosts_file(), folder.path().join("ssh").join("known_hosts"));
    assert_eq!(configured.config_file(), folder.path().join("ssh").join("config"));
    assert_eq!(configured.generic(), Some(configured.config_file().to_path_buf()));
    assert_eq!(configured.for_args(&["-G".to_owned()]), None);
    let own = normalized(configured.known_hosts_file());
    let config = normalized(configured.config_file());
    let body = text(configured.config_file());
    assert!(body.starts_with(&format!("# Written by Mixdog; rewritten on every start.\nHost *\n  UpdateHostKeys no\n  StrictHostKeyChecking yes\n  UserKnownHostsFile \"{own}\" ~/.ssh/known_hosts ~/.ssh/known_hosts2\n")), "{body}");
    assert!(body.contains("\nInclude \"") && body.ends_with(".ssh/config\"\n") && !config.is_empty());
    // A custom file the user's config names for a server is kept in the list, once.
    let custom = normalized(&env.home.join("work").join("hosts"));
    let list = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
    configured.register_user_known_hosts(&list(&[custom.as_str(), custom.as_str(), "~/.ssh/known_hosts", "none"])).await.expect("registered");
    let body = text(configured.config_file());
    assert_eq!(body.matches(custom.as_str()).count(), 1);
    assert!(!body.contains("none"));
    // The default files (also spelled out with the home folder) and Mixdog's own file are not added again.
    let spelled = normalized(&env.home.join(".ssh").join("known_hosts2"));
    configured.register_user_known_hosts(&list(&[spelled.as_str(), own.as_str()])).await.expect("registered");
    assert_eq!(text(configured.config_file()), body);
    // A pin goes to Mixdog's file; the user's own file is never touched.
    let user_file = env.home.join(".ssh").join("known_hosts");
    pin_host_key(&pin_of(configured.known_hosts_file(), "h", "AAAA")).await.expect("pinned");
    assert_eq!(text(configured.known_hosts_file()), format!("{}\n", pin_line("h", "AAAA")));
    assert!(!mixdog_fsio::exists(&mixdog_fsio::Unlaned, &user_file).expect("a check"));
}

#[tokio::test]
async fn the_user_files_of_the_config_are_capped_at_sixteen() {
    let folder = temp();
    let configured = MixdogSshConfig::configure(&disk_env(folder.path(), &[])).await.expect("configured");
    let many: Vec<String> = (0..20).map(|number| format!("/keys/file{number}")).collect();
    configured.register_user_known_hosts(&many).await.expect("registered");
    let body = text(configured.config_file());
    assert!(body.contains("/keys/file15\"") && !body.contains("/keys/file16\""));
}

#[tokio::test]
async fn a_registration_that_could_not_be_published_is_not_remembered_so_the_next_one_publishes_it() {
    let folder = temp();
    let configured = MixdogSshConfig::configure(&disk_env(folder.path(), &[])).await.expect("configured");
    let custom = vec!["/keys/custom".to_owned()];
    // A folder where the config file is: the replacement cannot be renamed over it.
    let config = configured.config_file().to_path_buf();
    std::fs::remove_file(&config).expect("removed");
    std::fs::create_dir(&config).expect("a folder in its place");
    configured.register_user_known_hosts(&custom).await.expect_err("not published");
    std::fs::remove_dir(&config).expect("removed");

    configured.register_user_known_hosts(&custom).await.expect("registered");
    assert!(text(&config).contains("/keys/custom\""), "the file the failed registration named is published now");
}

#[test]
fn the_config_words_quote_paths_with_spaces_and_non_ascii_characters() {
    let body = mixdog_ssh_config_text("C:\\Users\\김 철수\\ssh\\known_hosts", &["D:\\내 키\\hosts".to_owned()], Path::new("C:\\Users\\김 철수"));
    assert!(body.contains("UserKnownHostsFile \"C:/Users/김 철수/ssh/known_hosts\" ~/.ssh/known_hosts ~/.ssh/known_hosts2 \"D:/내 키/hosts\"\n"));
    assert!(body.contains("Include \"C:/Users/김 철수/.ssh/config\"\n"));
}

// ---- the desktop's old known_hosts ----

fn write_legacy(root: &Path, content: &str) -> PathBuf {
    let old = root.join("old-profile");
    mixdog_fsio::create_dir_all(&mixdog_fsio::Unlaned, old.join("ssh")).expect("a folder");
    mixdog_fsio::write(&mixdog_fsio::Unlaned, old.join("ssh").join("known_hosts"), content).expect("written");
    old
}

#[tokio::test]
async fn legacy_import_appends_only() {
    let folder = temp();
    let env = disk_env(&folder.path().join("data"), &[]);
    let configured = MixdogSshConfig::configure(&env).await.expect("configured");
    let pinned = format!("10.0.0.1 ssh-ed25519 {}", key_of("mine"));
    mixdog_fsio::write(&mixdog_fsio::Unlaned, configured.known_hosts_file(), &pinned).expect("written");
    let old_text =
        format!("# old\n\n{pinned}\n10.0.0.2 ssh-ed25519 {}\n@revoked * ssh-rsa {}\n10.0.0.1 ssh-ed25519 {}\n", key_of("b"), key_of("r"), key_of("rotated"));
    let old = write_legacy(folder.path(), &old_text);
    let added = configured.import_legacy_known_hosts(&env, &old).await.expect("imported");
    assert_eq!(added, 3);
    // Nothing of Mixdog's own file is removed or replaced (a different key for a pinned host is added beside it), and the old file stays.
    assert_eq!(
        text(configured.known_hosts_file()),
        format!("{pinned}\n10.0.0.2 ssh-ed25519 {}\n@revoked * ssh-rsa {}\n10.0.0.1 ssh-ed25519 {}\n", key_of("b"), key_of("r"), key_of("rotated"))
    );
    assert_eq!(text(&old.join("ssh").join("known_hosts")), old_text);
}

#[tokio::test]
async fn legacy_import_once() {
    let folder = temp();
    let env = disk_env(&folder.path().join("data"), &[]);
    let configured = MixdogSshConfig::configure(&env).await.expect("configured");
    let old = write_legacy(folder.path(), &format!("10.0.0.2 ssh-ed25519 {}\n", key_of("b")));
    assert_eq!(configured.import_legacy_known_hosts(&env, &old).await.expect("imported"), 1);
    assert!(mixdog_fsio::exists(&mixdog_fsio::Unlaned, configured.dir().join(".legacy-imported")).expect("a check"));
    mixdog_fsio::write(&mixdog_fsio::Unlaned, old.join("ssh").join("known_hosts"), format!("10.0.0.3 ssh-ed25519 {}\n", key_of("c"))).expect("written");
    assert_eq!(configured.import_legacy_known_hosts(&env, &old).await.expect("imported"), 0);
    assert_eq!(text(configured.known_hosts_file()), format!("10.0.0.2 ssh-ed25519 {}\n", key_of("b")));
    // No old folder at all: nothing to import, and the marker keeps later starts from looking again.
    let other = temp();
    let env = disk_env(&other.path().join("data"), &[]);
    let fresh = MixdogSshConfig::configure(&env).await.expect("configured");
    assert_eq!(fresh.import_legacy_known_hosts(&env, &other.path().join("absent")).await.expect("imported"), 0);
    assert!(mixdog_fsio::exists(&mixdog_fsio::Unlaned, fresh.dir().join(".legacy-imported")).expect("a check"));
}

#[tokio::test]
async fn legacy_import_does_not_create_the_old_folder_it_looks_for() {
    let folder = temp();
    let data = folder.path().join("data");
    let vars = [("MIXDOG_DATA_DIR", data.to_str().expect("a path")), ("USERNAME", "jdoe")];
    let env = env_with(Platform::Windows, &vars, Arc::new(LaneFiles(&mixdog_fsio::Unlaned)), quiet());
    let configured = MixdogSshConfig::configure(&env).await.expect("configured");
    // A path with a space is resolved through the 8.3 form, which needs the folder: it is not made for a read.
    let absent = folder.path().join("old desktop data");
    assert_eq!(configured.import_legacy_known_hosts(&env, &absent).await.expect("imported"), 0);
    assert!(!absent.exists(), "the old folder was created");
}

#[tokio::test]
async fn configure_merges_the_desktops_known_hosts_when_its_folder_is_named() {
    let folder = temp();
    let old = write_legacy(folder.path(), &format!("10.0.0.2 ssh-ed25519 {}\n", key_of("b")));
    let env = disk_env(&folder.path().join("data"), &[("MIXDOG_DESKTOP_USER_DATA", old.to_str().expect("a path"))]);
    let configured = MixdogSshConfig::configure(&env).await.expect("configured");
    assert_eq!(text(configured.known_hosts_file()), format!("10.0.0.2 ssh-ed25519 {}\n", key_of("b")));
}

#[tokio::test]
async fn the_ssh_folder_is_locked_to_the_user_once_and_a_later_start_runs_no_icacls() {
    let folder = temp();
    let data = folder.path().to_str().expect("a path").to_owned();
    let vars = [("MIXDOG_DATA_DIR", data.as_str()), ("USERNAME", "jdoe")];
    let first = quiet();
    let env = env_with(Platform::Windows, &vars, Arc::new(LaneFiles(&mixdog_fsio::Unlaned)), first.clone());
    MixdogSshConfig::configure(&env).await.expect("configured");
    assert_eq!(first.named("icacls").len(), 1, "the folder is locked at the first start");
    let second = quiet();
    let env = env_with(Platform::Windows, &vars, Arc::new(LaneFiles(&mixdog_fsio::Unlaned)), second.clone());
    MixdogSshConfig::configure(&env).await.expect("configured");
    assert!(second.named("icacls").is_empty(), "a folder already locked to this user is not locked again");
    // Another account is another lock.
    let other = quiet();
    let vars = [("MIXDOG_DATA_DIR", data.as_str()), ("USERNAME", "someone")];
    let env = env_with(Platform::Windows, &vars, Arc::new(LaneFiles(&mixdog_fsio::Unlaned)), other.clone());
    MixdogSshConfig::configure(&env).await.expect("configured");
    assert_eq!(other.named("icacls").len(), 1);
}

#[tokio::test]
async fn a_failed_lock_leaves_no_marker_so_the_next_start_tries_again() {
    let folder = temp();
    let data = folder.path().to_str().expect("a path").to_owned();
    let vars = [("MIXDOG_DATA_DIR", data.as_str()), ("USERNAME", "jdoe")];
    let denied = Tools::new(|_, _| Ok(ToolOutput { exit_code: Some(5), stdout: String::new(), stderr: "Access is denied.".into() }));
    let env = env_with(Platform::Windows, &vars, Arc::new(LaneFiles(&mixdog_fsio::Unlaned)), denied);
    assert!(MixdogSshConfig::configure(&env).await.is_err());
    let again = quiet();
    let env = env_with(Platform::Windows, &vars, Arc::new(LaneFiles(&mixdog_fsio::Unlaned)), again.clone());
    MixdogSshConfig::configure(&env).await.expect("configured");
    assert_eq!(again.named("icacls").len(), 1);
}
