//! A Goal record written before the todo list still carries its tasks (`goal-facade-api.mjs`
//! `adoptLegacyTasks`): the session's list adopts them, and only once that list is saved does the
//! record let them go. A failed save keeps them on the record, so the next read adopts again
//! (items already listed are skipped, never duplicated).
//!
//! Node adopts where the facade reads the Goal for the session: `goalStatus()` and
//! `goalContinuation()`. [`AdoptingGoals`] is the session's Goal hooks with that step in front of
//! the same two calls; every other call is the runtime's own.
//!
//! The fold is the stored list's own (`mixdog_tools::state::todo::adopt_legacy_goal_tasks`), not
//! a `todo` tool call: the tool's operations differ from Node's, the stored model does not.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_goal::goal::hooks::{GoalContinuationHooks, GoalTurnHooks, GoalViewHooks};
use mixdog_core_goal::goal::js::Goal;
use mixdog_core_goal::goal::{Admission, Continuation, ContinuationInput, GoalEvent, GoalResult, GoalRuntime, Subscription};
use mixdog_protocol::ThreadId;
use mixdog_tools::state::todo::{TodoStore, adopt_legacy_goal_tasks};
use serde_json::Value;

pub struct AdoptingGoals {
    goals: Arc<GoalRuntime>,
    todos: Arc<dyn TodoStore>,
}

impl AdoptingGoals {
    pub fn new(goals: Arc<GoalRuntime>, todos: Arc<dyn TodoStore>) -> Self {
        Self { goals, todos }
    }

    /// `adoptLegacyTasks(sessionId)`: true when the record carried tasks (adopted now, or all
    /// already listed). The record keeps them unless the list's commit succeeded; nothing here
    /// fails the Goal call it precedes.
    async fn adopt(&self, thread: &ThreadId) -> bool {
        let tasks = self.goals.legacy_tasks(thread.as_str()).await;
        if tasks.is_empty() {
            return false;
        }
        // The edit runs again over the winner's list when another `todo` commit lands first.
        // The commit is stamped by the store's clock (`commitPhases(session, phases, Date.now())`).
        // Every task already listed (`adoptLegacyGoalTasks` answers false) commits nothing: the list is as saved.
        let mut listed = false;
        let saved = self
            .todos
            .update(thread, &mut |list| match adopt_legacy_goal_tasks(list, &tasks, 0) {
                Some(next) => Ok(next),
                None => {
                    listed = true;
                    Err(String::new())
                }
            })
            .await;
        match if listed { Ok(()) } else { saved } {
            // Only a committed list lets the record go.
            Ok(()) => {
                if let Err(error) = self.goals.clear_legacy_tasks(thread.as_str()).await {
                    tracing::warn!(thread = thread.as_str(), "[goal] legacy tasks were adopted but not cleared: {}", error.message);
                }
            }
            // Kept on the record; adopted again on the next read.
            Err(error) => tracing::warn!(thread = thread.as_str(), "[goal] legacy tasks were not adopted: {error}"),
        }
        true
    }
}

#[async_trait]
impl GoalTurnHooks for AdoptingGoals {
    async fn turn_started(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        self.goals.turn_started(thread).await
    }
    async fn turn_settled(&self, thread: &ThreadId, detail: Value) -> GoalResult<Option<Goal>> {
        self.goals.turn_settled(thread, detail).await
    }
    async fn archive_completed_on_user_input(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        GoalTurnHooks::archive_completed_on_user_input(&*self.goals, thread).await
    }
    async fn reactivate_usage_limited(&self, thread: &ThreadId, goal_id: &str, admission: Admission) -> GoalResult<Option<Goal>> {
        GoalTurnHooks::reactivate_usage_limited(&*self.goals, thread, goal_id, admission).await
    }
}

#[async_trait]
impl GoalContinuationHooks for AdoptingGoals {
    /// `goalContinuation()`: Node adopts into the session first, so the continuation's todo block
    /// (`todoContextBlock(getSession(), .., { whole: true })`) already names the adopted items.
    /// The caller read its block before this call; it is read again when tasks were adopted.
    async fn continuation(&self, thread: &ThreadId, mut input: ContinuationInput) -> GoalResult<Continuation> {
        if self.adopt(thread).await {
            input.todo = self.todos.read(thread).await.context_block("Todo list for this Goal:", true);
        }
        GoalContinuationHooks::continuation(&*self.goals, thread, input).await
    }
    fn reset_continuation_rules(&self, thread: &ThreadId) -> GoalResult<()> {
        GoalContinuationHooks::reset_continuation_rules(&*self.goals, thread)
    }
}

#[async_trait]
impl GoalViewHooks for AdoptingGoals {
    /// `goalStatus()`.
    async fn goal_status(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        self.adopt(thread).await;
        self.goals.goal_status(thread).await
    }
    async fn stored_goal(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        self.goals.stored_goal(thread).await
    }
    async fn goal_control(&self, thread: &ThreadId, request: Value) -> GoalResult<Value> {
        self.goals.goal_control(thread, request).await
    }
    fn on_goal_change(&self, listener: Box<dyn Fn(&GoalEvent) + Send + Sync>) -> Subscription {
        self.goals.on_goal_change(listener)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_goal::goal::{GoalConfig, GoalEnv};
    use mixdog_tools::state::todo::{TodoEdit, TodoList, TodoPhase, TodoStatus, TodoTask};
    use serde_json::json;

    use super::*;

    /// The stored list of one thread; `fail` refuses every commit (a session that cannot be saved).
    #[derive(Default)]
    struct Lists {
        list: Mutex<TodoList>,
        fail: bool,
    }

    #[async_trait]
    impl TodoStore for Lists {
        async fn read(&self, _: &ThreadId) -> TodoList {
            self.list.lock().unwrap().clone()
        }
        async fn update(&self, _: &ThreadId, f: &mut TodoEdit<'_>) -> Result<(), String> {
            let next = f(&self.list.lock().unwrap().clone())?;
            if self.fail {
                return Err("the session could not be saved".into());
            }
            *self.list.lock().unwrap() = next;
            Ok(())
        }
        fn note_user_wait(&self, _: &ThreadId) {}
        fn user_waiting(&self, _: &ThreadId) -> bool {
            false
        }
        fn turn_started(&self, _: &ThreadId) {}
    }

    fn runtime(dir: &std::path::Path) -> Arc<GoalRuntime> {
        Arc::new(GoalRuntime::new(GoalConfig::new(dir.to_string_lossy().into_owned()), GoalEnv::system(mixdog_rt::testing::tokens().durability_io)))
    }

    /// A Goal of this build, then its record rewritten as an older build left it: the tasks on the record (`tasks`).
    async fn legacy_goal(dir: &std::path::Path, thread: &ThreadId) -> Arc<GoalRuntime> {
        let first = runtime(dir);
        first.goal_control(thread, json!("ship the release")).await.expect("create");
        first.close().await;
        let path = mixdog_core_goal::goal::storage::record_path(&dir.join("goals"), thread.as_str());
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path).expect("record")).expect("json");
        record["goal"]["tasks"] = json!([
            { "text": "Write the notes", "status": "completed" },
            { "text": "Tag the build", "status": "in_progress" },
            { "content": "Tell the team", "status": "awaiting_approval" },
            { "text": "Old idea", "status": "dropped" },
        ]);
        std::fs::write(&path, serde_json::to_vec(&record).expect("bytes")).expect("write");
        runtime(dir)
    }

    fn tasks(list: &TodoList) -> Vec<(String, String, TodoStatus)> {
        list.phases.iter().flat_map(|phase| phase.tasks.iter().map(|task| (phase.name.clone(), task.content.clone(), task.status))).collect()
    }

    /// `goalStatus()` adopts: the record's tasks are the session's list (`adoptLegacyGoalTasks`, an empty list takes
    /// them as `Tasks`), and once the list is saved the record lets them go (`clearLegacyTasks`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_goal_status_read_moves_a_legacy_records_tasks_into_the_list() {
        let dir = tempfile::tempdir().expect("dir");
        let thread = ThreadId::from("sess_legacy_goal");
        let goals = legacy_goal(dir.path(), &thread).await;
        assert_eq!(goals.legacy_tasks(thread.as_str()).await.len(), 4, "the record carries its tasks");
        let lists = Arc::new(Lists::default());
        let adopting = AdoptingGoals::new(goals.clone(), lists.clone());
        let goal = adopting.goal_status(&thread).await.expect("status").expect("the goal");
        assert_eq!(goal["objective"], "ship the release");
        let own = |content: &str, status| ("Tasks".to_owned(), content.to_owned(), status);
        assert_eq!(
            tasks(&lists.read(&thread).await),
            [
                own("Write the notes", TodoStatus::Completed),
                own("Tag the build", TodoStatus::InProgress),
                own("Tell the team", TodoStatus::Pending),
                own("Old idea", TodoStatus::Abandoned),
            ]
        );
        assert!(goals.legacy_tasks(thread.as_str()).await.is_empty(), "the saved list let the record go");
        // A second read has nothing to adopt and changes nothing.
        let before = lists.read(&thread).await;
        adopting.goal_status(&thread).await.expect("status");
        assert_eq!(lists.read(&thread).await, before);
        goals.close().await;
    }

    /// Every task already on the list (`adoptLegacyGoalTasks` answers false): the list is not written again, and the
    /// record lets its tasks go.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tasks_already_listed_leave_the_list_as_it_is_and_the_record_lets_go() {
        let dir = tempfile::tempdir().expect("dir");
        let thread = ThreadId::from("sess_legacy_goal");
        let goals = legacy_goal(dir.path(), &thread).await;
        let task = |content: &str| TodoTask { content: content.into(), status: TodoStatus::Completed, note: None };
        let listed = TodoList {
            phases: vec![TodoPhase { name: "Tasks".into(), tasks: vec![task("Write the notes"), task("Tag the build"), task("Tell the team"), task("Old idea")] }],
            updated_at_ms: 5,
        };
        let lists = Arc::new(Lists { list: Mutex::new(listed.clone()), fail: true });
        AdoptingGoals::new(goals.clone(), lists.clone()).goal_status(&thread).await.expect("status");
        assert_eq!(lists.read(&thread).await, listed);
        assert!(goals.legacy_tasks(thread.as_str()).await.is_empty());
        goals.close().await;
    }

    /// A failed save keeps the tasks on the record; the next load adopts again, and items already listed are skipped.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_list_that_could_not_be_saved_keeps_the_tasks_on_the_record() {
        let dir = tempfile::tempdir().expect("dir");
        let thread = ThreadId::from("sess_legacy_goal");
        let goals = legacy_goal(dir.path(), &thread).await;
        let failing = Arc::new(Lists { fail: true, ..Lists::default() });
        AdoptingGoals::new(goals.clone(), failing.clone()).goal_status(&thread).await.expect("the status is still read");
        assert!(failing.read(&thread).await.phases.is_empty());
        assert_eq!(goals.legacy_tasks(thread.as_str()).await.len(), 4, "kept for the next load");

        let listed = TodoList {
            phases: vec![TodoPhase { name: "Tasks".into(), tasks: vec![TodoTask { content: "Tag the build".into(), status: TodoStatus::Completed, note: None }] }],
            updated_at_ms: 5,
        };
        let lists = Arc::new(Lists { list: Mutex::new(listed), fail: false });
        let adopting = AdoptingGoals::new(goals.clone(), lists.clone());
        // `goalContinuation()`: the block the continuation is given names the adopted items.
        let stale = ContinuationInput { awaiting_work: true, todo: "stale".into() };
        adopting.continuation(&thread, stale).await.expect("continuation");
        let list = lists.read(&thread).await;
        assert_eq!(
            tasks(&list),
            [
                ("Tasks".to_owned(), "Tag the build".to_owned(), TodoStatus::Completed),
                ("Goal".to_owned(), "Write the notes".to_owned(), TodoStatus::Completed),
                ("Goal".to_owned(), "Tell the team".to_owned(), TodoStatus::InProgress),
                ("Goal".to_owned(), "Old idea".to_owned(), TodoStatus::Abandoned),
            ]
        );
        assert!(goals.legacy_tasks(thread.as_str()).await.is_empty());
        goals.close().await;
    }
}
