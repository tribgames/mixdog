//! The footer of the application (`StatusLine` of `app-view.jsx`): the statusline text machine fed from the published state.
//!
//! `app-view.jsx` hands the component the session's route, folder, stats, windows, agents and active tools; the hook
//! ([`crate::footer::StatuslineText`]) holds the line. Here the same props are read from the store's state on every turn of the
//! loop, the machine's timers are run from the application's timers, and the frame paints its line.

use std::hash::{Hash, Hasher};

use serde_json::{Value, json};

use super::AppState;
use crate::footer::{FooterInputs, RenderArgs, StatuslineRenderer, StatuslineText};
use crate::transcript::scroll::activity::{active_tools, active_tools_signature, agent_revision, statusline_stats};

/// The footer of a running application: the machine, and when its shared refresh tick fires next (the renderer's clock).
pub struct AppStatusline {
    text: StatuslineText,
    renderer: StatuslineRenderer,
    refresh_at: f64,
}

fn number(state: &Value, name: &str) -> f64 {
    state.get(name).and_then(Value::as_f64).unwrap_or(0.0)
}

fn text(state: &Value, name: &str) -> String {
    state.get(name).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn list(state: &Value, name: &str) -> Vec<Value> {
    state.get(name).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The props `app-view.jsx` gives `StatusLine`, read from the published `state`.
pub(crate) fn footer_inputs(state: &Value, columns: usize, rows: usize) -> FooterInputs {
    let fast = state.get("fast") == Some(&Value::Bool(true));
    let ultra = fast && state.pointer("/modelParameters/serviceTier").and_then(Value::as_str) == Some("ultrafast");
    // `activeTools`: the engine's summary when it published one, else the scan of the items.
    let signature = match state.get("activeToolSummary") {
        Some(summary) => summary.as_str().unwrap_or_default().to_owned(),
        None => active_tools_signature(state),
    };
    let tools = active_tools(&signature).map(|tools| {
        let mut entries = serde_json::Map::new();
        for (name, tool) in [("shell", tools.shell), ("web_search", tools.web_search), ("agent", tools.agent)] {
            if let Some(tool) = tool {
                entries.insert(name.to_owned(), json!({ "count": tool.count, "startedAt": tool.started_at }));
            }
        }
        Value::Object(entries)
    });
    let mut revision = std::collections::hash_map::DefaultHasher::new();
    agent_revision(state).hash(&mut revision);
    FooterInputs {
        args: RenderArgs {
            session_id: state.get("sessionId").and_then(Value::as_str).map(str::to_owned),
            client_host_pid: state.get("clientHostPid").and_then(Value::as_f64),
            provider: text(state, "provider"),
            model: text(state, "model"),
            effort: text(state, "effort"),
            fast,
            ultra,
            cwd: text(state, "cwd"),
            stats: Some(statusline_stats(state)),
            context_window: number(state, "contextWindow"),
            display_context_window: number(state, "displayContextWindow"),
            raw_context_window: number(state, "rawContextWindow"),
            compact_boundary_tokens: number(state, "compactBoundaryTokens"),
            auto_compact_token_limit: number(state, "autoCompactTokenLimit"),
            agent_workers: list(state, "agentWorkers"),
            agent_jobs: list(state, "agentJobs"),
            active_tools: tools,
            terminal_columns: Some(columns as f64),
        },
        resize_epoch: ((columns as u64) << 20) | rows as u64,
        agent_revision: revision.finish(),
        theme_epoch: state.get("themeEpoch").and_then(Value::as_u64).unwrap_or(0),
    }
}

impl AppStatusline {
    fn new(renderer: StatuslineRenderer, inputs: &FooterInputs, initial_line: Option<&str>) -> Self {
        let text = StatuslineText::new(renderer.clone(), inputs, initial_line);
        let refresh_at = renderer.now() + text.refresh_ms();
        Self { text, renderer, refresh_at }
    }

    /// One turn of the loop: the component rendered with `inputs`, the refresh tick and the machine's timers that are due.
    /// Whether the line changed.
    fn turn(&mut self, inputs: &FooterInputs) -> bool {
        let before = self.text.line().to_owned();
        self.text.update(inputs);
        let now = self.renderer.now();
        if now >= self.refresh_at {
            self.text.refresh_tick(inputs);
            self.refresh_at = now + self.text.refresh_ms();
        }
        if self.text.next_wake().is_some_and(|at| at <= now) {
            self.text.poll();
        }
        self.text.line() != before
    }

    /// How long until this footer needs a turn again, in milliseconds.
    fn wake_in_ms(&self) -> f64 {
        let now = self.renderer.now();
        let at = self.text.next_wake().map_or(self.refresh_at, |wake| wake.min(self.refresh_at));
        (at - now).max(0.0)
    }
}

impl AppState {
    /// Gives the application its footer (`initialStatusLine` is a line the previous footer saved).
    pub fn set_statusline(&mut self, renderer: StatuslineRenderer, initial_line: Option<&str>) {
        let inputs = footer_inputs(&self.store.state(), self.view_columns, 0);
        self.statusline = Some(AppStatusline::new(renderer, &inputs, initial_line));
    }

    /// The footer's turn; whether its line changed (the frame is then drawn again).
    pub fn statusline_turn(&mut self, columns: usize, rows: usize) -> bool {
        let Some(mut footer) = self.statusline.take() else { return false };
        let inputs = footer_inputs(&self.store.state(), columns, rows);
        let changed = footer.turn(&inputs);
        self.statusline = Some(footer);
        changed
    }

    /// When the footer needs its next turn, in milliseconds from now; `None` without a footer.
    pub fn statusline_wake_in_ms(&self) -> Option<f64> {
        self.statusline.as_ref().map(AppStatusline::wake_in_ms)
    }

    /// The line the frame paints under the prompt.
    pub(crate) fn statusline_line(&self) -> &str {
        self.statusline.as_ref().map_or("", |footer| footer.text.line())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_props_are_read_from_the_state_as_app_view_hands_them() {
        let state = json!({
            "sessionId": "s1", "provider": "anthropic", "model": "claude-sonnet-4-6", "effort": "high", "fast": true,
            "modelParameters": { "serviceTier": "ultrafast" }, "cwd": "/w", "contextWindow": 200000, "themeEpoch": 3,
            "agentWorkers": [{ "tag": "a" }], "activeToolSummary": "0:0:2:17:0:0",
        });
        let inputs = footer_inputs(&state, 120, 40);
        assert_eq!(inputs.args.session_id.as_deref(), Some("s1"));
        assert_eq!((inputs.args.provider.as_str(), inputs.args.model.as_str(), inputs.args.effort.as_str()), ("anthropic", "claude-sonnet-4-6", "high"));
        assert!(inputs.args.fast && inputs.args.ultra);
        assert_eq!(inputs.args.context_window, 200_000.0);
        assert_eq!(inputs.args.agent_workers.len(), 1);
        assert_eq!(inputs.args.active_tools, Some(json!({ "web_search": { "count": 2.0, "startedAt": 17.0 } })));
        assert_eq!(inputs.args.terminal_columns, Some(120.0));
        assert_eq!(inputs.theme_epoch, 3);
        // A resize is a new epoch; the same size is the same one.
        assert_ne!(inputs.resize_epoch, footer_inputs(&state, 121, 40).resize_epoch);
        assert_eq!(inputs.resize_epoch, footer_inputs(&state, 120, 40).resize_epoch);
    }

    #[test]
    fn a_fast_route_that_is_not_ultrafast_is_not_ultra_and_no_tool_is_none() {
        let inputs = footer_inputs(&json!({ "fast": true, "items": [] }), 80, 24);
        assert!(inputs.args.fast && !inputs.args.ultra);
        assert_eq!(inputs.args.active_tools, None);
        assert_eq!(inputs.args.session_id, None);
    }
}
