//! The production [`MediaGenerator`]: the lane catalog and credentials of the provider layer
//! behind [`MediaLanes`], and `jobs.mjs` `runAdapter` (which lane runs which adapter, with which
//! credentials) over the adapters of this module. The whole job runs as the pinned account of the
//! lane's provider when it has one: the catalog check, the credentials and the adapter alike.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::to_number_of;
use serde_json::Value;

use super::ledger::LedgerAccounts;
use super::accounts::{ACCOUNT_PROVIDERS, AccountProbe, AccountScope, ScopedLaneSources, SelectedAccounts, media_lane_account_provider};
use super::adapter_http::JsonPost;
use super::antigravity_image::{self, AntigravitySession};
use super::catalog_fetch::{Auth, FetchError};
use super::codex_image::{self, CodexSession};
use super::download::{AdapterError, PublicFetch};
use super::gemini_image;
use super::gemini_video;
use super::image_api::{self, ImageReference};
use super::jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, Reference, ResolvedMedia};
use super::lanes::{LaneError, MediaLanes};
use super::probe::{FileAccountProbe, ProviderAuth};
use super::xai::{self, Pacer};

/// The poll clock in production: wall time and a real wait.
pub struct TokioPacer;

#[async_trait]
impl Pacer for TokioPacer {
    fn now(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
    }

    async fn sleep(&self, ms: u64) {
        mixdog_rt::time::sleep(Duration::from_millis(ms)).await;
    }
}

/// The chat provider's client identity and login for one account (`None`: the provider's own).
pub type CodexSessions = Arc<dyn Fn(Option<&Path>) -> Arc<dyn CodexSession> + Send + Sync>;
pub type AntigravitySessions = Arc<dyn Fn(Option<&Path>) -> Arc<dyn AntigravitySession> + Send + Sync>;

/// What the generator takes from the world.
pub struct GeneratorParts {
    pub data_dir: PathBuf,
    /// The host's credential bindings (`AccountScope::under_host`); empty outside a pristine run.
    pub host: Vec<(String, PathBuf)>,
    pub selected: Arc<dyn SelectedAccounts>,
    pub accounts: Arc<dyn AccountProbe>,
    pub http: Arc<dyn JsonPost>,
    /// `RoutedPublicFetch` (wp-ws).
    pub public: Arc<dyn PublicFetch>,
    pub pacer: Arc<dyn Pacer>,
    pub probe: Arc<FileAccountProbe>,
    pub provider_auth: Arc<dyn ProviderAuth>,
    pub codex: CodexSessions,
    pub antigravity: AntigravitySessions,
}

pub struct StudioGenerator {
    parts: GeneratorParts,
}

impl StudioGenerator {
    pub fn new(parts: GeneratorParts) -> Self {
        Self { parts }
    }

    /// `withProviderAccount(mediaLaneAccountProvider(lane), account, …)`: the scope of a job. A lane
    /// without accounts ignores the pin; an account that is not one of the provider's is refused as
    /// Node refuses it.
    fn scope(&self, lane: &str, account: &str) -> Result<AccountScope, MediaFailure> {
        let base = AccountScope::under_host(self.parts.host.clone());
        let provider = if account.is_empty() { "" } else { media_lane_account_provider(lane) };
        if provider.is_empty() {
            return Ok(base);
        }
        base.with(&self.parts.data_dir, provider, account).map_err(|message| MediaFailure { message, code: None, usage: None })
    }

    fn lanes_in(&self, scope: AccountScope) -> MediaLanes {
        MediaLanes::new(Arc::new(ScopedLaneSources { data_dir: self.parts.data_dir.clone(), scope, selected: self.parts.selected.clone(), probe: self.parts.accounts.clone() }))
    }

    /// The credential file of the lane's provider in `scope`.
    async fn credential_file(&self, scope: &AccountScope, lane: &str) -> Option<PathBuf> {
        match media_lane_account_provider(lane) {
            "" => None,
            provider => scope.auth_path(&self.parts.data_dir, provider, self.parts.selected.as_ref()).await,
        }
    }
}

fn lane_failure(error: LaneError) -> MediaFailure {
    MediaFailure::new(error.message, error.code)
}

fn fetch_failure(error: FetchError) -> MediaFailure {
    MediaFailure { message: error.message, code: error.code, usage: None }
}

fn adapter_failure(error: AdapterError) -> MediaFailure {
    MediaFailure { message: error.message, code: error.code, usage: error.usage }
}

fn images(references: Vec<Reference>) -> Vec<ImageReference> {
    references.into_iter().map(|r| ImageReference { base64: r.base64, mime: r.mime }).collect()
}

/// `Number(a ?? b ?? 0) || fallback`: how many reference images the model takes.
fn max_references(entry: Option<&Value>, spec: &Value, video: bool) -> usize {
    let controls = |v: Option<&Value>| v.and_then(|v| v.get("controls")).and_then(|c| c.get("maxReferences")).filter(|n| !n.is_null()).cloned();
    let declared = controls(entry).or_else(|| controls(Some(spec)));
    let count = to_number_of(declared.as_ref());
    if count.is_nan() || count == 0.0 { if video { 7 } else { 5 } } else { count.max(0.0) as usize }
}

#[async_trait]
impl MediaGenerator for StudioGenerator {
    async fn resolve(&self, lane: &str, kind: &str, model: &str) -> Result<ResolvedMedia, MediaFailure> {
        self.resolve_for(lane, kind, model, "").await
    }

    async fn resolve_for(&self, lane: &str, kind: &str, model: &str, account: &str) -> Result<ResolvedMedia, MediaFailure> {
        let scope = self.scope(lane.trim(), account)?;
        let resolved = self.lanes_in(scope).resolve(lane, kind, model).await.map_err(lane_failure)?;
        let entry = resolved.spec["models"].as_array().and_then(|models| models.iter().find(|m| m["id"].as_str() == Some(resolved.model.as_str())));
        Ok(ResolvedMedia {
            kind: resolved.kind.clone(),
            lane: resolved.lane["id"].as_str().unwrap_or_default().to_owned(),
            model: resolved.model.clone(),
            max_references: max_references(entry, &resolved.spec, resolved.kind == "video"),
            request_model: entry.and_then(|m| m["requestModel"].as_str()).filter(|m| !m.is_empty()).map(str::to_owned),
        })
    }

    async fn lanes(&self) -> Value {
        Value::Array(self.lanes_in(AccountScope::under_host(self.parts.host.clone())).list(None).await)
    }

    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedMedia, MediaFailure> {
        let GenerationRequest { resolved, prompt, options, references, cancel, account, progress, .. } = request;
        let lane = resolved.lane.as_str();
        let scope = self.scope(lane, &account)?;
        let file = self.credential_file(&scope, lane).await;
        let refs = images(references);
        let (model, video) = (resolved.model.as_str(), resolved.kind == "video");
        let (http, public, parts) = (self.parts.http.as_ref(), self.parts.public.as_ref(), &self.parts);
        let on_progress = progress.as_ref();
        match lane {
            "grok-oauth" | "xai" => {
                let auth = self.xai_auth(lane, file.as_deref()).await?;
                if video {
                    let out = xai::generate_video(http, public, parts.pacer.as_ref(), &auth, model, &prompt, &options, &refs, &cancel, on_progress).await.map_err(adapter_failure)?;
                    Ok(GeneratedMedia { bytes: out.bytes, mime: out.mime.to_owned(), revised_prompt: None, duration_seconds: out.duration_seconds.as_f64(), usage: Some(out.usage) })
                } else {
                    let out = xai::generate_image(http, &auth, model, &prompt, &options, &refs, &cancel).await.map_err(adapter_failure)?;
                    Ok(image_result(out))
                }
            }
            "openai-oauth" => {
                let session = (parts.codex)(file.as_deref());
                let wanted = resolved.request_model.as_deref().unwrap_or(model);
                let out = codex_image::generate_image(http, session.as_ref(), wanted, &prompt, &options, &refs, &cancel).await.map_err(adapter_failure)?;
                Ok(GeneratedMedia { bytes: out.bytes, mime: out.mime.to_owned(), revised_prompt: out.revised_prompt, duration_seconds: None, usage: out.usage })
            }
            "openrouter" | "nano-gpt" => {
                let auth = parts.probe.image_api_auth(lane).await.map_err(fetch_failure)?;
                let out = image_api::generate_image(http, public, &auth, lane, model, &prompt, &options, &refs, &cancel).await.map_err(adapter_failure)?;
                Ok(image_result(out))
            }
            "antigravity-oauth" => {
                let session = (parts.antigravity)(file.as_deref());
                let out = antigravity_image::generate_image(http, session.as_ref(), model, &prompt, &options, &refs, &cancel).await.map_err(adapter_failure)?;
                Ok(image_result(out))
            }
            "gemini" => {
                let key = parts.probe.api_key_auth("gemini").await.map_err(fetch_failure)?.token;
                if video {
                    let out = gemini_video::generate_video(http, public, parts.pacer.as_ref(), &key, model, &prompt, &options, &refs, &cancel, on_progress).await.map_err(adapter_failure)?;
                    Ok(GeneratedMedia { bytes: out.bytes, mime: out.mime, revised_prompt: None, duration_seconds: None, usage: out.usage })
                } else {
                    let out = gemini_image::generate_image(http, &key, model, &prompt, &options, &refs, &cancel).await.map_err(adapter_failure)?;
                    Ok(image_result(out))
                }
            }
            other => Err(MediaFailure::new(format!("lane \"{other}\" has no adapter"), "MEDIA_LANE_UNKNOWN")),
        }
    }
}

impl StudioGenerator {
    /// `resolveXaiAuth(lane)`: the API key of `xai`, the signed-in account's bearer of `grok-oauth`.
    async fn xai_auth(&self, lane: &str, file: Option<&Path>) -> Result<Auth, MediaFailure> {
        if lane == "xai" {
            self.parts.probe.api_key_auth("xai").await.map_err(fetch_failure)
        } else {
            self.parts.provider_auth.oauth("grok-oauth", file).await.map_err(fetch_failure)
        }
    }
}

fn image_result(out: image_api::GeneratedImage) -> GeneratedMedia {
    GeneratedMedia { bytes: out.bytes, mime: out.mime, revised_prompt: out.revised_prompt, duration_seconds: None, usage: out.usage }
}

/// `recordMediaUsage`'s account: `ACCOUNT_PROVIDERS.includes(lane) ? currentProviderAccountId(lane) : ''`
/// for the account the job was pinned to (empty: the chat's selection).
pub fn ledger_account_of(data_dir: PathBuf, host: Vec<(String, PathBuf)>, selected: Arc<dyn SelectedAccounts>) -> Arc<dyn LedgerAccounts> {
    Arc::new(LedgerAccountOf { data_dir, host, selected })
}

struct LedgerAccountOf {
    data_dir: PathBuf,
    host: Vec<(String, PathBuf)>,
    selected: Arc<dyn SelectedAccounts>,
}

#[async_trait]
impl LedgerAccounts for LedgerAccountOf {
    async fn account(&self, lane: &str, pinned: &str) -> String {
        if !ACCOUNT_PROVIDERS.contains(&lane) {
            return String::new();
        }
        let base = AccountScope::under_host(self.host.clone());
        let scope = if pinned.is_empty() { base } else { base.with(&self.data_dir, lane, pinned).unwrap_or_default() };
        scope.account_id(lane, self.selected.as_ref()).await
    }
}
