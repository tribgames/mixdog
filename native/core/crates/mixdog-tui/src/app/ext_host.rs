//! [`ExtensionsHost`]: the MCP, skills, plugins, memory, project, resume and message-selector pickers' side of the application:
//! the picker claim, the prompts, the clipboard and folder dialog, the disabled-skill set and the prompt draft.

use std::collections::BTreeMap;
use std::io::stdout;

use mixdog_term::clipboard::copy_to_clipboard;
use mixdog_term::os::{FolderPick, FolderPickOptions, pick_folder};
use mixdog_term::paste::PastedImage;
use serde_json::Value;

use super::AppState;
use super::picker::AppPicker;
use crate::editor::helpers::HintTone;
use crate::editor::prompt::DraftOverride;
use crate::pickers::extensions::disabled_skills::SkillSet;
use crate::pickers::extensions::{ExtPanel, ExtensionsHost};
use crate::slash::host::{Opener, PromptSurface, TextPrompt, Tone};
use crate::surface::SurfaceClaim;
use crate::surface::epoch::PanelValue;

fn hint_tone(tone: Tone) -> HintTone {
    match tone {
        Tone::Info => HintTone::Info,
        Tone::Warn => HintTone::Warn,
        Tone::Error => HintTone::Error,
    }
}

/// The pasted images a restored message carries: an object keyed by id or a list; an entry needs its content.
fn images_of(value: &Value) -> BTreeMap<u64, PastedImage> {
    let entries: Vec<(Option<u64>, &Value)> = match value {
        Value::Object(map) => map.iter().map(|(key, entry)| (key.parse().ok(), entry)).collect(),
        Value::Array(list) => list.iter().map(|entry| (None, entry)).collect(),
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|(key, entry)| {
            let id = entry.get("id").and_then(Value::as_u64).or(key)?;
            let content = entry.get("content").or_else(|| entry.get("data")).and_then(Value::as_str).filter(|content| !content.is_empty())?;
            let text = |name: &str| entry.get(name).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
            Some((id, PastedImage { id, content: content.to_owned(), media_type: text("mediaType"), metadata_text: text("metadataText") }))
        })
        .collect()
}

/// The pasted texts a restored message carries, keyed by id.
fn texts_of(value: &Value) -> BTreeMap<u64, String> {
    match value {
        Value::Object(map) => map.iter().filter_map(|(key, text)| Some((key.parse().ok()?, text.as_str()?.to_owned()))).collect(),
        _ => BTreeMap::new(),
    }
}

impl ExtensionsHost for AppState {
    fn has_store_method(&self, name: &str) -> bool {
        self.store.has_method(name)
    }

    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.notice(text, tone);
    }

    fn push_plain_notice(&mut self, text: &str) {
        self.store.push_notice(text, "plain");
    }

    fn now_ms(&self) -> u64 {
        self.clock.now()
    }

    fn owns(&self, claim: SurfaceClaim) -> bool {
        self.surface.epoch().is_current(claim.epoch)
    }

    fn paint(&mut self, claim: &mut SurfaceClaim, panel: Option<ExtPanel>) -> bool {
        match self.paint_guarded(*claim, panel.map(AppPicker::Ext)) {
            Some(next) => {
                *claim = next;
                true
            }
            None => false,
        }
    }

    fn close_claim(&mut self, claim: &mut SurfaceClaim) -> bool {
        self.close_guarded(*claim)
    }

    fn clear_context(&mut self, claim: &mut SurfaceClaim) -> bool {
        match self.clear_context_guarded(*claim) {
            Some(next) => {
                *claim = next;
                true
            }
            None => false,
        }
    }

    fn close_usage_panel(&mut self) {
        self.surface.close_usage();
    }

    fn is_panel_epoch_current(&self, token: u64) -> bool {
        self.surface.epoch().is_current(token)
    }

    fn picker_kind(&self) -> Option<String> {
        self.surface.live_picker().map(|picker| picker.kind().to_owned()).filter(|kind| !kind.is_empty())
    }

    fn project_request(&self) -> Option<u64> {
        self.surface.live_picker().and_then(AppPicker::project_request)
    }

    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>) {
        self.set_text_prompt(surface == PromptSurface::Provider, next);
    }

    fn provider_prompt(&self) -> Option<TextPrompt> {
        self.provider_prompt.clone()
    }

    fn open(&mut self, opener: Opener, options: Value) -> Result<(), String> {
        self.open_now(opener, options)
    }

    fn copy_to_clipboard(&mut self, text: &str) -> Result<(), String> {
        copy_to_clipboard(&mut stdout(), text, false).map(|_| ()).map_err(|error| error.to_string())
    }

    fn pick_folder(&mut self, options: &FolderPickOptions) -> FolderPick {
        pick_folder(options)
    }

    fn cwd(&self) -> String {
        match self.store.state().get("cwd").and_then(Value::as_str) {
            Some(cwd) if !cwd.is_empty() => cwd.to_owned(),
            _ => self.options.cwd.clone(),
        }
    }

    fn disabled_skills(&self) -> SkillSet {
        self.disabled_skills.clone()
    }

    fn hold_disabled_skills(&mut self, set: SkillSet) {
        self.disabled_skills = set;
    }

    fn transcript_items(&self) -> Vec<Value> {
        self.store.state().get("items").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn show_prompt_hint(&mut self, text: &str, tone: Tone) {
        let now = self.clock.now();
        self.prompt.hint.show(text, hint_tone(tone), None, now);
    }

    fn clear_prompt_hint(&mut self) {
        self.prompt.hint.clear();
    }

    fn sync_prompt_layout_rows(&mut self, text: &str) {
        self.prompt_layout_value = text.to_owned();
    }

    fn set_prompt_draft_override(&mut self, id: u64, value: &str) {
        self.prompt.publish_override(id, DraftOverride { value: value.to_owned(), cursor: None, selection_anchor: None });
    }

    fn install_pasted_images(&mut self, images: &Value) {
        self.prompt.buffers.images.install(&images_of(images), true);
    }

    fn install_pasted_texts(&mut self, texts: &Value) {
        self.prompt.buffers.texts.install(&texts_of(texts), true);
    }
}
