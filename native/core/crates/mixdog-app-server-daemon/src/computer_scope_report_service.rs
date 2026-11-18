//! `host/computer/scopeReport` (desktop → core, a notification): a revoked automation scope's report changed at the desktop (a
//! release or compensation returned, an executor ended). The pool keeps it on the scope when its revision is newer than the one it
//! holds. Ownership follows submitted work: the core stamps each request of a scope's desktop work with the Computer claim it was
//! submitted under (`ScopedDesktop`, `HostChannel::claim_generation`), and a scope's report counts only from the claim that took
//! all of it (`Authority::record_desktop`). A report from a connection that does not hold the Computer claim
//! (`Outgoing::serves_capability`) is refused here. When a connection ends, every settling scope whose desktop work went to a claim
//! that no longer serves is unconfirmed there (`ComputerSessionPool::desktop_detached`); other scopes are untouched.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::computer_host::HostComputerScopeReportParams;
use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use serde_json::Value;

use crate::browser_engine_service::ClaimantProbe;
use crate::connection_close::ConnectionOwner;

const SCOPE_REPORT: &str = "host/computer/scopeReport";

/// The connection `host/computer/revokeScopes` is dispatched to: the claim whose scope reports count (the pool reads its generation
/// through the same selection).
pub struct ComputerClaimants(pub Arc<mixdog_app_server::Outgoing>);

impl ClaimantProbe for ComputerClaimants {
    fn is_claimant(&self, connection: ConnectionId) -> bool {
        let revoke = Method(mixdog_tools::desktop::computer_authority::REVOKE_SCOPES_METHOD);
        self.0.serves_method_of(connection, mixdog_core_api::HostCapability::Computer, revoke)
    }
}

/// Serves the notification over the pool; `None` where no pool exists, which leaves no scope to report.
pub struct ComputerScopeReportService {
    pool: Option<Arc<ComputerSessionPool>>,
    claimants: Arc<dyn ClaimantProbe>,
}

impl ComputerScopeReportService {
    pub fn new(pool: Option<Arc<ComputerSessionPool>>, claimants: Arc<dyn ClaimantProbe>) -> Self {
        Self { pool, claimants }
    }
}

#[async_trait]
impl DomainService for ComputerScopeReportService {
    fn methods(&self) -> &'static [&'static str] {
        &[SCOPE_REPORT]
    }

    /// A notification only: a request of it is not one the protocol has.
    async fn call(&self, _request: CoreRequest) -> Result<Reply, CoreError> {
        Err(CoreError::InvalidParams { path: "method".into(), expected: "a notification".into() })
    }

    /// A line that is not `{report}`, or one from a connection that does not hold the Computer claim, is dropped: a notification
    /// has no one to answer.
    fn notify(&self, _method: Method, params: Value, from: ConnectionId) -> Admit {
        let (Some(pool), Ok(params)) = (&self.pool, serde_json::from_value::<HostComputerScopeReportParams>(params)) else {
            return Admit::Accepted;
        };
        if !self.claimants.is_claimant(from) {
            return Admit::Accepted;
        }
        if let Ok(report) = serde_json::to_value(params.report) {
            pool.desktop_scope_report(report);
        }
        Admit::Accepted
    }
}

impl ConnectionOwner for ComputerScopeReportService {
    /// A connection ended (its claim, if it held one, is already gone from the claim table): the scopes whose desktop work went to a
    /// claim that no longer serves cannot be reported settled any more.
    fn connection_closed(&self, _connection: ConnectionId) {
        if let Some(pool) = &self.pool {
            pool.desktop_detached();
        }
    }
}
