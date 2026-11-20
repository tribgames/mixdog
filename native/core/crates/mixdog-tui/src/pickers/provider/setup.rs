//! The provider setup picker (`provider-setup-picker.mjs`) and the per-provider action panels (`provider-setup/api-key-actions.mjs`,
//! `oauth-actions.mjs`): the main list, the API-key actions (add, replace, delete, open the key console, the Vertex AI key
//! type), the OAuth actions (login, forget) and the sign-in they start, with its progress and result panels.
//!
//! One [`ProviderSetup`] is one open of the picker: it owns the surface claim shared by the nested panels, so a daemon
//! acknowledgement landing after Esc can neither paint nor navigate (every paint re-validates the claim).

use mixdog_tui_widgets::confirm_bar::ConfirmButton;
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_tui_widgets::picker::{IndexMode, PickerItem};
use serde_json::{Map, Value, json};

use super::format::{key_console_url, provider_detail_text, provider_status_footer};
use super::items::{ListOptions, main_list_items, managed_by_client, provider_main_initial_index};
use super::panel::{ConfirmBar, PanelFooter, PanelOwner, PanelRow, ProviderPanel, ProviderRef, RowKind};
use super::{Callback, ProviderHost, callback_from_value, run_callback, with_flow};
use crate::slash::host::{PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{truthy, value_text};
use crate::surface::{SurfaceClaim, SurfaceKind};

const VERTEX_EXPRESS_HINT: &str =
    "Express mode API keys serve Gemini models on the global location only. Claude and MaaS models need a service-account key or the gcloud login.";
// Shown with every device code: a code someone else hands you signs THEM in to your account. One row that fits 80 columns.
const DEVICE_CODE_WARNING: &str = "Continue only if you started this. Never enter a code someone sent you.";
const CHOOSE_HELP: &str = "\u{2191}/\u{2193} Select \u{b7} Enter Choose \u{b7} Esc Providers";

/// How the setup picker is opened (`options` of `openProviderSetupPicker`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SetupOptions {
    pub title: String,
    pub description: String,
    pub continue_label: String,
    pub continue_description: String,
    /// Esc on the main list goes here when there is no `on_cancel`; the continue row and the API-key prompt's save return here.
    pub return_to: Option<Callback>,
    /// The continue row goes here (`return_to` when absent).
    pub on_continue: Option<Callback>,
    pub on_cancel: Option<Callback>,
    /// The wizard's confirm bar: the main list shows it instead of the continue row.
    pub confirm_bar: Option<ConfirmBarSpec>,
    /// A provider setup the caller already read, so the "Checking Providers" frame is skipped.
    pub preloaded_setup: Option<Value>,
    pub force_refresh: bool,
    /// The provider row to highlight, remembered across reopens.
    pub highlight_provider_value: String,
}

/// A confirm bar and where its button leads.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfirmBarSpec {
    pub buttons: Vec<ConfirmButton>,
    pub on_confirm: Callback,
}

impl SetupOptions {
    /// The options of an open request that arrives as JSON (`{ title, description, continueLabel, continueDescription,
    /// forceRefresh, highlightProviderValue, returnTo, onContinue, onCancel }`, the targets as `{ "opener", "options" }`).
    pub fn from_value(value: &Value) -> Self {
        let text = |key: &str| value.get(key).filter(|member| truthy(member)).map(value_text).unwrap_or_default();
        let target = |key: &str| value.get(key).and_then(callback_from_value);
        Self {
            title: text("title"),
            description: text("description"),
            continue_label: text("continueLabel"),
            continue_description: text("continueDescription"),
            return_to: target("returnTo"),
            on_continue: target("onContinue"),
            on_cancel: target("onCancel"),
            confirm_bar: None,
            preloaded_setup: value.get("preloadedSetup").filter(|setup| setup.is_object()).cloned(),
            force_refresh: value.get("forceRefresh") == Some(&Value::Bool(true)),
            highlight_provider_value: text("highlightProviderValue"),
        }
    }
}

/// The panel on screen, which decides what a key means.
#[derive(Clone, Debug)]
enum Screen {
    Loading,
    Main,
    ApiActions(ProviderRef),
    VertexMode(ProviderRef),
    OAuthActions(ProviderRef),
    OAuthProgress(ProviderRef),
    OAuthResult { item: ProviderRef, ok: bool },
}

/// The sign-in in flight (`login` of `startOAuthLogin` and the `handled` latch of the interactive login).
#[derive(Clone, Debug)]
struct LoginState {
    item: ProviderRef,
    flow_id: Option<String>,
    /// Back was chosen on the progress panel: a login that settles afterwards becomes a notice instead of a result panel.
    backed_out: bool,
    handled: bool,
}

/// One open of the provider setup picker.
#[derive(Clone, Debug)]
pub struct ProviderSetup {
    options: SetupOptions,
    setup: Value,
    claim: SurfaceClaim,
    screen: Screen,
    panel: Option<ProviderPanel>,
    login: Option<LoginState>,
    closed: bool,
}

/// `openProviderSetupPicker(options)`: claims the surface once for this open, loads the provider setup (unless a preloaded
/// one comes with the options) and paints the main list. A failed load is reported and leaves the loading frame.
pub fn open_provider_setup(host: &mut dyn ProviderHost, mut options: SetupOptions) {
    host.set_prompt(PromptSurface::Provider, None);
    host.set_prompt(PromptSurface::Settings, None);
    // Full-panel overlays render ahead of the prompt in the floating-panel chain: a lingering usage or context panel would mask
    // any text-entry prompt opened from the provider actions.
    host.clear_context_panel();
    host.close_usage_panel();
    let claim = host.claim_surface(SurfaceKind::Picker);
    let preloaded = options.preloaded_setup.take().filter(Value::is_object);
    let mut flow = ProviderSetup { options, setup: Value::Null, claim, screen: Screen::Loading, panel: None, login: None, closed: false };
    match preloaded {
        Some(setup) => flow.setup = setup,
        None => {
            if !flow.load(host) {
                host.put_provider_flow(flow);
                return;
            }
        }
    }
    flow.paint_main(host);
    host.put_provider_flow(flow);
}

/// The returnTo of the open that is on screen, run: `true` when it had one (`afterSave` of the API-key prompt).
pub fn run_return_to(host: &mut dyn ProviderHost) -> bool {
    let Some(flow) = host.take_provider_flow() else {
        return false;
    };
    let target = flow.options.return_to.clone();
    host.put_provider_flow(flow);
    match target {
        Some(target) => {
            run_callback(host, &target);
            true
        }
        None => false,
    }
}

/// The OAuth code prompt finished with a login: the result panel (`successReturn`).
pub fn oauth_success_return(host: &mut dyn ProviderHost) {
    with_flow(host, |host, flow| {
        if let Some(login) = flow.login.as_mut() {
            // The prompt reported the result: a status the watcher reads later for the same flow changes nothing.
            login.handled = true;
            let login = login.clone();
            let message = format!("{} login complete.", login_name(&login.item));
            flow.show_result(host, &login.item, true, &message);
        }
    });
}

/// The OAuth code prompt was rejected (`failureReturn`).
pub fn oauth_failure_return(host: &mut dyn ProviderHost, error: &str) {
    with_flow(host, |host, flow| {
        if let Some(login) = flow.login.as_mut() {
            login.handled = true;
            let login = login.clone();
            let message = format!("{} code failed: {error}", login_name(&login.item));
            flow.show_result(host, &login.item, false, &message);
        }
    });
}

/// The OAuth code prompt was cancelled (`cancelReturn`): back to the provider's actions.
pub fn oauth_cancel_return(host: &mut dyn ProviderHost) {
    with_flow(host, |host, flow| {
        if let Some(login) = flow.login.clone() {
            flow.open_oauth_actions(host, &login.item);
        }
    });
}

/// The sign-in flow `flow_id` the host watches settled: its final status (`complete`, `failed`, `cancelled`, `expired`), or the
/// error that ended the wait (`waitForCallback` resolving or rejecting).
pub fn oauth_settled(host: &mut dyn ProviderHost, flow_id: &str, result: Result<Value, String>) {
    with_flow(host, |host, flow| flow.settled(host, flow_id, result));
}

fn login_name(item: &ProviderRef) -> String {
    if !item.name.is_empty() {
        item.name.clone()
    } else if !item.id.is_empty() {
        item.id.clone()
    } else {
        "OAuth".to_owned()
    }
}

fn row(value: &str, label: &str, meta: &str, description: &str, kind: RowKind) -> PanelRow {
    let mut item = PickerItem::new(value, label);
    item.meta = meta.to_owned();
    item.description = description.to_owned();
    PanelRow::new(item, kind)
}

impl ProviderSetup {
    /// Whether the picker was left (Esc on the main list); a closed flow is not kept.
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    fn owns(&self, host: &dyn ProviderHost) -> bool {
        host.owns_surface(self.claim)
    }

    /// `flow.paint(panel)`: a guarded write; false when the claim no longer holds.
    fn paint(&mut self, host: &mut dyn ProviderHost, panel: ProviderPanel) -> bool {
        match host.paint_provider_panel(self.claim, Some(panel.clone())) {
            Some(claim) => {
                self.claim = claim;
                self.panel = Some(panel);
                true
            }
            None => false,
        }
    }

    /// `flow.releaseSurface()`: the flow handing the picker surface to a prompt is still the owner, so it clears and goes on
    /// (Esc paths close instead: leaving is the handover).
    fn release_surface(&mut self, host: &mut dyn ProviderHost) {
        if let Some(claim) = host.paint_provider_panel(self.claim, None) {
            self.claim = claim;
        }
        self.panel = None;
    }

    fn close(&mut self, host: &mut dyn ProviderHost) {
        host.close_surface(self.claim);
        self.panel = None;
        self.closed = true;
    }

    fn remember(&mut self, item: &ProviderRef) {
        if !item.value.is_empty() {
            self.options.highlight_provider_value.clone_from(&item.value);
        }
    }

    /// `flow.reopenProviders()`: reached from acknowledgements as well as key presses, so a stale one must not restart the
    /// whole cluster over the user's surface.
    fn reopen_providers(&mut self, host: &mut dyn ProviderHost) {
        if !self.owns(host) {
            return;
        }
        open_provider_setup(host, self.options.clone());
    }

    fn title_or(&self, fallback: &str) -> String {
        if self.options.title.is_empty() { fallback.to_owned() } else { self.options.title.clone() }
    }

    fn description_or(&self, fallback: &str) -> String {
        if self.options.description.is_empty() { fallback.to_owned() } else { self.options.description.clone() }
    }

    /// `loadProviderSetup`: the placeholder frame, then the fetch; false when it failed (reported) or answered nothing.
    fn load(&mut self, host: &mut dyn ProviderHost) -> bool {
        let mut loading = ProviderPanel::new(
            PanelOwner::ProviderSetup,
            &self.title_or("Providers"),
            "providers-loading",
            vec![row("checking", "Checking Providers", "", "please wait", RowKind::Loading)],
        );
        loading.description = self.description_or("Choose a provider to configure.");
        loading.label_width = Some(18);
        loading.meta_width = Some(10);
        self.paint(host, loading);
        let args = if self.options.force_refresh { json!([{"force": true}]) } else { json!([]) };
        match host.store_call("getProviderSetup", args) {
            Ok(setup) if truthy(&setup) => {
                self.setup = setup;
                true
            }
            Ok(_) => false,
            Err(error) => {
                host.push_notice(&format!("providers failed: {error}"), Tone::Error);
                false
            }
        }
    }

    fn paint_main(&mut self, host: &mut dyn ProviderHost) {
        let managed = managed_by_client(&self.setup);
        let confirm = self.options.confirm_bar.is_some();
        let can_continue = self.options.return_to.is_some() || self.options.on_continue.is_some();
        let list = ListOptions {
            continue_label: self.options.continue_label.clone(),
            continue_description: self.options.continue_description.clone(),
            confirm_bar: confirm,
        };
        let rows = main_list_items(&self.setup, &list, can_continue, &*host);
        let highlight = self.options.highlight_provider_value.clone();
        let key = format!("providers-main:{}", if highlight.is_empty() { "root" } else { &highlight });
        let mut panel = ProviderPanel::new(PanelOwner::ProviderSetup, &self.title_or("Providers"), &key, Vec::new());
        panel.description = if managed {
            "Manage provider sign-ins and accounts in the local desktop window. Refresh to update availability.".to_owned()
        } else {
            self.description_or("Choose a provider. Enter opens provider actions.")
        };
        panel.footer = PanelFooter::HighlightedProvider;
        panel.footer_gap_rows = Some(1);
        panel.help = if confirm {
            None
        } else if managed {
            Some("\u{2191}/\u{2193} Select \u{b7} Enter Refresh \u{b7} Esc Back".to_owned())
        } else {
            Some("\u{2191}/\u{2193} Select \u{b7} Enter Open \u{b7} Esc Back".to_owned())
        };
        panel.index_mode = IndexMode::Always;
        panel.label_width = Some(18);
        panel.meta_width = Some(12);
        panel.initial_index = provider_main_initial_index(&rows, &highlight);
        panel.items = rows;
        panel.confirm_bar = self.options.confirm_bar.as_ref().map(|bar| ConfirmBar { buttons: bar.buttons.clone() });
        self.screen = Screen::Main;
        self.paint(host, panel);
    }

    /// Enter on row `index` of the panel on screen.
    pub fn select(&mut self, host: &mut dyn ProviderHost, index: usize) {
        let Some(row) = self.panel.as_ref().and_then(|panel| panel.items.get(index)).cloned() else {
            return;
        };
        match self.screen.clone() {
            Screen::Loading => {}
            Screen::Main => self.main_select(host, &row),
            Screen::ApiActions(item) => self.api_select(host, &item, &row),
            Screen::VertexMode(item) => {
                self.release_surface(host);
                if row.kind == RowKind::VertexApiKey {
                    self.api_key_prompt(host, &item, Some(("api-key", VERTEX_EXPRESS_HINT)));
                } else {
                    self.api_key_prompt(host, &item, None);
                }
            }
            Screen::OAuthActions(item) => match row.kind {
                RowKind::LoginOAuth => self.start_login(host, &item),
                RowKind::ForgetOAuth => self.forget_provider_auth(host, &item, Screen::OAuthActions(item.clone())),
                _ => {}
            },
            Screen::OAuthProgress(item) => {
                if row.kind == RowKind::Back {
                    self.back_out(host, &item);
                }
            }
            Screen::OAuthResult { item, ok } => self.leave_result(host, &item, ok),
        }
    }

    /// Esc on the panel on screen.
    pub fn cancel(&mut self, host: &mut dyn ProviderHost) {
        match self.screen.clone() {
            Screen::Loading => {
                self.close(host);
                if let Some(target) = self.options.on_cancel.clone() {
                    run_callback(host, &target);
                }
            }
            Screen::Main => {
                self.close(host);
                if let Some(target) = self.options.on_cancel.clone().or_else(|| self.options.return_to.clone()) {
                    run_callback(host, &target);
                }
            }
            Screen::ApiActions(_) | Screen::OAuthActions(_) => self.reopen_providers(host),
            Screen::VertexMode(item) => self.open_api_actions(host, &item),
            Screen::OAuthProgress(item) => self.back_out(host, &item),
            Screen::OAuthResult { item, ok } => self.leave_result(host, &item, ok),
        }
    }

    /// The highlight moved to row `index`: a provider row is remembered.
    pub fn highlight(&mut self, index: usize) {
        if !matches!(self.screen, Screen::Main) {
            return;
        }
        let provider = self.panel.as_ref().and_then(|panel| panel.items.get(index)).and_then(|row| row.provider.clone());
        if let Some(provider) = provider {
            self.remember(&provider);
        }
    }

    /// The confirm bar's button was chosen.
    pub fn confirm(&mut self, host: &mut dyn ProviderHost) {
        if let Some(bar) = self.options.confirm_bar.clone() {
            run_callback(host, &bar.on_confirm);
        }
    }

    fn main_select(&mut self, host: &mut dyn ProviderHost, row: &PanelRow) {
        if managed_by_client(&self.setup) && row.kind != RowKind::Continue {
            if row.kind == RowKind::RefreshClientProviders {
                let mut options = self.options.clone();
                options.preloaded_setup = None;
                options.force_refresh = true;
                open_provider_setup(host, options);
            }
            return;
        }
        // In-flow navigation (Enter on a provider row): the flow keeps the surface, so clear and continue. Esc closes.
        self.release_surface(host);
        match &row.kind {
            RowKind::Continue => {
                if let Some(target) = self.options.on_continue.clone().or_else(|| self.options.return_to.clone()) {
                    run_callback(host, &target);
                }
            }
            RowKind::ApiKey => {
                if let Some(item) = row.provider.clone() {
                    self.open_api_actions(host, &item);
                }
            }
            RowKind::OAuth => {
                if let Some(item) = row.provider.clone() {
                    self.open_oauth_actions(host, &item);
                }
            }
            _ => {}
        }
    }

    fn action_panel(&self, item: &ProviderRef, description: &str, label_width: usize, rows: Vec<PanelRow>) -> ProviderPanel {
        let mut panel =
            ProviderPanel::new(PanelOwner::ProviderSetup, &format!("Provider \u{b7} {}", item.name), &format!("providers-action:{}", item.value), rows);
        panel.description = description.to_owned();
        panel.footer = PanelFooter::Lines(provider_status_footer(Some(&item.row)));
        panel.help = Some(CHOOSE_HELP.to_owned());
        panel.index_mode = IndexMode::Always;
        panel.label_width = Some(label_width);
        panel
    }

    // ---- API keys ----------------------------------------------------------------------------------------------------

    fn open_api_actions(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef) {
        // Reached from acknowledgements (a failed forget) as well as key presses: prove ownership at the sink.
        if !self.owns(host) {
            return;
        }
        self.remember(item);
        let provider = &item.row;
        let has_auth = item.authenticated || provider.get("authenticated").is_some_and(truthy);
        let env = provider.get("env").is_some_and(truthy);
        let has_stored_key = provider.get("stored").is_some_and(truthy) || (!env && has_auth);
        let env_name = provider.get("envName").filter(|name| truthy(name)).map(value_text);
        let mut rows = vec![row(
            "set-key",
            if has_auth { "Replace API key" } else { "Add API key" },
            "",
            &match &env_name {
                Some(name) => format!("masked input \u{b7} {name}"),
                None => "masked input \u{b7} stored in OS keychain".to_owned(),
            },
            RowKind::SetKey,
        )];
        let key_url = key_console_url(provider);
        if !key_url.is_empty() && !has_auth {
            rows.push(row("get-key", "Get API key (browser)", "", &key_url, RowKind::GetKey));
        }
        if has_stored_key {
            let description = if env { "remove keychain key; env key remains active" } else { "remove stored key for this provider" };
            rows.push(row("forget-key", "Delete API key", "", description, RowKind::ForgetKey));
        }
        let panel = self.action_panel(item, "Choose an API-key action.", 22, rows);
        self.screen = Screen::ApiActions(item.clone());
        self.paint(host, panel);
    }

    fn api_select(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef, row: &PanelRow) {
        if row.kind == RowKind::SetKey && item.id == "vertex-ai" {
            self.open_vertex_mode(host, item);
            return;
        }
        self.release_surface(host);
        match row.kind {
            RowKind::SetKey => self.api_key_prompt(host, item, None),
            RowKind::GetKey => {
                // The opener is best effort; the address stays in the key prompt so a failed open still leaves it readable.
                let url = key_console_url(&item.row);
                host.open_in_browser(&url);
                host.push_notice(&format!("opened {url}"), Tone::Info);
                self.api_key_prompt(host, item, None);
            }
            RowKind::ForgetKey => self.forget_provider_auth(host, item, Screen::ApiActions(item.clone())),
            _ => {}
        }
    }

    /// Vertex AI takes either a service-account key or an express-mode API key.
    fn open_vertex_mode(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef) {
        let rows = vec![
            row("service-account", "Service account key", "", "service-account JSON", RowKind::VertexServiceAccount),
            row("api-key", "API key (express mode)", "", "Gemini only \u{b7} global location", RowKind::VertexApiKey),
        ];
        let mut panel =
            ProviderPanel::new(PanelOwner::ProviderSetup, &format!("Provider \u{b7} {}", item.name), &format!("providers-vertex-mode:{}", item.value), rows);
        panel.description = "Choose the Vertex AI key type.".to_owned();
        panel.help = Some(CHOOSE_HELP.replace("Esc Providers", "Esc Back"));
        panel.index_mode = IndexMode::Always;
        panel.label_width = Some(22);
        self.screen = Screen::VertexMode(item.clone());
        self.paint(host, panel);
    }

    /// `setApiKeyPrompt`: the masked key entry (the value is only ever sent to `saveProviderApiKey`, never logged).
    fn api_key_prompt(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef, extra: Option<(&str, &str)>) {
        if !self.owns(host) {
            return;
        }
        let provider = &item.row;
        let mut prompt = TextPrompt::new("api-key");
        prompt.label.clone_from(&item.name);
        let mut fields = Map::new();
        if let Some((auth_mode, hint)) = extra {
            fields.insert("authMode".to_owned(), json!(auth_mode));
            prompt.hint = hint.to_owned();
        }
        fields.insert("providerId".to_owned(), json!(item.id));
        fields.insert("mode".to_owned(), json!(if item.authenticated { "replace" } else { "set" }));
        fields.insert("envName".to_owned(), json!(provider.get("envName").filter(|name| truthy(name)).map(value_text).unwrap_or_default()));
        fields.insert("source".to_owned(), json!(provider_detail_text(provider)));
        fields.insert("keyUrl".to_owned(), json!(key_console_url(provider)));
        if self.options.return_to.is_some() {
            fields.insert("_afterSave".to_owned(), json!(true));
        }
        prompt.fields = fields;
        host.set_prompt(PromptSurface::Provider, Some(prompt));
    }

    /// `forgetProviderAuth`: navigates only once the removal is acknowledged, and returns to the provider's own action panel
    /// when it fails.
    fn forget_provider_auth(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef, reopen: Screen) {
        let result = if host.has_store_method("forgetProviderAuth") { host.store_call("forgetProviderAuth", json!([item.id])) } else { Ok(Value::Null) };
        match result {
            Ok(_) => {
                host.clear_model_caches("all");
                self.reopen_providers(host);
            }
            Err(error) => {
                host.push_notice(&format!("auth-forget failed: {error}"), Tone::Error);
                match reopen {
                    Screen::OAuthActions(item) => self.open_oauth_actions(host, &item),
                    Screen::ApiActions(item) => self.open_api_actions(host, &item),
                    _ => {}
                }
            }
        }
    }

    // ---- OAuth ---------------------------------------------------------------------------------------------------------

    fn open_oauth_actions(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef) {
        if !self.owns(host) {
            return;
        }
        self.remember(item);
        let provider = &item.row;
        let has_auth = item.authenticated || provider.get("authenticated").is_some_and(truthy) || provider.get("reauthRequired") == Some(&Value::Bool(true));
        let detail = provider_detail_text(provider);
        let mut rows = vec![row(
            "login-oauth",
            if has_auth { "Re-login" } else { "Login" },
            "",
            if detail.is_empty() { "open browser or OAuth flow" } else { &detail },
            RowKind::LoginOAuth,
        )];
        if has_auth {
            rows.push(row("forget-oauth", "Forget login", "", "remove stored OAuth credentials", RowKind::ForgetOAuth));
        }
        let panel = self.action_panel(item, "Choose an OAuth login action.", 22, rows);
        self.screen = Screen::OAuthActions(item.clone());
        self.paint(host, panel);
    }

    fn frame(&self, item: &ProviderRef, key: &str, rows: Vec<PanelRow>) -> ProviderPanel {
        let mut panel = ProviderPanel::new(PanelOwner::ProviderSetup, &format!("Provider \u{b7} {}", item.name), key, rows);
        panel.footer = PanelFooter::Lines(provider_status_footer(Some(&item.row)));
        panel.label_width = Some(22);
        panel.meta_width = Some(12);
        panel.index_mode = IndexMode::Never;
        panel
    }

    fn show_progress(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef, message: &str, detail: &str, device_code: bool) {
        let rows = vec![
            row("waiting", "Waiting for login", "Running", "finish the sign-in shown above", RowKind::Waiting),
            row("back", "Back", "", "return to provider actions", RowKind::Back),
        ];
        let mut panel = self.frame(item, &format!("providers-oauth-progress:{}", item.value), rows);
        if device_code {
            panel.footer = PanelFooter::Lines(vec![FooterInput::Object { glyph: "!".to_owned(), color: None, text: DEVICE_CODE_WARNING.to_owned() }]);
        }
        panel.description = message.to_owned();
        panel.detail = detail.to_owned();
        panel.help = Some(CHOOSE_HELP.to_owned());
        self.screen = Screen::OAuthProgress(item.clone());
        self.paint(host, panel);
    }

    fn show_result(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef, ok: bool, message: &str) {
        host.set_prompt(PromptSurface::Provider, None);
        let rows = if ok {
            vec![row("success", "Success", "Done", "refresh provider status", RowKind::Success)]
        } else {
            vec![row("back", "Back", "Ready", "return to provider actions", RowKind::Back)]
        };
        let mut panel = self.frame(item, &format!("providers-oauth-result:{}:{}", item.value, if ok { "ok" } else { "fail" }), rows);
        panel.description = if !message.is_empty() {
            message.to_owned()
        } else if ok {
            "Login complete.".to_owned()
        } else {
            "Login did not complete.".to_owned()
        };
        panel.help = Some(if ok { "Enter Refresh Providers \u{b7} Esc Providers" } else { "Enter Back \u{b7} Esc Providers" }.to_owned());
        self.screen = Screen::OAuthResult { item: item.clone(), ok };
        self.paint(host, panel);
    }

    fn leave_result(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef, ok: bool) {
        if ok {
            self.reopen_providers(host);
        } else {
            self.open_oauth_actions(host, item);
        }
    }

    /// Back on the progress panel returns to the actions; a login that settles afterwards becomes a notice.
    fn back_out(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef) {
        if let Some(login) = self.login.as_mut() {
            login.backed_out = true;
        }
        self.open_oauth_actions(host, item);
    }

    fn start_login(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef) {
        self.login = Some(LoginState { item: item.clone(), flow_id: None, backed_out: false, handled: false });
        self.show_progress(host, item, "Starting login flow\u{2026}", "", false);
        if host.has_store_method("beginOAuthProviderLogin") {
            self.begin_interactive_login(host, item);
        } else {
            self.run_blocking_login(host, item);
        }
    }

    fn backed_out(&self) -> bool {
        self.login.as_ref().is_some_and(|login| login.backed_out)
    }

    /// Login through `loginOAuthProvider`: the call alone decides the result panel.
    fn run_blocking_login(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef) {
        match host.store_call("loginOAuthProvider", json!([item.id])) {
            Ok(_) => {
                host.clear_model_caches("all");
                if self.backed_out() {
                    host.push_notice(&format!("{} login complete", item.name), Tone::Info);
                    return;
                }
                self.show_result(host, item, true, &format!("{} login complete.", item.name));
            }
            Err(error) => {
                if self.backed_out() {
                    host.push_notice(&format!("oauth login failed: {error}"), Tone::Error);
                    return;
                }
                self.show_result(host, item, false, &format!("OAuth login failed: {error}"));
            }
        }
    }

    /// Login through `beginOAuthProviderLogin`: a code-completing login hands the surface to the OAuth code prompt; the
    /// callback (or the prompt) finishes.
    fn begin_interactive_login(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef) {
        let name = login_name(item);
        // Headless machines never try a browser; the URL is shown in the panel either way.
        let open_browser = host.can_open_browser();
        let started = match host.store_call("beginOAuthProviderLogin", json!([item.id, {"openBrowser": open_browser}])) {
            Ok(started) => started,
            Err(error) => {
                host.push_notice(&format!("{name} login failed: {error}"), Tone::Error);
                self.open_oauth_actions(host, item);
                return;
            }
        };
        let member = |key: &str| started.get(key).filter(|value| truthy(value)).map(value_text).unwrap_or_default();
        let (url, manual_url, user_code) = (member("url"), member("manualUrl"), member("userCode"));
        let login_url = if manual_url.is_empty() { url.clone() } else { manual_url.clone() };
        if open_browser {
            let target = if url.is_empty() { &manual_url } else { &url };
            if !target.is_empty() {
                host.open_in_browser(target);
            }
        }
        let flow_id = started.get("flowId").and_then(Value::as_str).map(str::to_owned);
        if let Some(login) = self.login.as_mut() {
            login.flow_id.clone_from(&flow_id);
        }
        if started.get("manualCodeSupported").is_some_and(truthy) {
            // The handover to the code prompt happens only if this flow still owns the surface.
            if !self.owns(host) {
                return;
            }
            self.release_surface(host);
            self.oauth_code_prompt(host, item, &name, &started, &manual_url, &login_url);
            host.push_notice(
                &if open_browser {
                    format!("browser opened for {name}; paste code/redirect here if callback does not finish")
                } else {
                    format!("open the URL shown to sign in to {name}, then paste the code/redirect here")
                },
                Tone::Info,
            );
        } else if !self.backed_out() && self.owns(host) {
            // Device-code and URL-only polling logins stay in the progress panel, with the code and URL, until the result
            // panel replaces it or Back.
            let opened = if open_browser { " (browser opened)" } else { "" };
            let (message, detail) = if !user_code.is_empty() {
                (format!("Enter code {user_code} at{opened}:"), login_url.clone())
            } else if !login_url.is_empty() {
                (format!("Open this URL to sign in{opened}:"), login_url.clone())
            } else {
                ("Finish signing in for this provider.".to_owned(), String::new())
            };
            self.show_progress(host, item, &message, &detail, !user_code.is_empty());
        }
        if let Some(flow_id) = flow_id {
            host.watch_oauth_flow(&flow_id);
        }
    }

    fn oauth_code_prompt(&mut self, host: &mut dyn ProviderHost, item: &ProviderRef, name: &str, started: &Value, manual_url: &str, login_url: &str) {
        let mut prompt = TextPrompt::new("oauth-code");
        prompt.label = format!("{name} OAuth code");
        prompt.hint = if !manual_url.is_empty() {
            "If the browser callback does not finish, open the URL below manually and paste code#state.".to_owned()
        } else if !login_url.is_empty() {
            format!("Open the URL below to sign in, then paste the authorization code or full redirect URL for {name}.")
        } else {
            format!("Paste the authorization code or full redirect URL for {name}.")
        };
        let mut fields = Map::new();
        fields.insert("providerId".to_owned(), json!(item.id));
        fields.insert("providerName".to_owned(), json!(name));
        // Shown inside the live panel only: never written to the transcript, so it cannot linger in scrollback.
        fields.insert("detail".to_owned(), json!(login_url));
        fields.insert("_login".to_owned(), started.get("flowId").cloned().unwrap_or(Value::Null));
        fields.insert("_successReturn".to_owned(), json!(true));
        fields.insert("_failureReturn".to_owned(), json!(true));
        fields.insert("_cancelReturn".to_owned(), json!(true));
        if self.options.return_to.is_some() {
            fields.insert("_afterSave".to_owned(), json!(true));
        }
        prompt.fields = fields;
        host.set_prompt(PromptSurface::Provider, Some(prompt));
    }

    /// `finish(ok, message)` of the interactive login: once per login.
    fn finish_login(&mut self, host: &mut dyn ProviderHost, ok: bool, message: &str) {
        let Some(login) = self.login.as_mut() else {
            return;
        };
        if login.handled {
            return;
        }
        login.handled = true;
        let (item, backed_out) = (login.item.clone(), login.backed_out);
        if ok {
            host.clear_model_caches("all");
        }
        if backed_out {
            if !message.is_empty() {
                host.push_notice(message, if ok { Tone::Info } else { Tone::Error });
            }
            return;
        }
        let name = login_name(&item);
        let message = if !message.is_empty() {
            message.to_owned()
        } else if ok {
            format!("{name} login complete.")
        } else {
            format!("{name} login failed.")
        };
        self.show_result(host, &item, ok, &message);
    }

    fn settled(&mut self, host: &mut dyn ProviderHost, flow_id: &str, result: Result<Value, String>) {
        let Some(login) = self.login.as_ref() else {
            return;
        };
        if login.flow_id.as_deref() != Some(flow_id) {
            return;
        }
        let name = login_name(&login.item);
        match result {
            Ok(status) => match status.get("state").and_then(Value::as_str) {
                // A callback that resolved with a result; a code submitted in the prompt reports itself.
                Some("complete") if !host.oauth_submitting() => self.finish_login(host, true, &format!("{name} login complete")),
                Some("failed" | "expired") => {
                    let error = status.get("error").filter(|e| truthy(e)).map(value_text).unwrap_or_default();
                    // The core's text for a callback that resolved with nothing: Node left the panel as it was.
                    if error != "OAuth login did not complete." {
                        self.finish_login(host, false, &format!("{name} login failed: {error}"));
                    }
                }
                _ => {}
            },
            Err(error) => self.finish_login(host, false, &format!("{name} login failed: {error}")),
        }
    }
}
