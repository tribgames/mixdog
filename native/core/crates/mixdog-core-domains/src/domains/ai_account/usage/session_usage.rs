//! `thread/getSessionUsage` (`usage-stats-api.mjs` `getSessionUsage`): one session's totals from
//! its first request, plus the sessions it names and, on request, the agents it ran.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::ACCOUNT_PROVIDERS;
use mixdog_ai::accounts::AccountStore;
use mixdog_app_protocol::v2::params::ThreadGetSessionUsageParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::wrong_method;
use mixdog_core_base::support::failed;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::has_session;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_ledger::stats::session_usage_snapshot;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::DOMAIN;
use super::LedgerAccess;
use crate::domains::ai_account::failure::ledger_failure;

const METHOD: &str = "thread/getSessionUsage";
const MAX_SESSION_USAGE_IDS: usize = 64;

/// `accountScopedSessionId`: the provider-side session one account sent a session under.
pub fn account_scoped_session_id(provider: &str, account_id: &str, session_id: &str) -> String {
    let digest = Sha256::digest(format!("{provider}:{account_id}:{session_id}"));
    format!("account-{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// `otherSessionIds`: the distinct non-empty ids named beside the caller's own, at most 64.
pub fn other_session_ids(options: Option<&Value>, session_id: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in options.and_then(|o| o.get("sessionIds")).and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = id.as_str().filter(|id| !id.is_empty() && *id != session_id) {
            if !ids.iter().any(|seen| seen == id) {
                ids.push(id.to_owned());
            }
        }
        if ids.len() >= MAX_SESSION_USAGE_IDS {
            break;
        }
    }
    ids
}

pub struct SessionUsageService {
    ledger: Arc<dyn LedgerAccess>,
    accounts: AccountStore,
    /// The thread records, for whether a thread has its session yet (`has_session`).
    threads: Arc<dyn ThreadState>,
    messages: Arc<dyn ThreadMessages>,
}

impl SessionUsageService {
    pub fn new(ledger: Arc<dyn LedgerAccess>, accounts: AccountStore, threads: Arc<dyn ThreadState>, messages: Arc<dyn ThreadMessages>) -> Arc<Self> {
        Arc::new(Self { ledger, accounts, threads, messages })
    }

    /// `sessionUsageIdsFor`: the session's own id and the per-account ids it sent under.
    fn ids_for(scopes: &[(&'static str, Vec<String>)], session_id: &str) -> Vec<String> {
        let mut ids = vec![session_id.to_owned()];
        for (provider, accounts) in scopes {
            ids.extend(accounts.iter().map(|account| account_scoped_session_id(provider, account, session_id)));
        }
        ids
    }

    /// `accountScopes`: an unreadable pool leaves that provider's older records out.
    async fn scopes(&self) -> Vec<(&'static str, Vec<String>)> {
        let mut scopes = Vec::new();
        for provider in ACCOUNT_PROVIDERS {
            if let Ok(accounts) = self.accounts.accounts(provider).await {
                scopes.push((provider, accounts.into_iter().map(|account| account.id).collect()));
            }
        }
        scopes
    }

    async fn totals(&self, ids: Vec<String>, owners: Vec<String>) -> Result<Value, CoreError> {
        let ledger = self.ledger.ledger().await.map_err(|e| ledger_failure(e, DOMAIN))?;
        let bucket = ledger.session_usage(ids, owners).await.map_err(|e| ledger_failure(e, DOMAIN))?;
        Ok(session_usage_snapshot(&bucket))
    }

    pub async fn read(&self, session_id: &str, options: Option<&Value>) -> Result<Value, CoreError> {
        let others = other_session_ids(options, session_id);
        let agents = options.and_then(|o| o.get("agents")) == Some(&Value::Bool(true));
        let scopes = self.scopes().await;
        let mut result = Map::new();
        result.insert("sessionId".into(), Value::String(session_id.to_owned()));
        if let Value::Object(own) = self.totals(Self::ids_for(&scopes, session_id), vec![]).await? {
            result.extend(own);
        }
        if agents {
            let named = others.iter().flat_map(|id| Self::ids_for(&scopes, id)).collect();
            result.insert("agents".into(), self.totals(named, vec![session_id.to_owned()]).await?);
        }
        if others.is_empty() {
            return Ok(Value::Object(result));
        }
        let mut sessions = Map::new();
        for id in &others {
            sessions.insert(id.clone(), self.totals(Self::ids_for(&scopes, id), vec![]).await?);
        }
        result.insert("sessions".into(), Value::Object(sessions));
        Ok(Value::Object(result))
    }
}

#[async_trait]
impl DomainService for SessionUsageService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != METHOD {
            return Err(wrong_method(DOMAIN, req.method.as_str()));
        }
        let params: ThreadGetSessionUsageParams = decode(&req)?;
        // No session is `getSessionId()` null: the answer is null.
        let Some(thread) = params.thread_id else { return Ok(Reply::Value(Value::Null)) };
        // A thread with no session yet is `getSessionId()` null as well. A thread the directory does not know is a session
        // that ran and is gone: its totals are still in the ledger.
        if let Ok(header) = self.threads.header(&thread).await {
            let rows = self.messages.messages(&thread).await.map_err(|e| failed(DOMAIN, format!("{e:?}")))?;
            if !has_session(&header, &rows) {
                return Ok(Reply::Value(Value::Null));
            }
        }
        self.read(thread.as_str(), params.options.as_ref()).await.map(Reply::Value)
    }

    fn methods(&self) -> &'static [&'static str] {
        &[METHOD]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "session_usage_tests.rs"]
mod tests;
