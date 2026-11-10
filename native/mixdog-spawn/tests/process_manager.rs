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
use mixdog_spawn::tasks::TaskOutcome;
use mixdog_spawn::tasks::TaskStatus;

fn long_sleep() -> CommandSpec {
    shell("ping -n 40 127.0.0.1 >nul", "sleep 40")
}

async fn wait_exit(manager: &mixdog_spawn::LocalProcessManager, h: &mixdog_protocol::ProcessHandle) {
    while manager.info(h).unwrap().exit.is_none() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exit_codes_and_merged_output() {
    let m = manager();
    let h = handle("exit-code");
    m.spawn(request(&h, shell("echo out& echo err 1>&2& exit 7", "echo out; echo err >&2; exit 7")))
        .await
        .unwrap();
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
    let started = Instant::now();
    m.spawn(req).await.unwrap();
    let (_, exit) = collect(&m, &h).await;
    assert_eq!(exit.killed, Some(KillReason::TimeLimit));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
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
    m.spawn(request(&h, shell(&format!("type \"{path}\""), &format!("cat '{path}'"))))
        .await
        .unwrap();
    let (bytes, exit) = collect(&m, &h).await;
    assert_eq!(exit.status, ExitStatus::Code(0));
    assert_eq!(bytes.len(), data.len());
    assert!(bytes == data.as_bytes(), "output differs from the file");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handles_limits_and_errors() {
    let m = manager_with(ProcessConfig {
        max_processes: 2,
        input_queue_bytes: 10,
        ..ProcessConfig::default()
    });
    let (a, b, c) = (handle("limit-a"), handle("limit-b"), handle("limit-c"));
    m.spawn(request(&a, long_sleep())).await.unwrap();
    assert_eq!(
        m.spawn(request(&a, long_sleep())).await,
        Err(ProcessError::HandleInUse)
    );
    let missing = m
        .spawn(request(&handle("gone"), CommandSpec::Argv { program: "mixdog-no-such-program".into(), args: vec![] }))
        .await;
    assert!(matches!(missing, Err(ProcessError::ProgramNotFound { .. })), "{missing:?}");
    // A failed spawn leaves no slot behind.
    assert_eq!(m.live(), 1);
    let mut with_stdin = request(&b, shell("findstr \"^\"", "cat"));
    with_stdin.stdin_piped = true;
    m.spawn(with_stdin).await.unwrap();
    assert_eq!(
        m.spawn(request(&c, long_sleep())).await,
        Err(ProcessError::LimitReached { limit: 2 })
    );
    assert_eq!(m.live(), 2);
    // An input queue over its bound refuses the whole write and says so.
    assert_eq!(
        m.write_stdin(&b, vec![b'x'; 11]).await,
        Err(ProcessError::Overloaded { queue: ProcessQueue::Input })
    );
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
    let m = manager_with(ProcessConfig {
        ring_bytes: 4096,
        ..ProcessConfig::default()
    });
    let h = handle("ring");
    let path = file.display().to_string();
    // A consumer keeps up, so the reader is never held back by it.
    m.spawn(request(&h, shell(&format!("type \"{path}\""), &format!("cat '{path}'"))))
        .await
        .unwrap();
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

fn tree_script() -> CommandSpec {
    if cfg!(windows) {
        CommandSpec::Shell {
            script: "$p = Start-Process ping -ArgumentList '-n','90','127.0.0.1' -PassThru -WindowStyle Hidden; \
                     Write-Output \"CHILD=$($p.Id)\"; Start-Sleep 90"
                .to_owned(),
            shell: Some("powershell".to_owned()),
        }
    } else {
        CommandSpec::Shell {
            script: "sleep 90 & echo CHILD=$!; sleep 90".to_owned(),
            shell: None,
        }
    }
}

/// DS-PROC-6 and the tree-kill of DS-PROC-1: one kill takes the grandchild with the root, and
/// both are gone within 100 ms.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_takes_the_whole_tree_within_100ms() {
    let m = manager();
    let h = handle("tree");
    m.spawn(request(&h, tree_script())).await.unwrap();
    let grandchild = child_pid(&m, &h).await;
    assert!(pid_alive(grandchild), "the grandchild runs");
    let started = Instant::now();
    m.kill(&h).unwrap();
    let killed_in = started.elapsed();
    while pid_alive(grandchild) {
        assert!(started.elapsed() < Duration::from_secs(5), "the grandchild survived the kill");
        std::thread::sleep(Duration::from_millis(1));
    }
    let gone_after = started.elapsed();
    wait_exit(&m, &h).await;
    let exit_after = started.elapsed();
    eprintln!("kill issued in {killed_in:?}, grandchild gone after {gone_after:?}, exit event after {exit_after:?}");
    assert!(gone_after <= Duration::from_millis(100), "tree gone after {gone_after:?}");
    assert!(exit_after <= Duration::from_millis(100), "exit announced after {exit_after:?}");
    assert_eq!(m.info(&h).unwrap().exit.unwrap().killed, Some(KillReason::Requested));
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
        tokio::time::sleep(Duration::from_millis(5)).await;
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
    tokio::time::timeout(Duration::from_secs(60), m.output_blocked(h))
        .await
        .expect("the reader never parked at its feed's gate within 60 s")
        .unwrap()
}
/// DS-PROC-4: a 10 MB flood to a client that does not read stalls the PTY reader at the ring
/// bound, a second client's keystrokes still pass, another process is not slowed, and reading
/// again lets the flood finish.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn flood_to_a_stalled_client_stops_at_the_ring_bound() {
    const RING: usize = 1024 * 1024;
    let (path, _file) = big_pty_file("flood", 10 * 1024 * 1024);
    let m = manager_with(ProcessConfig {
        ring_bytes: RING,
        ..ProcessConfig::default()
    });
    let h = handle("flood");
    let cmd = flood_command(&path);
    m.spawn(pty_request(&h, cmd, PtySize { cols: 120, rows: 40 })).await.unwrap();
    // The client that never reads: subscribed, never polled.
    let mut client = m.subscribe(&h, None).unwrap();
    let stalled_at = pushed_when_blocked(&m, &h).await;
    assert!(
        stalled_at as usize <= RING && stalled_at as usize + 192 * 1024 >= RING,
        "reader stalled at {stalled_at}, ring bound {RING}"
    );
    assert!(m.info(&h).unwrap().exit.is_none(), "the flood is held back, not finished");

    // A second client's keystrokes pass while the output is stalled.
    let started = Instant::now();
    m.write_input(&h, b"x".to_vec()).unwrap();
    while m.input_backlog(&h).unwrap() > 0 {
        assert!(started.elapsed() < Duration::from_secs(2), "keystroke stuck behind the stalled output");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Another process is neither slowed nor stalled by it.
    let other = handle("flood-other");
    let t = Instant::now();
    m.spawn(request(&other, shell("echo unaffected", "echo unaffected"))).await.unwrap();
    let (bytes, exit) = collect(&m, &other).await;
    assert_eq!(exit.status, ExitStatus::Code(0));
    assert!(text(&bytes).contains("unaffected"));
    assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());

    // The client reads again: the flood completes, up to its last line.
    let drain_started = Instant::now();
    let mut tail: Vec<u8> = Vec::new();
    let mut total = 0usize;
    tokio::time::timeout(Duration::from_secs(120), async {
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
        tokio::time::sleep(Duration::from_millis(10)).await;
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
/// the gate).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn natural_exit_behind_paused_output_is_published_and_frees_the_slot() {
    let m = manager_with(ProcessConfig {
        max_processes: 1,
        ..ProcessConfig::default()
    });
    for (name, pty) in [("paused-pipe", false), ("paused-pty", true)] {
        let h = handle(name);
        let cmd = shell(
            "echo first& ping -n 3 127.0.0.1 >nul& echo last",
            "echo first; sleep 2; echo last",
        );
        let req = if pty {
            pty_request(&h, cmd, PtySize { cols: 100, rows: 30 })
        } else {
            request(&h, cmd)
        };
        m.spawn(req).await.unwrap();
        while m.output_pushed(&h).unwrap() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        m.set_output_paused(&h, true).unwrap();
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
        CommandSpec::Shell {
            script: "sleep 60 & echo CHILD=$!".to_owned(),
            shell: None,
        }
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
    let m = manager_with(ProcessConfig {
        output_drain: Duration::from_secs(60),
        ..ProcessConfig::default()
    });
    let h = handle("orphan-pipe");
    m.spawn(request(&h, orphan_pipe_script())).await.unwrap();
    let grandchild = child_pid(&m, &h).await;
    // Long enough for the root to be gone; the pipe is still held.
    tokio::time::sleep(Duration::from_millis(1500)).await;
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
        tokio::time::sleep(Duration::from_millis(5)).await;
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
    let m = manager_with(ProcessConfig {
        output_drain: Duration::from_millis(50),
        ..ProcessConfig::default()
    });
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
    let m = manager_with(ProcessConfig {
        ring_bytes: 256 * 1024,
        ..ProcessConfig::default()
    });
    let h = handle("kill-stalled");
    let cmd = flood_command(&path);
    m.spawn(pty_request(&h, cmd, PtySize { cols: 100, rows: 30 })).await.unwrap();
    let _client = m.subscribe(&h, None).unwrap();
    pushed_when_blocked(&m, &h).await;
    m.kill(&h).unwrap();
    wait_exit(&m, &h).await;
    assert_eq!(m.info(&h).unwrap().exit.unwrap().killed, Some(KillReason::Requested));
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
    m.write_input(&h, b"echo MIXDOG_PTY_OK\r".to_vec()).unwrap();
    // A resize storm: the last size wins.
    for i in 0..200u16 {
        m.resize_pty(&h, PtySize { cols: 20 + (i * 37) % 180, rows: 10 + (i * 11) % 50 }).unwrap();
    }
    m.resize_pty(&h, PtySize { cols: 97, rows: 31 }).unwrap();
    assert_eq!(m.info(&h).unwrap().pty, Some(PtySize { cols: 97, rows: 31 }));
    let query = if cfg!(windows) { "mode con\r" } else { "stty size\r" };
    m.write_input(&h, query.as_bytes().to_vec()).unwrap();
    m.write_input(&h, b"exit\r".to_vec()).unwrap();
    let (bytes, exit) = collect(&m, &h).await;
    let out = text(&bytes);
    assert!(out.contains("MIXDOG_PTY_OK"), "{out:?}");
    assert!(out.contains("97"), "the shell reports the final width: {out:?}");
    assert_eq!(exit.status, ExitStatus::Code(0));
    assert_eq!(m.resize_pty(&h, PtySize { cols: 10, rows: 10 }), Err(ProcessError::AlreadyExited));
}

/// The isolation property: the exit of one process is announced while another's output is
/// still being produced and consumed, and neither waits for the other.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_processes_exit_never_waits_for_anothers_output() {
    let m = manager();
    let slow = handle("slow");
    m.spawn(request(&slow, shell("ping -n 6 127.0.0.1", "for i in 1 2 3 4 5; do echo tick; sleep 1; done"))).await.unwrap();
    let mut quick = Vec::new();
    for i in 0..8 {
        let h = handle(&format!("quick-{i}"));
        m.spawn(request(&h, shell(&format!("echo quick {i}"), &format!("echo quick {i}")))).await.unwrap();
        quick.push(h);
    }
    let t = Instant::now();
    for h in &quick {
        let (_, exit) = collect(&m, h).await;
        assert_eq!(exit.status, ExitStatus::Code(0));
    }
    assert!(t.elapsed() < Duration::from_secs(4), "quick processes waited {:?}", t.elapsed());
    assert!(m.info(&slow).unwrap().exit.is_none(), "the slow process is still running");
    m.kill(&slow).unwrap();
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
    tokio::time::timeout(WAIT, m.write_input_wait(&h, text.into_bytes())).await.expect("the input was written within the deadline").unwrap();
    m.close_stdin(&h).unwrap();
    let (output, _) = collect(&m, &h).await;
    let got: Vec<String> = String::from_utf8_lossy(&output).lines().map(str::to_owned).collect();
    assert_eq!(got, lines);
}
