//! The provider setup picker and the onboarding wizard against what the Node code does (tests/goldens/pickers-provider.json,
//! recorded by tests/recorders/record-pickers-provider.mjs): the event log of scripted flows (panels, store calls, notices,
//! prompts, cache clears, opener calls), driven through a recording host with the same scripted store; plus the cases of
//! `provider-setup-picker.test.mjs`, `provider-usable.test.mjs` and `onboarding-steps.test.mjs` the recording does not cover.
//!
//! The recorder is run on a Node checkout (`node tests/recorders/record-pickers-provider.mjs --tree <checkout> --check
//! tests/goldens/pickers-provider.json`); this test only reads the recording.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use mixdog_term::paste::{PastedImage, PromptContent};
use mixdog_tui::app::AppCtx;
use mixdog_tui::pickers::PickerKind;
use mixdog_tui::pickers::provider::{
    ModelLabels, OnboardingState, PanelOwner, Prefetch, ProviderHost, ProviderPanel, ProviderSetup,
    RowKind, SetupOptions, cancel, confirm, finish_onboarding, highlight, oauth_cancel_return,
    oauth_failure_return, oauth_settled, oauth_success_return, onboarding_cancel, open_auth_step,
    open_models_step, open_provider_setup, opener_named, output_style_advance, output_style_back,
    prefetched_agents, prefetched_provider_models, resolve_onboarding_completed, run_return_to,
    select, start_onboarding, theme_advance, theme_back,
};
use mixdog_tui::slash::host::{
    PromptSurface, SlashHost, SlashState, SubmitOptions, TextPrompt, Tone,
};
use mixdog_tui::slash::notices::truthy;
use mixdog_tui::surface::{SurfaceClaim, SurfaceKind};
use mixdog_tui_widgets::picker::MetaPart;
use mixdog_tui_widgets::picker::layout::FooterInput;
use serde_json::{Map, Value, json};

const GOLDEN: &str = include_str!("goldens/pickers-provider.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("pickers-provider.json is valid JSON")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// The answers of `model-options.mjs` the recording holds, handed to the port as its model labels.
struct Labels {
    normalize: Vec<(Value, Vec<Value>)>,
    descriptions: HashMap<String, String>,
    parts: HashMap<String, Vec<(String, usize)>>,
    ranks: HashMap<String, f64>,
}

fn route_key(route: Option<&Value>) -> String {
    let Some(route) = route.filter(|route| !route.is_null()) else {
        return String::new();
    };
    let part = |key: &str| {
        route
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let fast = if route.get("fast").is_some_and(truthy) {
        "1"
    } else {
        ""
    };
    [
        part("provider"),
        part("model"),
        part("effort"),
        fast.to_owned(),
    ]
    .join("|")
}

impl Labels {
    fn from_golden(golden: &Value) -> Self {
        let labels = &golden["labels"];
        let pairs = |key: &str| labels[key].as_array().cloned().unwrap_or_default();
        Self {
            normalize: pairs("normalize")
                .iter()
                .map(|pair| {
                    (
                        pair[0].clone(),
                        pair[1].as_array().cloned().unwrap_or_default(),
                    )
                })
                .collect(),
            descriptions: pairs("descriptions")
                .iter()
                .map(|pair| (text(&pair[0]).to_owned(), text(&pair[1]).to_owned()))
                .collect(),
            parts: pairs("parts")
                .iter()
                .map(|pair| {
                    let parts = pair[1]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|part| {
                            (
                                text(&part[0]).to_owned(),
                                part[1].as_u64().unwrap_or(0) as usize,
                            )
                        })
                        .collect();
                    (text(&pair[0]).to_owned(), parts)
                })
                .collect(),
            ranks: pairs("ranks")
                .iter()
                .map(|pair| (text(&pair[0]).to_owned(), pair[1].as_f64().unwrap_or(900.0)))
                .collect(),
        }
    }
}

impl ModelLabels for Labels {
    fn provider_display_rank(&self, provider: &str) -> f64 {
        self.ranks
            .get(&provider.to_lowercase())
            .copied()
            .unwrap_or(900.0)
    }

    fn normalize_model_options(&self, models: &[Value]) -> Vec<Value> {
        let wanted = Value::Array(models.to_vec());
        self.normalize
            .iter()
            .find(|(input, _)| *input == wanted)
            .map(|(_, output)| output.clone())
            .unwrap_or_else(|| {
                panic!("the recording has no normalizeModelOptions answer for {wanted}")
            })
    }

    fn model_description(&self, model: &Value) -> String {
        let key = format!("{}:{}", text(&model["provider"]), text(&model["id"]));
        self.descriptions.get(&key).cloned().unwrap_or_default()
    }

    fn agent_model_parts(&self, route: Option<&Value>) -> Vec<MetaPart> {
        let key = route_key(route);
        let parts = self
            .parts
            .get(&key)
            .unwrap_or_else(|| panic!("the recording has no agentModelParts answer for {key}"));
        parts
            .iter()
            .map(|(text, width)| MetaPart {
                text: text.clone(),
                width: *width,
            })
            .collect()
    }
}

enum Pending {
    Models(u64, Result<Value, String>),
    Agents(Result<Value, String>),
}

/// A recording host: every effect is one entry of `log`, in the shape the recorder logs the same effect of the Node code in.
struct Host {
    log: Vec<Value>,
    replies: HashMap<String, VecDeque<Result<Value, String>>>,
    epoch: u64,
    live: Option<ProviderPanel>,
    flow: Option<ProviderSetup>,
    onboarding: OnboardingState,
    labels: Labels,
    desktop: bool,
    urls: Vec<String>,
    watched: Vec<String>,
    pending: Vec<Pending>,
    prompt: Option<TextPrompt>,
    submitting: bool,
}

impl Host {
    fn new(labels: Labels) -> Self {
        Self {
            log: Vec::new(),
            replies: HashMap::new(),
            epoch: 1,
            live: None,
            flow: None,
            onboarding: OnboardingState::default(),
            labels,
            desktop: false,
            urls: Vec::new(),
            watched: Vec::new(),
            pending: Vec::new(),
            prompt: None,
            submitting: false,
        }
    }

    fn script(&mut self, action: &str, reply: Result<Value, String>) {
        self.replies
            .insert(action.to_owned(), VecDeque::from([reply]));
    }

    /// A scripted store entry of a recorded scenario (`{ ok }`, `{ err }`, or a list answering one call after another).
    fn script_spec(&mut self, action: &str, spec: &Value) {
        let one = |answer: &Value| -> Result<Value, String> {
            if let Some(error) = answer.get("err") {
                return Err(text(error).to_owned());
            }
            let ok = answer.get("ok").cloned().unwrap_or(Value::Null);
            if action == "beginOAuthProviderLogin" {
                let mut status = Map::new();
                status.insert("flowId".to_owned(), json!("oauth_1"));
                status.insert("state".to_owned(), json!("pending"));
                for key in ["url", "manualUrl", "userCode"] {
                    if let Some(value) = ok.get(key) {
                        status.insert(key.to_owned(), value.clone());
                    }
                }
                status.insert(
                    "manualCodeSupported".to_owned(),
                    json!(ok.get("manualCode") == Some(&json!(true))),
                );
                return Ok(Value::Object(status));
            }
            Ok(ok)
        };
        let answers: VecDeque<_> = match spec {
            Value::Array(list) => list.iter().map(one).collect(),
            single => VecDeque::from([one(single)]),
        };
        self.replies.insert(action.to_owned(), answers);
    }

    fn answer(&mut self, action: &str) -> Option<Result<Value, String>> {
        let queue = self.replies.get_mut(action)?;
        if queue.len() > 1 {
            queue.pop_front()
        } else {
            queue.front().cloned()
        }
    }

    /// The results of the background prefetch land after the current turn: here, after the next store call returns.
    fn deliver_pending(&mut self) {
        for pending in std::mem::take(&mut self.pending) {
            match pending {
                Pending::Models(seq, result) => prefetched_provider_models(self, seq, result),
                Pending::Agents(result) => prefetched_agents(self, result),
            }
        }
    }

    fn notices(&self) -> Vec<(String, String)> {
        self.log
            .iter()
            .filter(|entry| entry[0] == "notice")
            .map(|entry| (text(&entry[1]).to_owned(), text(&entry[2]).to_owned()))
            .collect()
    }

    fn calls(&self, action: &str) -> Vec<Value> {
        self.log
            .iter()
            .filter(|entry| entry[0] == "call" && entry[1] == action)
            .map(|entry| entry[2].clone())
            .collect()
    }

    fn prompts(&self) -> Vec<Value> {
        self.log
            .iter()
            .filter(|entry| entry[0] == "prompt" && entry[1] == "provider")
            .map(|entry| entry[2].clone())
            .collect()
    }

    fn panel(&self) -> &ProviderPanel {
        self.live.as_ref().expect("a panel is on screen")
    }

    fn row_index(&self, value: &str) -> usize {
        let panel = self.panel();
        panel
            .items
            .iter()
            .position(|row| row.value() == value)
            .unwrap_or_else(|| panic!("no row {value} in panel {}", panel.title))
    }

    fn pick(&mut self, value: &str) {
        let (owner, index) = (self.panel().owner.clone(), self.row_index(value));
        select(self, &owner, index);
        self.deliver_pending();
    }

    fn esc(&mut self) {
        let owner = self.panel().owner.clone();
        cancel(self, &owner);
        self.deliver_pending();
    }

    fn begin(&mut self, options: SetupOptions) {
        open_provider_setup(self, options);
        self.deliver_pending();
    }
}

fn panel_json(panel: &ProviderPanel) -> Value {
    let footer: Vec<Value> = panel
        .footer_lines(panel.initial_index)
        .iter()
        .map(|line| match line {
            FooterInput::Plain(text) => json!(["", text]),
            FooterInput::Object { glyph, text, .. } => json!([glyph, text]),
        })
        .collect();
    let items: Vec<Value> = panel
        .items
        .iter()
        .map(|row| {
            let mut item = json!({
                "value": row.item.value,
                "label": row.item.label,
                "meta": row.item.meta,
                "description": row.item.description,
                "marker": row.item.marker,
            });
            if let Some(parts) = &row.item.meta_parts {
                item["metaParts"] = Value::Array(
                    parts
                        .iter()
                        .map(|part| json!([part.text, part.width]))
                        .collect(),
                );
            }
            item
        })
        .collect();
    json!({
        "title": panel.title,
        "description": panel.description,
        "detail": panel.detail,
        "pickerKey": panel.picker_key,
        "help": panel.help.clone().unwrap_or_default(),
        "initialIndex": panel.initial_index,
        "items": items,
        "footer": footer,
        "confirm": panel.confirm_bar.as_ref().map(|bar| {
            Value::Array(bar.buttons.iter().map(|button| json!([button.value, button.label])).collect())
        }),
    })
}

fn prompt_json(prompt: &TextPrompt) -> Value {
    let mut out = Map::new();
    out.insert("kind".to_owned(), json!(prompt.kind));
    for (key, value) in [("label", &prompt.label), ("hint", &prompt.hint)] {
        if !value.is_empty() {
            out.insert(key.to_owned(), json!(value));
        }
    }
    for key in [
        "providerId",
        "providerName",
        "mode",
        "envName",
        "source",
        "keyUrl",
        "authMode",
        "detail",
    ] {
        let value = prompt.text(key);
        if !value.is_empty() {
            out.insert(key.to_owned(), json!(value));
        }
    }
    for (key, field) in [
        ("afterSave", "_afterSave"),
        ("successReturn", "_successReturn"),
        ("failureReturn", "_failureReturn"),
        ("cancelReturn", "_cancelReturn"),
        ("login", "_login"),
    ] {
        if prompt.fields.get(field).is_some_and(truthy) {
            out.insert(key.to_owned(), json!(true));
        }
    }
    Value::Object(out)
}

fn surface_name(surface: PromptSurface) -> &'static str {
    match surface {
        PromptSurface::Provider => "provider",
        PromptSurface::Settings => "settings",
    }
}

impl AppCtx for Host {
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String> {
        let Some(reply) = self.answer(action) else {
            return Ok(Value::Null);
        };
        self.log.push(json!(["call", action, args]));
        self.deliver_pending();
        reply
    }

    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim {
        SurfaceClaim {
            kind,
            epoch: self.epoch,
        }
    }

    fn open_picker(&mut self, _kind: PickerKind) -> SurfaceClaim {
        SurfaceClaim {
            kind: SurfaceKind::Picker,
            epoch: self.epoch,
        }
    }
}

impl SlashHost for Host {
    fn state(&self) -> SlashState {
        SlashState::default()
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
        self.replies.contains_key(name)
    }

    fn clear_context_panel(&mut self) {
        self.log.push(json!(["clearContext"]));
        // Clearing the context panel hands the surface back: the epoch is superseded.
        self.epoch += 1;
    }

    fn close_usage_panel(&mut self) {
        self.log.push(json!(["closeUsage"]));
    }

    fn paint_loading_frame(&mut self, _command: &str, _title: &str) -> Option<SurfaceClaim> {
        None
    }

    fn owns_surface(&self, claim: SurfaceClaim) -> bool {
        claim.epoch == self.epoch
    }

    fn close_surface(&mut self, claim: SurfaceClaim) {
        if self.owns_surface(claim) {
            self.live = None;
            self.epoch += 1;
            self.log.push(json!(["panel", Value::Null]));
        }
    }

    fn paint_stop_confirm(&mut self, _claim: SurfaceClaim, _title: &str, _commands: &[String]) {}

    fn open(
        &mut self,
        opener: mixdog_tui::slash::host::Opener,
        options: Value,
    ) -> Result<(), String> {
        self.log.push(json!(["open", opener.as_str(), options]));
        Ok(())
    }

    fn open_with_return(
        &mut self,
        opener: mixdog_tui::slash::host::Opener,
        options: Value,
        _target: &TextPrompt,
    ) -> Result<(), String> {
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
        self.epoch += 1;
        self.epoch
    }

    fn is_panel_epoch_current(&self, token: u64) -> bool {
        token == self.epoch
    }

    fn write_token(&self, _surface: PromptSurface) -> u64 {
        0
    }

    fn set_write_token(&mut self, _surface: PromptSurface, _token: u64) {}

    fn provider_prompt(&self) -> Option<TextPrompt> {
        self.prompt.clone()
    }

    fn settings_prompt(&self) -> Option<TextPrompt> {
        None
    }

    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>) {
        let shown = next.as_ref().map_or(Value::Null, prompt_json);
        if surface == PromptSurface::Provider {
            self.prompt = next;
        }
        self.log
            .push(json!(["prompt", surface_name(surface), shown]));
    }

    fn mark_prompt_submitting(&mut self, _surface: PromptSurface, _target: &TextPrompt) {}

    fn oauth_submitting(&self) -> bool {
        self.submitting
    }

    fn set_oauth_submitting(&mut self, value: bool) {
        self.submitting = value;
    }

    fn oauth_complete_code(&mut self, _target: &TextPrompt, _code: &str) -> Result<(), String> {
        Ok(())
    }

    fn oauth_success_return(&mut self, _target: &TextPrompt) -> bool {
        true
    }

    fn oauth_failure_return(&mut self, _target: &TextPrompt, _error: &str) {}

    fn provider_after_save(&mut self, _target: &TextPrompt) -> bool {
        false
    }

    fn clear_model_caches(&mut self, scope: &str) {
        self.log.push(json!(["clearCaches", scope]));
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

    fn store_submit(
        &mut self,
        _method: &str,
        _content: &PromptContent,
        _options: &SubmitOptions,
    ) -> Result<Value, String> {
        Ok(Value::Null)
    }
}

impl ModelLabels for Host {
    fn provider_display_rank(&self, provider: &str) -> f64 {
        self.labels.provider_display_rank(provider)
    }

    fn normalize_model_options(&self, models: &[Value]) -> Vec<Value> {
        self.labels.normalize_model_options(models)
    }

    fn model_description(&self, model: &Value) -> String {
        self.labels.model_description(model)
    }

    fn agent_model_parts(&self, route: Option<&Value>) -> Vec<MetaPart> {
        self.labels.agent_model_parts(route)
    }
}

impl ProviderHost for Host {
    fn paint_provider_panel(
        &mut self,
        claim: SurfaceClaim,
        panel: Option<ProviderPanel>,
    ) -> Option<SurfaceClaim> {
        if !self.owns_surface(claim) {
            return None;
        }
        // The handover rule of the surface: closing a panel, or replacing it by one of another identity (its title).
        let handover = self.live.as_ref().is_some_and(|previous| {
            panel
                .as_ref()
                .is_none_or(|next| next.title != previous.title)
        });
        self.log.push(json!([
            "panel",
            panel.as_ref().map_or(Value::Null, panel_json)
        ]));
        self.live = panel;
        if handover {
            self.epoch += 1;
        }
        Some(SurfaceClaim {
            kind: claim.kind,
            epoch: self.epoch,
        })
    }

    fn can_open_browser(&self) -> bool {
        self.desktop
    }

    fn open_in_browser(&mut self, url: &str) {
        self.urls.push(url.to_owned());
    }

    fn watch_oauth_flow(&mut self, flow_id: &str) {
        self.watched.push(flow_id.to_owned());
    }

    fn take_provider_flow(&mut self) -> Option<ProviderSetup> {
        self.flow.take()
    }

    fn put_provider_flow(&mut self, flow: ProviderSetup) {
        self.flow = Some(flow);
    }

    fn has_provider_flow(&self) -> bool {
        self.flow.is_some()
    }

    fn onboarding(&mut self) -> &mut OnboardingState {
        &mut self.onboarding
    }

    fn set_onboarding_active(&mut self, active: bool) {
        self.log.push(json!(["active", active]));
    }

    fn start_step2_prefetch(&mut self, wants: Prefetch) {
        // The calls are made now and their results land after the current turn.
        if wants.provider_models && self.replies.contains_key("listProviderModels") {
            let result = self.answer("listProviderModels").expect("scripted");
            self.log.push(json!(["call", "listProviderModels", []]));
            self.pending.push(Pending::Models(wants.seq, result));
        }
        if wants.agents && self.replies.contains_key("listAgents") {
            let result = self.answer("listAgents").expect("scripted");
            self.log.push(json!(["call", "listAgents", []]));
            self.pending.push(Pending::Agents(result));
        }
    }

    fn set_provider_models_cache(&mut self, models: &[Value], _at_ms: u64) {
        self.log.push(json!(["modelsCache", models.len()]));
    }
}

// ---- the recording --------------------------------------------------------------------------------------------------------

fn setup_options(spec: &Value) -> SetupOptions {
    let target = |key: &str| {
        spec.get(key).and_then(Value::as_str).map(|name| {
            mixdog_tui::pickers::provider::Callback::Open(
                opener_named(name).expect("a known opener"),
                json!({}),
            )
        })
    };
    SetupOptions {
        return_to: target("returnTo"),
        on_continue: target("onContinue"),
        on_cancel: target("onCancel"),
        ..SetupOptions::default()
    }
}

fn run_step(host: &mut Host, step: &Value) {
    let kind = text(&step[0]);
    let a = text(&step[1]);
    match kind {
        "open" => host.begin(setup_options(&step[1])),
        "select" => host.pick(a),
        "cancel" => host.esc(),
        "highlight" => {
            let (owner, index) = (host.panel().owner.clone(), host.row_index(a));
            highlight(host, &owner, index);
        }
        "confirm" => {
            let owner = host.panel().owner.clone();
            confirm(host, &owner, a);
        }
        "settle" => {
            let status = match a {
                "complete" => json!({"state": "complete"}),
                "empty" => json!({"state": "failed", "error": "OAuth login did not complete."}),
                _ => json!({"state": "failed", "error": text(&step[2])}),
            };
            oauth_settled(host, "oauth_1", Ok(status));
        }
        "afterSave" => {
            run_return_to(host);
        }
        "codeSuccess" => oauth_success_return(host),
        "codeFailure" => oauth_failure_return(host, a),
        "codeCancel" => oauth_cancel_return(host),
        "wizard" => match a {
            "auth" => open_auth_step(host),
            "models" => open_models_step(host),
            "themeAdvance" => theme_advance(host),
            "themeBack" => theme_back(host),
            "styleBack" => output_style_back(host),
            "styleAdvance" => output_style_advance(host),
            "finish" => finish_onboarding(host),
            "skip" => onboarding_cancel(host),
            other => panic!("unknown wizard step {other}"),
        },
        "pick" => {
            if let Some(route) = step[1].get("defaultRoute") {
                host.onboarding.default_route = Some(route.clone());
            }
        }
        "state" => {
            let state = &host.onboarding;
            let routes = Value::Object(state.agent_routes.clone());
            let entry = json!(["state", {
                "defaultRoute": state.default_route.clone().unwrap_or(Value::Null),
                "webSearchRoute": state.web_search_route.clone().unwrap_or(Value::Null),
                "agentRoutes": routes,
            }]);
            host.log.push(entry);
        }
        other => panic!("unknown step {other}"),
    }
    host.deliver_pending();
}

#[test]
fn the_scenarios_log_what_the_node_code_logs() {
    let golden = golden();
    let mut mismatches = Vec::new();
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let mut host = Host::new(Labels::from_golden(&golden));
        host.desktop = scenario["browser"] == "desktop";
        for (action, spec) in scenario["store"].as_object().expect("store") {
            host.script_spec(action, spec);
        }
        for step in scenario["steps"].as_array().expect("steps") {
            run_step(&mut host, step);
        }
        let want = scenario["log"].as_array().expect("log");
        if host.log.len() != want.len() || host.log.iter().zip(want).any(|(got, want)| got != want)
        {
            let at = host
                .log
                .iter()
                .zip(want)
                .position(|(got, want)| got != want)
                .unwrap_or(host.log.len().min(want.len()));
            let short = |entry: Option<&Value>| {
                let shown = entry.map_or("(none)".to_owned(), Value::to_string);
                shown.chars().take(400).collect::<String>()
            };
            mismatches.push(format!(
                "{}: {} entries, want {}; first difference at {at}:\n  got  {}\n  want {}",
                text(&scenario["name"]),
                host.log.len(),
                want.len(),
                short(host.log.get(at)),
                short(want.get(at)),
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} scenarios differ:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}

#[test]
fn the_first_run_gate_resolves_as_the_node_gate_does() {
    for case in golden()["gate"].as_array().expect("gate") {
        let verdict = case.get("verdict").and_then(Value::as_bool);
        let status = case.get("status");
        let throws = case.get("throws").is_some();
        let no_method = case.get("noMethod").is_some();
        let resolved = resolve_onboarding_completed(verdict, || {
            if throws {
                return Some(Err("unreadable".to_owned()));
            }
            if no_method || status.is_none() {
                return None;
            }
            let status = status.expect("a status");
            // A promise is what an asynchronous store answers: not a readable status.
            if status.get("$promise").is_some() {
                Some(Err("pending".to_owned()))
            } else {
                Some(Ok(status.clone()))
            }
        });
        assert_eq!(
            Some(resolved),
            case["resolved"].as_bool(),
            "gate case {case}"
        );
    }
}

// ---- the cases of the Node tests the recording does not cover --------------------------------------------------------------

fn host_with(setup: Value) -> Host {
    let mut host = Host::new(Labels::from_golden(&golden()));
    host.script("getProviderSetup", Ok(setup));
    host
}

fn base_setup() -> Value {
    json!({
        "api": [
            {"id": "openai", "name": "OpenAI", "authenticated": true, "stored": true, "envName": "OPENAI_API_KEY"},
            {"id": "opencode-go", "name": "OpenCode Go", "authenticated": false, "url": "https://opencode.ai/keys"},
        ],
        "oauth": [{"id": "anthropic-oauth", "name": "Anthropic", "authenticated": false}],
        "local": [],
    })
}

#[test]
fn the_key_console_row_opens_the_browser_and_still_shows_the_address_in_the_prompt() {
    let mut host = host_with(base_setup());
    host.begin(SetupOptions::default());
    host.pick("api:opencode-go");
    host.pick("get-key");
    assert_eq!(host.urls, ["https://opencode.ai/keys"]);
    assert_eq!(
        host.notices().last().map(|(message, _)| message.as_str()),
        Some("opened https://opencode.ai/keys")
    );
    let prompt = host.prompts().pop().expect("a prompt");
    assert_eq!(prompt["keyUrl"], "https://opencode.ai/keys");
    assert_eq!(prompt["mode"], "set");
}

#[test]
fn a_desktop_start_opens_the_browser_and_a_headless_one_never_does() {
    for (desktop, opened) in [(true, 1), (false, 0)] {
        let mut host = host_with(base_setup());
        host.desktop = desktop;
        host.script_spec("beginOAuthProviderLogin", &json!({"ok": {"url": "https://example.test/auth", "manualUrl": "https://example.test/manual"}}));
        host.begin(SetupOptions::default());
        host.pick("oauth:anthropic-oauth");
        host.pick("login-oauth");
        assert_eq!(host.urls.len(), opened);
        // The runtime opened `url`, not the manual address.
        if desktop {
            assert_eq!(host.urls[0], "https://example.test/auth");
        }
        assert_eq!(
            host.calls("beginOAuthProviderLogin"),
            [json!(["anthropic-oauth", {"openBrowser": desktop}])]
        );
        assert_eq!(host.watched, ["oauth_1"]);
        let description = &host.panel().description;
        assert_eq!(
            description,
            if desktop {
                "Open this URL to sign in (browser opened):"
            } else {
                "Open this URL to sign in:"
            }
        );
        assert_eq!(
            host.panel().detail,
            "https://example.test/manual",
            "manualUrl wins over url"
        );
    }
}

#[test]
fn the_device_code_warning_fits_eighty_columns_and_a_plain_url_has_none() {
    let mut host = host_with(base_setup());
    host.script_spec(
        "beginOAuthProviderLogin",
        &json!({"ok": {"url": "https://example.test/device", "userCode": "ABCD-1234"}}),
    );
    host.begin(SetupOptions::default());
    host.pick("oauth:anthropic-oauth");
    host.pick("login-oauth");
    assert_eq!(host.panel().description, "Enter code ABCD-1234 at:");
    let lines = host.panel().footer_lines(0);
    assert_eq!(
        lines.len(),
        1,
        "one footer row, like the status footer it replaces"
    );
    let FooterInput::Object { text, .. } = &lines[0] else {
        panic!("an object line")
    };
    assert!(
        text.contains("Continue only if you started this")
            && text.contains("Never enter a code someone sent you")
    );
    assert!(text.chars().count() + 7 <= 80);

    let mut plain = host_with(base_setup());
    plain.script_spec(
        "beginOAuthProviderLogin",
        &json!({"ok": {"url": "https://example.test/poll"}}),
    );
    plain.begin(SetupOptions::default());
    plain.pick("oauth:anthropic-oauth");
    plain.pick("login-oauth");
    let FooterInput::Object { text, .. } = &plain.panel().footer_lines(0)[0] else {
        panic!("an object line")
    };
    assert!(!text.contains("someone sent you"));
}

#[test]
fn a_late_login_after_back_becomes_a_notice_and_the_result_panel_is_not_painted() {
    let mut host = host_with(base_setup());
    host.script_spec(
        "beginOAuthProviderLogin",
        &json!({"ok": {"url": "https://example.test/device", "userCode": "ABCD"}}),
    );
    host.begin(SetupOptions::default());
    host.pick("oauth:anthropic-oauth");
    host.pick("login-oauth");
    host.pick("back");
    oauth_settled(&mut host, "oauth_1", Ok(json!({"state": "complete"})));
    assert_eq!(
        host.panel().picker_key,
        "providers-action:oauth:anthropic-oauth"
    );
    assert_eq!(
        host.notices().last(),
        Some(&("Anthropic login complete".to_owned(), "info".to_owned()))
    );
    // A flow id that is not the current login's is not this picker's.
    oauth_settled(&mut host, "oauth_9", Err("late".to_owned()));
    assert_eq!(host.notices().len(), 1);
}

#[test]
fn a_code_submitted_in_the_prompt_is_not_finished_again_by_the_callback() {
    let mut host = host_with(base_setup());
    host.script_spec(
        "beginOAuthProviderLogin",
        &json!({"ok": {"url": "https://example.test/auth", "manualCode": true}}),
    );
    host.begin(SetupOptions::default());
    host.pick("oauth:anthropic-oauth");
    host.pick("login-oauth");
    let painted = host.log.len();
    host.submitting = true;
    oauth_settled(&mut host, "oauth_1", Ok(json!({"state": "complete"})));
    assert_eq!(host.log.len(), painted, "the prompt reports its own result");
}

#[test]
fn the_api_key_prompt_carries_no_key_and_nothing_secret_is_logged() {
    let mut host = host_with(base_setup());
    host.begin(SetupOptions::default());
    host.pick("api:openai");
    host.pick("set-key");
    let prompt = host.prompts().pop().expect("a prompt");
    assert_eq!(prompt["kind"], "api-key");
    assert_eq!(prompt["providerId"], "openai");
    assert!(
        host.log
            .iter()
            .all(|entry| entry[0] != "call" || entry[1] == "getProviderSetup")
    );
}

#[test]
fn client_managed_rows_never_open_a_credential_action() {
    let managed = json!({
        "managedByClient": true,
        "api": [{"id": "openai", "name": "OpenAI", "authenticated": true}],
        "oauth": [{"id": "anthropic-oauth", "name": "Anthropic"}],
        "local": [{"id": "mixdog-local", "name": "Local Provider", "detected": true, "enabled": true, "usable": true}],
    });
    let mut host = host_with(managed);
    host.script("saveProviderApiKey", Err("forbidden".to_owned()));
    host.script("forgetProviderAuth", Err("forbidden".to_owned()));
    host.script("loginOAuthProvider", Err("forbidden".to_owned()));
    host.begin(SetupOptions::default());
    let before = host.log.len();
    for value in ["api:openai", "oauth:anthropic-oauth", "local:mixdog-local"] {
        host.pick(value);
        assert_eq!(
            host.panel().picker_key,
            "providers-main:root",
            "{value} must stay read-only"
        );
    }
    assert_eq!(host.log.len(), before);
    assert!(host.panel().description.contains("local desktop window"));
    let last_help = host.panel().help.clone().unwrap_or_default();
    assert!(last_help.contains("Enter Refresh"));
}

#[test]
fn a_stale_acknowledgement_after_esc_neither_paints_nor_navigates() {
    let mut host = host_with(base_setup());
    host.begin(SetupOptions::default());
    host.pick("api:openai");
    host.esc();
    host.esc();
    let before = host.log.len();
    oauth_settled(&mut host, "oauth_1", Ok(json!({"state": "complete"})));
    oauth_cancel_return(&mut host);
    assert_eq!(host.log.len(), before);
    assert!(host.live.is_none());
}

#[test]
fn the_wizard_launches_once_and_the_flag_forces_it() {
    let mut host = Host::new(Labels::from_golden(&golden()));
    assert!(
        !start_onboarding(&mut host, false, Some(true)),
        "completed and not forced"
    );
    assert!(
        start_onboarding(&mut host, true, Some(true)),
        "--onboarding forces it"
    );
    assert_eq!(host.log.last(), Some(&json!(["active", true])));
    assert!(
        !start_onboarding(&mut host, true, Some(false)),
        "at most once per mount"
    );

    let mut fresh = Host::new(Labels::from_golden(&golden()));
    fresh.script("getOnboardingStatus", Ok(json!({"completed": false})));
    assert!(
        start_onboarding(&mut fresh, false, None),
        "an unfinished status opens it"
    );
    let mut unreadable = Host::new(Labels::from_golden(&golden()));
    unreadable.script("getOnboardingStatus", Err("down".to_owned()));
    assert!(
        !start_onboarding(&mut unreadable, false, None),
        "an unreadable status counts as completed"
    );
}

#[test]
fn a_prefetch_of_a_superseded_generation_is_dropped() {
    let mut host = Host::new(Labels::from_golden(&golden()));
    host.script(
        "listProviderModels",
        Ok(json!([{"provider": "openai", "id": "gpt-5"}])),
    );
    host.script("listAgents", Ok(json!([{"id": "researcher", "label": "Researcher", "description": "digs"}, {"id": "coder"}])));
    // The wizard asks for what it lacks; the provider cache is invalidated (an auth change) while the models are in flight.
    open_auth_step(&mut host);
    assert_eq!(host.pending.len(), 2);
    host.onboarding.invalidate_provider_models();
    host.deliver_pending();
    assert!(host.onboarding.provider_models.is_empty());
    assert!(host.log.iter().all(|entry| entry[0] != "modelsCache"));
    // The roster is not generation bound.
    assert_eq!(host.onboarding.agents.len(), 2);
    assert_eq!(
        host.onboarding.agents[1].label, "coder",
        "an agent without a label shows its id"
    );
}

#[test]
fn a_prefetch_of_the_current_generation_warms_step_two_once() {
    let mut host = Host::new(Labels::from_golden(&golden()));
    host.script(
        "listProviderModels",
        Ok(json!([{"provider": "openai", "id": "gpt-5"}])),
    );
    host.script("listAgents", Ok(json!([{"id": "coder"}])));
    open_auth_step(&mut host);
    host.deliver_pending();
    assert_eq!(host.onboarding.provider_models.len(), 1);
    assert_eq!(host.calls("listProviderModels").len(), 1);
    open_auth_step(&mut host);
    assert_eq!(
        host.calls("listProviderModels").len(),
        1,
        "nothing is asked for twice"
    );
    assert_eq!(host.calls("listAgents").len(), 1);
}

#[test]
fn the_models_step_shows_the_marker_route_as_following_main() {
    let mut host = Host::new(Labels::from_golden(&golden()));
    host.script("listProviderModels", Ok(json!([{"provider": "openai", "id": "gpt-5", "description": "flagship", "fastCapable": true}, {"provider": "anthropic", "id": "claude-sonnet-4"}])));
    host.script("listAgents", Ok(json!([])));
    host.onboarding.web_search_route = Some(json!({"provider": "default", "model": "default"}));
    open_models_step(&mut host);
    let web = &host.panel().items[1];
    assert_eq!(
        web.item
            .meta_parts
            .as_ref()
            .map(|parts| parts[0].text.as_str()),
        Some("(follows main)")
    );
    assert!(matches!(web.kind, RowKind::Slot(ref target) if target == "webSearch"));
    assert_eq!(host.panel().owner, PanelOwner::OnboardingModels);
}

#[test]
fn a_pick_without_a_model_asks_for_one() {
    let mut host = Host::new(Labels::from_golden(&golden()));
    host.script("listProviderModels", Ok(json!([{"provider": "openai", "id": "gpt-5", "description": "flagship", "fastCapable": true}, {"provider": "anthropic", "id": "claude-sonnet-4"}])));
    host.script("listAgents", Ok(json!([])));
    open_models_step(&mut host);
    host.pick("main-model");
    // A role picker whose selected row carries no model: the Default row of a lead picker does not exist, so select a stale index.
    let owner = host.panel().owner.clone();
    select(&mut host, &owner, 99);
    assert_eq!(
        host.notices().last(),
        Some(&(
            "select a provider model first".to_owned(),
            "warn".to_owned()
        ))
    );
    assert_eq!(
        host.panel().title,
        "First Run \u{b7} Step 2/4 \u{b7} Models"
    );
}
