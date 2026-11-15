//! What a paste turns into before it reaches the prompt (`app/prompt-handlers/paste-pipeline.mjs`, `use-prompt-paste.mjs`):
//! raw text, a folded paste token, or a mix of image references and folded text runs; and the Ctrl+V clipboard path.
//!
//! The readers (an image from a path, the clipboard's text and image) are [`PasteIo`], implemented by the application over
//! `mixdog_term::paste` and the core's `thread/resizeImage`; a reader that blocks runs on a worker and answers the editor's
//! [`PasteReply::Pending`], whose ticket the editor finishes under its staleness guard.

use mixdog_term::os::Platform;
use mixdog_term::paste::{ImageAttachment, should_fold_pasted_text, split_pasted_image_path_candidates};

use crate::editor::helpers::HintTone;
use crate::editor::prompt::{PasteReply, PasteSource};

use super::host::PromptHost;

/// The readers of the paste path.
pub trait PasteIo {
    /// The platform the path syntax and the clipboard readers follow.
    fn platform(&self) -> Platform;
    /// `state.cwd || process.cwd()`: where a relative pasted path is taken from.
    fn paste_cwd(&self) -> String;
    /// `readImageAttachmentFromPath(path, cwd, { provider })`: `Ok(None)` when it is not an image file that exists.
    fn read_image_from_path(&mut self, raw_path: &str) -> Result<Option<ImageAttachment>, String>;
    /// `readClipboardText()`.
    fn read_clipboard_text(&mut self) -> Result<String, String>;
    /// `readClipboardImageAttachment({ provider })`.
    fn read_clipboard_image(&mut self) -> Result<Option<ImageAttachment>, String>;
}

/// What the paste handler answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PasteResult {
    /// The text to insert instead of the pasted one.
    Insert(String),
    /// Insert the pasted text as it is (`undefined`).
    Raw,
    /// Nothing usable was found or the read failed (`false`): nothing is inserted.
    Nothing,
}

impl PasteResult {
    /// The answer the editor's paste callback takes.
    pub fn into_reply(self) -> PasteReply {
        match self {
            PasteResult::Insert(text) => PasteReply::Insert(text),
            PasteResult::Raw => PasteReply::Fallback,
            PasteResult::Nothing => PasteReply::Drop,
        }
    }
}

/// A pasted image path: the image becomes a reference, an unreadable or missing one stays the text that was pasted.
fn attach_image_path(host: &mut dyn PromptHost, path_text: &str) -> String {
    match host.read_image_from_path(path_text) {
        Ok(Some(image)) => {
            let reference = host.prompt().buffers.register_image(&image);
            let name = if image.filename.is_empty() { "image" } else { image.filename.as_str() };
            host.show_prompt_hint(&format!("attached {name}"), HintTone::Plain, None);
            reference
        }
        Ok(None) => path_text.to_owned(),
        Err(error) => {
            host.show_prompt_hint(&format!("image attach failed: {error}"), HintTone::Warn, None);
            path_text.to_owned()
        }
    }
}

/// The fold-or-insert pipeline shared by bracketed paste and the Ctrl+V text path. Without image paths the whole text folds
/// into a token when large, otherwise it is inserted raw: [`PasteResult::Raw`] lets the prompt insert it itself, while
/// `return_raw` answers the text (the clipboard-text path has no pasted text of its own to fall back on). With image paths
/// each one resolves to a reference (or stays text) and every contiguous run of other text folds on its own when large, so the
/// order around the references is kept.
pub fn process_pasted_text(host: &mut dyn PromptHost, raw: &str, return_raw: bool) -> PasteResult {
    let chunks = split_pasted_image_path_candidates(raw, host.platform());
    if !chunks.iter().any(|chunk| chunk.image_path) {
        if should_fold_pasted_text(raw) {
            return PasteResult::Insert(host.prompt().buffers.register_text(raw));
        }
        return if return_raw { PasteResult::Insert(raw.to_owned()) } else { PasteResult::Raw };
    }
    let mut out = String::new();
    let mut run = String::new();
    for chunk in &chunks {
        if chunk.image_path {
            flush_run(host, &mut run, &mut out);
            out.push_str(&attach_image_path(host, &chunk.text));
        } else {
            run.push_str(&chunk.text);
        }
    }
    flush_run(host, &mut run, &mut out);
    PasteResult::Insert(out)
}

/// A run of non-image text: folded into its own token only when over the threshold. The `"\n"` separators between lines are
/// plain text and stay inside the run around them.
fn flush_run(host: &mut dyn PromptHost, run: &mut String, out: &mut String) {
    if run.is_empty() {
        return;
    }
    if should_fold_pasted_text(run) {
        out.push_str(&host.prompt().buffers.register_text(run));
    } else {
        out.push_str(run);
    }
    run.clear();
}

/// Ctrl+V and Meta+V: prefer the clipboard's text (through the same fold pipeline as bracketed paste), fall back to its image.
pub fn paste_from_clipboard(host: &mut dyn PromptHost) -> PasteResult {
    let text = match host.read_clipboard_text() {
        Ok(text) => text,
        Err(error) => return paste_failed(host, &error),
    };
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.is_empty() {
        return process_pasted_text(host, &normalized, true);
    }
    match host.read_clipboard_image() {
        Ok(None) => {
            host.show_prompt_hint("no text or image found on clipboard", HintTone::Plain, None);
            PasteResult::Nothing
        }
        Ok(Some(image)) => {
            let reference = host.prompt().buffers.register_image(&image);
            let name = if image.filename.is_empty() { "clipboard image" } else { image.filename.as_str() };
            host.show_prompt_hint(&format!("attached {name}"), HintTone::Plain, None);
            PasteResult::Insert(reference)
        }
        Err(error) => paste_failed(host, &error),
    }
}

fn paste_failed(host: &mut dyn PromptHost, error: &str) -> PasteResult {
    host.show_prompt_hint(&format!("paste failed: {error}"), HintTone::Warn, None);
    PasteResult::Nothing
}

/// `handlePromptPaste(text, { source })`: bracketed paste and the Ctrl+V shortcut.
pub fn handle_prompt_paste(host: &mut dyn PromptHost, text: &str, source: PasteSource) -> PasteResult {
    if source == PasteSource::ClipboardShortcut && text.is_empty() {
        return paste_from_clipboard(host);
    }
    process_pasted_text(host, text, false)
}
