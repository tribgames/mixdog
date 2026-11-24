//! Tests of the per-target ssh config (cases of the desktop's `ssh-resolved-config.test.mjs`). `ssh -G` is scripted
//! and, for a run with `-F`, reads the generated file back; no process starts.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use super::*;
use crate::command::parse_ssh_target;
use crate::context::{ConfigFiles, LaneFiles, Platform, PreparedSpawn, SshChild, SshSpawner, ToolRunner};
use crate::diagnostics::Diagnostics;

fn dump(extra: &str) -> String {
    format!(
        "user ops\nhostname 10.0.0.9\nport 22\nidentityfile ~/.ssh/id_ed25519\nforwardagent yes\nforwardx11 yes\nlocalforward [127.0.0.1]:8080 [127.0.0.1]:80\nremoteforward [0.0.0.0]:9 [127.0.0.1]:9\ndynamicforward [127.0.0.1]:1080\npermitlocalcommand yes\nlocalcommand echo hi\nuserknownhostsfile ~/.ssh/known_hosts\nserveraliveinterval 30\n{extra}"
    )
}

const FORWARDS: [&str; 3] = ["local [127.0.0.1]:8080 [127.0.0.1]:80", "remote [0.0.0.0]:9 [127.0.0.1]:9", "dynamic [127.0.0.1]:1080"];

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

/// An ssh stand-in: `ssh -G` answers from the user's config (by destination), `ssh -G -F <file>` reads the generated
/// file back. `faithful: false` makes the generated file say something else than what was resolved.
struct Ssh {
    dumps: BTreeMap<String, String>,
    faithful: bool,
    fail: bool,
    /// Told when the generated config is being checked, and the check then never answers.
    stuck_check: Option<Arc<tokio::sync::Notify>>,
    calls: Mutex<Vec<Vec<String>>>,
}

impl Ssh {
    fn new(dumps: &[(&str, String)]) -> Arc<Self> {
        Arc::new(Self {
            dumps: dumps.iter().map(|(destination, text)| ((*destination).to_owned(), text.clone())).collect(),
            faithful: true,
            fail: false,
            stuck_check: None,
            calls: Mutex::new(Vec::new()),
        })
    }

    fn unfaithful(dumps: &[(&str, String)]) -> Arc<Self> {
        Arc::new(Self { faithful: false, ..Arc::try_unwrap(Self::new(dumps)).ok().expect("one owner") })
    }

    fn failing() -> Arc<Self> {
        Arc::new(Self { fail: true, ..Arc::try_unwrap(Self::new(&[])).ok().expect("one owner") })
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().map(|calls| calls.clone()).unwrap_or_default()
    }
}

/// The lines of the `Host "<name>"` block of a generated config.
fn block_of(text: &str, name: &str) -> Vec<String> {
    let head = format!("Host \"{name}\"");
    let mut inside = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        if line.starts_with("Host ") {
            inside = line == head;
        } else if inside && !line.trim().is_empty() {
            lines.push(line.trim().to_owned());
        }
    }
    lines
}

#[async_trait]
impl ToolRunner for Ssh {
    async fn run(&self, _command: &Path, args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(args.to_vec());
        }
        if self.fail {
            return Ok(ToolOutput { exit_code: Some(255), stdout: String::new(), stderr: "boom".to_owned() });
        }
        let destination = args.last().cloned().unwrap_or_default();
        if let (Some(stuck), Some("-F")) = (&self.stuck_check, args.get(1).map(String::as_str)) {
            stuck.notify_one();
            std::future::pending::<()>().await;
        }
        let stdout = if args.get(1).map(String::as_str) == Some("-F") {
            if !self.faithful {
                "user nobody\n".to_owned()
            } else {
                let text = std::fs::read_to_string(&args[2])?;
                block_of(&text, destination.rsplit('@').next().unwrap_or_default()).join("\n")
            }
        } else {
            self.dumps.get(&destination).cloned().unwrap_or_default()
        };
        Ok(ToolOutput { exit_code: Some(0), stdout, stderr: String::new() })
    }
}

fn env_for(folder: &Path, tools: Arc<Ssh>) -> SshEnv {
    SshEnv {
        platform: Platform::Linux,
        env: BTreeMap::from([("MIXDOG_DATA_DIR".to_owned(), folder.to_string_lossy().into_owned())]),
        home: PathBuf::from("/home/tester"),
        askpass_helper: None,
        server_cores_dir: None,
        files: Arc::new(LaneFiles(&mixdog_fsio::Unlaned)) as Arc<dyn ConfigFiles + Send + Sync>,
        config_files: Arc::new(NoConfig),
        tools,
        spawner: Arc::new(NoSpawn),
        diagnostics: Arc::new(Diagnostics::new()),
    }
}

async fn configured(folder: &Path, tools: &Arc<Ssh>) -> (SshEnv, Arc<ResolvedConfigs>) {
    let env = env_for(folder, Arc::clone(tools));
    let config = MixdogSshConfig::configure(&env).await.expect("configured");
    (env, ResolvedConfigs::new(config))
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

fn text(path: &Path) -> String {
    String::from_utf8_lossy(&mixdog_fsio::read(&mixdog_fsio::Unlaned, path).expect("a readable file")).into_owned()
}

fn target(raw: &str) -> SshTarget {
    parse_ssh_target(raw).expect("a valid target")
}

/// The config written for an inspection that could read the server, held as the attempt holds it.
#[derive(Debug)]
struct Found {
    file: PathBuf,
    /// The route's own options (else the user's config as read).
    generated: bool,
    forwards: Vec<String>,
    reviewed: ReviewedConfig,
}

/// Resolves the route once and writes the config from it, as an inspection that could read the server does.
async fn resolve(configs: &ResolvedConfigs, env: &SshEnv, target: &SshTarget) -> Found {
    let ctx = AttemptContext::default();
    let route = crate::host_key::resolve_route(env, &ctx, target).await.expect("a route");
    let user_config = env.files.read_text(&env.home.join(".ssh").join("config"));
    let (reviewed, forwards) = configs.write_reviewed(env, &ctx, target, &route, user_config.as_deref()).await.expect("written");
    let file = reviewed.file.as_ref().expect("a file").path().to_path_buf();
    Found { generated: text(&file).starts_with(GENERATED_HEADER), file, forwards, reviewed }
}

/// The generated files of the ssh folder.
fn generated(folder: &Path) -> Vec<String> {
    mixdog_fsio::read_dir(&mixdog_fsio::Unlaned, folder.join("ssh"))
        .expect("a folder")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("t-"))
        .collect()
}

fn name_of(path: &Path) -> String {
    path.file_name().expect("a name").to_string_lossy().into_owned()
}

#[test]
fn the_generated_block_carries_every_resolved_option_except_forwarding_ones_with_mixdogs_known_hosts_first() {
    let lines = parse_dump(&dump(""));
    let host = ResolvedHost {
        hostname: "10.0.0.9".to_owned(),
        port: 22,
        user: None,
        known_hosts_files: vec!["/h/.ssh/known_hosts".to_owned()],
        global_known_hosts_files: vec!["/etc/ssh/ssh_known_hosts".to_owned()],
        host_key_algorithms: Vec::new(),
        host_key_signatures: Vec::new(),
        proxy_jump: None,
        proxy_command: false,
        proxied: false,
        forwards: Vec::new(),
    };
    let body = resolved_block_text("gate", &lines, &host, "/data/known_hosts");
    assert!(body.starts_with(
        "Host \"gate\"\n  UpdateHostKeys no\n  StrictHostKeyChecking yes\n  UserKnownHostsFile \"/data/known_hosts\" \"/h/.ssh/known_hosts\"\n  GlobalKnownHostsFile \"/etc/ssh/ssh_known_hosts\"\n"
    ));
    let kept: Vec<&str> = body.lines().map(str::trim).collect();
    for wanted in ["user ops", "hostname 10.0.0.9", "identityfile ~/.ssh/id_ed25519", "serveraliveinterval 30"] {
        assert!(kept.contains(&wanted), "{wanted}");
    }
    for gone in ["forward", "localcommand", "permitlocalcommand"] {
        assert!(!kept.iter().any(|line| line.contains(gone)), "{gone}");
    }
    // A key file with spaces, printed bare by some builds, is quoted.
    let spaced = resolved_block_text("g", &parse_dump("identityfile C:/Users/John Doe/.ssh/id\n"), &host, "/k");
    assert!(spaced.contains("identityfile \"C:/Users/John Doe/.ssh/id\""));
}

#[tokio::test]
async fn a_faithful_per_target_config_replaces_the_users_and_every_ssh_of_the_target_uses_it() {
    let folder = tempfile::tempdir().expect("a folder");
    let tools = Ssh::new(&[("ops@gate", dump(""))]);
    let (env, configs) = configured(folder.path(), &tools).await;
    let found = resolve(&configs, &env, &target("ops@gate")).await;
    assert!(found.generated);
    assert!(found.forwards.is_empty(), "no forward of the user's applies");
    assert!(found.file.starts_with(folder.path()));
    let body = text(&found.file);
    assert!(!body.to_lowercase().contains("include"), "the user's config is not included");
    assert!(!body.contains("localforward") && !body.contains("remoteforward") && !body.contains("dynamicforward"));
    // exec, probe and tunnel arguments all pick it; other targets and ports do not.
    let own = Some(found.file.clone());
    assert_eq!(configs.for_args(&args(&["-o", "BatchMode=yes", "-T", "--", "ops@gate", "true"])), own);
    assert_eq!(configs.for_args(&args(&["-N", "-L", "1:2:3", "--", "ops@gate"])), own);
    assert_eq!(configs.for_args(&args(&["-p", "2200", "--", "ops@gate", "true"])), None);
    assert_eq!(configs.for_args(&args(&["--", "ops@other", "true"])), None);
    assert_eq!(configs.for_args(&args(&["-G"])), None);
    assert_eq!(configs.generic(), Some(folder.path().join("ssh").join("config")));
}

#[tokio::test]
async fn targets_that_differ_only_in_host_case_share_one_config_and_one_removed_by_hand_is_still_named_so_ssh_refuses() {
    let folder = tempfile::tempdir().expect("a folder");
    let tools = Ssh::new(&[("ops@BOX", dump(""))]);
    let (env, configs) = configured(folder.path(), &tools).await;
    let found = resolve(&configs, &env, &target("ops@BOX")).await;
    let owner = crate::pins::owner_of(&target("ops@box"));
    let name = name_of(&found.file);
    assert!(name.starts_with(&format!("t-v2-{owner}-")) && name.ends_with(".conf"), "{name}");
    assert_eq!(configs.for_args(&args(&["--", "ops@box", "true"])), Some(found.file.clone()));
    assert_eq!(configs.for_args(&args(&["--", "Ops@box", "true"])), None, "the user name keeps its case");
    mixdog_fsio::remove_file(&mixdog_fsio::Unlaned, &found.file).expect("removed");
    assert_eq!(configs.for_args(&args(&["--", "ops@box", "true"])), Some(found.file.clone()), "never another config instead");
}

#[tokio::test]
async fn a_target_with_an_explicit_port_gets_its_own_file_found_by_that_port() {
    let folder = tempfile::tempdir().expect("a folder");
    let tools = Ssh::new(&[("ops@gate", dump(""))]);
    let (env, configs) = configured(folder.path(), &tools).await;
    let plain = resolve(&configs, &env, &target("ops@gate")).await;
    let ported = resolve(&configs, &env, &target("ops@gate:2200")).await;
    assert_ne!(plain.file, ported.file);
    assert_eq!(configs.for_args(&args(&["-p", "2200", "--", "ops@gate", "true"])), Some(ported.file));
    assert_eq!(configs.for_args(&args(&["--", "ops@gate", "true"])), Some(plain.file));
    assert!(tools.calls().iter().any(|call| call.starts_with(&args(&["-G", "-p", "2200"]))));
}

#[tokio::test]
async fn each_proxy_jump_hop_gets_its_own_resolved_block_so_the_hops_ssh_resolves_from_the_same_file() {
    let folder = tempfile::tempdir().expect("a folder");
    let tools = Ssh::new(&[
        ("ops@inner", dump("proxyjump jump@bastion:2200\n")),
        ("jump@bastion", "user jump\nhostname bastion.example.com\nport 2200\nlocalforward [127.0.0.1]:1 [127.0.0.1]:2\nserveraliveinterval 15\n".to_owned()),
    ]);
    let (env, configs) = configured(folder.path(), &tools).await;
    let found = resolve(&configs, &env, &target("ops@inner")).await;
    let body = text(&found.file);
    assert!(block_of(&body, "inner").iter().any(|line| line == "proxyjump jump@bastion:2200"));
    let hop = block_of(&body, "bastion");
    assert!(hop.iter().any(|line| line == "hostname bastion.example.com") && hop.iter().any(|line| line == "port 2200"));
    assert!(!body.contains("localforward"), "a hop's forwards are left out too");
    assert!(tools.calls().iter().any(|call| call.first().map(String::as_str) == Some("-G") && call.last().map(String::as_str) == Some("jump@bastion")));
}

#[tokio::test]
async fn one_resolution_of_the_route_is_what_the_config_is_written_from() {
    let folder = tempfile::tempdir().expect("a folder");
    let tools = Ssh::new(&[("ops@inner", dump("proxyjump jump@bastion\n")), ("jump@bastion", "user jump\nhostname bastion.example.com\nport 22\n".to_owned())]);
    let (env, configs) = configured(folder.path(), &tools).await;
    resolve(&configs, &env, &target("ops@inner")).await;
    let reads = |destination: &str| {
        tools
            .calls()
            .iter()
            .filter(|call| {
                call.first().map(String::as_str) == Some("-G")
                    && call.get(1).map(String::as_str) != Some("-F")
                    && call.last().map(String::as_str) == Some(destination)
            })
            .count()
    };
    assert_eq!((reads("ops@inner"), reads("jump@bastion")), (1, 1), "each server of the route is resolved once");
}

#[tokio::test]
async fn when_the_generated_config_cannot_say_what_ssh_resolved_the_attempt_gets_the_users_config_as_it_was_read() {
    let folder = tempfile::tempdir().expect("a folder");
    let tools = Ssh::unfaithful(&[("ops@gate", dump(""))]);
    let mut env = env_for(folder.path(), Arc::clone(&tools));
    env.home = folder.path().join("home");
    std::fs::create_dir_all(env.home.join(".ssh")).expect("a folder");
    std::fs::write(env.home.join(".ssh").join("config"), "Host gate\n  HostName 10.0.0.9\n").expect("written");
    let configs = ResolvedConfigs::new(MixdogSshConfig::configure(&env).await.expect("configured"));
    let found = resolve(&configs, &env, &target("ops@gate")).await;
    assert!(!found.generated);
    assert_eq!(found.forwards, FORWARDS);
    // Later changes of the user's config are not what this attempt reviewed.
    std::fs::write(env.home.join(".ssh").join("config"), "Host gate\n  HostName 10.6.6.6\n").expect("changed");
    let body = text(&found.file);
    assert!(body.contains("HostName 10.0.0.9") && !body.contains("10.6.6.6") && !body.to_lowercase().contains("include"), "{body}");
    assert!(block_of(&body, "gate").iter().any(|line| line.starts_with("UserKnownHostsFile")), "the server's known_hosts files come first");
    assert_eq!(configs.for_args(&args(&["--", "ops@gate", "true"])), Some(found.file.clone()));
    assert_eq!(generated(folder.path()), vec![name_of(&found.file)], "the file that failed the check is not left behind");
}

#[tokio::test]
async fn a_reviewed_config_lives_while_something_holds_it_and_is_removed_after() {
    let folder = tempfile::tempdir().expect("a folder");
    let (env, configs) = configured(folder.path(), &Ssh::new(&[("ops@gate", dump(""))])).await;
    let gate = target("ops@gate");
    let first = resolve(&configs, &env, &gate).await;
    let reviewed = text(&first.file);

    // A second inspection of the target, after the user's config changed: another file, the first one untouched while its
    // attempt holds it.
    let changed = env_for(folder.path(), Ssh::new(&[("ops@gate", dump("serveraliveinterval 45\n"))]));
    let second = resolve(&configs, &changed, &gate).await;
    assert_ne!(second.file, first.file);
    assert_eq!(text(&first.file), reviewed);
    assert_eq!(configs.for_args(&args(&["--", "ops@gate", "true"])), Some(second.file.clone()));

    let first_file = first.file.clone();
    drop(first);
    assert!(!first_file.exists(), "nothing holds the first one any more");
    assert_eq!(generated(folder.path()), vec![name_of(&second.file)]);
    drop(second.reviewed);
    assert!(second.file.exists(), "the selection still holds the second");
}

#[tokio::test]
async fn a_resolution_dropped_while_its_config_is_being_checked_leaves_no_file() {
    let folder = tempfile::tempdir().expect("a folder");
    let checking = Arc::new(tokio::sync::Notify::new());
    let tools = Arc::new(Ssh { stuck_check: Some(checking.clone()), ..Arc::try_unwrap(Ssh::new(&[("ops@gate", dump(""))])).ok().expect("one owner") });
    let (env, configs) = configured(folder.path(), &tools).await;
    let gate = target("ops@gate");
    tokio::select! {
        _ = resolve(&configs, &env, &gate) => panic!("the check never answers"),
        () = checking.notified() => {}
    }
    // The caller went away mid-check: the file it was checking is gone with it.
    let left = generated(folder.path());
    assert!(left.is_empty(), "nothing of the dropped resolution is left: {left:?}");
    assert_eq!(configs.for_args(&args(&["--", "ops@gate", "true"])), None);
}

#[tokio::test]
async fn a_failing_ssh_reads_no_route_and_writes_nothing() {
    let folder = tempfile::tempdir().expect("a folder");
    let tools = Ssh::failing();
    let (env, _configs) = configured(folder.path(), &tools).await;
    assert!(crate::host_key::resolve_route(&env, &AttemptContext::default(), &target("ops@gate")).await.is_err());
    assert!(generated(folder.path()).is_empty());
}

#[tokio::test]
async fn a_path_that_ssh_printed_lossily_is_not_carried_and_the_users_config_applies() {
    let folder = tempfile::tempdir().expect("a folder");
    let lossy = dump("identityfile C:/Users/? ?/.ssh/id\n");
    let tools = Ssh::new(&[("ops@gate", lossy)]);
    let (env, configs) = configured(folder.path(), &tools).await;
    let found = resolve(&configs, &env, &target("ops@gate")).await;
    assert!(!found.generated);
    assert_eq!(found.forwards, FORWARDS);
}

#[tokio::test]
async fn a_route_longer_than_six_servers_and_a_loop_of_hops_are_handled() {
    let folder = tempfile::tempdir().expect("a folder");
    // h0 -> h1 -> ... -> h6: seven servers, more than the cap.
    let chain: Vec<(String, String)> = (0..7).map(|n| (format!("h{n}"), dump(&format!("proxyjump h{}\n", n + 1)))).collect();
    let pairs: Vec<(&str, String)> = chain.iter().map(|(name, text)| (name.as_str(), text.clone())).collect();
    let tools = Ssh::new(&pairs);
    let (env, configs) = configured(folder.path(), &tools).await;
    assert!(!resolve(&configs, &env, &target("h0")).await.generated, "too long to write out");
    // A hop that names a server of the route again is not resolved twice.
    let looped = Ssh::new(&[("a", dump("proxyjump b\n")), ("b", dump("proxyjump a\n"))]);
    let (env, configs) = configured(folder.path(), &looped).await;
    let found = resolve(&configs, &env, &target("a")).await;
    let body = text(&found.file);
    assert_eq!(body.matches("Host \"a\"").count(), 1);
    assert_eq!(body.matches("Host \"b\"").count(), 1);
}

#[tokio::test]
async fn a_machine_without_mixdogs_config_names_no_file() {
    let tools = Ssh::new(&[("ops@10.0.0.9", dump(""))]);
    let folder = tempfile::tempdir().expect("a folder");
    let env = env_for(folder.path(), tools);
    let configs = ResolvedConfigs::without_config();
    assert_eq!(configs.generic(), None);
    let target = parse_ssh_target("ops@10.0.0.9").expect("a target");
    let route = crate::host_key::resolve_route(&env, &AttemptContext::default(), &target).await.expect("a route");
    let (reviewed, _) = configs.write_reviewed(&env, &AttemptContext::default(), &target, &route, None).await.expect("nothing to write");
    assert_eq!(reviewed.file, None);
    assert_eq!(configs.for_args(&args(&["-p", "22", "--", "ops@10.0.0.9"])), None);
}
