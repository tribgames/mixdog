//! [`SessionSeams`] over the parts the composition root builds: each method delegates to the owner's
//! built part, and what no crate implements yet is one owner trait, [`ConfigSeams`], taken as a
//! parameter, so the root cannot be built without its real provider and nothing here stubs it.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_agent::env::Compactor;
use mixdog_agent::offload::ImageCompactor;
use mixdog_agent::step_effort::StepAutoEffort;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::todo::TodoView;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::paths::Paths;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::SessionSurface;
use serde_json::Value;

use super::assemble::{CompactorInput, RunSettings, SessionSeams, SessionTools, SkillParts};
use super::hooks::PostToolDispatch;
use super::hop_host::HopFactory;
use super::route_fallback::HopHost;
use super::session_tools::SessionToolBuilder;
use super::step_judge::{ladder_facts, LadderSources, StepLadderFacts};
use crate::ports::todo_view::TodoViews;

/// What the turn reads of the configuration and the agent store. Owner: WP-CONFIG; nothing in the
/// tree implements it yet.
pub trait ConfigSeams: Send + Sync + 'static {
    /// `getHiddenAgent(agent)`: `agent` is a row of `src/defaults/agents.json`.
    fn hidden_agent(&self, agent: Option<&str>) -> bool;
    /// The route's, settings' and agent's `RunConfig` fields; every field's Node origin is in
    /// `compose-seams.md` "RunSettings: origins".
    fn run_settings(&self, thread: &ThreadId, header: &Header) -> RunSettings;
    /// `readSection('agent').instructionFiles`, the stored setting.
    fn stored_instruction_files(&self) -> Option<Value>;
    /// The install's reply language `(code, name)` (`build_lead_language`), asked only for a header that
    /// recorded none. Runs in a lane job.
    fn response_language(&self) -> Option<(String, String)>;
}

/// The compaction pipeline of a session's route: [`super::compactors::SessionCompactors`] is the
/// implementation (`FreshCompactor::for_session` over the session's `FreshParts`, `TriggerSeams`,
/// fork source and `summary_routes`).
pub trait CompactorSource: Send + Sync + 'static {
    fn compactor(&self, thread: &ThreadId, header: &Header, input: CompactorInput) -> Option<Arc<dyn Compactor>>;
}

/// The built parts the seams delegate to.
pub struct SeamParts {
    pub tools: SessionToolBuilder,
    pub todos: TodoViews,
    pub post_tool: Arc<dyn PostToolDispatch>,
    pub compactors: Arc<dyn CompactorSource>,
    /// `None`: the install has no route fallback (no `HopSessions` yet); a run then never hops.
    pub hops: Option<Arc<HopFactory>>,
    /// `None`: no `Skill` tool is registered.
    pub skills: Option<SkillParts>,
    pub config: Arc<dyn ConfigSeams>,
    pub ladder: Arc<dyn LadderSources>,
    pub images: Option<Arc<dyn ImageCompactor>>,
    pub paths: Paths,
}

pub struct HostSeams {
    parts: SeamParts,
}

impl HostSeams {
    pub fn new(parts: SeamParts) -> Self {
        Self { parts }
    }
}

fn text<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).map_or("", mixdog_js::js_trim)
}

impl SessionSeams for HostSeams {
    fn tools(&self, _thread: &ThreadId, header: &Header, surface: &SessionSurface) -> SessionTools {
        self.parts.tools.tools(header, surface)
    }

    fn hidden_agent(&self, agent: Option<&str>) -> bool {
        self.parts.config.hidden_agent(agent)
    }

    fn todo_view(&self, thread: &ThreadId, header: &Header) -> Arc<dyn TodoView> {
        self.parts.todos.todo_view(thread, header)
    }

    fn post_tool_dispatch(&self) -> Arc<dyn PostToolDispatch> {
        self.parts.post_tool.clone()
    }

    fn compactor(&self, thread: &ThreadId, header: &Header, input: CompactorInput) -> Option<Arc<dyn Compactor>> {
        self.parts.compactors.compactor(thread, header, input)
    }

    fn hop_host(&self, thread: &ThreadId, header: &Header) -> Option<Arc<dyn HopHost>> {
        self.parts.hops.as_ref()?.hop_host(thread, header)
    }

    fn skill_parts(&self) -> Option<SkillParts> {
        self.parts.skills.as_ref().map(|s| SkillParts { names: s.names.clone(), tool: s.tool.clone() })
    }

    fn run_settings(&self, thread: &ThreadId, header: &Header) -> RunSettings {
        self.parts.config.run_settings(thread, header)
    }

    fn tail_context(&self, header: &Header) -> TailContext {
        super::tail::tail_context(header, || self.parts.config.response_language())
    }

    fn step_ladder_facts(&self, _thread: &ThreadId, header: &Header, _auto: &StepAutoEffort) -> Option<StepLadderFacts> {
        Some(ladder_facts(&*self.parts.ladder, text(header, "provider"), text(header, "model")))
    }

    fn image_compactor(&self) -> Option<Arc<dyn ImageCompactor>> {
        self.parts.images.clone()
    }

    fn plugin_root(&self) -> PathBuf {
        self.parts.paths.plugin_root.clone()
    }

    fn stored_instruction_files(&self) -> Option<Value> {
        self.parts.config.stored_instruction_files()
    }

    fn data_dir(&self) -> PathBuf {
        self.parts.paths.data_dir.clone()
    }
}