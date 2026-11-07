//! The one owner of a child process. Exactly one task per child holds it, and only that task ever
//! signals the child's group or reaps the child.
//!
//! The invariant (Unix): every group signal happens strictly before the leader is reaped. While the
//! leader is unreaped (alive, or a zombie) its pid, and so the process-group id, cannot be reused,
//! so `killpg` can only reach our own group. Everything else (an operator stop, a protocol
//! violation, pool shutdown, a dropped handle) *asks* the owner through [`Kill`]; the owner decides
//! when to signal, and signals at most once, always followed by the reap.

use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::UnboundedSender;

/// What the owner needs from a child. The real implementation is `process::ProcOps`; tests inject a
/// recorder to assert the order of signal and reap.
pub(crate) trait ChildOps {
    /// What the reap yields (the exit status).
    type Exit;

    /// Kills everything in the child's job or group. Called at most once, never after the reap.
    fn signal_group(&mut self);

    /// Whether the leader has exited, *without* reaping it (`waitid(WNOWAIT)` on Unix).
    fn leader_exited(&mut self) -> bool;

    /// Resolves when the leader's state may have changed (a SIGCHLD tick on Unix). `false` means
    /// the notifier is gone and no further change will be announced.
    async fn changed(&mut self) -> bool;

    /// Reaps the leader.
    async fn reap(&mut self) -> Self::Exit;
}

/// A request to the owner to end its child. Cheap to clone; sending after the child is gone is a
/// no-op.
#[derive(Clone)]
pub(crate) struct Kill(UnboundedSender<()>);

impl Kill {
    pub(crate) fn kill(&self) {
        let _ = self.0.send(());
    }
}

pub(crate) struct Owner<O> {
    ops: O,
    requests: UnboundedReceiver<()>,
}

pub(crate) fn owner<O: ChildOps>(ops: O) -> (Owner<O>, Kill) {
    let (tx, requests) = mpsc::unbounded_channel();
    (Owner { ops, requests }, Kill(tx))
}

impl<O: ChildOps> Owner<O> {
    /// Runs until the child is gone and reaped. The group is signalled exactly once, before the
    /// reap, whichever way the end comes: the leader exited (checked first, then on each change
    /// notice), a kill was requested (or every [`Kill`] handle was dropped), or the change notifier
    /// was lost while the leader is still unreaped.
    pub(crate) async fn until_exit(&mut self) -> O::Exit {
        loop {
            if self.ops.leader_exited() {
                break;
            }
            tokio::select! {
                biased;
                _ = self.requests.recv() => break,
                alive = self.ops.changed() => {
                    if !alive {
                        break;
                    }
                }
            }
        }
        self.ops.signal_group();
        self.ops.reap().await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use super::*;

    type Log = Arc<Mutex<Vec<&'static str>>>;

    /// A child whose exit the test controls, and which records every signal and reap.
    struct Fake {
        log: Log,
        exited: Arc<AtomicBool>,
        ticks: UnboundedReceiver<()>,
    }

    impl ChildOps for Fake {
        type Exit = ();

        fn signal_group(&mut self) {
            self.log.lock().unwrap().push("signal");
        }

        fn leader_exited(&mut self) -> bool {
            self.exited.load(Ordering::Acquire)
        }

        async fn changed(&mut self) -> bool {
            self.ticks.recv().await.is_some()
        }

        async fn reap(&mut self) {
            self.log.lock().unwrap().push("reap");
        }
    }

    struct Rig {
        owner: Owner<Fake>,
        kill: Kill,
        log: Log,
        exited: Arc<AtomicBool>,
        tick: UnboundedSender<()>,
    }

    fn rig() -> Rig {
        let log = Log::default();
        let exited = Arc::new(AtomicBool::new(false));
        let (tick, ticks) = mpsc::unbounded_channel();
        let (owner, kill) = owner(Fake { log: log.clone(), exited: exited.clone(), ticks });
        Rig { owner, kill, log, exited, tick }
    }

    /// The invariant: one signal, and it comes before the reap; nothing follows the reap.
    fn assert_signal_then_reap(log: &Log) {
        assert_eq!(*log.lock().unwrap(), ["signal", "reap"]);
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    #[tokio::test]
    async fn an_exit_kills_what_the_leader_left_before_it_is_reaped() {
        // Also the browser's case: the browser exits on its own and its helpers must go.
        let mut rig = rig();
        rig.exited.store(true, Ordering::Release);
        rig.tick.send(()).unwrap();
        rig.owner.until_exit().await;
        assert_signal_then_reap(&rig.log);
    }

    #[tokio::test(start_paused = true)]
    async fn an_exit_announced_while_waiting_kills_before_the_reap() {
        let Rig { mut owner, log, exited, tick, kill: _kill } = rig();
        let run = tokio::spawn(async move { owner.until_exit().await });
        settle().await;
        assert!(log.lock().unwrap().is_empty(), "nothing happens while the child lives");
        exited.store(true, Ordering::Release);
        tick.send(()).unwrap();
        run.await.unwrap();
        assert_signal_then_reap(&log);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_that_races_the_exit_signals_once_and_before_the_reap() {
        // Both are visible when the owner looks.
        let mut both = rig();
        both.exited.store(true, Ordering::Release);
        both.kill.kill();
        both.tick.send(()).unwrap();
        both.owner.until_exit().await;
        assert_signal_then_reap(&both.log);

        // The stop arrives first, the exit lands while the owner is already ending the child.
        let Rig { mut owner, log, exited, tick, kill } = rig();
        let run = tokio::spawn(async move { owner.until_exit().await });
        settle().await;
        kill.kill();
        exited.store(true, Ordering::Release);
        tick.send(()).unwrap();
        run.await.unwrap();
        assert_signal_then_reap(&log);

        // A stop requested after the owner finished is ignored: nothing signals after the reap.
        kill.kill();
        kill.kill();
        settle().await;
        assert_signal_then_reap(&log);
    }

    #[tokio::test(start_paused = true)]
    async fn losing_the_notifier_kills_the_still_unreaped_leader_then_reaps() {
        let rig = rig();
        let Rig { mut owner, log, tick, kill: _kill, exited: _exited } = rig;
        let run = tokio::spawn(async move { owner.until_exit().await });
        settle().await;
        drop(tick);
        run.await.unwrap();
        assert_signal_then_reap(&log);
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_every_handle_ends_the_child_the_same_way() {
        let Rig { mut owner, log, kill, tick: _tick, exited: _exited } = rig();
        let run = tokio::spawn(async move { owner.until_exit().await });
        settle().await;
        drop(kill);
        run.await.unwrap();
        assert_signal_then_reap(&log);
    }
}
