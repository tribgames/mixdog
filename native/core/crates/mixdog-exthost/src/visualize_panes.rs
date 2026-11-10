//! The core's copy of the desktop's visualize tabs with their resolved files, folded from what the desktop publishes as
//! `host/state/set {key: "visualize"}` exactly as Node's daemon folded main's (`createRemoteVisualizeMirror`,
//! `remote-visualize.ts`): a snapshot replaces every session, an event's state replaces or removes its session. A paired
//! phone renders a pane's pages (`visualizePanePages`) only for a PDF or Office pane's own file, inside the pane's root
//! (`pane.root ?? tab.cwd`).

use std::collections::HashMap;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

#[derive(Default)]
pub struct VisualizePanes {
    /// Per session id, the session's state as the desktop sent it.
    sessions: Mutex<HashMap<String, Value>>,
}

/// `hostState`: a state names its session and has a tab list.
fn host_state(value: &Value) -> Option<&Value> {
    let named = value.get("sessionId").and_then(Value::as_str).is_some_and(|id| !id.is_empty());
    (named && value.get("tabs").is_some_and(Value::is_array)).then_some(value)
}

/// `state.tabs.length || state.history?.length`.
fn kept(state: &Value) -> bool {
    let len = |key: &str| state.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    len("tabs") > 0 || len("history") > 0
}

/// `path.resolve` without the file system: `.` and `..` folded.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Node's `comparable`: lower case on Windows.
fn comparable(path: &Path) -> String {
    let text = lexical(path).to_string_lossy().into_owned();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

impl VisualizePanes {
    /// One `visualize` value of `host/state/set`: the whole snapshot (`replace`) or one change event (`apply`).
    pub fn fold(&self, value: &Value) {
        let mut sessions = self.sessions.lock().expect("visualize panes");
        match value {
            Value::Array(states) => {
                *sessions = states
                    .iter()
                    .filter_map(host_state)
                    .filter(|state| kept(state))
                    .map(|state| (state["sessionId"].as_str().unwrap_or_default().to_owned(), state.clone()))
                    .collect();
            }
            Value::Object(event) => {
                let Some(session) = event.get("sessionId").and_then(Value::as_str).filter(|id| !id.is_empty()) else { return };
                if let Some(state) = event.get("state").and_then(host_state) {
                    if kept(state) {
                        sessions.insert(session.to_owned(), state.clone());
                    } else {
                        sessions.remove(session);
                    }
                }
            }
            _ => {}
        }
    }

    /// Whether `root` and `rel` name a PDF or Office pane's own file, `root` being that pane's root (`visualizePanePages`).
    pub fn page_file(&self, root: &Path, rel: &str) -> bool {
        let (root_key, file_key) = (comparable(root), comparable(&root.join(rel)));
        let sessions = self.sessions.lock().expect("visualize panes");
        sessions.values().flat_map(|state| state["tabs"].as_array().into_iter().flatten()).any(|tab| {
            let cwd = tab.get("cwd").and_then(Value::as_str);
            tab.get("panes").and_then(Value::as_array).into_iter().flatten().any(|pane| {
                let kind = pane.get("kind").and_then(Value::as_str);
                let path = pane.get("path").and_then(Value::as_str).filter(|path| !path.is_empty());
                let pane_root = match pane.get("root") {
                    Some(Value::String(root)) => Some(root.as_str()),
                    None | Some(Value::Null) => cwd,
                    Some(_) => None,
                };
                matches!(kind, Some("pdf" | "document"))
                    && path.is_some_and(|path| comparable(Path::new(path)) == file_key)
                    && pane_root.is_some_and(|pane_root| comparable(Path::new(pane_root)) == root_key)
            })
        })
    }
}
