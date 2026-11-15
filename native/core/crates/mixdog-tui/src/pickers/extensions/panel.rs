//! What the extension pickers paint and what they need from the application: the panel and row records, the host trait, the
//! status read every list starts with (`extension-pickers/scope-note.mjs`) and the claim helpers.

use mixdog_js::value_to_string;
use mixdog_term::os::{FolderPick, FolderPickOptions};
use mixdog_tui_style::Key;
use mixdog_tui_style::theme::theme_color;
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_tui_widgets::picker::{Footer, IndexMode, PickerItem, PickerProps};
use serde_json::{Map, Value, json};

use crate::app::AppCtx;
use crate::slash::host::{Opener, PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{truthy, value_text};
use crate::surface::epoch::PanelValue;
use crate::surface::latch::IndexModePanel;
use crate::surface::{SurfaceClaim, SurfaceKind};

/// The colour of a row marker (`theme.success`, `theme.inactive`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerTone {
    Success,
    Inactive,
}

/// A core-memory entry row as `parseMemoryCoreRows` built it: the fields the entry panel and the text prompts read.
#[derive(Clone, Debug, PartialEq)]
pub struct CoreEntry {
    /// `_id`, a JSON number.
    pub id: Value,
    /// `_indexRevision`, when the listing carried one.
    pub index_revision: Option<Value>,
    /// `_projectId`: the project slug, or `Null` for a common memory.
    pub project_id: Value,
    pub element: String,
    pub summary: String,
    pub orig_element: String,
    pub orig_summary: String,
}

impl CoreEntry {
    /// The full untruncated sentence: `_summary || _element`.
    pub fn sentence(&self) -> &str {
        if self.summary.is_empty() { &self.element } else { &self.summary }
    }
}

/// What a row does when it is chosen (`_action` and the `_server`, `_skill`, `_plugin`, `_project`, `_rows` it carried).
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// A row with nothing behind it (`_action: 'noop'`, or no action).
    Noop,
    Server { name: String, enabled: bool },
    Skill { skill: Value, enabled: bool },
    /// A project-skills row: Enter opens the skill's detail.
    View(Value),
    Plugin(Value),
    Installed,
    Add,
    Info,
    Update,
    EnableMcp,
    CopyRoot,
    CopyMcpName,
    Uninstall,
    AddCore,
    CoreList(Vec<ExtItem>),
    CoreEntry(Box<CoreEntry>),
    /// A listing line that is no entry: Enter shows it as a notice.
    Line(String),
    Delete,
    Edit,
    /// The project list's `Current Path` shortcut.
    Current,
    Project(Value),
    Use,
    Enable,
    Disable,
}

/// One row.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtItem {
    pub value: String,
    pub label: String,
    pub marker: String,
    pub marker_tone: Option<MarkerTone>,
    pub meta: String,
    pub description: String,
    pub action: Action,
}

impl ExtItem {
    pub fn new(value: &str, label: &str, description: &str, action: Action) -> Self {
        Self {
            value: value.to_owned(),
            label: label.to_owned(),
            marker: String::new(),
            marker_tone: None,
            meta: String::new(),
            description: description.to_owned(),
            action,
        }
    }

    /// The footer of a highlighted memory entry: its full sentence, nothing for any other row.
    fn entry_footer(&self) -> String {
        match &self.action {
            Action::CoreEntry(entry) => entry.sentence().to_owned(),
            _ => String::new(),
        }
    }
}

/// Which handler a panel's keys go to, with what the Node closures captured.
#[derive(Clone, Debug, PartialEq)]
pub enum Handler {
    McpServers,
    /// The Skills list: the skills it was built from and the disabled set its rows show.
    Skills { skills: Vec<Value>, disabled: super::disabled_skills::SkillSet },
    ProjectSkills,
    SkillDetail(Value),
    Plugins,
    InstalledPlugins,
    PluginDetail(Value),
    /// The Memory root, also its loading frame.
    MemoryRoot,
    /// The stored-memory list, also its loading frame.
    MemoryList,
    MemoryEntry(Box<CoreEntry>),
    Project { initial_entry: bool, current_path: String },
    /// The inert project panel shown while the folder dialog is open.
    ProjectOpening,
    Resume(Vec<Value>),
    MessageSelector,
}

/// A picker panel (the record `own.paint` took).
#[derive(Clone, Debug, PartialEq)]
pub struct ExtPanel {
    /// `_kind`, empty when the panel has none.
    pub kind: String,
    pub title: String,
    pub description: String,
    pub items: Vec<ExtItem>,
    pub initial_index: usize,
    pub loading: bool,
    pub label_width: Option<usize>,
    pub meta_width: Option<usize>,
    pub help: Option<String>,
    pub index_mode: Option<IndexMode>,
    /// The footer shows the full sentence of the highlighted memory entry (`entrySummaryFooter`).
    pub entry_footer: bool,
    pub handler: Handler,
    /// The request a project list was painted for (`_projectRequestId`).
    pub request_id: Option<u64>,
    /// The first-screen project list still waiting for its opener (`_projectInitialPending`).
    pub initial_pending: bool,
}

impl ExtPanel {
    pub fn new(title: &str, description: &str, items: Vec<ExtItem>, handler: Handler) -> Self {
        Self {
            kind: String::new(),
            title: title.to_owned(),
            description: description.to_owned(),
            items,
            initial_index: 0,
            loading: false,
            label_width: None,
            meta_width: None,
            help: None,
            index_mode: None,
            entry_footer: false,
            handler,
            request_id: None,
            initial_pending: false,
        }
    }

    pub fn with_kind(mut self, kind: &str) -> Self {
        self.kind = kind.to_owned();
        self
    }

    /// The loading frame of a panel: the description says so and no row is selectable.
    pub fn loading(title: &str, description: &str, handler: Handler) -> Self {
        Self { loading: true, ..Self::new(title, description, Vec::new(), handler) }
    }

    /// Whether Left and Right adjust the highlighted row (`onLeft`, `onRight`): the help line says so.
    pub fn adjustable(&self) -> bool {
        matches!(self.handler, Handler::McpServers | Handler::Skills { .. })
    }

    /// The widget props of this panel at `columns`.
    pub fn to_props(&self, columns: usize) -> PickerProps {
        let items: Vec<PickerItem> = self.items.iter().map(picker_item).collect();
        let mut props = PickerProps::new(items, &self.title);
        props.description = self.description.clone();
        props.help = self.help.clone();
        props.columns = columns;
        props.label_width = self.label_width;
        props.meta_width = self.meta_width;
        props.index_mode = self.index_mode.unwrap_or_default();
        props.loading = self.loading;
        props.adjustable = self.adjustable();
        if self.entry_footer {
            let footers: Vec<String> = self.items.iter().map(ExtItem::entry_footer).collect();
            props.footer = Footer::ByItem(Box::new(move |_, selected| match footers.get(selected) {
                Some(text) if !text.is_empty() => vec![FooterInput::plain(text)],
                _ => Vec::new(),
            }));
        }
        props
    }
}

fn picker_item(item: &ExtItem) -> PickerItem {
    PickerItem {
        marker: item.marker.clone(),
        marker_color: item.marker_tone.map(|tone| match tone {
            MarkerTone::Success => theme_color(Key::Success),
            MarkerTone::Inactive => theme_color(Key::Inactive),
        }),
        meta: item.meta.clone(),
        description: item.description.clone(),
        ..PickerItem::new(&item.value, &item.label)
    }
}

impl PanelValue for ExtPanel {
    fn kind(&self) -> &str {
        &self.kind
    }

    fn title(&self) -> &str {
        &self.title
    }
}

impl IndexModePanel for ExtPanel {
    fn index_mode(&self) -> Option<IndexMode> {
        self.index_mode
    }

    fn with_index_mode(self, mode: IndexMode) -> Self {
        Self { index_mode: Some(mode), ..self }
    }
}

/// The application's side of the extension pickers. Store calls and surface claims come from [`AppCtx`]; the rest is what
/// the Node factories received as `store.pushNotice`, the prompt setters, `copyToClipboard`, `getPicker`, `pickFolder` and the
/// prompt callbacks of the message selector.
pub trait ExtensionsHost: AppCtx {
    /// Whether the store has the method `name`: a call of a method it lacks answers `Ok(Null)`, as `store.name?.()` did.
    fn has_store_method(&self, name: &str) -> bool;
    fn push_notice(&mut self, text: &str, tone: Tone);
    /// A notice in the plain tone (`pushNotice(text, 'plain')`).
    fn push_plain_notice(&mut self, text: &str);
    fn now_ms(&self) -> u64;

    /// Whether `claim` still owns the surface (`own.owns()`).
    fn owns(&self, claim: SurfaceClaim) -> bool;
    /// `own.paint(panel)`: a guarded write; `None` clears the picker and keeps the flow. A write that lands re-arms `claim`
    /// on the surface it took. False when the claim no longer holds.
    fn paint(&mut self, claim: &mut SurfaceClaim, panel: Option<ExtPanel>) -> bool;
    /// `own.close()`: clears the picker and hands ownership back for good.
    fn close_claim(&mut self, claim: &mut SurfaceClaim) -> bool;
    /// `own.context(null)`: closes the context panel, which supersedes; `claim` is re-armed.
    fn clear_context(&mut self, claim: &mut SurfaceClaim) -> bool;
    /// `closeUsagePanel()`.
    fn close_usage_panel(&mut self);
    /// `isPanelEpochCurrent(token)`.
    fn is_panel_epoch_current(&self, token: u64) -> bool;
    /// The `_kind` of the picker on screen (`getPicker()?._kind`).
    fn picker_kind(&self) -> Option<String>;
    /// The request id of the project list on screen (`_projectRequestId`), when the picker on screen is one.
    fn project_request(&self) -> Option<u64>;

    /// `setProviderPrompt(next)` / `setSettingsPrompt(next)`.
    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>);
    /// The provider prompt on screen.
    fn provider_prompt(&self) -> Option<TextPrompt>;
    /// Opens the picker or panel `opener` (`returnTo()`, the reopen of the plugin MCP path).
    fn open(&mut self, opener: Opener, options: Value) -> Result<(), String>;

    /// `copyToClipboard(text)`.
    fn copy_to_clipboard(&mut self, text: &str) -> Result<(), String>;
    /// The OS folder dialog (`pickFolder`), blocking while it is open.
    fn pick_folder(&mut self, options: &FolderPickOptions) -> FolderPick;
    /// `state.cwd || process.cwd()`.
    fn cwd(&self) -> String;

    /// The disabled-skill set the application holds (`getDisabledSkills()`).
    fn disabled_skills(&self) -> super::disabled_skills::SkillSet;
    /// Replaces the held set (the React state of `useDisabledSkills`).
    fn hold_disabled_skills(&mut self, set: super::disabled_skills::SkillSet);

    /// The transcript items (`store.getState().items`).
    fn transcript_items(&self) -> Vec<Value>;
    /// `showPromptHint(text, tone)`.
    fn show_prompt_hint(&mut self, text: &str, tone: Tone);
    fn clear_prompt_hint(&mut self);
    /// `syncPromptLayoutRows(text)`.
    fn sync_prompt_layout_rows(&mut self, text: &str);
    /// `setPromptDraftOverride({ id, value })`.
    fn set_prompt_draft_override(&mut self, id: u64, value: &str);
    /// `installPastedImages(images, { merge: true })`.
    fn install_pasted_images(&mut self, images: &Value);
    /// `installPastedTexts(texts, { merge: true })`.
    fn install_pasted_texts(&mut self, texts: &Value);
}

/// `surface.claim()`.
pub fn claim(host: &mut dyn ExtensionsHost) -> SurfaceClaim {
    host.claim_surface(SurfaceKind::Picker)
}

/// `surface.claim().close()`: the keypress that runs this owns the surface it clears.
pub fn close_now(host: &mut dyn ExtensionsHost) {
    let mut own = claim(host);
    host.close_claim(&mut own);
}

/// `createStoreServiceCall(store)(name, ...args)` of the project cluster: `Err` when the store has no such method.
pub fn service_call(host: &mut dyn ExtensionsHost, name: &str, args: Value) -> Result<Value, String> {
    if !host.has_store_method(name) {
        return Err(format!("project service method {name} is unavailable"));
    }
    host.store_call(name, args)
}

/// `readStatus(store, method, key, failureLabel)`: one daemon status list. A method the store lacks, a falsy answer, a missing
/// or non-list field all give an empty list; a failure is reported and gives `None`, so the caller paints nothing.
pub fn read_status(host: &mut dyn ExtensionsHost, method: &str, key: &str, label: &str) -> Option<Map<String, Value>> {
    match host.store_call(method, json!([])) {
        Err(error) => {
            host.push_notice(&format!("{label} failed: {error}"), Tone::Error);
            None
        }
        Ok(status) => {
            let mut status = match status {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            if !status.get(key).is_some_and(Value::is_array) {
                status.insert(key.to_owned(), Value::Array(Vec::new()));
            }
            Some(status)
        }
    }
}

/// The list `key` of a status read.
pub fn status_list(status: &Map<String, Value>, key: &str) -> Vec<Value> {
    status.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Project scope from a decorated status row: empty when global, else a short note (`scopeNote`).
pub fn scope_note(row: &Value) -> String {
    if row.get("activeHere") == Some(&Value::Bool(false)) {
        return "not in this project".to_owned();
    }
    let len = |key: &str| row.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    let own = len("scope");
    let count = if own > 0 { own } else { len("inheritedScope") };
    match count {
        0 => String::new(),
        1 => "1 project".to_owned(),
        count => format!("{count} projects"),
    }
}

/// `withScope(text, row)`.
pub fn with_scope(text: &str, row: &Value) -> String {
    let note = scope_note(row);
    if note.is_empty() { text.to_owned() } else { format!("{text} \u{b7} {note}") }
}

/// `String(row[key])` where `row[key] || fallback` is meant: the text of the field when it is truthy, else `fallback`.
pub fn or_text(row: &Value, key: &str, fallback: &str) -> String {
    match row.get(key) {
        Some(value) if truthy(value) => value_text(value),
        _ => fallback.to_owned(),
    }
}

/// `String(value)` of a member that may be missing (`undefined`).
pub fn js_text(row: &Value, key: &str) -> String {
    row.get(key).map_or_else(|| "undefined".to_owned(), value_to_string)
}
