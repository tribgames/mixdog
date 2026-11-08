//! The real [`InheritanceFit`]: what the target route's compaction policy says of a conversation
//! (`inheritanceFit` and `inheritanceCompactionPlan` of `session-runtime/inheritance-fit.mjs`).
//!
//! The heir has no session yet, so its policy is resolved from the route's windows
//! (`inheritanceRouteTarget`: the catalog's window fields, `compaction: { auto: true }` never synced
//! with the saved configuration) over the tools the opening session already sends. The
//! conversation is priced as `estimateMessagesTokens` prices it, and the gauge value is
//! `currentContextEstimateTokens`: the estimate plus the request reserve, on the route's
//! calibration.
//!
//! The thread side (the tools a request sends, the media meter of the source's attachments) is bound
//! lazily to the directory, as [`NextRequestSource`] is.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::boundary::{CompactPolicy, CompactSettings};
use mixdog_agent::compact::estimate::{MediaMeter, MessageMeter};
use mixdog_agent::compact::settings::Doc;
use mixdog_agent::compact::tool_schema::{RequestTools, estimate_request_reserve_tokens};
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_run::run_host::session_context_meta::{ContextMeta, session_context_meta};
use mixdog_core_session::session::inheritance::{FitBasis, InheritTarget, InheritanceFit};
use mixdog_protocol::ProviderId;
use mixdog_store::schema::record::Header;
use serde_json::{Value, json};

use super::compactors::CompactionWorld;
use super::message_row::message_of;
use super::next_request_source::NextRequestSource;
use super::run_seams::ConfigRunSeams;

/// The windows a model starts a session with (`resolveSessionContextMeta`).
pub trait RouteWindows: Send + Sync {
    fn window(&self, provider: &str, model: &str, seed: &Value) -> Option<ContextMeta>;
}

impl RouteWindows for mixdog_ai::catalog::CatalogService {
    fn window(&self, provider: &str, model: &str, seed: &Value) -> Option<ContextMeta> {
        session_context_meta(self, provider, model, seed)
    }
}

/// The compaction inputs of a route that has no session: the saved settings are not applied.
pub trait RouteSettings: Send + Sync {
    fn settings(&self, route: &Header) -> CompactSettings;
}

impl RouteSettings for ConfigRunSeams {
    fn settings(&self, route: &Header) -> CompactSettings {
        let mut compaction = Doc::new();
        compaction.insert("auto".into(), Value::Bool(true));
        self.compact_settings_with(route, false, compaction)
    }
}

/// What the measured threads give: the tools a request of the session sends, and the media meter of
/// the session whose conversation is measured.
#[async_trait]
pub trait MeasuredThreads: Send + Sync {
    /// `session.tools`; none for a session that is not loaded.
    async fn tools(&self, thread: &ThreadId) -> Vec<ToolDefinition>;
    /// The meter of `thread`'s attachments for `rows`; `None` when the thread is not loaded.
    async fn media(&self, thread: &ThreadId, rows: &[Value]) -> Option<Arc<dyn MediaMeter>>;
}

pub struct HostInheritanceFit {
    windows: Arc<dyn RouteWindows>,
    settings: Arc<dyn RouteSettings>,
    threads: Arc<dyn MeasuredThreads>,
}

impl HostInheritanceFit {
    pub fn new(windows: Arc<dyn RouteWindows>, settings: Arc<dyn RouteSettings>, threads: Arc<dyn MeasuredThreads>) -> Self {
        Self { windows, settings, threads }
    }

    /// The composition's: the catalog's windows, the process's configuration seams, and the
    /// threads of the directory `next` is bound to.
    pub fn process(catalog: Arc<mixdog_ai::catalog::CatalogService>, config: Arc<ConfigRunSeams>, next: Arc<NextRequestSource>, world: Arc<dyn CompactionWorld>) -> Self {
        Self::new(catalog, config, Arc::new(DirectoryThreads { next, world }))
    }

    /// `inheritanceRouteTarget`'s header: the route and its five window fields.
    fn route_header(target: &InheritTarget, meta: ContextMeta) -> Header {
        let mut header = Header::new();
        header.insert("provider".into(), json!(target.provider));
        header.insert("model".into(), json!(target.model));
        header.insert("contextWindow".into(), meta.context_window);
        header.insert("rawContextWindow".into(), meta.raw_context_window);
        header.insert("effectiveContextWindowPercent".into(), meta.effective_context_window_percent);
        header.insert("autoCompactTokenLimit".into(), meta.auto_compact_token_limit);
        header.insert("compactBoundaryTokens".into(), meta.compact_boundary_tokens);
        header
    }
}

impl HostInheritanceFit {
    /// The compaction inputs of the heir's route (`inheritanceRouteTarget`) over the tools the opening session sends.
    async fn route_settings(&self, target: &InheritTarget) -> Option<CompactSettings> {
        let seed = target.selected_context_window.map_or_else(|| json!({}), |window| json!({ "selectedContextWindow": window }));
        let meta = self.windows.window(&target.provider, &target.model, &seed)?;
        let mut settings = self.settings.settings(&Self::route_header(target, meta));
        let tools = match &target.tools_of {
            Some(thread) => self.threads.tools(thread).await,
            None => Vec::new(),
        };
        settings.request_reserve_tokens = estimate_request_reserve_tokens(&RequestTools { native: &[], defined: &tools });
        Some(settings)
    }
}

/// `INHERITANCE_COMPACT_MIN_BUDGET_TOKENS`.
const MIN_COMPACT_BUDGET_TOKENS: u64 = 4_000;

#[async_trait]
impl InheritanceFit for HostInheritanceFit {
    /// `inheritanceCompactionPlan`: `max(4000, compactTargetBudget({ ...policy, force: true }))` over the heir's policy.
    async fn compaction_budget(&self, target: &InheritTarget) -> Option<u64> {
        let policy = CompactPolicy::resolve(&self.route_settings(target).await?)?;
        (policy.boundary_tokens > 0).then(|| policy.target_budget().max(MIN_COMPACT_BUDGET_TOKENS))
    }

    async fn basis(&self, target: &InheritTarget, messages: &[Value]) -> Option<FitBasis> {
        let settings = self.route_settings(target).await?;
        let media = match (&target.source, messages.is_empty()) {
            (_, true) => None,
            (Some(source), false) => Some(self.threads.media(source, messages).await?),
            (None, false) => return None,
        };
        measure(&settings, messages, media.as_deref())
    }
}

/// `inheritanceFit` over a resolved route: `None` when the route has no compaction policy
/// (no boundary, or automatic compaction off), the trigger as the limit and the conversation's
/// `currentContextEstimateTokens` as the use. A conversation of a row that is not a message cannot
/// be priced, so it is not measured. `media` is read only for a conversation that has rows.
pub fn measure(settings: &CompactSettings, rows: &[Value], media: Option<&dyn MediaMeter>) -> Option<FitBasis> {
    let policy = CompactPolicy::resolve(settings)?;
    let mut estimate = 0u64;
    for row in rows {
        let message = message_of(row).ok()?;
        // `estimateMessagesTokens` prices a replay envelope whatever provider stored it.
        let owner = message.message.provider_replay().first().map_or_else(|| ProviderId::from(""), |replay| replay.owner.clone());
        estimate += MessageMeter { media: media?, replay_owner: &owner }.message(&message);
    }
    let used = ((estimate + policy.request_reserve_tokens) as f64 * policy.token_calibration).round() as u64;
    Some(FitBasis { limit: policy.trigger_tokens, used, compactable: true })
}

struct DirectoryThreads {
    next: Arc<NextRequestSource>,
    world: Arc<dyn CompactionWorld>,
}

#[async_trait]
impl MeasuredThreads for DirectoryThreads {
    async fn tools(&self, thread: &ThreadId) -> Vec<ToolDefinition> {
        let Some((directory, parts)) = self.next.bound() else { return Vec::new() };
        let Some(handle) = directory.upgrade().and_then(|directory| directory.handle(thread)) else { return Vec::new() };
        let header = handle.live_header().header();
        let surface = handle.surface().borrow().clone();
        parts.tool_definitions(thread, &header, &surface).await.unwrap_or_default()
    }

    async fn media(&self, thread: &ThreadId, rows: &[Value]) -> Option<Arc<dyn MediaMeter>> {
        let (directory, _) = self.next.bound()?;
        let handle = directory.upgrade()?.handle(thread)?;
        let header = handle.live_header().header();
        Some(self.world.facts(thread, &header, rows).await.media)
    }
}

#[cfg(test)]
mod tests;
