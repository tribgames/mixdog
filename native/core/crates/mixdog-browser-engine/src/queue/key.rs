//! Owner: s4-engine-queue
//! The queue a command belongs to: session metadata, the visible page, or one named background page
//! (`command-queue-key.ts`). Commands on different keys run in parallel.

use std::fmt;

/// The longest background tab name (`MAX_BACKGROUND_TAB_NAME_CHARS` of `tab-policy.ts`).
const MAX_BACKGROUND_TAB_NAME_CHARS: usize = 64;

/// What the key of a command is derived from: its session, its action and the page it names.
#[derive(Debug, Clone, Copy, Default)]
pub struct KeyInput<'a> {
    /// The owning session; empty or absent for a command with none.
    pub session: Option<&'a str>,
    /// The command's action as given (trimmed and lower-cased here).
    pub action: &'a str,
    /// The command's `tab`: a page id (`p2`), a visual tab (`v1`) or a background tab name.
    pub tab: &'a str,
    /// The command asks for a background page.
    pub background: bool,
}

/// What the key derivation asks of the session's tabs.
pub trait QueueKeyHost {
    /// The selected physical page of `session`, support tabs included: tab-less work resolves to it.
    fn current_page_id(&self, _session: &str) -> Option<String> {
        None
    }

    /// The background page named `name` of `session`.
    fn background_page_id(&self, _session: &str, _name: &str) -> Option<String> {
        None
    }

    /// The name of the background page `page_id` of `session`, when it is one.
    fn background_name_by_page_id(&self, session: &str, page_id: &str) -> Option<String>;
}

/// A queue key: the lane commands serialize on, and the page they act on when it is known (what a person's input on a page
/// holds, see `user_hold`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QueueKey {
    lane: String,
    page: Option<String>,
}

/// A background tab name the policy refuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyError(pub String);

impl fmt::Display for KeyError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for KeyError {}

impl QueueKey {
    pub fn new(lane: impl Into<String>, page: Option<String>) -> Self {
        Self { lane: lane.into(), page }
    }

    /// The text of the key (`session:owner:background:work`, `foreground`, `metadata`).
    pub fn lane(&self) -> &str {
        &self.lane
    }

    pub fn page(&self) -> Option<&str> {
        self.page.as_deref()
    }

    /// What a person's hold is recorded under: the page when the key knows it, else the lane.
    pub fn hold_key(&self) -> &str {
        self.page.as_deref().unwrap_or(&self.lane)
    }

    /// `commandQueueKey`.
    pub fn for_command(host: &dyn QueueKeyHost, input: &KeyInput<'_>) -> Result<Self, KeyError> {
        let owner = input.session.unwrap_or("");
        let prefix = if owner.is_empty() { String::new() } else { format!("session:{owner}:") };
        let action = input.action.trim().to_lowercase();
        if action == "list_tabs" || action == "downloads" {
            return Ok(Self::new(format!("{prefix}metadata"), None));
        }
        let given = input.tab.trim();
        let current;
        let tab = if !given.is_empty() {
            given
        } else if !input.background {
            current = host.current_page_id(owner).unwrap_or_default();
            current.trim()
        } else {
            ""
        };
        if is_numbered(tab, 'p') {
            return Ok(match host.background_name_by_page_id(owner, tab) {
                Some(name) => Self::new(format!("{prefix}background:{name}"), Some(tab.to_string())),
                None => Self::new(format!("{prefix}foreground"), Some(tab.to_string())),
            });
        }
        if input.background {
            let name = normalize_background_tab_name(tab, false)?;
            let page = host.background_page_id(owner, &name);
            return Ok(Self::new(format!("{prefix}background:{name}"), page));
        }
        if !tab.is_empty() && !is_numbered(tab, 'v') {
            let name = normalize_background_tab_name(tab, true)?;
            let page = host.background_page_id(owner, &name);
            return Ok(Self::new(format!("{prefix}background:{name}"), page));
        }
        Ok(Self::new(format!("{prefix}foreground"), host.current_page_id(owner)))
    }
}

/// `^<letter>\d+$`, either case.
fn is_numbered(text: &str, letter: char) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(first) if first.eq_ignore_ascii_case(&letter)) && {
        let digits = chars.as_str();
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    }
}

/// `normalizeBackgroundTabName`: the name a background page is kept under (`bg` when none is given and none is required).
pub fn normalize_background_tab_name(raw: &str, required: bool) -> Result<String, KeyError> {
    let name = raw.trim();
    if name.is_empty() {
        if required {
            return Err(KeyError("a background tab name is required".into()));
        }
        return Ok("bg".into());
    }
    if name.encode_utf16().count() > MAX_BACKGROUND_TAB_NAME_CHARS {
        return Err(KeyError(format!("background tab names may not exceed {MAX_BACKGROUND_TAB_NAME_CHARS} characters")));
    }
    if name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(KeyError("background tab names may not contain control characters".into()));
    }
    if is_numbered(name, 'v') || is_numbered(name, 'p') {
        return Err(KeyError("background tab names may not use the reserved p1/p2… or v1/v2… form".into()));
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tabs {
        current: Option<&'static str>,
        background: Vec<(&'static str, &'static str)>,
    }

    impl QueueKeyHost for Tabs {
        fn current_page_id(&self, _session: &str) -> Option<String> {
            self.current.map(str::to_string)
        }
        fn background_page_id(&self, _session: &str, name: &str) -> Option<String> {
            self.background.iter().find(|(_, n)| *n == name).map(|(page, _)| (*page).to_string())
        }
        fn background_name_by_page_id(&self, _session: &str, page_id: &str) -> Option<String> {
            self.background.iter().find(|(page, _)| *page == page_id).map(|(_, name)| (*name).to_string())
        }
    }

    fn none() -> Tabs {
        Tabs { current: None, background: Vec::new() }
    }

    fn key(host: &Tabs, action: &str, tab: &str, background: bool) -> String {
        let input = KeyInput { session: Some("owner"), action, tab, background };
        QueueKey::for_command(host, &input).expect("a key").lane().to_string()
    }

    #[test]
    fn metadata_actions_share_one_key_per_session() {
        assert_eq!(key(&none(), " List_Tabs ", "work", false), "session:owner:metadata");
        assert_eq!(key(&none(), "downloads", "", true), "session:owner:metadata");
        let input = KeyInput { session: None, action: "downloads", ..KeyInput::default() };
        assert_eq!(QueueKey::for_command(&none(), &input).expect("a key").lane(), "metadata");
    }

    #[test]
    fn tab_less_work_is_the_foreground_or_a_background_default() {
        assert_eq!(key(&none(), "click", "", false), "session:owner:foreground");
        assert_eq!(key(&none(), "navigate", "", true), "session:owner:background:bg");
        assert_eq!(key(&none(), "click", "v3", false), "session:owner:foreground");
        assert_eq!(key(&none(), "navigate", "research", true), "session:owner:background:research");
        assert_eq!(key(&none(), "click", "research", false), "session:owner:background:research");
    }

    #[test]
    fn a_page_id_takes_the_background_queue_of_that_page() {
        let host = Tabs { current: Some("p2"), background: vec![("p2", "work")] };
        for tab in ["work", "p2", ""] {
            assert_eq!(key(&host, "wait", tab, false), "session:owner:background:work", "tab {tab:?}");
        }
        assert_eq!(key(&host, "wait", "P9", false), "session:owner:foreground");
        // A background command with no tab does not borrow the selected page.
        assert_eq!(key(&host, "navigate", "", true), "session:owner:background:bg");
    }

    #[test]
    fn the_key_knows_the_page_a_person_holds() {
        let host = Tabs { current: Some("p2"), background: vec![("p2", "work")] };
        let input = KeyInput { session: Some("owner"), action: "click", tab: "work", background: false };
        let named = QueueKey::for_command(&host, &input).expect("a key");
        assert_eq!(named.page(), Some("p2"));
        assert_eq!(named.hold_key(), "p2");
        let input = KeyInput { session: Some("owner"), action: "click", ..KeyInput::default() };
        let selected = QueueKey::for_command(&host, &input).expect("a key");
        assert_eq!(selected.lane(), "session:owner:background:work");
        assert_eq!(selected.page(), Some("p2"));
        let bare = QueueKey::for_command(&none(), &input).expect("a key");
        assert_eq!(bare.page(), None);
        assert_eq!(bare.hold_key(), "session:owner:foreground");
    }

    #[test]
    fn a_refused_background_name_is_the_policys_message() {
        let refuse = |tab: &str| {
            let input = KeyInput { session: Some("owner"), action: "click", tab, background: true };
            QueueKey::for_command(&none(), &input).expect_err("refused").to_string()
        };
        assert_eq!(refuse(&"x".repeat(65)), "background tab names may not exceed 64 characters");
        assert_eq!(refuse("a\u{7}b"), "background tab names may not contain control characters");
        assert_eq!(normalize_background_tab_name("", true), Err(KeyError("a background tab name is required".into())));
        assert_eq!(normalize_background_tab_name("  ", false), Ok("bg".into()));
        assert!(normalize_background_tab_name("V12", false).is_err());
        assert_eq!(normalize_background_tab_name("v", false), Ok("v".into()));
        assert_eq!(normalize_background_tab_name(" research ", true), Ok("research".into()));
    }
}
