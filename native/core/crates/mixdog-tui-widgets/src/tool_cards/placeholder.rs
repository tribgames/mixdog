//! The blank card reserved for a freshly started tool still inside its pending-show delay
//! (`tool-execution/pending-placeholder.jsx`).

use mixdog_js::{js_to_lowercase, value_to_string};
use mixdog_view_model::card_model::agent_surface::SKILL_SURFACE_NAMES;
use mixdog_view_model::card_model::is_agent_tool;
use mixdog_view_model::tool_surface::format_tool_surface_default;
use serde_json::Value;

use super::Card;
use crate::Line;

/// The blank rows of a pending card. They mirror the row estimate: a non-aggregate skill or agent surface collapses to one
/// header row, everything else reserves a header and one detail row.
pub(crate) fn render_pending_placeholder(card: &Card) -> Vec<Line> {
    let name = card.prop("name").map(value_to_string).unwrap_or_default();
    let normalized = js_to_lowercase(&format_tool_surface_default(&name, card.prop("args").unwrap_or(&Value::Null)).normalized_name);
    let single_row = !crate::tool_cards::truthy(card.prop("aggregate")) && (SKILL_SURFACE_NAMES.contains(&normalized.as_str()) || is_agent_tool(&normalized));
    let mut rows = card.leading_rows();
    rows.push(Line(String::new()));
    if !single_row {
        rows.push(Line(String::new()));
    }
    rows
}
