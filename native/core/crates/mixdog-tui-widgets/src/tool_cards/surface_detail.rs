//! The theme binding of the tool card's status dot (`tool-execution/surface-detail.mjs`). What a surface is and what its
//! outcome is live in the shared card model; only the colour of the outcome is chosen here.

use mixdog_tui_style::Key;
use mixdog_view_model::card_model::derive_tool_outcome_tone;
use mixdog_view_model::card_model::terminal_status::OutcomeToneInput;

/// The theme key of the status dot: running keeps the text colour, a returned failure is a warning, a failed call is an
/// error and everything else is success.
pub fn tool_status_color(input: &OutcomeToneInput) -> Key {
    match derive_tool_outcome_tone(input) {
        "running" => Key::Text,
        "warning" => Key::Warning,
        "error" => Key::Error,
        _ => Key::Success,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn color(input: OutcomeToneInput) -> Key {
        tool_status_color(&input)
    }

    #[test]
    fn the_dot_colour_follows_the_outcome() {
        assert_eq!(color(OutcomeToneInput { pending: true, ..OutcomeToneInput::default() }), Key::Text);
        assert_eq!(color(OutcomeToneInput { terminal_status: "completed", ..OutcomeToneInput::default() }), Key::Success);
        assert_eq!(color(OutcomeToneInput { terminal_status: "cancelled", ..OutcomeToneInput::default() }), Key::Warning);
        assert_eq!(color(OutcomeToneInput { terminal_status: "failed", ..OutcomeToneInput::default() }), Key::Warning);
        assert_eq!(color(OutcomeToneInput { call_failed_count: 1.0, ..OutcomeToneInput::default() }), Key::Error);
        assert_eq!(color(OutcomeToneInput { call_failed_count: 1.0, partial_mutation: true, ..OutcomeToneInput::default() }), Key::Warning);
    }
}
