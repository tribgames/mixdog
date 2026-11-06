//! `AccountingDeps`: what the accounting of a provider send reads that is not the send
//! ([`accounting_deps`]), and the scope of a send over the session directory.
//!
//! Node's `accountProviderSend` (`usage-accounting.mjs:55-79`) reads the send's `opts.session`:
//!
//! - `sessionId = opts.usageSessionId || opts.sessionId || opts.session.id`;
//! - `sourceType = session.sourceType || opts.sourceType || opts.requestKind || ''`;
//! - the owner = `session.ownerSessionId || session.parentSessionId`;
//! - the route-fallback primary = `session.routeFallbackPrimary` while `session.provider` is the
//!   provider the send goes to.

use std::sync::Arc;

use mixdog_ai::accounts::AccountStore;
use mixdog_ai::catalog::CatalogPricing;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::accounted::{AccountingDeps, Scope, SendScope};
use mixdog_ai::registry::accounting::{UsageRow, UsageSink};
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::writer::UsageWriter;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::process::{ProcessServices, SessionHeaders};

/// The text of a header field when it is a non-empty string (JS truthiness of a string).
fn text(header: &Header, key: &str) -> Option<String> {
    header.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// The scope of a send, read from the header of the session it runs for.
pub struct HeaderScope {
    sessions: Arc<dyn SessionHeaders>,
}

impl HeaderScope {
    pub fn new(sessions: Arc<dyn SessionHeaders>) -> Self {
        Self { sessions }
    }
}

impl SendScope for HeaderScope {
    fn of(&self, provider: &str, request: &ModelRequest) -> Scope {
        let options = &request.options;
        let header = options.session_id.as_deref().and_then(|id| self.sessions.header(id));
        let header = header.as_deref();
        let from_header = |key: &str| header.and_then(|h| text(h, key));
        let primary = header
            .filter(|h| text(h, "provider").as_deref() == Some(provider))
            .and_then(|h| h.get("routeFallbackPrimary"))
            .and_then(|primary| {
                let name = primary.get("provider").and_then(Value::as_str).filter(|s| !s.is_empty())?;
                let model = primary.get("model").and_then(Value::as_str).unwrap_or_default();
                Some((name.to_owned(), model.to_owned()))
            });
        Scope {
            session_id: options.usage_session_id.clone().filter(|s| !s.is_empty()).or_else(|| options.session_id.clone().filter(|s| !s.is_empty())).or_else(|| from_header("id")),
            source_type: from_header("sourceType").or_else(|| options.request_kind.clone().filter(|s| !s.is_empty())).unwrap_or_default(),
            owner_session_id: from_header("ownerSessionId").or_else(|| from_header("parentSessionId")),
            primary,
        }
    }
}

/// The ledger's queue: a [`UsageRow`] is the ledger's `UsageRecord` (`recordQueued`).
pub struct LedgerSink(pub Arc<UsageWriter>);

#[async_trait::async_trait]
impl UsageSink for LedgerSink {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        let record: UsageRecord = serde_json::from_value(serde_json::to_value(&row).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        self.0.record_queued(record).await.map_err(|e| e.to_string())
    }
}

/// The single constructor: pricing over the catalog, the ledger read per send, the scope over the
/// session directory, and the account of an account provider.
pub fn accounting_deps(p: &ProcessServices) -> AccountingDeps {
    let io = CredentialIo { read: p.lanes.interactive_io, write: p.lanes.durability_io };
    let mut deps = AccountingDeps::new(Arc::new(CatalogPricing(p.catalog.clone())), p.ledger.clone());
    deps.scope = Arc::new(HeaderScope::new(p.sessions.clone()));
    deps.account = Arc::new(AccountStore::new(p.plugin_data.clone(), io));
    deps
}
