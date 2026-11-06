//! The session actions `thread/agentControl` (`agentControl` of `turn/agent-ops.mjs`),
//! `thread/stageAttachmentOriginal` and `thread/resizeImage` (`stageAttachmentOriginal` and
//! `resizeImage` of `session-api/media.mjs`). The app-server hands them to this domain instead of
//! the thread's actor: none reads or changes what only the actor owns; they act on the agent
//! runtime, the staged-originals store and the image host, and only name the thread. Each
//! answers the action's own value, as the session action lane returns it as `value`.
//!
//! A request without a `threadId` is refused: the 1.4.5 daemon hosted one session and answered
//! such a call for it, the core hosts many.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::AgentRuntime;
use mixdog_agent::agent_tool::scope::Caller;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::clean;
use mixdog_agent::agent_tool::scope::positive_int;
use mixdog_app_protocol::v2::params::ThreadAgentControlParams;
use mixdog_app_protocol::v2::params::ThreadResizeImageParams;
use mixdog_app_protocol::v2::params::ThreadStageAttachmentOriginalParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::composer_image;
use super::staged_originals::STAGED_ORIGINALS_MAX_BYTES;
use super::staged_originals::STAGED_ORIGINALS_TTL_MS;
use super::staged_originals::StageLimits;

pub const AGENT_CONTROL: &str = "thread/agentControl";
pub const STAGE_ATTACHMENT_ORIGINAL: &str = "thread/stageAttachmentOriginal";
pub const RESIZE_IMAGE: &str = "thread/resizeImage";

pub struct TurnActionsService {
    directory: Arc<SessionDirectory>,
    agents: Arc<AgentRuntime>,
    resizer: Arc<dyn ProfiledImageResizer>,
    ops: OpScopes,
}

/// `agentControl`'s context for the agent tool: the caller is the session itself, in the folder
/// it is in, under the host pid it was opened by (the daemon's own when it has none).
pub(super) fn control_caller(thread: &ThreadId, header: &mixdog_store::schema::record::Header) -> Caller {
    Caller {
        scope: Scope {
            caller_session_id: Some(thread.as_str().to_owned()),
            host_pid: Some(positive_int(header.get("clientHostPid")).unwrap_or_else(|| u64::from(std::process::id()))),
        },
        cwd: clean(header.get("cwd")),
    }
}

/// `agentTool.execute(args, context)` and the text it answers: the agent tool's own failures are
/// its answer, so this does not fail.
pub(super) async fn run_agent_control(agents: &AgentRuntime, caller: &Caller, args: Option<Value>) -> Value {
    let args = args.unwrap_or_else(|| json!({}));
    let reply = agents.handle(&args, caller).await;
    Value::String(mixdog_tools::orch::agent::render(&reply, &clean(args.get("tag"))))
}

/// A thrown `Error`: its message is the whole answer.
fn thrown(message: impl Into<String>) -> CoreError {
    failed("session", message)
}

fn thread_of(id: Option<ThreadId>) -> Result<ThreadId, CoreError> {
    id.ok_or_else(|| invalid("threadId", "the thread to act on"))
}

impl TurnActionsService {
    pub fn new(
        directory: Arc<SessionDirectory>,
        agents: Arc<AgentRuntime>,
        resizer: Arc<dyn ProfiledImageResizer>,
        ops: OpScopes,
    ) -> Self {
        Self { directory, agents, resizer, ops }
    }

    async fn header(&self, thread: &ThreadId) -> Result<mixdog_store::schema::record::Header, CoreError> {
        self.directory.stored_header(thread).await.ok_or_else(|| CoreError::ThreadNotFound { thread_id: thread.clone() })
    }

    /// `agentControl(args)`: `agentTool.execute(args, { callerCwd, invocationSource:
    /// 'user-command', callerSessionId, clientHostPid })`; the answer is the tool's text.
    async fn agent_control(&self, thread: &ThreadId, args: Option<Value>) -> Result<Value, CoreError> {
        let caller = control_caller(thread, &self.header(thread).await?);
        Ok(run_agent_control(&self.agents, &caller, args).await)
    }

    async fn stage(&self, bytes: Vec<u8>) -> Result<String, String> {
        let deps = self.directory.deps();
        let originals = deps.staged_originals.clone();
        let limits = StageLimits {
            now_ms: deps.clock.now_ms(),
            max_bytes: STAGED_ORIGINALS_MAX_BYTES,
            ttl_ms: STAGED_ORIGINALS_TTL_MS,
        };
        on_lane(deps.lanes.durability, &mixdog_rt::CancellationToken::new(), move |lane| originals.stage(lane, &bytes, limits))
            .await
            .map_err(|error| format!("{error:?}"))?
    }

    /// `stageAttachmentOriginal({ data })`: `{ originalRef }`.
    async fn stage_original(&self, input: &Value) -> Result<Value, CoreError> {
        composer_image::stage_original_payload(input, |bytes| self.stage(bytes)).await.map_err(thrown)
    }

    /// `resizeImage({ data, mimeType, source })`: the profiled resize of the thread's provider.
    async fn resize(&self, thread: &ThreadId, input: &Value) -> Result<Value, CoreError> {
        let header = self.header(thread).await?;
        let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned();
        let stage = |bytes: Vec<u8>| self.stage(bytes);
        composer_image::resize_image(self.resizer.as_ref(), thread, input, &provider, stage).await.map_err(thrown)
    }
}

#[async_trait]
impl DomainService for TurnActionsService {
    fn methods(&self) -> &'static [&'static str] {
        &[AGENT_CONTROL, STAGE_ATTACHMENT_ORIGINAL, RESIZE_IMAGE]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            AGENT_CONTROL => {
                let params: ThreadAgentControlParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                // A duplicate whose answer was too large to keep must not run the agent again.
                let replay = || async { Err(thrown("The recorded answer of this agent control was too large to replay.")) };
                self.ops.run(&req, None, || self.agent_control(&thread, params.args), replay).await
            }
            STAGE_ATTACHMENT_ORIGINAL => {
                let params: ThreadStageAttachmentOriginalParams = decode(&req)?;
                thread_of(params.thread_id)?;
                self.ops.run(&req, None, || self.stage_original(&params.input), || self.stage_original(&params.input)).await
            }
            RESIZE_IMAGE => {
                let params: ThreadResizeImageParams = decode(&req)?;
                let thread = thread_of(params.thread_id)?;
                self.ops.run(&req, None, || self.resize(&thread, &params.input), || self.resize(&thread, &params.input)).await
            }
            other => Err(wrong_method("thread turn actions", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
