//! The Web Search model picker (`openWebSearchPicker` of `route-pickers.mjs`): the nested model picker with a web-search
//! catalog and route.

use std::rc::Rc;

use serde_json::{Value, json};

use super::catalog::CatalogKind;
use super::options::{load_provider_display_names, route_label};
use super::picker::{ModelPickerOptions, open_model_picker};
use crate::pickers::common::{Own, PickerFn, PickerHost};
use crate::slash::host::Tone;
use crate::slash::notices::truthy;
use crate::surface::SurfaceKind;

/// The options of `openWebSearchPicker(options)`.
#[derive(Clone, Default)]
pub struct WebSearchOptions {
    /// A route to show instead of the saved one (`routeOverride`).
    pub route_override: Option<Value>,
    pub return_to: Option<PickerFn>,
    pub return_label: Option<String>,
    pub return_on_nested_cancel: bool,
}

/// `openWebSearchPicker(options)`.
pub fn open_web_search_picker(host: &mut dyn PickerHost, options: WebSearchOptions) {
    // Surface claim taken on this keypress: the route read below is a daemon round-trip, so Esc can land before anything
    // paints.
    let own = Own::new(host.claim_surface(SurfaceKind::Picker));
    let current = options.route_override.clone().filter(truthy).or_else(|| {
        host.store_call("getWebSearchRoute", json!([])).ok().filter(truthy)
    });
    if !own.owns(host) {
        return;
    }
    let return_to = options.return_to.clone();
    let immediate_return = options.return_to.clone();
    open_model_picker(
        host,
        ModelPickerOptions {
            title: Some("Web Search Model".to_owned()),
            loading_description: Some("Loading web-search-capable models...".to_owned()),
            provider_description: Some("Choose native web-search provider.".to_owned()),
            model_description: Some("Select native web-search model. Adjust Effort with \u{2190}/\u{2192}.".to_owned()),
            empty_notice: Some("no native web-search models available; connect OpenAI, Grok, Gemini, or Anthropic".to_owned()),
            catalog: CatalogKind::WebSearch,
            current_route: current,
            return_to,
            return_label: Some(options.return_label.filter(|label| !label.is_empty()).unwrap_or_else(|| "Settings".to_owned())),
            return_on_nested_cancel: options.return_on_nested_cancel,
            on_immediate_select: Some(Rc::new(move |host: &mut dyn PickerHost, _route: &Value| match &immediate_return {
                Some(return_to) => return_to(host),
                // Enter inside the nested picker: that keypress owns what it clears.
                None => {
                    let claim = host.claim_surface(SurfaceKind::Picker);
                    host.close_surface(claim);
                }
            })),
            on_select_route: Some(Rc::new(|host: &mut dyn PickerHost, route_input: &Value, _selected: &Value, _effort: &Option<String>| {
                let result = host.store_call("setWebSearchRoute", json!([route_input]))?;
                if !truthy(&result) {
                    host.push_notice("Web-search model save is already running.", Tone::Warn);
                    return Ok(Value::Null);
                }
                let names = load_provider_display_names(host);
                host.push_notice(&format!("Web-search model set to {}", route_label(&result, Some(&names))), Tone::Info);
                Ok(result)
            })),
            ..ModelPickerOptions::default()
        },
    );
}
