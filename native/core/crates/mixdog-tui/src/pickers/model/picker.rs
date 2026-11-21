use std::cell::RefCell;
use std::rc::Rc;

use mixdog_tui_widgets::picker::IndexMode;
use serde_json::{Value, json};

use super::catalog::{CatalogKind, load_catalog, schedule_background_refresh};
use super::footer::model_footer;
use super::options::{
    CatalogFailure, ProviderNames, build_catalog_failure_items, build_model_provider_items, build_provider_model_items, catalog_provider_display_names,
    load_provider_catalog_failures, load_provider_display_names, normalize_model_options, resolve_provider_display_name,
};
use super::selection::RouteSelection;
use crate::pickers::common::{Own, PanelItem, PickerFn, PickerHandler, PickerHost, PickerPanel, ProviderSetupRequest, RouteState};
use crate::slash::host::Tone;
use crate::slash::notices::model_switch_notice;
use crate::surface::SurfaceKind;

/// `MODEL_LIST_HELP`.
const MODEL_LIST_HELP: &str =
    "\u{2191}/\u{2193} Select \u{b7} \u{2190}/\u{2192} Effort \u{b7} C/Shift+C Context \u{b7} Tab Fast \u{b7} T Thinking \u{b7} R Routing \u{b7} Enter Save";

/// A caller-owned save (`options.onSelectRoute(routeInput, selected, effort)`): its error is reported as a failed save.
pub type SelectRoute = Rc<dyn Fn(&mut dyn PickerHost, &Value, &Value, &Option<String>) -> Result<Value, String>>;

/// `options.onImmediateSelect(routeInput)`: what the keypress that chose a route paints on the spot.
pub type ImmediateSelect = Rc<dyn Fn(&mut dyn PickerHost, &Value)>;

/// The options of `openModelPicker(options)`.
#[derive(Clone, Default)]
pub struct ModelPickerOptions {
    pub title: Option<String>,
    pub loading_description: Option<String>,
    pub provider_description: Option<String>,
    pub model_description: Option<String>,
    pub empty_notice: Option<String>,
    /// Which catalog and cache the rows come from.
    pub catalog: CatalogKind,
    /// Force a fresh listing (`/agents refresh`, `/model refresh`).
    pub refresh_models: bool,
    /// The route the rows are marked and seeded from (an agent's or the web search route); the live state when `None`.
    pub current_route: Option<Value>,
    pub return_to: Option<PickerFn>,
    pub return_label: Option<String>,
    pub return_on_nested_cancel: bool,
    /// The panel painted when a selection hands the surface back (`None` clears the picker).
    pub handoff_panel: Option<PickerPanel>,
    pub on_select_route: Option<SelectRoute>,
    pub on_immediate_select: Option<ImmediateSelect>,
    pub on_after_select: Option<PickerFn>,
}

fn non_empty(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|text| !text.is_empty())
}

/// The part of one open every panel of it shares (`view`).
struct Session {
    options: ModelPickerOptions,
    state: RouteState,
    models: Vec<Value>,
    active_route: Value,
    provider_names: ProviderNames,
    failures: Vec<CatalogFailure>,
    return_label: String,
    own: Rc<Own>,
    /// `providerListHighlightProvider`: the provider the list highlights when it is painted again.
    list_highlight: RefCell<Option<String>>,
}

impl Session {
    fn title(&self) -> &str {
        non_empty(&self.options.title).unwrap_or("Model")
    }

    fn list_help(&self) -> String {
        list_help(&self.options, &self.return_label)
    }

    /// `cancelModelPicker()`: back to the caller, else the picker closes.
    fn cancel(&self, host: &mut dyn PickerHost) {
        cancel_picker(host, &self.own, self.options.return_to.as_ref());
    }
}

fn list_help(options: &ModelPickerOptions, return_label: &str) -> String {
    if options.return_to.is_some() {
        format!("\u{2191}/\u{2193} Select \u{b7} Enter Open \u{b7} Esc {return_label}")
    } else {
        "\u{2191}/\u{2193} Select \u{b7} Enter Open \u{b7} Esc Back".to_owned()
    }
}

fn cancel_picker(host: &mut dyn PickerHost, own: &Own, return_to: Option<&PickerFn>) {
    match return_to {
        Some(return_to) => return_to(host),
        None => own.close(host),
    }
}

/// The loading frame answers Esc as the picker does.
struct LoadingHandler {
    own: Rc<Own>,
    return_to: Option<PickerFn>,
}

impl PickerHandler for LoadingHandler {
    fn on_cancel(&self, host: &mut dyn PickerHost) {
        cancel_picker(host, &self.own, self.return_to.as_ref());
    }
}

/// `openModelPicker(options)`.
pub fn open_model_picker(host: &mut dyn PickerHost, options: ModelPickerOptions) {
    let state = host.route_state();
    let own = Rc::new(Own::new(host.claim_surface(SurfaceKind::Picker)));
    host.clear_prompts();
    host.model_caches().request_seq += 1;
    let return_label = non_empty(&options.return_label).unwrap_or("Agents").to_owned();
    let help = list_help(&options, &return_label);
    let loading = |own: &Rc<Own>| {
        let mut panel = PickerPanel::new(non_empty(&options.title).unwrap_or("Model"));
        panel.description = non_empty(&options.loading_description).unwrap_or("Loading models...").to_owned();
        panel.help = Some(help.clone());
        panel.loading = true;
        panel.handler = Some(Rc::new(LoadingHandler { own: Rc::clone(own), return_to: options.return_to.clone() }));
        panel
    };
    let loaded = load_catalog(host, &options, &mut |host| {
        own.paint(host, Some(loading(&own)));
    });
    let Some(loaded) = loaded else { return };
    if loaded.models.is_empty() {
        host.push_notice(non_empty(&options.empty_notice).unwrap_or("no provider models available; open /providers to sign in"), Tone::Warn);
        // Delegation is a paint by proxy: the empty-catalog fallback opens Providers, so it must prove ownership exactly like
        // paint().
        if !own.owns(host) {
            return;
        }
        let retry = options.clone();
        host.open_provider_setup(ProviderSetupRequest {
            title: "Providers".to_owned(),
            continue_label: "Back to model setup".to_owned(),
            continue_description: "retry model list after provider auth".to_owned(),
            on_continue: Rc::new(move |host: &mut dyn PickerHost| open_model_picker(host, retry.clone())),
        });
        return;
    }
    let models = normalize_model_options(&loaded.models);
    let provider_names = catalog_provider_display_names(&models, &load_provider_display_names(host));
    let failures = load_provider_catalog_failures(host);
    let active_route = options.current_route.clone().unwrap_or_else(|| {
        json!({
            "provider": state.provider,
            "model": state.model,
            "effort": state.effort,
            "fast": state.fast,
            "modelParameters": state.model_parameters,
            "contextPercent": state.context_percent,
        })
    });
    let session = Rc::new(Session { options, state, models, active_route, provider_names, failures, return_label, own, list_highlight: RefCell::new(None) });
    render_provider_list(host, &session, None);
    schedule_background_refresh(host, &loaded);
}

/// `renderProviderList`: the provider rows, then the failed providers that have no rows.
fn render_provider_list(host: &mut dyn PickerHost, session: &Rc<Session>, highlight_provider: Option<&str>) {
    if let Some(provider) = highlight_provider {
        *session.list_highlight.borrow_mut() = Some(provider.to_owned());
    }
    let remembered = session.list_highlight.borrow().clone();
    let highlight = highlight_provider.map(str::to_owned).or(remembered);
    let mut items = build_model_provider_items(&session.models, Some(&session.active_route), Some(&session.provider_names));
    items.extend(build_catalog_failure_items(&session.failures, &session.models, Some(&session.provider_names)));
    let active_provider = session.active_route.get("provider").and_then(Value::as_str).filter(|text| !text.is_empty());
    let provider_highlight = highlight.filter(|text| !text.is_empty()).or_else(|| active_provider.map(str::to_owned));
    let initial = items.iter().position(|item| provider_highlight.as_deref().is_some_and(|provider| item.tag_text("_provider") == provider)).unwrap_or(0);
    let mut panel = PickerPanel::new(session.title());
    panel.description = non_empty(&session.options.provider_description).unwrap_or("Choose a provider.").to_owned();
    panel.help = Some(session.list_help());
    panel.index_mode = Some(IndexMode::Always);
    panel.label_width = Some(18);
    panel.meta_width = Some(20);
    panel.initial_index = Some(initial);
    panel.picker_key = Some(format!("model-picker:providers:{}", provider_highlight.as_deref().unwrap_or("default")));
    panel.items = items;
    panel.handler = Some(Rc::new(ProviderListHandler { session: Rc::clone(session) }));
    session.own.paint(host, Some(panel));
}

struct ProviderListHandler {
    session: Rc<Session>,
}

impl PickerHandler for ProviderListHandler {
    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        if let Some(failure) = item.tag("_failure").and_then(Value::as_str) {
            host.push_notice(&format!("{}: {failure}", item.item.label), Tone::Warn);
            return;
        }
        let provider = item.tag_text("_provider");
        if provider.is_empty() {
            return;
        }
        open_provider_models_picker(host, &self.session, provider);
    }

    fn on_highlight(&self, _host: &mut dyn PickerHost, item: &PanelItem) {
        let provider = item.tag_text("_provider");
        if !provider.is_empty() {
            *self.session.list_highlight.borrow_mut() = Some(provider.to_owned());
        }
    }

    fn wants_highlight(&self) -> bool {
        true
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        self.session.cancel(host);
    }
}

fn save_selected_route(host: &mut dyn PickerHost, session: &Session, selected: &Value, route_input: &Value, effort: &Option<String>) {
    let options = &session.options;
    if let Some(on_select_route) = &options.on_select_route {
        match &options.on_immediate_select {
            Some(immediate) => immediate(host, route_input),
            None => {
                session.own.paint(host, options.handoff_panel.clone());
            }
        }
        hand_back_surface(host, options);
        host.model_caches().mark_stale();
        if let Err(error) = on_select_route(host, route_input, selected, effort) {
            host.push_notice(&format!("Couldn\u{2019}t save model: {error}"), Tone::Error);
        }
        return;
    }
    session.own.paint(host, options.handoff_panel.clone());
    hand_back_surface(host, options);
    host.model_caches().mark_stale();
    host.push_notice(&model_switch_notice(), Tone::Info);
    match host.store_call("setRoute", json!([route_input])) {
        Ok(Value::Bool(false)) => host.push_notice("Model switch is already running", Tone::Warn),
        Ok(_) => {}
        Err(error) => host.push_notice(&format!("Couldn\u{2019}t switch model: {error}"), Tone::Error),
    }
}

fn hand_back_surface(host: &mut dyn PickerHost, options: &ModelPickerOptions) {
    if let Some(after) = &options.on_after_select {
        after(host);
    }
}

/// `openProviderModelsPicker`: paints the provider's model list.
fn open_provider_models_picker(host: &mut dyn PickerHost, session: &Rc<Session>, provider: &str) {
    let provider_models: Vec<Value> = session.models.iter().filter(|model| model.get("provider").and_then(Value::as_str) == Some(provider)).cloned().collect();
    let selection = Rc::new(RefCell::new(RouteSelection::new(provider_models, session.state.clone(), session.options.current_route.clone())));
    render_models(host, session, provider, &selection);
}

fn render_models(host: &mut dyn PickerHost, session: &Rc<Session>, provider: &str, selection: &Rc<RefCell<RouteSelection>>) {
    let options = &session.options;
    let items = build_provider_model_items(&session.models, provider, Some(&session.active_route));
    let active = |key: &str| session.active_route.get(key).and_then(Value::as_str).unwrap_or_default();
    let initial = items.iter().position(|item| item.tag_text("_provider") == active("provider") && item.tag_text("_modelId") == active("model")).unwrap_or(0);
    let mut panel = PickerPanel::new(&resolve_provider_display_name(provider, Some(&session.provider_names)));
    panel.description = non_empty(&options.model_description).unwrap_or("Select a model. Adjust Effort with \u{2190}/\u{2192}.").to_owned();
    let footer_selection = Rc::clone(selection);
    panel.footer = Some(Rc::new(move |item: Option<&PanelItem>| model_footer(&mut footer_selection.borrow_mut(), item.and_then(|item| item.tag("_model")))));
    panel.help = Some(if options.return_on_nested_cancel && options.return_to.is_some() {
        format!("{MODEL_LIST_HELP} \u{b7} Esc {}", session.return_label)
    } else {
        format!("{MODEL_LIST_HELP} \u{b7} Esc Back")
    });
    panel.index_mode = Some(IndexMode::Always);
    panel.initial_index = Some(initial);
    panel.picker_key = Some(format!("model-picker:provider-models:{provider}"));
    panel.items = items;
    panel.handler = Some(Rc::new(ModelListHandler { session: Rc::clone(session), provider: provider.to_owned(), selection: Rc::clone(selection) }));
    session.own.paint(host, Some(panel));
}

struct ModelListHandler {
    session: Rc<Session>,
    provider: String,
    selection: Rc<RefCell<RouteSelection>>,
}

impl ModelListHandler {
    fn repaint(&self, host: &mut dyn PickerHost) {
        render_models(host, &self.session, &self.provider, &self.selection);
    }
}

impl PickerHandler for ModelListHandler {
    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        let selected = item.tag("_model").cloned().or_else(|| {
            let (provider, id) = (item.tag_text("_provider"), item.tag_text("_modelId"));
            self.session
                .models
                .iter()
                .find(|model| model.get("provider").and_then(Value::as_str) == Some(provider) && model.get("id").and_then(Value::as_str) == Some(id))
                .cloned()
        });
        let Some(selected) = selected else { return };
        let (effort, route_input) = self.selection.borrow_mut().route_input_for(&selected);
        save_selected_route(host, &self.session, &selected, &route_input, &effort);
    }

    fn on_left(&self, host: &mut dyn PickerHost, item: Option<&PanelItem>) {
        if let Some(model) = item.and_then(|item| item.tag("_model")) {
            if self.selection.borrow_mut().cycle_effort(model, -1) {
                self.repaint(host);
            }
        }
    }

    fn on_right(&self, host: &mut dyn PickerHost, item: Option<&PanelItem>) {
        if let Some(model) = item.and_then(|item| item.tag("_model")) {
            if self.selection.borrow_mut().cycle_effort(model, 1) {
                self.repaint(host);
            }
        }
    }

    fn on_tab(&self, host: &mut dyn PickerHost, item: Option<&PanelItem>) {
        if let Some(model) = item.and_then(|item| item.tag("_model")) {
            if self.selection.borrow_mut().toggle_fast(model) {
                self.repaint(host);
            }
        }
    }

    fn on_key(&self, host: &mut dyn PickerHost, input: &str, item: Option<&PanelItem>) {
        let Some(model) = item.and_then(|item| item.tag("_model")) else { return };
        let changed = match input {
            "c" | "C" => self.selection.borrow_mut().step_context(model, if input == "C" { -1 } else { 1 }),
            "r" | "R" => self.selection.borrow_mut().cycle_routing(model),
            "t" | "T" => self.selection.borrow_mut().cycle_thinking(model),
            _ => return,
        };
        if changed {
            self.repaint(host);
        }
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        if self.session.options.return_on_nested_cancel && self.session.options.return_to.is_some() {
            self.session.cancel(host);
        } else {
            render_provider_list(host, &self.session, Some(&self.provider));
        }
    }

    fn adjustable(&self) -> bool {
        true
    }
}
