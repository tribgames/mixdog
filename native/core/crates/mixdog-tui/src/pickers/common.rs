//! What the pickers share: the panel a picker paints ([`PickerPanel`], rows with the data they stand for), the handler that
//! answers its keys ([`PickerHandler`]), the claim a picker holds ([`Own`]) and the application's side of them
//! ([`PickerHost`]).
//!
//! The Node pickers were factories over an injected `deps` bag: a `surface` whose claim proves ownership, the prompt setters,
//! `closeUsagePanel`, `store`, live state and the model catalog caches. Their panels carried closures (`onSelect`,
//! `onLeft`, `onCancel`, ...). Here a panel carries one [`PickerHandler`], the closures' shared state, and the host answers the
//! calls the closures made. A paint answers the claim it re-armed (a paint can itself be the handover), and a deferred
//! callback runs only while the claim it was bound to still owns the surface.
//!
//! The store's calls are blocking ([`AppCtx::store_call`]); a host that serves them off the UI thread runs the picker
//! function from the task that owns the result, and the claim checks drop the result of a surface the user left meanwhile.

use std::cell::Cell;
use std::rc::Rc;

use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::confirm_bar::ConfirmButton;
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_tui_widgets::picker::{Footer, IndexMode, PickerItem, PickerProps};
use serde_json::Value;

use super::model::catalog::{CatalogRefresh, ModelCatalogCaches};
use crate::app::AppCtx;
use crate::slash::host::Tone;
use crate::surface::SurfaceClaim;
use crate::surface::epoch::PanelValue;
use crate::surface::latch::IndexModePanel;

/// A row of a picker panel: the widget row and the data the Node row carried beside it (`_action`, `_provider`, `_modelId`,
/// `_model`, `_failure`, `_agent`, `_style`, `_workflow`, `_theme`), an object or `Null`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PanelItem {
    pub item: PickerItem,
    pub data: Value,
}

impl PanelItem {
    pub fn new(item: PickerItem, data: Value) -> Self {
        Self { item, data }
    }

    /// The data field `key` (`item._model`), absent for `null`.
    pub fn tag(&self, key: &str) -> Option<&Value> {
        self.data.get(key).filter(|value| !value.is_null())
    }

    /// The data field `key` as text, empty when absent or not text.
    pub fn tag_text(&self, key: &str) -> &str {
        self.tag(key).and_then(Value::as_str).unwrap_or("")
    }
}

/// A caller's continuation (`returnTo`, `onAfterSelect`, a deferred hop): run against the host when it is due.
pub type PickerFn = Rc<dyn Fn(&mut dyn PickerHost)>;

/// The footer under the highlighted row.
pub type FooterFn = Rc<dyn Fn(Option<&PanelItem>) -> Vec<FooterInput>>;

/// The onboarding confirm bar (`confirmBar: { buttons, onConfirm }`); the handler's [`PickerHandler::on_confirm`] answers it.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ConfirmSpec {
    pub buttons: Vec<ConfirmButton>,
}

impl ConfirmSpec {
    /// The Back and Next buttons of the onboarding steps.
    pub fn back_next() -> Self {
        Self { buttons: vec![ConfirmButton::new("back", "\u{25c0} Back"), ConfirmButton::new("next", "Next \u{25b6}")] }
    }
}

/// A caller's own confirm bar (`options.confirmBar`): its buttons and what Enter on one does (the button's `value`).
#[derive(Clone)]
pub struct CallerConfirm {
    pub buttons: Vec<ConfirmButton>,
    pub on_confirm: Rc<dyn Fn(&mut dyn PickerHost, &str)>,
}

/// The onboarding wizard's hooks (`options.onboarding`): where the picker goes on Next, Back and Esc.
#[derive(Clone, Default)]
pub struct Onboarding {
    pub on_advance: Option<PickerFn>,
    pub on_back: Option<PickerFn>,
    pub on_cancel: Option<PickerFn>,
}

impl Onboarding {
    /// `onboarding.onAdvance?.()`.
    pub fn advance(&self, host: &mut dyn PickerHost) {
        if let Some(advance) = &self.on_advance {
            advance(host);
        }
    }

    /// `onboarding.onBack?.()`.
    pub fn back(&self, host: &mut dyn PickerHost) {
        if let Some(back) = &self.on_back {
            back(host);
        }
    }

    /// `onboarding.onCancel?.()`.
    pub fn cancel(&self, host: &mut dyn PickerHost) {
        if let Some(cancel) = &self.on_cancel {
            cancel(host);
        }
    }
}

/// What a panel's keys do. Every method defaults to nothing, as an absent Node callback did; `item` is the highlighted row.
pub trait PickerHandler {
    /// Enter on a row (`onSelect(value, item)`).
    fn on_select(&self, _host: &mut dyn PickerHost, _item: &PanelItem) {}
    /// The highlight moved onto `item` (`onHighlight`).
    fn on_highlight(&self, _host: &mut dyn PickerHost, _item: &PanelItem) {}
    /// Left (`onLeft`).
    fn on_left(&self, _host: &mut dyn PickerHost, _item: Option<&PanelItem>) {}
    /// Right (`onRight`).
    fn on_right(&self, _host: &mut dyn PickerHost, _item: Option<&PanelItem>) {}
    /// Tab (`onTab`).
    fn on_tab(&self, _host: &mut dyn PickerHost, _item: Option<&PanelItem>) {}
    /// Any other typed key (`onKey(input, key, item)`).
    fn on_key(&self, _host: &mut dyn PickerHost, _input: &str, _item: Option<&PanelItem>) {}
    /// Esc (`onCancel`).
    fn on_cancel(&self, _host: &mut dyn PickerHost) {}
    /// Enter on a confirm-bar button (`confirmBar.onConfirm(button)`), the button's `value`.
    fn on_confirm(&self, _host: &mut dyn PickerHost, _button: &str) {}
    /// Whether the panel answers left, right or tab (the help line then says `←/→ Adjust`).
    fn adjustable(&self) -> bool {
        false
    }
    /// Whether the view reports highlight moves through [`PickerHandler::on_highlight`].
    fn wants_highlight(&self) -> bool {
        false
    }
}

/// The picker panel (`setPicker(panel)`): what the surface holds and the view paints.
#[derive(Clone, Default)]
pub struct PickerPanel {
    /// The identity a rebuild of the same panel keeps (`_kind`); the title when empty.
    pub kind: String,
    pub title: String,
    pub description: String,
    pub help: Option<String>,
    pub items: Vec<PanelItem>,
    pub index_mode: Option<IndexMode>,
    pub initial_index: Option<usize>,
    /// `pickerKey`: a new key resets the selection state of the view.
    pub picker_key: Option<String>,
    pub label_width: Option<usize>,
    pub meta_width: Option<usize>,
    pub loading: bool,
    pub footer: Option<FooterFn>,
    pub confirm: Option<ConfirmSpec>,
    pub handler: Option<Rc<dyn PickerHandler>>,
}

impl std::fmt::Debug for PickerPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PickerPanel")
            .field("title", &self.title)
            .field("picker_key", &self.picker_key)
            .field("items", &self.items.len())
            .field("loading", &self.loading)
            .finish_non_exhaustive()
    }
}

impl PickerPanel {
    pub fn new(title: &str) -> Self {
        Self { title: title.to_owned(), ..Self::default() }
    }

    /// The widget props at `columns`: the rows, the footer of the highlighted row, the confirm bar and whether the owner
    /// adjusts with left, right or tab.
    pub fn props(&self, columns: usize) -> PickerProps {
        let rows: Vec<PickerItem> = self.items.iter().map(|row| row.item.clone()).collect();
        let mut props = PickerProps::new(rows, &self.title);
        props.description.clone_from(&self.description);
        props.help.clone_from(&self.help);
        props.columns = columns;
        props.label_width = self.label_width;
        props.meta_width = self.meta_width;
        props.index_mode = self.index_mode.unwrap_or_default();
        props.loading = self.loading;
        props.confirm_buttons = self.confirm.as_ref().map(|spec| spec.buttons.clone()).unwrap_or_default();
        props.adjustable = self.handler.as_ref().is_some_and(|handler| handler.adjustable());
        if let Some(footer) = &self.footer {
            let footer = Rc::clone(footer);
            let items = self.items.clone();
            props.footer = Footer::ByItem(Box::new(move |_, index| footer(items.get(index))));
        }
        props
    }
}

impl PanelValue for PickerPanel {
    fn kind(&self) -> &str {
        &self.kind
    }

    fn title(&self) -> &str {
        &self.title
    }
}

impl IndexModePanel for PickerPanel {
    fn index_mode(&self) -> Option<IndexMode> {
        self.index_mode
    }

    fn with_index_mode(mut self, mode: IndexMode) -> Self {
        self.index_mode = Some(mode);
        self
    }
}

/// The part of the application state the route pickers read (`getState()`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RouteState {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub fast: Option<bool>,
    pub model_parameters: Value,
    pub context_percent: Value,
    /// `state.effortOptions`.
    pub effort_options: Vec<Value>,
    /// A turn is running.
    pub busy: bool,
}

/// What `openProviderSetupPicker` is asked for when the catalog is empty.
#[derive(Clone)]
pub struct ProviderSetupRequest {
    pub title: String,
    pub continue_label: String,
    pub continue_description: String,
    pub on_continue: PickerFn,
}

/// The application's side of the pickers.
pub trait PickerHost: AppCtx {
    /// `store.pushNotice(text, tone)`.
    fn push_notice(&mut self, text: &str, tone: Tone);
    /// `Date.now()`.
    fn now_ms(&self) -> u64;
    /// `getState()`.
    fn route_state(&self) -> RouteState;
    /// `setProviderPrompt(null); setSettingsPrompt(null)`.
    fn clear_prompts(&mut self);
    /// `own.context(null)`: the context panel closes. Clearing it hands the surface back exactly as closing a picker does (the
    /// epoch is superseded), and the claim is re-armed on what it just took: answers the re-armed claim, or `None` when `claim`
    /// no longer holds.
    fn clear_context_panel(&mut self, claim: SurfaceClaim) -> Option<SurfaceClaim>;
    /// `closeUsagePanel()`.
    fn close_usage_panel(&mut self);
    /// `own.owns()`.
    fn owns_surface(&self, claim: SurfaceClaim) -> bool;
    /// `own.close()`: the picker clears and ownership is handed back for good.
    fn close_surface(&mut self, claim: SurfaceClaim);
    /// `own.paint(panel)`: a guarded write of the picker (`None` clears it and keeps the flow). Answers the claim the paint
    /// re-armed, or `None` when `claim` no longer holds and nothing was painted.
    fn paint_picker(&mut self, claim: SurfaceClaim, panel: Option<PickerPanel>) -> Option<SurfaceClaim>;
    /// The model catalog caches (`providerModelsCacheRef`, `webSearchModelsCacheRef`, `modelPickerRequestRef`).
    fn model_caches(&mut self) -> &mut ModelCatalogCaches;
    /// Runs `job` later, off the open that asked for it ([`super::model::catalog::run_catalog_refresh`]).
    fn schedule_catalog_refresh(&mut self, job: CatalogRefresh);
    /// `openProviderSetupPicker(request)`.
    fn open_provider_setup(&mut self, request: ProviderSetupRequest);
}

/// `pickerHelp(onboarding, returnTo, base)`: the help line; onboarding leaves it to the confirm bar.
pub fn picker_help(onboarding: bool, has_return: bool, base: &str) -> Option<String> {
    if onboarding {
        return None;
    }
    Some(format!("{base} \u{b7} {}", if has_return { "Esc Settings" } else { "Esc Back" }))
}

/// A row with the check mark in the success colour (`marker: x ? '✓' : '', markerColor: theme.success`).
pub fn check_row(value: &str, label: &str, current: bool) -> PickerItem {
    let mut item = PickerItem::new(value, label);
    item.marker = if current { "\u{2713}".to_owned() } else { String::new() };
    item.marker_color = Some(theme_color(Key::Success));
    item
}

/// What every list picker clears before it paints: the text-entry prompts, the context panel (a guarded write of the claim,
/// which it re-arms) and the usage dashboard.
pub fn reset_surfaces(host: &mut dyn PickerHost, own: &Own) {
    host.clear_prompts();
    own.clear_context(host);
    host.close_usage_panel();
}

/// The claim a picker holds on the surface, re-armed by each of its paints (`own`).
#[derive(Clone, Debug)]
pub struct Own(Cell<SurfaceClaim>);

impl Own {
    pub fn new(claim: SurfaceClaim) -> Self {
        Self(Cell::new(claim))
    }

    /// The claim as the last paint left it (`own.defer(fn)` binds a callback to it).
    pub fn claim(&self) -> SurfaceClaim {
        self.0.get()
    }

    /// `own.owns()`.
    pub fn owns(&self, host: &dyn PickerHost) -> bool {
        host.owns_surface(self.0.get())
    }

    /// `own.paint(panel)`: true when the write landed (the claim is re-armed on what it just took).
    pub fn paint(&self, host: &mut dyn PickerHost, panel: Option<PickerPanel>) -> bool {
        match host.paint_picker(self.0.get(), panel) {
            Some(next) => {
                self.0.set(next);
                true
            }
            None => false,
        }
    }

    /// `own.context(null)`.
    pub fn clear_context(&self, host: &mut dyn PickerHost) -> bool {
        match host.clear_context_panel(self.0.get()) {
            Some(next) => {
                self.0.set(next);
                true
            }
            None => false,
        }
    }

    /// `own.close()`.
    pub fn close(&self, host: &mut dyn PickerHost) {
        host.close_surface(self.0.get());
    }
}

/// Runs `run` only while a callback deferred as `deferred` (a claim taken by [`Own::claim`] when the callback was made) still
/// owns the surface (`own.defer(fn)`).
pub fn run_deferred(host: &mut dyn PickerHost, deferred: SurfaceClaim, run: impl FnOnce(&mut dyn PickerHost)) {
    if host.owns_surface(deferred) {
        run(host);
    }
}
