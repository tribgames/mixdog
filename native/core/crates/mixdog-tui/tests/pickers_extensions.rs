//! The Rust extension pickers against what the Node code does (tests/goldens/pickers-extensions.json, recorded by
//! tests/recorders/record-pickers-extensions.mjs): the item lists, the notices, the store call logs, the prompts and the
//! panels left on screen of whole scenarios driven by the same scripted store, plus the cases the recording cannot express (the
//! toggle settling after Esc, the status normalisation, the formatters, the selector's caps).
//!
//! The recorder is run on a Node checkout (`node tests/recorders/record-pickers-extensions.mjs --tree <checkout> --check
//! tests/goldens/pickers-extensions.json`); this test only reads the recording.

use std::collections::BTreeMap;

use mixdog_term::os::{FolderPick, FolderPickOptions};
use mixdog_tui::app::AppCtx;
use mixdog_tui::pickers::PickerKind;
use mixdog_tui::pickers::extensions::disabled_skills::SkillSet;
use mixdog_tui::pickers::extensions::message_selector::{has_user_messages, message_selector_label, selectable_user_items};
use mixdog_tui::pickers::extensions::panel::{read_status, scope_note};
use mixdog_tui::pickers::extensions::resume::{format_session_message_count, format_session_updated_at};
use mixdog_tui::pickers::extensions::{Action, ExtPanel, Extensions, ExtensionsHost, Handler};
use mixdog_tui::slash::host::{Opener, PromptSurface, TextPrompt, Tone};
use mixdog_tui::surface::epoch::PanelValue;
use mixdog_tui::surface::owner::PanelSurface;
use mixdog_tui::surface::{SurfaceClaim, SurfaceKind};
use mixdog_tui_widgets::picker::IndexMode;
use serde_json::{Value, json};
const NOW_MS: u64 = 1_000_000;

/// What the recorder logs apart.
const CHANNELS: [&str; 9] = ["calls", "notices", "paints", "prompts", "returns", "clipboard", "hints", "errors", "values"];

fn action_name(action: &Action) -> Value {
    let name = match action {
        Action::Noop | Action::Line(_) | Action::Project(_) => return Value::Null,
        Action::Server { .. } => "server",
        Action::Skill { .. } => "skill",
        Action::View(_) => "view",
        Action::Plugin(_) => "plugin",
        Action::Installed => "installed",
        Action::Add => "add",
        Action::Info => "info",
        Action::Update => "update",
        Action::EnableMcp => "enable-mcp",
        Action::CopyRoot => "copy-root",
        Action::CopyMcpName => "copy-mcp-name",
        Action::Uninstall => "uninstall",
        Action::AddCore => "add-core",
        Action::CoreList(_) => "core-list",
        Action::CoreEntry(_) => "core-entry",
        Action::Delete => "delete",
        Action::Edit => "edit",
        Action::Current => "current",
        Action::Use => "use",
        Action::Enable => "enable",
        Action::Disable => "disable",
    };
    json!(name)
}

fn snap_panel(panel: &ExtPanel) -> Value {
    let items: Vec<Value> = panel
        .items
        .iter()
        .map(|item| {
            json!({
                "value": item.value,
                "label": item.label,
                "marker": item.marker,
                "markerColor": item.marker_tone.map(|tone| format!("{tone:?}").to_lowercase()),
                "meta": item.meta,
                "description": item.description,
                "action": action_name(&item.action),
            })
        })
        .collect();
    let footer = panel.entry_footer.then(|| {
        panel
            .items
            .iter()
            .map(|item| match &item.action {
                Action::CoreEntry(entry) => entry.sentence().to_owned(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
    });
    json!({
        "kind": (!panel.kind.is_empty()).then_some(&panel.kind),
        "title": panel.title,
        "description": panel.description,
        "loading": panel.loading,
        "help": panel.help,
        "labelWidth": panel.label_width,
        "metaWidth": panel.meta_width,
        "indexMode": panel.index_mode.map(|mode| match mode {
            IndexMode::Always => "always",
            IndexMode::Never => "never",
            IndexMode::Auto => "auto",
        }),
        "initialIndex": panel.initial_index,
        "adjust": panel.adjustable(),
        "footer": footer,
        "items": items,
    })
}

fn snap_prompt(prompt: &Option<TextPrompt>) -> Value {
    let Some(prompt) = prompt else { return Value::Null };
    let field = |key: &str| prompt.fields.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "kind": prompt.kind,
        "label": prompt.label,
        "hint": prompt.hint,
        "initialValue": prompt.initial_value,
        "providerName": field("providerName"),
        "detail": field("detail"),
        "projectPath": field("projectPath"),
        "skillName": field("skillName"),
        "_id": field("_id"),
        "_indexRevision": field("_indexRevision"),
        "_projectId": field("_projectId"),
        "_singleSentence": field("_singleSentence"),
    })
}

/// A recording host over a scripted store, with the surface of the application.
struct Fake {
    store: BTreeMap<String, Value>,
    sequence: BTreeMap<String, usize>,
    surface: PanelSurface<ExtPanel, (), ()>,
    log: BTreeMap<&'static str, Vec<Value>>,
    provider: Option<TextPrompt>,
    settings: Option<TextPrompt>,
    disabled: SkillSet,
    items: Vec<Value>,
    cwd: String,
    pick: Value,
    copy_fails: Option<String>,
    /// A store call of this method supersedes the surface first (Esc lands while it is in flight).
    esc_on: Option<&'static str>,
    now: u64,
}

impl Fake {
    fn new(spec: &Value) -> Self {
        let store = spec.get("store").and_then(Value::as_object).map(|map| map.clone().into_iter().collect()).unwrap_or_default();
        Self {
            store,
            sequence: BTreeMap::new(),
            surface: PanelSurface::new(),
            log: CHANNELS.iter().map(|name| (*name, Vec::new())).collect(),
            provider: None,
            settings: None,
            disabled: spec
                .get("disabled")
                .and_then(Value::as_array)
                .map(|names| names.iter().filter_map(|name| name.as_str().map(str::to_owned)).collect())
                .unwrap_or_default(),
            items: spec.get("items").and_then(Value::as_array).cloned().unwrap_or_default(),
            cwd: spec.get("cwd").and_then(Value::as_str).unwrap_or("C:\\current").to_owned(),
            pick: spec.get("pickFolder").cloned().unwrap_or_else(|| json!({"available": true, "path": null})),
            copy_fails: spec.get("copyFails").and_then(Value::as_str).map(str::to_owned),
            esc_on: None,
            now: NOW_MS,
        }
    }

    fn push(&mut self, channel: &'static str, entry: Value) {
        self.log.get_mut(channel).expect("a known channel").push(entry);
    }

    fn live(&self) -> Option<ExtPanel> {
        self.surface.live_picker().cloned()
    }

}

impl AppCtx for Fake {
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String> {
        let args = args.as_array().cloned().unwrap_or_default();
        if self.esc_on == Some(action) {
            self.surface.supersede();
        }
        let Some(script) = self.store.get(action).cloned() else {
            // The hook that holds the disabled set always writes through; a method the store lacks answers nothing.
            if action == "setDisabledSkills" {
                self.push("calls", json!([action, args[0]]));
            }
            return Ok(Value::Null);
        };
        let mut entry = vec![json!(action)];
        entry.extend(args.iter().cloned());
        self.push("calls", Value::Array(entry));
        let answer = match script.get("$seq").and_then(Value::as_array) {
            Some(answers) => {
                let at = self.sequence.entry(action.to_owned()).or_insert(0);
                let answer = answers[(*at).min(answers.len() - 1)].clone();
                *at += 1;
                answer
            }
            None => script,
        };
        if let Some(text) = answer.get("$throw").and_then(Value::as_str) {
            return Err(text.to_owned());
        }
        if let Some(at) = answer.get("$echo").and_then(Value::as_u64) {
            return Ok(args.get(at as usize).cloned().unwrap_or(Value::Null));
        }
        Ok(answer)
    }

    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim {
        self.surface.surface_claim(kind)
    }

    fn open_picker(&mut self, _kind: PickerKind) -> SurfaceClaim {
        self.surface.surface_claim(SurfaceKind::Picker)
    }
}

impl ExtensionsHost for Fake {
    fn has_store_method(&self, name: &str) -> bool {
        self.store.contains_key(name)
    }

    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.push("notices", json!([text, tone.as_str()]));
    }

    fn push_plain_notice(&mut self, text: &str) {
        self.push("notices", json!([text, "plain"]));
    }

    fn now_ms(&self) -> u64 {
        self.now
    }

    fn owns(&self, claim: SurfaceClaim) -> bool {
        self.surface.epoch().is_current(claim.epoch)
    }

    fn paint(&mut self, claim: &mut SurfaceClaim, panel: Option<ExtPanel>) -> bool {
        if !self.owns(*claim) {
            return false;
        }
        self.push("paints", panel.as_ref().map_or(Value::Null, snap_panel));
        self.surface.set_picker(panel);
        claim.epoch = self.surface.epoch().current();
        true
    }

    fn close_claim(&mut self, claim: &mut SurfaceClaim) -> bool {
        if !self.owns(*claim) {
            return false;
        }
        self.push("paints", Value::Null);
        self.surface.set_picker(None);
        // Closing hands the surface back for good.
        claim.epoch = u64::MAX;
        true
    }

    fn clear_context(&mut self, claim: &mut SurfaceClaim) -> bool {
        if !self.owns(*claim) {
            return false;
        }
        self.surface.supersede();
        claim.epoch = self.surface.epoch().current();
        true
    }

    fn close_usage_panel(&mut self) {}

    fn is_panel_epoch_current(&self, token: u64) -> bool {
        self.surface.epoch().is_current(token)
    }

    fn picker_kind(&self) -> Option<String> {
        self.surface.live_picker().map(|panel| panel.kind().to_owned()).filter(|kind| !kind.is_empty())
    }

    fn project_request(&self) -> Option<u64> {
        self.surface.live_picker().and_then(|panel| panel.request_id)
    }

    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>) {
        let (name, slot) = match surface {
            PromptSurface::Provider => ("provider", &mut self.provider),
            PromptSurface::Settings => ("settings", &mut self.settings),
        };
        *slot = next;
        let entry = json!([name, snap_prompt(slot)]);
        self.push("prompts", entry);
    }

    fn provider_prompt(&self) -> Option<TextPrompt> {
        self.provider.clone()
    }

    fn open(&mut self, opener: Opener, _options: Value) -> Result<(), String> {
        self.push("returns", json!(opener.as_str()));
        Ok(())
    }

    fn copy_to_clipboard(&mut self, text: &str) -> Result<(), String> {
        if let Some(error) = &self.copy_fails {
            return Err(error.clone());
        }
        self.push("clipboard", json!(text));
        Ok(())
    }

    fn pick_folder(&mut self, options: &FolderPickOptions) -> FolderPick {
        self.push("calls", json!(["pickFolder", {"title": options.title, "initialPath": options.initial_path}]));
        let answer = self.pick.clone();
        if answer.get("$throw").is_some() {
            // A dialog that fails is a dialog that is not there.
            return FolderPick { available: false, path: None, reason: None };
        }
        FolderPick {
            available: answer.get("available") != Some(&Value::Bool(false)),
            path: answer.get("path").and_then(Value::as_str).map(str::to_owned),
            reason: answer.get("reason").and_then(Value::as_str).map(str::to_owned),
        }
    }

    fn cwd(&self) -> String {
        self.cwd.clone()
    }

    fn disabled_skills(&self) -> SkillSet {
        self.disabled.clone()
    }

    fn hold_disabled_skills(&mut self, set: SkillSet) {
        self.disabled = set;
    }

    fn transcript_items(&self) -> Vec<Value> {
        self.items.clone()
    }

    fn show_prompt_hint(&mut self, text: &str, tone: Tone) {
        self.push("hints", json!(["hint", text, tone.as_str()]));
    }

    fn clear_prompt_hint(&mut self) {
        self.push("hints", json!(["clear"]));
    }

    fn sync_prompt_layout_rows(&mut self, text: &str) {
        self.push("hints", json!(["sync", text]));
    }

    fn set_prompt_draft_override(&mut self, _id: u64, value: &str) {
        self.push("hints", json!(["draft", value]));
    }

    fn install_pasted_images(&mut self, images: &Value) {
        self.push("hints", json!(["images", images]));
    }

    fn install_pasted_texts(&mut self, texts: &Value) {
        self.push("hints", json!(["texts", texts]));
    }
}



fn fake(store: Value) -> Fake {
    Fake::new(&json!({"store": store}))
}

fn texts(log: &[Value]) -> Vec<String> {
    log.iter().map(|entry| entry[0].as_str().unwrap_or_default().to_owned()).collect()
}

#[test]
fn status_reads_supply_an_empty_list_for_missing_methods_responses_fields_and_falsy_values() {
    for store in [json!({}), json!({"skillsStatus": null}), json!({"skillsStatus": {}}), json!({"skillsStatus": {"skills": 0}})] {
        let mut host = fake(store);
        let status = read_status(&mut host, "skillsStatus", "skills", "skills status").expect("a status");
        assert_eq!(Value::Object(status), json!({"skills": []}));
    }
}

#[test]
fn status_reads_retain_metadata_and_list_identity() {
    let mut host = fake(json!({"skillsStatus": {"count": 1, "skills": [{"name": "pdf"}]}}));
    let status = read_status(&mut host, "skillsStatus", "skills", "skills status").expect("a status");
    assert_eq!(Value::Object(status), json!({"count": 1, "skills": [{"name": "pdf"}]}));
}

#[test]
fn a_failed_status_read_reports_the_error_and_returns_none_rather_than_an_empty_list() {
    let mut host = fake(json!({"skillsStatus": {"$throw": "offline"}}));
    assert!(read_status(&mut host, "skillsStatus", "skills", "skills status").is_none());
    assert_eq!(host.log["notices"], vec![json!(["skills status failed: offline", "error"])]);
}

#[test]
fn the_scope_note_names_the_projects_a_row_applies_to() {
    assert_eq!(scope_note(&json!({})), "");
    assert_eq!(scope_note(&json!({"activeHere": false, "scope": ["a"]})), "not in this project");
    assert_eq!(scope_note(&json!({"scope": ["a"]})), "1 project");
    assert_eq!(scope_note(&json!({"scope": ["a", "b"], "inheritedScope": ["c"]})), "2 projects");
    assert_eq!(scope_note(&json!({"scope": [], "inheritedScope": ["c"]})), "1 project");
}

#[test]
fn an_mcp_toggle_that_settles_after_esc_paints_nothing() {
    let mut host = fake(json!({
        "mcpStatus": {"servers": [{"name": "graph", "enabled": true}]},
        "setMcpServerEnabled": {},
    }));
    let mut ext = Extensions::new();
    ext.open(&mut host, Opener::McpServers, &json!({}));
    let panel = host.live().expect("the list");
    let call = ext.begin_toggle(&mut host, &panel.items[0]).expect("a toggle");
    assert_eq!(host.live().expect("optimistic").items[0].description, "disabling\u{2026} \u{b7} unknown");
    // Esc lands while the store call is in flight.
    let on_screen = host.live().expect("the list");
    ext.cancel(&mut host, &on_screen);
    assert!(host.live().is_none());
    let painted = host.log["paints"].len();
    ext.finish_toggle(&mut host, call, Ok(Value::Null));
    assert_eq!(host.log["paints"].len(), painted);
    assert!(host.live().is_none());
}

#[test]
fn only_the_newest_mcp_toggle_may_refresh_the_row() {
    let mut host = fake(json!({"mcpStatus": {"servers": [{"name": "graph", "enabled": true}]}}));
    let mut ext = Extensions::new();
    ext.open(&mut host, Opener::McpServers, &json!({}));
    let panel = host.live().expect("the list");
    let first = ext.begin_toggle(&mut host, &panel.items[0]).expect("a toggle");
    let second = ext.begin_toggle(&mut host, &panel.items[0]).expect("a toggle");
    let painted = host.log["paints"].len();
    ext.finish_toggle(&mut host, first, Err("late".to_owned()));
    assert_eq!(host.log["paints"].len(), painted, "an older settle does not repaint");
    assert!(host.log["notices"].contains(&json!(["mcp toggle failed: late", "error"])));
    ext.finish_toggle(&mut host, second, Ok(Value::Null));
    assert_eq!(host.log["paints"].len(), painted + 1);
}

#[test]
fn a_list_that_lands_after_esc_is_not_painted() {
    for opener in [Opener::Skills, Opener::ProjectSkills, Opener::Plugins, Opener::McpServers] {
        let mut host = fake(json!({
            "skillsStatus": {"skills": [{"name": "pdf"}]},
            "pluginsStatus": {"plugins": []},
            "mcpStatus": {"servers": []},
        }));
        // Esc lands while the status read is in flight.
        host.esc_on = Some(match opener {
            Opener::Plugins => "pluginsStatus",
            Opener::McpServers => "mcpStatus",
            _ => "skillsStatus",
        });
        Extensions::new().open(&mut host, opener, &json!({}));
        assert!(host.live().is_none(), "{opener:?}");
        assert!(host.log["paints"].is_empty(), "{opener:?}");
        assert!(host.log["prompts"].is_empty(), "{opener:?}");
    }
}

#[test]
fn a_plugin_write_that_acks_after_esc_does_not_reopen_the_list() {
    let mut host = fake(json!({"pluginsStatus": {"plugins": []}, "updatePlugin": {}, "removePlugin": {}}));
    let mut ext = Extensions::new();
    let plugin = json!({"name": "demo", "sourceType": "git", "root": "/p"});
    for (method, value) in [("updatePlugin", "update"), ("removePlugin", "uninstall")] {
        host.esc_on = Some(method);
        ext.open_plugin_detail(&mut host, &plugin);
        let panel = host.live().expect("the plugin panel");
        let at = panel.items.iter().position(|item| item.value == value).expect("the row");
        ext.select(&mut host, &panel, at);
        assert!(host.live().is_none(), "{method}");
    }
    assert_eq!(texts(&host.log["calls"]), ["updatePlugin", "removePlugin"]);
}

#[test]
fn a_claim_that_was_closed_never_paints_again() {
    let mut host = fake(json!({}));
    host.surface.set_picker(Some(ExtPanel::new("Other", "", Vec::new(), Handler::Plugins)));
    let mut own = host.claim_surface(SurfaceKind::Picker);
    assert!(host.close_claim(&mut own));
    assert!(!host.paint(&mut own, None));
}

#[test]
fn the_disabled_set_is_read_once_and_written_back_through_the_store() {
    use mixdog_tui::pickers::extensions::disabled_skills::{load_disabled_skills, set_disabled_skills};
    let mut host = fake(json!({"getDisabledSkills": {"disabled": ["a", "b"]}, "setDisabledSkills": {"$throw": "disk full"}}));
    load_disabled_skills(&mut host);
    assert_eq!(host.disabled.names(), ["a", "b"]);
    let mut next = host.disabled.clone();
    next.remove("a");
    next.insert("c");
    set_disabled_skills(&mut host, next);
    assert_eq!(host.disabled.names(), ["b", "c"]);
    assert_eq!(host.log["calls"].last(), Some(&json!(["setDisabledSkills", ["b", "c"]])));
    assert_eq!(host.log["notices"], vec![json!(["skill disable persist failed: disk full", "error"])]);

    let mut empty = fake(json!({"getDisabledSkills": {"disabled": []}}));
    load_disabled_skills(&mut empty);
    assert!(empty.disabled.is_empty());
    let mut failing = fake(json!({"getDisabledSkills": {"$throw": "down"}}));
    load_disabled_skills(&mut failing);
    assert!(failing.disabled.is_empty());
}

#[test]
fn the_login_prompt_is_recognised_and_a_prompt_that_was_replaced_is_left_alone() {
    use mixdog_tui::pickers::extensions::mcp_login::{FLOW_FIELD, is_login_prompt};
    let mut host = fake(json!({
        "beginMcpOAuthLogin": {"flowId": "f1", "state": "pending", "url": "https://auth.example/a"},
        "getMcpOAuthLoginStatus": {"state": "complete"},
    }));
    let mut ext = Extensions::new();
    ext.login.login(&mut host, "srv");
    let prompt = host.provider.clone().expect("the paste prompt");
    assert!(is_login_prompt(&prompt));
    assert_eq!(prompt.fields[FLOW_FIELD], "f1");
    assert_eq!(ext.login.poll_due_at(), Some(NOW_MS + 1500));
    // Before the poll is due nothing is asked.
    ext.login.poll(&mut host);
    assert_eq!(texts(&host.log["calls"]), ["beginMcpOAuthLogin"]);
    // A prompt the user replaced meanwhile stays.
    host.provider = Some(TextPrompt::new("api-key"));
    host.now = NOW_MS + 1500;
    ext.login.poll(&mut host);
    assert_eq!(host.provider.as_ref().map(|prompt| prompt.kind.as_str()), Some("api-key"));
    assert!(host.log["notices"].contains(&json!(["MCP sign-in complete for srv", "info"])));
    assert!(ext.login.poll_due_at().is_none());
}

#[test]
fn the_message_selector_lists_the_newest_twenty_rewindable_prompts_oldest_first() {
    let items: Vec<Value> = (0..25).map(|id| json!({"kind": "user", "id": id, "text": format!("message {id}")})).collect();
    let rows = selectable_user_items(&items, 20);
    assert_eq!(rows.len(), 20);
    assert_eq!(rows[0].id, "5");
    assert_eq!(rows[19].id, "24");

    let mixed = vec![
        json!({"kind": "user", "id": 1, "text": "a"}),
        json!({"kind": "assistant", "id": 2, "text": "b"}),
        json!({"kind": "user", "id": 3, "text": "archived", "archived": true}),
        json!({"kind": "user", "text": "no id"}),
        json!({"kind": "user", "id": 4, "text": "  "}),
        json!({"kind": "user", "id": 5, "text": "  kept  "}),
    ];
    let rows = selectable_user_items(&mixed, 20);
    assert_eq!(rows.iter().map(|row| (row.id.as_str(), row.text.as_str())).collect::<Vec<_>>(), [("1", "a"), ("5", "kept")]);
    assert!(has_user_messages(&mixed));
    assert!(!has_user_messages(&[json!({"kind": "user", "text": " "})]));
}

#[test]
fn the_message_label_is_the_first_nonblank_line_cut_with_an_ellipsis() {
    assert_eq!(message_selector_label("  \n  hello \nworld", 56), "hello");
    assert_eq!(message_selector_label(&"x".repeat(56), 56), "x".repeat(56));
    assert_eq!(message_selector_label(&"x".repeat(57), 56), format!("{}\u{2026}", "x".repeat(55)));
    assert_eq!(message_selector_label("", 56), "");
}

#[test]
fn memory_edit_preserves_a_legacy_element_and_the_escape_target_is_sticky() {
    let mut host = fake(json!({"memoryControl": "COMMON:\nid=7 preference \u{2014} preference\nid=8 legacy label \u{2014} visible summary"}));
    let mut ext = Extensions::new();
    ext.open(&mut host, Opener::MemoryCore, &json!({"returnTo": "settings"}));
    let root = host.live().expect("the root");
    ext.select(&mut host, &root, 1);
    let list = host.live().expect("the list");
    let legacy = list.items.iter().position(|item| item.value == "core-common-8").expect("the legacy row");
    ext.select(&mut host, &list, legacy);
    let entry = host.live().expect("the entry panel");
    ext.select(&mut host, &entry, 1);
    let prompt = host.settings.clone().expect("the edit prompt");
    assert_eq!(prompt.fields["_singleSentence"], false);
    assert_eq!(prompt.initial_value.as_deref(), Some("visible summary"));
    assert_eq!(prompt.fields["_id"], 8);
    assert_eq!(prompt.fields["_projectId"], Value::Null);

    // Nested reopens inherit the entry context: Esc on the root goes back to Settings.
    ext.open(&mut host, Opener::MemoryCore, &json!({}));
    let root = host.live().expect("the root");
    ext.cancel(&mut host, &root);
    assert_eq!(host.log["returns"], vec![json!("settings")]);
    ext.open(&mut host, Opener::MemoryCore, &json!({"returnTo": null}));
    let root = host.live().expect("the root");
    ext.cancel(&mut host, &root);
    assert!(host.live().is_none());
    assert_eq!(host.log["returns"].len(), 1);
}

#[test]
fn the_first_screen_project_list_waits_for_its_opener() {
    use mixdog_tui::pickers::extensions::project::initial_project_panel;
    let panel = initial_project_panel("C:\\current");
    assert!(panel.initial_pending);
    assert!(panel.items.is_empty());
    assert_eq!(panel.help.as_deref(), Some("Waiting for the project service\u{2026}"));
    assert_eq!(panel.kind(), "project");
}

#[test]
fn the_serves_list_names_the_openers_the_module_opens() {
    for opener in [Opener::Mcp, Opener::McpServers, Opener::Skills, Opener::ProjectSkills, Opener::Plugins, Opener::MemoryCore, Opener::Project, Opener::Resume] {
        assert!(Extensions::serves(opener));
    }
    for opener in [Opener::Model, Opener::Settings, Opener::Usage] {
        assert!(!Extensions::serves(opener));
        let mut host = fake(json!({}));
        assert!(Extensions::new().open(&mut host, opener, &json!({})).is_none());
    }
}

#[test]
fn a_panel_becomes_picker_props_with_the_marker_colours_and_the_entry_footer() {
    let mut host = fake(json!({"memoryControl": "COMMON:\nid=7 preference \u{2014} a full sentence"}));
    let mut ext = Extensions::new();
    ext.open(&mut host, Opener::MemoryCore, &json!({}));
    let root = host.live().expect("the root");
    ext.select(&mut host, &root, 1);
    let list = host.live().expect("the list");
    let props = list.to_props(100);
    assert_eq!(props.label_width, Some(12));
    assert_eq!(props.columns, 100);
    assert!(!props.adjustable);
    assert_eq!(props.items[0].label, "#7");

    let mut servers = fake(json!({"mcpStatus": {"servers": [{"name": "graph"}]}}));
    ext.open(&mut servers, Opener::McpServers, &json!({}));
    let props = servers.live().expect("the list").to_props(80);
    assert!(props.adjustable);
    assert_eq!(props.items[0].marker, "\u{25cf}");
    assert!(props.items[0].marker_color.is_some());
}

#[test]
fn session_formatters_follow_app_format() {
    assert_eq!(format_session_message_count(None), "0 msgs");
    assert_eq!(format_session_message_count(Some(&json!(1))), "1 msg");
    assert_eq!(format_session_message_count(Some(&json!(12.6))), "13 msgs");
    assert_eq!(format_session_message_count(Some(&json!("3"))), "3 msgs");
    assert_eq!(format_session_message_count(Some(&json!(-4))), "0 msgs");
    assert_eq!(format_session_updated_at(None, 1.0e12), "--:--");
    assert_eq!(format_session_updated_at(Some(&json!(0)), 1.0e12), "--:--");
    assert_eq!(format_session_updated_at(Some(&json!("soon")), 1.0e12), "--:--");
    assert_eq!(format_session_updated_at(Some(&json!(-5)), 1.0e12), "--:--");
    let now = 1_794_735_000_000.0;
    let shown = mixdog_js::time::with_local_zone(mixdog_js::time::Tz::UTC, || {
        (
            format_session_updated_at(Some(&json!(1_794_735_000_000_i64)), now),
            format_session_updated_at(Some(&json!(1_700_000_000_000_i64)), now),
        )
    });
    assert_eq!(shown.0, "11-15 09:30");
    assert_eq!(shown.1, "2023-11-14 22:13");
}

