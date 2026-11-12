//! What an attached file becomes in the request body, replayed against Node's table
//! (`fixtures/media-wire/table.json`, recorded by `benchmarks/rust-core/recorders/record-media-wire.mjs`): per provider
//! family and capability combination × attachment kind. Every row runs the core's real send path: the run loop
//! (`Run::run`) over the messages Node was handed, with the stored files in a real blob store, the host's attachment
//! resolver and the host's media layer (`MediaLowering`) in its config, and a provider whose request body is built by
//! the family's real codec from the request the loop hands it (`WireCodec::encode`, which every adapter's `attempt`
//! runs). The managed local model's row runs the text-only route.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_agent::env::{AllowAll, CommitError, Clock, DrainRequest, NoGuards, NullObserver, Rewrite, SteerEntry, SteerSource, Ticket, TranscriptSink};
use mixdog_agent::message::AgentMessage;
use mixdog_agent::run::{Run, RunCarry, RunConfig};
use mixdog_agent::text_only::{TextOnlyInput, TextOnlyModel};
use mixdog_agent::tools::{ToolEnv, ToolSet};
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::{DocumentText, ExtError, PdfIntake, ProfiledImageResizer};
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::{MockApprovalGate, MockCodec, MockFileService, MockProcessManager, MockProgress, MockRetryDecider};
use mixdog_core_api::domain::provider::{
    DeliveryState, MediaSupport, ModelRequest, ModelStream, ProviderAdapter, ProviderError, StopReason, StreamEvent, WireCodec,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::tool::{SurfaceKind, ToolIo};
use mixdog_core_api::ids::{ThreadId, TurnId};
use mixdog_core_domains::domains::ai_admin::model_proxy::StoreAttachments;
use mixdog_protocol::ProviderId;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::media::{AttachmentFacts, MediaLowering, StoredFacts};
use super::message_row::message_of;

/// What the extension host's extraction gave Node for each file of the table, by the file's base64 bytes (the office
/// text by the bytes and the file name): the host's extraction is Node's own code, so the table carries its answers.
struct Extracted {
    pdf: HashMap<String, String>,
    office: HashMap<String, Option<String>>,
}

#[async_trait]
impl DocumentText for Extracted {
    async fn office_text(&self, _: &ThreadId, filename: &str, data: &str) -> Result<Option<String>, ExtError> {
        Ok(self.office.get(&format!("{data}\0{filename}")).expect("an Office file of the table").clone())
    }
    async fn pdf_text(&self, _: &ThreadId, data: &str) -> Result<String, ExtError> {
        Ok(self.pdf.get(data).expect("a PDF of the table").clone())
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("a request lowering counts no PDF pages")
    }
}

struct NoFacts;

#[async_trait]
impl AttachmentFacts for NoFacts {
    async fn facts(&self, _: &str) -> Option<StoredFacts> {
        None
    }
}

struct Zero;

impl Clock for Zero {
    fn now_ms(&self) -> i64 {
        0
    }
}

struct NoSteer;

#[async_trait]
impl SteerSource for NoSteer {
    async fn drain(&self, _: DrainRequest) -> Vec<SteerEntry> {
        Vec::new()
    }
}

struct Kept(std::sync::atomic::AtomicU64);

#[async_trait]
impl TranscriptSink for Kept {
    async fn commit(&self, _: &AgentMessage) -> Result<Ticket, CommitError> {
        Ok(Ticket(self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst)))
    }
    fn replace(&self, _: &[AgentMessage], _: &Rewrite) {}
    fn message_id(&self) -> String {
        format!("m{}", self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
    }
    async fn durable(&self, _: Ticket) {}
}

struct Reply(std::collections::VecDeque<StreamEvent>);

#[async_trait]
impl ModelStream for Reply {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.0.pop_front().map(Ok)
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

/// The request body a family's real codec builds, as the part Node's table records.
type Encode = Box<dyn Fn(&ModelRequest) -> Value + Send + Sync>;

/// A provider of one family: it declares the capabilities of its row and builds its body with the family's codec.
struct Family {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    support: MediaSupport,
    /// The model takes images (`modelRow?.supportsVision` of the Devin row, the local runtime's `takesImages`).
    vision: bool,
    encode: Encode,
    bodies: Mutex<Vec<Value>>,
    /// The Messages wire's image preparation, which every Messages adapter runs before it builds its request.
    images: Option<Arc<dyn ProfiledImageResizer>>,
    /// The messages of the requests the preparation refused (the run loop's recovery sends again without the image).
    refusals: Mutex<Vec<String>>,
}

#[async_trait]
impl ProviderAdapter for Family {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    fn native_pdf(&self) -> bool {
        self.support.native_pdf
    }
    fn native_documents(&self) -> Option<bool> {
        self.support.native_documents
    }
    async fn takes_vision(&self, _: &ModelRequest) -> bool {
        self.vision
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let request = match &self.images {
            Some(resizer) => match mixdog_ai::providers::anthropic::images::prepare_request(request, resizer.as_ref()).await {
                Ok(prepared) => prepared,
                Err(refusal) => {
                    self.refusals.lock().unwrap().push(refusal.message.clone());
                    return Err(refusal);
                }
            },
            None => request,
        };
        self.bodies.lock().unwrap().push((self.encode)(&request));
        Ok(Box::new(Reply(
            [
                StreamEvent::TextDelta("ok".into()),
                StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
            ]
            .into(),
        )))
    }
}

fn wire_body(codec: &dyn WireCodec, request: &ModelRequest) -> Value {
    let wire = codec.encode(request).expect("the codec encodes the request");
    serde_json::from_slice(&wire.body).expect("a JSON body")
}

struct Gemini;

impl mixdog_ai::providers::google::traits::ModelTraits for Gemini {
    fn is_gemini_family(&self, _: &str) -> bool {
        true
    }
    fn thinking(&self, _: &str) -> mixdog_ai::providers::google::traits::ThinkingControl {
        mixdog_ai::providers::google::traits::ThinkingControl::Unspecified
    }
}

struct WireCtx;

impl mixdog_ai::providers::openai::config::WireContext for WireCtx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _: &str, _: &str) -> Option<String> {
        None
    }
}

/// The family's request body builder: its real codec (or, for the Responses wire, the builder the codec calls; for the
/// Cursor run, the builder the adapter calls), whole.
fn encoder(family: &str) -> Encode {
    use mixdog_ai::providers::anthropic::{AnthropicCodec, AnthropicConfig, Flavor};
    use mixdog_ai::providers::compat::chat::{CompatChatCodec, CompatConfig};
    use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
    use mixdog_ai::providers::compat::CompatProfile;
    match family {
        "anthropic-messages" => {
            let codec = AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(Arc::new(|_| None)));
            Box::new(move |r| wire_body(&codec, r))
        }
        "openai-chat" => {
            let profile = CompatProfile::deepseek();
            let codec = CompatChatCodec::new(profile.clone(), CompatConfig::for_profile(&profile));
            Box::new(move |r| wire_body(&codec, r))
        }
        "openai-chat-text-only" => {
            let profile = CompatProfile::plain(mixdog_services::local_provider::catalog::LOCAL_PROVIDER_ID, "http://127.0.0.1/v1", mixdog_ai::providers::compat::profile::CredentialKind::Keyless);
            let codec = CompatChatCodec::new(profile.clone(), CompatConfig::for_profile(&profile));
            Box::new(move |r| wire_body(&codec, r))
        }
        "openai-responses-compat" => {
            let profile = CompatProfile::xai();
            let codec = CompatResponsesCodec::new(profile.clone(), CompatConfig::for_profile(&profile), mixdog_core_api::domain::keepalive::TransportKind::Http1);
            Box::new(move |r| wire_body(&codec, r))
        }
        "openai-responses" => {
            let config = mixdog_ai::providers::openai::config::OpenAiConfig::api_key(false, Arc::new(mixdog_ai::providers::openai::config::NoFacts), Arc::new(WireCtx));
            Box::new(move |r| Value::Object(mixdog_ai::providers::openai::body::build(&config, r).map))
        }
        "gemini" => {
            let codec = mixdog_ai::providers::google::codec::GoogleCodec::gemini("http://127.0.0.1", Arc::new(Gemini));
            Box::new(move |r| wire_body(&codec, r))
        }
        // The run frame the codec writes: `build_run` and the connect envelope of `CursorCodec::encode`, on the model
        // Node's send resolved the name to (no catalog entry: the name, no parameters), in the recorder's conversation.
        "cursor" => Box::new(|r| {
            use mixdog_ai::providers::cursor::request::{build_run, conversation_id, ModelSelection};
            let selection = ModelSelection { model_id: r.model.clone(), parameters: Vec::new(), max_mode: false, pricing_model: None };
            let conversation = conversation_id(CURSOR_SCOPE);
            let run = build_run(r, &selection, &conversation, CURSOR_UUID).expect("the Cursor run builds");
            let mut frame = mixdog_ai::providers::connect::frame::encode(&run.message, 0);
            pin_uuids(&mut frame, &conversation);
            json!({ "frame": base64::engine::general_purpose::STANDARD.encode(&frame) })
        }),
        // The chat request `DevinCodec::encode` frames: `build_chat_request` and its protobuf encoding. The recorder
        // writes the host's OS name as `<os>` (the `metadata.os` field), so the test does the same.
        "devin" => Box::new(|r| {
            use mixdog_ai::providers::devin::request::{build_chat_request, ChatParams};
            use mixdog_ai::providers::devin::session::{request_metadata, Client};
            let provider = ProviderId::from("devin-oauth");
            let mut metadata = request_metadata("k", "j", Client::Cli);
            metadata.os = "<os>".to_owned();
            let chat = build_chat_request(
                r,
                &ChatParams {
                    provider: &provider,
                    model: &r.model,
                    chat_model_uid: &r.model,
                    assignment_jwt: None,
                    row: None,
                    metadata,
                    cascade_id: "cascade",
                    execution_id: "execution",
                },
            );
            json!({ "chatRequest": base64::engine::general_purpose::STANDARD.encode(chat.encode()) })
        }),
        other => panic!("a family of the table: {other}"),
    }
}

/// The session scope of the recorder's Cursor conversation, and the value its `crypto.randomUUID` was pinned to.
const CURSOR_SCOPE: &str = "media-wire";
const CURSOR_UUID: &str = "00000000-0000-4000-8000-000000000000";

fn is_uuid(window: &[u8]) -> bool {
    window.len() == 36
        && window.iter().enumerate().all(|(at, b)| if matches!(at, 8 | 13 | 18 | 23) { *b == b'-' } else { b.is_ascii_hexdigit() })
}

/// Writes `CURSOR_UUID` over every uuid of the frame but the conversation's: the core draws each image's uuid at random,
/// Node's were pinned to that value (manifest: normalised, cursor row).
fn pin_uuids(frame: &mut [u8], conversation: &str) {
    let mut at = 0;
    while at + 36 <= frame.len() {
        if is_uuid(&frame[at..at + 36]) {
            if &frame[at..at + 36] != conversation.as_bytes() {
                frame[at..at + 36].copy_from_slice(CURSOR_UUID.as_bytes());
            }
            at += 36;
        } else {
            at += 1;
        }
    }
}

fn first_difference(core: &Value, node: &Value, at: String) -> Option<String> {
    match (core, node) {
        (Value::Object(x), Value::Object(y)) => x.keys().chain(y.keys()).find_map(|k| match (x.get(k), y.get(k)) {
            (Some(p), Some(q)) => first_difference(p, q, format!("{at}/{k}")),
            (p, q) => Some(format!("{at}/{k}: core {p:?} node {q:?}")),
        }),
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            x.iter().zip(y).enumerate().find_map(|(i, (p, q))| first_difference(p, q, format!("{at}/{i}")))
        }
        _ => (core != node).then(|| format!("{at}: core {core} node {node}")),
    }
}

/// Every row of the table through the run loop: the request body the core sends equals the one Node's family builds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_row_of_nodes_media_table_replays_equal() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/media-wire/table.json");
    let table: Value = serde_json::from_str(&mixdog_testkit::read_string(&path)).expect("the table is JSON");
    let rows = table["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 171, "12 provider rows × 10 attachment kinds, and 10 image kinds on 5 Messages providers, 1 on one");
    // The Messages wire's images are fitted by the extension host's `sharp`: Node's own `resizeImageBuffer`, run by the real worker.
    let tokens = mixdog_rt::testing::tokens();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
    let pool = Arc::new(
        mixdog_exthost::ExtHostPool::new(mixdog_exthost::ExtHostConfig {
            program: "node".into(),
            args: vec![root.join("src").join("ext-host").join("worker.mjs").into_os_string()],
            electron: false,
            workers: 1,
            pending_cap: 64,
            spawn_io: tokens.spawn_io,
            render_browser: mixdog_exthost::RenderBrowserConfig { command: None, profile_root: std::env::temp_dir().join("mixdog-exthost-media-wire"), no_sandbox: false },
        })
        .unwrap(),
    );
    let resizer: Arc<dyn ProfiledImageResizer> = Arc::new(mixdog_exthost::ExtImageCodec::new(pool.clone()));
    let extracted: Arc<dyn DocumentText> = Arc::new(Extracted {
        pdf: table["extraction"]["pdf"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect(),
        office: table["extraction"]["office"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned))).collect(),
    });
    let dir = tempfile::tempdir().unwrap();
    let blobs = mixdog_store::blobs::BlobStore::new(dir.path());
    for data in table["blobs"].as_object().unwrap().values() {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_str().unwrap()).unwrap();
        crate::run_host::fixture_fs::write(blobs.path(&mixdog_store::blobs::digest_of(&bytes)), bytes);
    }
    let store = Arc::new(StoreAttachments { store: blobs, interactive: tokens.interactive_io });
    let thread = ThreadId::from("sess_media".to_owned());
    let mut differences = Vec::new();
    for row in rows {
        let name = format!("{} / {}", row["provider"].as_str().unwrap(), row["kind"].as_str().unwrap());
        let family = row["family"].as_str().unwrap();
        let capabilities = &row["capabilities"];
        let provider = Arc::new(Family {
            id: ProviderId::from(row["provider"].as_str().unwrap()),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            // `providerTakesNativePdf`: only an explicit `false` lowers a PDF to text.
            support: MediaSupport { native_pdf: capabilities["nativePdf"] != json!(false), native_documents: capabilities["nativeDocuments"].as_bool() },
            vision: capabilities["vision"] != json!(false),
            encode: encoder(family),
            bodies: Mutex::new(Vec::new()),
            images: (family == "anthropic-messages").then(|| resizer.clone()),
            refusals: Mutex::new(Vec::new()),
        });
        let lowering = Arc::new(MediaLowering::new(thread.clone(), extracted.clone(), store.clone(), Arc::new(NoFacts), false, provider.id.clone()));
        let transcript: Vec<AgentMessage> = row["messages"].as_array().unwrap().iter().map(|m| message_of(m).unwrap()).collect();
        let env = mixdog_agent::env::RunEnv {
            clock: Arc::new(Zero),
            jitter: Arc::new(crate::run_host::retry::RandomJitter),
            waiter: Arc::new(crate::run_host::retry::TimerWait),
            decider: Arc::new(MockRetryDecider),
            steer: Arc::new(NoSteer),
            observer: Arc::new(NullObserver),
            sink: Arc::new(Kept(std::sync::atomic::AtomicU64::new(0))),
            gate: Arc::new(AllowAll),
            guards: Arc::new(NoGuards),
            compactor: None,
            route: None,
            skills: None,
            hooks: None,
            reuse: None,
            reactions: None,
            tail: None,
            mcp: None,
            side: None,
            step_judge: None,
            artifacts: None,
            images: None,
            failures: None,
        };
        let tool_env = ToolEnv {
            thread_id: thread.clone(),
            turn_id: TurnId::from("r"),
            cwd: AbsPath::new(dir.path().to_path_buf()).unwrap(),
            surface: SurfaceKind::Lead,
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            progress: Arc::new(MockProgress::default()),
            deadline_of: None,
            notify: None,
            review: None,
        };
        let mut config = RunConfig::new(thread.clone(), TurnId::from("r"), row["model"].as_str().unwrap());
        config.compact = None;
        config.attachments = Some(store.clone());
        if family == "openai-chat-text-only" {
            config.text_only = Some(TextOnlyInput { model: TextOnlyModel { name: "Local Model".into(), supports_tools: None }, media: lowering });
        } else {
            config.file_text = Some(lowering);
        }
        let run = Run::new(env, CancellationToken::new(), provider.clone(), ToolSet::new(Vec::new()), tool_env, config, transcript, RunCarry::default())
            .run()
            .await;
        // A request Node refuses (an image it cannot prepare) is refused by the core's preparation with the same message; the
        // run loop then recovers by sending again without the image, which the table does not record.
        if let Some(expected) = row.get("error").and_then(Value::as_str) {
            let refusals = provider.refusals.lock().unwrap().clone();
            if refusals.first().map(String::as_str) != Some(expected) {
                differences.push(format!("{name}: refused with {refusals:?}, Node: {expected}"));
            }
            continue;
        }
        let node = row.get("body").unwrap_or_else(|| panic!("{name}: Node's row has no body: {row}"));
        match run {
            Err(failure) => differences.push(format!("{name}: the run failed: {:?}", failure.error)),
            Ok(_) => {
                let sent = provider.bodies.lock().unwrap().clone();
                match sent.as_slice() {
                    [body] => {
                        differences.extend(first_difference(body, node, String::new()).map(|d| format!("{name}: {d}")));
                    }
                    other => differences.push(format!("{name}: {} requests", other.len())),
                }
            }
        }
    }
    pool.close().await;
    assert!(differences.is_empty(), "{} of {} rows differ:\n{}", differences.len(), rows.len(), differences.join("\n"));
}
