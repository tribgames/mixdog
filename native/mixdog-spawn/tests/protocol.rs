use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

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
