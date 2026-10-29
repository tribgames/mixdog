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

// Windows containment: a command spawned with `contain` runs in a job object
// it cannot break away from, so the server can prove its whole tree is gone.
// The tree is started by this test binary itself (the ignored `tree_helper`),
// run through the server like any command.
#[cfg(windows)]
mod containment {
    use super::read_message;
    use std::io::{BufReader, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    const HELPER_ENV: &str = "MIXDOG_SPAWN_TREE_HELPER";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const ERROR_ACCESS_DENIED: i32 = 5;

    /// The command the helper starts: a long-lived leaf process.
    fn sleeper() -> Command {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let mut command = Command::new(format!("{root}\\System32\\PING.EXE"));
        command
            .args(["-n", "120", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    /// Run only as the command of a containment test (HELPER_ENV names the
    /// mode): starts a child, then, unless it is to leave that child behind,
    /// tries a child that breaks away from its job and waits to be killed.
    #[test]
    #[ignore = "helper process the containment tests start through the server"]
    #[allow(clippy::zombie_processes)] // its children are left to the test
    fn tree_helper() {
        let Ok(mode) = std::env::var(HELPER_ENV) else {
            return;
        };
        let child = sleeper()
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("child");
        println!("child:{}", child.id());
        if mode == "survivor" {
            println!("done");
            return;
        }
        match sleeper()
            .creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
        {
            Ok(escaped) => println!("breakaway:escaped:{}", escaped.id()),
            Err(error) => println!("breakaway:denied:{}", error.raw_os_error().unwrap_or(-1)),
        }
        std::thread::sleep(Duration::from_secs(120));
    }

    /// A process this test started, held by handle so a reused pid never
    /// stands in for it. Still running when dropped: terminated.
    struct Held(HANDLE);

    impl Held {
        fn open(pid: u32) -> Self {
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
            assert!(!handle.is_null(), "process {pid} is not running");
            Held(handle)
        }

        fn exited(&self) -> bool {
            unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
        }
    }

    impl Drop for Held {
        fn drop(&mut self) {
            unsafe {
                if !self.exited() {
                    TerminateProcess(self.0, 1);
                }
                CloseHandle(self.0);
            }
        }
    }

    struct Server {
        child: Child,
        stdin: Option<ChildStdin>,
        stdout: BufReader<ChildStdout>,
    }

    impl Server {
        fn start() -> (Self, serde_json::Value) {
            let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-spawn"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap());
            let stdin = child.stdin.take();
            let ready = read_message(&mut stdout);
            (
                Server {
                    child,
                    stdin,
                    stdout,
                },
                ready,
            )
        }

        fn send(&mut self, request: serde_json::Value) {
            writeln!(self.stdin.as_mut().unwrap(), "{request}").unwrap();
        }

        fn next(&mut self) -> serde_json::Value {
            let message = read_message(&mut self.stdout);
            assert_ne!(message["event"], "error", "{message}");
            message
        }

        /// Spawn the helper in `mode` as request `id`, then read until it has
        /// reported what it started. Returns the spawned event and its lines.
        fn helper(
            &mut self,
            id: u64,
            mode: &str,
            contain: bool,
        ) -> (serde_json::Value, Vec<String>) {
            let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
            env.insert(HELPER_ENV.to_string(), mode.to_string());
            let program = std::env::current_exe().unwrap();
            self.send(serde_json::json!({
                "id": id,
                "program": program.to_str().unwrap(),
                "args": ["containment::tree_helper", "--exact", "--ignored", "--nocapture", "--test-threads=1"],
                "env": env,
                "contain": contain,
            }));
            let mut spawned = None;
            let mut text = String::new();
            let last = if mode == "survivor" {
                "done"
            } else {
                "breakaway:"
            };
            for _ in 0..400 {
                let message = self.next();
                match message["event"].as_str() {
                    Some("spawned") => spawned = Some(message),
                    Some("stdout") => text.push_str(message["text"].as_str().unwrap_or("")),
                    Some("exit") => panic!("helper exited early: {text}"),
                    _ => {}
                }
                if text.lines().any(|line| line.contains(last)) {
                    break;
                }
            }
            let lines = text.lines().map(str::to_string).collect();
            (spawned.expect("spawned event"), lines)
        }

        /// Read until the exit of request `id`; the events seen on the way.
        fn until_exit(&mut self, id: u64) -> Vec<serde_json::Value> {
            let mut seen = Vec::new();
            for _ in 0..400 {
                let message = self.next();
                let done = message["id"] == id && message["event"] == "exit";
                seen.push(message);
                if done {
                    return seen;
                }
            }
            panic!("no exit for request {id}: {seen:?}");
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            drop(self.stdin.take());
            let _ = self.child.wait();
        }
    }

    // The harness prints its own `test … ` prefix on the line of the first one.
    fn pid_after(lines: &[String], prefix: &str) -> Option<u32> {
        lines
            .iter()
            .find_map(|line| line.split_once(prefix))
            .map(|(_, pid)| pid.trim().parse().unwrap())
    }

    #[test]
    fn a_contained_cancel_kills_the_tree_and_verifies_its_job_empty_before_exit() {
        let (mut server, ready) = Server::start();
        assert_eq!(ready["caps"]["verifiedContainment"], true, "{ready}");
        let (spawned, lines) = server.helper(1, "tree", true);
        assert_eq!(spawned["contained"], true, "{spawned}");
        let child = Held::open(pid_after(&lines, "child:").expect("child pid"));
        assert_eq!(
            pid_after(&lines, "breakaway:denied:"),
            Some(ERROR_ACCESS_DENIED as u32),
            "a contained command cannot start a process outside its job: {lines:?}"
        );
        server.send(serde_json::json!({ "cancel": 1 }));
        let events = server.until_exit(1);
        let empty_at = events
            .iter()
            .position(|message| message["id"] == 1 && message["event"] == "tree_empty");
        assert!(empty_at.is_some(), "the job was verified empty: {events:?}");
        let exit = events.last().unwrap();
        assert_eq!(exit["treeOutcome"], "empty", "{exit}");
        assert!(child.exited(), "the child died with its root");
    }

    #[test]
    fn a_contained_command_that_exits_on_its_own_reports_its_empty_job() {
        let (mut server, _) = Server::start();
        server.send(serde_json::json!({
            "id": 3,
            "program": std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            "args": ["/d", "/s", "/c", "echo contained-ok"],
            "contain": true,
        }));
        let events = server.until_exit(3);
        assert!(
            events
                .iter()
                .any(|message| message["event"] == "tree_empty"),
            "{events:?}"
        );
        let exit = events.last().unwrap();
        assert_eq!(exit["code"], 0, "{exit}");
        assert_eq!(exit["treeOutcome"], "empty", "{exit}");
    }

    #[test]
    fn a_contained_command_that_exits_on_its_own_leaves_what_it_started_running() {
        let (mut server, _) = Server::start();
        let (_, lines) = server.helper(4, "survivor", true);
        let survivor = Held::open(pid_after(&lines, "child:").expect("child pid"));
        let events = server.until_exit(4);
        assert!(
            !events
                .iter()
                .any(|message| message["event"] == "tree_empty"),
            "{events:?}"
        );
        let exit = events.last().unwrap();
        assert_eq!(exit["code"], 0, "{exit}");
        assert_eq!(
            exit["treeOutcome"], "preserved",
            "a finished command's survivors are not killed: {exit}"
        );
        // Its job handle is closed by now: kill-on-close must not reach it.
        std::thread::sleep(Duration::from_millis(500));
        assert!(!survivor.exited(), "the survivor still runs");
    }

    #[test]
    fn a_cancel_after_a_contained_command_finished_kills_its_kept_survivors_through_the_job() {
        let (mut server, _) = Server::start();
        let (_, lines) = server.helper(5, "survivor", true);
        let survivor = Held::open(pid_after(&lines, "child:").expect("child pid"));
        let exit = server.until_exit(5).pop().unwrap();
        assert_eq!(exit["treeOutcome"], "preserved", "{exit}");
        // The request is reported; its survivors are still in its job.
        server.send(serde_json::json!({ "cancel": 5 }));
        let mut verified = false;
        for _ in 0..50 {
            let message = server.next();
            if message["id"] == 5 && message["event"] == "tree_empty" {
                verified = true;
                break;
            }
        }
        assert!(verified, "the kept survivors were killed and verified gone");
        let exited = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(10));
            survivor.exited()
        });
        assert!(exited, "the survivor died with the job");
    }

    #[test]
    fn an_uncontained_job_proves_nothing_a_breakaway_child_escapes_its_cancel() {
        let (mut server, _) = Server::start();
        let (spawned, lines) = server.helper(2, "tree", false);
        assert_ne!(spawned["contained"], true, "{spawned}");
        let escaped = pid_after(&lines, "breakaway:escaped:").map(Held::open);
        server.send(serde_json::json!({ "cancel": 2 }));
        let events = server.until_exit(2);
        let exit = events.last().unwrap();
        assert!(
            exit.get("treeOutcome").is_none(),
            "no emptiness claim without containment: {exit}"
        );
        match escaped {
            Some(escaped) => assert!(!escaped.exited(), "the escaped child outlives the job kill"),
            // A job this test itself runs in forbids breakaway.
            None => eprintln!("breakaway refused by an enclosing job: {lines:?}"),
        }
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
