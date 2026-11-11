//! `thread/inheritancePreflight` (`inheritancePreflight` of `session-runtime/lifecycle/
//! inheritance.mjs`): the read-only verdict of whether another session's conversation fits the
//! heir this session would open, on the route it would open with. The fit math runs on the
//! target route's compaction policy, which the host owns ([`InheritanceFit`]).

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::has_session;
use mixdog_app_protocol::v2::params::ThreadInheritancePreflightParams;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;

/// The heir's route (`inheritanceRouteTarget`): only a route naming a provider and a model has one.
pub struct InheritTarget {
    pub provider: String,
    pub model: String,
    /// A window picked on this route (`selectedContextWindow`), kept only when the route is the
    /// session's own.
    pub selected_context_window: Option<u64>,
    /// The heir as the session it is (`inheritFrom` measures its `target` session): its own window fields and installed
    /// compaction settings are the policy, not the route's catalog windows with `compaction: { auto: true }`.
    pub session: Option<ThreadId>,
    /// The session whose tool surface sizes the heir's request reserve (`session.tools`).
    pub tools_of: Option<ThreadId>,
    /// The session whose conversation is measured (`sourceSessionId`): the host prices its media
    /// through that session's own attachments.
    pub source: Option<ThreadId>,
}

/// What the target route's compaction policy says of a conversation
/// (`resolveWorkerCompactPolicy`, `currentContextEstimateTokens`).
pub struct FitBasis {
    /// `policy.triggerTokens`.
    pub limit: u64,
    /// `currentContextEstimateTokens(estimateMessagesTokens(messages), policy)`.
    pub used: u64,
    /// `inheritanceCompactionPlan(target) !== null`: the route has a boundary to compact toward.
    pub compactable: bool,
}

/// The host side of the preflight.
#[async_trait]
pub trait InheritanceFit: Send + Sync {
    /// `None` for an unmeasurable route: no boundary metadata, or auto-compaction off.
    async fn basis(&self, target: &InheritTarget, messages: &[Value]) -> Option<FitBasis>;
    /// `inheritanceCompactionPlan(target).budgetTokens`: what a conversation compacted for this heir must fit; `None` when
    /// the route has no boundary to compact toward.
    async fn compaction_budget(&self, target: &InheritTarget) -> Option<u64>;
}

fn clean(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| mixdog_js::js_trim(text).to_owned()).unwrap_or_default()
}

/// `inheritableMessages`: system blocks belong to the session that built them.
pub(super) fn inheritable(messages: Vec<Value>) -> Vec<Value> {
    messages.into_iter().filter(|message| message.get("role").and_then(Value::as_str) != Some("system")).collect()
}

/// `inheritanceFitMessage`.
fn fit_message(provider: &str, model: &str, used: u64, limit: u64) -> String {
    let route = [provider, model].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join("/");
    let route = if route.is_empty() { "the selected model" } else { route.as_str() };
    format!("inheritFrom: the full conversation needs {used} tokens but {route} allows {limit} before compaction")
}

impl SessionDirectory {
    async fn read_of(&self, thread: &ThreadId, method: &'static str) -> Result<Value, CoreError> {
        let ctx = CallContext::internal("inheritance");
        let handle = self.open_handle(thread, &ctx).await?;
        match handle.request(CoreRequest { method: Method(method), params: json!({ "threadId": thread }), op: None, ctx }).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Err(CoreError::Internal { incident_id: "inheritance-subscribed".into() }),
        }
    }

    /// The rows of a session; a session that is not there has none.
    pub(super) async fn rows_of(&self, id: &str) -> Result<Vec<Value>, CoreError> {
        match self.read_of(&ThreadId::from(id.to_owned()), "thread/messages/read").await {
            Ok(value) => Ok(value.get("messages").and_then(Value::as_array).cloned().unwrap_or_default()),
            Err(CoreError::ThreadNotFound { .. }) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    /// `inheritFrom` into a session that already exists (`inheritance.mjs`): the heir keeps its own record and route and
    /// takes the source's conversation after what it holds (`target.messages.push(...)`), which must be none - "interleaving
    /// two transcripts would produce a conversation neither model ever had". The checks run in Node's order: the heir is
    /// not the source, it holds no conversation, the source has one to carry. The heir has no lineage of its own to
    /// share with the source's, so the messages are appended to it as rows of no turn, as an import's are.
    pub(super) async fn carry_into(&self, source: &ThreadId, heir: &ThreadId, compact: bool) -> Result<Reply, CoreError> {
        let refused = |message: &str| mixdog_core_base::support::failed("inheritance", message);
        if heir == source {
            return Err(refused("inheritFrom: a session cannot inherit from itself"));
        }
        let ctx = CallContext::internal("inheritance");
        let handle = self.open_handle(heir, &ctx).await?;
        // `hasUserConversationMessage(target.messages) || hasUserConversationMessage(target.liveTurnMessages)`.
        let live = (**handle.cell.turn_messages.borrow()).clone();
        if super::route_session::has_user_conversation(&self.rows_of(heir.as_str()).await?) || super::route_session::has_user_conversation(&live) {
            return Err(refused("inheritFrom: this session already holds a conversation"));
        }
        let mut carried = inheritable(self.rows_of(source.as_str()).await?);
        if !super::route_session::has_user_conversation(&carried) {
            return Err(refused("inheritFrom: the source session has no conversation to carry"));
        }
        // Decided before anything moves, on the heir's own scale (`inheritanceFit` over the heir): an explicit `compact`
        // summarizes whatever the size, otherwise only a conversation that cannot fit is compacted.
        let held = handle.cell.header.load_full();
        let target = InheritTarget {
            provider: clean(held.get("provider")),
            model: clean(held.get("model")),
            selected_context_window: None,
            session: Some(heir.clone()),
            tools_of: Some(heir.clone()),
            source: Some(source.clone()),
        };
        let fit_of = |basis: Option<FitBasis>| basis.filter(|basis| basis.limit > 0);
        let fit = fit_of(self.deps().inherit.basis(&target, &carried).await);
        if compact || fit.as_ref().is_some_and(|fit| fit.used >= fit.limit) {
            // `fitConversationForHeir`: a compaction that cannot run is a refusal, not a half-carry.
            let budget = self.deps().inherit.compaction_budget(&target).await;
            let compacted = match budget {
                Some(budget) => match self.deps().compaction.compact_for_heir(source, budget, compact).await {
                    Ok(rows) => Some(inheritable(rows.unwrap_or_default())).filter(|rows| super::route_session::has_user_conversation(rows)),
                    Err(_) => None,
                },
                None => None,
            };
            if compact && compacted.is_none() {
                return Err(refused("inheritFrom: the conversation could not be compacted for the new session"));
            }
            let next_fit = match &compacted {
                Some(rows) => fit_of(self.deps().inherit.basis(&target, rows).await),
                None => fit,
            };
            if let Some(rows) = compacted {
                carried = rows;
            }
            if let Some(fit) = next_fit.filter(|fit| fit.used >= fit.limit) {
                return Err(refused(&fit_message(&target.provider, &target.model, fit.used, fit.limit)));
            }
        }
        let source_title = clean(self.read_of(source, "thread/header/read").await?.pointer("/header/title"));
        let mut set = Map::new();
        set.insert("inheritedFromSessionId".into(), json!(source.as_str()));
        if clean(held.get("title")).is_empty() && !source_title.is_empty() {
            set.insert("title".into(), json!(source_title));
        }
        let count = carried.len();
        // `recordInheritanceBoundary`: display-only, on the last carried row, naming the source, the heir and the route the heir holds.
        let boundary = json!({
            "sourceSessionId": source.as_str(),
            "sessionId": heir.as_str(),
            "provider": held.get("provider").cloned().unwrap_or(Value::Null),
            "modelId": held.get("model").cloned().unwrap_or(Value::Null),
            "at": self.deps().clock.now_ms(),
        });
        if let Some(Value::Object(last)) = carried.last_mut() {
            let meta = last.entry("meta").or_insert_with(|| json!({}));
            if !meta.is_object() {
                *meta = json!({});
            }
            let earlier = meta.get("sessionInheritances").and_then(Value::as_array).cloned().unwrap_or_default();
            meta["sessionInheritances"] = Value::Array(earlier.into_iter().chain([boundary]).collect());
        }
        for (method, params) in [
            ("thread/inheritedRows/append", json!({ "messages": carried })),
            ("thread/header/patch", json!({ "threadId": heir, "set": set, "unset": [] })),
        ] {
            handle.request(CoreRequest { method: Method(method), params, op: None, ctx: ctx.clone() }).await?;
        }
        let held = handle.cell.header.load();
        // The summary of the header as acked (the view's own, `view()`): the patch's reply is sent before its view is published,
        // so the view held now still shows the heir before it named its source.
        Ok(Reply::Value(json!({
            "thread": self.deps().transcript.summary(heir, &held),
            "messages": count,
            "provider": held.get("provider").cloned().unwrap_or(Value::Null),
            "model": held.get("model").cloned().unwrap_or(Value::Null),
        })))
    }
    pub(super) async fn inheritance_preflight(&self, params: &Value) -> Result<Value, CoreError> {
        let params: ThreadInheritancePreflightParams = serde_json::from_value(params.clone())
            .map_err(|_| CoreError::InvalidParams { path: "params".into(), expected: "ThreadInheritancePreflightParams".into() })?;
        let current = params.thread_id.as_ref();
        let header = match current {
            Some(thread) => self.read_of(thread, "thread/header/read").await?.get("header").and_then(Value::as_object).cloned().unwrap_or_default(),
            None => Map::new(),
        };
        let requested = params.selection.as_ref().filter(|selection| selection.is_object());
        let route = |key: &str| clean(requested.and_then(|selection| selection.get(key)));
        let (own_provider, own_model) = (clean(header.get("provider")), clean(header.get("model")));
        let provider = Some(route("provider")).filter(|name| !name.is_empty()).unwrap_or_else(|| own_provider.clone());
        let model = Some(route("model")).filter(|name| !name.is_empty()).unwrap_or_else(|| own_model.clone());
        let id = params.source_thread_id.as_ref().map(|id| mixdog_js::js_trim(id.as_str()).to_owned()).filter(|id| !id.is_empty());
        let (id, messages) = match id {
            Some(id) => {
                let rows = self.rows_of(&id).await?;
                (Some(id), rows)
            }
            // With no source the current session is the one measured (`getSessionId()`), when it has a session: a thread
            // that has none yet names no source.
            None => match current.map(|thread| mixdog_js::js_trim(thread.as_str()).to_owned()).filter(|id| !id.is_empty()) {
                Some(id) => {
                    let rows = self.rows_of(&id).await?;
                    if has_session(&header, &rows) { (Some(id), rows) } else { (None, Vec::new()) }
                }
                None => (None, Vec::new()),
            },
        };
        let carried = inheritable(messages);
        // A picked window belongs to the route that picked it; another provider/model pair falls
        // back to that model's own default.
        let selected_context_window = (provider == own_provider && model == own_model)
            .then(|| mixdog_agent::agent_tool::scope::positive_int(header.get("selectedContextWindow")))
            .flatten();
        let basis = if provider.is_empty() || model.is_empty() {
            None
        } else {
            let target = InheritTarget {
                provider: provider.clone(),
                model: model.clone(),
                selected_context_window,
                session: None,
                tools_of: current.cloned(),
                source: id.clone().map(ThreadId::from),
            };
            self.deps().inherit.basis(&target, &carried).await
        };
        // `inheritanceFit`: the base names the target's route, empty when it has none.
        let (name, tag) = if provider.is_empty() || model.is_empty() { (String::new(), String::new()) } else { (provider, model) };
        let mut out = Map::new();
        out.insert("provider".into(), json!(name));
        out.insert("model".into(), json!(tag));
        out.insert("messages".into(), json!(carried.len()));
        let (known, fits, used, limit) = match &basis {
            Some(basis) if basis.limit > 0 => (true, basis.used < basis.limit, basis.used, basis.limit),
            _ => (false, true, 0, 0),
        };
        out.insert("known".into(), json!(known));
        out.insert("fits".into(), json!(fits));
        out.insert("used".into(), json!(used));
        out.insert("limit".into(), json!(limit));
        out.insert("percent".into(), if known { json!(((used as f64 / limit as f64) * 100.0).ceil().max(0.0) as u64) } else { Value::Null });
        // An oversized conversation is compacted for the heir rather than refused.
        let will_compact = known && !fits && basis.as_ref().is_some_and(|basis| basis.compactable);
        out.insert("willCompact".into(), json!(will_compact));
        out.insert("sourceSessionId".into(), id.map_or(Value::Null, Value::from));
        let reason = if known && !fits && !will_compact { fit_message(&name, &tag, used, limit) } else { String::new() };
        out.insert("reason".into(), json!(reason));
        Ok(Value::Object(out))
    }
}
