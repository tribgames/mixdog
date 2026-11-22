//! The pins Mixdog writes in its own known_hosts, the state lock every writer takes, and the import of the desktop's old file. No
//! test here lets ssh run except the one that checks OpenSSH reads what is written.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

use super::*;
use crate::command::parse_ssh_target;
use crate::context::{ConfigFiles, LaneFiles, Platform, PreparedSpawn, SshChild, SshConfigFiles, SshEnv, SshSpawner, ToolOutput, ToolRunner};
use crate::diagnostics::Diagnostics;
use crate::mixdog_config::{MixdogSshConfig, with_state_lock};

/// `MixdogSshConfig::current` is process-wide: the tests that configure it take turns.
static TURN: Mutex<()> = Mutex::new(());

fn owner(raw: &str) -> String {
    owner_of(&parse_ssh_target(raw).expect("a target"))
}

fn claim(owner: &str, spec: &str, key: &str) -> Claim {
    Claim { owner: owner.to_owned(), spec: spec.to_owned(), key_type: "ssh-ed25519".to_owned(), key: key.to_owned() }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn identity_is_the_target_key_not_the_spelling() {
    assert_eq!(owner("ops@BOX"), owner("ops@box"));
    assert_ne!(owner("Ops@box"), owner("ops@box"), "the user name keeps its case");
    assert_ne!(owner("ops@box:22"), owner("ops@box"), "an explicit port is not an omitted one");
    assert_eq!(owner("ops@box").len(), 64);
}

#[test]
fn a_key_another_server_already_pinned_is_written_once_as_it_was() {
    let (a, b) = (owner("a@one"), owner("b@two"));
    // A pinned J; B confirms the same key of J.
    let file = add_claims(b"", &[claim(&a, "j.example", "KJ"), claim(&a, "a1.example", "K1")]).unwrap().unwrap();
    let file = add_claims(&file, &[claim(&b, "j.example", "KJ"), claim(&b, "b.example", "KB")]).unwrap().unwrap();
    assert_eq!(text(&file).matches("j.example").count(), 1);
    assert!(text(&file).contains(&format!("j.example ssh-ed25519 KJ mixdog-pin-v1={a}\n")));
    assert_eq!(add_claims(&file, &[claim(&b, "j.example", "KJ")]).unwrap(), None, "the same key again changes nothing");
}

#[test]
fn entries_without_an_owner_survive_byte_for_byte() {
    let legacy: &[u8] = b"# note\r\n|1|c2FsdA==|aGFzaA== ssh-ed25519 KH\r\n[box.example]:2222 ssh-ed25519 KP\r\nx.example,y.example ssh-ed25519 KL\r\n*.example.com ssh-ed25519 KW\r\n!bad.example,* ssh-ed25519 KN\r\n@cert-authority *.corp ssh-ed25519 KC\r\n@revoked old.example ssh-ed25519 KR\r\nbox.example ssh-ed25519 KOLD\r\nlast.example ssh-ed25519 KLAST";
    let a = owner("a@one");
    // Claiming a key an unmarked pin already holds appends a managed copy and leaves the original alone.
    let grown = add_claims(legacy, &[claim(&a, "box.example", "KOLD")]).unwrap().unwrap();
    assert!(grown.starts_with(legacy));
    assert!(
        text(&grown).ends_with(&format!("ssh-ed25519 KLAST\nbox.example ssh-ed25519 KOLD mixdog-pin-v1={a}")),
        "the pin takes the last place, without an ending as the file had none"
    );

    // A claim never sits beside a different key for the endpoint, nor on a revoked one.
    assert_eq!(add_claims(legacy, &[claim(&a, "box.example", "KNEW")]), Err(StateError::Conflict));
    assert_eq!(add_claims(legacy, &[claim(&a, "old.example", "KR")]), Err(StateError::Conflict));
}

#[test]
fn a_mark_this_version_cannot_read_stops_the_operation_and_changes_nothing() {
    let a = owner("a@one");
    // Another version's mark is a newer app's entry; a malformed mark of this version is told apart from it.
    let newer = "h ssh-ed25519 K mixdog-pin-v2=abc\n";
    assert!(matches!(add_claims(newer.as_bytes(), &[claim(&a, "x", "K")]), Err(StateError::NewerVersion(_))));
    assert!(StateError::NewerVersion("x".into()).to_string().contains("newer version of the app"));
    for bad in [
        "h ssh-ed25519 K mixdog-pin-v1=NOTHEX\n",
        "h ssh-ed25519 K mixdog-pin-v1=\n",
        "h,i ssh-ed25519 K mixdog-pin-v1=0000000000000000000000000000000000000000000000000000000000000000\n",
    ] {
        assert!(matches!(add_claims(bad.as_bytes(), &[claim(&a, "x", "K")]), Err(StateError::Invalid(_))), "{bad}");
    }
}

#[test]
fn a_key_rotates_in_place_only_when_one_managed_pin_holds_it() {
    let (a, b) = (owner("a@one"), owner("b@two"));
    let pinned = add_claims(b"", &[claim(&a, "h.example", "KOLD")]).unwrap().unwrap();
    assert!(can_rotate(&pinned, "h.example", "ssh-ed25519"));
    let rotated = text(&rotate(&pinned, &claim(&b, "h.example", "KNEW"), "KOLD").unwrap());
    assert!(rotated.contains("h.example ssh-ed25519 KNEW") && !rotated.contains("KOLD"));
    assert!(rotated.contains(&format!("KNEW mixdog-pin-v1={a}")), "the mark is kept as written");
    // A listed entry of the same endpoint makes it a matter for review.
    assert!(!can_rotate(b"h.example,i.example ssh-ed25519 K\n", "h.example", "ssh-ed25519"));
    assert!(matches!(rotate(b"h.example,i.example ssh-ed25519 K\n", &claim(&a, "h.example", "K2"), "K"), Err(StateError::Manual(_))));
}

#[test]
fn an_imported_entry_loses_the_mark_it_came_with() {
    let a = owner("a@one");
    assert_eq!(strip_reserved(&format!("h ssh-ed25519 K mixdog-pin-v1={a}")), "h ssh-ed25519 K");
    assert_eq!(strip_reserved("h ssh-ed25519 K some comment"), "h ssh-ed25519 K some comment");
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

/// An ssh that fails the test when it runs.
struct NoSsh;

#[async_trait]
impl ToolRunner for NoSsh {
    async fn run(&self, _command: &Path, args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
        panic!("the import ran ssh: {args:?}");
    }
}

fn env_in(folder: &Path) -> SshEnv {
    SshEnv {
        platform: Platform::Linux,
        env: BTreeMap::from([("MIXDOG_DATA_DIR".to_owned(), folder.to_string_lossy().into_owned())]),
        // No readable home: the import must not need the user's ~/.ssh.
        home: folder.join("no-such-home"),
        askpass_helper: None,
        server_cores_dir: None,
        files: Arc::new(LaneFiles(&mixdog_fsio::Unlaned)) as Arc<dyn ConfigFiles + Send + Sync>,
        config_files: Arc::new(NoConfig),
        tools: Arc::new(NoSsh),
        spawner: Arc::new(NoSpawn),
        diagnostics: Arc::new(Diagnostics::new()),
    }
}

async fn configured() -> (tempfile::TempDir, Arc<MixdogSshConfig>) {
    let folder = tempfile::tempdir().expect("a folder");
    let config = MixdogSshConfig::configure(&env_in(folder.path())).await.expect("configured");
    (folder, config)
}

fn lines(config: &MixdogSshConfig) -> String {
    std::fs::read_to_string(config.known_hosts_file()).unwrap()
}

#[tokio::test]
async fn opening_the_ssh_state_at_start_up_removes_every_generated_config_and_nothing_else() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().join("ssh");
    std::fs::create_dir_all(&dir).unwrap();
    let header = "# Written by Mixdog from what ssh resolves for this server; forwards are left out.\nHost x\n";
    let generated = ["t-0123456789ab.conf", "t-v2-abc.conf", "t-v2-abc-0123456789abcdef.conf", "t-v2-abc.0123456789abcdef.cand"];
    for name in generated {
        std::fs::write(dir.join(name), header).unwrap();
    }
    std::fs::write(dir.join("t-aaaaaaaaaaaa.conf"), "someone else's file").unwrap();
    std::fs::write(dir.join("notes.txt"), header).unwrap();

    MixdogSshConfig::configure(&env_in(folder.path())).await.expect("configured");

    for gone in generated {
        assert!(!dir.join(gone).exists(), "{gone}");
    }
    for kept in ["t-aaaaaaaaaaaa.conf", "notes.txt"] {
        assert!(dir.join(kept).exists(), "{kept}");
    }
}

#[tokio::test]
async fn a_start_that_finds_the_generated_config_as_it_would_write_it_leaves_the_file_alone() {
    let (folder, config) = configured().await;
    let file = config.config_file().to_path_buf();
    let written = std::fs::read(&file).unwrap();
    let long_ago = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    std::fs::File::options().write(true).open(&file).unwrap().set_modified(long_ago).unwrap();

    MixdogSshConfig::configure(&env_in(folder.path())).await.expect("configured again");

    assert_eq!(std::fs::read(&file).unwrap(), written);
    assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), long_ago, "the unchanged config was written again");
}

/// The other process of the tests below: holds the state lock, says so, then waits for the file `release` (and publishes a claim)
/// or is killed by the parent. A plain test that does nothing unless the parent started it.
#[test]
fn state_lock_holder() {
    let Ok(dir) = std::env::var("MIXDOG_TEST_LOCK_DIR") else { return };
    let dir = PathBuf::from(dir);
    let publishes = std::env::var("MIXDOG_TEST_LOCK_PUBLISH").is_ok();
    with_state_lock(&dir, || {
        std::fs::write(dir.join("locked"), "1")?;
        while !dir.join("release").exists() {
            std::thread::sleep(Duration::from_millis(10));
        }
        if publishes {
            let held = read_state(&dir.join("known_hosts"))?;
            let next = add_claims(&held, &[claim(&owner("a@one"), "from-a.example", "KA")]).map_err(io::Error::other)?.unwrap_or(held);
            publish_file(&dir.join("known_hosts"), &next)?;
        }
        Ok(())
    })
    .unwrap();
}

fn start_holder(dir: &Path, publishes: bool) -> std::process::Child {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "pins::pins_tests::state_lock_holder", "--nocapture", "--test-threads=1"]).env("MIXDOG_TEST_LOCK_DIR", dir);
    if publishes {
        command.env("MIXDOG_TEST_LOCK_PUBLISH", "1");
    }
    command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap()
}

fn wait_for(path: &Path) {
    for _ in 0..1000 {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("{} never appeared", path.display());
}

#[test]
fn a_second_process_cannot_enter_while_the_first_holds_the_lock_and_sees_its_published_file() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().to_path_buf();
    std::fs::write(dir.join("known_hosts"), "old.example ssh-ed25519 KOLD\n").unwrap();
    let mut holder = start_holder(&dir, true);
    wait_for(&dir.join("locked"));

    let entered = Arc::new(Mutex::new(false));
    let contender = {
        let (dir, entered) = (dir.clone(), Arc::clone(&entered));
        std::thread::spawn(move || {
            with_state_lock(&dir, || {
                *entered.lock().unwrap() = true;
                let held = read_state(&dir.join("known_hosts"))?;
                let next = add_claims(&held, &[claim(&owner("b@two"), "from-b.example", "KB")]).map_err(io::Error::other)?.unwrap_or(held);
                publish_file(&dir.join("known_hosts"), &next)
            })
            .unwrap();
        })
    };
    std::thread::sleep(Duration::from_millis(400));
    assert!(!*entered.lock().unwrap(), "entered while the other process held the lock");
    std::fs::write(dir.join("release"), "1").unwrap();
    contender.join().unwrap();
    assert!(holder.wait().unwrap().success());
    let held = std::fs::read_to_string(dir.join("known_hosts")).unwrap();
    assert!(held.contains("old.example") && held.contains("from-a.example") && held.contains("from-b.example"), "{held}");
}

#[test]
fn a_holder_that_dies_before_publishing_leaves_the_prior_complete_file_and_frees_the_lock() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().to_path_buf();
    std::fs::write(dir.join("known_hosts"), "old.example ssh-ed25519 KOLD\n").unwrap();
    let mut holder = start_holder(&dir, true);
    wait_for(&dir.join("locked"));
    holder.kill().unwrap();
    holder.wait().unwrap();
    let seen = with_state_lock(&dir, || read_state(&dir.join("known_hosts"))).unwrap();
    assert_eq!(text(&seen), "old.example ssh-ed25519 KOLD\n");
}

/// A file the other writers keep changing is never seen part-written: a reader with no lock sees only whole files, each holding
/// every line the one before it held.
#[test]
fn a_reader_without_the_lock_only_ever_sees_complete_files() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().to_path_buf();
    let file = dir.join("known_hosts");
    std::fs::write(&file, "old.example ssh-ed25519 KOLD\n").unwrap();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let (file, stop) = (file.clone(), Arc::clone(&stop));
        std::thread::spawn(move || {
            let (mut reads, mut most) = (0_u32, 0_usize);
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let seen = String::from_utf8(std::fs::read(&file).unwrap()).unwrap();
                assert!(seen.ends_with('\n'), "a part of a file: {seen:?}");
                let count = seen.lines().count();
                assert!(count >= most, "a file lost lines another showed: {count} < {most}");
                for line in seen.lines() {
                    let fields: Vec<&str> = line.split(' ').collect();
                    assert!(fields.len() == 3 || (fields.len() == 4 && fields[3].starts_with("mixdog-pin-v1=")), "a torn line: {line:?}");
                }
                (reads, most) = (reads + 1, count);
            }
            reads
        })
    };
    let owner = owner("a@one");
    for index in 0..150 {
        with_state_lock(&dir, || {
            let held = read_state(&file)?;
            let next = add_claims(&held, &[claim(&owner, &format!("h{index}.example"), &format!("K{index}"))]).map_err(io::Error::other)?.unwrap_or(held);
            publish_file(&file, &next)
        })
        .unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    assert!(reader.join().unwrap() > 0);
    assert_eq!(std::fs::read_to_string(&file).unwrap().lines().count(), 151);
}

/// Two starts importing the same old file at once: one import happens, whichever wins, and each line is held once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_importers_racing_make_one_logical_import() {
    let _turn = TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let (folder, config) = configured().await;
    let legacy = folder.path().join("legacy");
    std::fs::create_dir_all(legacy.join("ssh")).unwrap();
    std::fs::write(
        legacy.join("ssh").join("known_hosts"),
        "one.example ssh-ed25519 K1\ntwo.example ssh-ed25519 K2 mixdog-pin-v1=abc\n# note\nthree.example ssh-ed25519 K3\n",
    )
    .unwrap();
    let racers: Vec<_> = (0..2)
        .map(|_| {
            let (config, legacy, env) = (Arc::clone(&config), legacy.clone(), env_in(folder.path()));
            tokio::spawn(async move { config.import_legacy_known_hosts(&env, &legacy).await.unwrap() })
        })
        .collect();
    let mut counts = Vec::new();
    for racer in racers {
        counts.push(racer.await.unwrap());
    }
    counts.sort_unstable();
    assert_eq!(counts, vec![0, 3]);
    let held = lines(&config);
    for line in ["one.example ssh-ed25519 K1\n", "two.example ssh-ed25519 K2\n", "three.example ssh-ed25519 K3\n"] {
        assert_eq!(held.matches(line).count(), 1, "{line} in {held}");
    }
    assert!(!held.contains("mixdog-pin-v1"), "the imported entries belong to nobody");
}

/// Contending transactions wait on blocking threads: with one executor thread the rest of the program keeps running.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn contending_transactions_never_stall_the_one_executor_thread() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().to_path_buf();
    let beats = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let heart = {
        let beats = Arc::clone(&beats);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(5)).await;
                beats.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        })
    };
    let started = std::time::Instant::now();
    let workers: Vec<_> = (0..8)
        .map(|index| {
            let dir = dir.clone();
            tokio::spawn(async move {
                let owner = owner("a@one");
                crate::mixdog_config::locked(dir.clone(), move || {
                    std::thread::sleep(Duration::from_millis(40));
                    let file = dir.join("known_hosts");
                    let held = read_state(&file)?;
                    let next =
                        add_claims(&held, &[claim(&owner, &format!("h{index}.example"), &format!("K{index}"))]).map_err(io::Error::other)?.unwrap_or(held);
                    publish_file(&file, &next)
                })
                .await
                .unwrap();
            })
        })
        .collect();
    for worker in workers {
        worker.await.unwrap();
    }
    let (elapsed, beat) = (started.elapsed(), beats.load(std::sync::atomic::Ordering::Relaxed));
    heart.abort();
    assert_eq!(std::fs::read_to_string(dir.join("known_hosts")).unwrap().lines().count(), 8, "a transaction was lost");
    // Eight transactions of 40 ms ran one after another (>= 320 ms); the heartbeat kept its pace meanwhile.
    assert!(elapsed >= Duration::from_millis(320));
    assert!(beat >= 10, "the executor thread was held: {beat} beats in {elapsed:?}");
}

fn tool_runs(tool: &str, args: &[&str]) -> bool {
    std::process::Command::new(tool).args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok()
}

fn tool_output(tool: &str, args: &[&str]) -> String {
    let output = std::process::Command::new(tool).args(args).output().unwrap();
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// OpenSSH itself reads what Mixdog writes: `ssh-keygen -F` finds an annotated pin, `ssh -G -F` selects Mixdog's file first, and
/// each generated block says `UpdateHostKeys no` so that no connection writes the shared file. Needs the OpenSSH client tools;
/// without them it passes by skipping, and says so. CI's Linux, macOS and Windows runners all ship OpenSSH, where it runs.
#[test]
fn openssh_reads_the_annotated_pins_and_the_generated_blocks() {
    if !tool_runs("ssh", &["-V"]) || !tool_runs("ssh-keygen", &["-?"]) {
        eprintln!("skipped: the OpenSSH client tools are not installed here");
        return;
    }
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let key_file = dir.join("id");
    assert!(std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&key_file).status().unwrap().success());
    let public = std::fs::read_to_string(dir.join("id.pub")).unwrap();
    let mut parts = public.split_whitespace();
    let (key_type, key) = (parts.next().unwrap().to_owned(), parts.next().unwrap().to_owned());

    let known_hosts = dir.join("known_hosts");
    let pin = Claim::new(owner("ops@box"), "box.example".to_owned(), key_type.clone(), key.clone());
    std::fs::write(&known_hosts, format!("{}\n", pin.line())).unwrap();
    let found = tool_output("ssh-keygen", &["-F", "box.example", "-f", &known_hosts.to_string_lossy()]);
    assert!(found.contains(&key) && found.contains("# Host box.example found"), "{found}");

    let own = known_hosts.to_string_lossy().into_owned();
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let generic = dir.join("config");
    std::fs::write(&generic, crate::mixdog_config::mixdog_ssh_config_text(&own, &[], &home)).unwrap();
    let resolved = tool_output("ssh", &["-G", "-F", &generic.to_string_lossy(), "box.example"]);
    assert!(resolved.contains("updatehostkeys false") || resolved.contains("updatehostkeys no"), "{resolved}");
    assert!(
        resolved.lines().any(|line| line.starts_with("userknownhostsfile ") && line.contains("known_hosts")) && resolved.contains("stricthostkeychecking true"),
        "{resolved}"
    );
    let first_file = resolved.lines().find(|line| line.starts_with("userknownhostsfile ")).unwrap();
    assert!(first_file.trim_start_matches("userknownhostsfile ").starts_with(&own.replace('\\', "/")), "Mixdog's file is read first: {first_file}");

    let host = |name: &str| crate::host_key::ResolvedHost {
        hostname: name.to_owned(),
        port: 22,
        user: None,
        known_hosts_files: Vec::new(),
        global_known_hosts_files: Vec::new(),
        host_key_algorithms: Vec::new(),
        proxy_jump: None,
        proxy_command: false,
        proxied: false,
        forwards: Vec::new(),
    };
    let blocks = ["gate.example", "box.example"]
        .iter()
        .map(|name| {
            crate::resolved_config::resolved_block_text(name, &crate::resolved_config::parse_dump(&format!("hostname {name}\nport 22\n")), &host(name), &own)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let per_target = dir.join("t-v2-test.conf");
    std::fs::write(&per_target, format!("{blocks}\n")).unwrap();
    for name in ["gate.example", "box.example"] {
        let seen = tool_output("ssh", &["-G", "-F", &per_target.to_string_lossy(), name]);
        assert!(seen.contains("updatehostkeys false") || seen.contains("updatehostkeys no"), "{name}: {seen}");
        assert!(seen.contains("stricthostkeychecking true"), "{name}: {seen}");
    }
}
