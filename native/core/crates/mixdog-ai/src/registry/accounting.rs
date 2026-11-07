//! The usage write of one provider send (`accountProviderSend` in
//! `usage-accounting.mjs`, `makeUsageRecord` in `usage-ledger.mjs`): every
//! send's outcome becomes one ledger row. A completed send records its usage;
//! a cancelled or failed one records what the provider reported before it
//! ended (`ProviderError::partial_usage`, or the last usage the stream showed),
//! and a failure that reported nothing is still a request with zero tokens.
//! Attempts the broker retried and abandoned are billed too: each is its own
//! row under `<requestId>:abandoned:<index>`.
//!
//! The ledger and the price table stay behind two narrow traits so this crate
//! does not depend on `mixdog-ledger`: [`UsageSink`] takes the finished row,
//! [`UsagePricing`] prices it. The send settles only once its rows are durable.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Usage;
use mixdog_js::slice_utf16;
use serde::Serialize;
use serde::Serializer;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::accounted::AccountOf;
use crate::accounts::ACCOUNT_PROVIDERS;
use crate::catalog::PricedUsage;
use crate::catalog::PricingCatalog;
use crate::catalog::UsageArgs;
use crate::service::admin_route::jnum;

/// The cost source of a failure that reported no usage: the request log lists
/// it, but statistics and quota totals add no turn for it.
pub const NO_USAGE_COST_SOURCE: &str = "none";

/// Providers whose answering stream's generation window starts when generation
/// does; any other may reason before its first streamed token, so it records no
/// first-output time.
const TIMED_PROVIDERS: [&str; 5] = ["anthropic", "anthropic-oauth", "openai", "openai-oauth", "mixdog-local"];

/// Prices a usage (`priceUsage`).
pub trait UsagePricing: Send + Sync {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage;
}

impl UsagePricing for PricingCatalog {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        PricingCatalog::price_usage(self, args)
    }
}

/// The ledger's queue (`recordQueued`): resolves once the row is durable. A
/// repeated id is not an error. The composition adapts `mixdog_ledger`'s writer;
/// [`UsageRow`] deserializes as the ledger's `UsageRecord`.
#[async_trait]
pub trait UsageSink: Send + Sync {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String>;
}

fn int_or_float<S: Serializer>(value: &f64, out: S) -> Result<S::Ok, S::Error> {
    jnum(*value).serialize(out)
}

fn opt_int_or_float<S: Serializer>(value: &Option<f64>, out: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => jnum(*value).serialize(out),
        None => out.serialize_none(),
    }
}

/// A finished usage record, as `makeUsageRecord` produces it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub ts: i64,
    pub day: String,
    pub provider: String,
    pub model: String,
    pub kind: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_session_id: Option<String>,
    pub source_type: String,
    #[serde(serialize_with = "int_or_float")]
    pub input: f64,
    #[serde(serialize_with = "int_or_float")]
    pub output: f64,
    #[serde(serialize_with = "int_or_float")]
    pub cache_read: f64,
    #[serde(serialize_with = "int_or_float")]
    pub cache_write: f64,
    #[serde(serialize_with = "opt_int_or_float")]
    pub cost_usd: Option<f64>,
    pub cost_source: String,
    /// The price snapshot, serialized once (its field order is part of the route signature).
    pub rates: Option<String>,
    pub response_id: String,
    pub account: String,
    pub origin: String,
    #[serde(serialize_with = "int_or_float")]
    pub duration_ms: f64,
    pub requested_model: String,
    pub requested_provider: String,
    pub status: String,
    pub attempts: u32,
    #[serde(serialize_with = "opt_int_or_float")]
    pub ttft_ms: Option<f64>,
    #[serde(serialize_with = "int_or_float")]
    pub elapsed_ms: f64,
    pub id: String,
}

/// What a usage object says (`usage.inputTokens` and friends); `input_tokens`
/// is `None` when the input was not measured.
#[derive(Clone, Debug, PartialEq)]
pub struct Facts {
    pub input_tokens: Option<f64>,
    pub input_tokens_known: Option<bool>,
    pub output_tokens: f64,
    pub cached_tokens: f64,
    pub cache_write_tokens: f64,
    pub cache_write_1h_tokens: f64,
    pub cost_usd: Option<f64>,
    pub raw_service_tier: Option<String>,
}

impl Facts {
    /// A completed call that reported no usage: unknown input, unpriced.
    pub const UNMEASURED: Facts = Facts {
        input_tokens: None,
        input_tokens_known: Some(false),
        output_tokens: 0.0,
        cached_tokens: 0.0,
        cache_write_tokens: 0.0,
        cache_write_1h_tokens: 0.0,
        cost_usd: None,
        raw_service_tier: None,
    };
    /// A failure that reported nothing: zero tokens, zero cost.
    pub const FAILED: Facts = Facts {
        input_tokens: Some(0.0),
        input_tokens_known: None,
        output_tokens: 0.0,
        cached_tokens: 0.0,
        cache_write_tokens: 0.0,
        cache_write_1h_tokens: 0.0,
        cost_usd: Some(0.0),
        raw_service_tier: None,
    };

    /// Tokens, or a provider-reported cost (a cost-only report is still a billed request).
    pub fn recordable(&self) -> bool {
        let tokens = [self.input_tokens.unwrap_or(0.0), self.output_tokens, self.cached_tokens, self.cache_write_tokens];
        tokens.iter().any(|t| *t > 0.0) || self.cost_usd.is_some_and(|cost| cost.is_finite() && cost >= 0.0)
    }
}

impl From<&Usage> for Facts {
    fn from(usage: &Usage) -> Self {
        Facts {
            input_tokens: Some(usage.input_tokens as f64),
            input_tokens_known: None,
            output_tokens: usage.output_tokens as f64,
            cached_tokens: usage.cache_read_tokens as f64,
            cache_write_tokens: usage.cache_write_tokens as f64,
            cache_write_1h_tokens: usage.cache_write_1h_tokens as f64,
            cost_usd: usage.cost.map(|ticks| ticks.0 as f64 / 10_000_000_000.0),
            raw_service_tier: usage
                .raw
                .as_ref()
                .and_then(|raw| raw.get("service_tier"))
                .filter(|tier| crate::service::admin_route::truthy(Some(tier)))
                .map(mixdog_js::value_to_string),
        }
    }
}

/// The accounting identity of one send.
#[derive(Clone, Debug)]
pub struct SendIdentity {
    pub provider: String,
    /// The model the send was asked for.
    pub model: String,
    /// The route the user asked for: the primary one on a route-fallback hop.
    pub requested_provider: String,
    pub requested_model: String,
    pub route_hop: bool,
    pub session_id: Option<String>,
    pub owner_session_id: Option<String>,
    pub source_type: String,
    pub input_tokens_inclusive: bool,
    /// The tier the last wire attempt sent.
    pub request_service_tier: String,
    /// The account when the send has no roster attached ([`SendAccounting::with_account`]), which
    /// reads it for every row written instead; the error text is what Node's read throws inside the
    /// row's write, failing every row of the send.
    pub account: Result<String, String>,
    pub request_id: String,
    pub started_at: i64,
}

/// An attempt the provider billed and the broker retried.
#[derive(Clone, Debug)]
pub struct Abandoned {
    pub facts: Facts,
    pub model: Option<String>,
}

/// What a completed send produced.
#[derive(Clone, Debug, Default)]
pub struct Completed {
    pub facts: Option<Facts>,
    pub model: Option<String>,
    pub response_id: Option<String>,
    pub pricing_model: Option<String>,
    pub service_tier: Option<String>,
    pub request_service_tier: Option<String>,
    /// The answer came from a fallback model (`anthropicFallbacks`).
    pub fallback: bool,
    /// Generation start within the stream, for the first-output time.
    pub generation_ms: Option<f64>,
    /// When the stream returned.
    pub stream_ended_at: i64,
}

/// How a send ended.
pub enum Outcome<'a> {
    Completed(Completed),
    /// The user cancelled; `reported` is the last usage the stream showed.
    Cancelled { reported: Option<Facts> },
    Failed(&'a ProviderError),
}

/// `usageRouteKind`.
fn route_kind(provider: &str) -> &'static str {
    if provider == "mixdog-local" {
        "local"
    } else if provider.ends_with("-oauth") {
        "oauth"
    } else {
        "api"
    }
}

fn text(value: &str) -> String {
    slice_utf16(value, 300)
}

fn pos(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 { value } else { 0.0 }
}

/// `{ requestedModel, pricingModel }` of the priced rates, as Node reads them.
fn rate_field(rates: &serde_json::Map<String, Value>, key: &str) -> Option<Value> {
    rates.get(key).cloned()
}

fn day_key(ts: i64) -> String {
    match mixdog_js::time::local_fields(ts as f64) {
        Some(f) => format!("{:04}-{:02}-{:02}", f.year, f.month, f.day),
        None => String::new(),
    }
}

fn record_id(row: &UsageRow) -> String {
    let identity = if row.response_id.is_empty() {
        json!(["record", row.ts, row.provider, row.model, row.session_id, jnum(row.input), jnum(row.output), jnum(row.cache_read), jnum(row.cache_write)])
    } else {
        json!(["response", row.provider, row.model, row.response_id])
    };
    Sha256::digest(mixdog_js::json_stringify(&identity).as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A random version-4 UUID (`randomUUID`).
pub fn random_uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// The arguments of `makeUsageRecord` that an accounted send passes.
#[derive(Clone, Debug)]
pub struct RecordArgs {
    pub ts: i64,
    pub provider: String,
    pub model: String,
    pub requested_model: String,
    pub requested_provider: String,
    pub status: String,
    pub attempts: f64,
    pub ttft_ms: Option<f64>,
    pub elapsed_ms: f64,
    pub pricing_model: Option<String>,
    pub session_id: Option<String>,
    pub owner_session_id: Option<String>,
    pub source_type: String,
    pub facts: Facts,
    pub input_tokens_inclusive: bool,
    /// Media billed outside the text token slots (images, video seconds): priced from the catalog.
    pub media: Option<crate::catalog::Media>,
    pub service_tier: Option<String>,
    pub request_service_tier: Option<String>,
    pub response_id: String,
    pub account: String,
    pub duration_ms: f64,
    /// `None` is a live record.
    pub origin: Option<String>,
    pub id: Option<String>,
}

const STORED_STATUSES: [&str; 5] = ["completed", "retried", "substituted", "failed", "cancelled"];

/// `makeUsageRecord(args)`. `new_id` makes the random id of a live record.
pub fn make_usage_record(
    args: &RecordArgs,
    pricing: &dyn UsagePricing,
    new_id: &dyn Fn() -> String,
) -> Result<UsageRow, String> {
    let provider = text(&args.provider);
    let model = text(&args.model);
    let requested_model = text(&args.requested_model);
    let requested_provider = text(&args.requested_provider);
    if provider.is_empty() || model.is_empty() {
        return Err("Usage requires a provider and model".into());
    }
    if args.ts <= 0 {
        return Err("Usage requires a valid timestamp".into());
    }
    let kind = route_kind(&provider);
    let facts = &args.facts;
    let priced = pricing.price_usage(&UsageArgs {
        provider: provider.clone(),
        model: model.clone(),
        requested_model: Some(requested_model.clone()).filter(|m| !m.is_empty()),
        pricing_model: args.pricing_model.clone(),
        input_tokens: facts.input_tokens.unwrap_or(0.0),
        input_tokens_inclusive: Some(args.input_tokens_inclusive),
        input_tokens_known: facts.input_tokens_known,
        output_tokens: facts.output_tokens,
        cache_read_tokens: facts.cached_tokens,
        cache_write_tokens: facts.cache_write_tokens,
        cache_write_1h_tokens: facts.cache_write_1h_tokens,
        request_service_tier: args.request_service_tier.clone(),
        service_tier: args.service_tier.clone(),
        kind: Some(kind.to_owned()),
        ts: Some(args.ts as f64),
        media: args.media.clone(),
        ..UsageArgs::default()
    });
    let supplied = facts.cost_usd.filter(|cost| cost.is_finite() && *cost >= 0.0);
    // OAuth/quota plans have value, not per-request invoices.
    let subscription = kind == "oauth";
    let reported = facts.input_tokens_known != Some(false) && !subscription && kind != "local" && supplied.is_some();
    let no_tokens = priced.input == 0.0
        && pos(facts.output_tokens) == 0.0
        && pos(facts.cached_tokens) == 0.0
        && pos(facts.cache_write_tokens) == 0.0;
    let failed_empty = args.status == "failed" && facts.input_tokens_known != Some(false) && no_tokens;
    let mut cost_usd = priced.cost_usd;
    if kind == "local" {
        cost_usd = Some(0.0);
    } else if reported {
        cost_usd = supplied;
    } else if cost_usd.is_none() && failed_empty {
        // A request that measured no tokens at all cost nothing, priced model or not.
        cost_usd = Some(0.0);
    }
    let no_usage = failed_empty && !cost_usd.is_some_and(|cost| cost != 0.0 && !cost.is_nan());
    let rates_obj = if reported || kind == "local" {
        let mut own = serde_json::Map::new();
        own.insert("requestedModel".into(), rate_field(&priced.rates, "requestedModel").unwrap_or(Value::Null));
        own.insert("pricingModel".into(), rate_field(&priced.rates, "pricingModel").unwrap_or(Value::Null));
        for key in ["requestServiceTier", "serviceTier"] {
            if let Some(tier) = rate_field(&priced.rates, key).filter(|t| crate::service::admin_route::truthy(Some(t))) {
                own.insert(key.into(), tier);
            }
        }
        own.insert("pricingProvider".into(), json!(provider));
        own.insert("pricingSource".into(), json!(if kind == "local" { "local" } else { "provider" }));
        own
    } else {
        priced.rates.clone()
    };
    let cost_source = if no_usage {
        NO_USAGE_COST_SOURCE
    } else if kind == "local" {
        "local"
    } else if cost_usd.is_none() {
        "unpriced"
    } else if subscription {
        "subscription"
    } else if reported {
        "provider"
    } else {
        "catalog"
    };
    let session_id = match args.session_id.as_deref() {
        Some("no-session" | "(none)") | None => String::new(),
        Some(id) => text(id),
    };
    let origin = args.origin.clone().filter(|o| !o.is_empty()).unwrap_or_else(|| "live".into());
    let response_id = text(&args.response_id);
    let mut row = UsageRow {
        ts: args.ts,
        day: day_key(args.ts),
        provider: provider.clone(),
        model: model.clone(),
        kind: kind.to_owned(),
        session_id,
        owner_session_id: args.owner_session_id.as_deref().filter(|id| !id.is_empty()).map(text),
        source_type: text(&args.source_type),
        input: priced.input,
        output: pos(facts.output_tokens),
        cache_read: pos(facts.cached_tokens),
        cache_write: pos(facts.cache_write_tokens),
        cost_usd,
        cost_source: cost_source.to_owned(),
        rates: Some(mixdog_js::json_stringify(&Value::Object(rates_obj))),
        response_id,
        account: text(&args.account),
        origin,
        duration_ms: pos(args.duration_ms),
        requested_model: if requested_model != model { requested_model } else { String::new() },
        requested_provider: if requested_provider != provider { requested_provider } else { String::new() },
        status: if STORED_STATUSES.contains(&args.status.as_str()) { args.status.clone() } else { "completed".into() },
        attempts: (pos(args.attempts).floor() as u32).max(1),
        ttft_ms: args.ttft_ms.filter(|ms| ms.is_finite()).map(|ms| ms.max(0.0)),
        elapsed_ms: pos(args.elapsed_ms),
        id: String::new(),
    };
    row.id = match &args.id {
        Some(id) if !id.is_empty() => id.clone(),
        _ if row.origin == "live" && row.response_id.is_empty() => new_id(),
        _ => record_id(&row),
    };
    Ok(row)
}

/// These providers echo the requested id instead of reporting the model that
/// served, so a difference there would only be our own id mapping.
fn never_reports_served_model(provider: &str) -> bool {
    ["gemini", "vertex", "antigravity"].iter().any(|prefix| provider.starts_with(prefix))
}

/// The model id with only what provably names the same model removed: a
/// `vendor/` route prefix, a `[…]` context-window tag, a release-date snapshot
/// and `-latest`.
pub fn normalize_served_model_id(model: &str) -> String {
    use std::sync::OnceLock;
    static TAG: OnceLock<mixdog_js::JsRegex> = OnceLock::new();
    static SUFFIX: OnceLock<mixdog_js::JsRegex> = OnceLock::new();
    let tag = TAG.get_or_init(|| mixdog_js::JsRegex::new_static(r"\[[^\]]*\]$", ""));
    let suffix = SUFFIX.get_or_init(|| mixdog_js::JsRegex::new_static(r"(?:-\d{8}|-\d{4}-\d{2}-\d{2}|@\d{8}|-latest)$", ""));
    let mut id = mixdog_js::js_trim(model).to_owned();
    if let Some(found) = tag.find(&id) {
        id.truncate(found.start);
    }
    id = id.rsplit('/').next().unwrap_or_default().to_owned();
    loop {
        match suffix.find(&id) {
            Some(found) => id.truncate(found.start),
            None => return id,
        }
    }
}

/// Whether the model that answered is not the model asked for.
pub fn served_model_substituted(provider: &str, requested: &str, served: &str, fallback: bool) -> bool {
    if never_reports_served_model(provider) {
        return false;
    }
    if fallback {
        return true;
    }
    if requested.is_empty() || served.is_empty() {
        return false;
    }
    let (requested, served) = (normalize_served_model_id(requested), normalize_served_model_id(served));
    !(requested == "auto" || served == requested)
}

/// A request's one-word outcome. Precedence: failed > substituted > retried > completed.
pub fn usage_request_status(failed: bool, substituted: bool, attempts: u32) -> &'static str {
    if failed {
        "failed"
    } else if substituted {
        "substituted"
    } else if attempts > 1 {
        "retried"
    } else {
        "completed"
    }
}

/// The first-output time within the request, when its provider is timed.
fn first_output_ms(provider: &str, generation_ms: Option<f64>, stream_ms: f64) -> Option<f64> {
    let generation = generation_ms.filter(|g| g.is_finite())?;
    (TIMED_PROVIDERS.contains(&provider) && generation >= 0.0 && generation <= stream_ms).then(|| stream_ms - generation)
}

#[cfg(test)]
mod tests;

/// One send's accounting: collects the attempts the broker abandoned and
/// writes the rows when the send ends.
pub struct SendAccounting {
    identity: SendIdentity,
    pricing: Arc<dyn UsagePricing>,
    sink: Option<Arc<dyn UsageSink>>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    new_id: Arc<dyn Fn() -> String + Send + Sync>,
    /// Read for every row written (`usage-accounting.mjs:161`), not once for the send.
    account: Option<Arc<dyn AccountOf>>,
    abandoned: Vec<Abandoned>,
}

/// What recording did: the last write failure, if any (`usageAccountingError`).
/// A failed write is logged and never replaces the send's own result or error.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recorded {
    pub error: Option<String>,
    /// The completed request's wall time, as the ledger row's `duration_ms`
    /// measures it (Node stamps it on the result as `usageDurationMs`): `Some`
    /// only when a completed row was timed, i.e. a ledger was attached. The
    /// owner puts it on the send's terminal `StreamEvent::Completed.request_ms`.
    pub request_ms: Option<u64>,
}

struct Row<'a> {
    id: String,
    facts: Option<Facts>,
    model: Option<String>,
    completed: Option<&'a Completed>,
    timed: bool,
    outcome: Option<RowOutcome>,
}

#[derive(Clone, Copy)]
enum RowOutcome {
    Cancelled { attempts: u32 },
    Failed { attempts: u32 },
    Completed { attempts: u32 },
}

impl SendAccounting {
    /// `sink` is `None` while no ledger is open: nothing is recorded.
    pub fn new(identity: SendIdentity, pricing: Arc<dyn UsagePricing>, sink: Option<Arc<dyn UsageSink>>) -> Self {
        Self {
            identity,
            pricing,
            sink,
            now: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as i64)
            }),
            new_id: Arc::new(random_uuid),
            account: None,
            abandoned: Vec::new(),
        }
    }

    /// The roster each row's account is read from.
    pub fn with_account(mut self, account: Arc<dyn AccountOf>) -> Self {
        self.account = Some(account);
        self
    }

    /// Replaces the clock and the random id source (tests).
    pub fn with_sources(
        mut self,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
        new_id: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        self.now = now;
        self.new_id = new_id;
        self
    }

    /// A provider-local retry abandoned an attempt the provider still billed
    /// (`noteAbandonedUsage`): the enclosing send records it with its own row.
    pub fn note_abandoned(&mut self, usage: &Usage, model: Option<String>) {
        self.abandoned.push(Abandoned { facts: Facts::from(usage), model });
    }

    async fn save(&self, row: Row<'_>, recorded: &mut Recorded) {
        let Some(sink) = &self.sink else { return };
        let identity = &self.identity;
        let completed = row.completed;
        let now = (self.now)();
        let facts = row.facts.unwrap_or(Facts::UNMEASURED);
        let served_model = row.model.filter(|m| !m.is_empty()).unwrap_or_else(|| identity.model.clone());
        let attempts = match row.outcome {
            Some(RowOutcome::Cancelled { attempts } | RowOutcome::Failed { attempts } | RowOutcome::Completed { attempts }) => attempts,
            None => 1,
        };
        let status = match row.outcome {
            None => "completed".to_owned(),
            Some(RowOutcome::Cancelled { .. }) => "cancelled".to_owned(),
            Some(_) => {
                let failed = matches!(row.outcome, Some(RowOutcome::Failed { .. }));
                let substituted = identity.route_hop
                    || served_model_substituted(
                        &identity.provider,
                        &identity.requested_model,
                        &served_model,
                        completed.is_some_and(|c| c.fallback),
                    );
                usage_request_status(failed, substituted, attempts).to_owned()
            }
        };
        let duration_ms = if row.timed { (now - identity.started_at) as f64 } else { 0.0 };
        if row.timed {
            recorded.request_ms = Some(duration_ms.max(0.0) as u64);
        }
        let stream_ms = completed.map_or(0.0, |c| (c.stream_ended_at - identity.started_at) as f64);
        // `currentProviderAccountId` throws inside the row's construction: nothing is written.
        let read = match &self.account {
            Some(roster) if ACCOUNT_PROVIDERS.contains(&identity.provider.as_str()) => roster.of(&identity.provider).await,
            Some(_) => Ok(String::new()),
            None => identity.account.clone(),
        };
        let account = match read {
            Ok(account) => account,
            Err(error) => {
                tracing::error!("[usage-ledger] RECORD NOT SAVED: {error}");
                recorded.error = Some(error);
                return;
            }
        };
        let args = RecordArgs {
            ts: now,
            provider: identity.provider.clone(),
            model: served_model,
            requested_model: if row.outcome.is_some() { identity.requested_model.clone() } else { identity.model.clone() },
            requested_provider: if row.outcome.is_some() { identity.requested_provider.clone() } else { identity.provider.clone() },
            status,
            attempts: f64::from(attempts),
            ttft_ms: if row.timed { first_output_ms(&identity.provider, completed.and_then(|c| c.generation_ms), stream_ms) } else { None },
            elapsed_ms: if matches!(row.outcome, Some(RowOutcome::Failed { .. })) { (now - identity.started_at) as f64 } else { 0.0 },
            pricing_model: completed.and_then(|c| c.pricing_model.clone()),
            session_id: identity.session_id.clone(),
            owner_session_id: identity.owner_session_id.clone(),
            source_type: identity.source_type.clone(),
            input_tokens_inclusive: identity.input_tokens_inclusive,
            media: None,
            service_tier: completed
                .and_then(|c| c.service_tier.clone())
                .filter(|t| !t.is_empty())
                .or_else(|| facts.raw_service_tier.clone()),
            request_service_tier: Some(
                completed
                    .and_then(|c| c.request_service_tier.clone())
                    .unwrap_or_else(|| identity.request_service_tier.clone()),
            ),
            response_id: completed.and_then(|c| c.response_id.clone()).unwrap_or_default(),
            account,
            duration_ms,
            origin: None,
            id: completed
                .and_then(|c| c.response_id.as_ref())
                .filter(|id| !id.is_empty())
                .map(|_| None)
                .unwrap_or(Some(row.id.clone())),
            facts,
        };
        let outcome = match make_usage_record(&args, self.pricing.as_ref(), self.new_id.as_ref()) {
            Ok(built) => sink.record_queued(built).await,
            Err(error) => Err(error),
        };
        if let Err(error) = outcome {
            tracing::error!("[usage-ledger] RECORD NOT SAVED: {error}");
            recorded.error = Some(error);
        }
    }

    async fn save_abandoned(&self, recorded: &mut Recorded) {
        for (index, attempt) in self.abandoned.iter().enumerate() {
            if attempt.facts.recordable() {
                let row = Row {
                    id: format!("{}:abandoned:{index}", self.identity.request_id),
                    facts: Some(attempt.facts.clone()),
                    model: attempt.model.clone(),
                    completed: None,
                    timed: false,
                    outcome: None,
                };
                self.save(row, recorded).await;
            }
        }
    }

    /// Writes the rows of the send's end. The send settles only once they are
    /// durable; a write that fails is reported in the result, never thrown.
    pub async fn finish(&self, outcome: Outcome<'_>) -> Recorded {
        let mut recorded = Recorded::default();
        let abandoned = self.abandoned.len() as u32;
        let request_id = self.identity.request_id.clone();
        self.save_abandoned(&mut recorded).await;
        match outcome {
            Outcome::Cancelled { reported } => {
                // A user's cancel is not a request outcome: what it reported is
                // the request's row, marked `cancelled` so the request log leaves it out.
                if let Some(facts) = reported.filter(Facts::recordable) {
                    let row = Row { id: request_id, facts: Some(facts), model: None, completed: None, timed: false, outcome: Some(RowOutcome::Cancelled { attempts: abandoned + 1 }) };
                    self.save(row, &mut recorded).await;
                }
            }
            Outcome::Failed(error) => {
                // Only provider-reported usage is recordable; never invent tokens
                // for a failed request. A failure that reported nothing is still
                // a request: zero tokens.
                let reported = error.partial_usage.as_deref().map(Facts::from).filter(Facts::recordable);
                // `{ usage: reported, model: error.partialModel }`
                // (usage-accounting.mjs:225); a failure that reported nothing
                // has no served model to name.
                let model = reported.is_some().then(|| error.partial_model.as_deref().map(str::to_owned)).flatten();
                let row = Row {
                    id: request_id,
                    facts: Some(reported.unwrap_or(Facts::FAILED)),
                    model,
                    completed: None,
                    timed: false,
                    outcome: Some(RowOutcome::Failed { attempts: abandoned + 1 }),
                };
                self.save(row, &mut recorded).await;
            }
            Outcome::Completed(done) => {
                let row = Row {
                    id: request_id,
                    facts: done.facts.clone(),
                    model: done.model.clone(),
                    completed: Some(&done),
                    timed: true,
                    outcome: Some(RowOutcome::Completed { attempts: abandoned + 1 }),
                };
                self.save(row, &mut recorded).await;
            }
        }
        recorded
    }
}
