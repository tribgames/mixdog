//! The core's copy of the desktop's visualize tabs with their resolved files, folded from what the desktop publishes as
//! `host/state/set {key: "visualize"}` exactly as Node's daemon folded main's (`createRemoteVisualizeMirror`,
//! `remote-visualize.ts`): a snapshot replaces every session, an event's state replaces or removes its session. A paired
//! phone renders a pane's pages (`visualizePanePages`) only for a PDF or Office pane's own file, inside the pane's root
//! (`pane.root ?? tab.cwd`).

use std::collections::HashMap;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use serde_json::Value;
use serde_json::json;

/// The characters of one part of an oversized event (a section value is held up to `INLINE_MAX` bytes, and escaping can multiply a
/// character's size).
pub const PART_CHARS: usize = 40_000;

/// 3 panes, doubled while a kept version is compared with live (`MAX_PANES`, `remote-visualize.ts:185`).
pub const MAX_PANES: usize = 6;

/// One pane of a tab with its resolved file, as a paired phone's read of it is decided (`mixdog_workspace::visualize_pane`).
#[derive(Clone, Debug)]
pub struct TabPane {
    pub kind: String,
    /// The pane's resolved file; empty for an inline pane.
    pub path: PathBuf,
    /// The pane's own root, else the tab's working directory (`rootOf`, `remote-visualize.ts:137`).
    pub root: PathBuf,
    pub inline: bool,
    pub version: Option<i64>,
}

/// What a phone's read is made under: `root` is the folder its `rel` is relative to (the asked pane's root, else the tab's cwd).
#[derive(Clone, Debug)]
pub struct PaneScope {
    pub root: PathBuf,
    pub panes: Vec<TabPane>,
}

/// Reads of a pane's files for a paired phone, on the file system (the workspace owns the containment checks).
#[async_trait]
pub trait PaneFiles: Send + Sync {
    async fn range(&self, req: &CoreRequest, scope: PaneScope, rel: String, offset: u64, length: u64) -> Result<Value, CoreError>;
    async fn file(&self, req: &CoreRequest, scope: PaneScope, index: usize) -> Result<Value, CoreError>;
}

/// A PDF or Office pane's pages for a paired phone: the document service's `document/previewPages` on the pane's own file.
#[async_trait]
pub trait PanePages: Send + Sync {
    async fn pages(&self, req: &CoreRequest, root: String, rel: String, options: Value) -> Result<Value, CoreError>;
    /// The PDF an Office pane converts to, converted from a private copy of the file's authorized bytes (Node's `servedFile`,
    /// `remote-visualize.ts:156-165`); it lives in the core's conversion cache, outside the pane's root.
    async fn converted(&self, req: &CoreRequest, root: String, rel: String) -> Result<PathBuf, CoreError>;
}

/// The phones a visualize change goes to, and how: each connection that views the session gets every payload of the change, whole, in
/// order, as connection-scoped notifications (`visualize/changed`), which the connection's control queue holds in order and never
/// merges (a reader too slow to keep them is closed, as Node closed a client over its backlog). `everyone`: the change names a URL to
/// open, which goes to every attached phone.
pub trait VisualizePush: Send + Sync {
    fn push(&self, session_id: &str, everyone: bool, payloads: Vec<Value>);
    /// The connection's page registers or drops the visualize lane it reads.
    fn set_lane(&self, connection: mixdog_core_api::ids::ConnectionId, on: bool);
}

#[derive(Default)]
pub struct VisualizePanes {
    /// Per session id, the session's state as the desktop sent it.
    sessions: Mutex<HashMap<String, Value>>,
    /// Where the events of a session go: bound once the composition has the connection notifier and the device registry.
    push: OnceLock<Arc<dyn VisualizePush>>,
    /// Bound once the composition has built the workspace and the document service (they are built after the visualize service).
    files: OnceLock<Arc<dyn PaneFiles>>,
    pages: OnceLock<Arc<dyn PanePages>>,
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

/// `path.relative(root, file)` with `/` separators; none when `file` is not under `root`.
fn relative_of(root: &Path, file: &Path) -> Option<String> {
    let (root, file) = (lexical(root), lexical(file));
    if !PathBuf::from(comparable(&file)).starts_with(PathBuf::from(comparable(&root))) {
        return None;
    }
    let rest: PathBuf = file.components().skip(root.components().count()).collect();
    Some(rest.to_string_lossy().replace('\\', "/"))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A tab's panes as a phone's read sees them; a pane without its own root is under the tab's working directory.
fn tab_panes(tab: &Value) -> Vec<TabPane> {
    let cwd = text(tab, "cwd").unwrap_or_default();
    tab.get("panes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|pane| TabPane {
            kind: text(pane, "kind").unwrap_or_default().to_owned(),
            path: PathBuf::from(text(pane, "path").unwrap_or_default()),
            root: PathBuf::from(text(pane, "root").unwrap_or(cwd)),
            inline: pane.get("inline").is_some_and(|inline| !inline.is_null()),
            version: pane.get("version").and_then(Value::as_i64),
        })
        .collect()
}

/// A state with every host path left out (`cwd`, a pane's `path`, `root` and `target`): "clients only ever see the path-free state"
/// (`remote-visualize.ts:1-5`). The phone's adapter shapes the rest (`remoteVisualizeState`).
fn without_paths(state: &Value) -> Value {
    let mut state = state.clone();
    for tab in state.get_mut("tabs").and_then(Value::as_array_mut).into_iter().flatten() {
        if let Some(tab) = tab.as_object_mut() {
            tab.swap_remove("cwd");
        }
        for pane in tab.get_mut("panes").and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(pane) = pane.as_object_mut() {
                for key in ["path", "root", "target"] {
                    pane.swap_remove(key);
                }
            }
        }
    }
    state
}

impl VisualizePanes {
    /// What the `hostState` `visualize` section carries for a value the desktop set: the section is readable by a paired phone's
    /// subscription, so it never holds a host path. A snapshot is its states path-free; an event is its change fields alone
    /// (`reveal`, `tab`, `updated`, `held`, `heldSince`, `openUrl`) with `stateChanged: true` where it carried a state, which the
    /// phone reads from the core by `visualize/command`. So an event of any size keeps every field, and none is held back as a stub.
    ///
    /// An event keeps Node's shape: the state it announces, path-free, with its own effect fields exactly as the producer published them
    /// (`held` present or absent, `reveal`, `tab`, `updated`, `heldSince`, `openUrl`), so a phone applies it alone and in order. A
    /// section value is held only up to `INLINE_MAX`, and no stub can say what an event did; an event over [`PART_CHARS`] of JSON is
    /// therefore published as ordered `part` values of the same key (`{part:{id,index,count,text}}`, the text being slices of the
    /// event's JSON) that the phone puts back together. A snapshot is the state alone: a phone that cannot hold it reads it again.
    pub fn remote_changes(value: &Value) -> Vec<Value> {
        match value {
            Value::Array(states) => vec![Value::Array(states.iter().map(without_paths).collect())],
            Value::Object(event) => {
                let mut event = event.clone();
                if let Some(state) = event.get("state").filter(|state| !state.is_null()).map(without_paths) {
                    event.insert("state".to_owned(), state);
                }
                let event = Value::Object(event);
                let text = event.to_string();
                if text.chars().count() <= PART_CHARS {
                    return vec![event];
                }
                static PARTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                let id = PARTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let chars: Vec<char> = text.chars().collect();
                let slices: Vec<String> = chars.chunks(PART_CHARS).map(|slice| slice.iter().collect()).collect();
                let count = slices.len();
                slices.into_iter().enumerate().map(|(index, text)| json!({ "part": { "id": id, "index": index, "count": count, "text": text } })).collect()
            }
            other => vec![other.clone()],
        }
    }

    /// The notifier that carries events to phones; bound once.
    pub fn bind_push(&self, push: Arc<dyn VisualizePush>) {
        let _ = self.push.set(push);
    }

    /// A phone's page registers (`on`) or drops the visualize lane it reads; false when no composition bound a push.
    pub fn set_lane(&self, connection: mixdog_core_api::ids::ConnectionId, on: bool) -> bool {
        let Some(push) = self.push.get() else { return false };
        push.set_lane(connection, on);
        true
    }

    /// One change event of the desktop's, to the phones that view its session, whole and in order.
    pub fn push_event(&self, value: &Value) {
        let Some(push) = self.push.get() else { return };
        let Some(session) = value.get("sessionId").and_then(Value::as_str).filter(|id| !id.is_empty()) else { return };
        let everyone = value.get("openUrl").and_then(Value::as_str).is_some_and(|url| !url.is_empty());
        push.push(session, everyone, Self::remote_changes(value));
    }

    /// The workspace's reads of pane files; bound once.
    pub fn bind_files(&self, files: Arc<dyn PaneFiles>) {
        let _ = self.files.set(files);
    }

    /// The document service's page renders; bound once.
    pub fn bind_pages(&self, pages: Arc<dyn PanePages>) {
        let _ = self.pages.set(pages);
    }

    pub fn files(&self) -> Option<&Arc<dyn PaneFiles>> {
        self.files.get()
    }

    pub fn pages(&self) -> Option<&Arc<dyn PanePages>> {
        self.pages.get()
    }

    /// Every kept session's state, path-free (`visualizeState`'s snapshot, `mirror.replace`'s return), by session id.
    pub fn remote_states(&self) -> Vec<Value> {
        let sessions = self.sessions.lock().expect("visualize panes");
        let mut ids: Vec<&String> = sessions.keys().collect();
        ids.sort();
        ids.into_iter().map(|id| without_paths(&sessions[id])).collect()
    }

    fn tab(&self, session: &str, tab_id: &str) -> Result<Value, String> {
        let sessions = self.sessions.lock().expect("visualize panes");
        sessions
            .get(session)
            .and_then(|state| state.get("tabs").and_then(Value::as_array))
            .and_then(|tabs| tabs.iter().find(|tab| text(tab, "id") == Some(tab_id)))
            .cloned()
            .ok_or_else(|| "This visualize tab is closed.".to_owned())
    }

    /// `visualizePaneInline`: the inline content of pane `index` (`kind`, `source`, `title` when it has one).
    pub fn inline(&self, session: &str, tab_id: &str, index: usize) -> Result<Value, String> {
        let tab = self.tab(session, tab_id)?;
        let inline = tab.get("panes").and_then(Value::as_array).and_then(|panes| panes.get(index)).and_then(|pane| pane.get("inline")).filter(|inline| !inline.is_null());
        let Some(inline) = inline else { return Err("This visualize pane has no inline content.".to_owned()) };
        let mut answer = json!({ "kind": inline.get("kind").cloned().unwrap_or(Value::Null), "source": inline.get("source").cloned().unwrap_or(Value::Null) });
        if let Some(title) = text(inline, "title").filter(|title| !title.is_empty()) {
            answer["title"] = json!(title);
        }
        Ok(answer)
    }

    /// What a read of `tab_id` is made under: the tab's panes, and as the root the asked pane's (`index`) or the tab's working
    /// directory.
    pub fn scope(&self, session: &str, tab_id: &str, index: Option<usize>) -> Result<PaneScope, String> {
        let tab = self.tab(session, tab_id)?;
        let panes = tab_panes(&tab);
        let root = match index {
            Some(index) => panes.get(index).ok_or_else(|| "This visualize pane is closed.".to_owned())?.root.clone(),
            None => PathBuf::from(text(&tab, "cwd").unwrap_or_default()),
        };
        Ok(PaneScope { root, panes })
    }

    /// `visualizePanePages`: the root and file of a PDF or Office pane (`document/previewPages` admits exactly these).
    pub fn page_target(&self, session: &str, tab_id: &str, index: usize) -> Result<(String, String), String> {
        let pane = self.scope(session, tab_id, None)?.panes.into_iter().nth(index).ok_or_else(|| "This visualize pane is closed.".to_owned())?;
        if pane.kind != "pdf" && pane.kind != "document" {
            return Err("Only PDF and Office panes have pages.".to_owned());
        }
        let rel = relative_of(&pane.root, &pane.path).ok_or_else(|| "This file is not part of the visualize tab.".to_owned())?;
        Ok((pane.root.to_string_lossy().into_owned(), rel))
    }

    /// One `visualize` value of `host/state/set`: the whole snapshot (replaces the mirror) or one change event (applies to
    /// it). The order is the order of calls: the server applies one connection's publications in their arrival order.
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
                        // The state carries whether its session is held now and since when, as the producer last said it: `held` on
                        // the event while the agent turn runs, and its absence on the state-bearing event that releases it. A snapshot
                        // read is thereby authoritative about holds. The producer's snapshot carries the same fields per session, so the map a
                        // snapshot replaces is exactly what the producer holds.
                        let mut state = state.clone();
                        if let Some(fields) = state.as_object_mut() {
                            fields.swap_remove("held");
                            fields.swap_remove("heldSince");
                            if event.get("held").and_then(Value::as_bool) == Some(true) {
                                fields.insert("held".to_owned(), Value::Bool(true));
                                if let Some(since) = event.get("heldSince").filter(|since| since.is_i64()) {
                                    fields.insert("heldSince".to_owned(), since.clone());
                                }
                            }
                        }
                        sessions.insert(session.to_owned(), state);
                    } else {
                        sessions.remove(session);
                    }
                }
            }
            _ => {}
        }
    }

    /// The Office pane of `scope` whose file `rel` (under the scope's root) names: its reads are of the converted PDF.
    pub fn document_pane(scope: &PaneScope, rel: &str) -> Option<TabPane> {
        let file = comparable(&scope.root.join(rel));
        scope.panes.iter().find(|pane| pane.kind == "document" && !pane.inline && comparable(&pane.path) == file).cloned()
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
