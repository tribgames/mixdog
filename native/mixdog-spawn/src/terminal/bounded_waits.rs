use std::time::Duration;

use super::*;
use crate::manager::ProcessConfig;

struct Quiet;

impl TerminalEvents for Quiet {
    fn activity(&self, _: &str, _: Option<ActivityState>) {}
    fn size_owner(&self, _: &SizeOwnerChange) {}
    fn size_claims_forgotten(&self, _: &str) {}
}

fn tabs_with(config: ProcessConfig) -> (Arc<TerminalTabs>, LocalProcessManager) {
    let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, config);
    let tabs = Arc::new(TerminalTabs::new(manager.clone(), TerminalConfig::new(Arc::new(Quiet))));
    (tabs, manager)
}

/// The root exits at once but its grandchild keeps the output pipe for 60 s, so the
/// pipe-end the exit used to wait for never comes. `wait_gone` ends through the process
/// manager's bounded drain (`output_drain`), with no timer of its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_gone_ends_when_a_descendant_holds_the_pipe() {
    let (tabs, manager) = tabs_with(ProcessConfig { output_drain: Duration::from_millis(50), ..ProcessConfig::default() });
    let handle = ProcessHandle::from(format!("wait-gone-{}", std::process::id()));
    let command = if cfg!(windows) {
        CommandSpec::Shell {
            script: "$i = New-Object System.Diagnostics.ProcessStartInfo; $i.FileName = 'ping'; \
                         $i.Arguments = '-n 60 127.0.0.1'; $i.UseShellExecute = $false; \
                         [void][System.Diagnostics.Process]::Start($i)"
                .to_owned(),
            shell: Some("powershell".to_owned()),
        }
    } else {
        CommandSpec::Shell { script: "sleep 60 &".to_owned(), shell: None }
    };
    manager
        .spawn(SpawnRequest {
            handle: handle.clone(),
            command,
            cwd: AbsPath::new(std::env::temp_dir()).expect("the temp dir is absolute"),
            env: EnvSpec { inherit: true, ..EnvSpec::default() },
            pty: None,
            stdin_piped: false,
            output: OutputMode::Merged,
            owner: ProcessOwner::Internal,
            time_limit: None,
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), tabs.wait_gone(&handle)).await.expect("wait_gone ends although the pipe is still held");
    assert!(manager.info(&handle).unwrap().exit.is_some());
}

/// The spawner a waiter waits on goes away without finishing: the slot is released and the
/// waiter ends, instead of waiting for a wake-up that never comes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waiter_on_an_abandoned_spawn_is_released() {
    let (tabs, _manager) = tabs_with(ProcessConfig::default());
    let Claim::Spawn { guard, .. } = tabs.claim("term_1") else {
        panic!("the first claim spawns");
    };
    let waiter = {
        let tabs = Arc::clone(&tabs);
        tokio::spawn(async move { tabs.attach("term_1").await })
    };
    drop(guard);
    let attached = tokio::time::timeout(Duration::from_secs(10), waiter).await.expect("the waiter is released").unwrap();
    assert!(attached.is_none());
}
