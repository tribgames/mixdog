//! Owner: s4-engine-runner
//! Which pages a turn opened for itself (`task-lifecycle.ts`). Task-owned pages are disposable; user pages and explicit handoffs are
//! not. A finished turn is not a finished conversation: the next message usually continues the same work, and closing its pages would
//! throw away the sign-ins, half-filled forms and tab names already reported, so only a turn that ended badly (aborted) reclaims them
//! here. Releasing the whole session (`forget`) does too.

use std::collections::HashMap;
use std::collections::HashSet;

/// A page's owner: the session and the turn that opened it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Owner {
    session: String,
    turn: u64,
}

/// The pages a session's turns own, and the last turn each session finished.
#[derive(Debug, Default)]
pub struct TaskPages {
    owned: HashMap<String, Owner>,
    finished: HashMap<String, u64>,
    /// The sessions with a command in their running turn.
    touched: HashSet<String>,
}

/// `begin` after the turn was already finished.
pub const TASK_FINISHED: &str = "Browser task has already finished.";

impl TaskPages {
    /// The session's running turn: the one after the last that finished. The core never numbers the engine's turns, the engine
    /// counts them as it is told they end.
    pub fn current(&self, session: &str) -> u64 {
        self.finished.get(session).copied().unwrap_or(0) + 1
    }

    /// A command of `turn` starts for `session`. `Ok(false)`: the command names no turn (`0`), so nothing is owned. A command of a
    /// turn already finished is refused.
    pub fn begin(&mut self, session: &str, turn: u64) -> Result<bool, String> {
        if turn == 0 {
            return Ok(false);
        }
        if turn <= self.finished.get(session).copied().unwrap_or(0) {
            return Err(TASK_FINISHED.to_owned());
        }
        self.touched.insert(session.to_owned());
        Ok(true)
    }

    /// Whether a command ran in the session's turn since the last call; the answer is taken (a turn nobody ran a command in has
    /// nothing to finish).
    pub fn take_touched(&mut self, session: &str) -> bool {
        self.touched.remove(session)
    }

    /// The command of `turn` works on `page`; `disposable` marks a page it created (or a hidden helper it owns).
    pub fn use_page(&mut self, session: &str, turn: u64, page: &str, disposable: bool) -> Result<(), String> {
        if !self.begin(session, turn)? {
            return Ok(());
        }
        if disposable || self.owned.contains_key(page) {
            self.owned.insert(page.to_owned(), Owner { session: session.to_owned(), turn });
        }
        Ok(())
    }

    /// The page is kept for the user from now on (a page `open` showed, a handoff).
    pub fn retain(&mut self, page: &str) {
        self.owned.remove(page);
    }

    /// A popup belongs to whoever owned the page that opened it.
    pub fn inherit(&mut self, opener: &str, popup: &str) {
        if let Some(owner) = self.owned.get(opener).cloned() {
            self.owned.entry(popup.to_owned()).or_insert(owner);
        }
    }

    /// Whether the page is owned by a turn.
    pub fn owns(&self, page: &str) -> bool {
        self.owned.contains_key(page)
    }

    /// The turn of `session` ended. Pages that cannot be closed (`can_close` says no: a dialog needing a human answer is a handoff,
    /// never disposable) are retained; when `aborted`, the rest of the turn's pages are released and returned to be closed.
    pub fn finish(&mut self, session: &str, turn: u64, aborted: bool, can_close: impl Fn(&str) -> bool) -> Vec<String> {
        let mark = self.finished.entry(session.to_owned()).or_insert(0);
        *mark = (*mark).max(turn);
        let pages: Vec<String> = self.owned.iter().filter(|(_, owner)| owner.session == session && owner.turn == turn).map(|(page, _)| page.clone()).collect();
        let mut closing = Vec::new();
        for page in pages {
            if !can_close(&page) {
                self.retain(&page);
            } else if aborted {
                self.owned.remove(&page);
                closing.push(page);
            }
        }
        closing.sort();
        closing
    }

    /// A close that failed gives the page back to its turn: it stays owned for a later cleanup (`task-lifecycle.ts`: a close that
    /// throws never reaches the release).
    pub fn reown(&mut self, session: &str, turn: u64, page: &str) {
        self.owned.insert(page.to_owned(), Owner { session: session.to_owned(), turn });
    }

    /// The session is released: its marks and its pages are forgotten.
    pub fn forget(&mut self, session: &str) {
        self.finished.remove(session);
        self.touched.remove(session);
        self.owned.retain(|_, owner| owner.session != session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_without_a_turn_owns_nothing_and_a_finished_turn_refuses_commands() {
        let mut tasks = TaskPages::default();
        assert_eq!(tasks.begin("s1", 0), Ok(false));
        tasks.use_page("s1", 0, "p1", true).unwrap();
        assert!(!tasks.owns("p1"));
        tasks.finish("s1", 3, false, |_| true);
        assert_eq!(tasks.begin("s1", 3), Err(TASK_FINISHED.to_owned()));
        assert_eq!(tasks.begin("s1", 4), Ok(true));
        assert_eq!(tasks.begin("s2", 1), Ok(true));
    }

    #[test]
    fn the_running_turn_is_the_one_after_the_last_that_finished_and_an_idle_turn_has_nothing_to_finish() {
        let mut tasks = TaskPages::default();
        assert_eq!(tasks.current("s1"), 1);
        assert!(!tasks.take_touched("s1"));
        assert_eq!(tasks.begin("s1", 1), Ok(true));
        assert!(tasks.take_touched("s1") && !tasks.take_touched("s1"));
        tasks.finish("s1", 1, false, |_| true);
        assert_eq!((tasks.current("s1"), tasks.current("s2")), (2, 1));
        tasks.begin("s1", 2).unwrap();
        tasks.forget("s1");
        assert_eq!((tasks.current("s1"), tasks.take_touched("s1")), (1, false));
    }

    #[test]
    fn only_a_page_the_turn_made_is_disposable_until_it_uses_one_it_already_owns() {
        let mut tasks = TaskPages::default();
        tasks.use_page("s1", 1, "p1", false).unwrap();
        assert!(!tasks.owns("p1"));
        tasks.use_page("s1", 1, "p2", true).unwrap();
        assert!(tasks.owns("p2"));
        // A later command of a later turn that works on the owned page moves it to that turn.
        tasks.use_page("s1", 2, "p2", false).unwrap();
        assert_eq!(tasks.finish("s1", 1, true, |_| true), Vec::<String>::new());
        assert_eq!(tasks.finish("s1", 2, true, |_| true), ["p2"]);
    }

    #[test]
    fn a_finished_turn_keeps_its_pages_and_an_aborted_one_closes_them_except_a_handoff() {
        let mut tasks = TaskPages::default();
        for page in ["p1", "p2", "p3"] {
            tasks.use_page("s1", 1, page, true).unwrap();
        }
        tasks.use_page("s2", 1, "p9", true).unwrap();
        assert!(tasks.finish("s1", 1, false, |page| page != "p3").is_empty());
        assert!(tasks.owns("p1") && tasks.owns("p2") && !tasks.owns("p3"));
        tasks.use_page("s1", 2, "p4", true).unwrap();
        assert_eq!(tasks.finish("s1", 2, true, |_| true), ["p4"]);
        assert!(tasks.owns("p9"));
    }

    #[test]
    fn a_page_whose_close_failed_is_owned_again_until_the_session_is_forgotten() {
        let mut tasks = TaskPages::default();
        tasks.use_page("s1", 1, "p1", true).unwrap();
        assert_eq!(tasks.finish("s1", 1, true, |_| true), ["p1"]);
        assert!(!tasks.owns("p1"));
        tasks.reown("s1", 1, "p1");
        assert!(tasks.owns("p1"));
        tasks.forget("s1");
        assert!(!tasks.owns("p1"));
    }

    #[test]
    fn a_retained_page_and_a_popup_follow_their_owner_and_forgetting_releases_the_session() {
        let mut tasks = TaskPages::default();
        tasks.use_page("s1", 1, "p1", true).unwrap();
        tasks.inherit("p1", "p2");
        tasks.inherit("p7", "p8");
        assert!(tasks.owns("p2") && !tasks.owns("p8"));
        tasks.retain("p1");
        assert!(!tasks.owns("p1"));
        tasks.forget("s1");
        assert!(!tasks.owns("p2"));
        assert_eq!(tasks.begin("s1", 1), Ok(true));
    }
}
