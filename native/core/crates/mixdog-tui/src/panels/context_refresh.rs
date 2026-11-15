//! `app/use-context-panel-refresh.mjs`: keeps an open `/context` breakdown panel current. It is rebuilt whenever one of the
//! session fields it summarises changes.
//!
//! The effect of the Node hook runs on mount and whenever one of its dependencies changes (compared by identity); here the
//! fields are compared by value, so a field a new snapshot carries unchanged does not rebuild the panel.

use serde_json::Value;

/// The session fields the breakdown summarises (the dependencies of the effect). A field the state does not have is `null`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContextRefreshFields {
    pub stats: Value,
    pub context_window: Value,
    pub raw_context_window: Value,
    pub session_id: Value,
    pub tool_mode: Value,
    pub agent_workers: Value,
    pub agent_jobs: Value,
    pub provider: Value,
    pub model: Value,
    pub effort: Value,
    pub fast: Value,
    pub cwd: Value,
    pub client_host_pid: Value,
}

/// What the effect compared last: whether the context panel was the open one, and the fields.
#[derive(Clone, Debug, Default)]
pub struct ContextPanelRefresh {
    last: Option<(bool, ContextRefreshFields)>,
}

impl ContextPanelRefresh {
    pub fn new() -> Self {
        Self::default()
    }

    /// One render: `context_panel_open` is `contextPanelKind === 'context'`. Whether the panel is to be rebuilt
    /// ([`super::context::open_context_panel`]): it is the open panel and it just opened or a summarised field changed.
    pub fn observe(&mut self, context_panel_open: bool, fields: &ContextRefreshFields) -> bool {
        let unchanged = self.last.as_ref().is_some_and(|(open, last)| *open == context_panel_open && last == fields);
        if unchanged {
            return false;
        }
        self.last = Some((context_panel_open, fields.clone()));
        context_panel_open
    }
}
