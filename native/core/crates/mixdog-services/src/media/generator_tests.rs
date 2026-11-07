//! The production generator's dispatch: which adapter a lane runs (told by the first request each
//! makes: the adapters themselves are golden-tested), under which credentials, and as which
//! account. Every request is answered 500, so each adapter stops after its first request.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::accounts::SelectedAccounts;
use super::adapter_http::{JsonPost, PostReply};
use super::antigravity_image::{AntigravityAuth, AntigravitySession};
use super::catalog_fetch::{Auth, CatalogHttp, FetchError, HttpFailure, HttpReply};
use super::codex_image::{CodexAuth, CodexSession};
use super::download::{AdapterError, PublicFetch, PublicResponse};
use super::generator::{GeneratorParts, StudioGenerator};
use super::jobs::{GenerationRequest, MediaGenerator, Reference, ResolvedMedia};
use super::probe::{AccountedProbe, AgentKeys, AgentSettings, FileAccountProbe, ProbeParts, ProviderAuth};
use super::xai::Pacer;

struct Keys;

#[async_trait]
impl AgentKeys for Keys {
    async fn has(&self, _: &str) -> bool {
        true
    }

    async fn get(&self, _: &str) -> Option<String> {
        Some("key".to_owned())
    }
}

struct Settings;

impl AgentSettings for Settings {
    fn providers(&self) -> Value {
        json!({})
    }

    fn developer_enabled(&self, _: &str) -> bool {
        true
    }
}

struct NoCatalog;

#[async_trait]
impl CatalogHttp for NoCatalog {
    async fn get(&self, _: &str, _: &[(String, String)], _: Duration) -> Result<HttpReply, HttpFailure> {
        Err(HttpFailure { message: "offline".to_owned(), timed_out: false })
    }
}

/// The OAuth stores: a bearer for the account file it is asked about, noted.
#[derive(Default)]
struct Stores(Mutex<Vec<Option<PathBuf>>>);

#[async_trait]
impl ProviderAuth for Stores {
    async fn oauth(&self, _: &str, account: Option<&Path>) -> Result<Auth, FetchError> {
        self.0.lock().unwrap().push(account.map(Path::to_owned));
        Ok(Auth { token: "bearer".to_owned(), base_url: "https://api.x.ai/v1".to_owned(), ..Auth::default() })
    }

    async fn provider_rows(&self, _: &str, _: &Auth) -> Result<Value, FetchError> {
        Ok(json!([]))
    }
}

struct NoneSelected;

#[async_trait]
impl SelectedAccounts for NoneSelected {
    async fn selected(&self, _: &str) -> Option<String> {
        None
    }
}

/// Every request answered 500; the addresses asked, in order.
#[derive(Default)]
struct Wire(Mutex<Vec<String>>);

#[async_trait]
impl JsonPost for Wire {
    async fn post(&self, url: &str, _: &[(String, String)], _: &Value, _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.0.lock().unwrap().push(url.to_owned());
        Ok(PostReply { status: 500, headers: Vec::new(), body: String::new() })
    }

    async fn get(&self, url: &str, _: &[(String, String)], _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.0.lock().unwrap().push(url.to_owned());
        Ok(PostReply { status: 500, headers: Vec::new(), body: String::new() })
    }
}

struct NoPublic;

#[async_trait]
impl PublicFetch for NoPublic {
    async fn get(&self, _: &str, _: &[(String, String)], _: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        unreachable!("no download is reached")
    }
}

struct NoWait;

#[async_trait]
impl Pacer for NoWait {
    fn now(&self) -> i64 {
        0
    }

    async fn sleep(&self, _: u64) {}
}

struct Codex;

#[async_trait]
impl CodexSession for Codex {
    async fn auth(&self) -> Result<CodexAuth, AdapterError> {
        Ok(CodexAuth { access_token: "t".to_owned(), account_id: None })
    }

    async fn warm_version(&self) {}

    fn user_agent(&self) -> String {
        "ua".to_owned()
    }

    fn version_header(&self) -> String {
        "1".to_owned()
    }

    fn originator(&self) -> String {
        "o".to_owned()
    }

    fn responses_url(&self) -> String {
        "https://chatgpt.com/backend-api/codex/responses".to_owned()
    }

    fn request_id(&self) -> String {
        "0".repeat(32)
    }

    async fn lookup_reset(&self, _: &CodexAuth, _: &str, _: &CancellationToken) -> Option<i64> {
        None
    }
}

struct Antigravity;

#[async_trait]
impl AntigravitySession for Antigravity {
    async fn auth(&self) -> Result<AntigravityAuth, AdapterError> {
        Ok(AntigravityAuth { token: "t".to_owned(), project_id: "p".to_owned() })
    }

    fn headers(&self) -> Vec<(String, String)> {
        Vec::new()
    }

    fn endpoint(&self) -> String {
        "https://agy.example.test".to_owned()
    }

    fn uuid(&self) -> String {
        "u".to_owned()
    }
}

struct Rig {
    generator: StudioGenerator,
    wire: Arc<Wire>,
    stores: Arc<Stores>,
    codex_files: Arc<Mutex<Vec<Option<PathBuf>>>>,
    data: tempfile::TempDir,
}

fn rig() -> Rig {
    let data = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let stores = Arc::new(Stores::default());
    let probe = Arc::new(FileAccountProbe::new(ProbeParts {
        data_dir: data.path().to_owned(),
        lane: tokens.durability_io,
        now: Arc::new(|| 0),
        env: Arc::new(|_| None),
        keys: Arc::new(Keys),
        settings: Arc::new(Settings),
        provider_auth: stores.clone(),
        http: Arc::new(NoCatalog),
        revision: Arc::new(String::new),
    }));
    let wire = Arc::new(Wire::default());
    let codex_files = Arc::new(Mutex::new(Vec::new()));
    let seen = codex_files.clone();
    let generator = StudioGenerator::new(GeneratorParts {
        data_dir: data.path().to_owned(),
        host: Vec::new(),
        selected: Arc::new(NoneSelected),
        accounts: Arc::new(AccountedProbe(probe.clone())),
        http: wire.clone(),
        public: Arc::new(NoPublic),
        pacer: Arc::new(NoWait),
        probe,
        provider_auth: stores.clone(),
        codex: Arc::new(move |file| {
            seen.lock().unwrap().push(file.map(Path::to_owned));
            Arc::new(Codex)
        }),
        antigravity: Arc::new(|_| Arc::new(Antigravity)),
    });
    Rig { generator, wire, stores, codex_files, data }
}

fn request(lane: &str, kind: &str, model: &str, account: &str) -> GenerationRequest {
    GenerationRequest {
        resolved: ResolvedMedia { kind: kind.into(), lane: lane.into(), model: model.into(), max_references: 1, request_model: None },
        prompt: "a cat".into(),
        options: json!({}),
        references: vec![Reference { base64: "AAAA".into(), mime: "image/png".into() }],
        cancel: CancellationToken::new(),
        account: account.into(),
        session_id: "s".into(),
        source_type: "lead".into(),
        progress: Arc::new(|_| {}),
    }
}

#[tokio::test]
async fn each_lane_runs_its_own_adapter() {
    let cases = [
        ("xai", "image", "grok-imagine-image", "https://api.x.ai/v1/images/edits"),
        ("xai", "video", "grok-imagine-video", "https://api.x.ai/v1/videos/generations"),
        ("grok-oauth", "image", "grok-imagine-image", "https://api.x.ai/v1/images/edits"),
        ("openrouter", "image", "m", "https://openrouter.ai/api/v1/images"),
        ("gemini", "image", "gemini-3-pro-image", "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent"),
        ("gemini", "video", "veo-3.1", "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1:predictLongRunning"),
        ("gemini", "video", "gemini-omni-flash", "https://generativelanguage.googleapis.com/v1beta/interactions"),
        ("openai-oauth", "image", "gpt-image-2", "https://chatgpt.com/backend-api/codex/images/edits"),
        ("antigravity-oauth", "image", "gemini-3-pro-image", "https://agy.example.test/v1internal:streamGenerateContent?alt=sse"),
    ];
    for (lane, kind, model, first) in cases {
        let rig = rig();
        let failure = rig.generator.generate(request(lane, kind, model, "")).await.unwrap_err();
        assert_eq!(rig.wire.0.lock().unwrap().first().map(String::as_str), Some(first), "{lane} {kind} {model}: {}", failure.message);
    }
}

#[tokio::test]
async fn a_lane_without_an_adapter_is_refused() {
    let failure = rig().generator.generate(request("midjourney", "image", "m", "")).await.unwrap_err();
    assert_eq!((failure.message.as_str(), failure.code.as_deref()), ("lane \"midjourney\" has no adapter", Some("MEDIA_LANE_UNKNOWN")));
}

#[tokio::test]
async fn a_pinned_account_is_the_credential_file_of_the_whole_job() {
    // An account id is a UUID (`requireAccountId`); anything else is refused before the job runs.
    const WORK: &str = "3f2a7c1e-9b4d-4e6a-8c10-5d7e2a9b1f44";
    let rig = rig();
    let work = rig.data.path().join("provider-accounts").join("openai-oauth").join(format!("{WORK}.json"));
    rig.generator.generate(request("openai-oauth", "image", "gpt-image-2", WORK)).await.unwrap_err();
    assert_eq!(rig.codex_files.lock().unwrap().first(), Some(&Some(work)));
    // The OAuth stores of the other lanes are asked about the same account's file.
    let grok = rig.data.path().join("provider-accounts").join("grok-oauth").join(format!("{WORK}.json"));
    rig.generator.generate(request("grok-oauth", "image", "grok-imagine-image", WORK)).await.unwrap_err();
    assert_eq!(rig.stores.0.lock().unwrap().first(), Some(&Some(grok)));
    // No pin: the provider's own file.
    let rig = rig_unpinned().await;
    assert_eq!(rig.stores.0.lock().unwrap().first(), Some(&None));
}

async fn rig_unpinned() -> Rig {
    let rig = rig();
    rig.generator.generate(request("grok-oauth", "image", "grok-imagine-image", "")).await.unwrap_err();
    rig
}

#[tokio::test]
async fn an_account_that_is_not_the_providers_is_refused_before_any_request() {
    let rig = rig();
    let failure = rig.generator.generate(request("openai-oauth", "image", "gpt-image-2", "../escape")).await.unwrap_err();
    assert!(failure.code.is_none(), "{}", failure.message);
    assert!(rig.wire.0.lock().unwrap().is_empty());
}