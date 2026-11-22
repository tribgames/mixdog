//! A lane job's wait for work that runs on the runtime.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering::SeqCst;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;

/// Waits, inside a lane job, for `future`, whose work runs on `runtime`. A lane thread is no runtime thread and blocks on the
/// runtime. An inline lane (tests) runs the job on the thread that submitted it, a runtime worker or the thread inside
/// `Runtime::block_on`: there the wait parks on a signal of its own. tokio parks every `block_on` of a thread on that thread's
/// one parker, so a `block_on` nested inside the poll of the outer one takes the wake owed to the outer one, which is then
/// not polled again for it.
#[allow(clippy::disallowed_methods, reason = "runs inside a lane job; an inline lane's runtime worker hands off its tasks first")]
pub(super) fn wait_in_job<F: Future>(runtime: &tokio::runtime::Handle, future: F) -> F::Output {
    if tokio::runtime::Handle::try_current().is_err() {
        return runtime.block_on(future);
    }
    tokio::task::block_in_place(|| {
        let _entered = runtime.enter();
        park_until(future)
    })
}

struct Signal {
    woken: AtomicBool,
    thread: std::thread::Thread,
}

impl Wake for Signal {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.woken.store(true, SeqCst);
        self.thread.unpark();
    }
}

fn park_until<F: Future>(future: F) -> F::Output {
    let signal = Arc::new(Signal { woken: AtomicBool::new(false), thread: std::thread::current() });
    let waker = Waker::from(signal.clone());
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(output) = future.as_mut().poll(&mut cx) {
            return output;
        }
        while !signal.woken.swap(false, SeqCst) {
            std::thread::park();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;

    use super::*;

    /// Pending once, woken by its own first poll.
    fn woken_once() -> impl Future<Output = ()> {
        let mut polled = false;
        std::future::poll_fn(move |cx| {
            if std::mem::replace(&mut polled, true) {
                return Poll::Ready(());
            }
            cx.waker().wake_by_ref();
            Poll::Pending
        })
    }

    /// A task on the thread inside `Runtime::block_on` waits for an event; the event arrives while a lane job the same poll
    /// runs inline waits for the runtime. The task is polled again for it. (Release gate run 45050120492: a composed core's
    /// stop read a session's messages on that thread, the read's wait for the index took the wake of the other session's
    /// answer, and the stop was not polled again, its deadlines included.)
    #[test]
    fn a_wait_in_an_inline_job_leaves_the_wake_of_the_task_that_runs_it() {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("a runtime");
        let handle = runtime.handle().clone();
        let (ended, end) = std::sync::mpsc::channel();
        let task = std::thread::spawn(move || {
            runtime.block_on(async move {
                let (event, mut owed) = tokio::sync::oneshot::channel::<()>();
                let mut event = Some(event);
                std::future::poll_fn(|cx| {
                    if Pin::new(&mut owed).poll(cx).is_ready() {
                        return Poll::Ready(());
                    }
                    if let Some(event) = event.take() {
                        event.send(()).expect("the task waits for the event");
                        wait_in_job(&handle, woken_once());
                    }
                    Poll::Pending
                })
                .await;
            });
            let _ = ended.send(());
        });
        end.recv_timeout(std::time::Duration::from_secs(30)).expect("the task is polled again for the event that arrived during the job's wait");
        task.join().expect("the task's thread");
    }

    /// A wait for work another thread ends: the job's own wake reaches it.
    #[test]
    fn a_wait_in_an_inline_job_ends_when_the_runtime_ends_its_work() {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("a runtime");
        let handle = runtime.handle().clone();
        let answer = runtime.block_on(async move {
            let (ask, asked) = tokio::sync::oneshot::channel::<tokio::sync::oneshot::Sender<u8>>();
            tokio::spawn(async move {
                if let Ok(answer) = asked.await {
                    let _ = answer.send(7);
                }
            });
            wait_in_job(&handle, async move {
                let (answer, answered) = tokio::sync::oneshot::channel();
                ask.send(answer).expect("the worker's task waits");
                mixdog_rt::time::timeout(std::time::Duration::from_secs(30), answered).await.expect("answered in time").expect("an answer")
            })
        });
        assert_eq!(answer, 7);
    }
}
