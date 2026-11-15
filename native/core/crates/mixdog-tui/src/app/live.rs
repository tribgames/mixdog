//! What the running application draws and takes that is not a picker or the prompt box: the spinner row of a running turn
//! (`components/Spinner.jsx` fed as `app-view.jsx`'s `promptSpinner` feeds it), the welcome prompt hint
//! (`app/use-welcome-prompt-hint.mjs`), the inline editor of the provider and settings text-entry prompts
//! (`components/TextEntryPanel.jsx`) and the ctrl+wheel zoom passthrough (`app/use-mouse-input.mjs`).
//!
//! Time is an input as everywhere in the application: the spinner derives its glyph, its timer and its shimmer from the wall
//! clock at the frame (the Node component read `Date.now()`), and asks the loop to wake it again one animation tick later
//! ([`AppState::next_deadline`]); the zoom restore is the terminal layer's own state machine, written to the terminal here.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use mixdog_term::guard::TerminalRestorer;
use mixdog_term::modes::MouseTrackingRestore;
use mixdog_term::KeyFlags;
use mixdog_tui_style::spinner_meta::Quiet;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::sign_in_url::{CopyMethod, CopyStatus, copy_url, is_sign_in_copy_key};
use mixdog_tui_widgets::spinner::{FRAME_MS, REDUCED_MOTION_TICK_MS, SpinnerProgress, render_spinner};
use mixdog_tui_widgets::text_entry::TextEntryDraft;
use serde_json::{Value, json};

use super::AppState;
use super::store::AppStore;
use crate::editor::draft::Draft;
use crate::editor::text_entry::{TextEntryCallbacks, TextEntryEditor, TextEntryProps};
use crate::handlers::draft_flow::{cancel_provider_prompt, cancel_settings_prompt};
use crate::slash::host::{PromptSurface, TextPrompt};
use crate::slash::text_entry::text_entry_clears_by_empty;
use crate::view::hint::{HintInputs, WelcomeProbes};
use crate::view::labels::{provider_prompt_fields, settings_prompt_fields};
use crate::view::spinner::{LiveSpinner, SpinnerContext, spinner_props};

/// The wall clock in milliseconds since the epoch, as `Date.now()` reads it.
fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn text_member(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// `spinner.quiet` (`{ since, wait, tool?, warnMs }`), none when the turn is not quiet.
fn quiet_of(value: Option<&Value>) -> Option<Quiet> {
    let quiet = value.filter(|quiet| quiet.is_object())?;
    Some(Quiet { since: number(quiet, "since"), wait: text_member(quiet, "wait").unwrap_or_default(), tool: text_member(quiet, "tool"), warn_ms: number(quiet, "warnMs") })
}

/// The spinner state the row shows: the turn's own while it is active, else the command status that stands in for it.
fn live_spinner_of(state: &Value) -> Option<LiveSpinner> {
    let active = |key: &str| state.get(key).filter(|value| value.get("active") == Some(&Value::Bool(true)));
    let live = active("spinner").or_else(|| active("commandStatus"))?;
    Some(LiveSpinner {
        verb: text_member(live, "verb"),
        started_at: number(live, "startedAt"),
        output_tokens: live.get("outputTokens").and_then(Value::as_f64),
        tokens: live.get("tokens").and_then(Value::as_f64),
        thinking: live.get("thinking").is_some_and(|thinking| *thinking == Value::Bool(true)),
        thinking_segment_started_at: number(live, "thinkingSegmentStartedAt"),
        thinking_accumulated_ms: number(live, "thinkingAccumulatedMs"),
        quiet: quiet_of(live.get("quiet")),
        mode: text_member(live, "mode").unwrap_or_default(),
    })
}

/// Whether a web search is running: the second slot of the engine's `activeToolSummary` (`shell:web search:agent`, each
/// `count:startedAt`), which `use-transcript-activity.mjs` reads.
fn web_search_active(state: &Value) -> bool {
    let Some(summary) = state.get("activeToolSummary").and_then(Value::as_str) else { return false };
    summary.split(':').nth(2).and_then(|count| count.parse::<f64>().ok()).is_some_and(|count| count != 0.0)
}

/// The inline editor of the text-entry prompt on screen, and what it was made for.
pub(crate) struct TextEntry {
    surface: PromptSurface,
    identity: String,
    editor: TextEntryEditor,
    copy: CopyStatus,
}

/// The editor remounts when the prompt it serves changes: its kind, its title, its seed or its restore epoch (a rejected save
/// restores the entered text under a new epoch, as Node's `key` and reset effect do).
fn text_entry_identity(surface: PromptSurface, prompt: &TextPrompt) -> String {
    format!("{surface:?}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}", prompt.kind, prompt.label, prompt.restore_epoch, prompt.initial_value.as_deref().unwrap_or(""))
}

fn editor_props(surface: PromptSurface, prompt: &TextPrompt) -> TextEntryProps {
    match surface {
        PromptSurface::Provider => TextEntryProps { allow_empty: false, multiline: false, has_detail: !prompt.text("detail").trim().is_empty() },
        PromptSurface::Settings => TextEntryProps {
            allow_empty: text_entry_clears_by_empty(&prompt.kind),
            multiline: prompt.kind == "core-add" || prompt.kind == "core-edit",
            has_detail: false,
        },
    }
}

/// What the editor answers to: the submit goes to the prompt submit of the application, Escape to the cancel of the surface,
/// the copy key to the clipboard.
struct EntryBridge<'a> {
    app: &'a mut AppState,
    surface: PromptSurface,
    detail: String,
    copy: &'a mut CopyStatus,
}

impl TextEntryCallbacks for EntryBridge<'_> {
    fn on_submit(&mut self, value: &str) -> bool {
        crate::slash::on_submit(self.app, value)
    }

    fn on_cancel(&mut self) {
        match self.surface {
            PromptSurface::Provider => cancel_provider_prompt(self.app),
            PromptSurface::Settings => cancel_settings_prompt(self.app),
        }
    }

    fn on_copy_key(&mut self, input: &str, key: &KeyFlags) -> bool {
        if !is_sign_in_copy_key(input, key) {
            return false;
        }
        let url = self.detail.trim().to_owned();
        let status = copy_url(&url, |url| {
            mixdog_term::clipboard::copy_to_clipboard(&mut std::io::stdout(), url, true)
                .map(|outcome| match outcome {
                    mixdog_term::clipboard::CopyOutcome::Terminal => CopyMethod::Terminal,
                    mixdog_term::clipboard::CopyOutcome::Copied => CopyMethod::System,
                })
                .map_err(|error| error.0)
        });
        if let Some(status) = status {
            *self.copy = status;
        }
        true
    }
}

/// The store calls the welcome-hint probes make.
struct StoreProbes<'a>(&'a mut dyn AppStore);

impl WelcomeProbes for StoreProbes<'_> {
    fn call(&mut self, method: &str, args: Value) -> Option<Result<Value, String>> {
        if !self.0.has_method(method) {
            return None;
        }
        // `store.getProviderSetup()` takes no argument: the probe's empty object stands for none.
        let args: Vec<Value> = match args {
            Value::Object(map) if map.is_empty() => Vec::new(),
            other => vec![other],
        };
        Some(self.0.call(method, &args))
    }
}

impl AppState {
    // ---- the spinner row -------------------------------------------------------------------------------------------------

    /// The row of the prompt meta band while a turn (or a command) runs: the verb, the timer, the tokens and the interrupt hint.
    /// The progress (pause accounting, stall smoothing, the counted-up tokens) lives while the row is mounted. The row asks for
    /// the next frame one animation tick after this one.
    pub(crate) fn spinner_rows(&mut self, state: &Value, visible: bool, columns: usize, approval_pending: bool) -> Vec<Line> {
        let live = if visible { live_spinner_of(state) } else { None };
        let Some(live) = live else {
            self.spinner_progress = None;
            self.spinner_tick_due = None;
            return Vec::new();
        };
        let now = epoch_ms();
        let progress = self.spinner_progress.get_or_insert_with(|| SpinnerProgress::new(now, live.started_at));
        let thinking = state.get("thinking") == Some(&Value::Bool(true));
        let effort = state.get("effort").and_then(Value::as_str).unwrap_or("").to_owned();
        let props = spinner_props(&SpinnerContext {
            live: &live,
            thinking,
            effort: &effort,
            web_search_active: web_search_active(state),
            approval_pending,
            busy: state.get("busy") == Some(&Value::Bool(true)),
            spinner_active: state.get("spinner").is_some_and(|spinner| spinner.get("active") == Some(&Value::Bool(true))),
            columns,
        });
        let rows = render_spinner(progress, &props, now, self.reduced_motion);
        let tick = if self.reduced_motion { REDUCED_MOTION_TICK_MS } else { FRAME_MS };
        self.spinner_tick_due = Some(self.clock.now() + tick as u64);
        rows
    }

    // ---- the welcome prompt hint ------------------------------------------------------------------------------------------

    /// What the probes of the welcome hint look at, from the published state.
    fn welcome_inputs(&self) -> HintInputs {
        let state = self.store.state();
        let text = |key: &str| state.get(key).map(mixdog_js::value_to_string).filter(|text| text != "null").unwrap_or_default();
        let toast_error_signature = state
            .get("toasts")
            .and_then(Value::as_array)
            .map(|toasts| {
                toasts
                    .iter()
                    .filter(|toast| toast.get("tone").and_then(Value::as_str) == Some("error"))
                    .map(|toast| {
                        let part = |key: &str| toast.get(key).filter(|value| !value.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
                        format!("{}:{}", part("id"), part("text"))
                    })
                    .collect::<Vec<_>>()
                    .join("|")
            })
            .unwrap_or_default();
        HintInputs { provider: text("provider"), model: text("model"), workflow: state.get("workflow").cloned().unwrap_or(Value::Null), toast_error_signature }
    }

    /// The effect of `useWelcomePromptHint`: the probes run again when the provider, the model, the workflow id or the error
    /// signature changed. They are store calls, so they wait for the background turn ([`AppState::run_background`]) instead of
    /// running inside the publication that asked.
    pub(crate) fn sync_welcome_hint(&mut self) {
        let inputs = self.welcome_inputs();
        if self.welcome_seen.as_ref() != Some(&inputs) {
            self.welcome_seen = Some(inputs.clone());
            self.welcome_pending = Some(inputs);
        }
    }

    /// One run of the probes.
    pub(crate) fn run_welcome_probe(&mut self) {
        let Some(inputs) = self.welcome_pending.take() else { return };
        let mut probes = StoreProbes(&mut *self.store);
        if self.welcome.refresh(&mut probes, &inputs) {
            self.frame_requested = true;
        }
    }

    /// `dismissWelcomePromptHint()`: the draft gained its first character while the hint row is on screen.
    pub(crate) fn dismiss_welcome_hint(&mut self) {
        let visible = self.shell_refs.welcome_prompt_hint_visible;
        if visible && !self.welcome.dismissed() {
            self.frame_requested = true;
        }
        self.welcome.dismiss(visible);
    }

    // ---- the text-entry prompts -------------------------------------------------------------------------------------------

    /// The text-entry prompt on screen: the provider one first, as the floating panel orders them.
    fn active_text_prompt(&self) -> Option<(PromptSurface, &TextPrompt)> {
        self.provider_prompt.as_ref().map(|prompt| (PromptSurface::Provider, prompt)).or_else(|| self.settings_prompt.as_ref().map(|prompt| (PromptSurface::Settings, prompt)))
    }

    /// The editor follows the prompt: one per prompt on screen, remounted when the prompt is replaced.
    pub(crate) fn sync_text_entry(&mut self) {
        let wanted = self.active_text_prompt().map(|(surface, prompt)| (surface, text_entry_identity(surface, prompt), prompt.initial_value.clone().unwrap_or_default()));
        match wanted {
            None => self.text_entry = None,
            Some((_, identity, _)) if self.text_entry.as_ref().is_some_and(|entry| entry.identity == identity) => {}
            Some((surface, identity, seed)) => self.text_entry = Some(TextEntry { surface, identity, editor: TextEntryEditor::new(&seed), copy: CopyStatus::Idle }),
        }
    }

    /// The draft and the copy status the panel of `surface` shows.
    pub(crate) fn text_entry_view(&self, surface: PromptSurface) -> (TextEntryDraft, CopyStatus) {
        match self.text_entry.as_ref().filter(|entry| entry.surface == surface) {
            Some(entry) => {
                let draft: &Draft = entry.editor.draft();
                (TextEntryDraft { value: draft.value.clone(), cursor: draft.cursor, selection_anchor: draft.selection_anchor }, entry.copy)
            }
            None => (TextEntryDraft::default(), CopyStatus::Idle),
        }
    }

    /// One key at the text-entry prompt: typing, the caret and edit chords, Enter to submit (the prompt submit decides), Escape to
    /// cancel (the surface's own cancel), the sign-in copy key. False when no prompt is on screen.
    pub(crate) fn text_entry_key(&mut self, input: &str, key: &KeyFlags) -> bool {
        self.sync_text_entry();
        let Some((surface, prompt)) = self.active_text_prompt() else { return false };
        let props = editor_props(surface, prompt);
        let detail = prompt.text("detail");
        let label = match surface {
            PromptSurface::Provider => provider_prompt_fields(&json!({ "kind": prompt.kind })).prompt_label,
            PromptSurface::Settings => settings_prompt_fields(&prompt.kind).prompt_label.to_owned(),
        };
        let label_width = mixdog_termtext::display_width(&label);
        let Some(mut entry) = self.text_entry.take() else { return false };
        entry.editor.set_content_width(self.view_columns.saturating_sub(4 + label_width).max(1));
        let mut bridge = EntryBridge { app: self, surface, detail, copy: &mut entry.copy };
        entry.editor.handle_key(input, key, &props, &mut bridge);
        entry.editor.end_input_batch();
        self.text_entry = Some(entry);
        self.frame_requested = true;
        true
    }

    /// A bracketed paste into the text-entry prompt: inserted as text, line breaks normalised.
    pub(crate) fn text_entry_paste(&mut self, text: &str) -> bool {
        self.sync_text_entry();
        let Some(entry) = self.text_entry.as_mut() else { return false };
        entry.editor.handle_paste(text);
        self.frame_requested = true;
        true
    }

    // ---- the ctrl+wheel zoom ----------------------------------------------------------------------------------------------

    /// The terminal the application writes its mode changes to (the zoom passthrough turns mouse tracking off and on again).
    pub fn set_terminal(&mut self, terminal: TerminalRestorer) {
        self.zoom = Some(MouseTrackingRestore::new(std::sync::Arc::clone(terminal.modes())));
        self.terminal = Some(terminal);
    }

    /// `passthroughCtrlWheelZoom`: mouse tracking and alternate scroll go off so the terminal zooms its font on a ctrl+wheel;
    /// they come back [`mixdog_term::modes::MOUSE_RESTORE_DELAY`] later (with retries when a write fails).
    pub(crate) fn zoom_passthrough(&mut self) {
        let (Some(terminal), Some(zoom)) = (self.terminal.as_ref(), self.zoom.as_mut()) else { return };
        let Some(bytes) = zoom.passthrough(Instant::now()) else { return };
        if terminal.write(&bytes).is_err() {
            zoom.cancel();
        }
    }

    /// The restore of mouse tracking when it is due.
    pub(crate) fn zoom_restore_due(&mut self) {
        let (Some(terminal), Some(zoom)) = (self.terminal.as_ref(), self.zoom.as_mut()) else { return };
        let now = Instant::now();
        if let Some(bytes) = zoom.poll(now) {
            if terminal.write(&bytes).is_err() {
                zoom.write_failed(now);
            }
        }
    }

    /// When the restore of mouse tracking is due, in clock milliseconds.
    pub(crate) fn zoom_deadline(&self) -> Option<u64> {
        let due = self.zoom.as_ref()?.next_due()?;
        let wait = u64::try_from(due.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(u64::MAX);
        Some(self.clock.now().saturating_add(wait))
    }
}
