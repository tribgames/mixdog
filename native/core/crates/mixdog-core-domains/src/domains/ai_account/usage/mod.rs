//! The `usage` domain service (`usage-stats-api.mjs`, `provider-usage.mjs`): statistics and the
//! request log come from the ledger (settled, and its unpriced records refreshed, before a read); this service names the sessions behind requests
//! and serves the provider quota dashboard.

pub mod dashboard;
pub mod session_usage;
pub mod sources;

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_ledger::measure::is_conversation_source;
use mixdog_ledger::error::LedgerError;
use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::stats::UsageRequestsOptions;
use mixdog_ledger::stats::UsageStatsOptions;
use serde_json::Value;
use serde_json::json;

use self::dashboard::UsageSources;
use super::dashboards::Dashboards;
use super::failure::ledger_failure;
use super::js::truthy;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;

const DOMAIN: &str = "usage";

/// The usage ledger, asked for at every call as Node asks `getUsageLedger()`: opening it can fail and
/// the process's ledger path can change, so a service holds this, never one opened ledger.
pub trait LedgerAccess: Send + Sync {
    fn ledger(&self) -> Result<Arc<UsageLedger>, LedgerError>;
}

/// A ledger that is already open.
impl LedgerAccess for Arc<UsageLedger> {
    fn ledger(&self) -> Result<Arc<UsageLedger>, LedgerError> {
        Ok(Arc::clone(self))
    }
}

/// Stored session metadata (`title`, `agent`, `ownerSessionId`, `sourceType`) by session id.
/// WP-SESSION's directory has no such accessor yet.
#[async_trait]
pub trait SessionMetadata: Send + Sync {
    async fn metadata(&self, session_id: &str) -> Option<Value>;
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `isLeadVisibleRow({ sourceType })`: rows of an internal run are hidden.
fn is_lead_visible(source: &str) -> bool {
    !matches!(source, "memory-cycle" | "schedule" | "webhook" | "native-web-search" | "cache-warm" | "exec" | "session-title")
}

/// `agentIdOfHomeSession`: the agent id a home session id names, else empty.
fn agent_id_of_home_session(id: &str) -> String {
    id.strip_prefix("agent-home:").unwrap_or("").to_owned()
}

/// What internal run a source names; empty for the user's own conversation.
fn internal_kind(source: &str) -> String {
    let id = mixdog_js::js_trim(source).to_lowercase();
    if id == "session-title" {
        return id;
    }
    let hidden = !id.is_empty() && !is_lead_visible(&id);
    if hidden && (id == "exec" || !is_conversation_source(Some(&id))) { id } else { String::new() }
}

pub struct UsageService {
    ledger: Arc<dyn LedgerAccess>,
    sessions: Arc<dyn SessionMetadata>,
    sources: Arc<dyn UsageSources>,
    accounts: AccountStore,
    dashboards: Arc<Dashboards>,
}

impl UsageService {
    pub fn new(
        ledger: Arc<dyn LedgerAccess>,
        sessions: Arc<dyn SessionMetadata>,
        sources: Arc<dyn UsageSources>,
        accounts: AccountStore,
        dashboards: Arc<Dashboards>,
    ) -> Arc<Self> {
        Arc::new(Self { ledger, sessions, sources, accounts, dashboards })
    }

    async fn get_usage_requests(&self, options: Value) -> Result<Value, CoreError> {
        let options: UsageRequestsOptions =
            serde_json::from_value(options).map_err(|e| invalid("options", &e.to_string()))?;
        let ledger = self.ledger.ledger().map_err(|e| ledger_failure(e, DOMAIN))?;
        // Settled first, so a send's record is in the page requested after it.
        let mut page = ledger.get_usage_requests(options, now_ms()).await.map_err(|e| ledger_failure(e, DOMAIN))?;
        let requests = page["requests"].as_array().cloned().unwrap_or_default();
        page["requests"] = Value::Array(self.describe(requests).await);
        Ok(page)
    }

    /// `describeRequestSessions`: the title/role/kind each request is named by.
    async fn describe(&self, requests: Vec<Value>) -> Vec<Value> {
        let mut labels: Vec<(String, Value)> = Vec::new();
        let mut cache: Vec<(String, Option<Value>)> = Vec::new();
        let mut out = Vec::new();
        for mut request in requests {
            let s = |k: &str| request.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
            let (sid, owner, source) = (s("sessionId"), s("ownerSessionId"), s("sourceType"));
            let key = format!("{sid}\u{0}{owner}\u{0}{source}");
            if !labels.iter().any(|(k, _)| *k == key) {
                let label = self.label(&mut cache, &sid, &owner, &source).await;
                labels.push((key.clone(), label));
            }
            let label = labels.iter().find(|(k, _)| *k == key).map(|(_, l)| l.clone()).unwrap_or_default();
            if let Some(map) = request.as_object_mut() {
                map.shift_remove("ownerSessionId");
                map.shift_remove("sourceType");
                map.insert("sessionTitle".into(), label["title"].clone());
                map.insert("agentRole".into(), label["role"].clone());
                map.insert("agent".into(), label["agent"].clone());
                map.insert("internalKind".into(), label.get("internalKind").cloned().unwrap_or(json!("")));
                map.insert("backgroundKind".into(), label.get("backgroundKind").cloned().unwrap_or(json!("")));
            }
            out.push(request);
        }
        out
    }

    async fn label(&self, cache: &mut Vec<(String, Option<Value>)>, sid: &str, owner: &str, source: &str) -> Value {
        let own = self.read(cache, sid).await;
        let own_source = own.as_ref().and_then(|o| o.get("sourceType")).and_then(Value::as_str).unwrap_or("");
        let kind = internal_kind(if source.is_empty() { own_source } else { source });
        let title_of = |meta: Option<&Value>, id: &str| -> String {
            match meta.and_then(|v| v.get("title")).and_then(Value::as_str).filter(|t| !t.is_empty()) {
                Some(t) => t.to_owned(),
                None => agent_id_of_home_session(id),
            }
        };
        let openable = own.as_ref().is_some_and(|o| {
            let agent = truthy(o.get("agent"));
            let own_owner = o.get("ownerSessionId").and_then(Value::as_str).unwrap_or("");
            let own_source = o.get("sourceType").and_then(Value::as_str).unwrap_or("");
            internal_kind(own_source).is_empty()
                && ((agent && (!own_owner.is_empty() || !owner.is_empty())) || is_lead_visible(own_source))
        });
        if !kind.is_empty() && !openable {
            return json!({ "title": "", "role": "", "agent": false, "internalKind": kind });
        }
        let owner_id = own
            .as_ref()
            .and_then(|o| o.get("ownerSessionId").and_then(Value::as_str))
            .filter(|o| !o.is_empty())
            .map_or(owner.to_owned(), str::to_owned);
        let mut label = json!({ "title": title_of(own.as_ref(), sid), "role": "", "agent": false });
        let own_is_agent = own.as_ref().is_none_or(|o| truthy(o.get("agent")));
        if !owner_id.is_empty() && owner_id != sid && own_is_agent {
            let owner_meta = self.read(cache, &owner_id).await;
            let role = own.as_ref().and_then(|o| o.get("agent")).filter(|a| truthy(Some(a))).cloned();
            label = json!({
                "title": title_of(owner_meta.as_ref(), &owner_id),
                "role": role.unwrap_or_else(|| json!("")),
                "agent": true,
            });
        }
        label["backgroundKind"] = json!(kind);
        label
    }

    async fn read(&self, cache: &mut Vec<(String, Option<Value>)>, id: &str) -> Option<Value> {
        if id.is_empty() {
            return None;
        }
        if let Some((_, v)) = cache.iter().find(|(k, _)| k == id) {
            return v.clone();
        }
        let v = self.sessions.metadata(id).await;
        cache.push((id.to_owned(), v.clone()));
        v
    }
}

#[async_trait]
impl DomainService for UsageService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let options = match req.params.get("options") {
            Some(v) if !v.is_null() => v.clone(),
            _ => json!({}),
        };
        let value = match req.method.as_str() {
            "usage/getUsageDashboard" => self
                .dashboards
                .get(&options, self.sources.as_ref(), &self.accounts)
                .await
                .map_err(|f| f.into_core(DOMAIN))?,
            "usage/getUsageStats" => {
                let options: UsageStatsOptions =
                    serde_json::from_value(options).map_err(|e| invalid("options", &e.to_string()))?;
                self.ledger.ledger().map_err(|e| ledger_failure(e, DOMAIN))?.get_usage_stats(options, now_ms).await.map_err(|e| ledger_failure(e, DOMAIN))?
            }
            "usage/getUsageRequests" => self.get_usage_requests(options).await?,
            other => return Err(wrong_method(DOMAIN, other)),
        };
        Ok(Reply::Value(value))
    }

    fn methods(&self) -> &'static [&'static str] {
        &["usage/getUsageDashboard", "usage/getUsageStats", "usage/getUsageRequests"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
