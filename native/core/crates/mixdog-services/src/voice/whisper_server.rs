//! The one managed whisper-server child.
//!
//! At most one child exists, identified by an exact [`ServerContract`]. `ensure_ready` resolves
//! only when a child matching the current contract is bound to its port (the socket binds after
//! the model has loaded). A contract change, a dead child or a failed request is repaired by
//! tearing the child down and recreating the same contract; there is no fallback to another
//! binary or model. An idle child is released after [`IDLE_TIMEOUT`] so one transcription does
//! not pin the model for the life of the daemon.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use tokio::net::TcpStream;
use tokio::sync::Mutex;

use mixdog_rt::DurabilityIo;
use mixdog_js::JsRegex;
use tokio_util::sync::CancellationToken;

use super::pipeline::{AudioTools, ServerContract, VoiceError, WhisperEngine};
use super::whisper_owner::{PidMeta, clear_pid_file, listener_owned, pid_file, port_from_env, read_pid_file, reclaim_stale, select_port, write_pid_file};
use crate::lane::io_on_lane;
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
    lane: DurabilityIo,
    /// Where the pid file of this child lives.
    pid_file: PathBuf,
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
    processes: Processes,
}

impl WhisperServer {
    /// The default port and idle release, `MIXDOG_WHISPER_SERVER_PORT` and
    /// `MIXDOG_WHISPER_IDLE_TIMEOUT_MS` (0 disables the release) overriding them; the child runs
    /// under the shared process manager.
    pub fn with_defaults(processes: &Processes) -> Self {
        let port = std::env::var("MIXDOG_WHISPER_SERVER_PORT").ok().and_then(|raw| port_from_env(&raw)).unwrap_or(PREFERRED_PORT);
        let idle = match std::env::var("MIXDOG_WHISPER_IDLE_TIMEOUT_MS").map(|raw| mixdog_js::string_to_number(&raw)) {
            Ok(ms) if ms.is_finite() && ms >= 0.0 => Some(Duration::from_millis(ms as u64)).filter(|d| !d.is_zero()),
            _ => Some(IDLE_TIMEOUT),
        };
        Self::new(port, idle, processes)
    }

    /// `idle_timeout: None` never releases an idle child.
    pub fn new(preferred_port: u16, idle_timeout: Option<Duration>, processes: &Processes) -> Self {
        Self {
            shared: Arc::default(),
            preferred_port,
            idle_timeout,
            http: reqwest::Client::new(),
            launcher: Arc::new(SystemLauncher::new(processes)),
            processes: processes.clone(),
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
        let lane = self.processes.durability();
        let pid_path = pid_file(&contract.server_cmd);
        let cwd = contract.server_cmd.parent().unwrap_or(Path::new(".")).to_owned();
        // Reclaim only a child the pid file proves is ours; a foreign listener is never touched.
        if let Some(meta) = read_pid_file(lane, pid_path.clone()).await {
            reclaim_stale(&self.processes, &meta, &contract.model_path.to_string_lossy(), self.preferred_port, &cwd).await;
            clear_pid_file(lane, pid_path.clone()).await;
        }
        let port = select_port(&contract.host, self.preferred_port).map_err(VoiceError)?;
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
        let log = Arc::new(StdMutex::new(String::new()));
        let sink: LogSink = {
            let log = log.clone();
            Arc::new(move |text: &str| append_tail(&mut log.lock().unwrap(), text))
        };
        let process = self
            .launcher
            .launch(&contract.server_cmd.to_string_lossy(), &args, &cwd.to_string_lossy(), &[], sink)
            .await
            .map_err(|e| VoiceError(format!("whisper-server failed to start: {e}")))?;
        let pid = process.pid();
        let running = Running { process, contract: contract.clone(), port, log, lane, pid_file: pid_path.clone() };
        if let Some(pid) = pid {
            let meta = PidMeta { pid, server_cmd: &contract.server_cmd, model_path: &contract.model_path, thread_count: contract.thread_count, host: &contract.host, port, started_at_ms: crate::media::store::now_ms() };
            write_pid_file(lane, pid_path, &meta).await;
        }
        // The ownership queries end with the readiness budget.
        let readiness = CancellationToken::new();
        let _end = readiness.clone().drop_guard();
        tokio::spawn({
            let readiness = readiness.clone();
            async move {
                tokio::select! {
                    () = tokio::time::sleep(READY_TIMEOUT) => readiness.cancel(),
                    () = readiness.cancelled() => {}
                }
            }
        });
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        let addr = format!("{}:{port}", contract.host);
        while tokio::time::Instant::now() < deadline {
            if running.exited() {
                let tail = utf16_tail(&running.log.lock().unwrap(), 1000);
                teardown_running(running).await;
                return Err(VoiceError(format!("whisper-server died during startup:\n{tail}")));
            }
            // The printed bound port must be the one selected.
            let printed = printed_port(&running.log.lock().unwrap());
            if let Some(printed) = printed.filter(|p| *p != u64::from(port)) {
                teardown_running(running).await;
                return Err(VoiceError(format!("whisper-server bound port {printed} but contract requires {port}")));
            }
            let bound = matches!(tokio::time::timeout(PROBE_CONNECT, TcpStream::connect(&addr)).await, Ok(Ok(_)));
            if bound && pid.is_some_and(|pid| pid > 0) && listener_owned(&self.processes, &contract.host, port, pid.unwrap_or(0), &cwd, &readiness).await && !running.exited() {
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
        let path = wav.to_owned();
        let data = io_on_lane(self.processes.durability(), move || read_wav(&path)).await.map_err(|e| VoiceError(e.to_string()))?;
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

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_wav(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
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

/// The port of the first `listening at http://host:port` line the server printed.
fn printed_port(log: &str) -> Option<u64> {
    static LINE: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    let line = LINE.get_or_init(|| JsRegex::new_static("listening at https?:\\/\\/[^\\s:/]+:(\\d+)", "i"));
    line.captures(log).and_then(|c| c.get(1)).and_then(|digits| digits.parse().ok())
}

/// `text.slice(-limit)` by UTF-16 units.
fn utf16_tail(text: &str, limit: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&units[units.len().saturating_sub(limit)..])
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
    clear_pid_file(running.lane, running.pid_file.clone()).await;
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
    fn the_printed_port_and_log_tail_read_like_node() {
        assert_eq!(printed_port("x\nwhisper server Listening AT http://127.0.0.1:8771\n"), Some(8771));
        assert_eq!(printed_port("no line"), None);
        assert_eq!(utf16_tail("abcdef", 3), "def");
        assert_eq!(utf16_tail("ab", 9), "ab");
    }
}
