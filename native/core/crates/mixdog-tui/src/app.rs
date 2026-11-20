//! The application state (`src/tui/App.jsx`): every piece of state, ref and effect of the Node component is a field of
//! [`AppState`] and an explicit transition. [`AppCtx`] is what the slash dispatch, the pickers and the handlers call back
//! into: the store calls, the surface claims and the picker open requests.
//!
//! The Node component was a React tree: state in hooks, effects after each commit, factories that closed over a `deps` bag. Here
//! one object owns all of it and implements the host trait of each part ([`slash_host`], [`model_host`], [`settings_host`],
//! [`provider_host`], [`ext_host`], [`panels_host`]); the traits' methods are thin: the shared transitions are the inherent
//! methods below, so there is one implementation of each. Time is an input ([`Clock`]); nothing here sleeps or starts a timer:
//! [`AppState::next_deadline`] says when the run loop must call [`AppState::on_timers`], and [`AppState::run_background`] runs the
//! work that Node ran off the event that asked for it (a catalog refresh, the wizard's prefetch, the usage read).
//!
//! * [`boot`]: the first mount (the project picker present in the first frame, the onboarding verdict, the disabled skills).
//! * [`actions`]: `SlashHost::open` by opener name, and what a picker's continuation asks for ([`AppAction`]).
//! * [`keys`]: the keys of the picker on screen, routed to the family that painted it.
//! * [`timers`]: the deadlines of the panel-side timers.
//! * [`theme`]: the three theme methods that stay in this process, and the theme epoch.

pub mod actions;
pub mod boot;
pub mod clock;
pub mod ext_host;
pub mod input;
pub mod keys;
pub mod live;
pub mod model_host;
pub mod panels_host;
pub mod paste_jobs;
pub mod picker;
pub mod provider_host;
pub mod render;
pub mod settings_host;
pub mod slash_host;
pub mod statusline;
pub mod store;
pub mod theme;
pub mod timers;

use std::collections::VecDeque;
use std::sync::Arc;

use mixdog_term::frame::Grid;
use mixdog_term::selection::SelectionState;
use mixdog_tui_widgets::picker::state::PickerState;
use mixdog_tui_widgets::question::QuestionState;
use serde_json::Value;

use self::clock::Clock;
use self::picker::AppPicker;
use self::store::AppStore;
use crate::editor::{Draft, PromptEditor};
use crate::handlers::PromptState;
use crate::handlers::state::PublishedOverride;
use crate::mouse::{Mouse, MouseConfig};
use crate::panels::ContextPanel;
use crate::panels::btw::BtwController;
use crate::panels::context_refresh::ContextPanelRefresh;
use crate::panels::usage::UsageRequest;
use crate::pickers::PickerKind;
use crate::pickers::common::PickerFn;
use crate::pickers::extensions::Extensions;
use crate::pickers::extensions::disabled_skills::SkillSet;
use crate::pickers::model::catalog::{CatalogRefresh, ModelCatalogCaches};
use crate::pickers::provider::{OnboardingState, Prefetch, ProviderSetup};
use crate::pickers::settings::{PickerController, SettingsState};
use crate::slash::host::{Opener, TextPrompt, Tone};
use crate::slash::ui_open::UiOpenGate;
use crate::slash::workflow_cycle::CycleGuard;
use crate::surface::latch::EnterLatch;
use crate::surface::layout::ShellRefs;
use crate::surface::owner::PanelSurface;
use crate::surface::{SurfaceClaim, SurfaceKind};
use crate::transcript::scroll::coalesce::ScrollCoalescer;
use crate::transcript::scroll::engine::TranscriptScroll;
use crate::transcript::window::heights::ItemHeights;
use crate::transcript::window::row_index::IncrementalRowIndex;
use crate::view::chrome::TerminalChrome;

/// What a picker's continuation asks the application to do (`returnTo`, `onAdvance`, `onBack`, `onCancel`: the functions Node
/// passed around). They name the target instead of closing over it, because a continuation runs against the picker host.
#[derive(Clone, Debug, PartialEq)]
pub enum AppAction {
    /// Opens the picker or panel by opener name.
    Open(Opener, Value),
    /// Next on the wizard's theme step.
    ThemeAdvance,
    /// Back on the wizard's theme step.
    ThemeBack,
    /// Next (finish) on the wizard's output style step.
    OutputStyleAdvance,
    /// Back on the wizard's output style step.
    OutputStyleBack,
    /// Esc anywhere in the wizard: the confirmed skip.
    OnboardingCancel,
}

/// The calls the application's parts make on their host.
pub trait AppCtx {
    /// A store service call (`store.<action>(args)`), answered with the result value or the error text.
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String>;
    /// Claims the bottom surface for a panel of `kind`.
    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim;
    /// Opens a picker; its result arrives later and is dropped when the claim it was opened under was superseded.
    fn open_picker(&mut self, kind: PickerKind) -> SurfaceClaim;
    /// Runs what a continuation asked for. A host that serves none of them does nothing.
    fn run_action(&mut self, _action: AppAction) {}
}

/// How the application is started.
#[derive(Clone, Debug, Default)]
pub struct AppOptions {
    /// `state.cwd || process.cwd()`.
    pub cwd: String,
    /// The version the banner shows.
    pub version: String,
    /// `--onboarding`.
    pub force_onboarding: bool,
    /// The verdict the launcher resolved before the mount (`onboardingCompleted`); none: read it from the store.
    pub onboarding_completed: Option<bool>,
}

/// The state of the running terminal UI.
pub struct AppState {
    pub(crate) store: Box<dyn AppStore>,
    pub(crate) clock: Clock,
    pub(crate) options: AppOptions,
    /// The panel surface: the picker, the context panel and the usage dashboard, the epoch and the claims.
    pub surface: PanelSurface<AppPicker, ContextPanel, Value>,
    pub prompt: PromptState,
    /// `pickerOpenedFromEnterRef` as the prompt handlers see it; the surface keeps its own copy for the picker it opens
    /// ([`AppState::set_picker`] carries the mark across).
    pub(crate) enter_latch: EnterLatch,
    /// `promptLayoutValueRef`: the draft the prompt box reserves rows for.
    pub(crate) prompt_layout_value: String,
    /// The selection of the picker on screen (`usePickerSelection`), and the identity it belongs to.
    pub(crate) picker_state: PickerState,
    pub(crate) picker_identity: String,
    /// The row last reported to the panel's highlight callback.
    pub(crate) picker_highlight: Option<usize>,
    /// The frame's width and the rows the layout budgeted for the picker, as the last frame had them (the page keys read them).
    pub(crate) view_columns: usize,
    pub(crate) picker_visible_rows: usize,
    pub(crate) provider_prompt: Option<TextPrompt>,
    pub(crate) settings_prompt: Option<TextPrompt>,
    /// The `writeTokens` of the text-entry prompts (module-global in Node): provider, then settings.
    pub(crate) write_tokens: [u64; 2],
    pub(crate) oauth_submitting: bool,
    pub(crate) caches: ModelCatalogCaches,
    pub(crate) catalog_jobs: VecDeque<CatalogRefresh>,
    /// The continuations that provider setups opened for a picker will run ([`AppState::hold_continuation`]).
    pub(crate) continuations: Vec<Option<PickerFn>>,
    pub(crate) onboarding: OnboardingState,
    pub(crate) onboarding_active: bool,
    pub(crate) provider_flow: Option<ProviderSetup>,
    pub(crate) prefetches: VecDeque<Prefetch>,
    pub(crate) settings_state: SettingsState,
    pub(crate) settings_picker: Option<Box<dyn PickerController>>,
    /// Taken out for the length of one call into it; an open that arrives meanwhile is queued ([`AppState::pending_opens`]).
    pub(crate) extensions: Option<Extensions>,
    pub(crate) disabled_skills: SkillSet,
    pub(crate) btw: BtwController,
    pub(crate) ui_open: UiOpenGate,
    pub(crate) pending_opens: VecDeque<(Opener, Value)>,
    pub(crate) usage_requests: VecDeque<UsageRequest>,
    /// The sign-in flows being waited for ([`timers`]).
    pub(crate) oauth_watches: Vec<timers::OAuthWatch>,
    /// The first-screen project list still waits for its opener (`_projectInitialPending`), and the disabled-skill set for its read.
    pub(crate) project_boot_pending: bool,
    pub(crate) disabled_skills_pending: bool,
    /// `state.setupChanged` as the last published state had it.
    pub(crate) setup_changed_seen: Value,
    pub(crate) context_refresh: ContextPanelRefresh,
    /// The wizard's first step is launched on the next turn (`setTimeout(0)` of `useOnboardingStart`).
    pub(crate) onboarding_launch_pending: bool,
    /// When the boot-time catalog warm-up is due (`PREFETCH_DELAY_MS` after the mount); `None` once it ran.
    pub(crate) catalog_prefetch_due_ms: Option<u64>,
    /// What the frame is made from: the shell layout refs, the item heights and row index, the scroll state, the draft.
    pub(crate) shell_refs: ShellRefs,
    pub(crate) heights: ItemHeights,
    pub(crate) row_index: IncrementalRowIndex,
    pub(crate) scroll: TranscriptScroll,
    pub(crate) draft: Draft,
    /// The main prompt's editor, taken out for the length of one key.
    pub(crate) editor: Option<PromptEditor>,
    pub(crate) tool_output_expanded: bool,
    /// The debounced size, the one-tick input gate and the extended-keys write.
    pub chrome: TerminalChrome,
    /// `armTranscriptFollow()` was asked; the scroll engine takes it ([`AppState::take_follow_request`]).
    pub(crate) follow_requested: bool,
    /// `store.forceRenderRepaint()` was asked; the frame writer takes it ([`AppState::take_repaint_request`]).
    pub(crate) repaint_requested: bool,
    /// Set by [`AppState::mount`].
    pub(crate) mounted: bool,
    /// The footer under the prompt ([`AppState::set_statusline`]); none paints no line.
    pub(crate) statusline: Option<statusline::AppStatusline>,
    /// The mouse and selection state, taken out for the length of a call into it ([`input`]).
    pub(crate) mouse: Option<Mouse>,
    /// The render selection of the terminal layer and the last frame as the layout drew it (before the highlight).
    pub(crate) render_selection: SelectionState,
    pub(crate) rendered_grid: Option<Grid>,
    pub(crate) scroll_coalescer: ScrollCoalescer,
    /// The selected row of the slash palette (`slashIndex`) and the skills of the `$name` palette.
    pub(crate) slash_index: usize,
    pub(crate) mention_skills: Vec<Value>,
    pub(crate) mention_was_active: bool,
    pub(crate) tab_guard: CycleGuard,
    /// The draft publication the editor applied last, and the editor's draft while a handler asks for it mid-key.
    pub(crate) override_applied: Option<PublishedOverride>,
    pub(crate) live_draft: Option<Draft>,
    /// The tool approval panel: the highlighted row and the approval it belongs to, the question panel's state.
    pub(crate) approval_selected: usize,
    pub(crate) approval_for: Option<String>,
    pub(crate) question_for: Option<String>,
    pub(crate) question_state: Option<QuestionState>,
    /// A handler or a timer changed what the frame shows.
    pub(crate) frame_requested: bool,
    /// The total rows of the last committed transcript (`transcriptTotalRowsRef`).
    pub(crate) prev_total_rows: usize,
    /// The session the transcript window was laid out for.
    pub(crate) window_session: String,
    /// The spinner row's progress while the row is mounted, when the next animation tick is due, and whether motion is reduced
    /// (`MIXDOG_REDUCED_MOTION`, read once).
    pub(crate) spinner_progress: Option<mixdog_tui_widgets::spinner::SpinnerProgress>,
    pub(crate) spinner_tick_due: Option<u64>,
    pub(crate) reduced_motion: bool,
    /// The welcome prompt hint, the inputs its probes last ran for and the ones waiting to run.
    pub(crate) welcome: crate::view::hint::WelcomePromptHint,
    pub(crate) welcome_seen: Option<crate::view::hint::HintInputs>,
    pub(crate) welcome_pending: Option<crate::view::hint::HintInputs>,
    /// The inline editor of the text-entry prompt on screen.
    pub(crate) text_entry: Option<live::TextEntry>,
    /// The terminal mode writes and the restore of mouse tracking after a ctrl+wheel zoom.
    pub(crate) terminal: Option<mixdog_term::guard::TerminalRestorer>,
    pub(crate) zoom: Option<mixdog_term::modes::MouseTrackingRestore>,
    /// The pastes waiting for a read that blocks.
    pub(crate) paste: paste_jobs::PasteJobs,
}

impl AppState {
    /// An application over `store`, not yet mounted ([`AppState::mount`]).
    pub fn new(store: Box<dyn AppStore>, clock: Clock, options: AppOptions) -> Self {
        Self {
            store,
            clock,
            options,
            surface: PanelSurface::new(),
            prompt: PromptState::new(),
            enter_latch: EnterLatch::new(),
            prompt_layout_value: String::new(),
            picker_state: PickerState::default(),
            picker_identity: String::new(),
            picker_highlight: None,
            view_columns: 80,
            picker_visible_rows: 0,
            provider_prompt: None,
            settings_prompt: None,
            write_tokens: [0; 2],
            oauth_submitting: false,
            caches: ModelCatalogCaches::new(),
            catalog_jobs: VecDeque::new(),
            continuations: Vec::new(),
            onboarding: OnboardingState::default(),
            onboarding_active: false,
            provider_flow: None,
            prefetches: VecDeque::new(),
            settings_state: SettingsState::default(),
            settings_picker: None,
            extensions: Some(Extensions::new()),
            disabled_skills: SkillSet::new(),
            btw: BtwController::new(),
            ui_open: UiOpenGate::default(),
            pending_opens: VecDeque::new(),
            usage_requests: VecDeque::new(),
            oauth_watches: Vec::new(),
            project_boot_pending: false,
            disabled_skills_pending: false,
            setup_changed_seen: Value::Null,
            context_refresh: ContextPanelRefresh::new(),
            onboarding_launch_pending: false,
            catalog_prefetch_due_ms: None,
            shell_refs: ShellRefs::default(),
            heights: ItemHeights::default(),
            row_index: IncrementalRowIndex::default(),
            scroll: TranscriptScroll::default(),
            draft: Draft::empty(),
            editor: Some(Self::new_editor()),
            tool_output_expanded: false,
            chrome: TerminalChrome::new(80, 24),
            follow_requested: false,
            repaint_requested: false,
            mounted: false,
            statusline: None,
            mouse: Some(Mouse::new(MouseConfig::from_env(usize::from(mixdog_tui_widgets::statusline::STATUSLINE_BAND_ROWS)))),
            render_selection: SelectionState::default(),
            rendered_grid: None,
            scroll_coalescer: ScrollCoalescer::default(),
            slash_index: 0,
            mention_skills: Vec::new(),
            mention_was_active: false,
            tab_guard: CycleGuard::default(),
            override_applied: None,
            live_draft: None,
            approval_selected: 0,
            approval_for: None,
            question_for: None,
            question_state: None,
            frame_requested: false,
            prev_total_rows: 0,
            window_session: String::new(),
            spinner_progress: None,
            spinner_tick_due: None,
            reduced_motion: mixdog_tui_style::spinner_meta::is_reduced_motion(std::env::var("MIXDOG_REDUCED_MOTION").ok().as_deref()),
            welcome: crate::view::hint::WelcomePromptHint::default(),
            welcome_seen: None,
            welcome_pending: None,
            text_entry: None,
            terminal: None,
            zoom: None,
            paste: paste_jobs::PasteJobs::default(),
        }
    }

    /// The last published store state.
    pub fn store_state(&self) -> Arc<Value> {
        self.store.state()
    }

    /// `state.items.length`.
    pub fn item_count(&self) -> usize {
        self.store.state().get("items").and_then(Value::as_array).map_or(0, Vec::len)
    }

    /// The text-entry prompt of the provider surface.
    pub fn provider_prompt_value(&self) -> Option<&TextPrompt> {
        self.provider_prompt.as_ref()
    }

    /// The text-entry prompt of the settings surface.
    pub fn settings_prompt_value(&self) -> Option<&TextPrompt> {
        self.settings_prompt.as_ref()
    }

    /// The first-run wizard owns the screen: the welcome banner stays reserved while its steps mount.
    pub fn onboarding_active(&self) -> bool {
        self.onboarding_active
    }

    /// `armTranscriptFollow()` was asked since the last call.
    pub fn take_follow_request(&mut self) -> bool {
        std::mem::take(&mut self.follow_requested)
    }

    /// `store.forceRenderRepaint()` was asked since the last call.
    pub fn take_repaint_request(&mut self) -> bool {
        std::mem::take(&mut self.repaint_requested)
    }

    /// `store.pushNotice(text, tone)`.
    pub(crate) fn notice(&mut self, text: &str, tone: Tone) {
        self.store.push_notice(text, tone.as_str());
    }

    /// `store.<action>(...args)` with the three theme methods answered locally (see [`theme`]); `args` is the JSON array of the
    /// positional arguments (`null` for none).
    pub(crate) fn call_store(&mut self, action: &str, args: Value) -> Result<Value, String> {
        let args = match args {
            Value::Array(args) => args,
            Value::Null => Vec::new(),
            other => vec![other],
        };
        if let Some(answer) = self.local_theme_call(action, &args) {
            return answer;
        }
        self.store.call(action, &args)
    }

    /// `setPicker(panel)` through the surface, carrying the Enter mark across: the prompt handlers arm [`AppState::enter_latch`],
    /// the surface resolves the index mode of the picker that opens against its own latch.
    pub(crate) fn set_picker(&mut self, panel: Option<AppPicker>) {
        let now = self.clock.now();
        if self.enter_latch.is_armed() {
            self.surface.with_enter_latch(now, |surface| surface.set_picker(panel));
            if !self.surface.latch().is_armed() {
                self.enter_latch.consume();
            }
        } else {
            self.surface.set_picker(panel);
        }
        if !matches!(self.surface.live_picker(), Some(AppPicker::Settings(_))) {
            self.settings_picker = None;
        }
    }

    /// `own.paint(panel)` for a claim: the guarded write. The claim re-armed on what the write took, `None` when `claim` no
    /// longer holds (nothing is painted).
    pub(crate) fn paint_guarded(&mut self, claim: SurfaceClaim, panel: Option<AppPicker>) -> Option<SurfaceClaim> {
        if !self.surface.epoch().is_current(claim.epoch) {
            return None;
        }
        self.set_picker(panel);
        Some(self.surface.surface_claim(claim.kind))
    }

    /// `own.close()`: the picker clears and ownership is handed back for good: a late result of that picker must not repaint it.
    pub(crate) fn close_guarded(&mut self, claim: SurfaceClaim) -> bool {
        if !self.surface.epoch().is_current(claim.epoch) {
            return false;
        }
        self.set_picker(None);
        if self.surface.epoch().is_current(claim.epoch) {
            self.surface.supersede();
        }
        true
    }

    /// `own.context(null)`: the context panel closes, which supersedes the epoch; the claim re-armed, `None` when it no longer
    /// holds.
    pub(crate) fn clear_context_guarded(&mut self, claim: SurfaceClaim) -> Option<SurfaceClaim> {
        if !self.surface.epoch().is_current(claim.epoch) {
            return None;
        }
        let mut own = self.surface.claim();
        own.context(&mut self.surface, None);
        Some(self.surface.surface_claim(claim.kind))
    }

    /// `setProviderPrompt(next)` / `setSettingsPrompt(next)`.
    pub(crate) fn set_text_prompt(&mut self, provider: bool, next: Option<TextPrompt>) {
        if provider {
            self.provider_prompt = next;
        } else {
            self.settings_prompt = next;
        }
    }
}
