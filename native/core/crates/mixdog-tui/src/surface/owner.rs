//! The owning layer of the bottom panels (`app/panel-surface.mjs` and `usePanelOwnership` of `App.jsx`).
//!
//! [`PanelSurface`] holds the picker, the context panel and the usage panel, the supersession counter and the Enter latch.
//! The only way to write a panel is a claim taken at the user action that is allowed to own the screen:
//!
//! ```text
//! let mut own = surface.claim();
//! own.paint(&mut surface, Some(panel));  // guarded write; None clears but keeps the flow
//! own.close(&mut surface);               // Esc: clear and hand ownership back for good
//! let later = own.defer();               // a callback that may settle much later
//! own.run_deferred(&surface, later, f);  // runs `f` only while the claim still holds
//! ```
//!
//! A claim carries the panel epoch it was taken at and every write re-validates it, so a late async result (an Esc that came
//! first, a newer panel that replaced it) is dropped instead of painted. The async races of the Node app (promises and
//! timers settling in any order) are ordered events here: the caller feeds them in the order they settle.
//!
//! Two rules make a claim behave like the hand-written guards it replaces: a paint can itself be the handover (a panel
//! identity change), so a successful write re-arms the claim on the surface it just took; and `close` drops ownership for
//! good, which stops a late ack from re-opening a panel the user dismissed. Use `paint(None)`, not `close`, when the same flow
//! clears the picker and goes on (Enter to prompt).

use super::epoch::{PanelEpoch, PanelValue, should_supersede_panel_epoch};
use super::latch::{EnterLatch, IndexModePanel, resolve_picker_state};
use super::{SurfaceClaim, SurfaceKind};

/// A write the surface made, in the order it made them: what the view has to repaint.
#[derive(Clone, Debug, PartialEq)]
pub enum SurfaceEvent<P, C, U> {
    Picker(Option<P>),
    Context(Option<C>),
    Usage(Option<U>),
}

/// The bottom panels and who owns them. `P` is the picker panel, `C` the context panel, `U` the usage dashboard.
#[derive(Debug)]
pub struct PanelSurface<P, C, U> {
    epoch: PanelEpoch,
    /// The panel on screen as the state holds it (resolved: the index mode is carried over).
    picker: Option<P>,
    /// `livePickerRef`: updated synchronously by every write, so an in-flight guard sees the panel that is on screen at call
    /// time, including one opened by another factory, before the next render commits.
    live_picker: Option<P>,
    context: Option<C>,
    usage: Option<U>,
    usage_generation: u64,
    latch: EnterLatch,
    events: Vec<SurfaceEvent<P, C, U>>,
}

impl<P, C, U> Default for PanelSurface<P, C, U> {
    fn default() -> Self {
        Self {
            epoch: PanelEpoch::new(),
            picker: None,
            live_picker: None,
            context: None,
            usage: None,
            usage_generation: 0,
            latch: EnterLatch::new(),
            events: Vec::new(),
        }
    }
}

impl<P, C, U> PanelSurface<P, C, U>
where
    P: PanelValue + IndexModePanel + Clone,
    C: Clone,
    U: Clone,
{
    pub fn new() -> Self {
        Self::default()
    }

    /// The picker panel on screen.
    pub fn picker(&self) -> Option<&P> {
        self.picker.as_ref()
    }

    /// `livePickerRef.current`.
    pub fn live_picker(&self) -> Option<&P> {
        self.live_picker.as_ref()
    }

    pub fn context(&self) -> Option<&C> {
        self.context.as_ref()
    }

    pub fn usage(&self) -> Option<&U> {
        self.usage.as_ref()
    }

    pub fn epoch(&self) -> &PanelEpoch {
        &self.epoch
    }

    /// `supersedePanelEpoch()`: the user took the surface back (a cancelled text-entry prompt, a newer submit of the same
    /// prompt); every deferred paint issued before it is stale.
    pub fn supersede(&mut self) -> u64 {
        self.epoch.supersede()
    }

    pub fn latch(&self) -> &EnterLatch {
        &self.latch
    }

    /// The latch expiry timer fired.
    pub fn tick(&mut self, now_ms: u64) {
        self.latch.tick(now_ms);
    }

    /// `withPickerEnterLatch(action)`: runs `action` with the latch armed and re-arms the expiry after it.
    pub fn with_enter_latch<R>(&mut self, now_ms: u64, action: impl FnOnce(&mut Self) -> R) -> R {
        self.latch.arm();
        let result = action(self);
        self.latch.finish(now_ms);
        result
    }

    /// The backstop of the render: the live handle follows the committed state.
    pub fn commit_render(&mut self) {
        self.live_picker = self.picker.clone();
    }

    /// The picker setter of `usePanelOwnership`: `update` maps the panel it is given to the next one (a plain value ignores
    /// its argument). It is applied to the live panel (synchronously, for the guards) and to the committed one.
    ///
    /// A real handover (a close, or a replacement by a different panel) gives the surface to what the user is looking at
    /// now and supersedes every deferred paint issued before it. Rebuilding the same panel keeps ownership, and a redundant
    /// null to null (or a first open) is not a handover.
    pub fn update_picker(&mut self, update: impl Fn(Option<&P>) -> Option<P>) {
        let previous = self.live_picker.take();
        self.live_picker = update(previous.as_ref());
        if should_supersede_panel_epoch(previous.as_ref(), self.live_picker.as_ref()) {
            self.epoch.supersede();
        }
        let resolved = resolve_picker_state(self.picker.as_ref(), update(self.picker.as_ref()), &mut self.latch);
        self.picker = resolved;
        self.events.push(SurfaceEvent::Picker(self.picker.clone()));
    }

    /// `setPicker(panel)`.
    pub fn set_picker(&mut self, panel: Option<P>) {
        self.update_picker(|_| panel.clone());
    }

    fn set_context(&mut self, panel: Option<C>) {
        self.context = panel.clone();
        self.events.push(SurfaceEvent::Context(panel));
    }

    fn set_usage(&mut self, dashboard: Option<U>) {
        self.usage = dashboard.clone();
        self.events.push(SurfaceEvent::Usage(dashboard));
    }

    /// The writes made since the last call.
    pub fn take_events(&mut self) -> Vec<SurfaceEvent<P, C, U>> {
        std::mem::take(&mut self.events)
    }

    /// `surface.claim()`: this action takes the surface.
    pub fn claim(&self) -> PanelClaim {
        PanelClaim { token: self.epoch.current(), released: false }
    }

    /// The claim of a panel of `kind` as the application's context passes it around.
    pub fn surface_claim(&self, kind: SurfaceKind) -> SurfaceClaim {
        SurfaceClaim { kind, epoch: self.epoch.current() }
    }

    /// `surface.claimUsage()`: the usage dashboard is not a picker and a streaming update is not a handover, so the picker
    /// epoch cannot express its ownership. It has its own generation, bumped by [`close_usage`](Self::close_usage) (Esc, or a
    /// newer `/usage`) and by every new claim.
    pub fn claim_usage(&mut self) -> UsageClaim {
        self.usage_generation += 1;
        UsageClaim { generation: self.usage_generation }
    }

    /// `surface.closeUsage()`: closing the usage overlay invalidates every dashboard update in flight.
    pub fn close_usage(&mut self) {
        self.usage_generation += 1;
        self.set_usage(None);
    }
}

/// A claim on the picker and context panels, taken at a user action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelClaim {
    token: u64,
    released: bool,
}

/// A callback bound to the epoch of the claim at the moment it was made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deferred {
    token: u64,
}

impl PanelClaim {
    /// Whether this claim still holds the surface.
    pub fn owns<P, C, U>(&self, surface: &PanelSurface<P, C, U>) -> bool {
        !self.released && surface.epoch.is_current(self.token)
    }

    /// `own.paint(panel)`: a guarded write of the picker; `None` clears it. False when the claim no longer holds.
    pub fn paint<P, C, U>(&mut self, surface: &mut PanelSurface<P, C, U>, panel: Option<P>) -> bool
    where
        P: PanelValue + IndexModePanel + Clone,
        C: Clone,
        U: Clone,
    {
        if !self.owns(surface) {
            return false;
        }
        surface.set_picker(panel);
        self.token = surface.epoch.current();
        true
    }

    /// `own.context(panel)`: clearing the context panel hands the surface back exactly as closing a picker does, so it
    /// supersedes: a context open still in flight cannot repaint "Context Usage" after the user pressed Esc. Re-reading the
    /// token keeps this flow (Esc inside a settings picker, which clears context and carries on) working.
    pub fn context<P, C, U>(&mut self, surface: &mut PanelSurface<P, C, U>, panel: Option<C>) -> bool
    where
        P: PanelValue + IndexModePanel + Clone,
        C: Clone,
        U: Clone,
    {
        if !self.owns(surface) {
            return false;
        }
        let clears = panel.is_none();
        surface.set_context(panel);
        if clears {
            surface.epoch.supersede();
        }
        self.token = surface.epoch.current();
        true
    }

    /// `own.close()`: Esc clears the picker and hands ownership back for good.
    pub fn close<P, C, U>(&mut self, surface: &mut PanelSurface<P, C, U>) -> bool
    where
        P: PanelValue + IndexModePanel + Clone,
        C: Clone,
        U: Clone,
    {
        if !self.owns(surface) {
            return false;
        }
        surface.set_picker(None);
        self.released = true;
        true
    }

    /// `own.defer(fn)`: binds a callback that may settle much later to the epoch the claim holds now.
    pub fn defer(&self) -> Deferred {
        Deferred { token: self.token }
    }

    /// Runs `run` when the deferred callback settles, but only while the claim was not released and the epoch it was bound
    /// to is still current.
    pub fn run_deferred<P, C, U, R>(&self, surface: &PanelSurface<P, C, U>, deferred: Deferred, run: impl FnOnce() -> R) -> Option<R> {
        (!self.released && surface.epoch.is_current(deferred.token)).then(run)
    }
}

/// A claim on the usage dashboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageClaim {
    generation: u64,
}

impl UsageClaim {
    pub fn owns<P, C, U>(&self, surface: &PanelSurface<P, C, U>) -> bool {
        self.generation == surface.usage_generation
    }

    /// `own.paint(dashboard)`: a guarded write of the usage panel.
    pub fn paint<P, C, U>(&self, surface: &mut PanelSurface<P, C, U>, dashboard: Option<U>) -> bool
    where
        P: PanelValue + IndexModePanel + Clone,
        C: Clone,
        U: Clone,
    {
        if !self.owns(surface) {
            return false;
        }
        surface.set_usage(dashboard);
        true
    }
}

#[cfg(test)]
mod tests {
    use mixdog_tui_widgets::picker::IndexMode;

    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Panel {
        kind: &'static str,
        title: &'static str,
        mode: Option<IndexMode>,
    }

    impl PanelValue for Panel {
        fn kind(&self) -> &str {
            self.kind
        }
        fn title(&self) -> &str {
            self.title
        }
    }

    impl IndexModePanel for Panel {
        fn index_mode(&self) -> Option<IndexMode> {
            self.mode
        }
        fn with_index_mode(self, mode: IndexMode) -> Self {
            Self { mode: Some(mode), ..self }
        }
    }

    const fn titled(title: &'static str) -> Panel {
        Panel { kind: "", title, mode: None }
    }

    type Surface = PanelSurface<Panel, &'static str, u32>;

    fn painted_titles(events: &[SurfaceEvent<Panel, &'static str, u32>]) -> Vec<Option<&'static str>> {
        events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::Picker(panel) => Some(panel.as_ref().map(|panel| panel.title)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_claim_paints_while_nothing_replaced_it() {
        let mut surface = Surface::new();
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        assert_eq!(surface.picker().map(|panel| panel.title), Some("Settings"));
        assert!(own.paint(&mut surface, Some(titled("Settings"))), "a rebuild of the same panel keeps the claim");
    }

    #[test]
    fn a_paint_that_is_the_handover_rearms_the_claim() {
        let mut surface = Surface::new();
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        assert!(own.paint(&mut surface, Some(titled("Model"))), "replacing the panel supersedes, the claim follows");
        assert!(own.paint(&mut surface, Some(titled("Model"))));
        assert_eq!(surface.picker().map(|panel| panel.title), Some("Model"));
    }

    #[test]
    fn esc_on_the_panel_kills_every_late_paint_of_the_claim() {
        let mut surface = Surface::new();
        surface.set_picker(Some(titled("Settings")));
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Alias"))));
        let deferred = own.defer();
        assert_eq!(own.run_deferred(&surface, deferred, || 1), Some(1));
        surface.take_events();

        surface.set_picker(None);
        assert!(!own.paint(&mut surface, Some(titled("Late"))));
        assert!(!own.owns(&surface));
        assert_eq!(own.run_deferred(&surface, deferred, || 1), None);
        assert!(!own.close(&mut surface));
        assert!(!own.context(&mut surface, Some("ctx")));
        assert_eq!(surface.picker(), None);
        assert_eq!(painted_titles(&surface.take_events()), vec![None]);
    }

    #[test]
    fn a_copy_of_a_claim_dies_with_the_surface_it_held() {
        let mut surface = Surface::new();
        surface.set_picker(Some(titled("Settings")));
        let mut own = surface.claim();
        let mut copy = own.clone();
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        assert!(copy.paint(&mut surface, Some(titled("Settings"))));
        surface.set_picker(None);
        assert!(!own.paint(&mut surface, Some(titled("Settings"))));
        assert!(!copy.paint(&mut surface, Some(titled("Settings"))));
    }

    #[test]
    fn a_paint_that_hands_the_surface_over_leaves_the_other_claims_behind() {
        let mut surface = Surface::new();
        surface.set_picker(Some(titled("Settings")));
        let mut own = surface.claim();
        let mut other = own.clone();
        assert!(own.paint(&mut surface, Some(titled("Model"))));
        assert!(!other.paint(&mut surface, Some(titled("Settings"))));
        assert_eq!(surface.picker().map(|panel| panel.title), Some("Model"));
    }

    #[test]
    fn a_late_ack_does_not_overwrite_the_replacement_panel() {
        let mut surface = Surface::new();
        surface.set_picker(Some(titled("Agents")));
        let mut own = surface.claim();
        surface.set_picker(Some(titled("Provider · OpenAI")));
        assert!(!own.paint(&mut surface, Some(titled("Agents"))));
        assert_eq!(surface.picker().map(|panel| panel.title), Some("Provider · OpenAI"));
    }

    #[test]
    fn an_undisturbed_ack_still_reopens_the_panel() {
        let mut surface = Surface::new();
        surface.set_picker(Some(titled("Agents")));
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Agents"))));
        assert!(own.paint(&mut surface, Some(titled("Agents"))));
    }

    #[test]
    fn close_releases_the_claim_for_good() {
        let mut surface = Surface::new();
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        assert!(own.close(&mut surface));
        assert_eq!(surface.picker(), None);
        assert!(!own.paint(&mut surface, Some(titled("Settings"))));
        assert!(!own.close(&mut surface));
    }

    #[test]
    fn a_first_open_is_not_a_handover_so_a_pending_text_entry_write_stays_valid() {
        let mut surface = Surface::new();
        let own = surface.claim();
        let deferred = own.defer();
        surface.set_picker(Some(titled("Settings")));
        assert_eq!(own.run_deferred(&surface, deferred, || ()), Some(()));
        surface.set_picker(None);
        assert_eq!(own.run_deferred(&surface, deferred, || ()), None);
    }

    #[test]
    fn closing_while_nothing_is_open_does_not_supersede() {
        let mut surface = Surface::new();
        let own = surface.claim();
        surface.set_picker(None);
        assert!(own.owns(&surface));
    }

    #[test]
    fn the_explicit_supersede_of_a_cancelled_prompt_kills_pending_paints() {
        let mut surface = Surface::new();
        let mut own = surface.claim();
        surface.supersede();
        assert!(!own.paint(&mut surface, Some(titled("Late"))));
    }

    #[test]
    fn a_context_open_still_in_flight_cannot_reopen_what_esc_dismissed() {
        let mut surface = Surface::new();
        let mut opening = surface.claim();
        assert!(opening.context(&mut surface, Some("Context Usage")));

        assert!(surface.claim().context(&mut surface, None));

        assert!(!opening.context(&mut surface, Some("Context Usage")), "a late context paint was accepted");
        assert_eq!(surface.take_events(), vec![SurfaceEvent::Context(Some("Context Usage")), SurfaceEvent::Context(None)]);

        let mut reopening = surface.claim();
        assert!(reopening.context(&mut surface, Some("Context Usage")));
        assert_eq!(surface.context(), Some(&"Context Usage"));
    }

    #[test]
    fn clearing_context_mid_flow_keeps_the_flow_that_cleared_it() {
        let mut surface = Surface::new();
        let mut own = surface.claim();
        assert!(own.context(&mut surface, None));
        assert!(own.paint(&mut surface, Some(Panel { kind: "settings", title: "Settings", mode: None })));
        assert_eq!(surface.picker().map(|panel| panel.title), Some("Settings"));
    }

    #[test]
    fn the_live_handle_sees_a_write_before_the_render_commits() {
        let mut surface = Surface::new();
        surface.set_picker(Some(Panel { kind: "mcp-servers", title: "MCP", mode: None }));
        assert_eq!(surface.live_picker().map(|panel| panel.kind), Some("mcp-servers"));
        surface.set_picker(None);
        assert_eq!(surface.live_picker(), None);
        surface.commit_render();
        assert_eq!(surface.live_picker(), surface.picker());
    }

    #[test]
    fn a_function_update_sees_the_panel_on_screen() {
        let mut surface = Surface::new();
        surface.set_picker(Some(titled("Settings")));
        let own = surface.claim();
        surface.update_picker(|previous| previous.map(|panel| Panel { title: "Settings", mode: Some(IndexMode::Never), ..panel.clone() }));
        assert_eq!(surface.picker().and_then(|panel| panel.mode), Some(IndexMode::Never));
        assert!(own.owns(&surface), "the same panel rebuilt is not a handover");
    }

    #[test]
    fn a_picker_opened_from_enter_shows_its_indexes_and_survives_a_rebuild() {
        let mut surface = Surface::new();
        surface.with_enter_latch(0, |surface| surface.set_picker(Some(Panel { kind: "mcp-servers", title: "MCP", mode: None })));
        assert_eq!(surface.picker().and_then(|panel| panel.mode), Some(IndexMode::Always));
        assert!(!surface.latch().is_armed());
        surface.set_picker(Some(Panel { kind: "mcp-servers", title: "MCP · 2", mode: None }));
        assert_eq!(surface.picker().and_then(|panel| panel.mode), Some(IndexMode::Always));
    }

    #[test]
    fn the_enter_latch_expires_when_the_action_opens_no_picker() {
        let mut surface = Surface::new();
        surface.with_enter_latch(10, |_| ());
        assert!(surface.latch().is_armed());
        surface.tick(3009);
        assert!(surface.latch().is_armed());
        surface.tick(3010);
        surface.set_picker(Some(titled("Late")));
        assert_eq!(surface.picker().and_then(|panel| panel.mode), None);
    }

    #[test]
    fn the_usage_generation_follows_close_and_a_newer_claim() {
        let mut surface = Surface::new();
        let first = surface.claim_usage();
        assert!(first.paint(&mut surface, Some(1)));
        assert!(first.paint(&mut surface, Some(2)), "a streaming update is not a handover");
        let second = surface.claim_usage();
        assert!(!first.paint(&mut surface, Some(3)));
        assert!(second.paint(&mut surface, Some(4)));
        surface.close_usage();
        assert!(!second.paint(&mut surface, Some(5)));
        assert_eq!(surface.usage(), None);
        assert_eq!(
            surface.take_events(),
            vec![SurfaceEvent::Usage(Some(1)), SurfaceEvent::Usage(Some(2)), SurfaceEvent::Usage(Some(4)), SurfaceEvent::Usage(None)]
        );
    }

    #[test]
    fn a_settings_rebuild_keeps_ownership_so_its_own_deferred_refresh_lands() {
        let mut surface = Surface::new();
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        let refresh = own.defer();
        surface.set_picker(Some(Panel { kind: "", title: "Settings", mode: Some(IndexMode::Auto) }));
        assert_eq!(own.run_deferred(&surface, refresh, || ()), Some(()));
    }

    #[test]
    fn a_deferred_settings_refresh_cannot_clobber_the_panel_that_replaced_settings() {
        let mut surface = Surface::new();
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        let refresh = own.defer();
        surface.set_picker(Some(titled("Core memories")));
        assert_eq!(own.run_deferred(&surface, refresh, || ()), None);
    }

    #[test]
    fn the_handoff_between_pickers_never_paints_a_null_panel() {
        let mut surface = Surface::new();
        surface.set_picker(Some(titled("Theme")));
        surface.take_events();
        let mut own = surface.claim();
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        assert!(own.paint(&mut surface, Some(titled("Settings"))));
        assert_eq!(painted_titles(&surface.take_events()), vec![Some("Settings"), Some("Settings")]);
    }

    #[test]
    fn esc_on_a_loading_panel_prevents_the_pending_picker_from_appearing_later() {
        let mut surface = Surface::new();
        surface.set_picker(Some(Panel { kind: "slash-loading:workflow", title: "Workflow", mode: None }));
        let mut pending = surface.claim();
        surface.set_picker(None);
        assert!(!pending.paint(&mut surface, Some(titled("Workflow"))));
        assert_eq!(surface.picker(), None);
    }

    #[test]
    fn the_async_picker_replaces_its_loading_panel_when_nothing_intervened() {
        let mut surface = Surface::new();
        let mut pending = surface.claim();
        surface.set_picker(Some(Panel { kind: "slash-loading:workflow", title: "Workflow", mode: None }));
        assert!(pending.paint(&mut surface, Some(titled("Workflow"))));
        assert_eq!(surface.picker().map(|panel| panel.kind), Some(""));
    }
}
