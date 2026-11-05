//! The `tidy/` namespace: `getTidyEngineStatus`, `getTidyInstallStatus`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use serde_json::Value;

use super::install_job::InstallJob;
use super::status::{EngineResolver, tidy_engine_status};

pub struct TidyService {
    resolver: Arc<dyn EngineResolver>,
    install: Arc<InstallJob>,
}

impl TidyService {
    pub fn new(resolver: Arc<dyn EngineResolver>, install: Arc<InstallJob>) -> Self {
        Self { resolver, install }
    }
}

#[async_trait]
impl DomainService for TidyService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "tidy/getTidyEngineStatus" => Ok(Reply::Value(tidy_engine_status(self.resolver.as_ref(), &self.install).await)),
            "tidy/getTidyInstallStatus" => Ok(Reply::Value(self.install.status())),
            _ => Err(CoreError::InvalidParams { path: "method".into(), expected: "tidy/*".into() }),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["tidy/getTidyEngineStatus", "tidy/getTidyInstallStatus"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
