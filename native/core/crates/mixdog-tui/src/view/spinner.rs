//! The spinner row of the prompt cluster (`app-view.jsx`'s `promptSpinner`): what the live spinner of the session state and the
//! rest of the view context become as the props of the spinner widget.

use mixdog_tui_style::spinner_meta::Quiet;
use mixdog_tui_widgets::spinner::SpinnerProps;

/// The spinner state of the session (`state.spinner`, or the command status that stands in for it).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LiveSpinner {
    /// The text of a `reconnecting` turn; the widget's own default when none.
    pub verb: Option<String>,
    pub started_at: f64,
    pub output_tokens: Option<f64>,
    pub tokens: Option<f64>,
    pub thinking: bool,
    pub thinking_segment_started_at: f64,
    pub thinking_accumulated_ms: f64,
    pub quiet: Option<Quiet>,
    /// Empty for none: `responding`.
    pub mode: String,
}

/// What the props depend on besides the spinner state.
#[derive(Clone, Copy, Debug)]
pub struct SpinnerContext<'a> {
    pub live: &'a LiveSpinner,
    /// `state.thinking`.
    pub thinking: bool,
    /// `state.effort`.
    pub effort: &'a str,
    /// A web search is running (`activeTools.web_search.count`).
    pub web_search_active: bool,
    /// A tool approval is waiting: the spinner is paused.
    pub approval_pending: bool,
    /// `state.busy`.
    pub busy: bool,
    /// `state.spinner.active`: the turn spinner, not a command status.
    pub spinner_active: bool,
    /// The cells the spinner row has (`promptSpinnerColumns`).
    pub columns: usize,
}

/// The props of the spinner widget for the prompt meta row (no blank row above it: the row is one line).
pub fn spinner_props(context: &SpinnerContext<'_>) -> SpinnerProps {
    let live = context.live;
    let defaults = SpinnerProps::default();
    SpinnerProps {
        verb: live.verb.clone().unwrap_or(defaults.verb),
        started_at: live.started_at,
        // `outputTokens ?? tokens ?? 0`.
        output_tokens: live.output_tokens.or(live.tokens).unwrap_or(0.0),
        tokens: defaults.tokens,
        thinking: context.thinking || live.thinking,
        thinking_active_since: live.thinking_segment_started_at,
        thinking_ms: live.thinking_accumulated_ms,
        effort: context.effort.to_owned(),
        quiet: live.quiet.clone(),
        has_active_tools: context.web_search_active,
        paused: context.approval_pending,
        interruptible: context.busy && context.spinner_active,
        mode: if live.mode.is_empty() { defaults.mode } else { live.mode.clone() },
        columns: context.columns as f64,
        margin_top: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context<'a>(live: &'a LiveSpinner) -> SpinnerContext<'a> {
        SpinnerContext {
            live,
            thinking: false,
            effort: "high",
            web_search_active: false,
            approval_pending: false,
            busy: true,
            spinner_active: true,
            columns: 60,
        }
    }

    #[test]
    fn the_props_carry_the_turn_state_and_the_row_width() {
        let live = LiveSpinner {
            verb: Some("Thinking".to_owned()),
            started_at: 5.0,
            output_tokens: Some(7.0),
            mode: "responding".to_owned(),
            ..LiveSpinner::default()
        };
        let props = spinner_props(&context(&live));
        assert_eq!((props.verb.as_str(), props.started_at, props.output_tokens, props.columns, props.margin_top), ("Thinking", 5.0, 7.0, 60.0, 0));
        assert!(props.interruptible && !props.paused && !props.thinking);
        assert_eq!((props.effort.as_str(), props.mode.as_str()), ("high", "responding"));
    }

    #[test]
    fn tokens_fall_back_and_the_mode_defaults() {
        let live = LiveSpinner { tokens: Some(3.0), ..LiveSpinner::default() };
        let props = spinner_props(&context(&live));
        assert_eq!((props.output_tokens, props.mode.as_str()), (3.0, "responding"));
        assert_eq!(spinner_props(&context(&LiveSpinner::default())).output_tokens, 0.0);
    }

    #[test]
    fn a_pending_approval_pauses_it_and_a_command_status_is_not_interruptible() {
        let live = LiveSpinner { thinking: true, ..LiveSpinner::default() };
        let mut ctx = context(&live);
        ctx.approval_pending = true;
        ctx.spinner_active = false;
        ctx.web_search_active = true;
        let props = spinner_props(&ctx);
        assert!(props.paused && !props.interruptible && props.thinking && props.has_active_tools);
    }
}
