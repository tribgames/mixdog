//! [`AppCtx`] and [`SlashHost`] for the application: what the slash dispatch, the prompt submit and the Tab workflow cycle
//! call back into. Every method is one thing the Node code reached through `deps`, a React setter or a ref.

use std::collections::{BTreeMap, BTreeSet};

use mixdog_term::paste::{PastedImage, PromptContent, PromptPart};
use serde_json::{Map, Value, json};

use super::picker::{AppPicker, SlashPanel};
use super::{AppAction, AppCtx, AppState};
use crate::panels::btw::BtwHost;
use crate::pickers::PickerKind;
use crate::pickers::extensions::mcp_login;
use crate::pickers::provider::{oauth_failure_return, oauth_success_return, run_return_to};
use crate::slash::host::{Opener, PromptSurface, SlashHost, SlashState, SubmitOptions, TextPrompt, Tone};
use crate::slash::notices::truthy;
use crate::surface::{SurfaceClaim, SurfaceKind};

impl AppCtx for AppState {
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String> {
        self.call_store(action, args)
    }

    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim {
        self.surface.surface_claim(kind)
    }

    fn open_picker(&mut self, kind: PickerKind) -> SurfaceClaim {
        let opener = match kind {
            PickerKind::Model => Opener::Model,
            PickerKind::Provider => Opener::ProviderSetup,
            PickerKind::Settings => Opener::Settings,
            PickerKind::Extensions => Opener::Mcp,
        };
        if let Err(error) = self.open_now(opener, json!({})) {
            self.notice(&format!("panel failed to open: {error}"), Tone::Error);
        }
        self.surface.surface_claim(SurfaceKind::Picker)
    }

    fn run_action(&mut self, action: AppAction) {
        self.apply_action(action);
    }
}

fn text_of(state: &Value, key: &str) -> String {
    match state.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

/// `{ type: 'image', data, mimeType, pasteId }` and the text parts of a prompt, as the session service takes them.
pub(crate) fn content_value(content: &PromptContent) -> Value {
    match content {
        PromptContent::Text(text) => Value::String(text.clone()),
        PromptContent::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|part| match part {
                    PromptPart::Text(text) => json!({ "type": "text", "text": text }),
                    PromptPart::Image { data, mime_type, paste_id } => {
                        json!({ "type": "image", "data": data, "mimeType": mime_type, "pasteId": paste_id })
                    }
                })
                .collect(),
        ),
    }
}

/// The options of `submitPrompt(content, options)` on the wire: `displayText`, `pastedImages` (everything but the bytes, with
/// `sizeBytes`) and `pastedTexts`, keyed by id.
fn options_value(options: &SubmitOptions) -> Value {
    let mut map = Map::new();
    if let Some(display) = &options.display_text {
        map.insert("displayText".to_owned(), json!(display));
    }
    if !options.pasted_images.is_empty() {
        let images: Map<String, Value> = options
            .pasted_images
            .iter()
            .map(|(id, meta)| {
                (
                    id.to_string(),
                    json!({ "id": meta.id, "mediaType": meta.media_type, "metadataText": meta.metadata_text, "sizeBytes": meta.size_bytes }),
                )
            })
            .collect();
        map.insert("pastedImages".to_owned(), Value::Object(images));
    }
    if !options.pasted_texts.is_empty() {
        let texts: Map<String, Value> = options.pasted_texts.iter().map(|(id, text)| (id.to_string(), json!(text))).collect();
        map.insert("pastedTexts".to_owned(), Value::Object(texts));
    }
    Value::Object(map)
}

fn surface_index(surface: PromptSurface) -> usize {
    match surface {
        PromptSurface::Provider => 0,
        PromptSurface::Settings => 1,
    }
}

impl SlashHost for AppState {
    fn state(&self) -> SlashState {
        let state = self.store.state();
        SlashState {
            busy: state.get("busy") == Some(&Value::Bool(true)),
            command_busy: state.get("commandBusy") == Some(&Value::Bool(true)),
            provider: text_of(&state, "provider"),
            model: text_of(&state, "model"),
            workflow: state.get("workflow").cloned().unwrap_or(Value::Null),
        }
    }

    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.notice(text, tone);
    }

    fn push_notice_ttl(&mut self, text: &str, tone: Tone, _ttl_ms: u64) {
        // The store owns a notice's lifetime; the session store's own notices expire on its schedule.
        self.notice(text, tone);
    }

    fn now_ms(&self) -> u64 {
        self.clock.now()
    }

    fn has_store_method(&self, name: &str) -> bool {
        self.store.has_method(name)
    }

    fn clear_context_panel(&mut self) {
        let mut own = self.surface.claim();
        own.context(&mut self.surface, None);
    }

    fn close_usage_panel(&mut self) {
        self.surface.close_usage();
    }

    fn paint_loading_frame(&mut self, command: &str, title: &str) -> Option<SurfaceClaim> {
        let claim = self.surface.surface_claim(SurfaceKind::Picker);
        self.paint_guarded(claim, Some(AppPicker::Slash(SlashPanel::loading(command, title))))
    }

    fn owns_surface(&self, claim: SurfaceClaim) -> bool {
        self.surface.epoch().is_current(claim.epoch)
    }

    fn close_surface(&mut self, claim: SurfaceClaim) {
        self.close_guarded(claim);
    }

    fn paint_stop_confirm(&mut self, claim: SurfaceClaim, title: &str, commands: &[String]) {
        let Some(owned) = self.paint_guarded(claim, Some(AppPicker::Slash(SlashPanel::stop_confirm(claim, title, commands)))) else {
            return;
        };
        // The answer closes the surface under the claim the paint left: the same panel, rebuilt with it.
        self.set_picker(Some(AppPicker::Slash(SlashPanel::stop_confirm(owned, title, commands))));
    }

    fn open(&mut self, opener: Opener, options: Value) -> Result<(), String> {
        self.open_now(opener, options)
    }

    fn open_with_return(&mut self, opener: Opener, options: Value, target: &TextPrompt) -> Result<(), String> {
        let mut options = options;
        if target.fields.get("_returnTo").is_some_and(truthy) {
            options["returnTo"] = json!("settings");
        }
        self.open_now(opener, options)
    }

    fn register_project(&mut self, path: &str) -> Result<(), String> {
        let path = path.to_owned();
        self.with_extensions(|extensions, host| {
            extensions.register_project(host, &path);
        });
        Ok(())
    }

    fn enter_project(&mut self, target: &str) {
        let target = target.to_owned();
        self.with_extensions(|extensions, host| {
            extensions.enter_project(host, &target, true, true);
        });
    }

    fn login_mcp_server(&mut self, name: &str) {
        let name = name.to_owned();
        self.with_extensions(|extensions, host| extensions.login.login(host, &name));
    }

    fn logout_mcp_server(&mut self, name: &str) {
        let name = name.to_owned();
        self.with_extensions(|extensions, host| extensions.login.logout(host, &name));
    }

    fn btw_ask(&mut self, question: &str) {
        let mut btw = std::mem::take(&mut self.btw);
        let ask = btw.ask(self, question);
        // The microtask after `ask`: a dropped ask settles with nothing.
        if btw.dispatch(&*self, &ask) {
            // The model answers on a worker: the loop goes on taking input meanwhile. A store that cannot be called from
            // another thread answers here.
            match self.store.caller() {
                Some(call) => self.paste.ask_btw(call, ask),
                None => {
                    let result = self.call_store("askSide", json!([ask.question]));
                    btw.settle(&*self, &ask, result);
                }
            }
        } else {
            btw.settle(&*self, &ask, Ok(Value::Null));
        }
        self.btw = btw;
    }

    fn run_doctor(&mut self) -> Result<(), String> {
        crate::panels::doctor::run_doctor(self)
    }

    fn request_exit(&mut self) {
        let now = self.clock.now();
        self.prompt.exit.request(now);
    }

    fn force_render_repaint(&mut self) {
        self.repaint_requested = true;
    }

    fn supersede_panel_epoch(&mut self) -> u64 {
        self.surface.supersede()
    }

    fn is_panel_epoch_current(&self, token: u64) -> bool {
        self.surface.epoch().is_current(token)
    }

    fn write_token(&self, surface: PromptSurface) -> u64 {
        self.write_tokens[surface_index(surface)]
    }

    fn set_write_token(&mut self, surface: PromptSurface, token: u64) {
        self.write_tokens[surface_index(surface)] = token;
    }

    fn provider_prompt(&self) -> Option<TextPrompt> {
        self.provider_prompt.clone()
    }

    fn settings_prompt(&self) -> Option<TextPrompt> {
        self.settings_prompt.clone()
    }

    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>) {
        self.set_text_prompt(surface == PromptSurface::Provider, next);
    }

    fn mark_prompt_submitting(&mut self, surface: PromptSurface, target: &TextPrompt) {
        let slot = if surface == PromptSurface::Provider { &mut self.provider_prompt } else { &mut self.settings_prompt };
        if let Some(prompt) = slot.as_mut().filter(|prompt| *prompt == target) {
            prompt.submitting = true;
        }
    }

    fn oauth_submitting(&self) -> bool {
        self.oauth_submitting
    }

    fn set_oauth_submitting(&mut self, value: bool) {
        self.oauth_submitting = value;
    }

    fn oauth_complete_code(&mut self, target: &TextPrompt, code: &str) -> Result<(), String> {
        if mcp_login::is_login_prompt(target) {
            let code = code.to_owned();
            return self
                .with_extensions(|extensions, host| extensions.login.complete_code(host, &code))
                .unwrap_or_else(|| Err("OAuth login is no longer active".to_owned()));
        }
        let flow = target.text("_login");
        if flow.is_empty() {
            return Err("OAuth login is no longer active".to_owned());
        }
        let status = self.call_store("completeOAuthProviderLogin", json!([flow, code]))?;
        match status.get("state").and_then(Value::as_str) {
            Some("failed" | "expired" | "cancelled") => {
                let error = text_of(&status, "error");
                Err(if error.is_empty() { "OAuth login did not complete.".to_owned() } else { error })
            }
            _ => Ok(()),
        }
    }

    fn oauth_success_return(&mut self, target: &TextPrompt) -> bool {
        if mcp_login::is_login_prompt(target) {
            return true;
        }
        if target.fields.get("_successReturn").is_some_and(truthy) {
            oauth_success_return(self);
            return true;
        }
        false
    }

    fn oauth_failure_return(&mut self, target: &TextPrompt, error: &str) {
        if mcp_login::is_login_prompt(target) {
            self.with_extensions(|extensions, host| extensions.login.failure_return(host));
        } else if target.fields.get("_failureReturn").is_some_and(truthy) {
            oauth_failure_return(self, error);
        }
    }

    fn provider_after_save(&mut self, target: &TextPrompt) -> bool {
        target.fields.get("_afterSave").is_some_and(truthy) && run_return_to(self)
    }

    fn clear_model_caches(&mut self, scope: &str) {
        if self.caches.clear(scope) {
            self.onboarding.invalidate_provider_models();
        }
    }

    fn pasted_images(&self) -> BTreeMap<u64, PastedImage> {
        self.prompt.buffers.images.entries().clone()
    }

    fn pasted_texts(&self) -> BTreeMap<u64, String> {
        self.prompt.buffers.texts.entries().clone()
    }

    fn clear_pasted_images(&mut self, ids: Option<&BTreeSet<u64>>) {
        self.prompt.buffers.images.clear_ids(ids);
    }

    fn clear_pasted_texts(&mut self, ids: Option<&BTreeSet<u64>>) {
        self.prompt.buffers.texts.clear_ids(ids);
    }

    fn arm_transcript_follow(&mut self) {
        self.follow_requested = true;
    }

    fn store_submit(&mut self, _method: &str, content: &PromptContent, options: Option<&SubmitOptions>) -> Result<Value, String> {
        let prompt = content_value(content);
        let wire = options.map_or_else(|| Value::Object(Map::new()), options_value);
        let accepted = self.store.submit(&prompt, &wire)?;
        // The session service holds the prompt durably: the pasted snapshots it referenced are cleared (`onCommitted`).
        if accepted {
            if let Some(committed) = options.and_then(|options| options.on_committed.as_ref()) {
                self.prompt.buffers.images.clear_ids(Some(&committed.images));
                self.prompt.buffers.texts.clear_ids(Some(&committed.texts));
            }
        }
        Ok(Value::Bool(accepted))
    }
}

impl BtwHost for AppState {
    fn session_id(&self) -> String {
        text_of(&self.store.state(), "sessionId")
    }

    fn cancel_side(&mut self, session_id: &str) {
        let _ = self.call_store("cancelSide", json!([session_id]));
    }
}
