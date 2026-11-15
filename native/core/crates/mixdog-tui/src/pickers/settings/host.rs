//! What the settings pickers ask of the application beyond [`SlashHost`]: the picker panel on the surface, and the two label
//! functions the model pickers own. [`Own`] is the claim of `surface.claim()` over those calls.

use serde_json::Value;

use super::SettingsState;
use super::panel::Panel;
use crate::slash::host::SlashHost;
use crate::surface::SurfaceClaim;

/// The application's side of the settings pickers. The store calls, notices, prompts, openers and the surface ownership
/// checks are those of [`SlashHost`].
pub trait PickerHost: SlashHost {
    /// `surface.claim()`: this action takes the picker surface. The claim holds until the panel epoch is superseded, also
    /// before a panel was painted, so [`SlashHost::owns_surface`] of it is the epoch check alone.
    fn claim_picker(&mut self) -> SurfaceClaim;
    /// Writes `panel` as the picker when `claim` still holds; the answer is the claim re-armed on what the write took (a paint
    /// can itself be the handover), `None` when the claim no longer holds.
    fn paint_panel(&mut self, claim: SurfaceClaim, panel: &Panel) -> Option<SurfaceClaim>;
    /// `own.context(null)`: clears the context panel (that supersedes the epoch); the re-armed claim, `None` when it no longer holds.
    fn clear_context(&mut self, claim: SurfaceClaim) -> Option<SurfaceClaim>;
    /// The Settings picker's own state (the heavy-read cache, the build ticket, the live refresh).
    fn settings_state(&mut self) -> &mut SettingsState;
    /// `routeModelLabel(route)` of the model pickers: `(unset)` for a route with no model.
    fn route_model_label(&self, route: &Value) -> String;
}

/// A callback bound to the epoch a claim held when it was made (`own.defer`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deferred {
    epoch: u64,
}

impl Deferred {
    /// The epoch the callback was bound to.
    pub fn epoch(self) -> u64 {
        self.epoch
    }
}

/// `surface.claim()`: proof that a picker owns the surface, valid until the user hands it to something else or closes it.
#[derive(Clone, Debug)]
pub struct Own {
    claim: SurfaceClaim,
    released: bool,
}

impl Own {
    /// Takes the surface at the user action.
    pub fn take(host: &mut dyn PickerHost) -> Self {
        Self { claim: host.claim_picker(), released: false }
    }

    /// `own.owns()`.
    pub fn owns(&self, host: &dyn PickerHost) -> bool {
        !self.released && host.owns_surface(self.claim)
    }

    /// `own.paint(panel)`: false when the claim no longer holds.
    pub fn paint(&mut self, host: &mut dyn PickerHost, panel: &Panel) -> bool {
        if !self.owns(host) {
            return false;
        }
        match host.paint_panel(self.claim, panel) {
            Some(claim) => {
                self.claim = claim;
                true
            }
            None => false,
        }
    }

    /// `own.context(null)`.
    pub fn clear_context(&mut self, host: &mut dyn PickerHost) -> bool {
        if !self.owns(host) {
            return false;
        }
        match host.clear_context(self.claim) {
            Some(claim) => {
                self.claim = claim;
                true
            }
            None => false,
        }
    }

    /// `own.close()`: Esc clears the picker and hands ownership back for good.
    pub fn close(&mut self, host: &mut dyn PickerHost) -> bool {
        if !self.owns(host) {
            return false;
        }
        host.close_surface(self.claim);
        self.released = true;
        true
    }

    /// `own.defer(fn)`: binds a callback that settles later to the epoch the claim holds now.
    pub fn defer(&self) -> Deferred {
        Deferred { epoch: self.claim.epoch }
    }

    /// Whether the deferred callback may still run: the claim was not released and its epoch is current.
    pub fn holds(&self, host: &dyn PickerHost, deferred: Deferred) -> bool {
        !self.released && host.is_panel_epoch_current(deferred.epoch)
    }
}
