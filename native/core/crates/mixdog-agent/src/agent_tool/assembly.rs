//! The production assembly of the agent tool: the job board's views and starter, the turn runner,
//! the spawn and send flows and [`AgentRuntime`], wired from the host's collaborators in the one
//! order they depend on each other (Node `agent-tool/index.mjs` building `execute` over
//! `createAgentFlows`). [`assemble`] is the constructor the compose root calls; the result serves
//! as the `AgentPort` the orchestration tools take:
//!
//! ```ignore
//! let agents: Arc<dyn AgentPort> = mixdog_agent::agent_tool::assemble(parts).port();
//! ```

use std::sync::Arc;

use mixdog_tools::orch::agent::AgentPort;

use super::board::JobBoard;
use super::dispatch::{AgentDeps, AgentRuntime};
use super::error_text::ErrorText;
use super::flow::early::EarlyNotice;
use super::flow::job_starter::JobStarter;
use super::flow::send::{SendFlowDeps, SendFlowImpl};
use super::flow::seams::{Admission, OwnerNotify, SubagentEvents, TaskStarts, TurnReviews, TurnSessions, WorkerInbox};
use super::flow::spawn::{SpawnFlowDeps, SpawnFlowImpl};
use super::flow::turn::TurnRunner;
use super::flow::worker_turns::TurnOwner;
use super::flow::world::{SendWorld, SpawnWorld};
use super::host::{CallerScopes, Environment, Registry, Sessions, TerminalTrace};
use super::model_select::ModelCatalog;
use super::views::{JobViews, Workers};
use crate::env::Clock;

/// Everything the agent tool is wired to. Each field is one seam with its own production
/// implementation (or, for the two worlds, its own adapter over the session runtime).
pub struct AgentParts {
    /// The job table, built over the notifier that delivers its finished jobs
    /// (`JobBoard::new(clock, notifier, on_change)`).
    pub board: JobBoard,
    pub clock: Arc<dyn Clock>,
    pub registry: Arc<dyn Registry>,
    /// Closing and reading the agent sessions (`AgentSessions`).
    pub sessions: Arc<dyn Sessions>,
    /// The session manager as a worker's turn uses it (`SessionTurns`).
    pub turn_sessions: Arc<dyn TurnSessions>,
    /// The one owner of a worker's turn status (`WorkerTurns`).
    pub turns: Arc<dyn TurnOwner>,
    pub reviews: Arc<dyn TurnReviews>,
    pub events: Arc<dyn SubagentEvents>,
    pub inbox: Arc<dyn WorkerInbox>,
    pub owner_notify: Arc<dyn OwnerNotify>,
    /// The agent lane's admission (`ResourceAdmission`).
    pub admission: Arc<dyn Admission>,
    pub starts: Arc<dyn TaskStarts>,
    pub workers: Arc<dyn Workers>,
    /// Called whenever a job's or worker's status changes.
    pub status_changed: Arc<dyn Fn() + Send + Sync>,
    pub spawn_world: Arc<dyn SpawnWorld>,
    pub send_world: Arc<dyn SendWorld>,
    pub terminal_trace: Arc<dyn TerminalTrace>,
    pub env: Arc<dyn Environment>,
    pub catalog: Option<Arc<dyn ModelCatalog>>,
    pub scopes: Arc<dyn CallerScopes>,
    pub errors: Arc<dyn ErrorText>,
    pub default_cwd: String,
    pub mcp_scope_id: Option<String>,
}

/// The assembled agent tool and the parts other composers share.
pub struct Assembled {
    pub runtime: Arc<AgentRuntime>,
    pub spawn: Arc<SpawnFlowImpl>,
    pub send: Arc<SendFlowImpl>,
    pub board: JobBoard,
    pub views: Arc<JobViews>,
}

impl Assembled {
    /// The runtime as the `AgentPort` the orchestration tools take.
    pub fn port(&self) -> Arc<dyn AgentPort> {
        self.runtime.clone()
    }
}

/// Wires the turn runner, job starter, views and the two flows over `parts`, then the runtime.
pub fn assemble(parts: AgentParts) -> Assembled {
    let AgentParts {
        board,
        clock,
        registry,
        sessions,
        turn_sessions,
        turns,
        reviews,
        events,
        inbox,
        owner_notify,
        admission,
        starts,
        workers,
        status_changed,
        spawn_world,
        send_world,
        terminal_trace,
        env,
        catalog,
        scopes,
        errors,
        default_cwd,
        mcp_scope_id,
    } = parts;
    let early = Arc::new(EarlyNotice::new(owner_notify, clock.clone()));
    let runner = Arc::new(TurnRunner::new(turn_sessions.clone(), turns.clone(), reviews, events, inbox, early));
    let starter = Arc::new(JobStarter::new(board.clone(), sessions.clone(), turn_sessions, admission, starts, status_changed.clone()));
    let views = Arc::new(JobViews::new(board.clone(), registry.clone(), workers, clock.clone()));
    let spawn = Arc::new(SpawnFlowImpl::new(SpawnFlowDeps {
        world: spawn_world,
        registry: registry.clone(),
        sessions: sessions.clone(),
        env: env.clone(),
        board: board.clone(),
        views: views.clone(),
        starter: starter.clone(),
        runner: runner.clone(),
        clock,
        status_changed,
        default_cwd: default_cwd.clone(),
        mcp_scope_id,
    }));
    let send = Arc::new(SendFlowImpl::new(SendFlowDeps {
        world: send_world,
        registry: registry.clone(),
        env: env.clone(),
        views: views.clone(),
        starter,
        runner,
        turns,
        default_cwd: default_cwd.clone(),
    }));
    let runtime = Arc::new(AgentRuntime::new(AgentDeps {
        registry,
        send_flow: Arc::new(send.clone()),
        spawn_flow: Arc::new(spawn.clone()),
        terminal_trace,
        sessions,
        tasks: Arc::new(board.clone()),
        views: views.clone(),
        env,
        catalog,
        default_cwd,
        scopes,
        errors,
    }));
    Assembled { runtime, spawn, send, board, views }
}
