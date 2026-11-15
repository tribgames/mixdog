//! A recording fake [`SlashHost`], shared by the slash dispatch tests and the Node twin.
//!
//! Every effect the code under test has on its host is one entry of [`Fake::log`], in the shape `record-slash.mjs` logs the
//! same effect of the Node code in: `["call", action, args]`, `["notice", text, tone]`, `["open", opener, options]`,
//! `["paint", command, title]`, `["setPrompt", surface, prompt]`, ... The store answers each scenario scripts.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet, HashMap};

use mixdog_term::paste::{PastedImage, PromptContent, PromptPart};
use mixdog_tui::app::AppCtx;
use mixdog_tui::pickers::PickerKind;
use mixdog_tui::slash::host::{
    CommittedClear, Opener, PromptSurface, SlashHost, SlashState, SubmitOptions, TextPrompt, Tone,
};
use mixdog_tui::slash::workflow_cycle::{CycleGuard, TabCycleOverlays, workflow_tab_cycle};
use mixdog_tui::slash::{run_slash_command, stop_prompt_cancel, stop_prompt_select};
use mixdog_tui::surface::{SurfaceClaim, SurfaceKind};
use serde_json::{Map, Value, json};

/// The keys of a scenario prompt that stand for the callbacks the Node prompt object carried.
pub const FLAG_KEYS: [&str; 5] = ["_afterSave", "_successReturn", "_failureReturn", "_login", "_returnTo"];

#[derive(Default)]
pub struct Fake {
    pub log: Vec<Value>,
    pub paste: Vec<Value>,
    pub store: HashMap<String, Result<Value, String>>,
    pub state: SlashState,
    pub epoch: u64,
    pub clock: u64,
    pub provider: Option<TextPrompt>,
    pub settings: Option<TextPrompt>,
    pub images: BTreeMap<u64, PastedImage>,
    /// The pasted images whose record has no `type: 'image'`: Node's `buildPromptContentWithImages` takes only typed ones, so such an
    /// image is referenced and snapshotted but never becomes a content part.
    pub untyped_images: BTreeSet<u64>,
    pub texts: BTreeMap<u64, String>,
    pub open_fails: Vec<String>,
    pub doctor_fails: Option<String>,
    pub submit_result: Option<Value>,
    pub submit_sync: bool,
    pub submit_error: Option<String>,
    /// A test hook: the user presses Esc while a store call is in flight (the panel epoch is superseded by the call).
    pub esc_during_call: bool,
    surface_open: bool,
    stop_claim: Option<SurfaceClaim>,
    write_tokens: [u64; 2],
    oauth: bool,
    committed: Option<CommittedClear>,
}

fn surface_index(surface: PromptSurface) -> usize {
    match surface {
        PromptSurface::Provider => 0,
        PromptSurface::Settings => 1,
    }
}

fn surface_name(surface: PromptSurface) -> &'static str {
    match surface {
        PromptSurface::Provider => "provider",
        PromptSurface::Settings => "settings",
    }
}

fn flag(target: &TextPrompt, key: &str) -> bool {
    target.fields.get(key).is_some_and(mixdog_tui::slash::notices::truthy)
}

/// The prompt as `record-slash.mjs` logs it.
pub fn prompt_json(prompt: &TextPrompt) -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), json!(prompt.kind));
    if !prompt.label.is_empty() {
        map.insert("label".into(), json!(prompt.label));
    }
    if !prompt.hint.is_empty() {
        map.insert("hint".into(), json!(prompt.hint));
    }
    for (key, value) in &prompt.fields {
        if !FLAG_KEYS.contains(&key.as_str()) {
            map.insert(key.clone(), value.clone());
        }
    }
    if prompt.submitting {
        map.insert("submitting".into(), json!(true));
    }
    if let Some(initial) = &prompt.initial_value {
        map.insert("initialValue".into(), json!(initial));
    }
    if prompt.restore_epoch > 0 {
        map.insert("restoreEpoch".into(), json!(prompt.restore_epoch));
    }
    Value::Object(map)
}

/// A scenario prompt (`{ kind, label, hint, submitting, ...fields }`) as the host holds it.
pub fn prompt_from(spec: &Value) -> TextPrompt {
    let mut prompt = TextPrompt::default();
    for (key, value) in spec.as_object().into_iter().flatten() {
        match key.as_str() {
            "kind" => prompt.kind = value.as_str().unwrap_or_default().to_owned(),
            "label" => prompt.label = value.as_str().unwrap_or_default().to_owned(),
            "hint" => prompt.hint = value.as_str().unwrap_or_default().to_owned(),
            "submitting" => prompt.submitting = value.as_bool().unwrap_or(false),
            "initialValue" => prompt.initial_value = value.as_str().map(str::to_owned),
            "restoreEpoch" => prompt.restore_epoch = value.as_u64().unwrap_or(0),
            _ => {
                prompt.fields.insert(key.clone(), value.clone());
            }
        }
    }
    prompt
}

pub fn content_json(content: &PromptContent) -> Value {
    match content {
        PromptContent::Text(text) => json!(text),
        PromptContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    PromptPart::Text(text) => json!({"type": "text", "text": text}),
                    PromptPart::Image { data, mime_type, paste_id } => {
                        json!({"type": "image", "data": data, "mimeType": mime_type, "pasteId": paste_id})
                    }
                })
                .collect(),
        ),
    }
}

/// What Node's `buildPromptContentWithImages` builds when the images in `untyped` are not images to it: the parts of the others, or
/// the text alone.
fn node_content(content: &PromptContent, untyped: &BTreeSet<u64>) -> PromptContent {
    let PromptContent::Parts(parts) = content else { return content.clone() };
    if untyped.is_empty() {
        return content.clone();
    }
    let mut kept: Vec<PromptPart> = Vec::new();
    let mut pending_metadata: Option<PromptPart> = None;
    let mut text: Option<PromptPart> = None;
    let mut images = 0;
    for part in parts {
        match part {
            PromptPart::Image { paste_id, .. } if untyped.contains(paste_id) => pending_metadata = None,
            PromptPart::Image { .. } => {
                kept.extend(pending_metadata.take());
                kept.push(part.clone());
                images += 1;
            }
            PromptPart::Text(_) if text.is_none() && kept.is_empty() && pending_metadata.is_none() && parts.first() == Some(part) => text = Some(part.clone()),
            PromptPart::Text(_) => pending_metadata = Some(part.clone()),
        }
    }
    if images == 0 {
        return match text {
            Some(PromptPart::Text(value)) => PromptContent::Text(value),
            _ => content.clone(),
        };
    }
    PromptContent::Parts(text.into_iter().chain(kept).collect())
}

fn options_json(options: Option<&SubmitOptions>) -> Value {
    let mut map = Map::new();
    let Some(options) = options else {
        map.insert("committed".into(), json!(false));
        return Value::Object(map);
    };
    if let Some(text) = &options.display_text {
        map.insert("displayText".into(), json!(text));
    }
    let images: Map<String, Value> = options
        .pasted_images
        .iter()
        .map(|(id, meta)| {
            let mut image = Map::new();
            image.insert("id".into(), json!(meta.id));
            if let Some(media) = &meta.media_type {
                image.insert("mediaType".into(), json!(media));
            }
            if let Some(text) = &meta.metadata_text {
                image.insert("metadataText".into(), json!(text));
            }
            image.insert("sizeBytes".into(), json!(meta.size_bytes));
            (id.to_string(), Value::Object(image))
        })
        .collect();
    map.insert("pastedImages".into(), Value::Object(images));
    let texts: Map<String, Value> =
        options.pasted_texts.iter().map(|(id, text)| (id.to_string(), json!(text))).collect();
    map.insert("pastedTexts".into(), Value::Object(texts));
    map.insert("committed".into(), json!(options.on_committed.is_some()));
    Value::Object(map)
}

fn ids_json(ids: Option<&BTreeSet<u64>>) -> Value {
    ids.map_or(Value::Null, |ids| json!(ids.iter().collect::<Vec<_>>()))
}

impl Fake {
    pub fn new() -> Self {
        Self {
            state: SlashState {
                provider: "openai".into(),
                model: "gpt-5".into(),
                workflow: json!({"id": "wf0", "name": "Default WF"}),
                ..SlashState::default()
            },
            ..Self::default()
        }
    }

    /// Scripts the store's answer to `action` (`Ok(value)` resolves, `Err(text)` rejects).
    pub fn script(&mut self, action: &str, reply: Result<Value, String>) {
        self.store.insert(action.to_owned(), reply);
    }

    pub fn notices(&self) -> Vec<(String, String)> {
        self.log
            .iter()
            .filter(|entry| entry[0] == "notice")
            .map(|entry| {
                (entry[1].as_str().unwrap_or_default().to_owned(), entry[2].as_str().unwrap_or_default().to_owned())
            })
            .collect()
    }

    pub fn messages(&self) -> Vec<String> {
        self.notices().into_iter().map(|(message, _)| message).collect()
    }

    pub fn calls(&self) -> Vec<Value> {
        self.log.iter().filter(|entry| entry[0] == "call").cloned().collect()
    }

    pub fn call_names(&self) -> Vec<String> {
        self.calls().iter().map(|entry| entry[1].as_str().unwrap_or_default().to_owned()).collect()
    }

    pub fn opened(&self) -> Vec<(String, Value)> {
        self.log
            .iter()
            .filter(|entry| entry[0] == "open")
            .map(|entry| (entry[1].as_str().unwrap_or_default().to_owned(), entry[2].clone()))
            .collect()
    }

    pub fn closed_prompts(&self, surface: &str) -> usize {
        self.log.iter().filter(|entry| entry[0] == "setPrompt" && entry[1] == surface && entry[2].is_null()).count()
    }

    pub fn last_prompt(&self, surface: &str) -> Option<Value> {
        self.log.iter().rev().find(|entry| entry[0] == "setPrompt" && entry[1] == surface).map(|entry| entry[2].clone())
    }

    /// Whether a panel is on screen.
    pub fn surface_open(&self) -> bool {
        self.surface_open
    }

    /// Answers the `/stop` confirmation with an item.
    pub fn select(&mut self, value: &str) {
        if let (true, Some(claim)) = (self.surface_open, self.stop_claim) {
            stop_prompt_select(self, claim, value);
        }
    }

    pub fn cancel(&mut self) {
        if let (true, Some(claim)) = (self.surface_open, self.stop_claim) {
            stop_prompt_cancel(self, claim);
        }
    }

    pub fn commit(&mut self) {
        if let Some(committed) = self.committed.take() {
            self.clear_pasted_images(Some(&committed.images));
            self.clear_pasted_texts(Some(&committed.texts));
        }
    }
}

impl AppCtx for Fake {
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String> {
        let Some(reply) = self.store.get(action).cloned() else { return Ok(Value::Null) };
        self.log.push(json!(["call", action, args]));
        if self.esc_during_call {
            self.epoch += 1;
        }
        reply
    }

    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim {
        SurfaceClaim { kind, epoch: self.epoch }
    }

    fn open_picker(&mut self, _kind: PickerKind) -> SurfaceClaim {
        SurfaceClaim { kind: SurfaceKind::Picker, epoch: self.epoch }
    }
}

impl SlashHost for Fake {
    fn state(&self) -> SlashState {
        self.state.clone()
    }

    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.log.push(json!(["notice", text, tone.as_str()]));
    }

    fn push_notice_ttl(&mut self, text: &str, tone: Tone, ttl_ms: u64) {
        self.log.push(json!(["noticeTtl", text, tone.as_str(), ttl_ms]));
    }

    fn now_ms(&self) -> u64 {
        self.clock
    }

    fn has_store_method(&self, name: &str) -> bool {
        self.store.contains_key(name)
            || (name == "submit" && self.submit_sync)
            || (name == "submitAsync" && !self.submit_sync)
    }

    fn clear_context_panel(&mut self) {
        self.log.push(json!(["clearContext"]));
        // Clearing the context panel hands the surface back: the epoch is superseded.
        self.epoch += 1;
    }

    fn close_usage_panel(&mut self) {
        self.log.push(json!(["closeUsage"]));
    }

    fn paint_loading_frame(&mut self, command: &str, title: &str) -> Option<SurfaceClaim> {
        self.log.push(json!(["paint", command, title]));
        self.surface_open = true;
        Some(SurfaceClaim { kind: SurfaceKind::Picker, epoch: self.epoch })
    }

    fn owns_surface(&self, claim: SurfaceClaim) -> bool {
        self.surface_open && claim.epoch == self.epoch
    }

    fn close_surface(&mut self, claim: SurfaceClaim) {
        if self.owns_surface(claim) {
            self.surface_open = false;
            self.epoch += 1;
            self.log.push(json!(["closeSurface"]));
        }
    }

    fn paint_stop_confirm(&mut self, claim: SurfaceClaim, title: &str, commands: &[String]) {
        self.log.push(json!(["paintStop", title, commands]));
        self.surface_open = true;
        self.stop_claim = Some(claim);
    }

    fn open(&mut self, opener: Opener, options: Value) -> Result<(), String> {
        self.log.push(json!(["open", opener.as_str(), options]));
        if self.open_fails.iter().any(|name| name == opener.as_str()) { Err("open failed".to_owned()) } else { Ok(()) }
    }

    fn open_with_return(&mut self, opener: Opener, options: Value, _target: &TextPrompt) -> Result<(), String> {
        self.open(opener, options)
    }

    fn register_project(&mut self, path: &str) -> Result<(), String> {
        self.log.push(json!(["registerProject", path]));
        Ok(())
    }

    fn enter_project(&mut self, target: &str) {
        self.log.push(json!(["enterProject", target]));
    }

    fn login_mcp_server(&mut self, name: &str) {
        self.log.push(json!(["login", name]));
    }

    fn logout_mcp_server(&mut self, name: &str) {
        self.log.push(json!(["logout", name]));
    }

    fn btw_ask(&mut self, question: &str) {
        self.log.push(json!(["btw", question]));
    }

    fn run_doctor(&mut self) -> Result<(), String> {
        self.log.push(json!(["doctor"]));
        self.doctor_fails.clone().map_or(Ok(()), Err)
    }

    fn request_exit(&mut self) {
        self.log.push(json!(["exit"]));
    }

    fn force_render_repaint(&mut self) {
        self.log.push(json!(["repaint"]));
    }

    fn supersede_panel_epoch(&mut self) -> u64 {
        self.epoch += 1;
        self.epoch
    }

    fn is_panel_epoch_current(&self, token: u64) -> bool {
        token == self.epoch
    }

    fn write_token(&self, surface: PromptSurface) -> u64 {
        self.write_tokens[surface_index(surface)]
    }

    fn set_write_token(&mut self, surface: PromptSurface, token: u64) {
        self.write_tokens[surface_index(surface)] = token;
    }

    fn provider_prompt(&self) -> Option<TextPrompt> {
        self.provider.clone()
    }

    fn settings_prompt(&self) -> Option<TextPrompt> {
        self.settings.clone()
    }

    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>) {
        let shown = next.as_ref().map_or(Value::Null, prompt_json);
        self.log.push(json!(["setPrompt", surface_name(surface), shown]));
    }

    fn mark_prompt_submitting(&mut self, surface: PromptSurface, _target: &TextPrompt) {
        self.log.push(json!(["markSubmitting", surface_name(surface)]));
    }

    fn oauth_submitting(&self) -> bool {
        self.oauth
    }

    fn set_oauth_submitting(&mut self, value: bool) {
        self.oauth = value;
        self.log.push(json!(["oauth", value]));
    }

    fn oauth_complete_code(&mut self, target: &TextPrompt, code: &str) -> Result<(), String> {
        let login = target.text("_login");
        if login.is_empty() {
            return Err("OAuth login is no longer active".to_owned());
        }
        self.log.push(json!(["completeCode", code]));
        match login.split_once(':') {
            Some(("reject" | "throw", message)) => Err(message.to_owned()),
            _ => Ok(()),
        }
    }

    fn oauth_success_return(&mut self, target: &TextPrompt) -> bool {
        let had = flag(target, "_successReturn");
        if had {
            self.log.push(json!(["successReturn"]));
        }
        had
    }

    fn oauth_failure_return(&mut self, target: &TextPrompt, error: &str) {
        if flag(target, "_failureReturn") {
            self.log.push(json!(["failureReturn", error]));
        }
    }

    fn provider_after_save(&mut self, target: &TextPrompt) -> bool {
        let had = flag(target, "_afterSave");
        if had {
            self.log.push(json!(["afterSave"]));
        }
        had
    }

    fn clear_model_caches(&mut self, scope: &str) {
        self.log.push(json!(["clearCaches", scope]));
    }

    fn pasted_images(&self) -> BTreeMap<u64, PastedImage> {
        self.images.clone()
    }

    fn pasted_texts(&self) -> BTreeMap<u64, String> {
        self.texts.clone()
    }

    fn clear_pasted_images(&mut self, ids: Option<&BTreeSet<u64>>) {
        self.paste.push(json!(["clearImages", ids_json(ids)]));
    }

    fn clear_pasted_texts(&mut self, ids: Option<&BTreeSet<u64>>) {
        self.paste.push(json!(["clearTexts", ids_json(ids)]));
    }

    fn arm_transcript_follow(&mut self) {
        self.log.push(json!(["armFollow"]));
    }

    fn store_submit(
        &mut self,
        method: &str,
        content: &PromptContent,
        options: Option<&SubmitOptions>,
    ) -> Result<Value, String> {
        self.committed = options.and_then(|options| options.on_committed.clone());
        let content = node_content(content, &self.untyped_images);
        self.log.push(json!(["submit", method, content_json(&content), options_json(options)]));
        if method == "submit" {
            return Ok(self.submit_result.clone().unwrap_or(json!(true)));
        }
        match &self.submit_error {
            Some(error) => Err(error.clone()),
            None => Ok(self.submit_result.clone().unwrap_or(json!(true))),
        }
    }
}

/// Builds the fake of a recorded scenario from its spec.
pub fn fake_from_spec(spec: &Value) -> Fake {
    let mut fake = Fake::new();
    if let Some(state) = spec.get("state").and_then(Value::as_object) {
        fake.state.busy = state.get("busy").and_then(Value::as_bool).unwrap_or(false);
        fake.state.command_busy = state.get("commandBusy").and_then(Value::as_bool).unwrap_or(false);
        if let Some(workflow) = state.get("workflow") {
            fake.state.workflow = workflow.clone();
        }
    }
    for (name, reply) in spec.get("store").and_then(Value::as_object).into_iter().flatten() {
        let scripted = match reply.get("err") {
            Some(error) => Err(error.as_str().unwrap_or_default().to_owned()),
            None => Ok(reply.get("ok").cloned().unwrap_or(Value::Null)),
        };
        fake.script(name, scripted);
    }
    fake.clock = spec.get("clock").and_then(Value::as_u64).unwrap_or(0);
    fake.provider = spec.get("providerPrompt").filter(|prompt| !prompt.is_null()).map(prompt_from);
    fake.settings = spec.get("settingsPrompt").filter(|prompt| !prompt.is_null()).map(prompt_from);
    for (id, image) in spec.get("pastedImages").and_then(Value::as_object).into_iter().flatten() {
        let id: u64 = id.parse().unwrap_or(0);
        if image.get("type").and_then(Value::as_str) != Some("image") {
            fake.untyped_images.insert(image.get("id").and_then(Value::as_u64).unwrap_or(id));
        }
        fake.images.insert(
            id,
            PastedImage {
                id: image.get("id").and_then(Value::as_u64).unwrap_or(id),
                content: image.get("content").and_then(Value::as_str).unwrap_or_default().to_owned(),
                media_type: image.get("mediaType").and_then(Value::as_str).map(str::to_owned),
                metadata_text: image.get("metadataText").and_then(Value::as_str).map(str::to_owned),
            },
        );
    }
    for (id, text) in spec.get("pastedTexts").and_then(Value::as_object).into_iter().flatten() {
        fake.texts.insert(id.parse().unwrap_or(0), text.as_str().unwrap_or_default().to_owned());
    }
    fake.open_fails = spec
        .get("openFails")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    fake.doctor_fails = spec.get("doctorFails").and_then(Value::as_str).map(str::to_owned);
    fake.submit_result = spec.get("submitResult").cloned();
    fake.submit_sync = spec.get("submitSync").and_then(Value::as_bool).unwrap_or(false);
    fake.submit_error = spec.get("submitError").and_then(Value::as_str).map(str::to_owned);
    fake
}

/// The outcome of one scenario.
pub struct Outcome {
    pub log: Vec<Value>,
    pub paste: Vec<Value>,
    pub returns: Vec<Value>,
}

/// Plays the steps of a recorded scenario on the Rust code.
pub fn play(spec: &Value) -> Outcome {
    let mut fake = fake_from_spec(spec);
    let mut guard = CycleGuard::default();
    let mut gate = mixdog_tui::slash::ui_open::UiOpenGate::default();
    let mut returns = Vec::new();
    for step in spec["steps"].as_array().into_iter().flatten() {
        let kind = step[0].as_str().unwrap_or_default();
        let (a, b) = (&step[1], &step[2]);
        let mut timed = false;
        match kind {
            "run" => returns.push(json!(run_slash_command(
                &mut fake,
                a.as_str().unwrap_or_default(),
                b.as_str().unwrap_or_default()
            ))),
            "submit" => returns.push(json!(mixdog_tui::slash::on_submit(&mut fake, a.as_str().unwrap_or_default()))),
            "select" => fake.select(a.as_str().unwrap_or_default()),
            "cancel" => fake.cancel(),
            "commit" => fake.commit(),
            "tick" => fake.clock += a.as_u64().unwrap_or(0),
            "cycle" => {
                timed = true;
                returns
                    .push(json!(mixdog_tui::slash::workflow_cycle::cycle_workflow_from_prompt(&mut fake, &mut guard)));
            }
            "tab" => {
                timed = true;
                let on = |key: &str| a.get(key).and_then(Value::as_bool).unwrap_or(false);
                let overlays = TabCycleOverlays {
                    slash_palette_open: on("slashPaletteOpen"),
                    tool_approval: on("toolApproval"),
                    picker: on("picker"),
                    settings_prompt: on("settingsPrompt"),
                    provider_prompt: on("providerPrompt"),
                    context_panel: on("contextPanel"),
                    usage_panel: on("usagePanel"),
                };
                returns.push(json!(workflow_tab_cycle(&mut fake, &mut guard, overlays)));
            }
            "uiopen" => gate.run(&mut fake, a),
            other => panic!("unknown step {other}"),
        }
        let shown = if timed { json!([guard.pending, guard.last_at]) } else { Value::Null };
        fake.log.push(json!(["state", {"guard": shown}]));
    }
    Outcome { log: fake.log, paste: fake.paste, returns }
}
