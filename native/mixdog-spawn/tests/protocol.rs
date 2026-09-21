use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

#[cfg(unix)]
use std::os::fd::AsRawFd;

fn read_message(stdout: &mut impl BufRead) -> serde_json::Value {
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).unwrap()
}

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
    let ready_json = read_message(&mut stdout);
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
        let msg = read_message(&mut stdout);
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
    let ready_json = read_message(&mut stdout);
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
        let msg = read_message(&mut stdout);
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
        let msg = read_message(&mut stdout);
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

#[test]
fn track_and_promote_preserve_omitted_metadata_and_apply_present_values() {
    for operation in ["track", "promote"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-spawn"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut stdin = child.stdin.take().unwrap();
        assert_eq!(read_message(&mut stdout)["ready"], true);

        let cwd = std::env::current_dir()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        #[cfg(windows)]
        let mut request = serde_json::json!({
            "program": std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            "args": ["/d", "/s", "/c", "ping 127.0.0.1 -n 6 >nul"],
        });
        #[cfg(not(windows))]
        let mut request = serde_json::json!({
            "program": "/bin/sh",
            "args": ["-c", "sleep 5"],
        });
        request["id"] = serde_json::json!(11);
        request["jobId"] = serde_json::json!("job_metadata");
        request["command"] = serde_json::json!("original command");
        request["cwd"] = serde_json::json!(cwd);
        request["shellType"] = serde_json::json!("original shell");
        request["ownerSessionId"] = serde_json::json!("original owner");
        request["clientHostPid"] = serde_json::json!(101);
        writeln!(stdin, "{request}").unwrap();
        assert_eq!(read_message(&mut stdout)["event"], "spawned");
        assert_eq!(read_message(&mut stdout)["event"], "task_started");

        let cases = [
            (
                serde_json::json!({}),
                serde_json::json!([
                    "original command",
                    cwd,
                    "original shell",
                    "original owner",
                    101
                ]),
            ),
            (
                serde_json::json!({
                    "command": null,
                    "cwd": null,
                    "shellType": null,
                    "ownerSessionId": null,
                    "clientHostPid": null,
                }),
                serde_json::json!([
                    "original command",
                    cwd,
                    "original shell",
                    "original owner",
                    101
                ]),
            ),
            (
                serde_json::json!({
                    "command": "updated command",
                    "cwd": "updated cwd",
                    "shellType": "updated shell",
                    "ownerSessionId": "updated owner",
                    "clientHostPid": 202,
                }),
                serde_json::json!([
                    "updated command",
                    "updated cwd",
                    "updated shell",
                    "updated owner",
                    202
                ]),
            ),
            (
                serde_json::json!({
                    "cwd": "",
                    "shellType": null,
                    "ownerSessionId": "",
                    "clientHostPid": 0,
                }),
                serde_json::json!(["updated command", "", "updated shell", "", 0]),
            ),
            (
                serde_json::json!({"command": "", "shellType": ""}),
                serde_json::json!(["", "", "", "", 0]),
            ),
            (
                serde_json::json!({}),
                serde_json::json!(["", "", "", "", 0]),
            ),
        ];
        let fields = [
            "command",
            "cwd",
            "shellType",
            "ownerSessionId",
            "clientHostPid",
        ];
        for (index, (mut request, expected)) in cases.into_iter().enumerate() {
            let id = 20 + index as u64;
            request["id"] = serde_json::json!(id);
            if operation == "track" {
                request["track"] = serde_json::json!(11);
                request["jobId"] = serde_json::json!("job_metadata");
            } else {
                request["promoteTask"] = serde_json::json!("job_metadata");
            }
            writeln!(stdin, "{request}").unwrap();
            let message = read_message(&mut stdout);
            assert_eq!(message["id"], id, "{operation}: {message}");
            assert_eq!(message["event"], "task_started", "{operation}: {message}");
            assert_eq!(message["task"]["jobId"], "job_metadata");
            assert_eq!(message["task"]["requestId"], 11);
            assert_eq!(message["task"]["status"], "running");
            for (field, value) in fields.iter().zip(expected.as_array().unwrap()) {
                assert_eq!(
                    &message["task"][field], value,
                    "{operation}, case {index}, field {field}"
                );
            }
        }

        writeln!(
            stdin,
            "{}",
            serde_json::json!({"id": 99, "cancelTask": "job_metadata"})
        )
        .unwrap();
        let mut exited = false;
        for _ in 0..16 {
            let message = read_message(&mut stdout);
            assert_ne!(message["event"], "error", "{operation}: {message}");
            if message["event"] == "exit" {
                exited = true;
                break;
            }
        }
        drop(stdin);
        child.wait().unwrap();
        assert!(exited, "{operation}: cancelled process did not exit");
    }
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
    assert_eq!(read_message(&mut stdout)["ready"], true);

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
        let msg = read_message(&mut stdout);
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
