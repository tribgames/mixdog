//! The judge's own executor, in the shape of Node's judge worker (`judge-worker.mjs`): one dedicated
//! thread at normal priority, started on first use, that loads the model, warms it up and runs every
//! judgment, one job at a time in the order they were sent. Nothing else runs on it, so history-sized
//! CPU work on the shared lanes can neither hold its thread nor fill its queue.

use std::panic::AssertUnwindSafe;
use std::sync::mpsc;
use std::sync::{Mutex, PoisonError};

use mixdog_rt::{JudgeThread, ThreadToken};
use tokio::sync::oneshot;

use crate::effort_judge::error::JudgeError;

type Job = Box<dyn FnOnce() + Send>;

pub(crate) struct JudgeWorker {
    token: JudgeThread,
    /// The thread's queue, `None` until the first job. The thread ends when this is dropped.
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
}

impl JudgeWorker {
    pub(crate) fn new(token: JudgeThread) -> Self {
        Self { token, jobs: Mutex::new(None) }
    }

    /// Runs `job` on the judge's thread after every job sent before it and returns what it returned.
    /// A job whose caller is gone by the time it comes up (it gave up waiting) is skipped, as Node never
    /// sends a turn whose caller abandoned it. A job that panics answers as a worker that exited.
    pub(crate) async fn run<R, F>(&self, job: F) -> Result<R, JudgeError>
    where
        R: Send + 'static,
        F: FnOnce() -> R + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        self.post(move || {
            if !tx.is_closed() {
                let _ = tx.send(job());
            }
        })?;
        rx.await.map_err(|_| JudgeError::Worker("the judgment ended without an answer".to_owned()))
    }

    /// Queues `job` behind the jobs already sent, without waiting for it.
    pub(crate) fn post(&self, job: impl FnOnce() + Send + 'static) -> Result<(), JudgeError> {
        let sender = {
            let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
            match jobs.as_ref() {
                Some(sender) => sender.clone(),
                None => {
                    let sender = self.start()?;
                    *jobs = Some(sender.clone());
                    sender
                }
            }
        };
        sender.send(Box::new(job)).map_err(|_| JudgeError::Worker("the effort judge thread ended".to_owned()))
    }

    fn start(&self) -> Result<mpsc::Sender<Job>, JudgeError> {
        let (tx, rx) = mpsc::channel::<Job>();
        self.token
            .spawn_thread("mixdog-effort-judge", move |_| {
                for job in rx {
                    // The panicking job's answer is dropped (its caller reads "exited"); the thread
                    // stays for the next one, as Node starts a fresh worker for the next turn.
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(job));
                }
            })
            .map_err(|error| JudgeError::Worker(format!("effort judge thread: {error}")))?;
        Ok(tx)
    }
}
