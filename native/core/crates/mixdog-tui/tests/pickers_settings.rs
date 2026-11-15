//! The settings pickers (Settings, Update, Auto-clear, Profile, Developer) against a recording fake host: what each row shows,
//! which writes the arrows and Enter perform, where Enter navigates and Esc returns (the ports of `settings-picker.test.mjs`
//! and `maintenance-pickers.test.mjs`), and the same pickers against what the Node code does (tests/goldens/pickers-settings.json,
//! recorded by tests/recorders/record-pickers-settings.mjs).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::rc::Rc;

use mixdog_term::paste::{PastedImage, PromptContent};
use mixdog_tui::app::AppCtx;
use mixdog_tui::pickers::PickerKind;
use mixdog_tui::pickers::settings::host::PickerHost;
use mixdog_tui::pickers::settings::panel::Panel;
use mixdog_tui::pickers::settings::picker::run_live_refresh;
use mixdog_tui::pickers::settings::{self, Opening, PickerController, SettingsState};
use mixdog_tui::slash::host::{Opener, PromptSurface, SlashHost, SlashState, SubmitOptions, TextPrompt, Tone};
use mixdog_tui::surface::owner::PanelSurface;
use mixdog_tui::surface::{SurfaceClaim, SurfaceKind};
use mixdog_tui_style::time_format::{DurationOptions, format_duration};
use mixdog_tui_widgets::picker::PickerItem;
use mixdog_tui_widgets::picker::layout::FooterInput;
use serde_json::{Map, Value, json};

type Handler = Box<dyn FnMut(&Value) -> Result<Value, String>>;
type Hook = Box<dyn FnMut(&mut Fake, &str)>;

/// Which pickers the code under test owns: the others are logged where they open, as the Node factory's injected openers were.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Settings is real; Auto-clear, Profile, Update and Developer are logged.
    Settings,
    /// Those four are real; the return to Settings is logged.
    Maintenance,
}

struct Fake {
    kind: Kind,
    handlers: HashMap<String, Handler>,
    hook: Option<Hook>,
    /// The events of the scenario in the shape `record-pickers-settings.mjs` logs them.
    log: Vec<Value>,
    surface: PanelSurface<Panel, (), ()>,
    controller: Option<Box<dyn PickerController>>,
    settings: SettingsState,
    prompt: Option<TextPrompt>,
    workflow: Value,
}

impl Fake {
    fn new(kind: Kind) -> Self {
        Self {
            kind,
            handlers: HashMap::new(),
            hook: None,
            log: Vec::new(),
            surface: PanelSurface::new(),
            controller: None,
            settings: SettingsState::default(),
            prompt: None,
            workflow: json!({"id": "default"}),
        }
    }

    fn set_hook(&mut self, hook: impl FnMut(&mut Fake, &str) + 'static) {
        self.hook = Some(Box::new(hook));
    }

    /// Scripts the store's answer to `action`.
    fn on(&mut self, action: &str, handler: impl FnMut(&Value) -> Result<Value, String> + 'static) {
        self.handlers.insert(action.to_owned(), Box::new(handler));
    }

    /// Scripts `action` to answer `value` every time.
    fn answer(&mut self, action: &str, value: Value) {
        self.on(action, move |_| Ok(value.clone()));
    }

    fn fail(&mut self, action: &str, text: &str) {
        let text = text.to_owned();
        self.on(action, move |_| Err(text.clone()));
    }

    /// The answers of a scenario's store entry: a value, `{ "$throw": text }`, or `{ "$seq": [..] }`.
    fn script(&mut self, action: &str, spec: &Value) {
        fn reply(spec: &Value) -> Result<Value, String> {
            match spec.get("$throw") {
                Some(text) => Err(text.as_str().unwrap_or_default().to_owned()),
                None => Ok(spec.clone()),
            }
        }
        match spec.get("$seq").and_then(Value::as_array) {
            Some(answers) => {
                let answers = answers.clone();
                let at = Cell::new(0usize);
                self.on(action, move |_| {
                    let next = answers[at.get().min(answers.len() - 1)].clone();
                    at.set(at.get() + 1);
                    reply(&next)
                });
            }
            None => {
                let spec = spec.clone();
                self.on(action, move |_| reply(&spec));
            }
        }
    }

    fn open_picker_by(&mut self, opener: Opener, options: Value) {
        self.open(opener, options).expect("the fake opener never fails");
    }

    fn press(&mut self, key: impl FnOnce(&mut dyn PickerController, &mut Fake)) {
        let mut controller = self.controller.take().expect("a picker is open");
        key(controller.as_mut(), self);
        if self.controller.is_none() {
            self.controller = Some(controller);
        }
    }

    fn left(&mut self, value: &str) {
        self.press(|picker, host| picker.left(host, value));
    }

    fn right(&mut self, value: &str) {
        self.press(|picker, host| picker.right(host, value));
    }

    fn select(&mut self, value: &str) {
        self.press(|picker, host| picker.select(host, value));
    }

    fn confirm(&mut self, value: &str) {
        self.press(|picker, host| picker.confirm(host, value));
    }

    fn cancel(&mut self) {
        self.press(|picker, host| picker.cancel(host));
    }

    /// The user presses Esc on the panel on screen while a store call is in flight.
    fn esc(&mut self) {
        self.surface.set_picker(None);
    }

    fn panel(&self) -> Option<&Panel> {
        self.surface.picker()
    }

    fn title(&self) -> Option<&str> {
        self.panel().map(|panel| panel.title.as_str())
    }

    fn row(&self, value: &str) -> PickerItem {
        let panel = self.panel().expect("a panel is on screen");
        panel.items.iter().find(|item| item.value == value).unwrap_or_else(|| panic!("no row {value}")).clone()
    }

    fn values(&self) -> Vec<String> {
        self.panel().expect("a panel is on screen").items.iter().map(|item| item.value.clone()).collect()
    }

    fn notices(&self) -> Vec<(String, String)> {
        self.log
            .iter()
            .filter(|event| event[0] == "notice")
            .map(|event| (event[1].as_str().unwrap_or_default().to_owned(), event[2].as_str().unwrap_or_default().to_owned()))
            .collect()
    }

    fn messages(&self) -> Vec<String> {
        self.notices().into_iter().map(|(message, _)| message).collect()
    }

    fn last_notice(&self) -> (String, String) {
        self.notices().pop().expect("a notice was pushed")
    }

    fn calls(&self, action: &str) -> Vec<Value> {
        self.log.iter().filter(|event| event[0] == "call" && event[1] == action).map(|event| event[2].clone()).collect()
    }

    fn opened(&self) -> Vec<(String, Value)> {
        self.log
            .iter()
            .filter(|event| event[0] == "open")
            .map(|event| (event[1].as_str().unwrap_or_default().to_owned(), event[2].clone()))
            .collect()
    }

    fn cleared(&self) -> Vec<String> {
        self.log
            .iter()
            .filter(|event| event[0] == "clearModelCaches")
            .map(|event| event[1].as_str().unwrap_or_default().to_owned())
            .collect()
    }
}

/// The prompt as `record-pickers-settings.mjs` logs it: the Node prompt's function members are `true` (an absent
/// `returnTo` of an Auto-clear prompt is `null`).
fn prompt_json(prompt: &TextPrompt) -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), json!(prompt.kind));
    map.insert("label".into(), json!(prompt.label));
    map.insert("hint".into(), json!(prompt.hint));
    if let Some(initial) = &prompt.initial_value {
        map.insert("initialValue".into(), json!(initial));
    }
    for (key, value) in &prompt.fields {
        if key == "_returnTo" {
            map.insert("returnTo".into(), json!(true));
        } else {
            map.insert(key.clone(), value.clone());
        }
    }
    if prompt.kind == "autoclear-provider" && !map.contains_key("returnTo") {
        map.insert("returnTo".into(), Value::Null);
    }
    Value::Object(map)
}

impl AppCtx for Fake {
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String> {
        if !self.handlers.contains_key(action) {
            // The store has no such method: `store.method?.()` answered `undefined`.
            return Ok(Value::Null);
        }
        self.log.push(json!(["call", action, args]));
        if let Some(mut hook) = self.hook.take() {
            hook(self, action);
            if self.hook.is_none() {
                self.hook = Some(hook);
            }
        }
        let handler = self.handlers.get_mut(action).expect("checked above");
        handler(&args)
    }

    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim {
        SurfaceClaim { kind, epoch: self.surface.epoch().current() }
    }

    fn open_picker(&mut self, _kind: PickerKind) -> SurfaceClaim {
        self.claim_surface(SurfaceKind::Picker)
    }
}

impl SlashHost for Fake {
    fn state(&self) -> SlashState {
        SlashState {
            provider: "openai".into(),
            model: "gpt-5".into(),
            workflow: self.workflow.clone(),
            ..SlashState::default()
        }
    }

    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.log.push(json!(["notice", text, tone.as_str()]));
    }

    fn push_notice_ttl(&mut self, text: &str, tone: Tone, _ttl_ms: u64) {
        self.push_notice(text, tone);
    }

    fn now_ms(&self) -> u64 {
        0
    }

    fn has_store_method(&self, name: &str) -> bool {
        self.handlers.contains_key(name)
    }

    fn clear_context_panel(&mut self) {}

    fn close_usage_panel(&mut self) {}

    fn paint_loading_frame(&mut self, _command: &str, _title: &str) -> Option<SurfaceClaim> {
        None
    }

    fn owns_surface(&self, claim: SurfaceClaim) -> bool {
        self.surface.epoch().is_current(claim.epoch)
    }

    fn close_surface(&mut self, claim: SurfaceClaim) {
        if self.owns_surface(claim) {
            self.surface.set_picker(None);
        }
    }

    fn paint_stop_confirm(&mut self, _claim: SurfaceClaim, _title: &str, _commands: &[String]) {}

    fn open(&mut self, opener: Opener, options: Value) -> Result<(), String> {
        let owned = match self.kind {
            Kind::Settings => opener == Opener::Settings,
            Kind::Maintenance => {
                matches!(opener, Opener::AutoClear | Opener::Profile | Opener::Update | Opener::Developer)
            }
        };
        if owned {
            if let Opening::Open(controller) = settings::open(self, opener, &options) {
                self.controller = Some(controller);
            }
        } else if opener == Opener::Settings {
            self.log.push(json!(["returnTo"]));
        } else {
            let name = if opener.as_str() == "outputstyle" { "output-style" } else { opener.as_str() };
            self.log.push(json!(["open", name, options]));
        }
        Ok(())
    }

    fn open_with_return(&mut self, opener: Opener, options: Value, _target: &TextPrompt) -> Result<(), String> {
        self.open(opener, options)
    }

    fn register_project(&mut self, _path: &str) -> Result<(), String> {
        Ok(())
    }

    fn enter_project(&mut self, _target: &str) {}

    fn login_mcp_server(&mut self, _name: &str) {}

    fn logout_mcp_server(&mut self, _name: &str) {}

    fn btw_ask(&mut self, _question: &str) {}

    fn run_doctor(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn request_exit(&mut self) {}

    fn force_render_repaint(&mut self) {}

    fn supersede_panel_epoch(&mut self) -> u64 {
        self.surface.supersede()
    }

    fn is_panel_epoch_current(&self, token: u64) -> bool {
        self.surface.epoch().is_current(token)
    }

    fn write_token(&self, _surface: PromptSurface) -> u64 {
        0
    }

    fn set_write_token(&mut self, _surface: PromptSurface, _token: u64) {}

    fn provider_prompt(&self) -> Option<TextPrompt> {
        None
    }

    fn settings_prompt(&self) -> Option<TextPrompt> {
        self.prompt.clone()
    }

    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>) {
        if surface != PromptSurface::Settings {
            return;
        }
        if let Some(prompt) = &next {
            self.log.push(json!(["prompt", prompt_json(prompt)]));
        }
        self.prompt = next;
    }

    fn mark_prompt_submitting(&mut self, _surface: PromptSurface, _target: &TextPrompt) {}

    fn oauth_submitting(&self) -> bool {
        false
    }

    fn set_oauth_submitting(&mut self, _value: bool) {}

    fn oauth_complete_code(&mut self, _target: &TextPrompt, _code: &str) -> Result<(), String> {
        Ok(())
    }

    fn oauth_success_return(&mut self, _target: &TextPrompt) -> bool {
        false
    }

    fn oauth_failure_return(&mut self, _target: &TextPrompt, _error: &str) {}

    fn provider_after_save(&mut self, _target: &TextPrompt) -> bool {
        false
    }

    fn clear_model_caches(&mut self, scope: &str) {
        self.log.push(json!(["clearModelCaches", scope]));
    }

    fn pasted_images(&self) -> BTreeMap<u64, PastedImage> {
        BTreeMap::new()
    }

    fn pasted_texts(&self) -> BTreeMap<u64, String> {
        BTreeMap::new()
    }

    fn clear_pasted_images(&mut self, _ids: Option<&BTreeSet<u64>>) {}

    fn clear_pasted_texts(&mut self, _ids: Option<&BTreeSet<u64>>) {}

    fn arm_transcript_follow(&mut self) {}

    fn store_submit(&mut self, _method: &str, _content: &PromptContent, _options: Option<&SubmitOptions>) -> Result<Value, String> {
        Ok(Value::Null)
    }
}

impl PickerHost for Fake {
    fn claim_picker(&mut self) -> SurfaceClaim {
        self.claim_surface(SurfaceKind::Picker)
    }

    fn paint_panel(&mut self, claim: SurfaceClaim, panel: &Panel) -> Option<SurfaceClaim> {
        if !self.owns_surface(claim) {
            return None;
        }
        self.surface.set_picker(Some(panel.clone()));
        Some(self.surface_claim())
    }

    fn clear_context(&mut self, claim: SurfaceClaim) -> Option<SurfaceClaim> {
        if !self.owns_surface(claim) {
            return None;
        }
        // Clearing the context panel hands the surface back, as closing a picker does.
        self.surface.supersede();
        Some(self.surface_claim())
    }

    fn settings_state(&mut self) -> &mut SettingsState {
        &mut self.settings
    }

    fn route_model_label(&self, route: &Value) -> String {
        match route.get("model") {
            Some(model) if !model.is_null() => format!(
                "{}@{}",
                model.as_str().unwrap_or_default(),
                route.get("provider").and_then(Value::as_str).unwrap_or_default()
            ),
            _ => "(unset)".to_owned(),
        }
    }
}

impl Fake {
    fn surface_claim(&self) -> SurfaceClaim {
        SurfaceClaim { kind: SurfaceKind::Picker, epoch: self.surface.epoch().current() }
    }
}

fn fd(ms: f64) -> String {
    format_duration(ms, DurationOptions::default())
}

fn snapshot() -> Value {
    json!({
        "autoClear": {"enabled": true, "idleMs": 3_600_000, "provider": "openai"},
        "compaction": {"auto": true},
        "toolModules": {"webSearch": {"enabled": true}, "memory": {"enabled": false}},
        "systemShell": {"source": "config", "command": "pwsh", "effective": "pwsh -NoLogo"},
        "outputStyle": {"current": {"id": "simple", "label": "Simple"}},
        "webSearchRoute": {"provider": "openai", "model": "gpt-web"},
        "profile": {"title": "Jay", "languageEntry": {"label": "Korean"}, "experienceLevelEntry": {"label": "Vibe coder"}},
        "mcp": {"connectedCount": 1, "configuredCount": 2, "failedCount": 1},
        "plugins": {"count": 3},
        "skills": {"count": 12},
        "updateSettings": {"currentVersion": "1.0.0", "latestVersion": "1.1.0", "updateAvailable": true},
    })
}

fn themes() -> Value {
    json!([{"id": "dawn", "label": "Dawn"}, {"id": "dusk", "label": "Dusk"}])
}

/// A Settings host whose store answers the snapshot and the themes.
fn settings_host() -> Fake {
    let mut host = Fake::new(Kind::Settings);
    host.answer("getSettingsSnapshot", snapshot());
    host.answer("getTheme", json!("dusk"));
    host.answer("listThemes", themes());
    host
}

fn open_settings(host: &mut Fake) {
    host.open_picker_by(Opener::Settings, json!({}));
}

// ------------------------------------------------------------- Settings

#[test]
fn an_open_settings_panel_re_reads_on_a_settings_change_from_elsewhere_and_a_closed_one_stays_closed() {
    let current = Rc::new(RefCell::new(snapshot()));
    let mut host = settings_host();
    let source = Rc::clone(&current);
    host.on("getSettingsSnapshot", move |_| Ok(source.borrow().clone()));
    open_settings(&mut host);
    assert_eq!(host.row("profile").meta, "Jay \u{b7} Vibe coder \u{b7} Korean");
    // Another writer (desktop, phone, setup tool, hand edit) changed the profile.
    current.borrow_mut()["profile"]["title"] = json!("Kim");
    run_live_refresh(&mut host);
    assert_eq!(host.row("profile").meta, "Kim \u{b7} Vibe coder \u{b7} Korean");
    host.cancel();
    assert_eq!(host.title(), None);
    let reads = host.calls("getSettingsSnapshot").len();
    run_live_refresh(&mut host);
    assert_eq!(host.title(), None);
    assert_eq!(host.calls("getSettingsSnapshot").len(), reads, "a closed panel is not read again");
}

#[test]
fn a_settings_change_from_elsewhere_refreshes_the_mcp_plugin_and_skill_rows_not_only_the_light_ones() {
    let heavy = Rc::new(RefCell::new(json!({
        "mcp": {"connectedCount": 1, "configuredCount": 2, "failedCount": 1},
        "plugins": {"count": 3},
        "skills": {"count": 12},
    })));
    let mut light = snapshot();
    for key in ["mcp", "plugins", "skills"] {
        light.as_object_mut().expect("an object").remove(key);
    }
    let mut host = settings_host();
    let source = Rc::clone(&heavy);
    host.on("getSettingsSnapshot", move |args| {
        let mut answer = light.clone();
        if args[0]["heavy"] != json!(false) {
            for (key, value) in source.borrow().as_object().expect("an object") {
                answer[key] = value.clone();
            }
        }
        Ok(answer)
    });
    open_settings(&mut host);
    assert_eq!(host.row("mcp").description, "1/2 connected \u{b7} 1 failed");
    *heavy.borrow_mut() = json!({
        "mcp": {"connectedCount": 0, "configuredCount": 4, "failedCount": 0},
        "plugins": {"count": 5},
        "skills": {"count": 7},
    });
    run_live_refresh(&mut host);
    assert_eq!(host.row("mcp").description, "0/4 connected");
    assert_eq!(host.row("plugins").description, "5 detected");
    assert_eq!(host.row("skills").description, "7 available");
}

#[test]
fn overlapping_external_changes_share_one_heavy_read_and_a_late_older_response_never_rolls_the_cache_back() {
    let mut light = snapshot();
    for key in ["mcp", "plugins", "skills"] {
        light.as_object_mut().expect("an object").remove(key);
    }
    // The heavy reads in the order they are answered: the first open, the newer full open (it answers while the older read is
    // still outstanding), the older read, and the one follow-up the overlapping changes are owed.
    let counts: Rc<RefCell<VecDeque<i64>>> = Rc::new(RefCell::new(VecDeque::from([2, 4, 3, 4])));
    let heavy_reads = Rc::new(Cell::new(0));
    let mut host = settings_host();
    let (queue, reads) = (Rc::clone(&counts), Rc::clone(&heavy_reads));
    host.on("getSettingsSnapshot", move |args| {
        let mut answer = light.clone();
        if args[0]["heavy"] != json!(false) {
            reads.set(reads.get() + 1);
            let n = queue.borrow_mut().pop_front().expect("a scripted heavy read");
            answer["mcp"] = json!({"connectedCount": 0, "configuredCount": n, "failedCount": 0});
            answer["plugins"] = json!({"count": n});
            answer["skills"] = json!({"count": n});
        }
        Ok(answer)
    });
    host.answer("setAutoClear", json!({"enabled": false}));
    open_settings(&mut host);
    assert_eq!(host.row("mcp").description, "0/2 connected");

    // While the next heavy read is outstanding, three external changes arrive and a newer full open answers first.
    let fired = Cell::new(false);
    host.set_hook(move |host, action| {
        if action != "getSettingsSnapshot" || fired.replace(true) {
            return;
        }
        run_live_refresh(host);
        run_live_refresh(host);
        host.open_picker_by(Opener::Settings, json!({}));
    });
    run_live_refresh(&mut host);
    assert_eq!(host.row("mcp").description, "0/4 connected", "the older response did not repaint");
    // The reads: the first open, the newer open, the older read and exactly one follow-up for the overlapping changes.
    assert_eq!(heavy_reads.get(), 4);

    // The next light refresh reads the cache the older response must not have overwritten.
    host.left("autoclear");
    assert_eq!(host.row("mcp").description, "0/4 connected");
    assert_eq!(host.row("plugins").description, "4 detected");
    assert_eq!(host.row("skills").description, "4 available");
}

#[test]
fn rows_render_the_snapshot_values_in_the_parity_order() {
    let mut host = settings_host();
    open_settings(&mut host);
    let panel = host.panel().expect("a panel");
    assert_eq!(panel.title, "Settings");
    let hour = fd(3_600_000.0);
    let rows: Vec<(String, String)> = panel.items.iter().map(|item| (item.value.clone(), item.meta.clone())).collect();
    let want = [
        ("model", "GPT-5".to_owned()),
        ("websearch", "gpt-web@openai".to_owned()),
        ("workflow", "default".to_owned()),
        ("output-style", "Simple".to_owned()),
        ("profile", "Jay \u{b7} Vibe coder \u{b7} Korean".to_owned()),
        ("theme", "Dusk".to_owned()),
        ("web-search-enabled", "On".to_owned()),
        ("memory-enabled", "Off".to_owned()),
        ("autocompact", "On".to_owned()),
        ("autoclear", format!("On ({hour})")),
        ("memory", String::new()),
        ("providers", String::new()),
        ("mcp", String::new()),
        ("plugins", String::new()),
        ("skills", String::new()),
        ("voice", "Off".to_owned()),
        ("system-shell", "pwsh".to_owned()),
        ("developer", String::new()),
        ("update", "1.0.0 \u{2192} 1.1.0".to_owned()),
    ];
    assert_eq!(rows, want.iter().map(|(value, meta)| ((*value).to_owned(), meta.clone())).collect::<Vec<_>>());
    assert_eq!(host.row("mcp").description, "1/2 connected \u{b7} 1 failed");
    assert_eq!(host.row("plugins").description, "3 detected");
    assert_eq!(host.row("skills").description, "12 available");
    assert_eq!(host.row("autoclear").description, format!("Clear idle sessions after {hour} (openai default). Enter for options."));
    assert_eq!(host.row("system-shell").description, "Effective command: pwsh -NoLogo");
    let panel = host.panel().expect("a panel");
    assert_eq!(panel.help.as_deref(), Some("\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Change \u{b7} Enter Open/Toggle \u{b7} Esc Close"));
    assert_eq!((panel.label_width, panel.meta_width), (Some(18), Some(18)));
}

#[test]
fn the_voice_row_shows_the_core_state_and_a_failed_read_is_off() {
    let mut host = settings_host();
    host.answer("getVoiceStatus", json!({"enabled": true, "busy": false}));
    open_settings(&mut host);
    assert_eq!(host.row("voice").meta, "On");
    host.fail("getVoiceStatus", "away");
    open_settings(&mut host);
    assert_eq!(host.row("voice").meta, "Off");
}

#[test]
fn arrows_toggle_write_through_the_store_and_refresh_the_panel() {
    let mut host = settings_host();
    host.answer("setAutoClear", json!({"enabled": false}));
    host.answer("setCompactionSettings", json!({"auto": false}));
    host.answer("setWebSearchEnabled", json!(true));
    host.answer("setMemoryToolsEnabled", json!(true));
    open_settings(&mut host);
    host.left("autoclear");
    host.right("autocompact");
    host.select("web-search-enabled");
    host.left("memory-enabled");
    assert_eq!(host.calls("setAutoClear"), vec![json!([{"enabled": false}])]);
    assert_eq!(host.calls("setCompactionSettings"), vec![json!([{"auto": false}])]);
    assert_eq!(host.calls("setWebSearchEnabled"), vec![json!([false])]);
    assert_eq!(host.calls("setMemoryToolsEnabled"), vec![json!([true])]);
    assert_eq!(
        host.messages(),
        ["Auto-clear off", "Compaction auto off", "Web search off \u{b7} new sessions", "Memory on \u{b7} new sessions"]
    );
    assert_eq!(host.title(), Some("Settings"), "the post-write refresh repainted Settings");
}

#[test]
fn a_write_that_acks_after_esc_does_not_re_open_the_panel() {
    let mut host = settings_host();
    host.on("setAutoClear", |_| Ok(json!({"enabled": false})));
    open_settings(&mut host);
    // The user closes Settings while the write is in flight.
    host.set_hook(|host, action| {
        if action == "setAutoClear" {
            host.esc();
        }
    });
    host.left("autoclear");
    assert_eq!(host.title(), None);
    assert_eq!(host.messages(), ["Auto-clear off"]);
    assert_eq!(host.calls("getSettingsSnapshot").len(), 1, "no refresh was made");
}

#[test]
fn a_build_that_esc_superseded_never_paints() {
    let mut host = settings_host();
    host.set_hook(|host, action| {
        if action == "getSettingsSnapshot" {
            // Esc on the handoff panel while the snapshot is in flight.
            host.esc();
        }
    });
    open_settings(&mut host);
    assert_eq!(host.title(), None);
}

#[test]
fn writes_that_answer_nothing_or_fail_are_notices() {
    let mut host = settings_host();
    host.answer("setAutoClear", Value::Null);
    host.answer("setCompactionSettings", json!(false));
    host.fail("setWebSearchEnabled", "denied");
    open_settings(&mut host);
    host.left("autoclear");
    host.right("autocompact");
    host.select("web-search-enabled");
    host.left("memory-enabled");
    assert_eq!(
        host.notices(),
        [
            ("autoclear unavailable".to_owned(), "warn".to_owned()),
            ("compaction setting is busy".to_owned(), "warn".to_owned()),
            ("Web search setting failed: denied".to_owned(), "error".to_owned()),
            ("Memory setting is busy".to_owned(), "warn".to_owned()),
        ]
    );
}

#[test]
fn arrows_on_output_style_workflow_and_theme_cycle_with_wrap_around() {
    let mut host = settings_host();
    host.answer("listOutputStyles", json!({"current": {"id": "simple"}, "styles": [{"id": "default"}, {"id": "simple"}]}));
    host.answer("setOutputStyle", json!({"id": "default"}));
    host.answer("listWorkflows", json!([{"id": "default", "active": true}, {"id": "review"}]));
    host.answer("setWorkflow", json!({"id": "review"}));
    host.answer("setTheme", json!({"id": "dawn", "label": "Dawn"}));
    open_settings(&mut host);
    host.right("output-style");
    host.left("workflow");
    host.right("theme");
    assert_eq!(host.calls("setOutputStyle"), vec![json!(["default"])]);
    assert_eq!(host.calls("setWorkflow"), vec![json!(["review"])]);
    assert_eq!(host.calls("setTheme"), vec![json!(["dawn", {"persist": true}])]);
    assert_eq!(host.messages(), ["Output style set to Default.", "Workflow saved \u{b7} new sessions", "Theme set to Dawn"]);
}

#[test]
fn a_cycler_with_nothing_to_cycle_or_a_failing_write_says_so() {
    let mut host = settings_host();
    host.answer("listThemes", json!([]));
    host.answer("listOutputStyles", json!({"styles": []}));
    host.answer("listWorkflows", json!([]));
    open_settings(&mut host);
    host.right("output-style");
    host.right("workflow");
    host.right("theme");
    assert_eq!(host.messages(), ["no output styles available", "no workflows available", "no themes available"]);

    let mut host = settings_host();
    host.fail("listOutputStyles", "away");
    host.answer("listWorkflows", json!([{"id": "default"}]));
    host.fail("setWorkflow", "offline");
    host.answer("listThemes", json!([{"id": "dawn"}]));
    host.fail("setTheme", "read only");
    open_settings(&mut host);
    host.right("output-style");
    host.right("workflow");
    host.right("theme");
    assert_eq!(
        host.messages(),
        [
            "could not list output styles: away",
            "Couldn\u{2019}t switch workflow: offline",
            "Couldn\u{2019}t set theme: read only"
        ]
    );
}

#[test]
fn enter_routes_to_the_owning_picker_with_a_settings_return_or_opens_the_shell_prompt() {
    let mut host = settings_host();
    open_settings(&mut host);
    let rows = [
        "model",
        "websearch",
        "workflow",
        "output-style",
        "profile",
        "theme",
        "autoclear",
        "providers",
        "mcp",
        "plugins",
        "skills",
        "memory",
        "developer",
        "update",
    ];
    for value in rows {
        host.select(value);
    }
    let opened = host.opened();
    assert_eq!(opened.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), rows);
    let options = |name: &str| opened.iter().find(|(opened, _)| opened == name).map(|(_, options)| options.clone()).expect("opened");
    assert_eq!(options("developer")["returnTo"], json!("settings"));
    let model = options("model");
    assert_eq!(model["returnLabel"], json!("Settings"));
    assert_eq!(model["returnOnNestedCancel"], json!(true));
    assert_eq!(model["handoffPanel"]["description"], json!("Switching model..."));
    assert_eq!(model["returnTo"], json!("settings"));
    assert_eq!(options("providers")["continueLabel"], json!("Back to settings"));
    assert_eq!(options("mcp"), json!({}));

    host.select("system-shell");
    assert_eq!(host.title(), None);
    let prompt = host.prompt.clone().expect("the shell prompt");
    assert_eq!(prompt.kind, "system-shell");
    assert_eq!(prompt.initial_value.as_deref(), Some("pwsh"));
}

#[test]
fn a_failed_snapshot_surfaces_as_a_notice_never_a_failure() {
    let mut host = settings_host();
    host.fail("getSettingsSnapshot", "daemon away");
    open_settings(&mut host);
    assert_eq!(host.notices(), [("settings unavailable: daemon away".to_owned(), "error".to_owned())]);
}

#[test]
fn the_voice_toggle_goes_through_the_core_and_reports_what_happened() {
    let mut host = settings_host();
    host.answer("getVoiceStatus", json!({"enabled": false, "busy": false}));
    host.answer("toggleVoice", json!({"enabled": true, "result": {"ok": true, "enabled": true}}));
    open_settings(&mut host);
    host.select("voice");
    assert_eq!(host.calls("toggleVoice"), vec![json!([true])]);
    assert_eq!(host.last_notice(), ("Voice ON \u{2014} channel voice messages will be transcribed".to_owned(), "info".to_owned()));

    host.answer("getVoiceStatus", json!({"enabled": true, "busy": false}));
    host.answer("toggleVoice", json!({"result": {"ok": true, "enabled": false}}));
    host.right("voice");
    assert_eq!(host.calls("toggleVoice").last(), Some(&json!([false])));
    assert_eq!(host.last_notice(), ("Voice OFF".to_owned(), "info".to_owned()));

    host.answer("toggleVoice", json!({"result": {"ok": false, "error": "disk full"}}));
    host.left("voice");
    assert_eq!(host.last_notice(), ("Voice OFF failed: disk full".to_owned(), "error".to_owned()));

    host.answer("getVoiceStatus", json!({"enabled": false, "busy": false}));
    host.answer("toggleVoice", json!({"result": {"ok": false, "error": "Voice setup failed: no network"}}));
    host.left("voice");
    assert_eq!(host.last_notice(), ("Voice setup failed: no network".to_owned(), "error".to_owned()));

    host.answer("toggleVoice", json!({"result": {"ok": false}}));
    host.left("voice");
    assert_eq!(host.last_notice(), ("Voice install is already running".to_owned(), "warn".to_owned()));

    let before = host.calls("toggleVoice").len();
    host.answer("getVoiceStatus", json!({"enabled": false, "busy": true}));
    host.left("voice");
    assert_eq!(host.calls("toggleVoice").len(), before, "a running install is not started twice");
    assert_eq!(host.last_notice(), ("Voice install is already running".to_owned(), "warn".to_owned()));

    host.fail("getVoiceStatus", "away");
    host.left("voice");
    assert_eq!(host.last_notice(), ("voice setup failed: away".to_owned(), "error".to_owned()));
}

// -------------------------------------------------------------- Update

fn update_host() -> Fake {
    let mut host = Fake::new(Kind::Maintenance);
    host.answer(
        "getUpdateSettings",
        json!({"currentVersion": "1.0.0", "latestVersion": "1.1.0", "updateAvailable": true}),
    );
    host.answer("getUpdateStatus", json!({"phase": "idle"}));
    host.answer("checkForUpdate", Value::Null);
    host
}

#[test]
fn update_panel_versions_from_the_daemon_and_the_auto_update_toggle_writes_then_repaints() {
    let auto_update = Rc::new(Cell::new(false));
    let mut host = update_host();
    let state = Rc::clone(&auto_update);
    host.on("getUpdateSettings", move |_| {
        Ok(json!({"currentVersion": "1.0.0", "latestVersion": "1.1.0", "updateAvailable": true, "autoUpdate": state.get()}))
    });
    let state = Rc::clone(&auto_update);
    host.on("setAutoUpdate", move |args| {
        state.set(args[0] == json!(true));
        Ok(Value::Null)
    });
    host.open_picker_by(Opener::Update, json!({}));
    let panel = host.panel().expect("a panel").clone();
    assert_eq!(panel.title, "Update");
    assert_eq!(host.row("current").meta, "1.0.0");
    assert_eq!(host.row("latest").meta, "1.1.0");
    assert_eq!(host.row("auto-update").meta, "Off");
    assert_eq!(panel.confirm_buttons[0].label, "Update to v1.1.0");

    host.select("auto-update");
    assert_eq!(host.calls("setAutoUpdate"), vec![json!([true])]);
    assert_eq!(host.last_notice(), ("Auto-update on".to_owned(), "info".to_owned()));
    assert_eq!(host.row("auto-update").meta, "On");
}

#[test]
fn the_first_paint_comes_before_the_initial_check_and_the_check_repaints() {
    let mut host = update_host();
    let checked = Rc::new(Cell::new(false));
    let seen = Rc::clone(&checked);
    host.on("checkForUpdate", move |_| {
        seen.set(true);
        Ok(Value::Null)
    });
    host.set_hook(|host, action| {
        if action == "checkForUpdate" {
            // "Latest version" is checking while the initial check runs.
            assert_eq!(host.row("latest").meta, "checking\u{2026}");
        }
    });
    host.open_picker_by(Opener::Update, json!({}));
    assert!(checked.get());
    assert_eq!(host.row("latest").meta, "1.1.0");
}

#[test]
fn update_now_reports_the_installed_version_and_the_panel_shows_restart_to_apply() {
    let phase = Rc::new(RefCell::new("idle".to_owned()));
    let mut host = update_host();
    let status = Rc::clone(&phase);
    host.on("getUpdateStatus", move |_| {
        Ok(if *status.borrow() == "installed" { json!({"phase": "installed", "version": "1.1.0"}) } else { json!({"phase": "idle"}) })
    });
    let status = Rc::clone(&phase);
    host.on("runUpdateNow", move |_| {
        *status.borrow_mut() = "installed".to_owned();
        Ok(json!({"ok": true, "version": "1.1.0"}))
    });
    host.open_picker_by(Opener::Update, json!({"returnTo": "settings"}));
    host.confirm("update-now");
    assert_eq!(host.last_notice(), ("v1.1.0 installed \u{2014} restart to apply".to_owned(), "warn".to_owned()));
    assert_eq!(host.row("current").meta, "1.0.0 \u{2192} 1.1.0");
    assert_eq!(host.panel().expect("a panel").confirm_buttons[0].label, "v1.1.0 installed \u{2014} restart to apply");
    // Nothing runs a second time once installed.
    host.confirm("update-now");
    assert_eq!(host.calls("runUpdateNow").len(), 1);
    host.cancel();
    assert_eq!(host.log.iter().filter(|event| event[0] == "returnTo").count(), 1);
    assert_eq!(host.title(), None);
}

#[test]
fn update_failures_are_notices_and_an_install_in_progress_cannot_be_started_again() {
    let mut host = update_host();
    host.fail("getUpdateSettings", "offline");
    host.answer("getUpdateStatus", json!({"phase": "installing"}));
    host.fail("checkForUpdate", "no network");
    host.fail("setAutoUpdate", "denied");
    host.answer("runUpdateNow", json!({"ok": false, "error": "disk full"}));
    host.open_picker_by(Opener::Update, json!({}));
    assert_eq!(host.row("latest").meta, "unknown");
    assert_eq!(host.panel().expect("a panel").confirm_buttons[0].label, "Installing\u{2026}");
    host.select("auto-update");
    host.select("latest");
    host.confirm("update-now");
    assert_eq!(
        host.messages(),
        ["auto-update failed: denied", "update check failed: no network"],
        "an installing run is not started again"
    );

    let mut host = update_host();
    host.answer("runUpdateNow", json!({"ok": false}));
    host.open_picker_by(Opener::Update, json!({}));
    host.confirm("update-now");
    assert_eq!(host.notices(), [("Updating\u{2026}".to_owned(), "info".to_owned()), ("Update failed: unknown error".to_owned(), "error".to_owned())]);
    host.fail("runUpdateNow", "boom");
    host.confirm("update-now");
    assert_eq!(host.last_notice(), ("Update failed: boom".to_owned(), "error".to_owned()));
}

#[test]
fn an_update_check_settling_after_esc_does_not_re_open_the_panel() {
    let mut host = update_host();
    host.set_hook(|host, action| {
        if action == "checkForUpdate" {
            host.esc();
        }
    });
    host.open_picker_by(Opener::Update, json!({}));
    assert_eq!(host.title(), None);
}

// ----------------------------------------------------------- Auto-clear

fn auto_clear_state() -> Value {
    json!({
        "enabled": true,
        "idleMs": 1_800_000,
        "provider": "openai",
        "providerDefaults": [
            {"provider": "openai", "idleMs": 1_800_000, "builtInMs": 3_600_000, "custom": true},
            {"provider": "anthropic", "idleMs": 3_600_000, "builtInMs": 3_600_000},
        ],
    })
}

#[test]
fn auto_clear_rows_follow_the_current_setting_arrows_write_advanced_lists_provider_defaults() {
    let current = Rc::new(RefCell::new(auto_clear_state()));
    let mut host = Fake::new(Kind::Maintenance);
    let (read, written) = (Rc::clone(&current), Rc::clone(&current));
    host.on("getAutoClear", move |_| Ok(read.borrow().clone()));
    host.on("setAutoClear", move |args| {
        let mut state = written.borrow_mut();
        for (key, value) in args[0].as_object().expect("a patch") {
            state[key] = value.clone();
        }
        Ok(state.clone())
    });
    host.open_picker_by(Opener::AutoClear, json!({"returnTo": "settings"}));
    assert_eq!(host.title(), Some("Auto-clear"));
    assert_eq!(host.row("toggle").meta, "On");
    assert_eq!(host.row("toggle").description, format!("Clear idle sessions after {} (openai default) \u{b7} lead cache TTL 5m.", fd(1_800_000.0)));

    host.left("toggle");
    assert_eq!(host.calls("setAutoClear"), vec![json!([{"enabled": false}])]);
    assert_eq!(host.last_notice(), ("autoclear off".to_owned(), "info".to_owned()));
    assert_eq!(host.row("toggle").meta, "Off");
    assert_eq!(host.panel().expect("a panel").description, "Clear idle context after never \u{b7} lead cache TTL 1h.");

    host.select("advanced");
    assert_eq!(host.title(), Some("Auto-clear \u{b7} Advanced"));
    let rows: Vec<(String, String, String)> = host
        .panel()
        .expect("a panel")
        .items
        .iter()
        .map(|item| (item.value.clone(), item.marker.clone(), item.meta.clone()))
        .collect();
    assert_eq!(
        rows,
        [
            ("provider:openai".to_owned(), "\u{2713}".to_owned(), format!("{} custom", fd(1_800_000.0))),
            ("provider:anthropic".to_owned(), String::new(), fd(3_600_000.0)),
        ]
    );
    host.select("provider:openai");
    assert_eq!(host.title(), None);
    let prompt = host.prompt.clone().expect("the provider prompt");
    assert_eq!(prompt.kind, "autoclear-provider");
    assert_eq!(prompt.initial_value.as_deref(), Some("30m"));
    assert!(prompt.hint.contains("built-in 1h."), "{}", prompt.hint);
    assert_eq!(prompt.text("provider"), "openai");
    assert_eq!(prompt.fields.get("_returnTo"), Some(&json!(true)));
}

#[test]
fn auto_clear_esc_in_advanced_goes_back_and_esc_in_the_panel_returns_to_settings() {
    let mut host = Fake::new(Kind::Maintenance);
    host.answer("getAutoClear", auto_clear_state());
    host.open_picker_by(Opener::AutoClear, json!({"advanced": true, "returnTo": "settings"}));
    assert_eq!(host.title(), Some("Auto-clear \u{b7} Advanced"));
    host.cancel();
    assert_eq!(host.title(), Some("Auto-clear"));
    host.cancel();
    assert_eq!(host.title(), None);
    assert_eq!(host.log.iter().filter(|event| event[0] == "returnTo").count(), 1);
}

#[test]
fn auto_clear_writes_that_answer_nothing_fail_or_report_unlimited_say_so() {
    let answers = RefCell::new(VecDeque::from([
        Ok(Value::Null),
        Err("locked".to_owned()),
        Ok(json!({"enabled": true, "unlimited": true})),
        Ok(json!({"enabled": true, "idleMs": 600_000})),
    ]));
    let mut host = Fake::new(Kind::Maintenance);
    host.answer("getAutoClear", auto_clear_state());
    host.on("setAutoClear", move |_| answers.borrow_mut().pop_front().expect("a scripted answer"));
    host.open_picker_by(Opener::AutoClear, json!({}));
    host.right("toggle");
    host.right("toggle");
    host.select("toggle");
    host.select("toggle");
    assert_eq!(
        host.messages(),
        vec![
            "autoclear unavailable".to_owned(),
            "autoclear failed: locked".to_owned(),
            "autoclear on \u{b7} unlimited".to_owned(),
            format!("autoclear on \u{b7} idle {}", fd(600_000.0)),
        ]
    );
}

#[test]
fn the_provider_duration_editor_states_the_built_in_window_it_resets_to() {
    let mut host = Fake::new(Kind::Maintenance);
    host.answer(
        "getAutoClear",
        json!({"providerDefaults": [
            {"provider": "local", "idleMs": 90_000, "builtInMs": 0, "builtInUnlimited": true},
            {"provider": "x", "idleMs": 1500, "builtInMs": 45_000, "unlimited": false},
            {"provider": "y", "idleMs": 0, "unlimited": true, "builtInMs": 7_200_000},
        ]}),
    );
    host.open_picker_by(Opener::AutoClear, json!({"advanced": true}));
    host.select("provider:local");
    let prompt = host.prompt.clone().expect("a prompt");
    assert_eq!(prompt.initial_value.as_deref(), Some("90s"));
    assert!(prompt.hint.ends_with("Empty resets to built-in unlimited."), "{}", prompt.hint);
    assert_eq!(prompt.fields.get("_returnTo"), None);
    host.open_picker_by(Opener::AutoClear, json!({"advanced": true}));
    host.select("provider:x");
    let prompt = host.prompt.clone().expect("a prompt");
    assert_eq!(prompt.initial_value.as_deref(), Some("1500ms"));
    assert!(prompt.hint.ends_with("Empty resets to built-in 45s."), "{}", prompt.hint);
    host.open_picker_by(Opener::AutoClear, json!({"advanced": true}));
    host.select("provider:y");
    let prompt = host.prompt.clone().expect("a prompt");
    assert_eq!(prompt.initial_value.as_deref(), Some("unlimited"));
    assert!(prompt.hint.ends_with("Empty resets to built-in 2h."), "{}", prompt.hint);
}

// -------------------------------------------------------------- Profile

fn profile_state() -> Value {
    json!({
        "title": "Jay",
        "language": "ko",
        "experienceLevel": "vibe-coder",
        "languages": [
            {"id": "system", "label": "System (locale)"},
            {"id": "ko", "label": "Korean"},
            {"id": "en", "label": "English"},
        ],
    })
}

#[test]
fn profile_rows_from_the_profile_read_arrows_cycle_language_and_experience_enter_on_title_prompts() {
    let profile = Rc::new(RefCell::new(profile_state()));
    let mut host = Fake::new(Kind::Maintenance);
    let (read, written) = (Rc::clone(&profile), Rc::clone(&profile));
    host.on("getProfile", move |_| Ok(read.borrow().clone()));
    host.on("setProfile", move |args| {
        for (key, value) in args[0].as_object().expect("a patch") {
            written.borrow_mut()[key] = value.clone();
        }
        Ok(Value::Null)
    });
    host.open_picker_by(Opener::Profile, json!({}));
    let panel = host.panel().expect("a panel").clone();
    assert_eq!(panel.title, "Profile");
    let rows: Vec<(String, String)> = panel.items.iter().map(|item| (item.value.clone(), item.meta.clone())).collect();
    assert_eq!(
        rows,
        [("title", "Jay"), ("experience-level", "Vibe coder"), ("language", "Korean")]
            .map(|(value, meta)| (value.to_owned(), meta.to_owned()))
    );

    host.right("language");
    assert_eq!(host.calls("setProfile"), vec![json!([{"language": "en"}])]);
    assert_eq!(host.last_notice(), ("Language set to English".to_owned(), "info".to_owned()));
    assert_eq!(host.row("language").meta, "English");

    host.left("experience-level");
    assert_eq!(host.calls("setProfile").last(), Some(&json!([{"experienceLevel": "beginner"}])));
    assert_eq!(host.row("experience-level").meta, "Beginner");

    host.select("title");
    assert_eq!(host.title(), None);
    assert_eq!(host.prompt.as_ref().expect("the title prompt").kind, "profile-title");
}

#[test]
fn profile_with_no_experience_level_starts_cycling_from_the_first_and_last_entry() {
    let mut host = Fake::new(Kind::Maintenance);
    host.answer("getProfile", json!({}));
    host.answer("setProfile", Value::Null);
    host.open_picker_by(Opener::Profile, json!({}));
    assert_eq!(host.row("experience-level").meta, "(not set)");
    assert_eq!(host.row("language").meta, "System (locale)");
    host.left("experience-level");
    assert_eq!(host.calls("setProfile"), vec![json!([{"experienceLevel": "expert"}])]);
    host.right("experience-level");
    assert_eq!(host.calls("setProfile").last(), Some(&json!([{"experienceLevel": "beginner"}])));
}

#[test]
fn a_profile_write_acking_after_esc_does_not_re_open_the_panel_and_a_rejected_one_is_a_notice() {
    let mut host = Fake::new(Kind::Maintenance);
    host.answer("getProfile", profile_state());
    host.answer("setProfile", Value::Null);
    host.open_picker_by(Opener::Profile, json!({"returnTo": "settings"}));
    host.set_hook(|host, action| {
        if action == "setProfile" {
            host.esc();
        }
    });
    host.right("language");
    assert_eq!(host.title(), None);

    let mut host = Fake::new(Kind::Maintenance);
    host.answer("getProfile", profile_state());
    host.fail("setProfile", "rejected");
    host.open_picker_by(Opener::Profile, json!({}));
    host.right("language");
    assert_eq!(host.last_notice(), ("profile update failed: rejected".to_owned(), "error".to_owned()));
    assert_eq!(host.title(), Some("Profile"));
}

// ------------------------------------------------------------ Developer

const OAUTH_RISK_WARNING: &str = "Using this provider through OAuth carries a high risk of penalties such as account restrictions.";

fn developer_values() -> Rc<RefCell<BTreeMap<String, bool>>> {
    Rc::new(RefCell::new(
        [("antigravityOAuth", false), ("cursorOAuth", false), ("traceWire", false), ("verbose", true)]
            .into_iter()
            .map(|(id, on)| (id.to_owned(), on))
            .collect(),
    ))
}

fn developer_view(values: &BTreeMap<String, bool>) -> Value {
    let option = |id: &str, label: &str, extra: Value| {
        let mut option = json!({"id": id, "label": label, "description": format!("{label} description."), "enabled": values[id]});
        for (key, value) in extra.as_object().into_iter().flatten() {
            option[key] = value.clone();
        }
        option
    };
    json!({"sections": [
        {"id": "providers", "label": "Providers", "options": [
            option("antigravityOAuth", "Gemini (Antigravity)", json!({"warning": OAUTH_RISK_WARNING, "provider": "antigravity-oauth"})),
            option("cursorOAuth", "Cursor", json!({"warning": OAUTH_RISK_WARNING, "provider": "cursor-oauth"})),
        ]},
        {"id": "diagnostics", "label": "Diagnostics", "options": [
            option("traceWire", "Trace wire", json!({})),
            option("verbose", "Verbose", json!({})),
        ]},
    ]})
}

fn developer_host() -> (Fake, Rc<RefCell<Vec<(String, bool)>>>) {
    let values = developer_values();
    let writes = Rc::new(RefCell::new(Vec::new()));
    let mut host = Fake::new(Kind::Maintenance);
    let read = Rc::clone(&values);
    host.on("getDeveloperSettings", move |_| Ok(developer_view(&read.borrow())));
    let (written, log) = (Rc::clone(&values), Rc::clone(&writes));
    host.on("setDeveloperOption", move |args| {
        let (id, enabled) = (args[0].as_str().expect("an id").to_owned(), args[1] == json!(true));
        log.borrow_mut().push((id.clone(), enabled));
        written.borrow_mut().insert(id, enabled);
        Ok(developer_view(&written.borrow()))
    });
    (host, writes)
}

#[test]
fn developer_sections_render_from_the_data_enter_opens_a_section_esc_walks_back_to_settings() {
    let (mut host, _) = developer_host();
    host.open_picker_by(Opener::Developer, json!({"returnTo": "settings"}));
    assert_eq!(host.title(), Some("Developer"));
    let rows: Vec<(String, String, String)> = host
        .panel()
        .expect("a panel")
        .items
        .iter()
        .map(|item| (item.value.clone(), item.label.clone(), item.meta.clone()))
        .collect();
    assert_eq!(
        rows,
        [("providers", "Providers", "0 on"), ("diagnostics", "Diagnostics", "1 on")]
            .map(|(value, label, meta)| (value.to_owned(), label.to_owned(), meta.to_owned()))
    );
    assert_eq!(host.row("providers").description, "Gemini (Antigravity), Cursor");

    host.select("diagnostics");
    assert_eq!(host.title(), Some("Developer \u{b7} Diagnostics"));
    assert_eq!((host.row("traceWire").meta, host.row("verbose").meta), ("Off".to_owned(), "On".to_owned()));

    host.cancel();
    assert_eq!(host.title(), Some("Developer"));
    let panel = host.panel().expect("a panel");
    assert_eq!(panel.items[panel.initial_index.expect("a focus")].value, "diagnostics");
    host.cancel();
    assert_eq!(host.title(), None);
    assert_eq!(host.log.iter().filter(|event| event[0] == "returnTo").count(), 1);
}

#[test]
fn developer_arrows_set_and_enter_flips_an_option() {
    let (mut host, writes) = developer_host();
    host.open_picker_by(Opener::Developer, json!({}));
    host.select("diagnostics");
    assert_eq!(host.row("traceWire").meta, "Off");

    host.right("traceWire");
    assert_eq!(*writes.borrow(), [("traceWire".to_owned(), true)]);
    assert_eq!(host.last_notice(), ("Trace wire on".to_owned(), "info".to_owned()));
    assert_eq!(host.row("traceWire").meta, "On");

    host.select("traceWire");
    assert_eq!(writes.borrow().last(), Some(&("traceWire".to_owned(), false)));
    assert_eq!(host.last_notice(), ("Trace wire off".to_owned(), "info".to_owned()));
    assert_eq!(host.row("traceWire").meta, "Off");

    host.left("traceWire");
    assert_eq!(writes.borrow().len(), 2, "setting the current value writes nothing");
    assert!(host.cleared().is_empty(), "an option without a provider leaves the model catalog alone");
}

#[test]
fn developer_option_with_a_warning_turns_on_only_after_its_confirmation_off_needs_none() {
    let (mut host, writes) = developer_host();
    host.open_picker_by(Opener::Developer, json!({}));
    host.select("providers");
    let rows: Vec<(String, String)> =
        host.panel().expect("a panel").items.iter().map(|item| (item.label.clone(), item.meta.clone())).collect();
    assert_eq!(
        rows,
        [("Gemini (Antigravity)", "Off"), ("Cursor", "Off")].map(|(label, meta)| (label.to_owned(), meta.to_owned()))
    );

    host.right("cursorOAuth");
    assert_eq!(host.title(), Some("Turn on Cursor"));
    assert_eq!(host.values(), ["cancel", "accept"]);
    let lines: Vec<String> = host
        .panel()
        .expect("a panel")
        .footer
        .iter()
        .map(|line| match line {
            FooterInput::Object { text, .. } => text.clone(),
            FooterInput::Plain(text) => text.clone(),
        })
        .collect();
    assert!(lines.len() > 1 && lines.iter().all(|line| line.len() <= 60), "the warning is wrapped, not truncated: {lines:?}");
    assert_eq!(lines.join(" "), OAUTH_RISK_WARNING);
    assert!(writes.borrow().is_empty(), "the warning asks before writing");

    host.select("cancel");
    assert_eq!(host.title(), Some("Developer \u{b7} Providers"));
    host.select("cursorOAuth");
    host.cancel();
    assert_eq!(host.title(), Some("Developer \u{b7} Providers"));
    assert_eq!(host.row("cursorOAuth").meta, "Off");
    assert!(writes.borrow().is_empty(), "Cancel and Esc write nothing");
    assert!(host.cleared().is_empty());

    host.right("cursorOAuth");
    host.select("accept");
    assert_eq!(*writes.borrow(), [("cursorOAuth".to_owned(), true)]);
    assert_eq!(host.last_notice(), ("Cursor on".to_owned(), "info".to_owned()));
    assert_eq!(host.title(), Some("Developer \u{b7} Providers"));
    assert_eq!(host.row("cursorOAuth").meta, "On");
    assert_eq!(host.row("antigravityOAuth").meta, "Off", "each provider has its own toggle");
    assert_eq!(host.cleared(), ["all"], "turning a provider on drops the cached model list");

    host.left("cursorOAuth");
    assert_eq!(writes.borrow().last(), Some(&("cursorOAuth".to_owned(), false)));
    assert_eq!(host.row("cursorOAuth").meta, "Off");
    assert_eq!(host.cleared(), ["all", "all"], "turning it off drops the cached model list too");
}

#[test]
fn developer_write_that_answers_nothing_or_fails_is_a_notice_and_unreadable_settings_are_empty() {
    let (mut host, _) = developer_host();
    host.answer("setDeveloperOption", Value::Null);
    host.open_picker_by(Opener::Developer, json!({}));
    host.select("diagnostics");
    host.right("traceWire");
    assert_eq!(host.last_notice(), ("developer settings unavailable".to_owned(), "warn".to_owned()));
    host.fail("setDeveloperOption", "locked");
    host.left("verbose");
    assert_eq!(host.last_notice(), ("Verbose failed: locked".to_owned(), "error".to_owned()));

    let mut host = Fake::new(Kind::Maintenance);
    host.fail("getDeveloperSettings", "away");
    host.open_picker_by(Opener::Developer, json!({}));
    assert_eq!(host.last_notice(), ("developer settings unavailable: away".to_owned(), "error".to_owned()));
    assert!(host.panel().expect("an empty list").items.is_empty());
}

#[test]
fn a_developer_write_acking_after_esc_does_not_re_open_the_section() {
    let (mut host, _) = developer_host();
    host.open_picker_by(Opener::Developer, json!({}));
    host.select("diagnostics");
    host.set_hook(|host, action| {
        if action == "setDeveloperOption" {
            host.esc();
        }
    });
    host.right("traceWire");
    assert_eq!(host.title(), None, "the late ack did not repaint the section");
    assert_eq!(host.calls("getDeveloperSettings").len(), 2);
}

#[test]
fn the_openers_of_other_pickers_are_not_ours() {
    let mut host = Fake::new(Kind::Settings);
    assert!(matches!(settings::open(&mut host, Opener::Model, &json!({})), Opening::NotMine));
}

// ----------------------------------------------------------------- twin

const GOLDEN: &str = include_str!("goldens/pickers-settings.json");

/// The panel as `record-pickers-settings.mjs` records it.
fn panel_out(panel: Option<&Panel>) -> Value {
    let Some(panel) = panel else { return Value::Null };
    let index_mode = panel.index_mode.map(|mode| match mode {
        mixdog_tui_widgets::picker::IndexMode::Auto => "auto",
        mixdog_tui_widgets::picker::IndexMode::Always => "always",
        mixdog_tui_widgets::picker::IndexMode::Never => "never",
    });
    json!({
        "title": panel.title,
        "description": panel.description,
        "help": panel.help,
        "indexMode": index_mode,
        "labelWidth": panel.label_width,
        "metaWidth": panel.meta_width,
        "initialIndex": panel.initial_index,
        "loading": panel.loading,
        "items": panel.items.iter().map(|item| json!([item.value, item.label, item.meta, item.description, item.marker])).collect::<Vec<_>>(),
        "footer": panel.footer.iter().map(|line| match line {
            FooterInput::Object { glyph, text, .. } => json!([glyph, text]),
            FooterInput::Plain(text) => json!(["", text]),
        }).collect::<Vec<_>>(),
        "confirm": panel.confirm_buttons.iter().map(|button| button.label.clone()).collect::<Vec<_>>(),
    })
}

fn opener_named(name: &str) -> Opener {
    match name {
        "settings" => Opener::Settings,
        "update" => Opener::Update,
        "autoclear" => Opener::AutoClear,
        "profile" => Opener::Profile,
        "developer" => Opener::Developer,
        other => panic!("no picker {other}"),
    }
}

/// Plays a scenario of the golden on a fake whose store answers what the scenario scripts.
fn play(spec: &Value) -> (Vec<Value>, Vec<Value>) {
    let mut host = Fake::new(if spec["kind"] == "settings" { Kind::Settings } else { Kind::Maintenance });
    for (action, answer) in spec["store"].as_object().expect("a store") {
        host.script(action, answer);
    }
    let mut panels = Vec::new();
    for step in spec["steps"].as_array().expect("steps") {
        let key = |name: &str| step.get(name).and_then(Value::as_str).map(str::to_owned);
        if let Some(name) = key("open") {
            let mut options = step["options"].clone();
            if options.get("returnTo") == Some(&json!(true)) {
                options["returnTo"] = json!("settings");
            }
            host.open_picker_by(opener_named(&name), options);
        } else if let Some(value) = key("left") {
            host.left(&value);
        } else if let Some(value) = key("right") {
            host.right(&value);
        } else if let Some(value) = key("select") {
            host.select(&value);
        } else if let Some(value) = key("confirm") {
            host.confirm(&value);
        } else if step.get("cancel").is_some() {
            host.cancel();
        }
        panels.push(panel_out(host.panel()));
    }
    (host.log, panels)
}

#[test]
fn the_pickers_do_what_the_node_pickers_do() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("pickers-settings.json is valid JSON");
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 20, "{} scenarios", scenarios.len());
    let mut mismatches = Vec::new();
    for scenario in scenarios {
        let (events, panels) = play(&scenario["spec"]);
        let name = scenario["name"].as_str().unwrap_or_default();
        let (want_events, want_panels) = (scenario["events"].as_array().expect("events"), scenario["panels"].as_array().expect("panels"));
        if events != *want_events {
            let at = events.iter().zip(want_events).position(|(got, want)| got != want).unwrap_or(events.len().min(want_events.len()));
            mismatches.push(format!("{name}: event {at}: got {:?}, want {:?}", events.get(at), want_events.get(at)));
        }
        if panels != *want_panels {
            let at = panels.iter().zip(want_panels).position(|(got, want)| got != want).unwrap_or(0);
            mismatches.push(format!("{name}: panel after step {at}: got {}, want {}", panels[at], want_panels[at]));
        }
    }
    assert!(mismatches.is_empty(), "{} scenarios differ, first:\n{}", mismatches.len(), mismatches[..mismatches.len().min(6)].join("\n"));
}
