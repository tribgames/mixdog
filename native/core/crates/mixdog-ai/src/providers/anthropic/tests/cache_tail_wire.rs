//! The cache owner's admission through the real adapter with transport captures: every POST is admitted on the
//! credential it carries at the moment it goes out (a credential replay after a 401, a `max_tokens` replay after a
//! context overflow), rotation away and back reads each account's own proof, and a relayed session transcript with no
//! owner here is not sent.

use std::sync::atomic::{AtomicI64, Ordering};

use mixdog_core_api::domain::cache_tail::{Cold, ColdRequest, TailGateHandle, TailRefusal};

use super::*;

const T0: i64 = 1_700_000_000_000;

/// One POST: the key it carried and the clock when it went out.
struct Sent {
    key: String,
    at: i64,
    gzip: bool,
}

/// Answers each POST with the next scripted reply, keeps what was sent, and may move the clock before answering.
struct Wire {
    replies: Mutex<VecDeque<(u16, String, i64)>>,
    sent: Mutex<Vec<Sent>>,
    clock: Arc<AtomicI64>,
    hold_next_head: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, request: mixdog_core_api::domain::provider::WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        let key = request.headers.iter().find(|h| h.0 == "x-api-key").map(|h| h.1.clone()).unwrap_or_default();
        let gzip = request.headers.iter().any(|h| h.0.eq_ignore_ascii_case("content-encoding"));
        self.sent.lock().unwrap().push(Sent { key, at: self.clock.load(Ordering::SeqCst), gzip });
        let hold = self.hold_next_head.lock().unwrap().take();
        if let Some(entered) = hold {
            let _ = entered.send(());
            return std::future::pending().await;
        }
        let (status, body, advance) = self.replies.lock().unwrap().pop_front().expect("a scripted reply");
        self.clock.fetch_add(advance, Ordering::SeqCst);
        Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Once(Some(body.into_bytes()))) })
    }
}

struct Once(Option<Vec<u8>>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
        self.0.take().map(|b| Ok(b.into()))
    }
}

/// The key the account rotation serves now, and the one a reload after a refusal moves to.
struct Keys {
    current: Mutex<String>,
    next: String,
}

#[async_trait]
impl ApiKeySource for Keys {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok(self.current.lock().unwrap().clone())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        let mut current = self.current.lock().unwrap();
        current.clone_from(&self.next);
        Ok(current.clone())
    }
}

/// A turn that wrote `created` five-minute tokens after reading `read`.
fn written(read: u64, created: u64) -> String {
    let usage = json!({ "input_tokens": 5, "output_tokens": 1, "cache_read_input_tokens": read, "cache_creation_input_tokens": created, "cache_creation": { "ephemeral_5m_input_tokens": created, "ephemeral_1h_input_tokens": 0 } });
    [
        sse("message_start", json!({ "type": "message_start", "message": { "id": "m", "type": "message", "role": "assistant", "model": "claude-x", "content": [], "usage": usage } })),
        sse("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
        sse("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "ok" } })),
        sse("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
        sse("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 1 } })),
        sse("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat()
}

struct Rig {
    adapter: AnthropicAdapter,
    wire: Arc<Wire>,
    keys: Arc<Keys>,
    clock: Arc<AtomicI64>,
    gate: Option<TailGateHandle>,
}

impl Rig {
    fn new(name: &str, gated: bool) -> Self {
        Self::build(name, gated, None)
    }

    /// On the official URL, where large bodies go out compressed: the compressor moves the clock 2 s while `slow` is set,
    /// as a wait for the gzip lane does.
    fn official(name: &str, slow: Arc<std::sync::atomic::AtomicBool>) -> Self {
        Self::build(name, true, Some(slow))
    }

    fn build(name: &str, gated: bool, gzip: Option<Arc<std::sync::atomic::AtomicBool>>) -> Self {
        let clock = Arc::new(AtomicI64::new(T0));
        let wire = Arc::new(Wire { replies: Mutex::default(), sent: Mutex::default(), clock: clock.clone(), hold_next_head: Mutex::default() });
        let keys = Arc::new(Keys { current: Mutex::new("key-a".into()), next: "key-b".into() });
        let mut config = AnthropicConfig::new(Arc::new(|_: &str| Some(ModelCaps { max_output_tokens: Some(4096), ..ModelCaps::default() })));
        // Not the official URL: the bodies go out plain.
        if gzip.is_none() {
            config.base_url = "http://anthropic.test".into();
        }
        let mut adapter = AnthropicAdapter::api_key(config, wire.clone(), keys.clone(), mixdog_rt::testing::tokens().cpu_bulk);
        if let Some(slow) = gzip {
            let moved = clock.clone();
            adapter = adapter.with_compressor(Arc::new(move |raw: Vec<u8>| {
                let (slow, moved) = (slow.clone(), moved.clone());
                Box::pin(async move {
                    if slow.load(Ordering::SeqCst) {
                        moved.fetch_add(2_000, Ordering::SeqCst);
                    }
                    Ok(raw)
                })
            }));
        }
        let gate = gated.then(|| {
            let read = clock.clone();
            crate::cache_tail::Books::default().gate(name, None, crate::cache_tail::GateSettings { clock: Arc::new(move || read.load(Ordering::SeqCst)), auto_clear: Arc::new(|| true), sizing: 1, fresh: true, last_send_at: None })
        });
        Self { adapter, wire, keys, clock, gate }
    }

    fn script(&self, status: u16, body: String, advance_ms: i64) {
        self.wire.replies.lock().unwrap().push_back((status, body, advance_ms));
    }

    /// `turns` answered exchanges and a new question.
    fn request(&self, turns: usize) -> Arc<ModelRequest> {
        let mut messages = Vec::new();
        for n in 0..turns {
            messages.push(Message::new(Role::User, Content::Text(format!("q{n}"))));
            messages.push(Message::new(Role::Assistant, Content::Text(format!("a{n}"))));
        }
        messages.push(Message::new(Role::User, Content::Text(format!("q{turns}"))));
        let options = RequestOptions { tail_gate: self.gate.clone(), ..RequestOptions::default() };
        Arc::new(ModelRequest { model: "claude-x".into(), messages, tools: Vec::new(), options })
    }

    async fn turn(&self, request: Arc<ModelRequest>) -> Result<(), ProviderError> {
        let mut stream = self.adapter.attempt(request).await?;
        for item in drain(stream.as_mut()).await {
            item?;
        }
        Ok(())
    }

    fn sent(&self) -> Vec<(String, i64)> {
        self.wire.sent.lock().unwrap().iter().map(|s| (s.key.clone(), s.at)).collect()
    }

    fn refusal(error: ProviderError) -> TailRefusal {
        error.tail_refusal.unwrap_or_else(|| panic!("a refusal, not {}", error.message))
    }
}

#[tokio::test]
async fn dropping_a_post_before_its_head_settles_the_first_cache_write_without_usage() {
    let rig = Rig::new("cancelled-first-write", true);
    let gate = rig.gate.as_ref().expect("cache owner");
    let (entered, writing) = tokio::sync::oneshot::channel();
    *rig.wire.hold_next_head.lock().unwrap() = Some(entered);
    {
        let send = rig.adapter.attempt(rig.request(0));
        tokio::pin!(send);
        tokio::select! {
            result = writing => result.expect("write reached the transport"),
            _ = &mut send => panic!("the transport has not returned a response head"),
        }
        assert_eq!(gate.0.snapshot().expect("admission was recorded")["sent"], true);
    }
    assert_eq!(gate.0.snapshot().expect("drop settled admission")["sent"], false);
}

/// A 401 on account A replays on the reloaded key B: that POST is admitted on B's route inside the lifetime of the
/// session's last send, so it goes out unchanged and what it wrote is B's entry. Back on A the transcript goes out too.
#[tokio::test]
async fn a_credential_replay_is_admitted_on_its_own_account_and_rotation_back_reads_the_first_accounts_proof() {
    let rig = Rig::new("rotation", true);
    rig.script(200, written(0, 100), 0);
    rig.turn(rig.request(0)).await.expect("the first write");
    rig.clock.fetch_add(10_000, Ordering::SeqCst);
    rig.script(401, json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } }).to_string(), 0);
    rig.script(200, written(0, 150), 0);
    rig.turn(rig.request(1)).await.expect("the replay on B goes out unchanged");
    assert_eq!(rig.sent(), [("key-a".to_owned(), T0), ("key-a".to_owned(), T0 + 10_000), ("key-b".to_owned(), T0 + 10_000)]);
    // The rotation serves A again: its own proof admits the grown transcript inside its lifetime.
    *rig.keys.current.lock().unwrap() = "key-a".into();
    rig.script(200, written(100, 50), 0);
    rig.turn(rig.request(2)).await.expect("sent on A");
    assert_eq!(rig.sent().last(), Some(&("key-a".to_owned(), T0 + 10_000)));
    let book = rig.gate.as_ref().unwrap().0.snapshot().expect("the proof changed the book");
    let routes: std::collections::BTreeSet<&str> = book["receipts"].as_array().unwrap().iter().map(|r| r["route"].as_str().unwrap()).collect();
    assert_eq!(routes.len(), 2, "each account's proof is its own: {routes:?}");
}

/// A `max_tokens` replay after a context overflow is a POST of its own, admitted at its own moment: the overflow
/// answered after A's lifetime ran out, so the replay is not sent and the expiry is known.
#[tokio::test]
async fn an_inner_replay_is_admitted_with_the_clock_of_its_own_post() {
    let rig = Rig::new("replay", true);
    rig.script(200, written(0, 100), 0);
    rig.turn(rig.request(0)).await.expect("the first write");
    rig.clock.store(T0 + 299_000, Ordering::SeqCst);
    let overflow = json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "input length and `max_tokens` exceed context limit: 1000 + 4096 > 8000" } }).to_string();
    rig.script(400, overflow, 2_000);
    let refused = rig.turn(rig.request(1)).await.expect_err("the replay is refused");
    assert!(matches!(Rig::refusal(refused), TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })));
    assert_eq!(rig.sent().len(), 2, "the first write and the refused overflow; the replay never went out");
}

/// A prompt with no owner of its cache anywhere (no session) goes out unjudged.
#[tokio::test]
async fn a_standalone_prompt_with_no_owner_passes() {
    let rig = Rig::new("standalone", false);
    rig.script(200, written(0, 100), 0);
    rig.turn(rig.request(1)).await.expect("a standalone prompt");
    assert_eq!(rig.sent().len(), 1);
}

/// The compressed write and its plain re-send are each admitted at the write itself: the gzip lane's wait comes before
/// the admission (a wait that carries the tail past its lifetime refuses the write that would have gone out cold), and a
/// compressed body refused with 415 after the lifetime ran out leaves the plain re-send unsent.
#[tokio::test]
async fn the_compressed_write_and_its_plain_resend_are_admitted_after_every_wait() {
    let slow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let rig = Rig::official("gzip", slow.clone());
    let big = |turns: usize| {
        let mut request = (*rig.request(turns)).clone();
        request.messages[0] = Message::new(Role::User, Content::Text("x".repeat(20 * 1024)));
        Arc::new(request)
    };
    rig.script(200, written(0, 9000), 0);
    rig.turn(big(0)).await.expect("the first write");
    assert!(rig.wire.sent.lock().unwrap()[0].gzip, "compressed");
    // The compression's wait carries the clock past the lifetime: admitted after it, the write is cold and not sent.
    rig.clock.store(T0 + 299_000, Ordering::SeqCst);
    slow.store(true, Ordering::SeqCst);
    let refused = rig.turn(big(1)).await.expect_err("admitted after the wait");
    assert!(matches!(Rig::refusal(refused), TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })));
    assert_eq!(rig.sent().len(), 1, "nothing went out after the wait");
    // Inside the lifetime the compressed write goes out; refused 415 as the lifetime runs out, the plain re-send is a
    // write of its own, admitted at its own moment: not sent.
    slow.store(false, Ordering::SeqCst);
    rig.clock.store(T0 + 290_000, Ordering::SeqCst);
    rig.script(415, json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "unsupported content encoding" } }).to_string(), 20_000);
    let refused = rig.turn(big(1)).await.expect_err("the plain re-send is refused");
    assert!(matches!(Rig::refusal(refused), TailRefusal::Rebuild(ColdRequest { cold: Cold::Expired, .. })));
    let sent = rig.wire.sent.lock().unwrap().iter().map(|s| s.gzip).collect::<Vec<_>>();
    assert_eq!(sent, [true, true], "the compressed write went out, its plain re-send did not");
}