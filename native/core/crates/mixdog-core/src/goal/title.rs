//! `goal-title.mjs`: background title generation for a Goal objective. One job per session; a
//! newer objective supersedes the running job, and the title only lands when the stored Goal
//! still has the objective it was drawn from.

use std::sync::Arc;

use serde_json::Value;

use super::error::GoalError;
use super::js::{Goal, clean, put, put_num, string};
use super::runtime::{Inner, TitleJob};
use super::session_title::{SESSION_TITLE_TIMEOUT_MS, compact_session_title};

impl Inner {
    pub fn schedule_title(self: &Arc<Self>, id: &str, goal: &Goal) {
        let Some(titles) = self.env.titles.clone() else { return };
        if self.is_closed() {
            return;
        }
        let goal_id = clean(goal.get("id"));
        let objective = clean(goal.get("objective"));
        let shown_title = string(goal, "title");
        let slot = self.slot(id);
        let job_id = self.tx_new_title_job_id();
        let cancel = mixdog_rt::CancellationToken::new();
        {
            let mut mem = slot.mem();
            if let Some(old) = mem.title_job.replace(TitleJob { id: job_id, cancel: cancel.clone() }) {
                old.cancel.cancel();
            }
        }
        let (inner, id) = (self.clone(), id.to_owned());
        self.spawn_task(async move {
            let slot = inner.slot(&id);
            let superseded = |inner: &Arc<Inner>| {
                inner.is_closed() || cancel.is_cancelled() || slot.mem().title_job.as_ref().map(|j| j.id) != Some(job_id)
            };
            let timer = inner.env.timers.after(SESSION_TITLE_TIMEOUT_MS as f64, {
                let cancel = cancel.clone();
                Box::new(move || cancel.cancel())
            });
            let raw: Result<String, GoalError> = tokio::select! {
                result = titles.generate(&objective, &cancel) => result,
                () = cancel.cancelled() => Err(GoalError::new("Goal title generation superseded.")),
            };
            timer.cancel();
            if let Ok(raw) = raw {
                if !superseded(&inner) {
                    let title = compact_session_title(&raw);
                    if !title.is_empty() && title != shown_title {
                        let (task_slot, task_goal_id, task_objective) = (slot.clone(), goal_id.clone(), objective.clone());
                        let guard_cancel = cancel.clone();
                        let _ = inner
                            .with_mutation(&id, move |tx| {
                                let stale = guard_cancel.is_cancelled()
                                    || tx.inner.is_closed()
                                    || task_slot.mem().title_job.as_ref().map(|j| j.id) != Some(job_id);
                                if stale {
                                    return Ok(());
                                }
                                let Some(mut current) = tx.read_record()? else { return Ok(()) };
                                if clean(current.get("id")) != task_goal_id || string(&current, "objective") != task_objective {
                                    return Ok(());
                                }
                                put(&mut current, "title", Value::String(title));
                                let now = tx.now();
                                put_num(&mut current, "updatedAt", now);
                                tx.commit(Some(current), None).map(drop)
                            })
                            .await;
                    }
                }
            }
            let mut mem = slot.mem();
            if mem.title_job.as_ref().map(|j| j.id) == Some(job_id) {
                mem.title_job = None;
            }
        });
    }
}
