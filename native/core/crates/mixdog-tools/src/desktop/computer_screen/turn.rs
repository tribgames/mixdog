//! The screen control's one thread of control. Node runs the helper, every screen session and its video source on
//! one thread: whatever a handler checks, it acts on before anything else runs. The port runs on a multi-threaded
//! runtime, so every entry into the composite — a public call, a timer, a polled task, an event from the helper's
//! pipe or the input host — first takes this turn. It is reentrant on the thread that holds it (a handler that calls
//! into another part, which calls back, runs on as Node's nested call does) and held only for one synchronous
//! stretch: a task holds it while it is polled, never across an await.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::task::Context;
use std::task::Poll;
use std::thread::ThreadId;

use super::router::BoxFuture;

#[derive(Default)]
struct Holder {
    thread: Option<ThreadId>,
    depth: usize,
}

#[derive(Default)]
pub(super) struct Turn {
    holder: Mutex<Holder>,
    free: Condvar,
    /// Test only: told each time a thread starts waiting for a turn another thread holds.
    #[cfg(test)]
    waiting: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

struct Leave<'a>(&'a Turn);

impl Drop for Leave<'_> {
    fn drop(&mut self) {
        let mut holder = self.0.holder();
        holder.depth -= 1;
        if holder.depth == 0 {
            holder.thread = None;
            drop(holder);
            self.0.free.notify_one();
        }
    }
}

impl Turn {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn holder(&self) -> MutexGuard<'_, Holder> {
        self.holder.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `body` holding the turn: at once on the thread that already holds it, otherwise once no other thread
    /// does.
    pub(super) fn enter<R>(&self, body: impl FnOnce() -> R) -> R {
        let me = std::thread::current().id();
        {
            let mut holder = self.holder();
            loop {
                match holder.thread {
                    None => {
                        holder.thread = Some(me);
                        break;
                    }
                    Some(thread) if thread == me => break,
                    Some(_) => {
                        #[cfg(test)]
                        self.told_waiting();
                        holder = self.free.wait(holder).unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                }
            }
            holder.depth += 1;
        }
        let _leave = Leave(self);
        body()
    }

    /// `task`, polled only while holding the turn.
    pub(super) fn guard(self: &Arc<Self>, task: BoxFuture<()>) -> BoxFuture<()> {
        Box::pin(Guarded { turn: self.clone(), task })
    }

    #[cfg(test)]
    pub(super) fn on_waiting(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        *self.waiting.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(listener);
    }

    #[cfg(test)]
    fn told_waiting(&self) {
        let listener = self.waiting.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        if let Some(listener) = listener {
            listener();
        }
    }
}

struct Guarded {
    turn: Arc<Turn>,
    task: BoxFuture<()>,
}

impl Future for Guarded {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let this = &mut *self;
        let turn = this.turn.clone();
        turn.enter(|| this.task.as_mut().poll(context))
    }
}
