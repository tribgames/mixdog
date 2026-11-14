//! Owner: s4-engine-settle
//! Retry only read-only preflight failures, never an input or its verification (`actionability.ts`).

use std::fmt;
use std::future::Future;
use std::time::Duration;

use mixdog_rt::CancelView;
use mixdog_rt::time;

use super::settle::Cancelled;
use super::settle::pause;
use super::settle::throw_if_cancelled;

/// How long a target may take to become actionable (`waitForBrowserActionable`'s default).
pub const ACTIONABILITY_TIMEOUT: Duration = Duration::from_millis(5_000);
/// How long to wait between two probes at most.
const ACTIONABILITY_POLL: Duration = Duration::from_millis(100);

/// A target that is not ready yet (disabled, covered, not editable): the one failure a preflight is retried for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionabilityError {
    pub message: String,
    /// A short machine word for why (`disabled`, `covered`, `not-editable`).
    pub reason: String,
}

impl ActionabilityError {
    pub fn new(message: impl Into<String>, reason: impl Into<String>) -> Self {
        Self { message: message.into(), reason: reason.into() }
    }
}

impl fmt::Display for ActionabilityError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.message)
    }
}

impl std::error::Error for ActionabilityError {}

/// How a probe failed: not ready yet, or for a reason retrying cannot fix (a transport failure, a stale ref, an ambiguous target).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeFailure<E> {
    NotActionable(ActionabilityError),
    Other(E),
}

/// How the wait ended without a probe result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionableError<E> {
    Cancelled(Cancelled),
    /// The deadline passed: the last blocker.
    NotActionable(ActionabilityError),
    /// A failure that is not retried, as the probe gave it.
    Failed(E),
}

/// `waitForBrowserActionable`: runs `probe` until it answers, retrying only [`ProbeFailure::NotActionable`] every 100 ms until
/// `timeout` has passed. Cancellation interrupts the wait and never admits a later probe; a result that arrives after the
/// cancellation is dropped.
pub async fn wait_for_actionable<T, E, F, Fut>(mut probe: F, cancel: &CancelView, timeout: Duration) -> Result<T, ActionableError<E>>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, ProbeFailure<E>>>,
{
    let deadline = time::Instant::now() + timeout;
    loop {
        throw_if_cancelled(cancel).map_err(ActionableError::Cancelled)?;
        let answer = probe().await;
        throw_if_cancelled(cancel).map_err(ActionableError::Cancelled)?;
        match answer {
            Ok(result) => return Ok(result),
            Err(ProbeFailure::Other(error)) => return Err(ActionableError::Failed(error)),
            Err(ProbeFailure::NotActionable(blocker)) => {
                let remaining = deadline.saturating_duration_since(time::Instant::now());
                if remaining.is_zero() {
                    return Err(ActionableError::NotActionable(blocker));
                }
                pause(remaining.min(ACTIONABILITY_POLL), cancel).await.map_err(ActionableError::Cancelled)?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use mixdog_rt::CancelSource;

    use super::*;

    fn live() -> CancelView {
        CancelSource::new().view()
    }

    #[tokio::test]
    async fn read_only_actionability_probes_wait_for_readiness_and_return_the_fresh_result() {
        let probes = AtomicUsize::new(0);
        let result = wait_for_actionable(
            || async {
                if probes.fetch_add(1, Ordering::SeqCst) + 1 < 3 {
                    return Err(ProbeFailure::<String>::NotActionable(ActionabilityError::new("button is disabled", "disabled")));
                }
                Ok("fresh")
            },
            &live(),
            ACTIONABILITY_TIMEOUT,
        )
        .await;
        assert_eq!(result, Ok("fresh"));
        assert_eq!(probes.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn transport_failures_stale_refs_and_ambiguity_are_not_blindly_retried() {
        for message in ["CDP disconnected", "stale ref", "target matched 2 elements"] {
            let probes = AtomicUsize::new(0);
            let result = wait_for_actionable(
                || async {
                    probes.fetch_add(1, Ordering::SeqCst);
                    Err::<(), _>(ProbeFailure::Other(message.to_string()))
                },
                &live(),
                ACTIONABILITY_TIMEOUT,
            )
            .await;
            assert_eq!(result, Err(ActionableError::Failed(message.to_string())));
            assert_eq!(probes.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn an_actionability_deadline_reports_the_last_blocker_without_another_probe() {
        let probes = AtomicUsize::new(0);
        let blocker = ActionabilityError::new("button is covered", "covered");
        let result = wait_for_actionable(
            || async {
                probes.fetch_add(1, Ordering::SeqCst);
                Err::<(), ProbeFailure<String>>(ProbeFailure::NotActionable(blocker.clone()))
            },
            &live(),
            Duration::ZERO,
        )
        .await;
        assert_eq!(result, Err(ActionableError::NotActionable(blocker)));
        assert_eq!(probes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancellation_interrupts_readiness_polling_and_never_admits_a_later_probe() {
        let source = CancelSource::new();
        let view = source.view();
        let probes = AtomicUsize::new(0);
        let result = wait_for_actionable(
            || async {
                probes.fetch_add(1, Ordering::SeqCst);
                source.cancel("user took control");
                Err::<(), ProbeFailure<String>>(ProbeFailure::NotActionable(ActionabilityError::new("not yet editable", "not-editable")))
            },
            &view,
            ACTIONABILITY_TIMEOUT,
        )
        .await;
        assert_eq!(result, Err(ActionableError::Cancelled(Cancelled { reason: Some("user took control".into()) })));
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        let result = wait_for_actionable(
            || async {
                probes.fetch_add(1, Ordering::SeqCst);
                Ok::<(), ProbeFailure<String>>(())
            },
            &view,
            ACTIONABILITY_TIMEOUT,
        )
        .await;
        assert!(matches!(result, Err(ActionableError::Cancelled(_))));
        assert_eq!(probes.load(Ordering::SeqCst), 1, "an already-cancelled wait must not probe");
    }
}
