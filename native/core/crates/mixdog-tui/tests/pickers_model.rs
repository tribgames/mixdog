//! The Rust model, effort, Fast, web search, workflow, output style, agents and theme pickers against what the Node code does
//! (tests/goldens/pickers-model.json, recorded by tests/recorders/record-pickers-model.mjs): the model options over every
//! catalog of the recording, and scenarios of scripted operations whose store calls, notices, events and on-screen panel are
//! compared step by step. The ports of the Node unit tests (model-options.test.mjs, model-options-provider-names.test.mjs,
//! model-picker.test.mjs, route-pickers/workflow-picker.test.mjs) follow.
//!
//! The recorder is run on a Node checkout (`node tests/recorders/record-pickers-model.mjs --tree <checkout> --check
//! tests/goldens/pickers-model.json`); this test only reads the recording.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use mixdog_tui::app::AppCtx;
use mixdog_tui::pickers::PickerKind;
use mixdog_tui::pickers::common::{PanelItem, PickerFn, PickerHost, PickerPanel, ProviderSetupRequest, RouteState};
#[cfg(node_twin)]
use mixdog_tui::pickers::common::Onboarding;
#[cfg(node_twin)]
use mixdog_tui::pickers::model::agents::{AgentsOptions, open_agents_picker};
use mixdog_tui::pickers::model::catalog::{CatalogKind, CatalogRefresh, ModelCatalogCaches};
#[cfg(node_twin)]
use mixdog_tui::pickers::model::catalog::run_catalog_refresh;
use mixdog_tui::pickers::model::options::{self, ProviderNames};
#[cfg(node_twin)]
use mixdog_tui::pickers::model::output_style::{OutputStyleOptions, open_output_style_picker};
use mixdog_tui::pickers::model::picker::{ModelPickerOptions, SelectRoute};
#[cfg(node_twin)]
use mixdog_tui::pickers::model::picker::ImmediateSelect;
#[cfg(node_twin)]
use mixdog_tui::pickers::model::theme::{ThemeOptions, open_effort_picker, open_theme_picker};
#[cfg(node_twin)]
use mixdog_tui::pickers::model::web_search::{WebSearchOptions, open_web_search_picker};
use mixdog_tui::pickers::model::workflow::{WorkflowOptions, open_workflow_picker};
use mixdog_tui::pickers::model::open_model_picker;
use mixdog_tui::slash::host::Tone;
use mixdog_tui::surface::epoch::PanelValue;
use mixdog_tui::surface::owner::PanelSurface;
use mixdog_tui::surface::{SurfaceClaim, SurfaceKind};
use mixdog_tui_widgets::picker::PickerItem;
#[cfg(node_twin)]
use mixdog_tui_widgets::picker::IndexMode;
use mixdog_tui_widgets::picker::layout::FooterInput;
use serde_json::{Map, Value, json};

// ---------------------------------------------------------------------------------------------------------------- the host

type Events = Rc<RefCell<Vec<Value>>>;

/// A recording [`PickerHost`] over a real [`PanelSurface`]: the store answers a scenario scripts, the notices and events it
/// logs in the shape `record-pickers-model.mjs` logs them in.
struct Fake {
    surface: PanelSurface<PickerPanel, (), ()>,
    caches: ModelCatalogCaches,
    state: RouteState,
    script: Map<String, Value>,
    calls: Vec<Value>,
    notices: Vec<Value>,
    events: Events,
    clock: u64,
    jobs: VecDeque<CatalogRefresh>,
    setup: Option<ProviderSetupRequest>,
    supersede_next: bool,
}

impl AppCtx for Fake {
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String> {
        // The recorded store has the methods a scenario scripts and no others: Node reads the rest with `store?.method?.()`, which
        // makes no call, so an unscripted method is neither logged nor does it supersede the panel.
        if !self.script.contains_key(action) {
            return Ok(Value::Null);
        }
        self.calls.push(json!([action, args]));
        if std::mem::take(&mut self.supersede_next) {
            self.surface.supersede();
        }
        let Some(entry) = self.script.get(action) else { return Ok(Value::Null) };
        let entry = match entry.get("$args") {
            Some(by_args) => {
                let key = serde_json::to_string(&args).expect("args serialize");
                by_args.get(&key).or_else(|| by_args.get("*")).cloned().unwrap_or(Value::Null)
            }
            None => entry.clone(),
        };
        match entry.get("$error") {
            Some(message) => Err(message.as_str().unwrap_or_default().to_owned()),
            None => Ok(entry),
        }
    }

    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim {
        self.surface.surface_claim(kind)
    }

    fn open_picker(&mut self, _kind: PickerKind) -> SurfaceClaim {
        self.surface.surface_claim(SurfaceKind::Picker)
    }
}

impl PickerHost for Fake {
    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.notices.push(json!([text, tone.as_str()]));
    }

    fn now_ms(&self) -> u64 {
        self.clock
    }

    fn route_state(&self) -> RouteState {
        self.state.clone()
    }

    fn clear_prompts(&mut self) {
        self.events.borrow_mut().push(json!(["clearProviderPrompt"]));
        self.events.borrow_mut().push(json!(["clearSettingsPrompt"]));
    }

    fn clear_context_panel(&mut self, claim: SurfaceClaim) -> Option<SurfaceClaim> {
        if !self.surface.epoch().is_current(claim.epoch) {
            return None;
        }
        self.events.borrow_mut().push(json!(["context", null]));
        self.surface.supersede();
        Some(self.surface.surface_claim(SurfaceKind::Picker))
    }

    fn close_usage_panel(&mut self) {
        self.events.borrow_mut().push(json!(["closeUsage"]));
    }

    fn owns_surface(&self, claim: SurfaceClaim) -> bool {
        self.surface.epoch().is_current(claim.epoch)
    }

    fn close_surface(&mut self, claim: SurfaceClaim) {
        if self.owns_surface(claim) {
            self.surface.set_picker(None);
            // Closing hands ownership back for good.
            self.surface.supersede();
        }
    }

    fn paint_picker(&mut self, claim: SurfaceClaim, panel: Option<PickerPanel>) -> Option<SurfaceClaim> {
        if !self.owns_surface(claim) {
            return None;
        }
        self.surface.set_picker(panel);
        Some(self.surface.surface_claim(SurfaceKind::Picker))
    }

    fn model_caches(&mut self) -> &mut ModelCatalogCaches {
        &mut self.caches
    }

    fn schedule_catalog_refresh(&mut self, job: CatalogRefresh) {
        self.jobs.push_back(job);
    }

    fn open_provider_setup(&mut self, request: ProviderSetupRequest) {
        self.events.borrow_mut().push(json!(["providerSetup", request.title, request.continue_label, request.continue_description]));
        self.setup = Some(request);
    }
}

const T0: u64 = 1_000_000_000;

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

impl Fake {
    /// A host for a scenario spec (`{ state, caches, clock, store }`).
    fn new(spec: &Value) -> Self {
        let mut script = Map::new();
        script.insert("listProviderModels".to_owned(), json!([]));
        script.insert("listWebSearchModels".to_owned(), json!([]));
        for (key, value) in spec.get("store").and_then(Value::as_object).into_iter().flatten() {
            script.insert(key.clone(), value.clone());
        }
        let state_spec = spec.get("state").cloned().unwrap_or_else(|| json!({}));
        let state = RouteState {
            provider: state_spec.get("provider").and_then(Value::as_str).unwrap_or("anthropic").to_owned(),
            model: state_spec.get("model").and_then(Value::as_str).unwrap_or("claude-x-1").to_owned(),
            effort: state_spec.get("effort").and_then(Value::as_str).map(str::to_owned),
            fast: state_spec.get("fast").and_then(Value::as_bool).or(Some(false)),
            model_parameters: state_spec.get("modelParameters").cloned().unwrap_or(Value::Null),
            context_percent: state_spec.get("contextPercent").cloned().unwrap_or(Value::Null),
            effort_options: state_spec.get("effortOptions").and_then(Value::as_array).cloned().unwrap_or_default(),
            busy: state_spec.get("busy").and_then(Value::as_bool).unwrap_or(false),
        };
        let mut caches = ModelCatalogCaches::new();
        for (kind, key) in [(CatalogKind::Provider, "provider"), (CatalogKind::WebSearch, "webSearch")] {
            let entry = spec.get("caches").and_then(|caches| caches.get(key));
            let models = entry.and_then(|entry| entry.get("models")).and_then(Value::as_array).cloned();
            caches.store(kind, models, entry.and_then(|entry| entry.get("at")).and_then(Value::as_u64).unwrap_or(0));
        }
        Self {
            surface: PanelSurface::new(),
            caches,
            state,
            script,
            calls: Vec::new(),
            notices: Vec::new(),
            events: Rc::new(RefCell::new(Vec::new())),
            clock: spec.get("clock").and_then(Value::as_u64).unwrap_or(T0),
            jobs: VecDeque::new(),
            setup: None,
            supersede_next: false,
        }
    }

    fn panel(&self) -> Option<PickerPanel> {
        self.surface.picker().cloned()
    }

    /// What settles on its own in the app after an operation: the scheduled catalog refreshes.
    #[cfg(node_twin)]
    fn settle(&mut self) {
        while let Some(job) = self.jobs.pop_front() {
            run_catalog_refresh(self, job);
        }
    }

    /// The row a scenario names: an index, or a value, model id or provider.
    fn row(&self, reference: &Value) -> Option<PanelItem> {
        let panel = self.panel()?;
        match reference.as_u64() {
            Some(index) => panel.items.get(index as usize).cloned(),
            None => {
                let wanted = reference.as_str().unwrap_or_default();
                panel
                    .items
                    .iter()
                    .find(|row| row.item.value == wanted || row.tag_text("_modelId") == wanted || row.tag_text("_provider") == wanted)
                    .cloned()
            }
        }
    }

    fn select(&mut self, reference: &Value) {
        let Some(panel) = self.panel() else { return };
        // Node calls `panel.onSelect(item?.value, item)` whether or not a row matched; a handler that does not look at the row (the
        // agent's own panel opens its model list for anything but `off`) still runs.
        let item = self.row(reference).unwrap_or_else(|| PanelItem::new(PickerItem::new("", ""), json!({})));
        if let Some(handler) = panel.handler {
            handler.on_select(self, &item);
        }
    }

    #[cfg(node_twin)]
    fn adjust(&mut self, key: &str, reference: &Value) {
        let (Some(panel), item) = (self.panel(), self.row(reference)) else { return };
        let Some(handler) = panel.handler else { return };
        match key {
            "left" => handler.on_left(self, item.as_ref()),
            "right" => handler.on_right(self, item.as_ref()),
            _ => handler.on_tab(self, item.as_ref()),
        }
    }

    #[cfg(node_twin)]
    fn key(&mut self, input: &str, reference: &Value) {
        let (Some(panel), item) = (self.panel(), self.row(reference)) else { return };
        if let Some(handler) = panel.handler {
            handler.on_key(self, input, item.as_ref());
        }
    }

    #[cfg(node_twin)]
    fn highlight(&mut self, reference: &Value) {
        let (Some(panel), Some(item)) = (self.panel(), self.row(reference)) else { return };
        if let Some(handler) = panel.handler.filter(|handler| handler.wants_highlight()) {
            handler.on_highlight(self, &item);
        }
    }

    fn cancel(&mut self) {
        if let Some(handler) = self.panel().and_then(|panel| panel.handler) {
            handler.on_cancel(self);
        }
    }

    #[cfg(node_twin)]
    fn confirm(&mut self, button: &str) {
        let Some(panel) = self.panel().filter(|panel| panel.confirm.is_some()) else { return };
        if let Some(handler) = panel.handler {
            handler.on_confirm(self, button);
        }
    }

    /// The footer texts of every row of the panel.
    #[cfg(node_twin)]
    fn footers(&self, panel: &PickerPanel) -> Option<Value> {
        let footer = panel.footer.as_ref()?;
        let rows: Vec<Value> = panel
            .items
            .iter()
            .map(|row| {
                Value::Array(
                    footer(Some(row))
                        .into_iter()
                        .map(|line| match line {
                            FooterInput::Object { glyph, text, .. } => json!([glyph, text]),
                            FooterInput::Plain(text) => json!(["", text]),
                        })
                        .collect(),
                )
            })
            .collect();
        Some(Value::Array(rows))
    }

    /// The footer texts of one model row (`footerText(id)`).
    fn footer_texts(&self, model_id: &str) -> Vec<String> {
        let panel = self.panel().expect("a panel is on screen");
        let row = panel.items.iter().find(|row| row.tag_text("_modelId") == model_id).expect("the row exists");
        (panel.footer.as_ref().expect("a footer"))(Some(row))
            .into_iter()
            .map(|line| match line {
                FooterInput::Object { text, .. } => text,
                FooterInput::Plain(text) => text,
            })
            .collect()
    }

    /// The panel as `record-pickers-model.mjs` summarises it.
    #[cfg(node_twin)]
    fn summary(&self) -> Value {
        let Some(panel) = self.panel() else { return Value::Null };
        let items: Vec<Value> = panel
            .items
            .iter()
            .map(|row| {
                let tag = |key: &str| row.tag(key).and_then(Value::as_str).map_or(Value::Null, |text| json!(text));
                json!({
                    "value": row.item.value,
                    "label": row.item.label,
                    "marker": row.item.marker,
                    "meta": row.item.meta,
                    "description": row.item.description,
                    "metaParts": row.item.meta_parts.as_ref().map(|parts| parts.iter().map(|part| json!([part.text, part.width])).collect::<Vec<_>>()),
                    "action": tag("_action"),
                    "provider": tag("_provider"),
                    "modelId": tag("_modelId"),
                    "failure": tag("_failure"),
                })
            })
            .collect();
        let handler = panel.handler.as_ref();
        json!({
            "title": panel.title,
            "description": panel.description,
            "help": panel.help,
            "pickerKey": panel.picker_key,
            "initialIndex": panel.initial_index,
            "indexMode": panel.index_mode.map(|mode| match mode {
                IndexMode::Always => "always",
                IndexMode::Never => "never",
                IndexMode::Auto => "auto",
            }),
            "labelWidth": panel.label_width,
            "metaWidth": panel.meta_width,
            "loading": panel.loading,
            "confirm": panel.confirm.as_ref().map(|confirm| confirm.buttons.iter().map(|button| json!([button.value, button.label])).collect::<Vec<_>>()),
            "adjustable": handler.is_some_and(|handler| handler.adjustable()),
            "highlights": handler.is_some_and(|handler| handler.wants_highlight()),
            "items": items,
            "footers": self.footers(&panel),
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------- options

/// The caller continuations a scenario names, which log what they were called with.
#[cfg(node_twin)]
struct Callbacks {
    return_to: Option<PickerFn>,
    after_select: Option<PickerFn>,
    immediate: Option<ImmediateSelect>,
    handoff: Option<PickerPanel>,
    on_select_route: Option<SelectRoute>,
    onboarding: Option<Onboarding>,
}

fn log_fn(events: &Events, entry: Value) -> PickerFn {
    let events = Rc::clone(events);
    Rc::new(move |_| events.borrow_mut().push(entry.clone()))
}

#[cfg(node_twin)]
impl Callbacks {
    fn new(raw: &Value, events: &Events) -> Self {
        let flag = |key: &str| raw.get(key).is_some_and(|value| value.as_bool().unwrap_or(true) && !value.is_null());
        let on_select_route: Option<SelectRoute> = raw.get("onSelectRoute").and_then(Value::as_str).map(|mode| {
            let (events, fails) = (Rc::clone(events), mode == "fail");
            let route: SelectRoute = Rc::new(move |_host: &mut dyn PickerHost, route: &Value, picked: &Value, effort: &Option<String>| {
                events.borrow_mut().push(json!(["onSelectRoute", route["model"], picked["id"], effort]));
                if fails { Err("disk full".to_owned()) } else { Ok(Value::Null) }
            });
            route
        });
        Self {
            return_to: flag("returnTo").then(|| log_fn(events, json!(["returnTo"]))),
            after_select: flag("onAfterSelect").then(|| log_fn(events, json!(["afterSelect"]))),
            immediate: flag("onImmediateSelect").then(|| {
                let events = Rc::clone(events);
                let immediate: ImmediateSelect = Rc::new(move |_host: &mut dyn PickerHost, route: &Value| events.borrow_mut().push(json!(["immediate", route.get("model").cloned().unwrap_or(Value::Null)])));
                immediate
            }),
            handoff: flag("handoffPanel").then(|| PickerPanel::new("Handoff")),
            on_select_route,
            onboarding: flag("onboarding").then(|| Onboarding {
                on_advance: Some(log_fn(events, json!(["onboarding", "advance"]))),
                on_back: Some(log_fn(events, json!(["onboarding", "back"]))),
                on_cancel: Some(log_fn(events, json!(["onboarding", "cancel"]))),
            }),
        }
    }
}

#[cfg(node_twin)]
fn opt_text(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(node_twin)]
fn model_options(raw: &Value, callbacks: Callbacks) -> ModelPickerOptions {
    ModelPickerOptions {
        title: opt_text(raw, "title"),
        provider_description: opt_text(raw, "providerDescription"),
        model_description: opt_text(raw, "modelDescription"),
        empty_notice: opt_text(raw, "emptyNotice"),
        refresh_models: raw.get("refreshModels").and_then(Value::as_bool).unwrap_or(false),
        current_route: raw.get("currentRoute").cloned(),
        return_to: callbacks.return_to,
        return_label: opt_text(raw, "returnLabel"),
        return_on_nested_cancel: raw.get("returnOnNestedCancel").and_then(Value::as_bool).unwrap_or(false),
        handoff_panel: callbacks.handoff,
        on_select_route: callbacks.on_select_route,
        on_immediate_select: callbacks.immediate,
        on_after_select: callbacks.after_select,
        ..ModelPickerOptions::default()
    }
}

/// Runs one operation of a scenario.
#[cfg(node_twin)]
fn run_op(fake: &mut Fake, op: &Value) {
    let raw = op.get("options").cloned().unwrap_or_else(|| json!({}));
    let events = Rc::clone(&fake.events);
    if op.get("supersedeDuring").is_some() {
        fake.supersede_next = true;
    }
    if let Some(name) = op.get("open").and_then(Value::as_str) {
        let callbacks = Callbacks::new(&raw, &events);
        match name {
            "model" => open_model_picker(fake, model_options(&raw, callbacks)),
            "websearch" => open_web_search_picker(
                fake,
                WebSearchOptions {
                    route_override: raw.get("routeOverride").cloned(),
                    return_to: callbacks.return_to,
                    return_label: opt_text(&raw, "returnLabel"),
                    return_on_nested_cancel: raw.get("returnOnNestedCancel").and_then(Value::as_bool).unwrap_or(false),
                },
            ),
            "agents" => open_agents_picker(
                fake,
                AgentsOptions {
                    refresh_models: raw.get("refreshModels").and_then(Value::as_bool).unwrap_or(false),
                    route_overrides: raw.get("routeOverrides").and_then(Value::as_object).into_iter().flatten().map(|(id, route)| (id.clone(), route.clone())).collect(),
                    initial_agent_id: opt_text(&raw, "initialAgentId").unwrap_or_default(),
                },
            ),
            "workflow" => open_workflow_picker(fake, WorkflowOptions { return_to: callbacks.return_to, handoff_panel: callbacks.handoff }),
            "outputstyle" => open_output_style_picker(
                fake,
                OutputStyleOptions { return_to: callbacks.return_to, handoff_panel: callbacks.handoff, onboarding: callbacks.onboarding, confirm_bar: None },
            ),
            "theme" => open_theme_picker(
                fake,
                ThemeOptions { return_to: callbacks.return_to, handoff_panel: callbacks.handoff, onboarding: callbacks.onboarding, confirm_bar: None },
            ),
            "effort" => open_effort_picker(fake),
            other => panic!("unknown opener {other}"),
        }
    } else if op.get("continue").is_some() {
        if let Some(request) = fake.setup.take() {
            (request.on_continue)(fake);
        }
    } else if let Some(reference) = op.get("select") {
        fake.select(reference);
    } else if let Some(key) = ["left", "right", "tab"].into_iter().find(|key| op.get(*key).is_some()) {
        fake.adjust(key, &op[key]);
    } else if let Some(input) = op.get("key").and_then(Value::as_str) {
        fake.key(input, op.get("row").unwrap_or(&Value::Null));
    } else if let Some(reference) = op.get("highlight") {
        fake.highlight(reference);
    } else if op.get("cancel").is_some() {
        fake.cancel();
    } else if let Some(button) = op.get("confirm").and_then(Value::as_str) {
        fake.confirm(button);
    } else if op.get("supersede").is_some() {
        fake.surface.supersede();
    } else if let Some(ms) = op.get("advance").and_then(Value::as_u64) {
        fake.clock += ms;
    }
    fake.settle();
}

/// The store calls of one step as a multiset: whether `got` holds the same calls as `want`, in any order.
#[cfg(node_twin)]
fn same_calls(got: &[Value], want: &[Value]) -> bool {
    let mut rest: Vec<&Value> = want.iter().collect();
    got.len() == want.len()
        && got.iter().all(|call| match rest.iter().position(|candidate| *candidate == call) {
            Some(at) => {
                rest.remove(at);
                true
            }
            None => false,
        })
}

#[cfg(node_twin)]
fn caches_of(fake: &Fake) -> Value {
    let provider = fake.caches.entry(CatalogKind::Provider);
    let web = fake.caches.entry(CatalogKind::WebSearch);
    json!([provider.models.as_ref().map(Vec::len), provider.at, web.models.as_ref().map(Vec::len), web.at])
}

// ---------------------------------------------------------------------------------------------------------------- model options twin

#[cfg(node_twin)]
fn number_of(value: &Value) -> f64 {
    match value {
        Value::Null => f64::NAN,
        Value::String(text) => match text.as_str() {
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => f64::NAN,
        },
        other => other.as_f64().expect("a number"),
    }
}

#[cfg(node_twin)]
fn same_number(got: f64, want: &Value) -> bool {
    let want = number_of(want);
    (got.is_nan() && want.is_nan()) || got == want
}

#[cfg(node_twin)]
fn row_summary(row: &PanelItem) -> Value {
    json!([row.item.value, row.item.label, row.item.marker, row.item.meta, row.item.description, row.tag_text("_action"), row.tag_text("_provider"), row.tag_text("_modelId")])
}

#[cfg(node_twin)]
fn names_of(value: &Value) -> ProviderNames {
    value.as_object().into_iter().flatten().map(|(id, name)| (id.clone(), name.as_str().unwrap_or_default().to_owned())).collect()
}

#[cfg(node_twin)]
fn pair_of(models: &[Value]) -> Value {
    Value::Array(models.iter().map(|model| json!([model["provider"], model["id"]])).collect())
}

// ---------------------------------------------------------------------------------------------------------------- ported unit tests

fn model(provider: &str, id: &str) -> Value {
    json!({"provider": provider, "id": id})
}

#[test]
fn model_version_parsing_preserves_claude_compact_and_generic_precedence() {
    for (id, expected) in [
        ("CLAUDE-OPUS-5", vec![5.0, 0.0]),
        ("claude-sonnet-4-6", vec![4.0, 6.0]),
        ("claude-sonnet-4.6", vec![4.0, 6.0]),
        ("gpt5.2.123", vec![5.0, 2.0, 123.0]),
        ("prefix-1-gpt5.2", vec![5.0, 2.0]),
        ("gpt-5", vec![5.0]),
        ("vendor-v3.4", vec![3.0, 4.0]),
        ("vendor-v2.3.4567", vec![2.0, 3.0, 456.0]),
        ("unversioned", vec![]),
        ("", vec![]),
    ] {
        assert_eq!(options::parsed_model_version(id), expected, "{id}");
    }
}

#[test]
fn version_consumers_retain_display_fallback_descending_order_and_context_defaults() {
    assert_eq!(options::model_version(&json!({"id": "unversioned", "display": "gpt5.1"})), vec![5.0, 1.0]);
    assert_eq!(options::compare_model_version(&json!({"id": "gpt-5.2"}), &json!({"id": "gpt-5.1"})), -1.0);
    assert_eq!(options::model_context_window(&model("anthropic", "claude-opus-5")), 1_000_000.0);
    assert_eq!(options::model_context_window(&model("anthropic", "claude-sonnet-4-6")), 1_000_000.0);
    assert_eq!(options::model_context_window(&json!({"provider": "anthropic", "id": "claude-opus-5", "contextWindow": 200_000})), 200_000.0);
    assert_eq!(options::model_context_window(&model("openai", "gpt-5")), 0.0);
}

#[test]
fn all_openrouter_rolling_aliases_remain_selectable_beyond_the_eight_model_family_limit() {
    let ids = [
        "~google/gemini-flash-latest", "~google/gemini-pro-latest", "~anthropic/claude-opus-latest", "~anthropic/claude-sonnet-latest",
        "~anthropic/claude-haiku-latest", "~anthropic/claude-fable-latest", "~deepseek/deepseek-pro-latest", "~deepseek/deepseek-flash-latest",
        "~deepseek/deepseek-v4-flash-latest", "~openai/gpt-astra-latest", "~openai/gpt-sol-latest", "~openai/gpt-terra-latest",
        "~openai/gpt-luna-latest", "~openai/gpt-mini-latest", "~z-ai/glm-flash-latest", "~z-ai/glm-latest", "~moonshotai/kimi-latest", "~x-ai/grok-latest",
    ];
    let models: Vec<Value> = ids.iter().enumerate().map(|(at, id)| json!({"id": id, "provider": "openrouter", "created": 1000 + at})).collect();
    let normalized = options::normalize_model_options(&models);
    assert_eq!(normalized.len(), ids.len());
    let mut got: Vec<String> = normalized.iter().map(|model| text(model, "id")).collect();
    got.sort();
    let mut want: Vec<String> = ids.iter().map(|id| (*id).to_owned()).collect();
    want.sort();
    assert_eq!(got, want);
}

#[test]
fn rolling_aliases_do_not_consume_the_existing_versioned_model_allowance() {
    let versions: Vec<Value> = (0..10).map(|at| json!({"provider": "openrouter", "id": format!("vendor/model-{at}"), "created": 1000 + at})).collect();
    let alias = json!({"provider": "openrouter", "id": "vendor/model-latest", "created": 1});
    let mut all = versions.clone();
    all.push(alias.clone());
    let normalized = options::normalize_model_options(&all);
    assert!(normalized.contains(&alias));
    let others: Vec<String> = normalized.iter().filter(|model| **model != alias).map(|model| text(model, "id")).collect();
    let want: Vec<String> = versions.iter().skip(2).rev().map(|model| text(model, "id")).collect();
    assert_eq!(others, want);
}

#[test]
fn anthropic_concrete_family_limits_still_keep_three_opus_versions_and_one_sonnet() {
    let ids = ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-5", "claude-sonnet-5-5"];
    let models: Vec<Value> = ids.iter().map(|id| model("anthropic-oauth", id)).collect();
    let mut got: Vec<String> = options::normalize_model_options(&models).iter().map(|model| text(model, "id")).collect();
    got.sort();
    assert_eq!(got, ["claude-opus-4-7", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
}

#[test]
fn only_a_terminal_latest_alias_marker_bypasses_version_trimming() {
    use mixdog_view_model::display::model_alias::is_rolling_model_alias;
    assert!(is_rolling_model_alias("~google/gemini-flash-latest"));
    assert!(is_rolling_model_alias("mistral-large-latest"));
    assert!(!is_rolling_model_alias("model-latest-preview"));
    assert!(!is_rolling_model_alias("model-latest:batch"));
    assert!(!is_rolling_model_alias(""));
}

const CUSTOM_ID: &str = "custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7";

fn provider_models() -> Vec<Value> {
    vec![json!({"provider": "openai", "id": "gpt-x", "display": "GPT X"}), json!({"provider": CUSTOM_ID, "id": "my-model", "display": "My Model"})]
}

fn label_of(items: &[PanelItem], provider: &str) -> String {
    items.iter().find(|row| row.tag_text("_provider") == provider).expect("the provider row").item.label.clone()
}

#[test]
fn provider_list_names_custom_providers_by_setup_and_falls_back_to_the_raw_id() {
    let models = provider_models();
    assert_eq!(label_of(&options::build_model_provider_items(&models, None, None), CUSTOM_ID), CUSTOM_ID);
    let names = ProviderNames::from([(CUSTOM_ID.to_owned(), "내 AI".to_owned())]);
    let items = options::build_model_provider_items(&models, None, Some(&names));
    assert_eq!(label_of(&items, CUSTOM_ID), "내 AI");
    assert_eq!(label_of(&items, "openai"), options::provider_display_name("openai"));
}

#[test]
fn row_provider_name_names_a_custom_provider_when_setup_is_missing_and_setup_still_wins() {
    let rows = vec![
        json!({"provider": "openai", "id": "gpt-x", "providerName": "Spoof"}),
        json!({"provider": CUSTOM_ID, "id": "my-model", "providerName": "Gateway"}),
    ];
    let mut bare = Fake::new(&json!({}));
    let setup = options::load_provider_display_names(&mut bare);
    let names = options::catalog_provider_display_names(&rows, &setup);
    let items = options::build_model_provider_items(&rows, None, Some(&names));
    assert_eq!(label_of(&items, CUSTOM_ID), "Gateway");
    assert_eq!(label_of(&items, "openai"), options::provider_display_name("openai"));
    let from_setup = ProviderNames::from([(CUSTOM_ID.to_owned(), "내 AI".to_owned())]);
    assert_eq!(options::catalog_provider_display_names(&rows, &from_setup)[CUSTOM_ID], "내 AI");
    let only_id = [json!({"provider": CUSTOM_ID, "id": "m"})];
    assert!(!options::catalog_provider_display_names(&only_id, &ProviderNames::new()).contains_key(CUSTOM_ID));
}

#[test]
fn route_label_names_a_custom_provider_by_its_setup_name_built_ins_by_their_label() {
    let names = ProviderNames::from([(CUSTOM_ID.to_owned(), "내 AI".to_owned())]);
    let first = |label: String| label.split(" \u{b7} ").next().unwrap_or_default().to_owned();
    let custom = json!({"provider": CUSTOM_ID, "model": "my-model"});
    assert_eq!(first(options::route_label(&custom, Some(&names))), "내 AI");
    assert_eq!(first(options::route_label(&custom, None)), CUSTOM_ID);
    assert_eq!(first(options::route_label(&json!({"provider": "openai", "model": "gpt-x"}), Some(&names))), options::provider_display_name("openai"));
}

#[test]
fn a_provider_whose_model_list_failed_gets_a_row_that_says_why_one_with_models_does_not() {
    let setup = json!({
        "api": [
            {"id": "opencode-go", "catalogError": {"message": "opencode-go models 401: This API key has expired.", "errorKind": {"kind": "auth", "code": "api_key_expired", "status": 401}}},
            {"id": "openai", "catalogError": {"message": "openai models 500", "errorKind": {"kind": "transient", "status": 500}}},
            {"id": "xai"},
        ],
        "oauth": [],
        "local": [],
    });
    let mut fake = Fake::new(&json!({"store": {"getProviderSetup": setup}}));
    let failures = options::load_provider_catalog_failures(&mut fake);
    assert_eq!(failures.iter().map(|failure| failure.id.as_str()).collect::<Vec<_>>(), ["opencode-go", "openai"]);
    assert_eq!(failures[0].text, "Provider authentication failed Check your sign-in or API key, then try again.");
    let items = options::build_catalog_failure_items(&failures, &provider_models(), None);
    let rows: Vec<(String, String)> = items.iter().map(|row| (row.item.label.clone(), row.tag_text("_failure").to_owned())).collect();
    assert_eq!(rows, [(options::provider_display_name("opencode-go"), failures[0].text.clone())]);
}

// ---- the model picker

fn efforts() -> Value {
    json!([{"value": "low", "label": "low"}, {"value": "medium", "label": "medium"}, {"value": "high", "label": "high"}])
}

fn claude_x() -> Value {
    json!({
        "provider": "anthropic", "id": "claude-x-1", "display": "Claude X", "effortOptions": efforts(), "fastCapable": true,
        "fastEfforts": ["low", "medium"], "contextWindow": 200_000, "maxContextWindow": 1_000_000,
        "modelParameterOptions": [{"id": "thinking", "label": "Thinking", "options": [{"value": "off", "label": "Off"}, {"value": "on", "label": "On"}]}],
        "defaultModelParameters": {"thinking": "off"},
    })
}

fn claude_plain() -> Value {
    json!({"provider": "anthropic", "id": "claude-plain", "display": "Claude Plain", "contextWindow": 100_000})
}

/// A host with the models cached and `setRoute` answering true, the Node test's `createHarness`.
fn harness(models: Vec<Value>, state: Value) -> Fake {
    Fake::new(&json!({"caches": {"provider": {"models": models, "at": T0}}, "state": state, "store": {"setRoute": true}}))
}

/// Opens the model picker and selects the first provider.
fn open_provider(fake: &mut Fake, options: ModelPickerOptions) {
    open_model_picker(fake, options);
    let first = fake.row(&json!(0)).expect("a provider row");
    let handler = fake.panel().and_then(|panel| panel.handler).expect("a handler");
    handler.on_select(fake, &first);
}

fn press(fake: &mut Fake, what: &str, model_id: &str) {
    let row = fake.row(&json!(model_id));
    let handler = fake.panel().and_then(|panel| panel.handler).expect("a handler");
    match what {
        "left" => handler.on_left(fake, row.as_ref()),
        "right" => handler.on_right(fake, row.as_ref()),
        "tab" => handler.on_tab(fake, row.as_ref()),
        key => handler.on_key(fake, key, row.as_ref()),
    }
}

fn enter(fake: &mut Fake, model_id: &str) {
    fake.select(&json!(model_id));
}

fn last_route(fake: &Fake) -> Value {
    fake.calls.iter().rev().find(|call| call[0] == "setRoute").map(|call| call[1][0].clone()).expect("setRoute was called")
}

#[test]
fn model_list_footer_shows_default_effort_context_fast_and_thinking_lines() {
    let mut fake = harness(vec![claude_x(), claude_plain()], json!({}));
    open_provider(&mut fake, ModelPickerOptions::default());
    assert_eq!(fake.panel().and_then(|panel| panel.picker_key).as_deref(), Some("model-picker:provider-models:anthropic"));
    // Fast is not offered at the default (high) effort, so no Fast line yet.
    assert_eq!(
        fake.footer_texts("claude-x-1"),
        ["High Effort \u{2190}/\u{2192} To Adjust", "20% \u{b7} 200k Context \u{b7} Default \u{b7} C/Shift+C Adjust", "Thinking: Off \u{b7} T Toggle"]
    );
    // No effort, Fast or parameters: only the context line remains.
    assert_eq!(fake.footer_texts("claude-plain"), ["100% \u{b7} 100k Context \u{b7} Default \u{b7} C/Shift+C Adjust"]);
    assert_eq!(fake.row(&json!("claude-x-1")).expect("row").item.marker, "\u{2713}");
}

#[test]
fn left_right_cycle_effort_with_wrap_around_and_fast_follows_the_effort_it_is_allowed_on() {
    let mut fake = harness(vec![claude_x(), claude_plain()], json!({}));
    open_provider(&mut fake, ModelPickerOptions::default());
    press(&mut fake, "right", "claude-x-1");
    assert_eq!(fake.footer_texts("claude-x-1")[0], "Low Effort \u{2190}/\u{2192} To Adjust", "wraps past high");
    press(&mut fake, "left", "claude-x-1");
    press(&mut fake, "left", "claude-x-1");
    assert_eq!(fake.footer_texts("claude-x-1")[0], "Medium Effort \u{2190}/\u{2192} To Adjust");
    press(&mut fake, "tab", "claude-x-1");
    assert_eq!(fake.footer_texts("claude-x-1")[2], "Fast On \u{b7} Tab Toggle");
    press(&mut fake, "right", "claude-x-1");
    assert_eq!(fake.footer_texts("claude-x-1")[0], "High Effort \u{2190}/\u{2192} To Adjust");
    assert_eq!(fake.footer_texts("claude-x-1").len(), 3, "Fast is unavailable at high");
}

fn speed_option() -> Value {
    json!({"id": "serviceTier", "label": "Speed", "kind": "enum", "options": [{"value": "priority", "label": "Fast"}, {"value": "ultrafast", "label": "Ultrafast"}]})
}

fn speed_lines(fake: &Fake, id: &str) -> Vec<String> {
    fake.footer_texts(id).into_iter().filter(|line| line.to_lowercase().contains("fast")).collect()
}

#[test]
fn tab_cycles_standard_fast_ultrafast_standard_when_the_model_offers_ultrafast() {
    let models = vec![json!({"provider": "anthropic", "id": "ultra-1", "display": "Ultra", "fastCapable": true, "modelParameterOptions": [speed_option()]})];
    let mut fake = harness(models.clone(), json!({"model": "other"}));
    open_provider(&mut fake, ModelPickerOptions::default());
    assert_eq!(speed_lines(&fake, "ultra-1"), ["Fast Off \u{b7} Tab Toggle"]);
    press(&mut fake, "tab", "ultra-1");
    assert_eq!(speed_lines(&fake, "ultra-1"), ["Fast On \u{b7} Tab Toggle"]);
    press(&mut fake, "tab", "ultra-1");
    assert_eq!(speed_lines(&fake, "ultra-1"), ["Ultrafast \u{b7} Tab Toggle"]);
    enter(&mut fake, "ultra-1");
    let route = last_route(&fake);
    assert_eq!(route["fast"], true);
    assert_eq!(route["modelParameters"]["serviceTier"], "ultrafast");

    let mut again = harness(models, json!({"model": "other"}));
    open_provider(&mut again, ModelPickerOptions::default());
    for _ in 0..3 {
        press(&mut again, "tab", "ultra-1");
    }
    assert_eq!(speed_lines(&again, "ultra-1"), ["Fast Off \u{b7} Tab Toggle"]);
    enter(&mut again, "ultra-1");
    let route = last_route(&again);
    assert_eq!(route["fast"], false);
    assert!(route["modelParameters"].get("serviceTier").is_none());
}

#[test]
fn tab_keeps_the_plain_on_off_toggle_without_the_ultrafast_option() {
    let models = vec![json!({"provider": "anthropic", "id": "plain-fast", "display": "PF", "fastCapable": true})];
    let mut fake = harness(models, json!({"model": "other"}));
    open_provider(&mut fake, ModelPickerOptions::default());
    press(&mut fake, "tab", "plain-fast");
    assert_eq!(fake.footer_texts("plain-fast"), ["Fast On \u{b7} Tab Toggle"]);
    press(&mut fake, "tab", "plain-fast");
    assert_eq!(fake.footer_texts("plain-fast"), ["Fast Off \u{b7} Tab Toggle"]);
}

#[test]
fn context_steps_in_ten_percent_notches_and_t_cycles_thinking() {
    let mut fake = harness(vec![claude_x(), claude_plain()], json!({}));
    open_provider(&mut fake, ModelPickerOptions::default());
    press(&mut fake, "c", "claude-x-1");
    press(&mut fake, "c", "claude-x-1");
    assert_eq!(fake.footer_texts("claude-x-1")[1], "40% \u{b7} 400k Context \u{b7} C/Shift+C Adjust");
    press(&mut fake, "C", "claude-x-1");
    assert_eq!(fake.footer_texts("claude-x-1")[1], "30% \u{b7} 300k Context \u{b7} C/Shift+C Adjust");
    press(&mut fake, "t", "claude-x-1");
    assert_eq!(fake.footer_texts("claude-x-1")[2], "Thinking: On \u{b7} T Toggle");
    press(&mut fake, "t", "claude-plain");
    assert_eq!(fake.footer_texts("claude-plain"), ["100% \u{b7} 100k Context \u{b7} Default \u{b7} C/Shift+C Adjust"]);
}

#[test]
fn enter_saves_the_selected_route_through_set_route_and_hands_the_surface_back() {
    let mut fake = harness(vec![claude_x(), claude_plain()], json!({}));
    let after_events = Rc::clone(&fake.events);
    let after: PickerFn = log_fn(&after_events, json!(["back"]));
    open_provider(&mut fake, ModelPickerOptions { on_after_select: Some(after), ..ModelPickerOptions::default() });
    press(&mut fake, "right", "claude-x-1");
    press(&mut fake, "tab", "claude-x-1");
    press(&mut fake, "c", "claude-x-1");
    enter(&mut fake, "claude-x-1");
    let routes: Vec<&Value> = fake.calls.iter().filter(|call| call[0] == "setRoute").map(|call| &call[1][0]).collect();
    assert_eq!(
        routes,
        [&json!({"provider": "anthropic", "model": "claude-x-1", "effort": "low", "contextPercent": 30, "fast": true, "modelParameters": {"thinking": "off"}})]
    );
    assert_eq!(*fake.events.borrow().last().expect("an event"), json!(["back"]));
    assert_eq!(fake.notices.last(), Some(&json!(["Model saved \u{b7} new sessions", "info"])));
    assert_eq!(fake.caches.entry(CatalogKind::Provider).at, 0, "catalog marked stale after a save");

    open_provider(&mut fake, ModelPickerOptions::default());
    enter(&mut fake, "claude-plain");
    assert_eq!(last_route(&fake), json!({"provider": "anthropic", "model": "claude-plain", "contextPercent": 100}));
}

#[test]
fn a_caller_owned_save_goes_through_on_select_route_and_reports_its_failure() {
    let mut fake = harness(vec![claude_x(), claude_plain()], json!({}));
    let saved: Rc<RefCell<Vec<(String, String, Option<String>)>>> = Rc::default();
    let log = Rc::clone(&saved);
    let on_select_route: SelectRoute = Rc::new(move |_host: &mut dyn PickerHost, route: &Value, picked: &Value, effort: &Option<String>| {
        log.borrow_mut().push((text(route, "model"), text(picked, "id"), effort.clone()));
        Err("disk full".to_owned())
    });
    let options = ModelPickerOptions {
        on_select_route: Some(on_select_route),
        current_route: Some(json!({"provider": "anthropic", "model": "claude-x-1", "effort": "medium", "fast": true})),
        ..ModelPickerOptions::default()
    };
    open_provider(&mut fake, options);
    assert_eq!(fake.footer_texts("claude-x-1")[0], "Medium Effort \u{2190}/\u{2192} To Adjust", "currentRoute seeds the effort");
    assert_eq!(fake.footer_texts("claude-x-1")[2], "Fast On \u{b7} Tab Toggle");
    enter(&mut fake, "claude-x-1");
    assert_eq!(*saved.borrow(), [("claude-x-1".to_owned(), "claude-x-1".to_owned(), Some("medium".to_owned()))]);
    assert!(fake.calls.iter().all(|call| call[0] != "setRoute"));
    assert_eq!(fake.notices.last(), Some(&json!(["Couldn\u{2019}t save model: disk full", "error"])));
}

#[test]
fn esc_on_the_model_list_returns_to_the_provider_list_or_to_the_caller_when_nested() {
    let mut fake = harness(vec![claude_x(), claude_plain()], json!({}));
    open_provider(&mut fake, ModelPickerOptions::default());
    fake.cancel();
    assert_eq!(fake.panel().and_then(|panel| panel.picker_key).as_deref(), Some("model-picker:providers:anthropic"));

    let mut nested = harness(vec![claude_x(), claude_plain()], json!({}));
    let returned = log_fn(&nested.events, json!(["returned"]));
    open_provider(
        &mut nested,
        ModelPickerOptions { return_to: Some(returned), return_on_nested_cancel: true, return_label: Some("Agents".to_owned()), ..ModelPickerOptions::default() },
    );
    assert!(nested.panel().and_then(|panel| panel.help).expect("help").ends_with("Esc Agents"));
    // The open cleared the text prompts (`setProviderPrompt(null)`, `setSettingsPrompt(null)`); the Esc only returns.
    nested.events.borrow_mut().clear();
    nested.cancel();
    assert_eq!(*nested.events.borrow(), [json!(["returned"])]);
}

#[test]
fn r_cycles_open_router_routing_through_its_four_values_and_enter_saves_provider_sort() {
    let routing = json!({"id": "providerSort", "label": "Routing", "kind": "enum", "options": [
        {"value": "auto", "label": "Auto"}, {"value": "price", "label": "Price first"},
        {"value": "throughput", "label": "Speed first"}, {"value": "latency", "label": "Latency first"}]});
    let models = vec![
        json!({"provider": "anthropic", "id": "or-1", "display": "OR", "modelParameterOptions": [routing]}),
        json!({"provider": "anthropic", "id": "plain-1", "display": "Plain"}),
    ];
    let mut fake = harness(models, json!({"model": "other"}));
    open_provider(&mut fake, ModelPickerOptions::default());
    let routing_line = |fake: &Fake| fake.footer_texts("or-1").into_iter().find(|line| line.starts_with("Routing")).unwrap_or_default();
    assert_eq!(routing_line(&fake), "Routing: Auto \u{b7} R Cycle");
    let mut labels = Vec::new();
    for _ in 0..4 {
        press(&mut fake, "r", "or-1");
        labels.push(routing_line(&fake));
    }
    assert_eq!(
        labels,
        ["Routing: Price first \u{b7} R Cycle", "Routing: Speed first \u{b7} R Cycle", "Routing: Latency first \u{b7} R Cycle", "Routing: Auto \u{b7} R Cycle"]
    );
    press(&mut fake, "R", "or-1");
    // A row without the option shows no Routing line and R does nothing.
    press(&mut fake, "r", "plain-1");
    assert!(!fake.footer_texts("plain-1").iter().any(|line| line.starts_with("Routing")));
    enter(&mut fake, "or-1");
    assert_eq!(last_route(&fake)["modelParameters"]["providerSort"], "price");
}

// ---- the workflow picker

#[test]
fn workflow_help_returns_to_back_standalone_and_settings_when_a_caller_is_provided() {
    for (with_return, help) in [(false, "\u{2191}/\u{2193} Select \u{b7} Enter Choose \u{b7} Esc Back"), (true, "\u{2191}/\u{2193} Select \u{b7} Enter Choose \u{b7} Esc Settings")] {
        let mut fake = Fake::new(&json!({"store": {"listWorkflows": [{"id": "solo", "name": "Solo"}]}}));
        let return_to: Option<PickerFn> = with_return.then(|| log_fn(&fake.events, json!(["returned"])));
        open_workflow_picker(&mut fake, WorkflowOptions { return_to, handoff_panel: None });
        assert_eq!(fake.panel().and_then(|panel| panel.help).as_deref(), Some(help));
    }
}

#[test]
fn an_esc_before_the_workflow_switch_acks_cancels_the_hop_back() {
    let mut fake = Fake::new(&json!({"store": {"listWorkflows": [{"id": "team", "name": "Team"}], "setWorkflow": {"id": "team"}}}));
    let return_to = log_fn(&fake.events, json!(["returned"]));
    open_workflow_picker(&mut fake, WorkflowOptions { return_to: Some(return_to), handoff_panel: None });
    fake.supersede_next = true;
    fake.select(&json!("team"));
    assert!(fake.events.borrow().iter().all(|event| event != &json!(["returned"])));
    assert_eq!(fake.notices.last(), Some(&json!(["Workflow saved \u{b7} new sessions", "info"])));
}

#[test]
fn panels_report_the_identity_the_surface_keys_on() {
    let mut fake = Fake::new(&json!({"store": {"listWorkflows": [{"id": "solo", "name": "Solo"}]}}));
    open_workflow_picker(&mut fake, WorkflowOptions::default());
    let panel = fake.panel().expect("a panel");
    assert_eq!(PanelValue::title(&panel), "Workflow");
    assert_eq!(PanelValue::kind(&panel), "");
    // The widget props carry the rows, the widths and the confirm bar the panel asked for.
    let props = panel.props(100);
    assert_eq!(props.items.len(), 1);
    assert_eq!(props.label_width, Some(18));
    assert!(!props.adjustable);
}

// ---- the catalog cache

#[test]
fn the_warm_up_fills_empty_caches_and_a_provider_clear_makes_a_stale_listing_drop() {
    use mixdog_tui::pickers::model::catalog::prefetch_catalogs;
    let mut fake = Fake::new(&json!({"store": {"listProviderModels": [claude_x()], "listWebSearchModels": [claude_plain()]}}));
    prefetch_catalogs(&mut fake);
    assert_eq!(fake.caches.entry(CatalogKind::Provider).models.as_ref().map(Vec::len), Some(1));
    assert_eq!(fake.caches.entry(CatalogKind::WebSearch).models.as_ref().map(Vec::len), Some(1));
    // A cache that already holds rows is left alone.
    fake.script.insert("listProviderModels".to_owned(), json!([claude_x(), claude_plain()]));
    prefetch_catalogs(&mut fake);
    assert_eq!(fake.caches.entry(CatalogKind::Provider).models.as_ref().map(Vec::len), Some(1));
    assert!(fake.caches.clear("provider"));
    assert!(fake.caches.entry(CatalogKind::Provider).models.is_none());
    assert!(fake.caches.entry(CatalogKind::WebSearch).models.is_some(), "the provider scope leaves the web-search cache");
    assert!(!fake.caches.clear("webSearch"));
    assert!(fake.caches.entry(CatalogKind::WebSearch).models.is_none());
}

#[cfg(node_twin)]
#[path = "node-twin/pickers_model.rs"]
mod node_twin;
