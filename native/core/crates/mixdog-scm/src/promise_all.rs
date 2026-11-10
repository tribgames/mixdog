//! `Promise.all` for reads Node starts together (git-history.ts:298, :534): they are polled in the order asked, in place, so each
//! starts its program in that order; the first failure in time is returned at once; and the reads still running are left to finish
//! on their own (Promise.all does not cancel them), not dropped.

use std::future::Future;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Either;
use futures::future::select;
use mixdog_rt::TaskClass;

use crate::error::ScmFailure;

fn leave_running<T: Send + 'static>(rest: BoxFuture<'static, Result<T, ScmFailure>>) {
    mixdog_rt::spawn("scm-read-left-running", TaskClass::Work, async move {
        let _ = rest.await;
    });
}

pub(crate) async fn all2<A, B>(
    a: impl Future<Output = Result<A, ScmFailure>> + Send + 'static,
    b: impl Future<Output = Result<B, ScmFailure>> + Send + 'static,
) -> Result<(A, B), ScmFailure>
where
    A: Send + 'static,
    B: Send + 'static,
{
    match select(a.boxed(), b.boxed()).await {
        Either::Left((first, rest)) => match first {
            Ok(first) => Ok((first, rest.await?)),
            Err(failure) => {
                leave_running(rest);
                Err(failure)
            }
        },
        Either::Right((second, rest)) => match second {
            Ok(second) => Ok((rest.await?, second)),
            Err(failure) => {
                leave_running(rest);
                Err(failure)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::Notify;

    use super::all2;
    use crate::error::ScmFailure;

    /// The failure that comes first in time is the one reported, at once; the slower read is left to finish.
    #[tokio::test]
    async fn the_first_failure_in_time_is_reported_and_the_other_read_runs_on() {
        let release = Arc::new(Notify::new());
        let finished = Arc::new(Notify::new());
        let slow = {
            let (release, finished) = (release.clone(), finished.clone());
            async move {
                release.notified().await;
                finished.notify_one();
                Err::<(), _>(ScmFailure::Cancelled)
            }
        };
        let fast = async { Err::<(), _>(ScmFailure::invalid("fast", "a failure")) };
        let failure = all2(slow, fast).await.unwrap_err();
        assert!(matches!(failure, ScmFailure::Invalid { .. }), "{failure:?}");
        release.notify_one();
        finished.notified().await;
    }
}
