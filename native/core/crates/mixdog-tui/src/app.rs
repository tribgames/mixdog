//! The application state (`src/tui/App.jsx`): every piece of state, ref and effect of the Node component becomes a field of
//! [`AppState`] and an explicit transition, filled by `nr-tui-app-run`. [`AppCtx`] is what the slash dispatch, the pickers
//! and the handlers call back into: the store calls, the surface claims and the picker open requests.

use serde_json::Value;

use crate::pickers::PickerKind;
use crate::surface::{SurfaceClaim, SurfaceKind};

/// The state of the running terminal UI. The fields land with the app task.
#[derive(Debug, Default)]
pub struct AppState {}

/// The calls the application's parts make on their host.
pub trait AppCtx {
    /// A store service call (`store.<action>(args)`), answered with the result value or the error text.
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String>;
    /// Claims the bottom surface for a panel of `kind`.
    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim;
    /// Opens a picker; its result arrives later and is dropped when the claim it was opened under was superseded.
    fn open_picker(&mut self, kind: PickerKind) -> SurfaceClaim;
}
