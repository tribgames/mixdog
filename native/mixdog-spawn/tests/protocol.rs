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

#[cfg(unix)]
#[test]
fn server_does_not_forward_inherited_descriptors_to_spawned_commands() {
    let marker_path = std::env::temp_dir().join(format!(
        "mixdog-spawn-inherited-fd-{}",
        std::process::id()
    ));
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
