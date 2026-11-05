//! Plumbing the domain services of this module share: params decoding, coded failures that
//! carry a sentence for the user, lane jobs, and the op gate of a mutation (P §9).

use std::future::Future;
use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::DomainErrorDetail;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::ops::AppliedOp;
use crate::ops::Begin;
use crate::ops::OpGate;
use crate::ops::OpOutcome;
use crate::ops::OpRequest;
use crate::ops::ThreadOpGates;

/// An applied result larger than this is not stored with the op (P §9.3): a duplicate
/// reproduces it instead.
const STORED_RESULT_MAX: usize = 16 * 1024;

pub(crate) fn decode<T: DeserializeOwned>(req: &CoreRequest) -> Result<T, CoreError> {
    serde_json::from_value(req.params.clone()).map_err(|error| CoreError::InvalidParams {
        path: "params".into(),
        expected: error.to_string().into(),
    })
}

pub(crate) fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams {
        path: path.into(),
        expected: expected.into(),
    }
}

/// The method does not belong to the service it reached.
pub(crate) fn wrong_method(namespace: &str, method: &str) -> CoreError {
    invalid("method", &format!("a method of {namespace}, not {method}"))
}

/// A refusal the user reads verbatim: `code` is the stable part, `message` the sentence the
/// 1.4.5 daemon answered with.
pub(crate) fn failed(domain: &'static str, code: &'static str, message: impl Into<String>) -> CoreError {
    CoreError::DomainError {
        domain: domain.into(),
        code: code.into(),
        detail: Some(Box::new(DomainErrorDetail::CommandFailed {
            message: message.into(),
        })),
    }
}

/// Runs `job` on `lane`. A full queue answers `queueFull` at once; a cancelled caller drops
/// a job that has not started.
pub(crate) async fn on_lane<L, R, F>(lane: L, cancel: &CancellationToken, job: F) -> Result<R, CoreError>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    lane.submit(cancel, job)?
        .await
        .map_err(|_| CoreError::Cancelled { by: "caller".into() })
}

/// The op gates of the mutating methods of one domain: its own scope's gate, and the
/// thread directory's for a request that names a thread (`thread_or_none(thread_id)`).
#[derive(Clone)]
pub struct OpScopes {
    domain: OpGate,
    threads: Arc<dyn ThreadOpGates>,
}

impl OpScopes {
    pub fn new(domain: OpGate, threads: Arc<dyn ThreadOpGates>) -> Self {
        Self { domain, threads }
    }

    /// Runs one mutation once per `(scope, opId)`: a duplicate answers the recorded outcome
    /// without executing. `external` brackets an action that leaves the process
    /// (`effect`, `target`), so a crash in between reads as `externalOutcomeUnknown`.
    /// `reproduce` rebuilds the result of a duplicate whose result was too large to store.
    pub async fn run<E, EF, R, RF>(
        &self,
        req: &CoreRequest,
        external: Option<(&'static str, String)>,
        execute: E,
        reproduce: R,
    ) -> Result<Reply, CoreError>
    where
        E: FnOnce() -> EF,
        EF: Future<Output = Result<Value, CoreError>>,
        R: FnOnce() -> RF,
        RF: Future<Output = Result<Value, CoreError>>,
    {
        let id = req.op.clone().ok_or(CoreError::OpIdRequired)?;
        let thread = req.params.get("threadId").and_then(Value::as_str).map(ThreadId::from);
        let gate = match thread {
            Some(thread) => self.threads.gate(&thread, &req.ctx).await?,
            None => self.domain.clone(),
        };
        let op = OpRequest::new(id.clone(), req.method.as_str(), &req.params);
        let ticket = match gate.begin(&op, &req.ctx).await? {
            Begin::Done(outcome) => {
                let AppliedOp { result, .. } = outcome.into_result(&id)?;
                return match result {
                    Some(value) => Ok(Reply::Value(value)),
                    None => reproduce().await.map(Reply::Value),
                };
            }
            Begin::Execute(ticket) => ticket,
        };
        if let Some((effect, target)) = external {
            ticket.external_pending(effect.into(), target.into()).await?;
        }
        match execute().await {
            Ok(value) => {
                let stored = (value.to_string().len() <= STORED_RESULT_MAX).then(|| value.clone());
                ticket
                    .finish(OpOutcome::Applied(AppliedOp { seq: None, result: stored }))
                    .await?;
                Ok(Reply::Value(value))
            }
            Err(error) => {
                ticket.finish(OpOutcome::Rejected(error.clone())).await?;
                Err(error)
            }
        }
    }
}

/// What JavaScript's `trim()` treats as space.
pub(crate) fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Fixtures the tests of every domain service share.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Arc;

    use async_trait::async_trait;
    use mixdog_core_api::CoreError;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::ids::OpId;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_api::ops::OpScope;
    use mixdog_core_api::service::DomainService;
    use mixdog_store::state::CoreState;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::ops::StateOpStore;

    /// Every thread shares the domain's gate: the tests need an op record, not a thread actor.
    struct SharedGate(OpGate);

    #[async_trait]
    impl ThreadOpGates for SharedGate {
        async fn gate(&self, _thread: &ThreadId, _ctx: &CallContext) -> Result<OpGate, CoreError> {
            Ok(self.0.clone())
        }
    }

    /// The op scopes of domain `name` over a `state/core.sqlite` in `dir`.
    pub(crate) async fn scopes(dir: &std::path::Path, name: &str) -> OpScopes {
        let t = mixdog_rt::testing::tokens();
        let state = CoreState::open(t.sqlite_writer_thread, t.interactive_io, &dir.join("core.sqlite")).unwrap().0;
        let store = Arc::new(StateOpStore::new(state, name.into()));
        let gate = OpGate::domain(OpScope::Domain(name.into()), store).await.unwrap();
        OpScopes::new(gate.clone(), Arc::new(SharedGate(gate)))
    }

    pub(crate) fn op(n: u64) -> OpId {
        OpId::from(format!("018f0000-0000-7000-8000-{n:012x}"))
    }

    /// A request of `method` with `params`, as a connection would send it.
    pub(crate) fn request(method: &'static str, params: Value, op_n: Option<u64>) -> CoreRequest {
        CoreRequest {
            method: mixdog_core_api::ids::Method(method),
            params,
            op: op_n.map(op),
            ctx: CallContext::internal("test"),
        }
    }

    /// `params` with the op id the mutation carries.
    pub(crate) fn with_op(mut params: Value, n: u64) -> Value {
        params["opId"] = json!(op(n).as_str());
        params
    }

    pub(crate) async fn value(service: &dyn DomainService, req: CoreRequest) -> Result<Value, CoreError> {
        match service.call(req).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => panic!("never subscribes"),
        }
    }
}
