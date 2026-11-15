//! Up/Down through the recent prompts (`app/prompt-handlers/history-navigation.mjs`, `use-prompt-history-nav.mjs`): one step
//! as a pure decision over the navigation state, then its application to the prompt state.

use crate::editor::prompt::HistoryDirection;
use crate::history::prompt_history_key;

use super::host::PromptHost;

/// Where a walk through the history is (`promptHistoryNavRef`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryNav {
    pub active: bool,
    /// The entry shown, -1 for none.
    pub index: i64,
    /// The draft the walk started from, shown again when it walks back past the newest entry.
    pub seed: String,
    /// The text the walk last put in the box: a different text ends the walk.
    pub last_value: String,
}

impl HistoryNav {
    pub fn idle() -> Self {
        Self { active: false, index: -1, seed: String::new(), last_value: String::new() }
    }
}

impl Default for HistoryNav {
    fn default() -> Self {
        Self::idle()
    }
}

/// What one step decided: `value` is what the prompt shows next (`None`: leave it), `nav` the navigation state to keep
/// (`None`: unchanged), `reset` whether the walk ended, `draft_changed` whether the prompt text was replaced.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NavOutcome {
    pub value: Option<String>,
    pub nav: Option<HistoryNav>,
    pub reset: bool,
    pub draft_changed: bool,
}

/// `navigatePromptHistory`: entries equal to the current text are skipped so Up/Down always moves to something different.
pub fn navigate_prompt_history(
    direction: HistoryDirection,
    current_text: &str,
    empty_draft: bool,
    nav: &HistoryNav,
    history: &[String],
) -> NavOutcome {
    let down = direction == HistoryDirection::Down;
    let current_key = prompt_history_key(current_text);
    if (empty_draft && down) || history.is_empty() {
        return NavOutcome { reset: true, ..NavOutcome::default() };
    }
    if down && !nav.active {
        return NavOutcome::default();
    }
    let active = nav.active && (current_text == nav.last_value || current_text == nav.seed);
    let seed = if active { nav.seed.clone() } else { current_text.to_owned() };
    let step: i64 = if down { -1 } else { 1 };
    let len = history.len() as i64;
    let mut next = (if active { nav.index } else { -1 }) + step;
    while next >= 0 && next < len && prompt_history_key(&history[next as usize]) == current_key {
        next += step;
    }
    if next < 0 {
        return NavOutcome { reset: true, draft_changed: true, value: Some(seed), nav: None };
    }
    if next >= len {
        return NavOutcome::default();
    }
    let value = history[next as usize].clone();
    NavOutcome {
        nav: Some(HistoryNav { active: true, index: next, seed, last_value: value.clone() }),
        value: Some(value),
        draft_changed: true,
        reset: false,
    }
}

/// `handlePromptHistoryNavigate(direction, currentText, meta)`: applies one step to the navigation state, the draft-change flag
/// and the prompt hint; answers the text to show.
pub fn handle_prompt_history_navigate(
    host: &mut dyn PromptHost,
    direction: HistoryDirection,
    current_text: &str,
    empty_draft: bool,
) -> Option<String> {
    let history = host.recent_prompt_history();
    let outcome = navigate_prompt_history(direction, current_text, empty_draft, &host.prompt().history_nav, &history);
    let state = host.prompt();
    if outcome.reset {
        state.reset_history_nav();
    }
    if let Some(nav) = outcome.nav {
        state.history_nav = nav;
    }
    state.hint.clear();
    if outcome.draft_changed {
        state.history_draft_change = true;
    }
    outcome.value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history() -> Vec<String> {
        ["third", "second", "first"].iter().map(|text| (*text).to_owned()).collect()
    }

    /// One step applied to `nav` the way the handler applies it.
    fn step(nav: &mut HistoryNav, direction: HistoryDirection, text: &str, empty_draft: bool) -> (Option<String>, bool) {
        let outcome = navigate_prompt_history(direction, text, empty_draft, nav, &history());
        if outcome.reset {
            *nav = HistoryNav::idle();
        }
        if let Some(next) = outcome.nav {
            *nav = next;
        }
        (outcome.value, outcome.reset)
    }

    #[test]
    fn navigation_walks_recent_prompts_skips_duplicates_of_the_current_text_and_restores_the_seed() {
        use HistoryDirection::{Down, Up};
        let mut nav = HistoryNav::idle();
        assert_eq!(step(&mut nav, Down, "draft", false).0, None, "down while inactive does nothing");
        assert_eq!(step(&mut nav, Up, "draft", false).0.as_deref(), Some("third"));
        assert_eq!(nav, HistoryNav { active: true, index: 0, seed: "draft".into(), last_value: "third".into() });
        assert_eq!(step(&mut nav, Up, "third", false).0.as_deref(), Some("second"));
        assert_eq!(step(&mut nav, Up, "second", false).0.as_deref(), Some("first"));
        assert_eq!(step(&mut nav, Up, "first", false).0, None, "past the oldest entry stays put");
        assert_eq!(step(&mut nav, Down, "first", false).0.as_deref(), Some("second"));
        assert_eq!(step(&mut nav, Down, "second", false).0.as_deref(), Some("third"));
        let (value, reset) = step(&mut nav, Down, "third", false);
        assert_eq!((value.as_deref(), reset), (Some("draft"), true), "below the newest entry the seed comes back");
        assert!(!nav.active);

        assert_eq!(step(&mut nav, Up, "third", false).0.as_deref(), Some("second"), "an entry equal to the current text is skipped");
        let (value, reset) = step(&mut nav, Down, "anything", true);
        assert_eq!((value, reset), (None, true));
    }

    #[test]
    fn an_empty_history_resets_and_a_changed_text_starts_a_new_walk() {
        let outcome = navigate_prompt_history(HistoryDirection::Up, "x", false, &HistoryNav::idle(), &[]);
        assert_eq!(outcome, NavOutcome { reset: true, ..NavOutcome::default() });
        let walking = HistoryNav { active: true, index: 1, seed: "seed".into(), last_value: "second".into() };
        let outcome = navigate_prompt_history(HistoryDirection::Up, "typed", false, &walking, &history());
        assert_eq!(outcome.nav.map(|nav| (nav.index, nav.seed)), Some((0, "typed".to_owned())));
    }
}
