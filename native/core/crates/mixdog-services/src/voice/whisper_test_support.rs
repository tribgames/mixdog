//! A scripted whisper-server for tests: a process manager whose children are an ffprobe/ffmpeg stand-in and a real loopback
//! HTTP server answering `/inference`, plus the listener-ownership query answers of each OS.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::{
    CommandSpec, ExitStatus, KillReason, OutputStream, ProcessError, ProcessEvent, ProcessExit, ProcessInfo, ProcessManager, PtySize, SpawnRequest,
    SpawnedProcess,
};
use mixdog_protocol::ProcessHandle;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Notify, mpsc};

use super::whisper_owner::Os;

pub(super) const WHISPER_PID: u32 = 2_147_480_001;

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
    pub(super) calls: Mutex<Vec<Value>>,
    pub(super) requests_shared: Arc<Mutex<Vec<Value>>>,
    next_pid: AtomicU32,
    pending: Mutex<HashMap<String, mpsc::UnboundedReceiver<ProcessEvent>>>,
    pub(super) servers: Mutex<HashMap<String, (mpsc::UnboundedSender<ProcessEvent>, tokio::task::JoinHandle<()>)>>,
    /// What the listener query answers: `None` fails it, `Some(pid)` names the listening pid.
    pub(super) listener_pid: Mutex<Option<u32>>,
    pub(super) listener_os: Mutex<Option<Os>>,
    pub(super) listener_port: AtomicU32,
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

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<(Vec<u8>, usize)> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head_end, length) = loop {
        let Ok(read) = stream.read(&mut chunk).await else { return None };
        if read == 0 {
            return None;
        }
        raw.extend_from_slice(&chunk[..read]);
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&raw[..at]).to_lowercase();
            let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
            break (at + 4, length);
        }
    };
    while raw.len() < head_end + length {
        let Ok(read) = stream.read(&mut chunk).await else { break };
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
    }
    Some((raw, head_end))
}

async fn serve(listener: tokio::net::TcpListener, requests: Arc<Mutex<Vec<Value>>>, hang: Arc<AtomicBool>, seen: Arc<Notify>) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { return };
        // The readiness probe connects and hangs up without a request.
        let Some((raw, head_end)) = read_request(&mut stream).await else { continue };
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
        let _ = stream
            .write_all(
                format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).as_bytes(),
            )
            .await;
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

    fn subscribe_holding(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        self.subscribe(handle, from_seq)
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
