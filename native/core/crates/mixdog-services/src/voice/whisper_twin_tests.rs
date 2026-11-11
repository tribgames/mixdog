//! Rust against Node's recorded whisper pipeline (`fixtures/services/whisper-twin.json`,
//! `record-whisper.mjs`): the children one transcription starts (ffprobe, ffmpeg, whisper-server,
//! the listener-ownership query) with their arguments, what is POSTed to the server, the listener
//! query on every platform and the Windows tree-kill command.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::{CommandSpec, ExitStatus, KillReason, OutputStream, ProcessError, ProcessEvent, ProcessExit, ProcessInfo, ProcessManager, PtySize, SpawnRequest, SpawnedProcess};
use mixdog_protocol::ProcessHandle;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

use super::pipeline::VoicePipeline;
use super::pipeline::tests::Fixed;
use super::runtime::{RuntimeManifest, SERVER_NAME};
use super::whisper_owner::{Os, listener_owned_on, listener_pids_include, tree_kill_command};
use super::whisper_server::{ProcessAudioTools, WhisperServer};
use crate::tidy::process::Processes;

const WHISPER_PID: u32 = 2_147_480_001;

fn fixture() -> Value {
    let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
    serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/whisper-twin.json")).unwrap()).unwrap()
}

fn stem(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    name.strip_suffix(".exe").unwrap_or(name).to_owned()
}

fn wav_bytes() -> Vec<u8> {
    let data = [1u8; 32];
    let mut wav = Vec::new();
    wav.extend(b"RIFF");
    wav.extend((36 + data.len() as u32).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16u32.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(1u16.to_le_bytes());
    wav.extend(16000u32.to_le_bytes());
    wav.extend(32000u32.to_le_bytes());
    wav.extend(2u16.to_le_bytes());
    wav.extend(16u16.to_le_bytes());
    wav.extend(b"data");
    wav.extend((data.len() as u32).to_le_bytes());
    wav.extend(data);
    wav
}

/// What the listener-ownership query answers on `os`, as Node's recorder scripted it.
fn listener_answer(os: Os, pid: u32, port: u16) -> String {
    match os {
        Os::Windows => format!("{pid}\r\n"),
        Os::Linux => format!("LISTEN 0 4096 127.0.0.1:{port} 0.0.0.0:* users:((\"whisper-server\",pid={pid},fd=3))\n"),
        Os::Other => format!("p{pid}\n"),
    }
}

fn host_os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "linux") {
        Os::Linux
    } else {
        Os::Other
    }
}

struct Events(mpsc::UnboundedReceiver<ProcessEvent>);

#[async_trait]
impl EventSource<ProcessEvent> for Events {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.0.recv().await
    }
}

#[derive(Default)]
pub(super) struct Scripted {
    /// `{kind, file, args, cwd?}` per child the code started, in order.
    calls: Mutex<Vec<Value>>,
    requests_shared: Arc<Mutex<Vec<Value>>>,
    next_pid: AtomicU32,
    pending: Mutex<HashMap<String, mpsc::UnboundedReceiver<ProcessEvent>>>,
    pub(super) servers: Mutex<HashMap<String, (mpsc::UnboundedSender<ProcessEvent>, tokio::task::JoinHandle<()>)>>,
    /// What the listener query answers: `None` fails it, `Some(pid)` names the listening pid.
    listener_pid: Mutex<Option<u32>>,
    listener_os: Mutex<Option<Os>>,
    listener_port: AtomicU32,
    /// While set, the server reads an `/inference` request and never answers it.
    pub(super) hang_inference: Arc<AtomicBool>,
    /// Notified when a hung `/inference` request has been read.
    pub(super) inference_seen: Arc<Notify>,
    /// Notified when a child is killed.
    pub(super) killed: Notify,
}

impl Scripted {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self { next_pid: AtomicU32::new(5000), listener_pid: Mutex::new(Some(WHISPER_PID)), ..Default::default() })
    }
}

async fn serve(listener: tokio::net::TcpListener, requests: Arc<Mutex<Vec<Value>>>, hang: Arc<AtomicBool>, seen: Arc<Notify>) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { return };
        let mut raw = Vec::new();
        let mut chunk = [0u8; 8192];
        let (head_end, length) = loop {
            let Ok(read) = stream.read(&mut chunk).await else { break (0, 0) };
            if read == 0 {
                break (0, 0);
            }
            raw.extend_from_slice(&chunk[..read]);
            if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&raw[..at]).to_lowercase();
                let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                break (at + 4, length);
            }
        };
        // The readiness probe connects and hangs up without a request.
        if head_end == 0 {
            continue;
        }
        while raw.len() < head_end + length {
            let Ok(read) = stream.read(&mut chunk).await else { break };
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..read]);
        }
        let head = String::from_utf8_lossy(&raw[..head_end.min(raw.len())]).into_owned();
        let mut first = head.lines().next().unwrap_or_default().split(' ');
        let (method, url) = (first.next().unwrap_or_default().to_owned(), first.next().unwrap_or_default().to_owned());
        let multipart = head.lines().any(|l| l.to_lowercase().starts_with("content-type: multipart/form-data; boundary="));
        let body: String = raw[head_end.min(raw.len())..].iter().map(|b| char::from(*b)).collect();
        let part = regex::Regex::new(r#"name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: ([^\r]+)\r\n)?\r\n([^\r]*)"#).unwrap();
        let fields: Vec<Value> = part
            .captures_iter(&body)
            .map(|m| json!({"name": &m[1], "filename": m.get(2).map(|f| f.as_str()), "type": m.get(3).map(|t| t.as_str()), "value": if m.get(2).is_some() { Value::Null } else { json!(&m[4]) }}))
            .collect();
        requests.lock().unwrap().push(json!({"method": method, "url": url, "multipart": multipart, "fields": fields}));
        if hang.load(Ordering::SeqCst) {
            seen.notify_one();
            std::future::pending::<()>().await;
        }
        let reply = r#"{"text":" hello world "}"#;
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await;
        let _ = stream.shutdown().await;
    }
}

fn exited(seq: u64, code: i32) -> ProcessEvent {
    ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(code), killed: None } }
}

#[async_trait]
impl ProcessManager for Scripted {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { program, args } = &request.command else { return Err(ProcessError::Io { os_code: None }) };
        let name = stem(program);
        let port_at = args.iter().position(|a| a == "--port");
        let (tx, rx) = mpsc::unbounded_channel();
        let mut pid = self.next_pid.fetch_add(1, Ordering::SeqCst);
        let data = args.last().cloned().unwrap_or_default();
        if name == "whisper-server" || name == "ffmpeg" || name.starts_with("ffprobe") {
            let mut call = json!({"kind": "spawn", "file": name, "args": args.iter().enumerate().map(|(i, a)| if Some(i) == port_at.map(|p| p + 1) { "{PORT}".to_owned() } else { a.clone() }).collect::<Vec<_>>()});
            if name == "whisper-server" {
                call["cwd"] = json!(request.cwd.as_path().to_string_lossy());
            }
            self.calls.lock().unwrap().push(call);
        } else {
            let port = self.listener_port.load(Ordering::SeqCst);
            let placeholder = |a: &String| a.replace(&port.to_string(), "{PORT}");
            self.calls.lock().unwrap().push(json!({"kind": "listener", "file": program, "args": args.iter().map(placeholder).collect::<Vec<_>>()}));
        }
        if name == "whisper-server" {
            pid = WHISPER_PID;
            let port: u16 = args[port_at.unwrap() + 1].parse().unwrap();
            let host = args[args.iter().position(|a| a == "--host").unwrap() + 1].clone();
            self.listener_port.store(u32::from(port), Ordering::SeqCst);
            let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await.map_err(|_| ProcessError::Io { os_code: None })?;
            let task = tokio::spawn(serve(listener, self.requests_shared.clone(), self.hang_inference.clone(), self.inference_seen.clone()));
            self.servers.lock().unwrap().insert(request.handle.0.clone(), (tx, task));
        } else if name == "ffmpeg" {
            #[allow(clippy::disallowed_methods)]
            std::fs::write(&data, wav_bytes()).map_err(|_| ProcessError::Io { os_code: None })?;
            tx.send(exited(0, 0)).unwrap();
        } else if name.starts_with("ffprobe") {
            tx.send(ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: b"12.5\n".to_vec() }).unwrap();
            tx.send(exited(1, 0)).unwrap();
        } else {
            let port = u16::try_from(self.listener_port.load(Ordering::SeqCst)).unwrap_or(0);
            let os = self.listener_os.lock().unwrap().unwrap_or_else(host_os);
            match *self.listener_pid.lock().unwrap() {
                Some(listening) => {
                    tx.send(ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: listener_answer(os, listening, port).into_bytes() }).unwrap();
                    tx.send(exited(1, 0)).unwrap();
                }
                None => tx.send(exited(0, 1)).unwrap(),
            }
        }
        self.pending.lock().unwrap().insert(request.handle.0.clone(), rx);
        Ok(SpawnedProcess { handle: request.handle, pid })
    }

    fn subscribe(&self, handle: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let rx = self.pending.lock().unwrap().remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
        Ok(Box::new(Events(rx)))
    }

    async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
        Ok(())
    }

    fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }

    fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::NotPty)
    }

    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        let (tx, task) = self.servers.lock().unwrap().remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
        task.abort();
        self.killed.notify_one();
        let _ = tx.send(ProcessEvent::Exited { seq: 0, exit: ProcessExit { status: ExitStatus::Signal(15), killed: Some(KillReason::Requested) } });
        Ok(())
    }

    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

fn replace_data(value: &Value, data: &str) -> Value {
    serde_json::from_str(&value.to_string().replace(&data.replace('\\', "\\\\"), "{DATA}")).unwrap()
}

#[tokio::test]
async fn one_transcription_starts_the_children_node_recorded_with_the_same_arguments() {
    let twin = fixture();
    let ext = if cfg!(windows) { ".exe" } else { "" };
    if twin["platform"] != if cfg!(windows) { "win32" } else if cfg!(target_os = "linux") { "linux" } else { "darwin" } {
        return;
    }
    for scenario in twin["pipeline"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let put = |rel: &str, bytes: &[u8]| {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, bytes).unwrap();
        };
        let version = scenario["version"].as_str().unwrap();
        let model = scenario["modelFilename"].as_str().unwrap();
        put("voice-runtime/active-version", format!("whisper-{version}-vulkan").as_bytes());
        put(&format!("voice-runtime/whisper-{version}-vulkan/Release/whisper-cli{ext}"), b"x");
        put(&format!("voice-runtime/whisper-{version}-vulkan/Release/{SERVER_NAME}"), b"x");
        put(&format!("voice/models/{model}"), b"model");
        put("ffmpeg-runtime/active-version", b"ffmpeg-6");
        put(&format!("ffmpeg-runtime/ffmpeg-6/ffmpeg{ext}"), b"x");
        put("in/clip.ogg", b"ogg");
        let manifest = RuntimeManifest {
            version: version.to_owned(),
            variants: vec![("vulkan".into(), format!("Release/whisper-cli{ext}"))],
            model_key: "standard".into(),
            model_id: "standard".into(),
            model_filename: model.to_owned(),
            model_size: 5,
            ffmpeg_executable: Some(format!("ffmpeg{ext}")),
        };
        let manager = Scripted::new();
        let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
        let server = Arc::new(WhisperServer::new(0, None, &processes));
        let pipeline = Arc::new(VoicePipeline::new(dir.path().to_owned(), manifest, Arc::new(Fixed(json!({"enabled": true, "transcription": scenario["voice"]["transcription"], "language": scenario["voice"]["language"]}))), server.clone(), Arc::new(ProcessAudioTools(processes.clone())), mixdog_rt::testing::tokens().durability_io));
        let text = pipeline.transcribe(&dir.path().join("in").join("clip.ogg"), Some("att-1"), &CancellationToken::new()).await.unwrap();
        assert_eq!(text.as_deref(), scenario["text"].as_str(), "{}", scenario["name"]);
        // The pid file records the child while it runs and goes with it when it dies on its own.
        let pid_path = dir.path().join("voice-runtime").join("whisper-server.pid.json");
        let recorded: Value = serde_json::from_str(&std::fs::read_to_string(&pid_path).unwrap()).unwrap();
        assert_eq!((recorded["pid"].as_u64(), recorded["host"].as_str()), (Some(u64::from(WHISPER_PID)), Some("127.0.0.1")));
        let handle = ProcessHandle(manager.servers.lock().unwrap().keys().next().unwrap().clone());
        manager.kill(&handle).unwrap();
        mixdog_rt::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!pid_path.exists(), "the exit watcher clears the pid file");
        server.stop().await;
        mixdog_rt::time::sleep(std::time::Duration::from_millis(30)).await;
        let data = dir.path().to_string_lossy().into_owned();
        // Node's ffmpeg and ffprobe carry no working directory; only the server's is recorded.
        let calls = replace_data(&Value::Array(manager.calls.lock().unwrap().clone()), &data);
        let expected: Vec<Value> = scenario["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let mut call = json!({"kind": c["kind"], "file": c["file"], "args": c["args"]});
                if c["file"] == "whisper-server" {
                    call["cwd"] = c["cwd"].clone();
                }
                call
            })
            .collect();
        assert_eq!(calls, Value::Array(expected), "{}", scenario["name"]);
        let requests = replace_data(&Value::Array(manager.requests_shared.lock().unwrap().clone()), &data);
        assert_eq!(requests, scenario["requests"], "{}", scenario["name"]);
    }
}

#[tokio::test]
async fn the_listener_query_asks_and_decides_as_node_does_on_every_platform() {
    let twin = fixture();
    let cwd = std::env::temp_dir();
    for case in twin["listener"].as_array().unwrap() {
        let os = match case["platform"].as_str().unwrap() {
            "win32" => Os::Windows,
            "linux" => Os::Linux,
            _ => Os::Other,
        };
        let manager = Scripted::new();
        manager.listener_port.store(18771, Ordering::SeqCst);
        *manager.listener_os.lock().unwrap() = Some(os);
        *manager.listener_pid.lock().unwrap() = match case["outcome"].as_str().unwrap() {
            "query fails" => None,
            "other pid" => Some(7),
            _ => Some(WHISPER_PID),
        };
        let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
        let owned = listener_owned_on(os, &processes, case["host"].as_str().unwrap(), 18771, WHISPER_PID, &cwd, &CancellationToken::new()).await;
        assert_eq!(owned, case["owned"], "{case}");
        let asked: Vec<Value> = manager.calls.lock().unwrap().iter().map(|c| json!({"file": c["file"], "args": c["args"]})).collect();
        let expected: Vec<Value> = case["calls"].as_array().unwrap().iter().map(|c| json!({"file": c["file"], "args": c["args"]})).collect();
        assert_eq!(asked, expected, "{case}");
    }
    for line in twin["pidLines"].as_array().unwrap() {
        assert_eq!(listener_pids_include(line["stdout"].as_str().unwrap(), WHISPER_PID), line["includes"], "{line}");
    }
}

#[test]
fn the_tree_kill_command_is_node_byte_for_byte() {
    use base64::Engine as _;
    let twin = fixture();
    for case in twin["treeKill"].as_array().unwrap() {
        let (command, args) = tree_kill_command(case["pid"].as_u64().unwrap() as u32, case["aliveAt"].as_i64().unwrap());
        assert_eq!(command, case["command"].as_str().unwrap());
        let at = args.iter().position(|a| a == "-EncodedCommand").unwrap();
        assert_eq!(json!(args[..=at]), case["flags"]);
        let units: Vec<u16> = base64::engine::general_purpose::STANDARD.decode(&args[at + 1]).unwrap().chunks(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), case["script"].as_str().unwrap());
    }
}
