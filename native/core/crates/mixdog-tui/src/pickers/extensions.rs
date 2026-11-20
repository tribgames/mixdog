//! The extension pickers: `/mcp`, `/skills`, `/plugins`, `/memory`, `/project`, `/resume` and the double-Esc message selector
//! (`src/tui/app/extension-pickers.mjs` and `extension-pickers/*`, `core-memory-picker.mjs` and `core-memory-picker/*`,
//! `project-picker.mjs` and `project-picker/*`, `resume-picker.mjs`, `message-selector.mjs`, `use-disabled-skills.mjs`).
//!
//! The Node factories took a store, a panel surface and prompt setters and painted panels whose rows carried closures. Here a
//! panel is data ([`ExtPanel`]): its rows carry an [`Action`] and the panel a [`Handler`] naming what Enter, Left/Right, a
//! key and Esc do, and [`Extensions`] runs the handler over [`ExtensionsHost`], the application's side. A promise chain of the
//! Node code is a sequence of host calls: the store answers `Ok(value)` or `Err(text)` (a rejection), and after every call the
//! claim of the panel is checked again before anything is painted, exactly where the Node code checked `own.owns()`. A host
//! that serves a store call off the UI thread runs the function from the task that owns the result.
//!
//! * [`panel`]: the panel and row records, the host trait, the shared status read;
//! * [`mcp_servers`], [`mcp_login`]: the MCP list with its optimistic toggle and the sign-in flow;
//! * [`skills`], [`plugins`]: the Skills lists and per-skill panel, the Plugins menu, list and per-plugin panel;
//! * [`core_memory`]: the Memory panels and their text prompts;
//! * [`project`]: the project list, the folder dialog, register, enter and rename;
//! * [`resume`], [`message_selector`], [`disabled_skills`]: the saved-chat list, the rewind list, the disabled-skill set.

pub mod core_memory;
pub mod disabled_skills;
pub mod mcp_login;
pub mod mcp_servers;
pub mod message_selector;
pub mod panel;
pub mod plugins;
pub mod project;
pub mod resume;
pub mod skills;

use serde_json::Value;

use crate::slash::host::{Opener, Tone};
use crate::slash::notices::truthy;
pub use mcp_login::McpLogin;
pub use panel::{Action, CoreEntry, ExtItem, ExtPanel, ExtensionsHost, Handler, MarkerTone};

/// The state the pickers keep between calls: the MCP toggle settle guard, the Esc target of the Memory picker, the project
/// list request counter and the active MCP sign-in.
#[derive(Debug, Default)]
pub struct Extensions {
    mcp_epoch: u64,
    mcp_active: bool,
    memory_escape: Option<Opener>,
    project_requests: u64,
    pub login: McpLogin,
}

/// The openers [`Extensions::open`] serves.
const OPENERS: [Opener; 8] =
    [Opener::Mcp, Opener::McpServers, Opener::Skills, Opener::ProjectSkills, Opener::Plugins, Opener::MemoryCore, Opener::Project, Opener::Resume];

/// The openers a `returnTo` option can name.
const RETURN_TARGETS: [Opener; 4] = [Opener::Settings, Opener::Model, Opener::ProviderSetup, Opener::AutoClear];

impl Extensions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether [`open`](Self::open) serves `opener`.
    pub fn serves(opener: Opener) -> bool {
        OPENERS.contains(&opener)
    }

    /// Opens the picker `opener` names with the options the slash command or the opener's caller gave (`{}` for none):
    /// `initialEntry` for the project list, and `returnTo` for the Memory picker (an opener name, or null for none; in Node a
    /// function the Settings row passed). `None` when this module does not serve `opener`.
    pub fn open(&mut self, host: &mut dyn ExtensionsHost, opener: Opener, options: &Value) -> Option<()> {
        match opener {
            Opener::Mcp | Opener::McpServers => self.open_mcp_servers(host, None, None),
            Opener::Skills => self.open_skills(host, skills::SkillsOptions::default()),
            Opener::ProjectSkills => self.open_project_skills(host),
            Opener::Plugins => self.open_plugins(host),
            Opener::MemoryCore => {
                let return_to = match options.get("returnTo") {
                    None => core_memory::ReturnTo::Inherit,
                    Some(Value::String(name)) => RETURN_TARGETS
                        .iter()
                        .find(|target| target.as_str() == name)
                        .map_or(core_memory::ReturnTo::Close, |target| core_memory::ReturnTo::Opener(*target)),
                    Some(_) => core_memory::ReturnTo::Close,
                };
                self.open_memory_core(host, return_to);
            }
            Opener::Project => {
                self.open_project(host, options.get("initialEntry").is_some_and(truthy));
            }
            Opener::Resume => self.open_resume(host),
            _ => return None,
        }
        Some(())
    }

    /// Enter on row `index` of `panel` (`onSelect`).
    pub fn select(&mut self, host: &mut dyn ExtensionsHost, panel: &ExtPanel, index: usize) {
        let Some(item) = panel.items.get(index) else { return };
        match &panel.handler {
            Handler::McpServers => self.toggle_server(host, item),
            Handler::Skills { skills, disabled } => self.toggle_skill(host, skills, disabled, item),
            Handler::ProjectSkills => {
                panel::close_now(host);
                if let Action::View(skill) = &item.action {
                    self.open_skill_detail(host, skill);
                }
            }
            Handler::SkillDetail(skill) => self.skill_detail_select(host, skill, item),
            Handler::Plugins => {
                panel::close_now(host);
                match item.action {
                    Action::Installed => self.open_installed_plugins(host),
                    Action::Add => plugins::begin_add_plugin(host),
                    _ => {}
                }
            }
            Handler::InstalledPlugins => {
                panel::close_now(host);
                if let Action::Plugin(plugin) = &item.action {
                    self.open_plugin_detail(host, plugin);
                }
            }
            Handler::PluginDetail(plugin) => self.plugin_detail_select(host, plugin, item),
            Handler::MemoryRoot => match &item.action {
                Action::AddCore => core_memory::begin_add(host),
                Action::CoreList(rows) => self.open_core_list(host, Some(rows.clone())),
                Action::Line(line) => host.push_notice(line, Tone::Info),
                _ => {}
            },
            Handler::MemoryList => match &item.action {
                Action::CoreEntry(entry) => self.open_core_entry_actions(host, entry),
                Action::Line(line) => host.push_notice(line, Tone::Info),
                _ => {}
            },
            Handler::MemoryEntry(entry) => match item.action {
                Action::Edit => core_memory::begin_edit(host, entry),
                Action::Delete => core_memory::begin_delete(host, entry),
                _ => {}
            },
            Handler::Project { initial_entry, current_path } => self.project_select(host, *initial_entry, current_path, item),
            Handler::Resume(sessions) => resume::select(host, sessions, &item.value),
            Handler::MessageSelector => message_selector::select(host, &item.value),
            Handler::ProjectOpening => {}
        }
    }

    /// Left or Right on row `index` of `panel` (`onLeft`, `onRight`): the toggles of the MCP and Skills lists.
    pub fn adjust(&mut self, host: &mut dyn ExtensionsHost, panel: &ExtPanel, index: usize) {
        let Some(item) = panel.items.get(index) else { return };
        match &panel.handler {
            Handler::McpServers => self.toggle_server(host, item),
            Handler::Skills { skills, disabled } => self.toggle_skill(host, skills, disabled, item),
            _ => {}
        }
    }

    /// A character key on `panel` with row `index` highlighted (`onKey`): `c` and `r` of the project list.
    pub fn key(&mut self, host: &mut dyn ExtensionsHost, panel: &ExtPanel, ch: char, index: Option<usize>) {
        if let Handler::Project { .. } = panel.handler {
            self.project_key(host, ch, index.and_then(|index| panel.items.get(index)));
        }
    }

    /// Esc on `panel` (`onCancel`).
    pub fn cancel(&mut self, host: &mut dyn ExtensionsHost, panel: &ExtPanel) {
        match &panel.handler {
            Handler::McpServers => {
                // Leaving the picker invalidates any in-flight settle.
                self.mcp_active = false;
                self.mcp_epoch += 1;
                panel::close_now(host);
            }
            Handler::Skills { .. } | Handler::Plugins | Handler::Resume(_) | Handler::MessageSelector | Handler::Project { .. } => {
                panel::close_now(host);
            }
            Handler::ProjectSkills | Handler::SkillDetail(_) => {
                panel::close_now(host);
                self.open_skills(host, skills::SkillsOptions::default());
            }
            Handler::InstalledPlugins => {
                panel::close_now(host);
                self.open_plugins(host);
            }
            Handler::PluginDetail(_) => {
                panel::close_now(host);
                self.open_installed_plugins(host);
            }
            Handler::MemoryRoot => self.close_memory_core(host),
            Handler::MemoryList => self.open_memory_core(host, core_memory::ReturnTo::Inherit),
            Handler::MemoryEntry(_) => self.open_core_list(host, None),
            Handler::ProjectOpening => {}
        }
    }
}
