//! The survivors of a finished command are listed and reported gone from the operating system's
//! events, against a real job object (Windows) or process group (Linux).

mod common;

use std::time::Duration;

use common::*;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_spawn::survivors::ProcessSurvivors;
use tokio_util::sync::CancellationToken;

/// A command whose root exits at once, leaving a long sleeper that does not hold its output.
fn leaves_a_sleeper() -> CommandSpec {
    if cfg!(windows) {
        CommandSpec::Shell {
            script: "$p = Start-Process ping -ArgumentList '-n','90','127.0.0.1' -PassThru -WindowStyle Hidden; \
                     Write-Output \"CHILD=$($p.Id)\""
                .to_owned(),
            shell: Some("powershell".to_owned()),
        }
    } else {
        CommandSpec::Shell {
            script: "sleep 90 >/dev/null 2>&1 & echo CHILD=$!".to_owned(),
            shell: None,
        }
    }
}

/// Runs the command to its exit and returns the sleeper's pid.
async fn run_and_find_sleeper(
    m: &mixdog_spawn::LocalProcessManager,
    h: &mixdog_protocol::ProcessHandle,
) -> u32 {
    run_and_find(m, h, leaves_a_sleeper()).await
}

async fn run_and_find(
    m: &mixdog_spawn::LocalProcessManager,
    h: &mixdog_protocol::ProcessHandle,
    command: CommandSpec,
) -> u32 {
    use mixdog_core_api::domain::process::ProcessManager;
    m.spawn(request(h, command)).await.unwrap();
    let (bytes, _) = collect(m, h).await;
    let out = text(&bytes);
    let at = out.find("CHILD=").expect("the command printed its child");
    out[at + 6..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().unwrap()
}

fn end_externally(pid: u32) {
    let status = if cfg!(windows) {
        std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output()
    } else {
        std::process::Command::new("kill").args(["-9", &pid.to_string()]).output()
    };
    status.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_survivor_is_listed_and_its_end_wakes_the_waiter() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-wait");
    let sleeper = run_and_find_sleeper(&m, &h).await;
    assert!(pid_alive(sleeper));
    let report = watch.survivors(&h).expect("the sleeper outlived its command");
    assert!(report.reachable);

    let waiter = tokio::spawn({
        let (watch, h) = (watch.clone(), h.clone());
        async move { watch.wait_gone(&h, &CancellationToken::new()).await }
    });
    // Nothing ends while the sleeper runs, however long the waiter has been parked.
    let mut waiter = waiter;
    assert!(tokio::time::timeout(Duration::from_millis(300), &mut waiter).await.is_err(), "the waiter returned with a survivor running");

    end_externally(sleeper);
    let confirmed = tokio::time::timeout(Duration::from_secs(10), waiter)
        .await
        .expect("the survivor's end wakes the waiter")
        .unwrap();
    assert!(confirmed, "the end of the last survivor is a confirmation");
    assert_eq!(watch.survivors(&h), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_ends_the_survivors_and_a_second_look_finds_none() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-kill");
    let sleeper = run_and_find_sleeper(&m, &h).await;
    assert!(watch.survivors(&h).is_some());
    assert!(watch.kill(&h).await, "a fresh look finds every survivor gone");
    assert!(!pid_alive(sleeper), "the sleeper survived the kill");
    assert_eq!(watch.survivors(&h), None);
    // Nothing left: waiting returns at once.
    let confirmed = tokio::time::timeout(Duration::from_secs(2), watch.wait_gone(&h, &CancellationToken::new())).await.expect("nothing to wait for");
    assert!(confirmed);
}

/// An abort ends the wait with `false` (`waitForShellDescendants`), not with a confirmation: the survivor is still there.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_abort_ends_the_wait_unconfirmed_and_leaves_the_survivor_running() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-abort");
    let sleeper = run_and_find_sleeper(&m, &h).await;
    let abort = CancellationToken::new();
    let waiter = tokio::spawn({
        let (watch, h, abort) = (watch.clone(), h.clone(), abort.clone());
        async move { watch.wait_gone(&h, &abort).await }
    });
    abort.cancel();
    let confirmed = tokio::time::timeout(Duration::from_secs(10), waiter).await.expect("the abort ends the wait").unwrap();
    assert!(!confirmed, "an aborted wait confirms nothing");
    assert!(pid_alive(sleeper), "aborting a wait does not touch the survivor");
    assert!(watch.survivors(&h).is_some());
    assert!(!watch.wait_gone(&h, &abort).await, "an abort already raised answers false at once");
    end_externally(sleeper);
}

/// A process this test starts outside the command's job, attached to the root's console: the console host then outlives the
/// root for as long as this process runs, so a look made before the host has exited deterministically sees it.
#[cfg(windows)]
struct ConsoleClient(std::process::Child);

#[cfg(windows)]
impl ConsoleClient {
    fn attach(root: u32) -> Self {
        use std::io::BufRead;
        use std::os::windows::process::CommandExt;
        let script = format!(
            "$o = [Console]::Out; $i = [Console]::In; \
             Add-Type -Name C -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool FreeConsole(); [DllImport(\"kernel32.dll\")] public static extern bool AttachConsole(uint p);'; \
             [void][W.C]::FreeConsole(); $o.WriteLine([W.C]::AttachConsole({root})); $o.Flush(); [void]$i.ReadLine()"
        );
        let mut child = std::process::Command::new("powershell")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            // Without LOCALAPPDATA (an isolated test environment) PowerShell writes its module cache under the cwd.
            .current_dir(std::env::temp_dir())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
        let client = Self(child);
        assert_eq!(line.trim(), "True", "the client attached to the root's console");
        client
    }

    /// Detaches by ending: its stdin closes and it exits on its own.
    fn end(mut self) {
        drop(self.0.stdin.take());
        self.0.wait().unwrap();
    }
}

#[cfg(windows)]
impl Drop for ConsoleClient {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A root that ended on its own leaves its console host, which ends once its last console client has: that host is no
/// survivor (`CONSOLE_HOST` of `lib/shell-descendants.mjs`). The settle waits for the host's own exit, not for a fixed time,
/// so a host held longer than any fixed wait is still not reported.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_console_host_still_exiting_after_its_root_is_no_survivor() {
    use mixdog_core_api::domain::process::ProcessEvent;
    use mixdog_core_api::domain::process::ProcessManager;
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-console-host");
    let command = CommandSpec::Argv {
        program: "powershell".to_owned(),
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output \"ROOT=$PID\"; [void][Console]::In.ReadLine()"]
            .map(str::to_owned)
            .to_vec(),
    };
    m.spawn(mixdog_core_api::domain::process::SpawnRequest { stdin_piped: true, ..request(&h, command) }).await.unwrap();
    let mut events = m.subscribe(&h, Some(0)).unwrap();
    let mut out = Vec::new();
    let root: u32 = loop {
        match tokio::time::timeout(WAIT, events.next()).await.expect("the root prints its pid").expect("the feed is open") {
            ProcessEvent::Output { bytes, .. } => out.extend(bytes),
            ProcessEvent::Exited { .. } => panic!("the root ended before it printed its pid: {}", text(&out)),
        }
        let printed = text(&out);
        if let Some(pid) = printed.split("ROOT=").nth(1).and_then(|rest| rest.lines().next()).and_then(|pid| pid.trim().parse().ok()) {
            break pid;
        }
    };
    let client = ConsoleClient::attach(root);
    mixdog_spawn::testing::arm_settle_window();
    let (entered, parked) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        mixdog_spawn::testing::wait_settle_window_entered();
        let _ = entered.send(());
    });
    m.close_stdin(&h).unwrap();
    parked
        .recv_timeout(WAIT)
        .expect("the settle of the ended root found only its console host left and waits for it");
    client.end();
    mixdog_spawn::testing::release_settle_window();
    loop {
        match tokio::time::timeout(WAIT, events.next()).await.expect("the root's exit is published").expect("the feed is open") {
            ProcessEvent::Exited { .. } => break,
            ProcessEvent::Output { .. } => {}
        }
    }
    assert_eq!(watch.survivors(&h), None, "a console host that exited after its root is no survivor");
}

/// The cancel's own schedule (`killShellDescendants`): SIGTERM to the group first, and a survivor that ignores it is ended by
/// the forced stop that follows, so the kill still reports every one gone.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_survivor_that_ignores_sigterm_is_ended_by_the_forced_stop() {
    let m = manager();
    let watch = ProcessSurvivors::new(m.clone());
    let h = handle("survivor-ignores-term");
    let ignoring = CommandSpec::Shell {
        script: "(trap '' TERM; exec sleep 90) >/dev/null 2>&1 & echo CHILD=$!".to_owned(),
        shell: None,
    };
    let sleeper = run_and_find(&m, &h, ignoring).await;
    assert!(watch.survivors(&h).is_some());
    assert!(watch.kill(&h).await, "the forced stop ends what SIGTERM did not");
    assert!(!pid_alive(sleeper), "the sleeper survived the kill");
    assert_eq!(watch.survivors(&h), None);
}