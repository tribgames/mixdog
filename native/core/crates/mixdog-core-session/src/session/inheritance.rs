//! `thread/inheritancePreflight`: the read-only verdict of whether another session's conversation
//! fits the heir this session would open, on the route it would open with. The fit math runs on
//! the target route's compaction policy, which the host owns ([`InheritanceFit`]).

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::ThreadInheritancePreflightParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::has_session;
use mixdog_store::offload_sources;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::actor::ForkSource;

/// How many times the removal of a refused carry's "being copied" mark is tried before it is given up.
const UNMARK_TRIES: usize = 3;

/// A carry that failed, and whether its append was attempted (rows of it may be in the heir's log).
struct Carry {
    error: CoreError,
    appended: bool,
}

/// A carry decided and checked, not yet written: the rows the heir takes and whether the compactor made them.
struct Plan {
    rows: Vec<Value>,
    compacted: bool,
}

pub(super) enum CarryMode {
    Existing { compact: bool },
    New { compact: bool },
    Recovery { rows: Vec<Value> },
}

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
    /// `rebindToChangedPrefix` for a carry (`carryConversation`): thinking replay is bound to the request prefix (system
    /// prompt and tools) that produced it, so when the heir's differs from the source's (`system_differs`, or the tools
    /// the two sessions send) the carried rows go to the heir without it. The rows as they are when the prefix is the same.
    async fn bind_to_heir_prefix(&self, source: &ThreadId, heir: &ThreadId, system_differs: bool, rows: Vec<Value>) -> Vec<Value>;
}

struct CopyMark<'a> {
    handle: &'a SessionHandle,
    heir: &'a ThreadId,
}

impl<'a> CopyMark<'a> {
    async fn stored_before_any_row(
        handle: &'a SessionHandle,
        heir: &'a ThreadId,
        source_fields: &Map<String, Value>,
        source: &ThreadId,
    ) -> Result<Self, CoreError> {
        let (marking, unset) = carry_mark(&handle.cell.header.load_full(), source_fields, source);
        let mark = Self { handle, heir };
        mark.patch(marking, unset, "inheritance").await?;
        Ok(mark)
    }

    async fn withdraw(&self) {
        for _ in 0..UNMARK_TRIES {
            if self.patch(Map::new(), vec![offload_sources::INHERITING, offload_sources::INHERITING_BOOT], "inheritance-unmark").await.is_ok() {
                break;
            }
        }
    }

    async fn patch(&self, set: Map<String, Value>, unset: Vec<&str>, caller: &'static str) -> Result<Reply, CoreError> {
        let ctx = CallContext::internal(caller);
        self.handle
            .request(CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": self.heir, "set": set, "unset": unset }), op: None, ctx })
            .await
    }
}

fn carry_mark(before: &Map<String, Value>, source_fields: &Map<String, Value>, source: &ThreadId) -> (Map<String, Value>, Vec<&'static str>) {
    let mut sources: std::collections::BTreeSet<String> = offload_sources::sources(before).into_iter().collect();
    sources.extend(offload_sources::sources(source_fields));
    sources.insert(offload_sources::safe_segment(source.as_str()));
    let mut marking = Map::new();
    marking.insert(offload_sources::INHERITING.into(), json!(source.as_str()));
    marking.insert(offload_sources::INHERITING_BOOT.into(), json!(offload_sources::boot()));
    let mut unset = Vec::new();
    if offload_sources::holds_set(source_fields) {
        offload_sources::set_sources(&mut marking, sources.into_iter().collect());
    } else {
        marking.insert(offload_sources::SOURCES.into(), json!(sources));
        unset.push(offload_sources::SOURCES_RULES);
    }
    (marking, unset)
}

fn system_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter().filter(|row| row.get("role").and_then(Value::as_str) == Some("system")).cloned().collect()
}

fn attach_boundary(carried: &mut [Value], boundary: Value) {
    if let Some(Value::Object(last)) = carried.last_mut() {
        let meta = last.entry("meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        let earlier = meta.get("sessionInheritances").and_then(Value::as_array).cloned().unwrap_or_default();
        meta["sessionInheritances"] = Value::Array(earlier.into_iter().chain([boundary]).collect());
    }
}

fn clean(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| mixdog_js::js_trim(text).to_owned()).unwrap_or_default()
}

/// `inheritableMessages`: system blocks belong to the session that built them.
pub fn inheritable(messages: Vec<Value>) -> Vec<Value> {
    messages.into_iter().filter(|message| message.get("role").and_then(Value::as_str) != Some("system")).collect()
}

/// `inheritanceFit(messages, target)`: the verdict on `messages` carried rows of a conversation over the target's
/// [`FitBasis`] (`None`: an unmeasurable route, which stays permissive).
pub fn inheritance_fit(provider: &str, model: &str, messages: usize, basis: Option<&FitBasis>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("provider".into(), json!(provider));
    out.insert("model".into(), json!(model));
    out.insert("messages".into(), json!(messages));
    let (known, fits, used, limit) = match basis {
        Some(basis) if basis.limit > 0 => (true, basis.used < basis.limit, basis.used, basis.limit),
        _ => (false, true, 0, 0),
    };
    out.insert("known".into(), json!(known));
    out.insert("fits".into(), json!(fits));
    out.insert("used".into(), json!(used));
    out.insert("limit".into(), json!(limit));
    out.insert("percent".into(), if known { json!(((used as f64 / limit as f64) * 100.0).ceil().max(0.0) as u64) } else { Value::Null });
    out
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

    pub(super) async fn carry_into(&self, source_handle: &SessionHandle, heir: &ThreadId, snapshot: &ForkSource, mode: CarryMode) -> Result<Reply, CoreError> {
        let source = &source_handle.id;
        let refused = |message: &str| mixdog_core_base::support::failed("inheritance", message);
        if heir == source {
            return Err(refused("inheritFrom: a session cannot inherit from itself"));
        }
        let ctx = CallContext::internal("inheritance");
        let handle = self.open_handle(heir, &ctx).await?;
        let live = (**handle.cell.turn_messages.borrow()).clone();
        if super::route_session::has_user_conversation(&self.rows_of(heir.as_str()).await?) || super::route_session::has_user_conversation(&live) {
            return Err(refused("inheritFrom: this session already holds a conversation"));
        }
        self.deps().sensitive.carry(source, heir);
        let mark = CopyMark::stored_before_any_row(&handle, heir, &snapshot.header, source).await?;
        let (count, compacted) = match self.carry_rows(source_handle, &handle, snapshot, mode).await {
            Ok(done) => done,
            Err(Carry { error, appended: false }) => {
                mark.withdraw().await;
                return Err(error);
            }
            Err(Carry { error, appended: true }) => return Err(error),
        };
        let held = handle.cell.header.load();
        Ok(Reply::Value(json!({
            "thread": handle.cell.view.load_full().summary.clone(),
            "messages": count,
            "compacted": compacted,
            "provider": held.get("provider").cloned().unwrap_or(Value::Null),
            "model": held.get("model").cloned().unwrap_or(Value::Null),
        })))
    }

    async fn carry_rows(&self, source: &SessionHandle, handle: &SessionHandle, snapshot: &ForkSource, mode: CarryMode) -> Result<(usize, bool), Carry> {
        let existing = matches!(mode, CarryMode::Existing { .. });
        let (carried, set, compacted) = self.fit_rows(source, handle, snapshot, mode).await.map_err(|error| Carry { error, appended: false })?;
        let ctx = CallContext::internal(if existing { "inheritance" } else { "inheritance-durable" });
        let count = carried.len();
        let params = json!({ "messages": carried, "set": set, "unset": [offload_sources::INHERITING, offload_sources::INHERITING_BOOT] });
        match handle.request(CoreRequest { method: Method("thread/inheritedRows/append"), params, op: None, ctx }).await {
            Ok(_) => Ok((count, compacted)),
            Err(CoreError::BarrierFailed { .. }) if existing => Ok((count, compacted)),
            Err(error) => Err(Carry { error, appended: true }),
        }
    }

    /// The source's rows fitted to the heir, the last one holding the inheritance boundary, and the heir's header
    /// fields naming its source; nothing is written.
    async fn fit_rows(
        &self,
        source: &SessionHandle,
        handle: &SessionHandle,
        snapshot: &ForkSource,
        mode: CarryMode,
    ) -> Result<(Vec<Value>, Map<String, Value>, bool), CoreError> {
        let heir = &handle.id;
        let held = handle.cell.header.load_full();
        let target = InheritTarget {
            provider: clean(held.get("provider")),
            model: clean(held.get("model")),
            selected_context_window: mixdog_agent::agent_tool::scope::positive_int(held.get("selectedContextWindow")),
            session: Some(heir.clone()),
            tools_of: Some(heir.clone()),
            source: Some(source.id.clone()),
        };
        let mut set = Map::new();
        set.insert("inheritedFromSessionId".into(), json!(source.id));
        let source_title = clean(snapshot.header.get("title"));
        if clean(held.get("title")).is_empty() && !source_title.is_empty() {
            set.insert("title".into(), json!(source_title));
        }
        let compact = match mode {
            CarryMode::Recovery { rows } => return Ok((rows, set, false)),
            CarryMode::Existing { compact } | CarryMode::New { compact } => compact,
        };
        let source_rows = source.completed_history(snapshot).await?;
        let source_system = system_rows(&source_rows);
        let heir_system = system_rows(&self.rows_of(heir.as_str()).await?);
        let system_differs = !source_system.is_empty() && !heir_system.is_empty() && source_system != heir_system;
        let Plan { rows: carried, compacted } = self.plan_carry(source, source_rows, &target, compact, system_differs).await?;
        let mut carried = mixdog_agent::effort::strip_effort_configuration(carried);
        let boundary = json!({
            "sourceSessionId": source.id,
            "sessionId": heir.as_str(),
            "provider": held.get("provider").cloned().unwrap_or(Value::Null),
            "modelId": held.get("model").cloned().unwrap_or(Value::Null),
            "at": self.deps().clock.now_ms(),
        });
        attach_boundary(&mut carried, boundary);
        Ok((carried, set, compacted))
    }

    /// `carryConversation` up to the point anything is written: the source's conversation (or the compactor's, when
    /// `compact` asks for it or the conversation cannot fit `target`), checked as Node checks it.
    async fn plan_carry(
        &self,
        source: &SessionHandle,
        rows: Vec<Value>,
        target: &InheritTarget,
        compact: bool,
        system_differs: bool,
    ) -> Result<Plan, CoreError> {
        let refused = |message: &str| mixdog_core_base::support::failed("inheritance", message);
        // The replay bound to the source's prefix is removed before the fit is measured: it is what the heir would not send.
        let bind = |rows: Vec<Value>| async move {
            match &target.session {
                Some(heir) => self.deps().inherit.bind_to_heir_prefix(&source.id, heir, system_differs, rows).await,
                None => rows,
            }
        };
        let system = system_rows(&rows);
        let mut carried = bind(inheritable(rows)).await;
        if !super::route_session::has_user_conversation(&carried) {
            return Err(refused("inheritFrom: the source session has no conversation to carry"));
        }
        // Decided before anything moves, on the heir's own scale (`inheritanceFit` over the heir): an explicit `compact`
        // summarizes whatever the size, otherwise only a conversation that cannot fit is compacted.
        let fit_of = |basis: Option<FitBasis>| basis.filter(|basis| basis.limit > 0);
        let fit = fit_of(self.deps().inherit.basis(target, &carried).await);
        // `carryConversation`'s `compacted`: the heir takes the compactor's conversation instead of the source's.
        let mut was_compacted = false;
        if compact || fit.as_ref().is_some_and(|fit| fit.used >= fit.limit) {
            // `fitConversationForHeir`: a compaction that cannot run is a refusal, not a half-carry.
            let budget = self.deps().inherit.compaction_budget(target).await;
            let compacted = match budget {
                Some(budget) => {
                    // The compactor summarizes the rows the fit was measured on (`fitConversationForHeir(carrySource, ...)`): the
                    // committed turns as bound to the heir's prefix, behind the system blocks the source's requests lead with.
                    let measured: Vec<Value> = system.iter().cloned().chain(carried.iter().cloned()).collect();
                    let compacted = self.deps().compaction.compact_for_heir(&source.id, &measured, budget, compact).await;
                    match compacted.ok().flatten().map(inheritable).filter(|rows| super::route_session::has_user_conversation(rows)) {
                        Some(rows) => Some(bind(rows).await),
                        None => None,
                    }
                }
                None => None,
            };
            if compact && compacted.is_none() {
                return Err(refused("inheritFrom: the conversation could not be compacted for the new session"));
            }
            let next_fit = match &compacted {
                Some(rows) => fit_of(self.deps().inherit.basis(target, rows).await),
                None => fit,
            };
            if let Some(rows) = compacted {
                carried = rows;
                was_compacted = true;
            }
            if let Some(fit) = next_fit.filter(|fit| fit.used >= fit.limit) {
                return Err(refused(&fit_message(&target.provider, &target.model, fit.used, fit.limit)));
            }
        }
        Ok(Plan { rows: carried, compacted: was_compacted })
    }

    async fn preflight_source(
        &self,
        requested: Option<&ThreadId>,
        current: Option<&ThreadId>,
        header: &Map<String, Value>,
    ) -> Result<(Option<String>, Vec<Value>), CoreError> {
        let trimmed = |thread: Option<&ThreadId>| thread.map(|thread| mixdog_js::js_trim(thread.as_str()).to_owned()).filter(|id| !id.is_empty());
        if let Some(id) = trimmed(requested) {
            let rows = self.rows_of(&id).await?;
            return Ok((Some(id), rows));
        }
        let Some(id) = trimmed(current) else { return Ok((None, Vec::new())) };
        let rows = self.rows_of(&id).await?;
        Ok(if has_session(header, &rows) { (Some(id), rows) } else { (None, Vec::new()) })
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
        let (id, messages) = self.preflight_source(params.source_thread_id.as_ref(), current, &header).await?;
        let carried = inheritable(messages);
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
        let mut out = inheritance_fit(&name, &tag, carried.len(), basis.as_ref());
        let (known, fits) = (out["known"] == json!(true), out["fits"] == json!(true));
        let (used, limit) = (out["used"].as_u64().unwrap_or(0), out["limit"].as_u64().unwrap_or(0));
        // An oversized conversation is compacted for the heir rather than refused.
        let will_compact = known && !fits && basis.as_ref().is_some_and(|basis| basis.compactable);
        out.insert("willCompact".into(), json!(will_compact));
        out.insert("sourceSessionId".into(), id.map_or(Value::Null, Value::from));
        let reason = if known && !fits && !will_compact { fit_message(&name, &tag, used, limit) } else { String::new() };
        out.insert("reason".into(), json!(reason));
        Ok(Value::Object(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fit(messages: usize, basis: Option<FitBasis>) -> Value {
        Value::Object(inheritance_fit("openai", "gpt-5", messages, basis.as_ref()))
    }

    #[test]
    fn a_conversation_below_the_routes_limit_fits_and_says_how_much_of_it_is_used() {
        assert_eq!(
            fit(4, Some(FitBasis { limit: 200, used: 50, compactable: true })),
            json!({ "provider": "openai", "model": "gpt-5", "messages": 4, "known": true, "fits": true, "used": 50, "limit": 200, "percent": 25 })
        );
    }

    #[test]
    fn the_percent_rounds_up_and_a_conversation_at_the_limit_no_longer_fits() {
        assert_eq!(fit(1, Some(FitBasis { limit: 3, used: 1, compactable: true }))["percent"], 34);
        let full = fit(1, Some(FitBasis { limit: 200, used: 200, compactable: true }));
        assert_eq!((&full["fits"], &full["percent"]), (&json!(false), &json!(100)));
        assert_eq!(fit(1, Some(FitBasis { limit: 200, used: 300, compactable: false }))["percent"], 150);
    }

    #[test]
    fn a_route_that_cannot_be_measured_stays_permissive() {
        let open = json!({ "provider": "openai", "model": "gpt-5", "messages": 2, "known": false, "fits": true, "used": 0, "limit": 0, "percent": null });
        assert_eq!(fit(2, None), open);
        assert_eq!(fit(2, Some(FitBasis { limit: 0, used: 90, compactable: true })), open, "a limit of nothing measures nothing");
    }

    #[test]
    fn the_refusal_names_the_heirs_route_or_a_selected_model_when_it_has_none() {
        assert_eq!(
            fit_message("openai", "gpt-5", 300, 200),
            "inheritFrom: the full conversation needs 300 tokens but openai/gpt-5 allows 200 before compaction"
        );
        assert_eq!(fit_message("", "gpt-5", 300, 200), "inheritFrom: the full conversation needs 300 tokens but gpt-5 allows 200 before compaction");
        assert_eq!(fit_message("", "", 300, 200), "inheritFrom: the full conversation needs 300 tokens but the selected model allows 200 before compaction");
    }

    #[test]
    fn a_carried_conversation_leaves_the_sources_system_blocks_behind() {
        let rows = vec![json!({ "role": "system", "content": "s" }), json!({ "role": "user", "content": "u" }), json!({ "role": "assistant", "content": "a" })];
        assert_eq!(inheritable(rows), vec![json!({ "role": "user", "content": "u" }), json!({ "role": "assistant", "content": "a" })]);
    }
}
