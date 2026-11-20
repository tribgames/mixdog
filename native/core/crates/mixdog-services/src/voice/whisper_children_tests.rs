//! The children one transcription starts (ffmpeg, whisper-server, the listener-ownership query), what is posted to the
//! server, the listener query on every platform and the Windows tree-kill command.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::process::ProcessManager;
use mixdog_protocol::ProcessHandle;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::pipeline::VoicePipeline;
use super::pipeline::tests::Fixed;
use super::runtime::{RuntimeManifest, SERVER_NAME};
use super::whisper_owner::{Os, listener_owned_on, listener_pids_include, tree_kill_command};
use super::whisper_server::{ProcessAudioTools, WhisperServer};
use super::whisper_test_support::{Scripted, WHISPER_PID};
use crate::tidy::process::Processes;

fn ext() -> &'static str {
    if cfg!(windows) { ".exe" } else { "" }
}

fn install(root: &std::path::Path) -> RuntimeManifest {
    let put = |rel: &str, bytes: &[u8]| {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    };
    put("voice-runtime/active-version", b"whisper-1.7.0-vulkan");
    put(&format!("voice-runtime/whisper-1.7.0-vulkan/Release/whisper-cli{}", ext()), b"x");
    put(&format!("voice-runtime/whisper-1.7.0-vulkan/Release/{SERVER_NAME}"), b"x");
    put("voice/models/ggml-small.bin", b"model");
    put("ffmpeg-runtime/active-version", b"ffmpeg-6");
    put(&format!("ffmpeg-runtime/ffmpeg-6/ffmpeg{}", ext()), b"x");
    put("in/clip.ogg", b"ogg");
    RuntimeManifest {
        version: "1.7.0".into(),
        variants: vec![("vulkan".into(), format!("Release/whisper-cli{}", ext()))],
        model_key: "standard".into(),
        model_id: "standard".into(),
        model_filename: "ggml-small.bin".into(),
        model_size: 5,
        ffmpeg_executable: Some(format!("ffmpeg{}", ext())),
    }
}

fn pipeline(dir: &std::path::Path, voice: Value) -> (Arc<VoicePipeline>, Arc<WhisperServer>, Arc<Scripted>) {
    let manager = Scripted::new();
    let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
    let server = Arc::new(WhisperServer::new(0, None, &processes));
    let pipeline = Arc::new(VoicePipeline::new(
        dir.to_owned(),
        install(dir),
        Arc::new(Fixed(voice)),
        server.clone(),
        Arc::new(ProcessAudioTools(processes)),
        mixdog_rt::testing::tokens().durability_io,
    ));
    (pipeline, server, manager)
}

fn calls_of(manager: &Scripted, file: &str) -> Vec<Value> {
    manager.calls.lock().unwrap().iter().filter(|c| c["file"] == file).cloned().collect()
}

#[tokio::test]
async fn one_transcription_converts_the_audio_starts_the_server_and_posts_the_wav_with_the_language() {
    let dir = tempfile::tempdir().unwrap();
    let (pipeline, server, manager) =
        pipeline(dir.path(), json!({"enabled": true, "language": "ko", "transcription": {"threadCount": 3, "maxDurationSec": 600}}));
    let text = pipeline.transcribe(&dir.path().join("in").join("clip.ogg"), Some("att-1"), &CancellationToken::new()).await.unwrap();
    assert_eq!(text.as_deref(), Some("hello world"));

    let probe = &calls_of(&manager, "ffprobe")[0];
    assert!(probe["args"].as_array().unwrap().iter().any(|a| a == "format=duration"), "the duration gate probes the container");
    let ffmpeg = &calls_of(&manager, "ffmpeg")[0];
    let args: Vec<String> = ffmpeg["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
    let at = |flag: &str| args.iter().position(|a| a == flag).unwrap();
    assert!(args[at("-i") + 1].ends_with("clip.ogg"));
    assert_eq!((args[at("-ar") + 1].as_str(), args[at("-ac") + 1].as_str(), args[at("-threads") + 1].as_str()), ("16000", "1", "3"));
    assert!(args.last().unwrap().ends_with("clip.wav"));

    let started = &calls_of(&manager, "whisper-server")[0];
    let args: Vec<&str> = started["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    assert_eq!(args[0], "--model");
    assert!(args[1].ends_with("ggml-small.bin"));
    assert_eq!((&args[2..4], args[6], args[7]), (&["--host", "127.0.0.1"][..], "-t", "3"));

    let requests = manager.requests_shared.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        (requests[0]["method"].as_str(), requests[0]["url"].as_str(), requests[0]["multipart"].as_bool()),
        (Some("POST"), Some("/inference"), Some(true))
    );
    let fields: Vec<(&str, Option<&str>)> =
        requests[0]["fields"].as_array().unwrap().iter().map(|f| (f["name"].as_str().unwrap(), f["value"].as_str())).collect();
    assert_eq!(fields, vec![("file", None), ("response_format", Some("json")), ("language", Some("ko"))]);

    // The pid file records the child while it runs and goes with it when it dies on its own.
    let pid_path = dir.path().join("voice-runtime").join("whisper-server.pid.json");
    let recorded: Value = serde_json::from_str(&std::fs::read_to_string(&pid_path).unwrap()).unwrap();
    assert_eq!((recorded["pid"].as_u64(), recorded["host"].as_str()), (Some(u64::from(WHISPER_PID)), Some("127.0.0.1")));
    let handle = ProcessHandle(manager.servers.lock().unwrap().keys().next().unwrap().clone());
    manager.kill(&handle).unwrap();
    mixdog_rt::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!pid_path.exists(), "the exit watcher clears the pid file");
    server.stop().await;
}

#[tokio::test]
async fn a_second_transcription_of_the_same_attachment_starts_no_child() {
    let dir = tempfile::tempdir().unwrap();
    let (pipeline, server, manager) = pipeline(dir.path(), json!({"enabled": true, "language": "en"}));
    let audio = dir.path().join("in").join("clip.ogg");
    let first = pipeline.transcribe(&audio, Some("att-1"), &CancellationToken::new()).await.unwrap();
    let children = manager.calls.lock().unwrap().len();
    let second = pipeline.transcribe(&audio, Some("att-1"), &CancellationToken::new()).await.unwrap();
    assert_eq!((first, second), (Some("hello world".to_owned()), Some("hello world".to_owned())));
    assert_eq!(manager.calls.lock().unwrap().len(), children);
    assert_eq!(manager.requests_shared.lock().unwrap().len(), 1);
    server.stop().await;
}

#[tokio::test]
async fn a_file_over_the_size_gate_is_skipped_before_any_child_starts() {
    let dir = tempfile::tempdir().unwrap();
    let (pipeline, _server, manager) = pipeline(dir.path(), json!({"enabled": true, "transcription": {"maxFileSizeMB": 0.000001}}));
    let text = pipeline.transcribe(&dir.path().join("in").join("clip.ogg"), None, &CancellationToken::new()).await.unwrap();
    assert_eq!(text, None);
    assert!(manager.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_listener_query_asks_and_decides_on_every_platform() {
    let cwd = std::env::temp_dir();
    for (os, owner, query_works, expected) in [
        (Os::Windows, WHISPER_PID, true, true),
        (Os::Windows, 7, true, false),
        (Os::Windows, WHISPER_PID, false, false),
        (Os::Linux, WHISPER_PID, true, true),
        (Os::Linux, 7, true, false),
        (Os::Linux, WHISPER_PID, false, false),
        (Os::Other, WHISPER_PID, true, true),
        (Os::Other, 7, true, false),
        (Os::Other, WHISPER_PID, false, false),
    ] {
        let manager = Scripted::new();
        manager.listener_port.store(18771, Ordering::SeqCst);
        *manager.listener_os.lock().unwrap() = Some(os);
        *manager.listener_pid.lock().unwrap() = query_works.then_some(owner);
        let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
        let owned = listener_owned_on(os, &processes, "127.0.0.1", 18771, WHISPER_PID, &cwd, &CancellationToken::new()).await;
        assert_eq!(owned, expected, "{os:?} owner {owner} query {query_works}");
        let asked = manager.calls.lock().unwrap().clone();
        assert_eq!(asked.len(), 1, "one query");
        let program = asked[0]["file"].as_str().unwrap().to_lowercase();
        let args = asked[0]["args"].to_string();
        match os {
            Os::Windows => assert!(program.ends_with("powershell.exe") && args.contains("Get-NetTCPConnection") && args.contains("-LocalPort {PORT}")),
            Os::Linux => assert!(program == "ss" && args.contains("sport = :{PORT}")),
            Os::Other => assert!(program == "lsof" && args.contains("-iTCP@127.0.0.1:{PORT}") && args.contains("-sTCP:LISTEN")),
        }
    }
    let manager = Scripted::new();
    let processes = Processes::new(manager.clone(), mixdog_rt::testing::tokens().durability_io);
    assert!(!listener_owned_on(Os::Linux, &processes, "127.0.0.1", 18771, 0, &cwd, &CancellationToken::new()).await, "no pid, no query");
    assert!(manager.calls.lock().unwrap().is_empty());
    assert!(
        !listener_owned_on(Os::Windows, &processes, "1.2.3.4'; x", 18771, 5, &cwd, &CancellationToken::new()).await,
        "a host that is not an address is never put in a command"
    );
    assert!(manager.calls.lock().unwrap().is_empty());
}

#[test]
fn listener_pid_lines_match_whole_trimmed_lines_only() {
    assert!(listener_pids_include("12\r\n 345 \r\n", 345));
    assert!(!listener_pids_include("12\r\n3456\r\n", 345));
    assert!(!listener_pids_include("", 345));
}

#[test]
fn the_windows_tree_kill_is_an_encoded_command_naming_the_pid_and_the_alive_instant() {
    use base64::Engine as _;
    let (command, args) = tree_kill_command(4242, 1_700_000_000_000);
    assert!(command.to_lowercase().ends_with("powershell.exe"));
    assert_eq!(args[..3], ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    let units: Vec<u16> = base64::engine::general_purpose::STANDARD.decode(&args[3]).unwrap().chunks(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
    let script = String::from_utf16(&units).unwrap();
    assert!(script.contains("-Pids @(4242)") && script.contains("-AliveAt "), "{script}");
}
