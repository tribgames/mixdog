use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

#[cfg(unix)]
use std::os::fd::AsRawFd;

#[test]
fn serve_spawn_echoes_and_exits() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-spawn"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    let ready_json: serde_json::Value = serde_json::from_str(ready.trim()).unwrap();
    assert_eq!(ready_json["ready"], true);

    #[cfg(windows)]
    let request = serde_json::json!({
        "id": 1,
        "program": std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
        "args": ["/c", "echo", "spawn-ok"],
    });
    #[cfg(not(windows))]
    let request = serde_json::json!({
        "id": 1,
        "program": "/bin/echo",
        "args": ["spawn-ok"],
    });
    writeln!(stdin, "{request}").unwrap();

    let mut spawned = false;
    let mut output = String::new();
    let mut code = None;
    for _ in 0..16 {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let msg: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        match msg["event"].as_str() {
            Some("spawned") => {
                spawned = true;
                assert!(msg["pid"].as_u64().unwrap() > 0);
            }
            Some("stdout") | Some("stderr") => {
                output.push_str(msg["text"].as_str().unwrap_or(""));
            }
            Some("exit") => {
                code = msg["code"].as_i64();
                break;
            }
            Some("error") => panic!("spawn error: {msg}"),
            _ => {}
        }
    }
    drop(stdin);
    let _ = child.wait();
    assert!(spawned);
    assert_eq!(code, Some(0));
    assert!(output.to_ascii_lowercase().contains("spawn-ok"), "{output}");
}

#[test]
fn foreground_job_is_tracked_before_promotion() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-spawn"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    let ready_json: serde_json::Value = serde_json::from_str(ready.trim()).unwrap();
    assert_eq!(ready_json["caps"]["trackedForeground"], true);
    assert_eq!(ready_json["caps"]["promoteTask"], true);

    #[cfg(windows)]
    let request = serde_json::json!({
        "id": 11,
        "program": std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
        "args": ["/d", "/s", "/c", "ping 127.0.0.1 -n 6 >nul"],
        "jobId": "job_foreground_tracked",
        "ownerSessionId": "sess_owner",
        "command": "slow foreground command",
    });
    #[cfg(not(windows))]
    let request = serde_json::json!({
        "id": 11,
        "program": "/bin/sh",
        "args": ["-c", "sleep 5"],
        "jobId": "job_foreground_tracked",
        "ownerSessionId": "sess_owner",
        "command": "slow foreground command",
    });
    writeln!(stdin, "{request}").unwrap();

    let mut initial_task = None;
    for _ in 0..16 {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let msg: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        if msg["event"] == "task_started" {
            initial_task = Some(msg["task"].clone());
            break;
        }
        if msg["event"] == "error" {
            panic!("spawn error: {msg}");
        }
    }
    let initial_task = initial_task.expect("foreground task was not registered at spawn");
    assert_eq!(initial_task["jobId"], "job_foreground_tracked");
    assert_eq!(initial_task["status"], "running");
    assert_eq!(initial_task["ownerSessionId"], "sess_owner");

    let promote = serde_json::json!({
        "id": 12,
        "promoteTask": "job_foreground_tracked",
        "timeoutMs": 50,
    });
    writeln!(stdin, "{promote}").unwrap();

    let mut promoted = false;
    let mut completed = None;
    for _ in 0..32 {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let msg: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        if msg["id"] == 12 && msg["event"] == "task_started" {
            promoted = true;
        }
        if msg["event"] == "task_complete" {
            completed = Some(msg["task"].clone());
        }
        if msg["event"] == "exit" {
            break;
        }
        if msg["event"] == "error" {
            panic!("promotion error: {msg}");
        }
    }
    drop(stdin);
    let _ = child.wait();
    let completed = completed.expect("promoted task did not complete");
    assert!(promoted);
    assert_eq!(completed["jobId"], "job_foreground_tracked");
    assert_eq!(completed["status"], "failed");
    assert_eq!(completed["timedOut"], true);
}

#[cfg(unix)]
#[test]
fn server_does_not_forward_inherited_descriptors_to_spawned_commands() {
    let marker_path =
        std::env::temp_dir().join(format!("mixdog-spawn-inherited-fd-{}", std::process::id()));
    let marker = std::fs::File::create(&marker_path).unwrap();
    let marker_fd = marker.as_raw_fd();
    unsafe {
        libc::fcntl(marker_fd, libc::F_SETFD, 0);
    }

    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-spawn"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(ready.trim()).unwrap()["ready"],
        true
    );

    let command = format!(
        "target=$(readlink /proc/self/fd/{marker_fd} 2>/dev/null || true); \
         if [ \"$target\" = '{}' ]; then echo fd-leaked; else echo fd-clean; fi",
        marker_path.display()
    );
    let request = serde_json::json!({
        "id": 1,
        "program": "/bin/sh",
        "args": ["-c", command],
    });
    writeln!(stdin, "{request}").unwrap();

    let mut output = String::new();
    for _ in 0..16 {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let msg: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        match msg["event"].as_str() {
            Some("stdout") | Some("stderr") => {
                output.push_str(msg["text"].as_str().unwrap_or(""));
            }
            Some("exit") => break,
            Some("error") => panic!("spawn error: {msg}"),
            _ => {}
        }
    }
    drop(stdin);
    let _ = child.wait();
    drop(marker);
    let _ = std::fs::remove_file(marker_path);
    assert!(output.contains("fd-clean"), "{output}");
    assert!(!output.contains("fd-leaked"), "{output}");
}
