//! The helper against a local endpoint that plays the desktop's half: a named pipe on Windows, a unix socket elsewhere.
//! Checks the exit codes (0 answer, 1 refusal / closed / unreadable, 2 environment missing) and the exact bytes.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

const HELPER: &str = env!("CARGO_BIN_EXE_mixdog-askpass");

static NEXT: AtomicU32 = AtomicU32::new(0);

fn unique() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{:08x}{:08x}{:08x}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed), nanos as u32)
}

#[cfg(windows)]
mod endpoint {
    use std::fs::File;
    use std::os::windows::io::{FromRawHandle, RawHandle};

    unsafe extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_size: u32,
            in_size: u32,
            default_timeout: u32,
            security: *const core::ffi::c_void,
        ) -> RawHandle;
        fn ConnectNamedPipe(pipe: RawHandle, overlapped: *const core::ffi::c_void) -> i32;
    }

    pub struct Listener(File);

    pub fn bind(unique: &str) -> (String, Listener) {
        let name = format!(r"\\.\pipe\mixdog-askpass-{unique}");
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        // PIPE_ACCESS_DUPLEX, byte mode, one instance.
        // SAFETY: `wide` is a NUL-terminated name that outlives the call; the handle is owned by the File built from it.
        let handle = unsafe { CreateNamedPipeW(wide.as_ptr(), 3, 0, 1, 65536, 65536, 0, core::ptr::null()) };
        assert_ne!(handle as isize, -1, "CreateNamedPipeW failed");
        // SAFETY: a valid pipe handle nothing else owns.
        (name, Listener(unsafe { File::from_raw_handle(handle) }))
    }

    impl Listener {
        pub fn accept(self) -> File {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: the handle is the pipe this listener owns; no overlapped structure is used.
            let ok = unsafe { ConnectNamedPipe(self.0.as_raw_handle(), core::ptr::null()) };
            // A client that connected before this call reports ERROR_PIPE_CONNECTED (535), which is a connection too.
            assert!(ok != 0 || std::io::Error::last_os_error().raw_os_error() == Some(535), "ConnectNamedPipe failed");
            self.0
        }
    }

    /// Closes the server end once the helper has read everything written to it (closing first could drop it).
    pub fn hang_up(stream: File) {
        // FlushFileBuffers on a pipe waits until the other end has read the buffered bytes.
        let _ = stream.sync_all();
    }
}

#[cfg(unix)]
mod endpoint {
    use std::os::unix::net::{UnixListener, UnixStream};

    pub struct Listener(UnixListener);

    pub fn bind(unique: &str) -> (String, Listener) {
        let path = std::env::temp_dir().join(format!("mxd-ap-{unique}.sock"));
        let listener = UnixListener::bind(&path).expect("bind");
        (path.to_string_lossy().into_owned(), Listener(listener))
    }

    impl Listener {
        pub fn accept(self) -> UnixStream {
            self.0.accept().expect("accept").0
        }
    }

    /// Closes the server end; what was written stays readable for the helper.
    pub fn hang_up(stream: UnixStream) {
        drop(stream);
    }
}

/// What the helper sent and how it ended.
struct Run {
    request: String,
    output: Output,
}

/// Runs the helper against an endpoint that answers `reply` (`None`: closes after reading the request).
fn run(args: &[&str], reply: Option<&str>) -> Run {
    let (name, listener) = endpoint::bind(&unique());
    let (request_tx, request_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let reply = reply.map(str::to_owned);
    let server: JoinHandle<()> = std::thread::spawn(move || {
        let mut stream = listener.accept();
        let mut line = String::new();
        BufReader::new(&mut stream).read_line(&mut line).expect("request");
        let whole_line = reply.as_deref().is_some_and(|reply| reply.ends_with('\n'));
        if let Some(reply) = reply {
            stream.write_all(reply.as_bytes()).expect("reply");
            stream.flush().expect("flush");
        }
        request_tx.send(line).expect("send");
        if whole_line {
            // The endpoint stays open until the helper has exited: it must stop at the newline, not wait for the end.
            let _ = release_rx.recv();
        } else {
            // No whole reply line: hang up so the helper reads what was written and then sees the end.
            endpoint::hang_up(stream);
        }
    });
    let output = Command::new(HELPER)
        .args(args)
        .env("MIXDOG_ASKPASS_ENDPOINT", &name)
        .env("MIXDOG_ASKPASS_TOKEN", "tok\"en")
        .stdin(Stdio::null())
        .output()
        .expect("spawn helper");
    let request = request_rx.recv().expect("request line");
    drop(release_tx);
    server.join().expect("server");
    Run { request, output }
}

#[test]
fn answers_secret() {
    let run = run(&["Enter", "passphrase:"], Some("{\"ok\":true,\"secret\":\"s3\\u00e9 \\\"q\\\"\"}\n"));
    assert_eq!(run.request, "{\"token\":\"tok\\\"en\",\"prompt\":\"Enter passphrase:\"}\n");
    assert_eq!(run.output.status.code(), Some(0));
    assert_eq!(run.output.stdout, "s3é \"q\"\n".as_bytes());
    assert!(run.output.stderr.is_empty());
}

#[test]
fn refuses_on_ok_false() {
    for reply in ["{\"ok\":false}\n", "{\"ok\":false,\"secret\":\"leak\"}\n", "{\"ok\":true}\n", "not json\n"] {
        let run = run(&["x"], Some(reply));
        assert_eq!(run.output.status.code(), Some(1), "{reply}");
        assert!(run.output.stdout.is_empty(), "{reply}");
    }
}

#[test]
fn closes_on_eof() {
    assert_eq!(run(&["x"], None).output.status.code(), Some(1));
    // A reply that ends without its newline is not a reply.
    let run = run(&["x"], Some("{\"ok\":true,\"secret\":\"s\"}"));
    assert_eq!(run.output.status.code(), Some(1));
    assert!(run.output.stdout.is_empty());
}

#[test]
fn request_stays_within_64_kib() {
    // Windows caps a whole command line at 32,767 UTF-16 units (CreateProcess), so the prompt there is as long as a spawn
    // allows; the 64 KiB bound is reached through the prompt only on unix.
    let long = "p".repeat(if cfg!(windows) { 32_000 } else { 100_000 });
    let run = run(&[long.as_str()], Some("{\"ok\":true,\"secret\":\"s\"}\n"));
    assert!(run.request.len() <= 64 * 1024 && run.request.ends_with("\"}\n"));
    assert_eq!(run.output.status.code(), Some(0));
}

#[test]
fn exit_2_without_env() {
    let status = |endpoint: Option<&str>, token: Option<&str>| {
        let mut command = Command::new(HELPER);
        command.env_remove("MIXDOG_ASKPASS_ENDPOINT").env_remove("MIXDOG_ASKPASS_TOKEN").stdin(Stdio::null());
        if let Some(endpoint) = endpoint {
            command.env("MIXDOG_ASKPASS_ENDPOINT", endpoint);
        }
        if let Some(token) = token {
            command.env("MIXDOG_ASKPASS_TOKEN", token);
        }
        command.output().expect("spawn helper").status.code()
    };
    assert_eq!(status(None, None), Some(2));
    assert_eq!(status(Some("x"), None), Some(2));
    assert_eq!(status(None, Some("t")), Some(2));
    assert_eq!(status(Some(""), Some("t")), Some(2));
}
