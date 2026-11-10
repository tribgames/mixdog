//! The startup probes' process-wide cache (`runtime-capabilities.mjs`), kept for the daemon's
//! lifetime so a later session gets exactly the observations the first one did:
//!
//! - the shell-tools line: one slot keyed by PATH; a different PATH replaces it
//!   (`_shellToolsStartupEntry`);
//! - whether `git` is on PATH: remembered for 30 seconds per PATH (`gitExecutablePresent`);
//! - the repository change state per root and the git-ignored names per listed directory: the
//!   first answer is kept, every later use serves it and asks for one refresh in the background
//!   (`_repositoryChangeState`, `_gitIgnoredEntries`), so a session sees at worst the previous
//!   observation. A prewarm's answer is taken by its first use without a refresh (`unserved`).
//!
//! The probes that need a child process are run by the host's async prewarm: it drains
//! [`StartupObservations::take_requests`], runs them through the process service and records the
//! answers. Until an answer is recorded the use reads as a failed probe and is not cached.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_agent::env::Clock;

/// `GIT_PRESENCE_TTL_MS`.
const GIT_PRESENCE_TTL_MS: i64 = 30_000;

/// A probe the host must run and record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeRequest {
    /// `git status --porcelain` for a repository root: record `"clean"`, `"changes present"` or none.
    ChangeState { root: String },
    /// `git check-ignore` for the entries of a directory.
    Ignored { directory: String, names: Vec<String> },
}

#[derive(Default)]
struct ChangeEntry {
    value: Option<String>,
    unserved: bool,
    pending: bool,
}

struct IgnoreEntry {
    names: HashSet<String>,
    ignored: HashSet<String>,
    unserved: bool,
    /// Bumped by every synchronous (miss) probe, so a refresh started before it is discarded.
    generation: u64,
    /// The generation a refresh in flight was started at.
    refresh: Option<u64>,
}

impl IgnoreEntry {
    fn covers(&self, names: &[String]) -> bool {
        self.names.len() == names.len() && names.iter().all(|name| self.names.contains(name))
    }
}

#[derive(Default)]
struct State {
    shell_tools: Option<(String, String)>,
    git_present: Option<(String, i64, bool)>,
    change: HashMap<String, ChangeEntry>,
    ignore: HashMap<String, IgnoreEntry>,
    requests: Vec<ProbeRequest>,
}

pub struct StartupObservations {
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
}

impl StartupObservations {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self { clock, state: Mutex::new(State::default()) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The probes waiting for the host, each once.
    pub fn take_requests(&self) -> Vec<ProbeRequest> {
        std::mem::take(&mut self.state().requests)
    }

    /// Records a change-state answer (`None` is a failed probe); `prewarm` marks a boot-time answer
    /// whose first use starts no refresh.
    pub fn record_change_state(&self, root: &str, value: Option<String>, prewarm: bool) {
        self.state().change.insert(root.to_owned(), ChangeEntry { value, unserved: prewarm, pending: false });
    }

    /// Records the git-ignored names among `names` of `directory`. `prewarm` is a synchronous
    /// answer (a miss resolved before composing, or the boot prewarm): it replaces the observation
    /// and is fresh for its first use. Otherwise it is a refresh's answer, applied only if no
    /// synchronous answer came since the refresh started.
    pub fn record_ignored(&self, directory: &str, names: Vec<String>, ignored: HashSet<String>, prewarm: bool) {
        let mut state = self.state();
        let names: HashSet<String> = names.into_iter().collect();
        let Some(entry) = state.ignore.get_mut(directory) else {
            if prewarm {
                state.ignore.insert(directory.to_owned(), IgnoreEntry { names, ignored, unserved: true, generation: 0, refresh: None });
            }
            return;
        };
        if prewarm {
            entry.names = names;
            entry.ignored = ignored;
            entry.unserved = true;
            entry.generation += 1;
        } else {
            if entry.refresh == Some(entry.generation) {
                entry.names = names;
                entry.ignored = ignored;
            }
            entry.refresh = None;
        }
    }

    /// Whether an observation exists that serves `request`: what is asked for and not answered
    /// is a miss the host resolves before the composition goes on.
    pub fn answers(&self, request: &ProbeRequest) -> bool {
        let state = self.state();
        match request {
            ProbeRequest::ChangeState { root } => state.change.contains_key(root),
            ProbeRequest::Ignored { directory, names } => state.ignore.get(directory).is_some_and(|entry| entry.covers(names)),
        }
    }
    /// Records the POSIX login-shell probe's line for `path_env`.
    pub fn record_shell_tools(&self, path_env: &str, line: &str) {
        self.state().shell_tools = Some((path_env.to_owned(), line.to_owned()));
    }

    /// The shell-tools line for `path_env`: the cached one, else `compute`d now and kept.
    pub(super) fn shell_tools(&self, path_env: &str, compute: impl FnOnce() -> Option<String>) -> String {
        let mut state = self.state();
        if let Some((key, line)) = &state.shell_tools
            && key == path_env
        {
            return line.clone();
        }
        let Some(line) = compute() else { return String::new() };
        state.shell_tools = Some((path_env.to_owned(), line.clone()));
        line
    }

    /// `gitExecutablePresent`: the PATH walk, remembered for 30 seconds.
    pub(super) fn git_present(&self, path_env: &str, walk: impl FnOnce() -> bool) -> bool {
        let now = self.clock.now_ms();
        let mut state = self.state();
        if let Some((key, at, present)) = &state.git_present
            && key == path_env
            && now - at < GIT_PRESENCE_TTL_MS
        {
            return *present;
        }
        let present = walk();
        state.git_present = Some((path_env.to_owned(), now, present));
        present
    }

    pub(super) fn change_state(&self, root: &str) -> Option<String> {
        let mut state = self.state();
        let request = ProbeRequest::ChangeState { root: root.to_owned() };
        let Some(entry) = state.change.get_mut(root) else {
            if !state.requests.contains(&request) {
                state.requests.push(request);
            }
            return None;
        };
        let value = entry.value.clone();
        if entry.unserved {
            entry.unserved = false;
        } else if !entry.pending {
            entry.pending = true;
            state.requests.push(request);
        }
        value
    }

    /// The ignored names among `names`. Any observation that does not cover exactly these names
    /// is a miss (`_coversNames`): a probe is requested, nothing is ignored meanwhile, and the
    /// host resolves it before the composition goes on.
    pub(super) fn ignored(&self, directory: &str, names: &[String]) -> HashSet<String> {
        let mut state = self.state();
        let request = ProbeRequest::Ignored { directory: directory.to_owned(), names: names.to_vec() };
        let Some(entry) = state.ignore.get_mut(directory).filter(|entry| entry.covers(names)) else {
            if !state.requests.contains(&request) {
                state.requests.push(request);
            }
            return HashSet::new();
        };
        let ignored = entry.ignored.clone();
        if entry.unserved {
            entry.unserved = false;
        } else if entry.refresh.is_none() {
            entry.refresh = Some(entry.generation);
            state.requests.push(request);
        }
        ignored
    }
}
#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::Ordering;

    use super::*;

    struct Ticking(AtomicI64);

    impl Clock for Ticking {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn observations() -> (StartupObservations, Arc<Ticking>) {
        let clock = Arc::new(Ticking(AtomicI64::new(0)));
        (StartupObservations::new(clock.clone()), clock)
    }

    #[test]
    fn the_first_shell_tools_line_is_kept_until_the_path_changes() {
        let (probes, _) = observations();
        assert_eq!(probes.shell_tools("A", || Some("first".into())), "first");
        assert_eq!(probes.shell_tools("A", || Some("second".into())), "first");
        assert_eq!(probes.shell_tools("B", || Some("other".into())), "other");
        assert_eq!(probes.shell_tools("A", || None), "", "a failed probe renders nothing and is not kept");
    }

    #[test]
    fn git_presence_is_remembered_for_thirty_seconds_per_path() {
        let (probes, clock) = observations();
        assert!(probes.git_present("A", || true));
        clock.0.store(29_999, Ordering::SeqCst);
        assert!(probes.git_present("A", || false));
        assert!(!probes.git_present("B", || false));
        clock.0.store(29_999 + 29_999, Ordering::SeqCst);
        assert!(!probes.git_present("B", || true), "within the window of the last walk");
        clock.0.store(29_999 + 30_000, Ordering::SeqCst);
        assert!(probes.git_present("B", || true));
    }

    #[test]
    fn a_later_session_gets_the_previous_change_state_and_one_refresh_is_asked() {
        let (probes, _) = observations();
        assert_eq!(probes.change_state("/r"), None);
        assert_eq!(probes.take_requests(), [ProbeRequest::ChangeState { root: "/r".into() }]);
        probes.record_change_state("/r", Some("clean".into()), false);
        assert_eq!(probes.change_state("/r").as_deref(), Some("clean"));
        assert_eq!(probes.change_state("/r").as_deref(), Some("clean"));
        assert_eq!(probes.take_requests(), [ProbeRequest::ChangeState { root: "/r".into() }], "one refresh in flight");
        probes.record_change_state("/r", Some("changes present".into()), false);
        assert_eq!(probes.change_state("/r").as_deref(), Some("changes present"));
    }

    #[test]
    fn a_prewarmed_answer_is_fresh_for_its_first_use() {
        let (probes, _) = observations();
        probes.record_change_state("/r", Some("clean".into()), true);
        assert_eq!(probes.change_state("/r").as_deref(), Some("clean"));
        assert!(probes.take_requests().is_empty());
        assert_eq!(probes.change_state("/r").as_deref(), Some("clean"));
        assert_eq!(probes.take_requests().len(), 1);
    }

    #[test]
    fn ignored_names_are_served_only_for_the_names_they_were_asked_about() {
        let (probes, _) = observations();
        let names = vec!["a".to_owned(), "b".to_owned()];
        assert!(probes.ignored("/d", &names).is_empty());
        probes.record_ignored("/d", names.clone(), HashSet::from(["b".to_owned()]), true);
        assert_eq!(probes.take_requests().len(), 1);
        assert_eq!(probes.ignored("/d", &names), HashSet::from(["b".to_owned()]));
        assert!(probes.take_requests().is_empty());
        let more = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        assert!(probes.ignored("/d", &more).is_empty());
        assert_eq!(probes.take_requests(), [ProbeRequest::Ignored { directory: "/d".into(), names: more }]);
    }

    /// Name sets A → B → A: each change is a miss resolved synchronously (`runtime-capabilities.mjs`
    /// `_gitIgnoredEntries`), never a refresh of a stale observation that shows ignored entries.
    #[test]
    fn a_name_set_that_comes_back_is_a_miss_not_a_refresh() {
        let (probes, _) = observations();
        let a = vec!["keep".to_owned(), "skip".to_owned()];
        let b = vec!["keep".to_owned(), "other".to_owned()];
        let ask = |names: &Vec<String>| ProbeRequest::Ignored { directory: "/d".into(), names: names.clone() };
        assert!(!probes.answers(&ask(&a)));
        probes.record_ignored("/d", a.clone(), HashSet::from(["skip".to_owned()]), true);
        assert!(probes.answers(&ask(&a)));
        assert!(!probes.answers(&ask(&b)), "B is not covered by A's observation");
        assert!(probes.ignored("/d", &b).is_empty());
        probes.record_ignored("/d", b.clone(), HashSet::new(), true);
        assert!(!probes.answers(&ask(&a)), "A is not covered by B's observation");
        probes.take_requests();
        assert!(probes.ignored("/d", &a).is_empty(), "a miss serves nothing");
        assert_eq!(probes.take_requests(), [ask(&a)]);
        probes.record_ignored("/d", a.clone(), HashSet::from(["skip".to_owned()]), true);
        assert_eq!(probes.ignored("/d", &a), HashSet::from(["skip".to_owned()]));
    }

    /// A refresh started before a synchronous probe is discarded (`generation`).
    #[test]
    fn a_refresh_that_started_before_a_miss_answer_is_discarded() {
        let (probes, _) = observations();
        let a = vec!["keep".to_owned(), "skip".to_owned()];
        let b = vec!["keep".to_owned()];
        probes.record_ignored("/d", a.clone(), HashSet::from(["skip".to_owned()]), true);
        probes.ignored("/d", &a);
        probes.ignored("/d", &a);
        assert_eq!(probes.take_requests().len(), 1, "the second use starts the refresh");
        probes.record_ignored("/d", b.clone(), HashSet::new(), true);
        probes.record_ignored("/d", a.clone(), HashSet::new(), false);
        assert!(probes.answers(&ProbeRequest::Ignored { directory: "/d".into(), names: b }), "the late refresh of A did not replace B");
        assert!(!probes.answers(&ProbeRequest::Ignored { directory: "/d".into(), names: a }));
    }
}