//! The scripted relay the twin tests drive (`relay_twin_host`): the contract of `tests/twin/node/relay-host.mjs`. It takes one JSON
//! argument, the knobs of `startRelay` with the names and units of that file's header plus the host keys `fakes`, `mobileRelease`,
//! `treeRoot` and `installBase`; an unknown knob is an error. Mail, native push and Web Push are replaced by fakes that write every
//! call as `[twin] <json>` on stdout and answer what the scenario scripted: the n-th call takes the n-th answer, the last answer
//! repeats, an empty list means success, and `delayMs` is how long the fake waits before it answers.
//!
//! stdout then carries `[relay] <http|https> listening on :<port> (renderer: <dir>|none)` and the relay's own lines; the host closes the
//! relay and exits 0 when its stdin ends. A start failure is `[relay] failed to start: <message>` on stderr and exit 1.

use std::collections::BTreeMap;
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine;
use mixdog_fsio::Unlaned;
use mixdog_rt::exec::RtConfig;
use mixdog_rt::{Backend, LaneTokens, TaskClass};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::{Options, Seams, start};
use crate::config::Config;
use crate::feedback::{FeedbackMail, FeedbackSender, SendFailure};
use crate::logline;
use crate::native_push::{BoxFuture, Platform, PushMessage, PushSender, SendResult};
use crate::web_push::send::{PushClient, PushFuture, PushRequest};

/// The knobs that are options of `startRelay`.
const RELAY_OPTIONS: &[&str] = &[
    "port",
    "dataDir",
    "rendererDir",
    "rendererReleasesDir",
    "tlsCert",
    "tlsKey",
    "maxFrameBytes",
    "maxHookPending",
    "maxInflightBytes",
    "maxIngressBytes",
    "ingressReservationBytes",
    "ingressWindowBytes",
    "maxPayloadBytes",
    "uplinkCapacityBytes",
    "handshakeStallMs",
    "livenessProbeMs",
    "feedbackEnv",
    "feedbackOptions",
    "nativePushEnv",
    "turnEnv",
];

/// The knobs that belong to the host. `treeRoot` names the tree the Node host copies its relay from: the Rust relay is the program
/// that is running, so it has nothing to copy and the key only has to be accepted.
const HOST_OPTIONS: &[&str] = &["fakes", "mobileRelease", "treeRoot", "installBase"];

/// Writes one `[twin] <json>` line.
fn record(value: &Value) {
    let _ = writeln!(std::io::stdout().lock(), "[twin] {value}");
}

/// `answerSequence`: the scripted answers of one fake.
struct Answers {
    list: Vec<Value>,
    next: AtomicUsize,
}

impl Answers {
    fn new(spec: &Value) -> Self {
        let list = spec.get("answers").and_then(Value::as_array).cloned().unwrap_or_default();
        Self { list, next: AtomicUsize::new(0) }
    }

    /// The next answer, after its `delayMs`. A `null` answer is `{}`.
    async fn next(&self) -> Value {
        let at = self.next.fetch_add(1, Ordering::SeqCst);
        let answer = match self.list.get(at.min(self.list.len().saturating_sub(1))) {
            Some(Value::Null) | None => json!({}),
            Some(answer) => answer.clone(),
        };
        let delay = answer.get("delayMs").and_then(Value::as_f64).unwrap_or(0.0);
        if delay > 0.0 {
            mixdog_rt::time::sleep(Duration::from_millis(delay as u64)).await;
        }
        answer
    }
}

/// The text of a rejected answer: `String(answer.throw)`.
fn thrown(answer: &Value) -> Option<String> {
    answer.get("throw").map(|thrown| match thrown {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `createFeedbackSender`.
struct FakeFeedbackSender {
    answers: Answers,
}

fn recorded_mail(mail: &FeedbackMail) -> Value {
    let mut recorded = Map::new();
    recorded.insert("from".to_owned(), json!(mail.from));
    recorded.insert("to".to_owned(), json!(mail.to));
    if let Some(reply_to) = &mail.reply_to {
        recorded.insert("replyTo".to_owned(), json!(reply_to));
    }
    recorded.insert("subject".to_owned(), json!(mail.subject));
    recorded.insert("text".to_owned(), json!(mail.text));
    recorded.insert("messageId".to_owned(), json!(mail.message_id));
    if !mail.attachments.is_empty() {
        let attachments: Vec<Value> = mail
            .attachments
            .iter()
            .map(|attachment| {
                json!({
                    "filename": attachment.filename,
                    "contentType": attachment.content_type,
                    "contentDisposition": "attachment",
                    "bytes": attachment.content.len(),
                    "sha256": sha256_hex(&attachment.content),
                })
            })
            .collect();
        recorded.insert("attachments".to_owned(), Value::Array(attachments));
    }
    json!({ "fake": "feedbackSender", "call": "send", "mail": recorded })
}

impl FeedbackSender for FakeFeedbackSender {
    fn send<'a>(&'a self, mail: FeedbackMail) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>> {
        Box::pin(async move {
            record(&recorded_mail(&mail));
            let answer = self.answers.next().await;
            if thrown(&answer).is_none() {
                return Ok(());
            }
            // `error.code`, which the queue logs as `code=<code>` (`error` when it has none).
            let code = match answer.get("code") {
                Some(Value::String(code)) if !code.is_empty() => Some(code.clone()),
                Some(Value::Number(code)) => Some(code.to_string()),
                _ => None,
            };
            Err(SendFailure { code })
        })
    }

    fn close(&self) {
        record(&json!({ "fake": "feedbackSender", "call": "close" }));
    }
}

/// `createNativePushFake`.
struct FakeNativePush {
    platforms: Vec<&'static str>,
    answers: Answers,
}

fn recorded_push(message: &PushMessage) -> Value {
    let mut recorded = Map::new();
    recorded.insert("platform".to_owned(), json!(message.platform.as_str()));
    recorded.insert("token".to_owned(), json!(message.token));
    recorded.insert("mx".to_owned(), json!(message.mx));
    recorded.insert("reason".to_owned(), json!(message.reason));
    recorded.insert("collapseKey".to_owned(), json!(message.collapse_key));
    if let Some(sandbox) = message.sandbox {
        recorded.insert("sandbox".to_owned(), json!(sandbox));
    }
    json!({ "fake": "nativePush", "call": "send", "message": recorded })
}

impl PushSender for FakeNativePush {
    fn platforms(&self) -> Vec<&'static str> {
        self.platforms.clone()
    }

    fn send<'a>(&'a self, message: &'a PushMessage) -> BoxFuture<'a, SendResult> {
        Box::pin(async move {
            record(&recorded_push(message));
            let answer = self.answers.next().await;
            // An empty answer is the default success.
            if answer.as_object().is_none_or(Map::is_empty) {
                return SendResult { ok: true, status: 200, invalid: false, error: None };
            }
            SendResult {
                ok: answer.get("ok").and_then(Value::as_bool).unwrap_or(false),
                status: answer.get("status").and_then(Value::as_u64).and_then(|status| u16::try_from(status).ok()).unwrap_or(0),
                invalid: answer.get("invalid").and_then(Value::as_bool).unwrap_or(false),
                error: answer.get("error").and_then(Value::as_str).map(str::to_owned),
            }
        })
    }

    fn close(&self) {
        record(&json!({ "fake": "nativePush", "call": "close" }));
    }
}

/// `createWebPushFetch`: a status (201 by default) or `{"throw": "message"}` for a network error.
struct FakeWebPush {
    answers: Answers,
}

impl PushClient for FakeWebPush {
    fn post(&self, request: PushRequest) -> PushFuture<'_> {
        Box::pin(async move {
            let headers: Map<String, Value> = request.headers.iter().map(|(name, value)| ((*name).to_owned(), json!(value))).collect();
            record(&json!({
                "fake": "webPushFetch",
                "call": "fetch",
                "url": request.endpoint,
                "method": "POST",
                "headers": headers,
                "redirect": "error",
                "bodyBytes": request.body.len(),
                "bodyBase64": base64::engine::general_purpose::STANDARD.encode(&request.body),
            }));
            let answer = self.answers.next().await;
            if let Some(message) = thrown(&answer) {
                return Err(message);
            }
            Ok(answer.get("status").and_then(Value::as_u64).and_then(|status| u16::try_from(status).ok()).unwrap_or(201))
        })
    }
}

/// What one invocation asks for, read from its knob object.
struct Spec {
    config: Config,
    options: Options,
    seams: Seams,
    mobile_release: Option<Value>,
    install_base: Option<PathBuf>,
}

fn text(knobs: &Map<String, Value>, name: &str) -> Result<String, String> {
    match knobs.get(name) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(format!("knob {name} must be a string")),
    }
}

fn number(knobs: &Map<String, Value>, name: &str) -> Result<Option<f64>, String> {
    match knobs.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_f64().map(Some).ok_or_else(|| format!("knob {name} must be a number")),
    }
}

fn count(knobs: &Map<String, Value>, name: &str, into: &mut usize) -> Result<(), String> {
    if let Some(value) = number(knobs, name)? {
        *into = value as usize;
    }
    Ok(())
}

fn millis(knobs: &Map<String, Value>, name: &str, into: &mut Duration) -> Result<(), String> {
    if let Some(value) = number(knobs, name)? {
        *into = Duration::from_millis(value as u64);
    }
    Ok(())
}

fn environment(knobs: &Map<String, Value>, name: &str) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = knobs.get(name) else { return Ok(BTreeMap::new()) };
    let object = value.as_object().ok_or_else(|| format!("knob {name} must be an object"))?;
    Ok(object.iter().map(|(key, value)| (key.clone(), value.as_str().map_or_else(|| value.to_string(), str::to_owned))).collect())
}

/// The numbers of `feedbackOptions`. `smtpTimeoutMs` belongs to the mail transport and is read by it, not here.
fn feedback_options(options: &mut Options, spec: &Value) -> Result<(), String> {
    let Some(spec) = spec.as_object() else { return Err("knob feedbackOptions must be an object".to_owned()) };
    let feedback = &mut options.feedback;
    count(spec, "maxPending", &mut feedback.max_pending)?;
    count(spec, "maxRecords", &mut feedback.max_records)?;
    count(spec, "ipLimit", &mut feedback.ip_limit)?;
    count(spec, "globalLimit", &mut feedback.global_limit)?;
    count(spec, "maxPendingAttachmentBytes", &mut feedback.max_pending_attachment_bytes)?;
    if let Some(value) = number(spec, "baseDelayMs")? {
        feedback.base_delay_ms = value;
    }
    if let Some(value) = number(spec, "maxDelayMs")? {
        feedback.max_delay_ms = value;
    }
    if let Some(value) = number(spec, "ipWindowMs")? {
        feedback.ip_window_ms = value as i64;
    }
    if let Some(value) = number(spec, "globalWindowMs")? {
        feedback.global_window_ms = value as i64;
    }
    Ok(())
}

fn fakes(spec: &Value, seams: &mut Seams) {
    if let Some(fake) = spec.get("feedbackSender").filter(|fake| !fake.is_null()) {
        seams.feedback_sender = Some(Arc::new(FakeFeedbackSender { answers: Answers::new(fake) }));
    }
    if let Some(fake) = spec.get("nativePush").filter(|fake| !fake.is_null()) {
        let platforms = fake.get("platforms").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
        let platforms = platforms.filter_map(Platform::parse).map(Platform::as_str).collect();
        seams.native_push = Some(Arc::new(FakeNativePush { platforms, answers: Answers::new(fake) }));
    }
    if let Some(fake) = spec.get("webPushFetch").filter(|fake| !fake.is_null()) {
        seams.web_push_client = Some(Arc::new(FakeWebPush { answers: Answers::new(fake) }));
    }
}

impl Spec {
    fn parse(knobs: &Value) -> Result<Self, String> {
        let knobs = knobs.as_object().ok_or("the knobs are one JSON object")?;
        if let Some(unknown) = knobs.keys().find(|key| !RELAY_OPTIONS.contains(&key.as_str()) && !HOST_OPTIONS.contains(&key.as_str())) {
            return Err(format!("unknown knob: {unknown}"));
        }
        let data_dir = text(knobs, "dataDir")?;
        if data_dir.is_empty() {
            return Err("knob dataDir is required".to_owned());
        }
        let config = Config {
            port: number(knobs, "port")?.unwrap_or(0.0),
            data_dir,
            renderer_dir: text(knobs, "rendererDir")?,
            renderer_releases_dir: text(knobs, "rendererReleasesDir")?,
            tls_cert: text(knobs, "tlsCert")?,
            tls_key: text(knobs, "tlsKey")?,
            env: BTreeMap::new(),
            install_dir: PathBuf::new(),
        };
        let mut options = Options::for_environment(&BTreeMap::new());
        options.feedback_env = environment(knobs, "feedbackEnv")?;
        options.native_push_env = environment(knobs, "nativePushEnv")?;
        options.turn_env = environment(knobs, "turnEnv")?;
        count(knobs, "maxFrameBytes", &mut options.max_frame_bytes)?;
        count(knobs, "maxHookPending", &mut options.max_hook_pending)?;
        count(knobs, "maxInflightBytes", &mut options.max_inflight_bytes)?;
        count(knobs, "maxIngressBytes", &mut options.max_ingress_bytes)?;
        count(knobs, "ingressReservationBytes", &mut options.ingress_reservation_bytes)?;
        count(knobs, "ingressWindowBytes", &mut options.ingress_window_bytes)?;
        count(knobs, "maxPayloadBytes", &mut options.max_payload_bytes)?;
        count(knobs, "uplinkCapacityBytes", &mut options.uplink_capacity_bytes)?;
        millis(knobs, "handshakeStallMs", &mut options.handshake.stall)?;
        millis(knobs, "livenessProbeMs", &mut options.handshake.probe)?;
        if let Some(spec) = knobs.get("feedbackOptions") {
            feedback_options(&mut options, spec)?;
        }
        let mut seams = Seams::default();
        if let Some(spec) = knobs.get("fakes") {
            fakes(spec, &mut seams);
        }
        let install_base = Some(text(knobs, "installBase")?).filter(|base| !base.is_empty()).map(PathBuf::from);
        Ok(Self { config, options, seams, mobile_release: knobs.get("mobileRelease").cloned(), install_base })
    }
}

/// `installRelay`: a fresh install directory, with `mobile-release.json` when the scenario gave one (an object is written as JSON, a
/// string verbatim). The relay reads its Android link from there.
fn install(spec: &Spec) -> Result<PathBuf, String> {
    let base = spec.install_base.clone().unwrap_or_else(std::env::temp_dir);
    let root = base.join(format!("relay-twin-{}", uuid::Uuid::new_v4()));
    mixdog_fsio::create_dir_all(&Unlaned, &root).map_err(|error| format!("{}: {error}", root.display()))?;
    let release = match &spec.mobile_release {
        None => return Ok(root),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    };
    let file = root.join("mobile-release.json");
    mixdog_fsio::write(&Unlaned, &file, release).map_err(|error| format!("{}: {error}", file.display()))?;
    Ok(root)
}

fn remove_install(root: &Path) {
    drop(mixdog_fsio::remove_dir_all(&Unlaned, root));
}

/// Blocks a thread on stdin until it ends, then says so.
fn watch_stdin(ended: oneshot::Sender<()>) {
    let mut sink = [0u8; 1024];
    let mut stdin = std::io::stdin().lock();
    while matches!(stdin.read(&mut sink), Ok(read) if read > 0) {}
    let _ = ended.send(());
}

async fn host(knobs: Value, tokens: LaneTokens) -> ExitCode {
    let mut spec = match Spec::parse(&knobs) {
        Ok(spec) => spec,
        Err(message) => {
            eprintln!("[relay-host] {message}");
            return ExitCode::from(1);
        }
    };
    let root = match install(&spec) {
        Ok(root) => root,
        Err(message) => {
            eprintln!("[relay-host] {message}");
            return ExitCode::from(1);
        }
    };
    spec.config.install_dir.clone_from(&root);
    let started = match mixdog_fsio::create_dir_all(&Unlaned, &spec.config.data_dir) {
        Ok(()) => start(&spec.config, spec.options, spec.seams, tokens).await,
        Err(error) => Err(error.to_string()),
    };
    let relay = match started {
        Ok(relay) => relay,
        Err(message) => {
            logline::emit(&logline::failed_to_start(&message));
            remove_install(&root);
            return ExitCode::from(1);
        }
    };
    logline::emit(&logline::listening(spec.config.scheme(), relay.port, &spec.config.renderer_dir));
    let (ended, stdin_ended) = oneshot::channel();
    let watcher = std::thread::Builder::new().name("relay-twin-stdin".to_owned()).spawn(move || watch_stdin(ended));
    // Without a reader the host could never learn that it is to stop: it stops now rather than run for ever.
    if watcher.is_ok() {
        let _ = stdin_ended.await;
    }
    relay.close().await;
    remove_install(&root);
    ExitCode::SUCCESS
}

/// The entry of `relay_twin_host`: the one JSON argument is the knob object.
pub fn main() -> ExitCode {
    let argument = std::env::args().nth(1).unwrap_or_else(|| "{}".to_owned());
    let knobs = match serde_json::from_str::<Value>(&argument) {
        Ok(knobs) => knobs,
        Err(error) => {
            eprintln!("[relay-host] {error}");
            return ExitCode::from(1);
        }
    };
    let (executors, tokens) = match mixdog_rt::exec::boot(RtConfig::detect()) {
        Ok(booted) => booted,
        Err(error) => {
            eprintln!("[relay-host] {error}");
            return ExitCode::from(1);
        }
    };
    executors.handle(TaskClass::Work).block_on(host(knobs, tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(knobs: Value) -> Result<Spec, String> {
        Spec::parse(&knobs)
    }

    #[test]
    fn the_knobs_of_the_node_host_are_read_with_their_names_and_units() {
        let spec = parsed(json!({
            "dataDir": "/d", "rendererDir": "/r", "maxFrameBytes": 1000, "handshakeStallMs": 50, "livenessProbeMs": 20,
            "feedbackEnv": {"SMTP_USER": "u"}, "feedbackOptions": {"maxPending": 3, "ipWindowMs": 5000},
            "fakes": {"nativePush": {"platforms": ["apns", "other"], "answers": []}},
            "mobileRelease": {"a": 1}, "treeRoot": "/t", "installBase": "/i",
        }))
        .unwrap();
        assert_eq!((spec.config.data_dir.as_str(), spec.config.renderer_dir.as_str(), spec.config.port), ("/d", "/r", 0.0));
        assert_eq!(spec.options.max_frame_bytes, 1000);
        assert_eq!((spec.options.handshake.stall, spec.options.handshake.probe), (Duration::from_millis(50), Duration::from_millis(20)));
        assert_eq!(spec.options.feedback_env["SMTP_USER"], "u");
        assert_eq!((spec.options.feedback.max_pending, spec.options.feedback.ip_window_ms), (3, 5000));
        assert_eq!(spec.seams.native_push.unwrap().platforms(), vec!["apns"]);
        assert_eq!(spec.install_base, Some(PathBuf::from("/i")));
    }

    #[test]
    fn a_misspelt_knob_and_a_missing_data_directory_are_refused() {
        assert_eq!(parsed(json!({"dataDir": "/d", "maxFrameByte": 1})).err().unwrap(), "unknown knob: maxFrameByte");
        assert_eq!(parsed(json!({})).err().unwrap(), "knob dataDir is required");
    }

    #[tokio::test]
    async fn the_n_th_call_takes_the_n_th_answer_and_the_last_repeats() {
        let answers = Answers::new(&json!({"answers": [{"status": 500}, {"status": 410}]}));
        let statuses = [answers.next().await, answers.next().await, answers.next().await];
        assert_eq!(statuses.map(|answer| answer["status"].as_u64().unwrap()), [500, 410, 410]);
        assert_eq!(Answers::new(&json!({})).next().await, json!({}));
    }

    #[test]
    fn a_mail_is_recorded_with_its_attachments_as_a_length_and_a_digest() {
        let mail = FeedbackMail {
            from: "f".to_owned(),
            to: "t".to_owned(),
            reply_to: None,
            subject: "s".to_owned(),
            text: "x".to_owned(),
            attachments: vec![crate::feedback::MailAttachment { filename: "a.txt".to_owned(), content: b"abc".to_vec(), content_type: "text/plain".to_owned() }],
            message_id: "<id@feedback.mixdog>".to_owned(),
        };
        let recorded = recorded_mail(&mail);
        let attachment = &recorded["mail"]["attachments"][0];
        assert_eq!(attachment["bytes"], 3);
        assert_eq!(attachment["sha256"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(attachment["contentDisposition"], "attachment");
        assert!(recorded["mail"].get("replyTo").is_none());
    }
}
