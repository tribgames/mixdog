//! The one login session type of every provider: a state feed
//! ([`LoginSession::next`] delivers each state once, the last is terminal), a
//! pasted-input channel, cancel, and a single-flow guard per flow. A flow
//! supplies only its body ([`start_session`]); it ends when the provider says
//! so, the user cancels, or a device code's own expiry passes. No timer
//! decides a login outcome.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_rt::TaskClass;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Shared {
    state: Mutex<(u64, LoginState)>,
    delivered: Mutex<u64>,
    changed: Notify,
}

impl Shared {
    fn set(&self, next: LoginState) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.1.is_terminal() {
            return;
        }
        *state = (state.0 + 1, next);
        drop(state);
        self.changed.notify_waiters();
    }
}

/// What a running flow can do to its session.
pub struct FlowCtx {
    shared: Arc<Shared>,
    /// Text the user pasted (flows that take input).
    pub pasted: mpsc::UnboundedReceiver<String>,
}

impl FlowCtx {
    pub fn set(&self, state: LoginState) {
        self.shared.set(state);
    }
}

/// Frees the flow for the next `start` however the session ends. A flow keeps
/// an `Arc<AtomicBool>` and claims it in `start`.
pub struct FlowGuard(Arc<AtomicBool>);

impl FlowGuard {
    /// `None` while another session of the flow is alive.
    pub fn claim(flag: &Arc<AtomicBool>) -> Option<Self> {
        (!flag.swap(true, Ordering::AcqRel)).then(|| Self(flag.clone()))
    }
}

impl Drop for FlowGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct Session {
    shared: Arc<Shared>,
    pasted: Option<mpsc::UnboundedSender<String>>,
    cancel: CancellationToken,
}

#[async_trait]
impl LoginSession for Session {
    fn state(&self) -> LoginState {
        self.shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .1
            .clone()
    }

    async fn next(&self) -> Option<LoginState> {
        loop {
            let notified = self.shared.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (version, state) = self
                .shared
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            {
                let mut delivered = self
                    .shared
                    .delivered
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if version > *delivered {
                    *delivered = version;
                    return Some(state);
                }
                if state.is_terminal() {
                    return None;
                }
            }
            notified.await;
        }
    }

    async fn provide(&self, input: LoginInput) -> Result<(), LoginError> {
        if self.state().is_terminal() {
            return Err(LoginError::Finished);
        }
        let Some(pasted) = &self.pasted else {
            return Err(LoginError::InputNotExpected);
        };
        let LoginInput::AuthorizationCode(text) = input;
        pasted.send(text).map_err(|_| LoginError::Finished)
    }

    fn cancel(&self) {
        self.cancel.cancel();
    }
}

/// Runs `run` as one login: its `Ok` account label is `Done`, its failure is
/// `Failed`, and a cancel ends it as `Cancelled` before either. `first` is
/// the initial state; `takes_input` says whether `provide` is accepted.
pub fn start_session<F, Fut>(
    guard: FlowGuard,
    first: LoginState,
    takes_input: bool,
    run: F,
) -> Box<dyn LoginSession>
where
    F: FnOnce(FlowCtx, CancellationToken) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<Option<String>, LoginFailure>> + Send + 'static,
{
    let shared = Arc::new(Shared {
        state: Mutex::new((1, first)),
        delivered: Mutex::new(0),
        changed: Notify::new(),
    });
    let cancel = CancellationToken::new();
    let (tx, rx) = mpsc::unbounded_channel();
    let ctx = FlowCtx {
        shared: shared.clone(),
        pasted: rx,
    };
    let task_shared = shared.clone();
    let task_cancel = cancel.clone();
    mixdog_rt::spawn("ai.oauth.login", TaskClass::Work, async move {
        let _guard = guard;
        let outcome = tokio::select! {
            () = task_cancel.cancelled() => {
                task_shared.set(LoginState::Cancelled);
                return;
            }
            outcome = run(ctx, task_cancel.clone()) => outcome,
        };
        task_shared.set(match outcome {
            Ok(account) => LoginState::Done { account },
            Err(failure) => LoginState::Failed(failure),
        });
    });
    Box::new(Session {
        shared,
        pasted: takes_input.then_some(tx),
        cancel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::http::call;
    use crate::oauth::http::testing::Scripted;
    use crate::oauth::http::testing::finish;

    fn authorize() -> LoginState {
        LoginState::Authorize {
            url: "https://auth.test/a".into(),
            manual_url: None,
        }
    }

    #[tokio::test]
    async fn a_flow_body_ends_as_done_with_each_state_delivered_once() {
        mixdog_rt::testing::tokens();
        let flag = Arc::new(AtomicBool::new(false));
        let guard = FlowGuard::claim(&flag).unwrap();
        assert!(FlowGuard::claim(&flag).is_none(), "one session at a time");
        let http = Scripted::new(&[(200, r#"{"user":"me"}"#)]);
        let session = start_session(guard, authorize(), false, move |ctx, _| async move {
            ctx.set(LoginState::Waiting);
            let reply = call(&*http, "GET", "https://x.test/whoami", Vec::new(), Vec::new()).await?;
            Ok(reply.json().and_then(|j| j["user"].as_str().map(str::to_owned)))
        });
        let states = finish(&*session).await;
        assert_eq!(states.first(), Some(&authorize()));
        assert_eq!(states.last(), Some(&LoginState::Done { account: Some("me".into()) }));
        assert_eq!(states.iter().filter(|s| s.is_terminal()).count(), 1);
        assert!(matches!(
            session.provide(LoginInput::AuthorizationCode("x".into())).await,
            Err(LoginError::Finished)
        ));
        assert!(FlowGuard::claim(&flag).is_some(), "the flow is free again");
    }

    #[tokio::test]
    async fn input_is_refused_when_the_flow_takes_none_and_cancel_ends_it() {
        mixdog_rt::testing::tokens();
        let flag = Arc::new(AtomicBool::new(false));
        let session = start_session(FlowGuard::claim(&flag).unwrap(), authorize(), false, |_, _| async {
            std::future::pending::<Result<Option<String>, LoginFailure>>().await
        });
        assert!(matches!(
            session.provide(LoginInput::AuthorizationCode("x".into())).await,
            Err(LoginError::InputNotExpected)
        ));
        session.cancel();
        assert_eq!(finish(&*session).await.last(), Some(&LoginState::Cancelled));
        assert!(FlowGuard::claim(&flag).is_some());
    }
}
