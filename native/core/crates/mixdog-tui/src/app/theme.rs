//! The theme methods that stay in this process (`bindLocalThemeMethods` of `index.jsx`) and the theme epoch.
//!
//! The palette lives here: `listThemes`, `getTheme` and `setTheme` are answered from [`mixdog_tui_style::theme`], and a switch is
//! mirrored to the core so its own epoch re-renders the other attached views: `setTheme` with `persist: true` writes `ui.theme`
//! through the core, one with `persist: false` only tells it (the core does not persist it). A failure of the core's side is
//! ignored: the local palette is already applied.

use mixdog_tui_style::theme::{get_theme_setting, get_theme_version, list_themes, set_theme};
use serde_json::{Value, json};

use super::AppState;

impl AppState {
    /// The theme epoch (`state.themeEpoch`): the row heights are measured again for the palette when it changes.
    pub fn theme_epoch(&self) -> u64 {
        get_theme_version()
    }

    /// The answer of a theme call, `None` for any other action.
    pub(crate) fn local_theme_call(&mut self, action: &str, args: &[Value]) -> Option<Result<Value, String>> {
        match action {
            "listThemes" => Some(serde_json::to_value(list_themes()).map_err(|error| error.to_string())),
            "getTheme" => Some(Ok(json!(get_theme_setting()))),
            "setTheme" => Some(self.apply_theme(args)),
            _ => None,
        }
    }

    /// `setTheme(id, { persist = true })`: the palette is applied first, then mirrored to the core.
    fn apply_theme(&mut self, args: &[Value]) -> Result<Value, String> {
        let id = args.first().map(mixdog_js::value_to_string).unwrap_or_default();
        let persist = args.get(1).and_then(|options| options.get("persist")) != Some(&Value::Bool(false));
        let applied = set_theme(&id);
        let _ = self.store.call("setTheme", &[json!(applied.id), json!({ "persist": persist })]);
        serde_json::to_value(applied).map_err(|error| error.to_string())
    }
}
