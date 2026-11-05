//! The one managed whisper-server child.
//!
//! At most one child exists, identified by an exact [`ServerContract`]. `ensure_ready` resolves
//! only when a child matching the current contract is bound to its port (the socket binds after
//! the model has loaded). A contract change, a dead child or a failed request is repaired by
//! tearing the child down and recreating the same contract; there is no fallback to another
//! binary or model. An idle child is released after [`IDLE_TIMEOUT`] so one transcription does
//! not pin the model for the life of the daemon.

use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use tokio::net::TcpStream;
use tokio::sync::Mutex;

use super::pipeline::{AudioTools, ServerContract, VoiceError, WhisperEngine};
use crate::local_provider::server_process::{Launcher, LogSink, RunningProcess, SystemLauncher};
use crate::tidy::process::{Processes, RunOptions};

const PREFERRED_PORT: u16 = 8771;
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const READY_POLL: Duration = Duration::from_millis(250);
const PROBE_CONNECT: Duration = Duration::from_secs(1);
const STOP_GRACE: Duration = Duration::from_secs(5);
const LOG_TAIL_BYTES: usize = 4000;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

struct Running {
    process: Arc<dyn RunningProcess>,
    contract: ServerContract,
    port: u16,
    log: Arc<StdMutex<String>>,
}

impl Running {
    /// Whether the child has exited, without waiting.
    fn exited(&self) -> bool {
        self.process.wait().now_or_never().is_some()
    }
}

#[derive(Default)]
struct Shared {
    running: Mutex<Option<Running>>,
    /// Bumped by every use; an idle timer acts only if it still holds the latest value.
    generation: AtomicU64,
    inflight: AtomicUsize,
}

#[derive(Clone)]
pub struct WhisperServer {
    shared: Arc<Shared>,
    preferred_port: u16,
    idle_timeout: Option<Duration>,
    http: reqwest::Client,
    launcher: Arc<SystemLauncher>,
}

impl WhisperServer {
    /// The default port and idle release; the child runs under the shared process manager.
    pub fn with_defaults(processes: &Processes) -> Self {
        Self::new(PREFERRED_PORT, Some(IDLE_TIMEOUT), processes)
    }

    /// `idle_timeout: None` never releases an idle child.
    pub fn new(preferred_port: u16, idle_timeout: Option<Duration>, processes: &Processes) -> Self {
        Self {
            shared: Arc::default(),
            preferred_port,
            idle_timeout,
            http: reqwest::Client::new(),
            launcher: Arc::new(SystemLauncher::new(processes)),
        }
    }

    pub async fn stop(&self) {
        let mut slot = self.shared.running.lock().await;
        teardown(&mut slot).await;
    }

    fn arm_idle_release(&self) {
        let Some(after) = self.idle_timeout else { return };
        let armed = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let shared = Arc::downgrade(&self.shared);
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            let Some(shared) = shared.upgrade() else { return };
            let mut slot = shared.running.lock().await;
            if shared.generation.load(Ordering::SeqCst) == armed && shared.inflight.load(Ordering::SeqCst) == 0 {
                teardown(&mut slot).await;
            }
        });
    }

    async fn start(&self, contract: &ServerContract) -> Result<Running, VoiceError> {
        let port = select_port(&contract.host, self.preferred_port)?;
        let args = [
            "--model".to_owned(),
            contract.model_path.to_string_lossy().into_owned(),
            "--host".to_owned(),
            contract.host.clone(),
            "--port".to_owned(),
            port.to_string(),
            "-t".to_owned(),
            contract.thread_count.to_string(),
        ];
        let cwd = contract.server_cmd.parent().unwrap_or(Path::new(".")).to_string_lossy().into_owned();
        let log = Arc::new(StdMutex::new(String::new()));
        let sink: LogSink = {
            let log = log.clone();
            Arc::new(move |text: &str| append_tail(&mut log.lock().unwrap(), text))
        };
        let process = self
            .launcher
            .launch(&contract.server_cmd.to_string_lossy(), &args, &cwd, &[], sink)
            .await
            .map_err(|e| VoiceError(format!("whisper-server failed to start: {e}")))?;
        let running = Running { process, contract: contract.clone(), port, log };
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        let addr = format!("{}:{port}", contract.host);
        while tokio::time::Instant::now() < deadline {
            if running.exited() {
                let tail = running.log.lock().unwrap().clone();
                return Err(VoiceError(format!("whisper-server died during startup:\n{tail}")));
            }
            if let Ok(Ok(_)) = tokio::time::timeout(PROBE_CONNECT, TcpStream::connect(&addr)).await {
                return Ok(running);
            }
            tokio::time::sleep(READY_POLL).await;
        }
        teardown_running(running).await;
        Err(VoiceError(format!("whisper-server did not become ready within {}ms", READY_TIMEOUT.as_millis())))
    }
}

#[async_trait]
impl WhisperEngine for WhisperServer {
    async fn ensure_ready(&self, contract: &ServerContract) -> Result<(), VoiceError> {
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut slot = self.shared.running.lock().await;
            let alive = match slot.as_mut() {
                Some(r) => r.contract == *contract && !r.exited(),
                None => false,
            };
            if !alive {
                teardown(&mut slot).await;
                *slot = Some(self.start(contract).await?);
            }
        }
        self.arm_idle_release();
        Ok(())
    }

    async fn transcribe(&self, wav: &Path, language: Option<&str>) -> Result<String, VoiceError> {
        let (host, port) = {
            let slot = self.shared.running.lock().await;
            let running = slot
                .as_ref()
                .ok_or_else(|| VoiceError("transcribe: whisper-server not READY (state=STOPPED)".into()))?;
            (running.contract.host.clone(), running.port)
        };
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        self.shared.inflight.fetch_add(1, Ordering::SeqCst);
        let result = self.post_inference(&host, port, wav, language).await;
        self.shared.inflight.fetch_sub(1, Ordering::SeqCst);
        if result.is_err() {
            // The contract is no longer satisfiable on this child; the next ensure_ready
            // recreates it.
            let mut slot = self.shared.running.lock().await;
            teardown(&mut slot).await;
        }
        self.arm_idle_release();
        result
    }
}

impl WhisperServer {
    async fn post_inference(&self, host: &str, port: u16, wav: &Path, language: Option<&str>) -> Result<String, VoiceError> {
        let data = tokio::fs::read(wav).await.map_err(|e| VoiceError(e.to_string()))?;
        let name = wav.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let boundary = format!("----mixdog{}", uuid::Uuid::new_v4().simple());
        let body = multipart_body(&boundary, &name, &data, language);
        let response = self
            .http
            .post(format!("http://{host}:{port}/inference"))
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .body(body)
            .send()
            .await
            .map_err(|e| VoiceError(e.to_string()))?;
        let status = response.status();
        let text = response.text().await.map_err(|e| VoiceError(e.to_string()))?;
        parse_inference(status.as_u16(), &text)
    }
}

/// `file`, `response_format=json` and the optional `language` form fields.
pub(crate) fn multipart_body(boundary: &str, filename: &str, wav: &[u8], language: Option<&str>) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len() + 512);
    let mut field = |name: &str, value: &str| {
        body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").bytes());
    };
    field("response_format", "json");
    if let Some(language) = language {
        field("language", language);
    }
    body.extend(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .bytes(),
    );
    body.extend_from_slice(wav);
    body.extend(format!("\r\n--{boundary}--\r\n").bytes());
    body
}

pub(crate) fn parse_inference(status: u16, body: &str) -> Result<String, VoiceError> {
    if !(200..300).contains(&status) {
        let head = mixdog_js::slice_utf16(body, 500);
        return Err(VoiceError(format!("whisper-server /inference HTTP {status}: {head}")));
    }
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|e| VoiceError(format!("whisper-server /inference returned invalid JSON: {e}")))?;
    match json.get("text").and_then(|t| t.as_str()) {
        Some(text) => Ok(text.to_owned()),
        None => {
            let head = mixdog_js::slice_utf16(&json.to_string(), 300);
            Err(VoiceError(format!("whisper-server /inference returned no text field: {head}")))
        }
    }
}

/// The preferred port when free, else an OS-assigned one. A foreign listener is never reused.
fn select_port(host: &str, preferred: u16) -> Result<u16, VoiceError> {
    let reserve = |port: u16| -> std::io::Result<u16> {
        let listener = TcpListener::bind(SocketAddr::new(host.parse().map_err(std::io::Error::other)?, port))?;
        Ok(listener.local_addr()?.port())
    };
    reserve(preferred)
        .or_else(|_| reserve(0))
        .map_err(|e| VoiceError(format!("no loopback port for whisper-server: {e}")))
}

fn append_tail(log: &mut String, text: &str) {
    log.push_str(text);
    if log.len() > LOG_TAIL_BYTES {
        let mut cut = log.len() - LOG_TAIL_BYTES;
        while !log.is_char_boundary(cut) {
            cut += 1;
        }
        log.drain(..cut);
    }
}

async fn teardown(slot: &mut Option<Running>) {
    if let Some(running) = slot.take() {
        teardown_running(running).await;
    }
}

async fn teardown_running(running: Running) {
    running.process.kill();
    let _ = tokio::time::timeout(STOP_GRACE, running.process.wait()).await;
}

/// ffmpeg and ffprobe as children of the shared process manager.
pub struct ProcessAudioTools(pub Processes);

#[async_trait]
impl AudioTools for ProcessAudioTools {
    async fn convert_to_wav(
        &self,
        ffmpeg: &Path,
        audio: &Path,
        wav: &Path,
        sample_rate: u32,
        channels: u32,
        threads: usize,
    ) -> Result<(), VoiceError> {
        let args: Vec<String> = [
            "-i",
            &audio.to_string_lossy(),
            "-ar",
            &sample_rate.to_string(),
            "-ac",
            &channels.to_string(),
            "-threads",
            &threads.to_string(),
            "-y",
            &wav.to_string_lossy(),
        ]
        .map(str::to_owned)
        .to_vec();
        let mut options = RunOptions::new(wav.parent().unwrap_or(Path::new(".")));
        options.timeout = Duration::ZERO;
        let result = self.0.run(&ffmpeg.to_string_lossy(), &args, options).await;
        if result.code == 0 {
            Ok(())
        } else if !result.error.is_empty() {
            Err(VoiceError(format!("{} {}", ffmpeg.display(), result.error)))
        } else {
            Err(VoiceError(format!("{} exit {}", ffmpeg.display(), if result.code < 0 { "signal".into() } else { result.code.to_string() })))
        }
    }

    async fn probe_duration_sec(&self, audio: &Path) -> Option<f64> {
        let args: Vec<String> = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", &audio.to_string_lossy()].map(str::to_owned).to_vec();
        let mut options = RunOptions::new(audio.parent().unwrap_or(Path::new(".")));
        options.timeout = Duration::ZERO;
        let output = self.0.run("ffprobe", &args, options).await;
        if output.code != 0 {
            return None;
        }
        Some(mixdog_js::string_to_number(&output.stdout)).filter(|d| d.is_finite() && *d != 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_carries_format_language_and_file() {
        let body = multipart_body("B", "a.wav", b"RIFF", Some("ko"));
        let text = String::from_utf8(body).unwrap();
        assert!(text.contains("name=\"response_format\"\r\n\r\njson\r\n"));
        assert!(text.contains("name=\"language\"\r\n\r\nko\r\n"));
        assert!(text.contains("name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n--B--\r\n"));
        assert!(!String::from_utf8(multipart_body("B", "a.wav", b"", None)).unwrap().contains("language"));
    }

    #[test]
    fn inference_response_needs_a_text_field() {
        assert_eq!(parse_inference(200, r#"{"text":" hi"}"#).unwrap(), " hi");
        assert!(parse_inference(500, "boom").unwrap_err().0.contains("HTTP 500: boom"));
        assert!(parse_inference(200, "{}").unwrap_err().0.contains("no text field"));
    }

    #[test]
    fn port_selection_skips_a_busy_preferred_port() {
        let held = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = held.local_addr().unwrap().port();
        let chosen = select_port("127.0.0.1", busy).unwrap();
        assert_ne!(chosen, busy);
    }
}
