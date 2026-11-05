//! The one place that builds every tool of the orchestration, state and desktop front ends from
//! the services behind them (WP-INTEGRATE calls [`tools`] once per core).

use std::sync::Arc;

use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::tool::Tool;

use super::agent::AgentPort;
use super::agent::AgentTool;
use super::bridge::CallTool;
use super::bridge::CatalogView;
use super::bridge::LoadTool;
use super::bridge::ToolDispatcher;
use super::explore::ExploreRunner;
use super::explore::ExploreTool;
use super::office::OfficeTool;
use super::office::OfficeWrites;
use super::ports::CallerFacts;
use super::service::ServiceTool;
use super::service::ToolService;
use super::session::SessionPort;
use super::session::SessionTool;
use super::skill::SkillPort;
use super::skill::SkillTool;
use crate::desktop::browser::BrowserTool;
use crate::desktop::computer::ComputerTool;
use crate::desktop::host::HostCommands;
use crate::desktop::terminal::CommandPolicy;
use crate::desktop::terminal::TerminalPort;
use crate::desktop::terminal::TerminalTool;
use crate::desktop::visualize::VisualizeTool;
use crate::state::ask_user::AskUserTool;
use crate::state::goal::GoalPort;
use crate::state::goal::GoalTool;
use crate::state::handoff::HandoffEnv;
use crate::state::handoff::HandoffUserTool;
use crate::state::react::ReactTool;
use crate::state::react::Reactions;
use crate::state::todo::TodoStore;
use crate::state::todo::TodoTool;

/// Every service the tools of this module sit on.
pub struct Services {
    pub facts: Arc<dyn CallerFacts>,
    pub sessions: Arc<dyn SessionPort>,
    pub agents: Arc<dyn AgentPort>,
    pub explorer: Arc<dyn ExploreRunner>,
    pub skills: Arc<dyn SkillPort>,
    pub catalog: Arc<dyn CatalogView>,
    pub dispatcher: Arc<dyn ToolDispatcher>,
    pub setup: Arc<dyn ToolService>,
    pub media: Arc<dyn ToolService>,
    pub tidy: Arc<dyn ToolService>,
    pub ext_pool: Arc<dyn ExtPool>,
    pub office_writes: Arc<dyn OfficeWrites>,
    /// The plugin data directory; it must differ from every workspace.
    pub data_dir: String,
    pub todos: Arc<dyn TodoStore>,
    pub goals: Arc<dyn GoalPort>,
    pub reactions: Arc<dyn Reactions>,
    pub handoff: Arc<dyn HandoffEnv>,
    /// Mints unique request ids (`secret_<uuid>`).
    pub ids: Arc<dyn Fn() -> String + Send + Sync>,
    pub host: Arc<dyn HostCommands>,
    pub terminals: Arc<dyn TerminalPort>,
    pub command_policy: Arc<dyn CommandPolicy>,
    /// `None` where the OS has no computer-use backend.
    pub computer: Option<Arc<dyn ComputerBackend>>,
}

/// All tools, in the order the catalog lists them.
pub fn tools(s: Services) -> Vec<Arc<dyn Tool>> {
    let mut all: Vec<Arc<dyn Tool>> = vec![
        Arc::new(LoadTool::new(s.catalog.clone())),
        Arc::new(CallTool::new(s.catalog, s.dispatcher)),
        Arc::new(SkillTool::new(s.skills)),
        Arc::new(SessionTool::new(s.sessions.clone(), s.facts.clone())),
        Arc::new(AgentTool::new(s.agents, s.sessions, s.facts.clone())),
        Arc::new(ExploreTool::new(s.explorer)),
        Arc::new(TodoTool::new(s.todos.clone())),
        Arc::new(GoalTool::new(s.goals, s.todos.clone(), s.facts.clone())),
        Arc::new(AskUserTool::new(s.facts.clone(), s.todos)),
        Arc::new(HandoffUserTool::new(s.facts.clone(), s.host.clone(), s.handoff, s.ids)),
        Arc::new(ReactTool::new(s.reactions, s.facts)),
        Arc::new(ServiceTool::setup(s.setup)),
        Arc::new(ServiceTool::media(s.media)),
        Arc::new(ServiceTool::tidy(s.tidy)),
        Arc::new(OfficeTool::new(s.ext_pool, s.office_writes, s.data_dir)),
        Arc::new(BrowserTool::browser(s.host.clone())),
        Arc::new(BrowserTool::devtools(s.host.clone())),
        Arc::new(VisualizeTool::new(s.host)),
        Arc::new(TerminalTool::new(s.terminals, s.command_policy)),
    ];
    if let Some(backend) = s.computer {
        all.push(Arc::new(ComputerTool::new(backend)));
    }
    all
}
