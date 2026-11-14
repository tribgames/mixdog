//! Real implementations of four `TurnPath` inputs over process services:
//!
//! - [`BotRouteStore`]: the hop's `bots` (`BotRoutes`), Node's `agent-store.mjs`
//!   (`readBotRoute`, `readMixyRoute`, `storedBotRoute`). Node reads these through a file-watching
//!   cache on route paths that invalidates on every change; this reads the small `agent.json`
//!   files afresh on each call, on the IO lane, with the same last-good-copy fallback.
//! - [`CatalogCeilings`]: `OutputCeilingSource`, Node's `provider.escalatedMaxTokens(model, opts)`
//!   (`anthropic-max-tokens.mjs` `resolveAnthropicEscalatedMaxTokens`). Only the two Anthropic
//!   providers define it; every other provider answers `null`. The turn's `opts` never carry
//!   `modelMaxOutputTokens` (a gateway adds its own inside the provider), so `model_max` is `None`.
//! - [`CatalogVision`]: `ModelVision`, Node's `pdfReadModes` `seesImages` (`tool-exec/dispatch.mjs`).
//! - the usage sink is [`LedgerSink`](super::accounting_scope::LedgerSink), tested below.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_agent::env::ModelVision;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::providers::custom::reasoning::is_custom_provider_name;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_config::config::{is_store_bot, Config, AGENT_SECTION};
use mixdog_rt::{CancellationToken, InLane, InteractiveIo};
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value};

use mixdog_core_run::run_host::route_chain::{BotRoutes, RouteReadUnavailable};
use super::model_proxy_pc::takes_images;
use super::settings::{OutputCeilingSource, OutputCeilings};

const BOTS_DIR: &str = "bots";
const MIXY_BOT_ID: &str = "mixy";

/// The hop's `bots`: where a bot's own route lives. Every call reads the files afresh on the
/// interactive IO lane, which is what Node's watcher cache amounts to (it invalidates on every
/// change), so there is no cache here.
pub struct BotRouteStore {
    reads: Arc<BotReads>,
    io: InteractiveIo,
}

impl BotRouteStore {
    pub fn new(data_dir: impl Into<PathBuf>, io: InteractiveIo) -> Self {
        Self { reads: Arc::new(BotReads { data_dir: data_dir.into() }), io }
    }

    /// One lane job, a full lane waited out (the read starts a user's or an agent's turn). A lane that cannot run it is
    /// an error, never a store with nothing in it: "no route" would hand the bot's turn to the config's route, a
    /// different model.
    async fn on_lane<T: Send + 'static>(&self, read: impl FnOnce(&BotReads, &InLane<InteractiveIo>) -> T + Send + 'static) -> Result<T, RouteReadUnavailable> {
        let reads = self.reads.clone();
        mixdog_core_base::support::on_lane_wait(self.io, &CancellationToken::new(), move |lane| read(&reads, lane)).await.map_err(|_| RouteReadUnavailable)
    }
}

/// The blocking reads; they only run as the body of a lane job.
struct BotReads {
    data_dir: PathBuf,
}

impl BotReads {
    fn bot_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join(BOTS_DIR).join(id)
    }

    /// The route in a bot folder's `agent.json` when it is complete.
    fn route_in(&self, bot: &str) -> Option<Value> {
        read_object(&self.bot_dir(bot).join("agent.json"))?.get("route").filter(|r| is_complete(r)).cloned()
    }
}

impl BotReads {
    fn bot_route(&self, lane: &InLane<InteractiveIo>, agent_id: &str) -> Option<Option<Value>> {
        is_store_bot(lane, &self.data_dir, agent_id).then(|| self.route_in(agent_id))
    }

    fn stored_bot_route(&self, lane: &InLane<InteractiveIo>, agent_id: &str) -> Option<Value> {
        if self.data_dir.as_os_str().is_empty() {
            return None;
        }
        if agent_id == MIXY_AGENT_ID { self.route_in(MIXY_BOT_ID) } else { self.bot_route(lane, agent_id).flatten() }
    }
}

#[async_trait::async_trait]
impl BotRoutes for BotRouteStore {
    /// `readBotRoute`: `None` when `agent_id` is no store bot, `Some(None)` for a bot without a route.
    async fn bot_route(&self, agent_id: &str) -> Result<Option<Option<Value>>, RouteReadUnavailable> {
        let id = agent_id.to_owned();
        self.on_lane(move |reads, lane| reads.bot_route(lane, &id)).await
    }

    /// `storedBotRoute`: Mixy (runtime id `lead`) reads `bots/mixy`.
    async fn stored_bot_route(&self, agent_id: &str) -> Result<Option<Value>, RouteReadUnavailable> {
        let id = agent_id.to_owned();
        self.on_lane(move |reads, lane| reads.stored_bot_route(lane, &id)).await
    }
}

fn is_complete(route: &Value) -> bool {
    let text = |key: &str| route.get(key).and_then(Value::as_str).is_some_and(|s| !mixdog_js::js_trim(s).is_empty());
    route.is_object() && text("provider") && text("model")
}

/// A JSON object file; a missing or damaged one falls back to its last good copy (`.bak`).
#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
fn read_object(file: &Path) -> Option<Map<String, Value>> {
    let parse = |path: &Path| match mixdog_statefile::parse_json_text(&std::fs::read(path).ok()?) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    };
    let mut backup = file.as_os_str().to_owned();
    backup.push(".bak");
    parse(file).or_else(|| parse(Path::new(&backup)))
}

/// `MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS` when it is a positive number (invalid reads as unset).
fn env_override() -> bool {
    std::env::var("MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS").ok().filter(|raw| !mixdog_js::js_trim(raw).is_empty()).is_some_and(|raw| {
        let n = mixdog_js::string_to_number(&raw);
        n.is_finite() && n > 0.0
    })
}

/// The cap a normal Anthropic request carries (`DEFAULT_SAFETY_CAP`).
const SAFETY_CAP: f64 = 65_536.0;

/// `resolveAnthropicEscalatedMaxTokens` without a gateway value: the declared output limit when it
/// exceeds what a normal request carries, else `None`. An env override is never escalated past.
pub fn escalated_from(declared: Option<f64>, env_override: bool) -> Option<u32> {
    if env_override {
        return None;
    }
    let declared = declared.filter(|d| d.is_finite() && *d > 0.0)?.floor();
    (declared > declared.min(SAFETY_CAP)).then_some(declared as u32)
}

/// `OutputCeilingSource` over the catalog.
pub struct CatalogCeilings {
    catalog: Arc<CatalogService>,
}

impl CatalogCeilings {
    pub fn new(catalog: Arc<CatalogService>) -> Self {
        Self { catalog }
    }

    /// The live roster row's `outputTokens`, then the shared catalog's (`getModelMetadataSync`).
    fn declared(&self, provider: &str, model: &str) -> Option<f64> {
        let valid = |n: f64| (n.is_finite() && n > 0.0).then_some(n);
        let listed = valid(mixdog_js::to_number_of(self.catalog.model_meta(provider, model).get("outputTokens")));
        listed.or_else(|| valid(mixdog_js::to_number_of(self.catalog.sync_meta(model, "anthropic")?.get("outputTokens"))))
    }
}

impl OutputCeilingSource for CatalogCeilings {
    fn ceilings(&self, provider: &str, model: &str, _header: &Header) -> OutputCeilings {
        let escalated = matches!(provider, "anthropic" | "anthropic-oauth")
            .then(|| escalated_from(self.declared(provider, model), env_override()))
            .flatten();
        OutputCeilings { escalated, model_max: None }
    }
}

/// `ModelVision` over the config and the catalog (`pdfReadModes`).
pub struct CatalogVision {
    catalog: Arc<CatalogService>,
    config: Config,
}

impl CatalogVision {
    pub fn new(catalog: Arc<CatalogService>, config: Config) -> Self {
        Self { catalog, config }
    }

    /// `providerModelVisionOverride`: a custom provider's own image-input setting for the model, when it states one.
    /// Read in place from the loaded document: this is asked on every tool call, and `provider_entry` would copy the
    /// whole agent section for it.
    fn vision_override(&self, provider: &str, model: &str) -> Option<bool> {
        if !is_custom_provider_name(provider) {
            return None;
        }
        let doc = self.config.full();
        let entry = doc.get(AGENT_SECTION)?.get("providers")?.get(provider)?;
        entry.get("modelOverrides")?.get(model)?.get("supportsVision")?.as_bool()
    }
}

impl ModelVision for CatalogVision {
    /// `seesImages`: the provider sends image input (`providerReadsImages`) and the model's vision is not off, by its
    /// custom setting, else by the catalog's `supportsVision` (`getModelMetadataSync`); a route with no model has none
    /// to be off.
    fn sees_images(&self, provider: &str, model: &str) -> bool {
        let vision = || self.vision_override(provider, model).or_else(|| self.catalog.sync_meta(model, provider)?.get("supportsVision")?.as_bool());
        takes_images(provider) && (model.is_empty() || vision() != Some(false))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_ai::registry::accounting::{Facts, RecordArgs, UsagePricing, make_usage_record};
    use mixdog_ai::registry::accounting::UsageSink;
    use mixdog_ai::catalog::{CatalogSnapshot, ModelsDevSource, PricedUsage, UsageArgs};
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_ai::transport::http::{HttpResponse, HttpSend};
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
    use mixdog_ledger::writer::UsageWriter;
    use mixdog_ledger::reader::UsageReader;
    use serde_json::json;

    use super::super::accounting_scope::LedgerSink;
    use super::*;

    fn write(path: PathBuf, body: &str) {
        crate::run_host::fixture_fs::write(path, body);
    }

    fn io() -> InteractiveIo {
        mixdog_rt::testing::tokens().interactive_io
    }

    #[tokio::test]
    async fn a_bots_route_lives_in_its_folder_once_the_split_ran() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let store = BotRouteStore::new(data, io());
        write(data.join("bots/botty/agent.json"), r#"{"route":{"provider":"xai","model":"grok-4","fallbacks":[{"provider":"a","model":"b"}]},"x":1}"#);
        // Before the split nobody is a store bot: the config decides.
        assert_eq!(store.bot_route("botty").await.unwrap(), None);
        write(data.join("bots/migration.json"), r#"{"version":1,"bots":["moved"]}"#);
        assert_eq!(store.bot_route("botty").await.unwrap(), Some(Some(json!({"provider":"xai","model":"grok-4","fallbacks":[{"provider":"a","model":"b"}]}))));
        // A bot the split moved but without a folder has no route; an unknown id is no bot.
        assert_eq!(store.bot_route("moved").await.unwrap(), Some(None));
        assert_eq!(store.bot_route("stranger").await.unwrap(), None);
        // A route without a model is not a route.
        write(data.join("bots/half/agent.json"), r#"{"route":{"provider":"xai"}}"#);
        assert_eq!(store.bot_route("half").await.unwrap(), Some(None));
        // Mixy is no ordinary bot; the Lead's runtime id reads Mixy's folder.
        write(data.join("bots/mixy/agent.json"), r#"{"route":{"provider":"openai","model":"gpt-5"}}"#);
        assert_eq!(store.bot_route("mixy").await.unwrap(), None);
        assert_eq!(store.stored_bot_route("lead").await.unwrap(), Some(json!({"provider":"openai","model":"gpt-5"})));
        assert_eq!(store.stored_bot_route("botty").await.unwrap().unwrap()["model"], "grok-4");
        assert_eq!(store.stored_bot_route("stranger").await.unwrap(), None);
    }

    /// Node's watcher cache invalidates on every change, so an edit is seen by the next read.
    #[tokio::test]
    async fn an_edit_is_seen_by_the_next_read() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        write(data.join("bots/migration.json"), r#"{"version":1}"#);
        write(data.join("bots/botty/agent.json"), r#"{"route":{"provider":"p","model":"one"}}"#);
        let store = BotRouteStore::new(data, io());
        assert_eq!(store.stored_bot_route("botty").await.unwrap().unwrap()["model"], "one");
        write(data.join("bots/botty/agent.json"), r#"{"route":{"provider":"p","model":"two"}}"#);
        assert_eq!(store.stored_bot_route("botty").await.unwrap().unwrap()["model"], "two");
    }

    #[tokio::test]
    async fn a_damaged_agent_json_reads_from_its_last_good_copy() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        write(data.join("bots/migration.json"), r#"{"version":1}"#);
        write(data.join("bots/botty/agent.json"), "{ not json");
        write(data.join("bots/botty/agent.json.bak"), r#"{"route":{"provider":"p","model":"m"}}"#);
        assert_eq!(BotRouteStore::new(data, io()).bot_route("botty").await.unwrap(), Some(Some(json!({"provider":"p","model":"m"}))));
    }

    #[tokio::test]
    async fn no_data_dir_means_no_bots() {
        let store = BotRouteStore::new("", io());
        assert_eq!((store.bot_route("botty").await.unwrap(), store.stored_bot_route("lead").await.unwrap()), (None, None));
    }

    #[test]
    fn an_escalation_exists_only_above_the_normal_cap() {
        // `resolveAnthropicEscalatedMaxTokens`: the declared limit when it exceeds min(declared, 65536).
        assert_eq!(escalated_from(Some(128_000.0), false), Some(128_000));
        assert_eq!(escalated_from(Some(65_536.0), false), None);
        assert_eq!(escalated_from(Some(32_000.0), false), None);
        assert_eq!(escalated_from(Some(128_000.9), false), Some(128_000));
        assert_eq!(escalated_from(None, false), None);
        assert_eq!(escalated_from(Some(0.0), false), None);
        assert_eq!(escalated_from(Some(f64::NAN), false), None);
        // The user's own env ceiling is never escalated past.
        assert_eq!(escalated_from(Some(128_000.0), true), None);
    }

    struct Offline;

    #[async_trait::async_trait]
    impl HttpSend for Offline {
        async fn send(
            &self,
            _: WireRequest,
            _exchange: mixdog_ai::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            Err(ProviderError::new(
                ErrorKind::Transient,
                DeliveryState::NotSent,
            ))
        }
    }

    #[tokio::test]
    async fn only_the_anthropic_providers_define_an_escalation() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
        let ceilings = CatalogCeilings::new(catalog);
        let header = Header::default();
        // An empty catalog declares nothing: no escalation, whatever the provider.
        for provider in ["anthropic", "anthropic-oauth", "openai"] {
            assert_eq!(ceilings.ceilings(provider, "claude-opus-5", &header), OutputCeilings::default());
        }
    }

    /// `pdfReadModes`' `seesImages`: the text-only local runtime sees no images, a custom model's own image-input setting
    /// decides for it, and a model nothing says is blind sees them.
    #[tokio::test]
    async fn a_model_sees_images_unless_its_provider_or_its_own_setting_says_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let path = dir.path().join("mixdog-config.json");
        let overrides = json!({ "blind": { "supportsVision": false }, "sighted": { "supportsVision": true } });
        write(path.clone(), &json!({ "agent": { "providers": { "custom-box": { "modelOverrides": overrides } } } }).to_string());
        let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(path, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
        let vision = CatalogVision::new(catalog, config);
        assert!(!vision.sees_images("mixdog-local", "local-model-x"));
        assert!(!vision.sees_images("custom-box", "blind"));
        assert!(vision.sees_images("custom-box", "sighted"));
        assert!(vision.sees_images("custom-box", "unstated-model-x"));
        assert!(vision.sees_images("openai", "undescribed-model-x"));
        assert!(vision.sees_images("openai", ""));
    }

    struct Unpriced;
    impl UsagePricing for Unpriced {
        fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
            PricedUsage { input: args.input_tokens, cost_usd: None, rates: Map::new() }
        }
    }

    #[tokio::test]
    async fn a_sends_usage_row_lands_in_the_ledger_as_the_record_it_is() {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.sqlite");
        let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
        let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
        let args = RecordArgs {
            ts: 1_800_000_000_000,
            provider: "anthropic".into(),
            model: "claude-opus-5".into(),
            requested_model: "claude-opus-5".into(),
            requested_provider: "anthropic".into(),
            status: "completed".into(),
            attempts: 1.0,
            ttft_ms: Some(120.0),
            elapsed_ms: 0.0,
            pricing_model: None,
            session_id: Some("s1".into()),
            owner_session_id: None,
            source_type: "user".into(),
            facts: Facts {
                input_tokens: Some(10.0),
                input_tokens_known: Some(true),
                output_tokens: 5.0,
                cached_tokens: 1.0,
                cache_write_tokens: 2.0,
                cache_write_1h_tokens: 0.0,
                cost_usd: None,
                raw_service_tier: None,
            },
            input_tokens_inclusive: false,
            media: None,
            service_tier: None,
            request_service_tier: None,
            response_id: String::new(),
            account: String::new(),
            duration_ms: 900.0,
            origin: None,
            id: Some("row-1".into()),
        };
        let row = make_usage_record(&args, &Unpriced, &|| "unused".to_owned()).unwrap();
        let sink = LedgerSink(writer.clone());
        sink.record_queued(row.clone()).await.unwrap();
        // A repeated id is not an error.
        sink.record_queued(row).await.unwrap();
        writer.settle_writes().await.unwrap();
        let usage = reader.session_usage(vec!["s1".into()], vec![]).await.unwrap().to_string();
        assert!(usage.contains("\"turns\":1"), "{usage}");
    }
}
