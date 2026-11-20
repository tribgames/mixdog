//! The feedback queue on a clock the tests move: persistence before acceptance, idempotence, validation, attachments, retry with backoff across restarts, capacity, and corrupt or unreadable storage.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::Unlaned;
use mixdog_relay::feedback::attachments::{self, MAX_BYTES};
use mixdog_relay::feedback::records;
use mixdog_relay::feedback::{FeedbackError, FeedbackMail, FeedbackOptions, FeedbackSender, FeedbackService, SendFailure};
use mixdog_relay::js;
use mixdog_relay::logline::Line;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Semaphore;

// ---- the rig ----

/// The wall clock of the service, moved by the test together with the runtime's paused time.
#[derive(Clone)]
struct Clock(Arc<AtomicI64>);

impl Clock {
    fn new(ms: i64) -> Self {
        Self(Arc::new(AtomicI64::new(ms)))
    }

    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }

    fn reader(&self) -> mixdog_relay::feedback::Clock {
        let cell = self.0.clone();
        Arc::new(move || cell.load(Ordering::SeqCst) as f64)
    }

    async fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
        tokio::time::advance(Duration::from_millis(ms as u64)).await;
        settle().await;
    }
}

#[derive(Clone, Default)]
struct Lines(Arc<Mutex<Vec<String>>>);

impl Lines {
    fn sink(&self) -> mixdog_relay::feedback::LogSink {
        let lines = self.0.clone();
        Arc::new(move |line: &Line| lines.lock().unwrap().push(line.text.clone()))
    }

    fn all(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn has(&self, text: &str) -> bool {
        self.all().iter().any(|line| line == text)
    }
}

/// A mail transport that records what it is given and answers what the test scripted.
struct Fake {
    sent: Mutex<Vec<FeedbackMail>>,
    outcome: Mutex<Result<(), SendFailure>>,
    calls: AtomicUsize,
    delivered: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
    closed: AtomicBool,
    gate: Option<Semaphore>,
}

impl Fake {
    fn new(outcome: Result<(), SendFailure>, gate: Option<Semaphore>) -> Arc<Self> {
        Arc::new(Self {
            sent: Mutex::new(Vec::new()),
            outcome: Mutex::new(outcome),
            calls: AtomicUsize::new(0),
            delivered: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            gate,
        })
    }

    fn ok() -> Arc<Self> {
        Self::new(Ok(()), None)
    }

    fn failing(code: &str) -> Arc<Self> {
        Self::new(Err(SendFailure::with_code(code)), None)
    }

    fn gated() -> Arc<Self> {
        Self::new(Ok(()), Some(Semaphore::new(0)))
    }

    fn set_ok(&self) {
        *self.outcome.lock().unwrap() = Ok(());
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn delivered(&self) -> usize {
        self.delivered.load(Ordering::SeqCst)
    }

    fn mails(&self) -> Vec<FeedbackMail> {
        self.sent.lock().unwrap().clone()
    }
}

impl FeedbackSender for Fake {
    fn send<'a>(&'a self, mail: FeedbackMail) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(active, Ordering::SeqCst);
            self.sent.lock().unwrap().push(mail);
            if let Some(gate) = &self.gate {
                gate.acquire().await.unwrap().forget();
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            let outcome = self.outcome.lock().unwrap().clone();
            if outcome.is_ok() {
                self.delivered.fetch_add(1, Ordering::SeqCst);
            }
            outcome
        })
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// Lets every task that can run, run.
async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}

async fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..5000 {
        if condition() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("timed out waiting for {what}");
}

fn options(clock: &Clock, lines: &Lines) -> FeedbackOptions {
    FeedbackOptions { now: clock.reader(), log: lines.sink(), ..FeedbackOptions::default() }
}

async fn start(dir: &Path, sender: Option<&Arc<Fake>>, options: FeedbackOptions) -> FeedbackService {
    let io = mixdog_rt::testing::tokens().durability_io;
    FeedbackService::start(dir, io, sender.map(|sender| sender.clone() as Arc<dyn FeedbackSender>), options).await
}

/// A fresh data directory, a clock, a log and a service over `sender`.
struct World {
    dir: TempDir,
    clock: Clock,
    lines: Lines,
}

impl World {
    fn new() -> Self {
        Self { dir: TempDir::new().unwrap(), clock: Clock::new(1_000_000), lines: Lines::default() }
    }

    fn options(&self) -> FeedbackOptions {
        options(&self.clock, &self.lines)
    }

    async fn start(&self, sender: Option<&Arc<Fake>>, options: FeedbackOptions) -> FeedbackService {
        start(self.dir.path(), sender, options).await
    }

    fn feedback(&self) -> PathBuf {
        self.dir.path().join("feedback")
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> =
            mixdog_fsio::read_dir(&Unlaned, self.feedback()).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn text(&self, id: &str) -> String {
        mixdog_fsio::read_to_string(&Unlaned, self.feedback().join(format!("{id}.json"))).unwrap()
    }

    fn record(&self, id: &str) -> Value {
        js::parse(&self.text(id)).unwrap()
    }

    fn sent_at(&self, id: &str) -> f64 {
        mixdog_fsio::read_to_string(&Unlaned, self.feedback().join(format!("{id}.json")))
            .ok()
            .and_then(|text| js::parse(&text).ok())
            .and_then(|record| record["sentAt"].as_f64())
            .unwrap_or(0.0)
    }
}

fn uid(n: u32) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
}

fn valid(id: &str) -> Value {
    json!({ "id": id, "kind": "bug", "message": "  it broke  " })
}

fn with(mut body: Value, key: &str, value: Value) -> Value {
    body[key] = value;
    body
}

fn image(kind: &str, size: usize, fill: u8) -> Vec<u8> {
    let head: Vec<u8> = match kind {
        "png" => vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "jpeg" => vec![0xff, 0xd8, 0xff, 0xe0],
        _ => [b"RIFF".as_slice(), &[0, 0, 0, 0], b"WEBP"].concat(),
    };
    let mut bytes = vec![fill; size];
    bytes[..head.len()].copy_from_slice(&head);
    bytes
}

fn attach(name: &str, kind: &str, size: usize, fill: u8) -> Value {
    json!({ "name": name, "mimeType": format!("image/{kind}"), "data": STANDARD.encode(image(kind, size, fill)) })
}

fn ok_attachment() -> Value {
    attach("shot.png", "png", 64, 7)
}

// ---- submit: persisted before accepted, mailed once ----

#[tokio::test(start_paused = true)]
async fn a_submission_is_on_disk_before_it_is_accepted_and_is_mailed_once() {
    let world = World::new();
    let sender = Fake::gated();
    let service = world.start(Some(&sender), world.options()).await;
    let id = uid(1);
    let body = with(valid(&id), "replyTo", json!("User@Example.com"));
    let accepted = service.submit(&body).await.unwrap();
    assert_eq!((accepted.id.as_str(), accepted.status), (id.as_str(), "accepted"));
    // The mail is still in flight (the gate is shut); the record is already durable and compact.
    assert_eq!(world.names(), [format!("{id}.json")]);
    let text = world.text(&id);
    assert!(text.starts_with(&format!("{{\"id\":\"{id}\",\"hash\":\"")), "compact JSON: {text}");
    assert!(text.contains("\"payload\":{\"kind\":\"bug\",\"message\":\"it broke\",\"replyTo\":\"User@Example.com\"}"));
    assert!(text.ends_with("\"createdAt\":1000000,\"attempts\":0,\"nextAttemptAt\":1000000,\"sentAt\":0}"));
    wait_for("the send", || sender.calls() == 1).await;
    sender.gate.as_ref().unwrap().add_permits(1);
    wait_for("the sent mark", || world.sent_at(&id) > 0.0).await;
    let mails = sender.mails();
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0].to, "support@mixdog.ai");
    assert_eq!(mails[0].from, "feedback@localhost");
    assert_eq!(mails[0].text, "it broke");
    assert_eq!(mails[0].reply_to.as_deref(), Some("User@Example.com"));
    assert_eq!(mails[0].subject, format!("[Mixdog feedback] bug {id}"));
    assert_eq!(mails[0].message_id, format!("<{id}@feedback.mixdog>"));
    assert!(mails[0].attachments.is_empty());
    let after = world.record(&id);
    assert_eq!(after["sentAt"], json!(1_000_000));
    assert!(after.get("payload").is_none(), "a sent record drops its payload");
    assert_eq!(after.as_object().unwrap().len(), 6);
    settle().await;
    assert_eq!(sender.calls(), 1);
    service.close().await;
    assert!(sender.closed.load(Ordering::SeqCst));
}

#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn the_directory_is_private_and_so_are_the_records() {
    use std::os::unix::fs::PermissionsExt;
    let world = World::new();
    let sender = Fake::failing("EAUTH");
    let service = world.start(Some(&sender), world.options()).await;
    service.submit(&valid(&uid(1))).await.unwrap();
    let mode = |path: PathBuf| mixdog_fsio::metadata(&Unlaned, path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(world.feedback()), 0o700);
    assert_eq!(mode(world.feedback().join(format!("{}.json", uid(1)))), 0o600);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn the_same_id_and_payload_is_idempotent_and_a_different_payload_conflicts() {
    let world = World::new();
    let sender = Fake::ok();
    let service = world.start(Some(&sender), world.options()).await;
    let body = valid(&uid(1));
    service.submit(&body).await.unwrap();
    wait_for("the first mail", || sender.delivered() == 1).await;
    // The message is compared after trimming.
    service.submit(&with(body.clone(), "message", json!("it broke"))).await.unwrap();
    let both = valid(&uid(2));
    let (a, b) = tokio::join!(service.submit(&both), service.submit(&both));
    assert!(a.is_ok() && b.is_ok());
    let conflict = service.submit(&with(body.clone(), "message", json!("other"))).await.unwrap_err();
    assert_eq!((conflict.status, conflict.code), (409, "conflict"));
    let conflict = service.submit(&with(body.clone(), "kind", json!("other"))).await.unwrap_err();
    assert_eq!(conflict.status, 409);
    wait_for("two mails", || sender.delivered() == 2).await;
    settle().await;
    assert_eq!(sender.calls(), 2);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn the_uppercase_id_is_stored_lowercase() {
    let world = World::new();
    let sender = Fake::ok();
    let service = world.start(Some(&sender), world.options()).await;
    let id = "ABCDEF01-0000-4000-8000-00000000000A";
    let accepted = service.submit(&valid(id)).await.unwrap();
    assert_eq!(accepted.id, id.to_ascii_lowercase());
    assert_eq!(world.names(), [format!("{}.json", id.to_ascii_lowercase())]);
    service.close().await;
}

// ---- validation ----

#[tokio::test(start_paused = true)]
async fn a_body_that_is_not_a_valid_feedback_is_refused_with_400() {
    let world = World::new();
    let sender = Fake::ok();
    let service = world.start(Some(&sender), world.options()).await;
    let id = uid(1);
    let long = "a".repeat(8001);
    let bad = [
        json!("x"),
        json!([]),
        json!(null),
        with(valid(&id), "id", json!("nope")),
        with(valid(&id), "id", json!(5)),
        with(valid(&id), "kind", json!("x")),
        with(valid(&id), "kind", json!(null)),
        with(valid(&id), "message", json!("   ")),
        with(valid(&id), "message", json!("\u{feff}\u{a0}\u{2028}")),
        with(valid(&id), "message", json!(long)),
        with(valid(&id), "message", json!(7)),
        // 4001 emoji are 8002 UTF-16 units.
        with(valid(&id), "message", json!("\u{1f600}".repeat(4001))),
        with(valid(&id), "replyTo", json!("not-an-email")),
        with(valid(&id), "replyTo", json!(format!("{}@b.co", "a".repeat(250)))),
        with(valid(&id), "replyTo", json!(5)),
        with(valid(&id), "replyTo", json!(null)),
        with(valid(&id), "replyTo", json!("a b@c.de")),
        with(valid(&id), "replyTo", json!("a@b")),
        with(valid(&id), "replyTo", json!("a@b.")),
        with(valid(&id), "replyTo", json!("a@@b.co")),
        with(valid(&id), "replyTo", json!("a(b)@c.de")),
        with(valid(&id), "replyTo", json!("\"a\"@c.de")),
    ];
    for body in bad {
        let error = service.submit(&body).await.unwrap_err();
        assert_eq!((error.status, error.code), (400, "invalid_feedback"), "{body}");
    }
    assert!(world.names().is_empty());
    // The edges that are accepted: 8000 units, JavaScript white space around the text, a blank reply address.
    service.submit(&with(valid(&uid(2)), "message", json!("a".repeat(8000)))).await.unwrap();
    service.submit(&with(valid(&uid(3)), "message", json!("\u{1f600}".repeat(4000)))).await.unwrap();
    service.submit(&with(valid(&uid(4)), "message", json!("\u{feff}\u{a0}hi\u{2029}"))).await.unwrap();
    service.submit(&with(valid(&uid(5)), "replyTo", json!("   "))).await.unwrap();
    service.submit(&with(valid(&uid(6)), "replyTo", json!(format!("{}@b.co", "a".repeat(248))))).await.unwrap();
    wait_for("every mail", || sender.delivered() == 5).await;
    let mails = sender.mails();
    assert_eq!(mails[2].text, "hi");
    assert_eq!(mails[3].reply_to, None, "a blank reply address is absent");
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn the_rate_limits_are_per_address_and_global() {
    let world = World::new();
    let options = FeedbackOptions { ip_limit: 2, global_limit: 4, ..world.options() };
    let service = world.start(Some(&Fake::ok()), options).await;
    assert!(service.check_rate("1.1.1.1").is_ok());
    assert!(service.check_rate("1.1.1.1").is_ok());
    assert_eq!(service.check_rate("1.1.1.1"), Err(FeedbackError { status: 429, code: "rate_limited" }));
    // A refusal by the address window is not counted against the global one: 4 hits so far, the limit.
    assert!(service.check_rate("2.2.2.2").is_ok());
    assert!(service.check_rate("2.2.2.2").is_ok());
    assert_eq!(service.check_rate("3.3.3.3").unwrap_err().status, 429);
    service.close().await;
}

// ---- the schedule ----

#[tokio::test(start_paused = true)]
async fn failed_sends_retry_with_bounded_backoff_and_survive_a_restart() {
    let world = World::new();
    let sender = Fake::failing("ETIMEDOUT");
    let options = FeedbackOptions { base_delay_ms: 1000.0, max_delay_ms: 4000.0, ..world.options() };
    let service = world.start(Some(&sender), options.clone()).await;
    let id = uid(1);
    let body = valid(&id);
    service.submit(&body).await.unwrap();
    wait_for("attempt 1", || sender.calls() == 1).await;
    settle().await;
    world.clock.advance(999).await;
    assert_eq!(sender.calls(), 1);
    world.clock.advance(1).await;
    wait_for("attempt 2", || sender.calls() == 2).await;
    world.clock.advance(1999).await;
    assert_eq!(sender.calls(), 2);
    world.clock.advance(1).await;
    wait_for("attempt 3", || sender.calls() == 3).await;
    world.clock.advance(4000).await;
    wait_for("attempt 4", || sender.calls() == 4).await;
    settle().await;
    let stored = world.record(&id);
    assert_eq!(stored["attempts"], json!(4));
    assert_eq!(stored["nextAttemptAt"].as_i64().unwrap(), world.clock.now() + 4000, "capped at the maximum");
    assert!(world.lines.has(&format!("[relay] feedback send failed id={id} code=ETIMEDOUT")));
    service.close().await;
    let closed_calls = sender.calls();
    world.clock.advance(100_000).await;
    assert_eq!(sender.calls(), closed_calls, "a closed service sends nothing");

    let second = Fake::ok();
    let service = world.start(Some(&second), options).await;
    wait_for("the due record after a restart", || second.delivered() == 1).await;
    assert_eq!(second.mails()[0].text, "it broke");
    service.submit(&body).await.unwrap();
    settle().await;
    assert_eq!(second.calls(), 1, "still idempotent after a restart");
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn the_default_backoff_is_thirty_seconds_doubling_to_one_hour() {
    let world = World::new();
    let sender = Fake::failing("ECONNECTION");
    let service = world.start(Some(&sender), world.options()).await;
    let id = uid(1);
    service.submit(&valid(&id)).await.unwrap();
    wait_for("attempt 1", || sender.calls() == 1).await;
    settle().await;
    let mut delays = Vec::new();
    for attempt in 1..=9usize {
        let record = world.record(&id);
        assert_eq!(record["attempts"], json!(attempt));
        let delay = record["nextAttemptAt"].as_i64().unwrap() - world.clock.now();
        delays.push(delay);
        world.clock.advance(delay).await;
        wait_for("the next attempt", || sender.calls() == attempt + 1).await;
        settle().await;
    }
    assert_eq!(delays, [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn one_send_runs_at_a_time_and_close_waits_for_it() {
    let world = World::new();
    let sender = Fake::gated();
    let service = world.start(Some(&sender), world.options()).await;
    service.submit(&valid(&uid(1))).await.unwrap();
    wait_for("a send in flight", || sender.calls() == 1).await;
    service.submit(&valid(&uid(2))).await.unwrap();
    world.clock.advance(60_000).await;
    assert_eq!(sender.peak.load(Ordering::SeqCst), 1, "the second record waits for the first send");
    assert_eq!(sender.calls(), 1);
    let closing = tokio::spawn({
        let service = service.clone();
        async move { service.close().await }
    });
    settle().await;
    assert!(!closing.is_finished(), "close waits for the send in flight");
    sender.gate.as_ref().unwrap().add_permits(1);
    closing.await.unwrap();
    assert_eq!(sender.calls(), 1, "a closed service starts no further send");
    assert_eq!(sender.delivered(), 1);
    assert!(sender.closed.load(Ordering::SeqCst));
    assert!(world.sent_at(&uid(1)) > 0.0, "the sent mark is written before close returns");
    let late = service.submit(&valid(&uid(3))).await.unwrap_err();
    assert_eq!(late.status, 503);
}

// ---- capacity ----

#[tokio::test(start_paused = true)]
async fn the_undelivered_records_are_capped_and_the_delivered_are_pruned() {
    let world = World::new();
    let sender = Fake::failing("EAUTH");
    let options = FeedbackOptions { max_pending: 2, max_records: 5, ..world.options() };
    let service = world.start(Some(&sender), options).await;
    service.submit(&valid(&uid(1))).await.unwrap();
    service.submit(&valid(&uid(2))).await.unwrap();
    let busy = service.submit(&valid(&uid(3))).await.unwrap_err();
    assert_eq!((busy.status, busy.code), (503, "feedback_busy"));
    assert_eq!(world.names().len(), 2);
    service.close().await;

    let ok_world = World::new();
    let sender = Fake::ok();
    let options = FeedbackOptions { max_records: 2, ..ok_world.options() };
    let service = ok_world.start(Some(&sender), options).await;
    for n in 1..=4 {
        service.submit(&valid(&uid(n))).await.unwrap();
        wait_for("delivery", || ok_world.sent_at(&uid(n)) > 0.0).await;
        // The clock moves so the oldest delivered record is the first one.
        ok_world.clock.advance(1).await;
    }
    assert_eq!(ok_world.names(), [format!("{}.json", uid(3)), format!("{}.json", uid(4))]);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_unlink_answers_503_and_the_record_is_not_forgotten() {
    let world = World::new();
    let sender = Fake::ok();
    let options = FeedbackOptions { max_records: 1, ..world.options() };
    let service = world.start(Some(&sender), options).await;
    let a = uid(1);
    service.submit(&valid(&a)).await.unwrap();
    wait_for("delivery of a", || world.sent_at(&a) > 0.0).await;
    settle().await;
    service.faults().unlink.store(true, Ordering::SeqCst);
    let error = service.submit(&valid(&uid(2))).await.unwrap_err();
    assert_eq!((error.status, error.code), (503, "feedback_unavailable"));
    assert!(world.lines.has("[relay] feedback prune failed code=error"));
    assert_eq!(world.names().len(), 1);
    service.submit(&valid(&a)).await.unwrap();
    service.faults().unlink.store(false, Ordering::SeqCst);
    service.submit(&valid(&uid(2))).await.unwrap();
    assert!(!world.names().contains(&format!("{a}.json")), "a is pruned once the unlink works");
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn pending_attachment_bytes_are_bounded_and_freed_after_delivery() {
    let world = World::new();
    let sender = Fake::failing("EAUTH");
    let options = FeedbackOptions { max_pending_attachment_bytes: 10_000, ..world.options() };
    let service = world.start(Some(&sender), options).await;
    let big = |n: u32| with(valid(&uid(n)), "attachments", json!([attach("a.png", "png", 6000, n as u8)]));
    service.submit(&big(1)).await.unwrap();
    let busy = service.submit(&big(2)).await.unwrap_err();
    assert_eq!((busy.status, busy.code), (503, "feedback_busy"));
    service.submit(&valid(&uid(3))).await.expect("feedback without attachments is unaffected");
    sender.set_ok();
    world.clock.advance(30_000).await;
    wait_for("both queued mails", || sender.delivered() == 2).await;
    settle().await;
    service.submit(&big(4)).await.expect("delivered attachments release the capacity");
    service.close().await;
}

// ---- storage ----

#[tokio::test(start_paused = true)]
async fn without_mail_every_submission_is_503_and_nothing_is_stored() {
    let world = World::new();
    let service = world.start(None, world.options()).await;
    assert!(!service.configured());
    assert_eq!(world.names(), Vec::<String>::new(), "the directory exists even without mail");
    let error = service.submit(&valid(&uid(1))).await.unwrap_err();
    assert_eq!((error.status, error.code), (503, "feedback_unavailable"));
    assert!(world.names().is_empty());
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn corrupt_records_fail_closed_with_generic_diagnostics() {
    let world = World::new();
    mixdog_fsio::create_dir_all(&Unlaned, world.feedback()).unwrap();
    let id = uid(1);
    let secret = "SECRET-PAYLOAD-TEXT";
    let put = |name: &str, text: String| mixdog_fsio::write(&Unlaned, world.feedback().join(name), text).unwrap();
    put(&format!("{id}.json"), format!("{{\"id\":\"{id}\",\"payload\":\"{secret}\""));
    let other = uid(2);
    put(&format!("{other}.json"), json!({ "id": uid(3), "hash": "x" }).to_string());
    put("notes.txt", "ignored".to_owned());
    put(&format!("{}.json.tmp", uid(4)), "ignored".to_owned());
    let sender = Fake::ok();
    let service = world.start(Some(&sender), world.options()).await;
    let lines = world.lines.all();
    assert_eq!(lines, [format!("[relay] feedback record unreadable file={id}.json code=error"), format!("[relay] feedback record corrupt file={other}.json"),]);
    assert!(!lines.join("\n").contains(secret));
    let error = service.submit(&valid(&uid(9))).await.unwrap_err();
    assert_eq!(error.status, 503);
    let error = service.submit(&json!({ "id": id, "kind": "bug", "message": "x" })).await.unwrap_err();
    assert_eq!(error.status, 503, "no acknowledgement of an unverified id");
    settle().await;
    assert_eq!(sender.calls(), 0);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_record_that_cannot_be_read_leaves_the_storage_unavailable() {
    let world = World::new();
    let name = format!("{}.json", uid(1));
    mixdog_fsio::create_dir_all(&Unlaned, world.feedback().join(&name)).unwrap();
    let service = world.start(Some(&Fake::ok()), world.options()).await;
    let lines = world.lines.all();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].starts_with(&format!("[relay] feedback record unreadable file={name} code=")), "{lines:?}");
    assert!(!lines[0].ends_with("code="));
    assert_eq!(service.submit(&valid(&uid(2))).await.unwrap_err().status, 503);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_file_where_the_directory_belongs_makes_the_storage_unavailable() {
    let world = World::new();
    mixdog_fsio::write(&Unlaned, world.feedback(), "a file where the directory should be").unwrap();
    let service = world.start(Some(&Fake::ok()), world.options()).await;
    let lines = world.lines.all();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].starts_with("[relay] feedback storage unavailable code="), "{lines:?}");
    assert_eq!(service.submit(&valid(&uid(1))).await.unwrap_err().status, 503);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_first_write_answers_503_and_leaves_nothing_acknowledged() {
    let world = World::new();
    let sender = Fake::ok();
    let service = world.start(Some(&sender), world.options()).await;
    service.faults().rename.store(true, Ordering::SeqCst);
    let id = uid(1);
    let body = valid(&id);
    assert_eq!(service.submit(&body).await.unwrap_err().status, 503);
    assert_eq!(service.submit(&body).await.unwrap_err().status, 503, "the retry is not mistaken for a duplicate");
    assert!(world.lines.has(&format!("[relay] feedback persist failed id={id} code=error")));
    assert!(world.names().is_empty(), "the temp file is unlinked");
    settle().await;
    assert_eq!(sender.calls(), 0);
    service.faults().rename.store(false, Ordering::SeqCst);
    service.submit(&body).await.unwrap();
    service.close().await;
}

// ---- attachments ----

#[test]
fn the_attachment_validator_refuses_what_it_refuses_in_node() {
    let ok = ok_attachment();
    assert!(attachments::normalize(None).unwrap().is_empty());
    assert!(attachments::normalize(Some(&json!([]))).unwrap().is_empty());
    let with_extras = with(with(with(ok.clone(), "path", json!("/etc/passwd")), "url", json!("http://x")), "headers", json!({}));
    let kept = attachments::normalize(Some(&json!([with_extras]))).unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].to_value(), ok, "unknown fields are dropped");
    for kind in ["png", "jpeg", "webp"] {
        assert_eq!(attachments::normalize(Some(&json!([attach(&format!("a.{kind}"), kind, 64, 7)]))).unwrap().len(), 1);
    }
    let data = ok["data"].as_str().unwrap().to_owned();
    let not_image = STANDARD.encode(b"not an image at all");
    let bad = [
        json!(null),
        json!("x"),
        json!({}),
        json!([null]),
        json!([[]]),
        json!([{}]),
        json!([with(ok.clone(), "name", json!(null))]),
        json!([with(ok.clone(), "data", json!(5))]),
        json!([with(ok.clone(), "mimeType", json!("image/gif"))]),
        json!([with(ok.clone(), "mimeType", json!("image/svg+xml"))]),
        json!([with(ok.clone(), "name", json!(""))]),
        json!([with(ok.clone(), "name", json!("../x.png"))]),
        json!([with(ok.clone(), "name", json!("a/b.png"))]),
        json!([with(ok.clone(), "name", json!("a\\b.png"))]),
        json!([with(ok.clone(), "name", json!("a\r\nBcc: x.png"))]),
        json!([with(ok.clone(), "name", json!(".hidden.png"))]),
        json!([with(ok.clone(), "name", json!("trailing."))]),
        json!([with(ok.clone(), "name", json!(" x.png"))]),
        json!([with(ok.clone(), "name", json!("x.png\u{a0}"))]),
        json!([with(ok.clone(), "name", json!("x\u{2028}.png"))]),
        json!([with(ok.clone(), "name", json!("x\u{85}.png"))]),
        json!([with(ok.clone(), "name", json!(format!("{}.png", "a".repeat(100))))]),
        json!([with(ok.clone(), "name", json!("C:x.png"))]),
        json!([with(ok.clone(), "name", json!("a*.png"))]),
        json!([with(ok.clone(), "data", json!(format!("data:image/png;base64,{data}")))]),
        json!([with(ok.clone(), "data", json!(format!("{data}\n")))]),
        json!([with(ok.clone(), "data", json!(&data[1..]))]),
        json!([with(ok.clone(), "data", json!(format!("{}*", &data[..data.len() - 1])))]),
        json!([with(ok.clone(), "data", json!(""))]),
        json!([with(ok.clone(), "data", json!(not_image))]),
        json!([with(ok.clone(), "mimeType", json!("image/jpeg"))]),
        json!([with(ok.clone(), "mimeType", json!("image/webp"))]),
        json!([with(ok.clone(), "data", json!(STANDARD.encode(&image("png", 8, 0)[..4])))]),
        json!([ok.clone(), ok.clone(), ok.clone(), ok.clone()]),
        json!([attach("big.png", "png", MAX_BYTES + 1, 0)]),
        json!([with(ok.clone(), "data", json!(STANDARD.encode(image("png", 14, 0)).trim_end_matches('=')))]),
    ];
    for value in bad {
        assert!(attachments::normalize(Some(&value)).is_err(), "{}", value.to_string().chars().take(70).collect::<String>());
    }
    // A name of 99 units is fine; 51 emoji are 102 units.
    assert!(attachments::normalize(Some(&json!([with(ok.clone(), "name", json!(format!("{}.png", "a".repeat(95))))]))).is_ok());
    assert!(attachments::normalize(Some(&json!([with(ok.clone(), "name", json!("\u{1f600}".repeat(51)))]))).is_err());
    // Trailing bits must be zero: the last character of a padded text is canonical or the text is refused.
    let head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5];
    let odd = STANDARD.encode(&head);
    assert!(attachments::normalize(Some(&json!([with(ok.clone(), "data", json!(odd))]))).is_ok());
    let loose = format!("{}B==", &odd[..odd.len() - 3]);
    assert!(attachments::normalize(Some(&json!([with(ok.clone(), "data", json!(loose))]))).is_err());
    let max = attach("max.png", "png", MAX_BYTES, 0);
    assert_eq!(attachments::normalize(Some(&json!([max.clone(), max.clone(), max.clone()]))).unwrap().len(), 3);
    assert!(attachments::normalize(Some(&json!([max.clone(), max.clone(), max, ok]))).is_err());
}

#[tokio::test(start_paused = true)]
async fn invalid_attachments_answer_400_and_store_nothing() {
    let world = World::new();
    let sender = Fake::ok();
    let options = FeedbackOptions { ip_limit: 100, ..world.options() };
    let service = world.start(Some(&sender), options).await;
    let bad = [
        json!("x"),
        json!([{ "name": "a.png", "mimeType": "image/png", "data": "AAAA" }]),
        json!([with(ok_attachment(), "name", json!("../a.png"))]),
        json!([ok_attachment(), ok_attachment(), ok_attachment(), ok_attachment()]),
        json!([attach("big.png", "png", MAX_BYTES + 1, 0)]),
        json!(null),
    ];
    for (n, attachments) in bad.into_iter().enumerate() {
        let error = service.submit(&with(valid(&uid(n as u32 + 1)), "attachments", attachments)).await.unwrap_err();
        assert_eq!((error.status, error.code), (400, "invalid_feedback"));
    }
    assert!(world.names().is_empty());
    let max = attach("max.png", "png", MAX_BYTES, 0);
    let full = with(valid(&uid(20)), "attachments", json!([max.clone(), max.clone(), max]));
    assert!(full.to_string().len() <= mixdog_relay::feedback::MAX_BODY_BYTES);
    service.submit(&full).await.unwrap();
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn attachments_are_persisted_before_acceptance_mailed_and_removed() {
    let world = World::new();
    let sender = Fake::failing("EAUTH");
    let service = world.start(Some(&sender), world.options()).await;
    let id = uid(1);
    let attachments = json!([attach("a.png", "png", 100, 1), attach("b.jpg", "jpeg", 200, 2), attach("c.webp", "webp", 300, 3)]);
    let body = with(with(valid(&id), "attachments", attachments.clone()), "replyTo", json!("who@example.com"));
    service.submit(&body).await.unwrap();
    let stored = world.record(&id);
    assert_eq!(stored["payload"]["attachments"], attachments, "durable before the mail leaves");
    wait_for("the first attempt", || sender.calls() == 1).await;
    // An id retried with the same attachments is the same submission; any other content conflicts.
    service.submit(&body).await.unwrap();
    for other in [
        json!([attach("a.png", "png", 100, 9), attach("b.jpg", "jpeg", 200, 2), attach("c.webp", "webp", 300, 3)]),
        json!([attach("z.png", "png", 100, 1), attach("b.jpg", "jpeg", 200, 2), attach("c.webp", "webp", 300, 3)]),
        json!([]),
    ] {
        assert_eq!(service.submit(&with(body.clone(), "attachments", other)).await.unwrap_err().status, 409);
    }
    let mut without = body.clone();
    without.as_object_mut().unwrap().shift_remove("attachments");
    assert_eq!(service.submit(&without).await.unwrap_err().status, 409);
    sender.set_ok();
    world.clock.advance(30_000).await;
    wait_for("the mail", || sender.delivered() == 1).await;
    let mails = sender.mails();
    let mail = mails.last().unwrap();
    let files: Vec<(&str, &str, Vec<u8>)> = mail.attachments.iter().map(|a| (a.filename.as_str(), a.content_type.as_str(), a.content.clone())).collect();
    assert_eq!(
        files,
        [("a.png", "image/png", image("png", 100, 1)), ("b.jpg", "image/jpeg", image("jpeg", 200, 2)), ("c.webp", "image/webp", image("webp", 300, 3)),]
    );
    assert_eq!(mail.reply_to.as_deref(), Some("who@example.com"));
    wait_for("the sent mark", || world.sent_at(&id) > 0.0).await;
    assert!(world.record(&id).get("payload").is_none(), "the attachments are removed with the payload");
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn an_attachment_free_payload_hashes_as_before() {
    let world = World::new();
    let service = world.start(Some(&Fake::failing("EAUTH")), world.options()).await;
    let id = uid(1);
    service.submit(&with(valid(&id), "attachments", json!([]))).await.unwrap();
    let hash = world.record(&id)["hash"].as_str().unwrap().to_owned();
    assert_eq!(hash, records::sha256_hex(br#"["bug","it broke",""]"#));
    assert!(world.record(&id)["payload"].get("attachments").is_none());
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn legacy_records_without_attachments_load_and_corrupt_attachments_fail_closed() {
    let legacy = |id: &str, payload: Value| {
        json!({ "id": id, "hash": "h", "payload": payload, "createdAt": 1, "attempts": 0, "nextAttemptAt": 0, "sentAt": 0 }).to_string()
    };
    let world = World::new();
    mixdog_fsio::create_dir_all(&Unlaned, world.feedback()).unwrap();
    let id = uid(1);
    let put = |world: &World, id: &str, payload: Value| {
        mixdog_fsio::write(&Unlaned, world.feedback().join(format!("{id}.json")), legacy(id, payload)).unwrap();
    };
    put(&world, &id, json!({ "kind": "bug", "message": "old", "replyTo": "" }));
    let sender = Fake::ok();
    let service = world.start(Some(&sender), world.options()).await;
    wait_for("the legacy mail", || sender.delivered() == 1).await;
    assert_eq!(sender.mails()[0].text, "old");
    assert!(sender.mails()[0].attachments.is_empty());
    assert!(world.lines.all().is_empty());
    service.close().await;

    let bad = World::new();
    mixdog_fsio::create_dir_all(&Unlaned, bad.feedback()).unwrap();
    let id = uid(2);
    put(&bad, &id, json!({ "kind": "bug", "message": "x", "replyTo": "", "attachments": [{ "name": "../x", "mimeType": "image/png", "data": "AAAA" }] }));
    let sender = Fake::ok();
    let service = bad.start(Some(&sender), bad.options()).await;
    settle().await;
    assert_eq!(sender.calls(), 0);
    assert!(bad.lines.has(&format!("[relay] feedback record corrupt file={id}.json")));
    assert_eq!(service.submit(&valid(&uid(3))).await.unwrap_err().status, 503);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn what_the_strict_loader_refuses() {
    let id = uid(1);
    let good = |extra: Value| {
        let mut record = json!({
            "id": id, "hash": "h", "payload": { "kind": "bug", "message": "m", "replyTo": "" },
            "createdAt": 1, "attempts": 0, "nextAttemptAt": 0, "sentAt": 0
        });
        for (key, value) in extra.as_object().unwrap() {
            record[key] = value.clone();
        }
        record
    };
    let refused = [
        good(json!({ "id": uid(2) })),
        good(json!({ "hash": 5 })),
        good(json!({ "createdAt": -1 })),
        good(json!({ "attempts": "0" })),
        good(json!({ "nextAttemptAt": null })),
        good(json!({ "sentAt": "x" })),
        good(json!({ "payload": null })),
        good(json!({ "payload": { "kind": "x", "message": "m", "replyTo": "" } })),
        good(json!({ "payload": { "kind": "bug", "message": 1, "replyTo": "" } })),
        good(json!({ "payload": { "kind": "bug", "message": "m" } })),
        good(json!({ "payload": { "kind": "bug", "message": "m", "replyTo": "", "attachments": null } })),
        json!([]),
        json!(null),
    ];
    for (n, record) in refused.into_iter().enumerate() {
        let world = World::new();
        mixdog_fsio::create_dir_all(&Unlaned, world.feedback()).unwrap();
        mixdog_fsio::write(&Unlaned, world.feedback().join(format!("{id}.json")), record.to_string()).unwrap();
        let service = world.start(Some(&Fake::ok()), world.options()).await;
        assert!(world.lines.has(&format!("[relay] feedback record corrupt file={id}.json")), "case {n}: {record}");
        service.close().await;
    }
    // A sent record needs no payload, and an empty attachments list is a valid record.
    for record in
        [good(json!({ "sentAt": 5, "payload": null })), good(json!({ "payload": { "kind": "bug", "message": "m", "replyTo": "", "attachments": [] } }))]
    {
        let world = World::new();
        mixdog_fsio::create_dir_all(&Unlaned, world.feedback()).unwrap();
        mixdog_fsio::write(&Unlaned, world.feedback().join(format!("{id}.json")), record.to_string()).unwrap();
        let service = world.start(Some(&Fake::ok()), world.options()).await;
        assert!(world.lines.all().is_empty(), "{record}");
        service.close().await;
    }
}
