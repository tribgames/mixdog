//! DS-PROC-1, 4 and 6 and the isolation property of the one process manager, against real
//! processes (cmd / PowerShell on Windows, sh elsewhere).

mod common;

use std::time::Duration;
use std::time::Instant;

use common::*;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessQueue;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_spawn::ProcessConfig;
use mixdog_spawn::ShutdownOutcome;
use mixdog_spawn::tasks::TaskOutcome;
use mixdog_spawn::tasks::TaskStatus;

fn long_sleep() -> CommandSpec {
    shell("ping -n 40 127.0.0.1 >nul", "sleep 40")
}

async fn wait_exit(manager: &mixdog_spawn::LocalProcessManager, h: &mixdog_protocol::ProcessHandle) {
    while manager.info(h).unwrap().exit.is_none() {
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exit_codes_and_merged_output() {
    let m = manager();
    let h = handle("exit-code");
    m.spawn(request(&h, shell("echo out& echo err 1>&2& exit 7", "echo out; echo err >&2; exit 7"))).await.unwrap();
    let (bytes, exit) = collect(&m, &h).await;
    assert_eq!(exit.status, ExitStatus::Code(7));
    assert_eq!(exit.killed, None);
    let out = text(&bytes);
    let (o, e) = (out.find("out").expect("stdout"), out.find("err").expect("stderr"));
    assert!(o < e, "merged output keeps arrival order: {out:?}");
    assert_eq!(TaskOutcome::of_exit(&exit).status, TaskStatus::Failed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn separate_output_keeps_streams_apart() {
    let m = manager();
    let h = handle("separate");
    let mut req = request(&h, shell("echo out& echo err 1>&2", "echo out; echo err >&2"));
    req.output = OutputMode::Separate;
    m.spawn(req).await.unwrap();
    let mut events = m.subscribe(&h, Some(0)).unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    loop {
        match events.next().await.unwrap() {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => out.extend(bytes),
            ProcessEvent::Output { stream: OutputStream::Stderr, bytes, .. } => err.extend(bytes),
            ProcessEvent::Output { .. } => panic!("a pipe has no pty stream"),
            ProcessEvent::Exited { .. } => break,
        }
    }
    assert!(text(&out).contains("out") && !text(&out).contains("err"), "{:?}", text(&out));
    assert!(text(&err).contains("err") && !text(&err).contains("out"), "{:?}", text(&err));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_limit_ends_with_time_limit_and_reports_124() {
    let m = manager();
    let h = handle("time-limit");
    let mut req = request(&h, long_sleep());
    req.time_limit = Some(Duration::from_millis(300));
    m.spawn(req).await.unwrap();
    let (_, exit) = collect(&m, &h).await;
    // The 40 s sleep did not end on its own: the limit ended it.
    assert_eq!(exit.killed, Some(KillReason::TimeLimit));
    let outcome = TaskOutcome::of_exit(&exit);
    assert_eq!((outcome.status, outcome.exit_code), (TaskStatus::Failed, Some(124)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stdin_reaches_the_process_and_closing_ends_it() {
    let m = manager();
    let h = handle("stdin");
    let mut req = request(&h, shell("findstr \"^\"", "cat"));
    req.stdin_piped = true;
    m.spawn(req).await.unwrap();
    m.write_stdin(&h, b"hello from stdin\r\n".to_vec()).await.unwrap();
    m.close_stdin(&h).unwrap();
    assert_eq!(m.close_stdin(&h), Err(ProcessError::StdinClosed));
    let (bytes, exit) = collect(&m, &h).await;
    assert_eq!(exit.status, ExitStatus::Code(0));
    assert!(text(&bytes).contains("hello from stdin"), "{:?}", text(&bytes));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_megabytes_arrive_intact() {
    let dir = scratch_dir("integrity");
    let file = dir.join("big.txt");
    let mut data = String::new();
    let mut i = 0u32;
    while data.len() < 3 * 1024 * 1024 {
        data.push_str(&format!("line {i:08}\r\n"));
        i += 1;
    }
    std::fs::write(&file, &data).unwrap();
    let m = manager();
    let h = handle("integrity");
    let path = file.display().to_string();
    m.spawn(request(&h, shell(&format!("type \"{path}\""), &format!("cat '{path}'")))).await.unwrap();
    let (bytes, exit) = collect(&m, &h).await;
    assert_eq!(exit.status, ExitStatus::Code(0));
    assert_eq!(bytes.len(), data.len());
    assert!(bytes == data.as_bytes(), "output differs from the file");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handles_limits_and_errors() {
    let m = manager_with(ProcessConfig { max_processes: 2, input_queue_bytes: 10, ..ProcessConfig::default() });
    let (a, b, c) = (handle("limit-a"), handle("limit-b"), handle("limit-c"));
    m.spawn(request(&a, long_sleep())).await.unwrap();
    assert_eq!(m.spawn(request(&a, long_sleep())).await, Err(ProcessError::HandleInUse));
    let missing = m.spawn(request(&handle("gone"), CommandSpec::Argv { program: "mixdog-no-such-program".into(), args: vec![] })).await;
    assert!(matches!(missing, Err(ProcessError::ProgramNotFound { .. })), "{missing:?}");
    // A failed spawn leaves no slot behind.
    assert_eq!(m.live(), 1);
    let mut with_stdin = request(&b, shell("findstr \"^\"", "cat"));
    with_stdin.stdin_piped = true;
    m.spawn(with_stdin).await.unwrap();
    assert_eq!(m.spawn(request(&c, long_sleep())).await, Err(ProcessError::LimitReached { limit: 2 }));
    assert_eq!(m.live(), 2);
    // An input queue over its bound refuses the whole write and says so.
    assert_eq!(m.write_stdin(&b, vec![b'x'; 11]).await, Err(ProcessError::Overloaded { queue: ProcessQueue::Input }));
    m.write_stdin(&b, vec![b'x'; 10]).await.unwrap();
    assert_eq!(m.write_stdin(&a, b"x".to_vec()).await, Err(ProcessError::StdinClosed));
    assert_eq!(m.resize_pty(&a, PtySize { cols: 10, rows: 10 }), Err(ProcessError::NotPty));
    assert_eq!(m.kill(&handle("nobody")), Err(ProcessError::UnknownHandle));
    m.kill(&a).unwrap();
    wait_exit(&m, &a).await;
    assert_eq!(m.kill(&a), Err(ProcessError::AlreadyExited));
    m.spawn(request(&c, shell("exit 0", "exit 0"))).await.unwrap();
    m.kill(&b).unwrap();
    let (_, exit) = collect(&m, &c).await;
    assert_eq!(exit.status, ExitStatus::Code(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replay_ring_forgets_the_oldest_events() {
    let dir = scratch_dir("ring");
    let file = dir.join("ring.txt");
    std::fs::write(&file, "0123456789abcdef\r\n".repeat(20_000)).unwrap();
    let m = manager_with(ProcessConfig { ring_bytes: 4096, ..ProcessConfig::default() });
    let h = handle("ring");
    let path = file.display().to_string();
    // A consumer keeps up, so the reader is never held back by it.
    m.spawn(request(&h, shell(&format!("type \"{path}\""), &format!("cat '{path}'")))).await.unwrap();
    let mut live = m.subscribe(&h, None).unwrap();
    while !matches!(live.next().await, Some(ProcessEvent::Exited { .. }) | None) {}
    match m.subscribe(&h, Some(0)) {
        Err(ProcessError::ReplayUnavailable { oldest }) => assert!(oldest > 0),
        other => panic!("expected ReplayUnavailable, got {:?}", other.map(|_| ())),
    }
}

/// The pid a script printed as `CHILD=<pid>`.
async fn child_pid(m: &mixdog_spawn::LocalProcessManager, h: &mixdog_protocol::ProcessHandle) -> u32 {
    async {
        let mut events = m.subscribe(h, Some(0)).unwrap();
        let mut seen = String::new();
        while let Some(event) = events.next().await {
            if let ProcessEvent::Output { bytes, .. } = event {
                seen.push_str(&text(&bytes));
                if let Some(at) = seen.find("CHILD=") {
                    let digits: String = seen[at + 6..].chars().take_while(char::is_ascii_digit).collect();
                    if !digits.is_empty() && seen[at + 6 + digits.len()..].contains('\n') {
                        return digits.parse().unwrap();
                    }
                }
            }
        }
        panic!("the script never printed its child");
    }
    .await
}

/// A root that prints its grandchild's pid and goes on running; the grandchild holds the output pipe as the root does (on
/// Windows started without the shell, so it inherits the root's handles, as in [`orphan_pipe_script`]).
fn tree_script() -> CommandSpec {
    if cfg!(windows) {
        CommandSpec::Shell {
            script: "$i = New-Object System.Diagnostics.ProcessStartInfo; $i.FileName = 'ping'; \
                     $i.Arguments = '-n 90 127.0.0.1'; $i.UseShellExecute = $false; \
                     $p = [System.Diagnostics.Process]::Start($i); Write-Output \"CHILD=$($p.Id)\"; Start-Sleep 90"
                .to_owned(),
            shell: Some("powershell".to_owned()),
        }
    } else {
        CommandSpec::Shell { script: "sleep 90 & echo CHILD=$!; sleep 90".to_owned(), shell: None }
    }
}

/// What tells the explanations of a late exit apart, read once the exit has been announced (a holder of the output
/// pipe is still there then): every process of the root's group (the root is its own group leader, `setsid`) with
/// pid, group, state and command, and whether the root itself was reaped.
///
/// - The root has no row: it was reaped. A row in state `Z` is a root still waiting to be reaped.
/// - No row in the group at all, yet the exit was late: the output reader had ended or the drain was not what held it.
/// - A row besides the root (a foreground `sleep` that outlived the group signal, say) holds the output pipe, so the reader
///   had not finished and the exit waited for the drain to run to its deadline (`ProcessConfig::output_drain`, 2 s).
#[cfg(unix)]
fn late_exit_report(root: u32) -> String {
    let listing = std::process::Command::new("ps")
        .args(["-ax", "-o", "pid=,pgid=,stat=,command="])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_else(|error| format!("ps failed: {error}"));
    let rows: Vec<&str> = listing.lines().filter(|row| row.split_whitespace().nth(1).and_then(|pgid| pgid.parse::<u32>().ok()) == Some(root)).collect();
    let root_row = rows.iter().find(|row| row.split_whitespace().next().and_then(|pid| pid.parse::<u32>().ok()) == Some(root));
    format!(
        "root {root}: {}\nprocesses in group {root} (pid pgid stat command):\n{}",
        match root_row {
            None => "no row (reaped)".to_owned(),
            Some(row) if row.split_whitespace().nth(2).is_some_and(|stat| stat.starts_with('Z')) => "zombie (not reaped)".to_owned(),
            Some(_) => "alive".to_owned(),
        },
        if rows.is_empty() { "  (none)".to_owned() } else { rows.join("\n") }
    )
}

#[cfg(windows)]
fn late_exit_report(root: u32) -> String {
    format!("root {root}: no group listing on Windows")
}

/// DS-PROC-6 and the tree-kill of DS-PROC-1: one kill takes the grandchild and every other member of the group with the root,
/// and the exit is announced once nothing of the tree holds the output. The drain bound is past every wait of the test, so an
/// exit announced at all was announced by the end of the tree, not by the bound.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_takes_the_whole_tree_before_its_exit_is_announced() {
    let m = manager_with(ProcessConfig { output_drain: 2 * WAIT, ..ProcessConfig::default() });
    let h = handle("tree-order");
    m.spawn(request(&h, tree_script())).await.unwrap();
    let grandchild = child_pid(&m, &h).await;
    assert!(pid_alive(grandchild), "the grandchild runs");
    m.kill(&h).unwrap();
    let Ok((_, exit)) = mixdog_rt::time::timeout(WAIT, collect(&m, &h)).await else {
        panic!("no exit announced: the kill left a holder of the output\n{}", late_exit_report(m.info(&h).unwrap().pid));
    };
    assert_eq!(exit.killed, Some(KillReason::Requested));
    let started = Instant::now();
    while pid_alive(grandchild) {
        assert!(started.elapsed() < Duration::from_secs(5), "the grandchild survived the kill");
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_limit_takes_the_whole_tree_too() {
    let m = manager();
    let h = handle("tree-limit");
    let mut req = request(&h, tree_script());
    req.time_limit = Some(Duration::from_secs(8));
    m.spawn(req).await.unwrap();
    let grandchild = child_pid(&m, &h).await;
    let (_, exit) = collect(&m, &h).await;
    assert_eq!(exit.killed, Some(KillReason::TimeLimit));
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(grandchild) {
        assert!(Instant::now() < deadline, "the grandchild survived the run limit");
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
}

fn big_pty_file(name: &str, bytes: usize) -> (String, std::path::PathBuf) {
    let dir = scratch_dir(name);
    let file = dir.join("flood.txt");
    let mut data = String::with_capacity(bytes + 64);
    let mut i = 0u32;
    while data.len() < bytes {
        data.push_str(&format!("flood {i:09} {}\r\n", "0123456789abcdefghijklmnopqrstuvwxyz".repeat(3)));
        i += 1;
    }
    data.push_str("END-OF-FLOOD-MARKER\r\n");
    std::fs::write(&file, data).unwrap();
    (file.display().to_string(), file)
}

fn flood_command(path: &str) -> CommandSpec {
    shell(&format!("type \"{path}\""), &format!("cat '{path}'"))
}

/// The bytes pushed once the process's reader is parked at its feed's gate: held back by the stalled consumer or the paused feed. The wait is on
/// the reader's own signal, so a loaded machine cannot end it early; the deadline fails a reader that never parks.
async fn pushed_when_blocked(m: &mixdog_spawn::LocalProcessManager, h: &mixdog_protocol::ProcessHandle) -> u64 {
    mixdog_rt::time::timeout(Duration::from_secs(60), m.output_blocked(h)).await.expect("the reader never parked at its feed's gate within 60 s").unwrap()
}
/// DS-PROC-4: a 10 MB flood to a client that does not read stalls the PTY reader at the ring
/// bound, a second client's keystrokes still pass, another process is not slowed, and reading
/// again lets the flood finish.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn flood_to_a_stalled_client_stops_at_the_ring_bound() {
    const RING: usize = 1024 * 1024;
    let (path, _file) = big_pty_file("flood", 10 * 1024 * 1024);
    let m = manager_with(ProcessConfig { ring_bytes: RING, ..ProcessConfig::default() });
    let h = handle("flood");
    let cmd = flood_command(&path);
    m.spawn(pty_request(&h, cmd, PtySize { cols: 120, rows: 40 })).await.unwrap();
    // The client that never reads: subscribed, never polled.
    let mut client = m.subscribe(&h, None).unwrap();
    let stalled_at = pushed_when_blocked(&m, &h).await;
    assert!(stalled_at as usize <= RING && stalled_at as usize + 192 * 1024 >= RING, "reader stalled at {stalled_at}, ring bound {RING}");
    assert!(m.info(&h).unwrap().exit.is_none(), "the flood is held back, not finished");

    // A second client's keystrokes pass while the output is stalled.
    m.write_input(&h, b"x".to_vec()).unwrap();
    let passed = mixdog_rt::time::timeout(WAIT, async {
        while m.input_backlog(&h).unwrap() > 0 {
            mixdog_rt::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(passed.is_ok(), "keystroke stuck behind the stalled output");
    assert!(m.info(&h).unwrap().exit.is_none(), "the flood is still held back");

    // Another process runs to its end while the flood is held back.
    let other = handle("flood-other");
    m.spawn(request(&other, shell("echo unaffected", "echo unaffected"))).await.unwrap();
    let (bytes, exit) = collect(&m, &other).await;
    assert_eq!(exit.status, ExitStatus::Code(0));
    assert!(text(&bytes).contains("unaffected"));
    assert!(m.info(&h).unwrap().exit.is_none(), "the flood is still held back");

    // The client reads again: the flood completes, up to its last line.
    let drain_started = Instant::now();
    let mut tail: Vec<u8> = Vec::new();
    let mut total = 0usize;
    mixdog_rt::time::timeout(Duration::from_secs(120), async {
        while let Some(event) = client.next().await {
            match event {
                ProcessEvent::Output { bytes, .. } => {
                    total += bytes.len();
                    tail.extend(bytes);
                    let excess = tail.len().saturating_sub(4096);
                    tail.drain(..excess);
                }
                ProcessEvent::Exited { .. } => break,
            }
        }
    })
    .await
    .expect("the flood finishes once the client reads");
    eprintln!("drained {total} bytes in {:?}", drain_started.elapsed());
    let tail = text(&tail);
    assert!(tail.contains("END-OF-FLOOD-MARKER"), "tail: {tail:?}");
    assert!(total >= 10 * 1024 * 1024 / 2, "only {total} bytes arrived");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_pause_stops_the_reader_and_resume_releases_it() {
    let (path, _file) = big_pty_file("pause", 4 * 1024 * 1024);
    let m = manager();
    let h = handle("pause");
    let cmd = flood_command(&path);
    m.spawn(pty_request(&h, cmd, PtySize { cols: 120, rows: 40 })).await.unwrap();
    // Pause once the flood has started: a reader paused before its first byte stays at zero.
    while m.output_pushed(&h).unwrap() == 0 {
        mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    }
    m.set_output_paused(&h, true).unwrap();
    let stalled = pushed_when_blocked(&m, &h).await;
    assert!(stalled < 4 * 1024 * 1024, "paused reader consumed the whole flood: {stalled}");
    assert!(m.info(&h).unwrap().exit.is_none());
    m.set_output_paused(&h, false).unwrap();
    let (bytes, _) = collect(&m, &h).await;
    assert!(text(&bytes).contains("END-OF-FLOOD-MARKER") || m.output_pushed(&h).unwrap() > stalled);
}

/// A process that exits by itself while its output is paused still publishes its exit and frees
/// its admission slot: the exit opens the reader's flow gate (it used to join a reader parked on
/// the gate). The script waits for a line of input between its two outputs, which the test sends once the output is paused.
///
/// The Unix terminal does not echo that line: a session leader's exit on macOS first waits until its terminal's output has been read
/// (XNU `proc_exit` → `ttywait`), so with the echo parked at the gate, `last` would stay unread in the terminal and the root would
/// never exit while paused. Without the echo, `last` is the one output after the pause, and the parked reader holds all of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn natural_exit_behind_paused_output_is_published_and_frees_the_slot() {
    let m = manager_with(ProcessConfig { max_processes: 1, ..ProcessConfig::default() });
    for (name, pty) in [("paused-pipe", false), ("paused-pty", true)] {
        let h = handle(name);
        let unix = if pty { "stty -echo; echo first; read line; echo last" } else { "echo first; read line; echo last" };
        let cmd = shell("echo first& set /p line=& echo last", unix);
        let req = if pty { pty_request(&h, cmd, PtySize { cols: 100, rows: 30 }) } else { SpawnRequest { stdin_piped: true, ..request(&h, cmd) } };
        m.spawn(req).await.unwrap();
        while m.output_pushed(&h).unwrap() == 0 {
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
        m.set_output_paused(&h, true).unwrap();
        if pty {
            m.write_input(&h, b"go\r".to_vec()).unwrap();
        } else {
            m.write_stdin(&h, b"go\r\n".to_vec()).await.unwrap();
        }
        wait_exit(&m, &h).await;
        assert_eq!(m.live(), 0, "{name}: the slot is free");
        let (bytes, exit) = collect(&m, &h).await;
        assert_eq!(exit.status, ExitStatus::Code(0));
        assert!(text(&bytes).contains("last"), "{name}: output after the pause is kept: {:?}", text(&bytes));
    }
}

/// A root that prints its grandchild's pid and exits, leaving the grandchild holding the pipe.
fn orphan_pipe_script() -> CommandSpec {
    if cfg!(windows) {
        CommandSpec::Shell {
            script: "$i = New-Object System.Diagnostics.ProcessStartInfo; $i.FileName = 'ping'; \
                     $i.Arguments = '-n 60 127.0.0.1'; $i.UseShellExecute = $false; \
                     $p = [System.Diagnostics.Process]::Start($i); Write-Output \"CHILD=$($p.Id)\""
                .to_owned(),
            shell: Some("powershell".to_owned()),
        }
    } else {
        CommandSpec::Shell { script: "sleep 60 & echo CHILD=$!".to_owned(), shell: None }
    }
}

fn kill_pid(pid: u32) {
    let _ = std::process::Command::new(if cfg!(windows) { "taskkill" } else { "kill" })
        .args(if cfg!(windows) { vec!["/F".to_owned(), "/PID".to_owned(), pid.to_string()] } else { vec![pid.to_string()] })
        .output();
}

/// The root exits but a grandchild keeps the output pipe open: within the drain bound the exit
/// waits for the pipe, and a kill still takes the grandchild down so the exit completes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_after_the_root_exited_still_takes_a_descendant_holding_the_pipe() {
    let m = manager_with(ProcessConfig { output_drain: Duration::from_secs(60), ..ProcessConfig::default() });
    let h = handle("orphan-pipe");
    m.spawn(request(&h, orphan_pipe_script())).await.unwrap();
    let grandchild = child_pid(&m, &h).await;
    // The root ends after it printed the grandchild; the manager reaps it, and the pipe is still held.
    let root = m.info(&h).unwrap().pid;
    while pid_alive(root) {
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(m.info(&h).unwrap().exit.is_none(), "the exit waits for the held pipe");
    assert!(pid_alive(grandchild));
    let killed = m.kill(&h);
    if killed.is_err() {
        // Do not leave the grandchild behind when the assertion below fails.
        let _ = std::process::Command::new(if cfg!(windows) { "taskkill" } else { "kill" })
            .args(if cfg!(windows) { vec!["/F".to_owned(), "/PID".to_owned(), grandchild.to_string()] } else { vec![grandchild.to_string()] })
            .output();
    }
    assert_eq!(killed, Ok(()), "kill reaches the tree after the root exited");
    let started = Instant::now();
    while pid_alive(grandchild) {
        assert!(started.elapsed() < Duration::from_secs(5), "the grandchild survived the kill");
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
    }
    wait_exit(&m, &h).await;
    assert_eq!(m.info(&h).unwrap().exit.unwrap().killed, Some(KillReason::Requested));
    assert_eq!(m.kill(&h), Err(ProcessError::AlreadyExited));
}

/// F9: the grandchild keeps the pipe for the whole test (it sleeps 60 s and is only killed at
/// the end), yet the exit is published once the drain bound has passed, carrying the output
/// that arrived, and the exit is the last event.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_exit_is_published_within_the_drain_bound_while_a_descendant_holds_the_pipe() {
    let m = manager_with(ProcessConfig { output_drain: Duration::from_millis(50), ..ProcessConfig::default() });
    let h = handle("drain-bound");
    m.spawn(request(&h, orphan_pipe_script())).await.unwrap();
    let grandchild = child_pid(&m, &h).await;
    let (bytes, exit) = collect(&m, &h).await;
    let held = pid_alive(grandchild);
    kill_pid(grandchild);
    assert!(held, "the exit was published while the grandchild still held the pipe");
    assert!(text(&bytes).contains("CHILD="), "output that arrived is kept: {:?}", text(&bytes));
    assert_eq!(exit.killed, None, "the drain does not kill");
    assert_eq!(m.kill(&h), Err(ProcessError::AlreadyExited));
}

/// A killed process with a stalled client still ends: kill releases its reader.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_releases_a_reader_held_by_a_stalled_client() {
    let (path, _file) = big_pty_file("kill-stalled", 6 * 1024 * 1024);
    let m = manager_with(ProcessConfig { ring_bytes: 256 * 1024, ..ProcessConfig::default() });
    let h = handle("kill-stalled");
    let cmd = flood_command(&path);
    m.spawn(pty_request(&h, cmd, PtySize { cols: 100, rows: 30 })).await.unwrap();
    let _client = m.subscribe(&h, None).unwrap();
    pushed_when_blocked(&m, &h).await;
    m.kill(&h).unwrap();
    wait_exit(&m, &h).await;
    assert_eq!(m.info(&h).unwrap().exit.unwrap().killed, Some(KillReason::Requested));
}

/// The width a shell's answer to the size query names, once the answer is whole.
fn reported_width(answer: &str) -> Option<u16> {
    if cfg!(windows) {
        // `mode con`: five "<label>:   <number>" lines in the system's language (lines, columns, keyboard rate and
        // delay, code page); the columns are the second.
        let values: Vec<u16> = answer
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter_map(|(_, value)| {
                let digits: String = value.trim_start().chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            })
            .collect();
        (values.len() >= 5).then(|| values[1])
    } else {
        // `stty size`: a line ending in "31 97". The prompt of the query stands before it when the query was typed
        // ahead of that prompt ("$ 31 97").
        answer.split_inclusive('\n').filter(|line| line.ends_with('\n')).find_map(|line| {
            let mut parts = line.split_whitespace().rev();
            let (cols, rows) = (parts.next()?, parts.next()?);
            rows.parse::<u16>().ok()?;
            cols.parse().ok()
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pty_session_echoes_input_and_follows_resizes() {
    let m = manager();
    let h = handle("pty");
    let command = if cfg!(windows) {
        CommandSpec::Argv { program: "cmd.exe".into(), args: vec![] }
    } else {
        CommandSpec::Argv { program: "/bin/sh".into(), args: vec![] }
    };
    m.spawn(pty_request(&h, command, PtySize { cols: 80, rows: 24 })).await.unwrap();
    assert_eq!(m.info(&h).unwrap().pty, Some(PtySize { cols: 80, rows: 24 }));
    let mut events = m.subscribe(&h, Some(0)).unwrap();
    let mut seen = String::new();
    m.write_input(&h, b"echo MIXDOG_PTY_OK\r".to_vec()).unwrap();
    // The storm goes to a shell that is attached and reading: a size sent while the client attaches can be dropped by
    // the console host (microsoft/terminal#10400; release gate run 45607620142 stayed at the storm's 116th size).
    let attached = async {
        while !seen.contains("MIXDOG_PTY_OK") {
            match events.next().await.expect("the feed ends with the exit event") {
                ProcessEvent::Output { bytes, .. } => seen.push_str(&text(&bytes)),
                ProcessEvent::Exited { .. } => panic!("the shell ended before it was told to: {seen:?}"),
            }
        }
    };
    assert!(tokio::time::timeout(WAIT, attached).await.is_ok(), "the shell echoes its first command: {seen:?}");
    // A resize storm: the last size wins.
    for i in 0..200u16 {
        m.resize_pty(&h, PtySize { cols: 20 + (i * 37) % 180, rows: 10 + (i * 11) % 50 }).unwrap();
    }
    m.resize_pty(&h, PtySize { cols: 97, rows: 31 }).unwrap();
    assert_eq!(m.info(&h).unwrap().pty, Some(PtySize { cols: 97, rows: 31 }));
    // A console applies the sizes it is sent in their order, each some time after the call that sent it returned
    // (release gate run 45055219445: `mode con` answered a size from the middle of the storm). The last size wins once
    // they are all applied: the shell is asked until it answers that one.
    let query = if cfg!(windows) { "mode con\r" } else { "stty size\r" };
    let settled = async {
        loop {
            let from = seen.len();
            m.write_input(&h, query.as_bytes().to_vec()).unwrap();
            let width = loop {
                match events.next().await.expect("the feed ends with the exit event") {
                    ProcessEvent::Output { bytes, .. } => seen.push_str(&text(&bytes)),
                    ProcessEvent::Exited { .. } => panic!("the shell ended before it was told to: {seen:?}"),
                }
                if let Some(width) = reported_width(&seen[from..]) {
                    break width;
                }
            };
            if width == 97 {
                return;
            }
        }
    };
    let reported = tokio::time::timeout(WAIT, settled).await;
    assert!(reported.is_ok(), "the shell reports the final width: {seen:?}");
    drop(events);
    m.write_input(&h, b"exit\r".to_vec()).unwrap();
    let (bytes, exit) = collect(&m, &h).await;
    let out = text(&bytes);
    assert!(out.contains("MIXDOG_PTY_OK"), "{out:?}");
    assert_eq!(exit.status, ExitStatus::Code(0));
    assert_eq!(m.resize_pty(&h, PtySize { cols: 10, rows: 10 }), Err(ProcessError::AlreadyExited));
}

/// The isolation property: the exit of one process is announced while another's output is
/// still being produced and consumed, and neither waits for the other. The slow process only
/// ends when it is killed, so every quick exit is announced while it still runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_processes_exit_never_waits_for_anothers_output() {
    let m = manager();
    let slow = handle("slow");
    m.spawn(request(&slow, shell("ping -t 127.0.0.1", "while :; do echo tick; sleep 1; done"))).await.unwrap();
    let mut ticks = m.subscribe(&slow, None).unwrap();
    let mut quick = Vec::new();
    for i in 0..8 {
        let h = handle(&format!("quick-{i}"));
        m.spawn(request(&h, shell(&format!("echo quick {i}"), &format!("echo quick {i}")))).await.unwrap();
        quick.push(h);
    }
    for h in &quick {
        let (_, exit) = collect(&m, h).await;
        assert_eq!(exit.status, ExitStatus::Code(0));
    }
    assert!(m.info(&slow).unwrap().exit.is_none(), "the slow process is still running");
    assert!(matches!(ticks.next().await, Some(ProcessEvent::Output { .. })), "its output is still being produced");
    m.kill(&slow).unwrap();
}

/// A hung-up process's later kill reaches that process only (Node's dispose kills the captured entry's own pty, terminal-manager.ts:543):
/// once it has exited and a new process runs under the same handle, the kill finds its own process ended and the new one untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hung_up_process_is_killed_as_itself_never_through_its_handle() {
    let m = manager();
    let h = handle("hung-up");
    m.spawn(pty_request(&h, long_sleep(), PtySize { cols: 80, rows: 24 })).await.unwrap();
    let hung = m.hang_up(&h).unwrap();
    m.kill(&h).unwrap();
    let _ = collect(&m, &h).await;
    m.spawn(pty_request(&h, long_sleep(), PtySize { cols: 80, rows: 24 })).await.unwrap();
    assert_eq!(hung.kill(), Err(ProcessError::AlreadyExited), "the kill reached the old process, which had ended");
    assert_eq!(m.info(&h).unwrap().exit, None, "the process now under the handle was not killed");
    m.kill(&h).unwrap();
    let _ = collect(&m, &h).await;
}

/// While a write larger than the queue is in progress (the process reads nothing, so it stays in progress), the process's write side is
/// its own: another write is not queued between its pieces (Node's one `pty.write` per string, terminal-manager.ts:419), neither the
/// immediate one nor a waiting one, which goes after it.
#[tokio::test(flavor = "multi_thread")]
async fn a_write_in_pieces_is_never_interleaved_with_another_write() {
    let m = manager_with(ProcessConfig { input_queue_bytes: 16, ..ProcessConfig::default() });
    let h = handle("one-writer");
    m.spawn(SpawnRequest { stdin_piped: true, ..request(&h, long_sleep()) }).await.unwrap();
    // More than the pipe and the queue hold together: the write is still in progress after its first poll.
    let mut first = Box::pin(m.write_input_wait(&h, "é".repeat(256 * 1024).into_bytes()));
    assert!(poll_once(&mut first).await.is_pending(), "the large write is in progress");
    assert_eq!(m.write_input(&h, b"x".to_vec()), Err(ProcessError::Overloaded { queue: ProcessQueue::Input }), "no write lands between its pieces");
    let mut second = Box::pin(m.write_input_wait(&h, b"x".to_vec()));
    assert!(poll_once(&mut second).await.is_pending(), "a waiting write goes after the whole of it");
    m.kill(&h).unwrap();
    assert_eq!(mixdog_rt::time::timeout(WAIT, first).await.expect("the first write ends with the process"), Err(ProcessError::StdinClosed));
    let _ = collect(&m, &h).await;
}

/// A write whose caller is dropped after it began is still written whole (Node's `pty.write` takes the string at once,
/// terminal-manager.ts:419): the next write, which waits behind it, finds all of it written first.
#[tokio::test(flavor = "multi_thread")]
async fn a_write_whose_caller_is_dropped_midway_is_written_whole() {
    let m = manager_with(ProcessConfig { input_queue_bytes: 16, ..ProcessConfig::default() });
    let h = handle("dropped-writer");
    m.spawn(SpawnRequest { stdin_piped: true, ..request(&h, CommandSpec::Argv { program: "sort".into(), args: vec![] }) }).await.unwrap();
    // Longer than the queue many times over, within `sort`'s line limit (4096 on Windows).
    let long = "x".repeat(4000);
    let mut first = Box::pin(m.write_input_wait(&h, format!("{long}\n").into_bytes()));
    let _ = poll_once(&mut first).await;
    drop(first);
    mixdog_rt::time::timeout(WAIT, m.write_input_wait(&h, b"END\n".to_vec())).await.expect("the second write within the deadline").unwrap();
    m.close_stdin(&h).unwrap();
    let (output, _) = collect(&m, &h).await;
    let lines: Vec<String> = String::from_utf8(output).unwrap().lines().map(|line| line.trim_end().to_owned()).collect();
    assert_eq!(lines, ["END".to_owned(), long], "both writes, whole");
}

/// A write waiting for room ends when the input is refused (a disposed terminal), and lets go of the write side: a later write is
/// refused as closed, not queued behind it.
#[tokio::test(flavor = "multi_thread")]
async fn refusing_the_input_ends_a_waiting_write() {
    let m = manager_with(ProcessConfig { input_queue_bytes: 16, ..ProcessConfig::default() });
    let h = handle("refused-writer");
    m.spawn(SpawnRequest { stdin_piped: true, ..request(&h, long_sleep()) }).await.unwrap();
    let mut first = Box::pin(m.write_input_wait(&h, "é".repeat(256 * 1024).into_bytes()));
    assert!(poll_once(&mut first).await.is_pending(), "the large write waits for room");
    m.refuse_input(&h);
    assert_eq!(mixdog_rt::time::timeout(WAIT, first).await.expect("the write ends when the input is refused"), Err(ProcessError::StdinClosed));
    assert_eq!(m.write_input(&h, b"x".to_vec()), Err(ProcessError::StdinClosed), "the write side is free and refuses");
    m.kill(&h).unwrap();
    let _ = collect(&m, &h).await;
}

/// A whole write resolves only once the process has its bytes, not once they are queued: to a process that reads nothing, it
/// is still waiting with every byte inside the queue, and when the process is ended before reading them it fails, so a
/// caller never takes a part of its input for the whole.
#[tokio::test(flavor = "multi_thread")]
async fn a_whole_write_is_done_when_the_process_has_it_and_fails_when_it_never_does() {
    let m = manager();
    let h = handle("whole-unread");
    m.spawn(SpawnRequest { stdin_piped: true, ..request(&h, long_sleep()) }).await.unwrap();
    // Well inside the 1 MiB queue, far more than the pipe holds.
    let mut write = Box::pin(m.write_input_whole(&h, vec![b'x'; 512 * 1024]));
    assert!(poll_once(&mut write).await.is_pending(), "queued is not written");
    m.kill(&h).unwrap();
    let ended = mixdog_rt::time::timeout(WAIT, write).await.expect("the write ends with the process");
    assert!(ended.is_err(), "an unread write fails: {ended:?}");
    let _ = collect(&m, &h).await;
}

async fn poll_once<F: std::future::Future + Unpin>(future: &mut F) -> std::task::Poll<F::Output> {
    std::future::poll_fn(|cx| std::task::Poll::Ready(std::pin::Pin::new(&mut *future).poll(cx))).await
}

/// Input larger than the whole input queue is written in pieces, in order, instead of being refused for its size (Node's `pty.write`
/// takes any length): `sort` reads 64 lines through a queue of 16 bytes and prints them all.
#[tokio::test(flavor = "multi_thread")]
async fn input_larger_than_the_queue_is_written_in_pieces() {
    let m = manager_with(ProcessConfig { input_queue_bytes: 16, ..ProcessConfig::default() });
    let h = handle("big-input");
    m.spawn(SpawnRequest { stdin_piped: true, ..request(&h, CommandSpec::Argv { program: "sort".into(), args: vec![] }) }).await.unwrap();
    let lines: Vec<String> = (0..64).map(|n| format!("line {n:02}")).collect();
    let text = lines.iter().map(|line| format!("{line}\n")).collect::<String>();
    assert!(text.len() > 16 * 4);
    mixdog_rt::time::timeout(WAIT, m.write_input_wait(&h, text.into_bytes())).await.expect("the input was written within the deadline").unwrap();
    m.close_stdin(&h).unwrap();
    let (output, _) = collect(&m, &h).await;
    let got: Vec<String> = String::from_utf8_lossy(&output).lines().map(str::to_owned).collect();
    assert_eq!(got, lines);
}

/// A scope a computer helper is launched under: revoked or not, the handles it launched, and a signal when a launch asks for its
/// commit.
#[derive(Default)]
struct TestScope {
    state: std::sync::Mutex<(bool, Vec<mixdog_protocol::ProcessHandle>)>,
    asked: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

struct TestCommit<'a>(std::sync::MutexGuard<'a, (bool, Vec<mixdog_protocol::ProcessHandle>)>);

impl mixdog_core_api::domain::process::LaunchCommit for TestCommit<'_> {
    fn launched(&mut self, handle: &mixdog_protocol::ProcessHandle) {
        self.0.1.push(handle.clone());
    }
}

impl mixdog_core_api::domain::process::LaunchAuthority for TestScope {
    fn begin(&self) -> Option<Box<dyn mixdog_core_api::domain::process::LaunchCommit + '_>> {
        if let Some(asked) = self.asked.lock().unwrap().take() {
            let _ = asked.send(());
        }
        let state = self.state.lock().unwrap();
        (!state.0).then(|| Box::new(TestCommit(state)) as Box<dyn mixdog_core_api::domain::process::LaunchCommit>)
    }
}

fn scoped(h: &mixdog_protocol::ProcessHandle, scope: &std::sync::Arc<TestScope>) -> SpawnRequest {
    let owner = mixdog_core_api::domain::process::ProcessOwner::ComputerHelper { scope: Some(mixdog_core_api::domain::process::LaunchScope(scope.clone())) };
    SpawnRequest { owner, ..request(h, long_sleep()) }
}

/// A launch queued before its scope's revocation and reaching its creation while the revocation holds the scope is refused when the
/// revocation completes: nothing is created. The revocation is held with the scope's own lock (a barrier), not timed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_queued_helper_launch_whose_scope_is_revoked_meanwhile_creates_nothing() {
    let m = manager();
    let scope = std::sync::Arc::new(TestScope::default());
    let (told, asked) = std::sync::mpsc::channel();
    *scope.asked.lock().unwrap() = Some(told);
    let revoking = scope.state.lock().unwrap();
    let h = handle("revoked-meanwhile");
    let (manager, request) = (m.clone(), scoped(&h, &scope));
    let launch = tokio::spawn(async move { manager.spawn(request).await });
    tokio::task::spawn_blocking(move || asked.recv()).await.unwrap().expect("the launch asked for its commit");
    let mut revoking = revoking;
    revoking.0 = true;
    drop(revoking);
    assert_eq!(launch.await.unwrap(), Err(ProcessError::Revoked));
    assert!(m.info(&h).is_err(), "no process was created");
    assert!(scope.state.lock().unwrap().1.is_empty());
}

/// A launch whose scope holds is registered with the scope by its handle before the commit is let go: a revocation that follows
/// finds it and can stop it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_helper_launched_under_a_scope_is_registered_with_it() {
    let m = manager();
    let scope = std::sync::Arc::new(TestScope::default());
    let h = handle("registered");
    m.spawn(scoped(&h, &scope)).await.unwrap();
    let launched = {
        let mut state = scope.state.lock().unwrap();
        state.0 = true;
        state.1.clone()
    };
    assert_eq!(launched, vec![h.clone()]);
    m.kill(&launched[0]).unwrap();
    wait_exit(&m, &h).await;
    let again = handle("registered-again");
    assert_eq!(m.spawn(scoped(&again, &scope)).await, Err(ProcessError::Revoked), "a revoked scope starts nothing");
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_reaps_its_own_children_and_closes_admission() {
    let m = manager();
    let other = manager();
    let h = handle("shutdown-live");
    let natural = handle("shutdown-natural");
    let queued = handle("shutdown-queued");
    let blocked = || SpawnRequest { stdin_piped: true, ..request(&h, shell("sort.exe", "exec cat")) };
    let owned = m.spawn(blocked()).await.unwrap();
    // Even the same handle in another manager isn't owned by this shutdown.
    let unrelated = other.spawn(blocked()).await.unwrap();
    #[cfg(unix)]
    unsafe {
        assert_eq!(libc::getsid(owned.pid as libc::pid_t), owned.pid as libc::pid_t);
        assert_eq!(libc::getsid(unrelated.pid as libc::pid_t), unrelated.pid as libc::pid_t);
    }
    m.spawn(request(&natural, shell("exit /b 7", "exit 7"))).await.unwrap();
    let (_, natural_exit) = tokio::time::timeout(WAIT, collect(&m, &natural)).await.unwrap();

    let scope = std::sync::Arc::new(TestScope::default());
    let (told, asked) = std::sync::mpsc::channel();
    *scope.asked.lock().unwrap() = Some(told);
    let hold = scope.state.lock().unwrap();
    let (manager, req) = (m.clone(), scoped(&queued, &scope));
    let launch = tokio::spawn(async move { manager.spawn(req).await });
    tokio::task::spawn_blocking(move || asked.recv_timeout(WAIT)).await.unwrap().unwrap();
    let mut stop = Box::pin(m.shutdown());
    let pending = poll_once(&mut stop).await.is_pending();
    drop(hold);

    let launched = tokio::time::timeout(WAIT, launch).await.unwrap().unwrap();
    let stopped = tokio::time::timeout(WAIT, stop).await.unwrap();
    let unrelated_alive = pid_alive(unrelated.pid);
    let expected = if cfg!(windows) { ShutdownOutcome::Clean } else { ShutdownOutcome::Unverified };
    assert_eq!(tokio::time::timeout(WAIT, other.shutdown()).await.unwrap(), expected);

    assert!(pending, "shutdown waits for an admission that could still create a child");
    assert_eq!(launched, Err(ProcessError::Revoked));
    assert_eq!(stopped, expected, "Unix cannot prove no descendant escaped");
    assert_eq!(tokio::time::timeout(WAIT, m.shutdown()).await.unwrap(), stopped);
    assert_eq!(m.live(), 0);
    assert!(!pid_alive(owned.pid));
    assert!(unrelated_alive);
    let exit = m.info(&h).unwrap().exit.unwrap();
    #[cfg(unix)]
    assert_eq!(exit.status, ExitStatus::Signal(libc::SIGKILL));
    #[cfg(windows)]
    assert_eq!(exit.status, ExitStatus::Code(137));
    assert_eq!(exit.killed, None, "the OS status does not prove who caused the exit");
    assert_eq!(natural_exit.status, ExitStatus::Code(7));
    assert_eq!(m.info(&natural).unwrap().exit, Some(natural_exit));
    assert_eq!(natural_exit.killed, None);
    assert_eq!(m.spawn(request(&queued, long_sleep())).await, Err(ProcessError::Revoked));
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_confirms_an_older_windows_job_after_its_handle_is_reused() {
    let m = manager_with(ProcessConfig { output_drain: Duration::ZERO, ..ProcessConfig::default() });
    let h = handle("shutdown-reused-job");
    let mut command = orphan_pipe_script();
    let CommandSpec::Shell { script, .. } = &mut command else { unreachable!() };
    script.push_str("; [Console]::ReadLine() | Out-Null");
    m.spawn(SpawnRequest { stdin_piped: true, ..request(&h, command) }).await.unwrap();
    let child = tokio::time::timeout(WAIT, child_pid(&m, &h)).await.unwrap();
    m.close_stdin(&h).unwrap();
    tokio::time::timeout(WAIT, collect(&m, &h)).await.unwrap();
    assert!(pid_alive(child), "the first job still has a descendant");
    m.spawn(request(&h, long_sleep())).await.unwrap();
    assert_eq!(tokio::time::timeout(WAIT, m.shutdown()).await.unwrap(), ShutdownOutcome::Clean);
    assert!(!pid_alive(child), "the first job was confirmed empty, not just the current one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn default_process_config_is_uncapped() {
    assert_eq!(ProcessConfig::default().max_processes, 0);
    let m = manager();
    let handles = [handle("uncapped-1"), handle("uncapped-2"), handle("uncapped-3")];
    for h in &handles {
        m.spawn(request(h, long_sleep())).await.unwrap();
    }
    assert_eq!(m.live(), 3);
    let expected = if cfg!(windows) { ShutdownOutcome::Clean } else { ShutdownOutcome::Unverified };
    assert_eq!(tokio::time::timeout(WAIT, m.shutdown()).await.unwrap(), expected);
}
