//! `createFeedbackService`: validation of a submission, the durable queue, and the delivery schedule. One send runs at a
//! time; a send that fails is retried at 30 s doubling to one hour, forever and across restarts; the mail transport sits
//! behind [`FeedbackSender`] (the `feedbackSender` seam). File I/O runs as `DurabilityIo` lane jobs, timers on the
//! `mixdog_rt` clock.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_js::JsRegex;
use mixdog_rt::{DurabilityIo, TaskClass};
use serde_json::Value;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;

use super::attachments::{self, Attachment};
use super::records::{self, Disk, Loaded, Payload, Record};
use crate::logline::{self, Line};
use crate::rate_limit::{self, RateLimiter};

const MAX_MESSAGE_CHARS: usize = 8000;
const MAX_EMAIL_CHARS: usize = 254;
const DEFAULT_FROM: &str = "feedback@localhost";
const DEFAULT_TO: &str = "support@mixdog.ai";
/// What a wait too long for a timer is cut to (a stored `nextAttemptAt` far in the future).
const LONGEST_WAIT: Duration = Duration::from_secs(24 * 60 * 60);

/// A refusal with the HTTP status and error code the caller answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeedbackError {
    pub status: u16,
    pub code: &'static str,
}

impl FeedbackError {
    const INVALID: Self = Self { status: 400, code: "invalid_feedback" };
    const CONFLICT: Self = Self { status: 409, code: "conflict" };
    const RATE_LIMITED: Self = Self { status: 429, code: "rate_limited" };
    const UNAVAILABLE: Self = Self { status: 503, code: "feedback_unavailable" };
    const BUSY: Self = Self { status: 503, code: "feedback_busy" };
}

impl std::fmt::Display for FeedbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}

impl std::error::Error for FeedbackError {}

/// What the caller answers `202` with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    pub id: String,
    pub status: &'static str,
}

/// One file of a mail. Strings are parsed text: encode them for the wire with `js::node_utf8`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAttachment {
    pub filename: String,
    pub content: Vec<u8>,
    pub content_type: String,
}

/// The message of one feedback record, as `deliver` hands it to the sender: the attachments are sent with
/// `Content-Disposition: attachment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedbackMail {
    pub from: String,
    pub to: String,
    /// `Reply-To`, only when the submission gave one.
    pub reply_to: Option<String>,
    /// `[Mixdog feedback] <kind> <uuid>`
    pub subject: String,
    pub text: String,
    pub attachments: Vec<MailAttachment>,
    /// `<uuid@feedback.mixdog>`
    pub message_id: String,
}

/// A send that failed; only its code is logged (`error` when it has none), never payload or secrets.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendFailure {
    pub code: Option<String>,
}

impl SendFailure {
    pub fn with_code(code: &str) -> Self {
        Self { code: Some(code.to_owned()) }
    }
}

/// The mail transport behind the queue.
pub trait FeedbackSender: Send + Sync + 'static {
    /// Sends one mail: `Ok` when the server accepted it.
    fn send<'a>(&'a self, mail: FeedbackMail) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>>;

    /// Called once when the service is closed, after its last send.
    fn close(&self) {}
}

/// `Date.now()` as the schedule reads it: milliseconds.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
/// Where the diagnostic lines go.
pub type LogSink = Arc<dyn Fn(&Line) + Send + Sync>;

/// `FEEDBACK_DEFAULTS` and the seams of `createFeedbackService`.
#[derive(Clone)]
pub struct FeedbackOptions {
    pub max_pending: usize,
    pub max_records: usize,
    pub base_delay_ms: f64,
    pub max_delay_ms: f64,
    pub ip_limit: usize,
    pub ip_window_ms: i64,
    pub global_limit: usize,
    pub global_window_ms: i64,
    /// Raw bytes of attachments held by undelivered records.
    pub max_pending_attachment_bytes: usize,
    /// `From` of every mail: the SMTP user when mail is configured.
    pub from: String,
    /// `To` of every mail: `FEEDBACK_TO`, `support@mixdog.ai` by default.
    pub to: String,
    pub now: Clock,
    pub log: LogSink,
}

impl Default for FeedbackOptions {
    fn default() -> Self {
        Self {
            max_pending: 500,
            max_records: 5000,
            base_delay_ms: 30_000.0,
            max_delay_ms: 60.0 * 60_000.0,
            ip_limit: 10,
            ip_window_ms: 10 * 60_000,
            global_limit: 120,
            global_window_ms: 60 * 60_000,
            max_pending_attachment_bytes: 48 * 1024 * 1024,
            from: DEFAULT_FROM.to_owned(),
            to: DEFAULT_TO.to_owned(),
            now: Arc::new(|| rate_limit::now_ms() as f64),
            log: Arc::new(logline::emit),
        }
    }
}

/// A validated request body.
struct Input {
    id: String,
    kind: String,
    message: String,
    reply_to: String,
    attachments: Vec<Attachment>,
}

fn is_email(text: &str) -> bool {
    static PATTERN: OnceLock<JsRegex> = OnceLock::new();
    PATTERN
        .get_or_init(|| JsRegex::new_static(r#"^[^\s@<>(),;:\\"]+@[^\s@<>(),;:\\"]+\.[^\s@<>(),;:\\"]+$"#, ""))
        .is_match(text)
}

/// `normalizeFeedback(body)`; `body` is parsed JSON.
fn normalize(body: &Value) -> Result<Input, FeedbackError> {
    let bad = FeedbackError::INVALID;
    let object = body.as_object().ok_or(bad)?;
    let id = object.get("id").and_then(Value::as_str).filter(|id| records::is_uuid(id)).ok_or(bad)?;
    let kind = object.get("kind").and_then(Value::as_str).filter(|kind| records::KINDS.contains(kind)).ok_or(bad)?;
    let message = crate::js::js_trim(object.get("message").and_then(Value::as_str).ok_or(bad)?);
    if message.is_empty() || crate::js::js_len(message) > MAX_MESSAGE_CHARS {
        return Err(bad);
    }
    // Absent or blank means no reply address; null and non-strings are refused.
    let reply_to = match object.get("replyTo") {
        None => "",
        Some(value) => {
            let reply = crate::js::js_trim(value.as_str().ok_or(bad)?);
            if crate::js::js_len(reply) > MAX_EMAIL_CHARS || (!reply.is_empty() && !is_email(reply)) {
                return Err(bad);
            }
            reply
        }
    };
    let attachments = attachments::normalize(object.get("attachments")).map_err(|_| bad)?;
    Ok(Input {
        id: id.to_ascii_lowercase(),
        kind: kind.to_owned(),
        message: message.to_owned(),
        reply_to: reply_to.to_owned(),
        attachments,
    })
}

struct Entry {
    /// Insertion order: a `Map`'s, which the schedule and the prune follow.
    seq: u64,
    record: Record,
}

struct State {
    records: HashMap<String, Entry>,
    next_seq: u64,
    /// The id whose send is in flight.
    sending: Option<String>,
    storage_ok: bool,
}

impl State {
    fn insert(&mut self, record: Record) {
        self.next_seq += 1;
        self.records.insert(record.id.clone(), Entry { seq: self.next_seq, record });
    }

    fn pending_count(&self) -> usize {
        self.records.values().filter(|entry| !entry.record.is_sent()).count()
    }

    fn pending_attachment_bytes(&self) -> usize {
        self.records.values().map(|entry| entry.record.pending_attachment_bytes()).sum()
    }
}

/// What the delivery loop does next.
enum Step {
    Deliver(String, Payload),
    Wait(Option<f64>),
}

struct Inner {
    options: FeedbackOptions,
    disk: Disk,
    sender: Option<Arc<dyn FeedbackSender>>,
    state: Mutex<State>,
    /// Submissions run one at a time so the capacity and idempotency checks stay valid across the awaits.
    admit: Semaphore,
    wake: Notify,
    closed: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
    limiters: Mutex<(RateLimiter, RateLimiter)>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Inner {
    fn log(&self, line: &Line) {
        (self.options.log)(line);
    }

    fn now(&self) -> f64 {
        (self.options.now)()
    }

    /// `diag`: an id or file name and an error code only.
    fn diag(&self, what: &str, error: &std::io::Error) {
        self.log(&logline::feedback_diagnostic(what, &records::error_code(error)));
    }

    fn next_step(&self) -> Step {
        let now = self.now();
        let mut state = locked(&self.state);
        let mut waiting: Option<f64> = None;
        let mut due: Option<(u64, &Entry)> = None;
        for entry in state.records.values().filter(|entry| !entry.record.is_sent()) {
            if entry.record.next_attempt_at <= now {
                if due.is_none_or(|(seq, _)| entry.seq < seq) {
                    due = Some((entry.seq, entry));
                }
            } else {
                waiting = Some(waiting.map_or(entry.record.next_attempt_at, |next| next.min(entry.record.next_attempt_at)));
            }
        }
        let chosen = due.and_then(|(_, entry)| entry.record.payload.clone().map(|payload| (entry.record.id.clone(), payload)));
        match chosen {
            Some((id, payload)) => {
                state.sending = Some(id.clone());
                Step::Deliver(id, payload)
            }
            None => Step::Wait(waiting.map(|next| (next - now).max(0.0))),
        }
    }

    /// `deliver`: one send, then the record's new state on disk.
    async fn deliver(&self, sender: &Arc<dyn FeedbackSender>, id: String, payload: Payload) {
        let result = match build_mail(&self.options, &id, &payload) {
            Some(mail) => sender.send(mail).await,
            None => Err(SendFailure::default()),
        };
        let now = self.now();
        let mut failed = None;
        let text = {
            let mut state = locked(&self.state);
            state.records.get_mut(&id).map(|entry| {
                let record = &mut entry.record;
                match result {
                    Ok(()) => {
                        record.sent_at = now;
                        record.payload = None;
                    }
                    Err(failure) => {
                        record.attempts += 1.0;
                        let doubling = 2f64.powf((record.attempts - 1.0).min(30.0));
                        record.next_attempt_at = now + self.options.max_delay_ms.min(self.options.base_delay_ms * doubling);
                        failed = Some(failure.code.filter(|code| !code.is_empty()).unwrap_or_else(|| "error".to_owned()));
                    }
                }
                record.to_text()
            })
        };
        if let Some(code) = failed {
            self.log(&logline::feedback_send_failed(&id, &code));
        }
        if let Some(text) = text
            && let Err(error) = self.disk.persist(&id, text, false).await
        {
            // The in-memory state still prevents a resend in this process.
            self.diag(&format!("state persist failed id={id}"), &error);
        }
        locked(&self.state).sending = None;
    }

    /// `pruneSent`: frees the oldest delivered record; its file is gone before it is forgotten, so a failed unlink can never
    /// let the disk outgrow the cap.
    async fn prune_sent(&self) -> Result<bool, FeedbackError> {
        let oldest = {
            let state = locked(&self.state);
            state
                .records
                .values()
                .filter(|entry| entry.record.is_sent() && state.sending.as_deref() != Some(entry.record.id.as_str()))
                .min_by(|a, b| a.record.sent_at.total_cmp(&b.record.sent_at).then(a.seq.cmp(&b.seq)))
                .map(|entry| entry.record.id.clone())
        };
        let Some(id) = oldest else { return Ok(false) };
        if let Err(error) = self.disk.remove(&id).await {
            self.diag("prune failed", &error);
            return Err(FeedbackError::UNAVAILABLE);
        }
        locked(&self.state).records.remove(&id);
        Ok(true)
    }

    async fn admit(&self, input: Input) -> Result<Accepted, FeedbackError> {
        if self.sender.is_none() || !locked(&self.state).storage_ok || self.closed.load(Ordering::SeqCst) {
            return Err(FeedbackError::UNAVAILABLE);
        }
        let hash = records::payload_hash(&input.kind, &input.message, &input.reply_to, &input.attachments);
        {
            let state = locked(&self.state);
            if let Some(existing) = state.records.get(&input.id) {
                if existing.record.hash != hash {
                    return Err(FeedbackError::CONFLICT);
                }
                return Ok(Accepted { id: input.id, status: "accepted" });
            }
            if state.pending_count() >= self.options.max_pending {
                return Err(FeedbackError::BUSY);
            }
            if !input.attachments.is_empty()
                && state.pending_attachment_bytes() + attachments::bytes_of(&input.attachments) > self.options.max_pending_attachment_bytes
            {
                return Err(FeedbackError::BUSY);
            }
        }
        while locked(&self.state).records.len() >= self.options.max_records {
            if !self.prune_sent().await? {
                return Err(FeedbackError::BUSY);
            }
        }
        let now = self.now();
        let record = Record {
            id: input.id,
            hash,
            payload: Some(Payload {
                kind: input.kind,
                message: input.message,
                reply_to: input.reply_to,
                attachments: (!input.attachments.is_empty()).then_some(input.attachments),
            }),
            created_at: now,
            attempts: 0.0,
            next_attempt_at: now,
            sent_at: 0.0,
        };
        if let Err(error) = self.disk.persist(&record.id, record.to_text(), true).await {
            self.diag(&format!("persist failed id={}", record.id), &error);
            return Err(FeedbackError::UNAVAILABLE);
        }
        let id = record.id.clone();
        locked(&self.state).insert(record);
        self.wake.notify_one();
        Ok(Accepted { id, status: "accepted" })
    }
}

/// `deliver`'s message: `None` only for stored attachment text that is not base64, which validation has already refused.
fn build_mail(options: &FeedbackOptions, id: &str, payload: &Payload) -> Option<FeedbackMail> {
    let attachments = payload
        .attachments
        .iter()
        .flatten()
        .map(|a| {
            Some(MailAttachment { filename: a.name.clone(), content: STANDARD.decode(&a.data).ok()?, content_type: a.mime_type.clone() })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(FeedbackMail {
        from: options.from.clone(),
        to: options.to.clone(),
        reply_to: (!payload.reply_to.is_empty()).then(|| payload.reply_to.clone()),
        subject: format!("[Mixdog feedback] {} {id}", payload.kind),
        text: payload.message.clone(),
        attachments,
        message_id: format!("<{id}@feedback.mixdog>"),
    })
}

/// The delivery loop: delivers what is due, in the order the records were taken in, then sleeps until the next retry or until
/// a record arrives or the service closes.
async fn run(inner: Arc<Inner>, sender: Arc<dyn FeedbackSender>) {
    while !inner.closed.load(Ordering::SeqCst) {
        match inner.next_step() {
            Step::Deliver(id, payload) => inner.deliver(&sender, id, payload).await,
            Step::Wait(Some(ms)) => {
                let wait = Duration::try_from_secs_f64(ms / 1000.0).unwrap_or(LONGEST_WAIT).min(LONGEST_WAIT);
                tokio::select! {
                    () = inner.wake.notified() => {}
                    () = mixdog_rt::time::sleep(wait) => {}
                }
            }
            Step::Wait(None) => inner.wake.notified().await,
        }
    }
}

/// The feedback queue.
#[derive(Clone)]
pub struct FeedbackService {
    inner: Arc<Inner>,
}

impl FeedbackService {
    /// Creates `<data_dir>/feedback` (0700, also when mail is not configured), loads the records and starts delivering what is
    /// due. A record that cannot be read or is not valid leaves the storage unavailable: every submission then answers 503.
    pub async fn start(
        data_dir: &Path,
        io: DurabilityIo,
        sender: Option<Arc<dyn FeedbackSender>>,
        options: FeedbackOptions,
    ) -> Self {
        let limiters = (
            RateLimiter::new(options.ip_limit, options.ip_window_ms),
            RateLimiter::with_max_keys(options.global_limit, options.global_window_ms, 1),
        );
        let inner = Arc::new(Inner {
            options,
            disk: Disk::new(data_dir, io),
            sender,
            state: Mutex::new(State { records: HashMap::new(), next_seq: 0, sending: None, storage_ok: true }),
            admit: Semaphore::new(1),
            wake: Notify::new(),
            closed: AtomicBool::new(false),
            task: Mutex::new(None),
            limiters: Mutex::new(limiters),
        });
        match inner.disk.load().await {
            Ok(files) => {
                for loaded in files {
                    match loaded {
                        Loaded::Record(record) => locked(&inner.state).insert(*record),
                        Loaded::Unreadable { file, code } => {
                            inner.log(&logline::feedback_diagnostic(&format!("record unreadable file={file}"), &code));
                            locked(&inner.state).storage_ok = false;
                        }
                        Loaded::Corrupt { file } => {
                            inner.log(&logline::feedback_record_corrupt(&file));
                            locked(&inner.state).storage_ok = false;
                        }
                    }
                }
            }
            Err(error) => {
                inner.diag("storage unavailable", &error);
                locked(&inner.state).storage_ok = false;
            }
        }
        if let Some(sender) = inner.sender.clone() {
            let handle = mixdog_rt::spawn("relay-feedback-delivery", TaskClass::Work, run(inner.clone(), sender));
            *locked(&inner.task) = Some(handle);
        }
        Self { inner }
    }

    /// Whether mail is configured (a sender is connected).
    pub fn configured(&self) -> bool {
        self.inner.sender.is_some()
    }

    /// `checkRate(ip)`: the per-address and the global window; a refusal is 429.
    pub fn check_rate(&self, ip: &str) -> Result<(), FeedbackError> {
        let mut limiters = locked(&self.inner.limiters);
        if !limiters.0.allow(ip) || !limiters.1.allow("global") {
            return Err(FeedbackError::RATE_LIMITED);
        }
        Ok(())
    }

    /// `submit(body)`: validates the parsed body, stores the record, and answers only once it is on disk. A refusal carries
    /// the status and code to answer.
    pub async fn submit(&self, body: &Value) -> Result<Accepted, FeedbackError> {
        let input = normalize(body)?;
        // The semaphore is never closed, so a permit is always granted.
        let _turn = self.inner.admit.acquire().await;
        self.inner.admit(input).await
    }

    /// `close()`: stops scheduling, waits for the submission and the send in progress, then closes the sender.
    pub async fn close(&self) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.inner.wake.notify_one();
        drop(self.inner.admit.acquire().await);
        let task = locked(&self.inner.task).take();
        if let Some(task) = task {
            let _ = task.await;
        }
        if let Some(sender) = &self.inner.sender {
            sender.close();
        }
    }

    /// The faults a test puts on the disk.
    #[cfg(any(test, feature = "test-support"))]
    pub fn faults(&self) -> &records::Faults {
        &self.inner.disk.faults
    }
}
