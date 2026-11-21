//! The footer rows under the highlighted model (`model-picker/model-footer.mjs`): the selected effort with its glyph, the
//! context percent, Fast, and the remaining parameters.

use mixdog_tui_style::theme::Color as ThemeColor;
use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::picker::layout::FooterInput;
use mixdog_view_model::display::model_display::effort_display_label;
use serde_json::Value;

use super::options::{OPENROUTER_SORT_PARAMETER, fast_display_label, format_context_window};
use super::selection::{RouteSelection, effort_items_for};
use crate::slash::notices::truthy;

fn effort_glyph(value: Option<&str>) -> &'static str {
    match value {
        Some("none") => "\u{25cb}",
        Some("low") => "\u{25d4}",
        Some("medium") => "\u{25d1}",
        Some("high") => "\u{25d5}",
        Some("max") => "\u{25c6}",
        Some("ultra") => "\u{2726}",
        _ => "\u{25cf}",
    }
}

/// The theme key of an effort, resolved at call time so a theme switch re-tones the footer.
fn effort_color(value: Option<&str>) -> ThemeColor {
    theme_color(match value {
        Some("none") => Key::Inactive,
        Some("low") => Key::Warning,
        Some("medium") => Key::Claude,
        Some("max" | "ultra") => Key::Permission,
        _ => Key::Error,
    })
}

fn effort_label(selection: &RouteSelection, value: Option<&str>) -> String {
    let found = selection
        .provider_effort_items()
        .into_iter()
        .find(|effort| effort.get("value").and_then(Value::as_str) == value && value.is_some())
        .and_then(|effort| effort.get("label").filter(|label| truthy(label)).map(mixdog_js::value_to_string));
    effort_display_label(&found.unwrap_or_else(|| value.unwrap_or_default().to_owned()))
}

fn line(glyph: &str, color: ThemeColor, text: String) -> FooterInput {
    FooterInput::Object { glyph: glyph.to_owned(), color: Some(color), text }
}

fn context_footer_line(selection: &mut RouteSelection, model: Option<&Value>) -> Option<FooterInput> {
    let context = model.and_then(|model| selection.context_selection_for(model))?;
    let is_default = context.percent == context.default_percent;
    Some(line(
        "\u{25a3}",
        theme_color(if is_default { Key::Inactive } else { Key::Permission }),
        format!(
            "{}% \u{b7} {}{} \u{b7} C/Shift+C Adjust",
            context.percent,
            format_context_window(context.tokens),
            if is_default { " \u{b7} Default" } else { "" }
        ),
    ))
}

fn fast_footer_line(selection: &mut RouteSelection, model: Option<&Value>) -> Option<FooterInput> {
    if !selection.fast_available(model) {
        return None;
    }
    let fast_on = model.is_some_and(|model| selection.get_selected_fast(model));
    let ultrafast = model.is_some_and(|model| selection.is_ultrafast(model));
    Some(line(
        if fast_on { "\u{25cf}" } else { "\u{25cb}" },
        theme_color(if fast_on { Key::FastMode } else { Key::Inactive }),
        format!("{} \u{b7} Tab Toggle", if ultrafast { "Ultrafast".to_owned() } else { fast_display_label(fast_on) }),
    ))
}

fn parameter_footer_lines(selection: &mut RouteSelection, model: Option<&Value>) -> Vec<FooterInput> {
    let Some(model) = model else { return Vec::new() };
    let parameters = selection.model_parameters_for(model);
    let mut lines = Vec::new();
    for parameter in model.get("modelParameterOptions").and_then(Value::as_array).into_iter().flatten() {
        let id = parameter.get("id").and_then(Value::as_str).unwrap_or_default();
        if id == "context" || id == "serviceTier" {
            continue;
        }
        let value = parameters.get(id).filter(|value| truthy(value)).map(mixdog_js::value_to_string).unwrap_or_default();
        let shown = parameter
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|option| option.get("value").and_then(Value::as_str) == Some(value.as_str()))
            .and_then(|option| option.get("label").filter(|label| truthy(label)).map(mixdog_js::value_to_string))
            .unwrap_or_else(|| value.clone());
        let label = parameter.get("label").filter(|label| truthy(label)).map(mixdog_js::value_to_string).unwrap_or_default();
        lines.push(line(
            "\u{25c7}",
            theme_color(Key::Inactive),
            format!("{label}: {shown} \u{b7} {}", if id == OPENROUTER_SORT_PARAMETER { "R Cycle" } else { "T Toggle" }),
        ));
    }
    lines
}

/// `modelFooter(selection, model)`: the lines under the highlighted row (`None` when the list is empty).
pub fn model_footer(selection: &mut RouteSelection, model: Option<&Value>) -> Vec<FooterInput> {
    let items = model.map_or_else(|| selection.provider_effort_items(), effort_items_for);
    let values: Vec<String> = items.iter().filter_map(|effort| effort.get("value").filter(|value| truthy(value)).map(mixdog_js::value_to_string)).collect();
    let context_line = context_footer_line(selection, model);
    let fast_line = fast_footer_line(selection, model);
    let parameter_lines = parameter_footer_lines(selection, model);
    let rest = |lines: &mut Vec<FooterInput>| {
        lines.extend(context_line.clone());
        lines.extend(fast_line.clone());
        lines.extend(parameter_lines.clone());
    };
    if values.is_empty() {
        let mut lines = Vec::new();
        rest(&mut lines);
        return lines;
    }
    let mut selected = selection.get_selected_effort(model);
    if !selected.as_ref().is_some_and(|effort| values.contains(effort)) {
        selected = model.and_then(|model| selection.model_default_effort(model));
        selection.set_selected_effort(model, selected.clone());
    }
    let effort_line = line(
        effort_glyph(selected.as_deref()),
        effort_color(selected.as_deref()),
        format!("{} Effort \u{2190}/\u{2192} To Adjust", effort_label(selection, selected.as_deref())),
    );
    let mut lines = vec![effort_line];
    rest(&mut lines);
    lines
}
