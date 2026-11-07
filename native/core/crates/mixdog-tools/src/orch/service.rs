//! `setup`, `media` and `tidy`: model-facing front ends of services that own their own state and
//! access rules (settings actor, media jobs, formatter engines). The tool carries the exact
//! definition and cancellation; the service validates its actions, applies the caller-scope
//! rules (interactive callers only for `setup` writes, approvals never remembered) and answers.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use tokio_util::sync::CancellationToken;

use super::util::PortError;
use super::util::cancelled;
use super::util::spec_from_def;

/// One call into a tool service.
pub struct ServiceCall<'a> {
    pub thread: &'a ThreadId,
    pub surface: SurfaceKind,
    pub cwd: &'a AbsPath,
    pub args: &'a JsonValue,
    pub cancel: &'a CancellationToken,
}

#[async_trait]
pub trait ToolService: Send + Sync {
    /// The reply parts; a refusal or failure is a typed [`PortError`] with the existing text.
    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError>;
}

pub struct ServiceTool {
    spec: ToolSpec,
    service: Arc<dyn ToolService>,
}

impl ServiceTool {
    pub fn setup(service: Arc<dyn ToolService>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/setup.json"), false, &["setup"]), service }
    }

    /// Media jobs run in the background; several calls may overlap.
    pub fn media(service: Arc<dyn ToolService>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/media.json"), true, &[]), service }
    }

    pub fn tidy(service: Arc<dyn ToolService>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/tidy.json"), false, &["tidy"]), service }
    }

    /// Standing user memory; it writes, so it runs apart from other calls.
    pub fn memory(service: Arc<dyn ToolService>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/memory.json"), false, &[]), service }
    }

    /// Stored session history; read-only, so calls may overlap (`readOnlyHint`).
    pub fn recall(service: Arc<dyn ToolService>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/recall.json"), true, &[]), service }
    }
}

#[async_trait]
impl Tool for ServiceTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        if self.spec.name == "setup" {
            super::setup_input::validate(&args, &self.spec.input_schema)?;
        }
        let call = ServiceCall { thread: &ctx.thread_id, surface: ctx.surface, cwd: &ctx.cwd, args: &args, cancel: &ctx.cancel };
        let parts = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(cancelled()),
            r = self.service.call(call) => r?,
        };
        Ok(ToolOutput { parts, ..ToolOutput::default() })
    }
}
