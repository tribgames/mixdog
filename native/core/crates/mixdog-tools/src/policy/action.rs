//! What a remembered grant is keyed by: an outbound action kind, or a hook's
//! own `ask` on a tool (`tool:<name>`).

use mixdog_core_api::domain::approval::ActionKind;

pub const fn kind_name(kind: ActionKind) -> &'static str {
    match kind {
        ActionKind::Comment => "comment",
        ActionKind::Review => "review",
        ActionKind::Message => "message",
        ActionKind::Email => "email",
        ActionKind::Publish => "publish",
        ActionKind::Form => "form",
        ActionKind::Payment => "payment",
        ActionKind::Delete => "delete",
        ActionKind::Trash => "trash",
        ActionKind::BrowserSubmit => "browser_submit",
        ActionKind::BrowserPost => "browser_post",
        ActionKind::BrowserUpload => "browser_upload",
    }
}

pub fn parse_kind(text: &str) -> Option<ActionKind> {
    ActionKind::ALL.into_iter().find(|kind| kind_name(*kind) == text)
}

const TOOL_PREFIX: &str = "tool:";
const TOOL_NAME_LIMIT: usize = 120;

/// Tools whose approvals change what agents may do, or are the user prompt
/// itself: always answered once, whatever asked.
const UNREMEMBERED_TOOLS: [&str; 3] = ["setup", "ask_user", "handoff_user"];

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum GrantKey {
    Kind(ActionKind),
    /// A validated tool name, without the `tool:` prefix.
    Tool(String),
}

impl GrantKey {
    /// The key of a tool's hook ask; `None` when that tool is never remembered.
    pub fn tool(name: &str) -> Option<Self> {
        let valid = (1..=TOOL_NAME_LIMIT).contains(&mixdog_js::utf16_len(name))
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'));
        (valid && !UNREMEMBERED_TOOLS.contains(&name)).then(|| Self::Tool(name.to_owned()))
    }

    /// Reads the stored form: an action kind name or `tool:<name>`.
    pub fn parse(text: &str) -> Option<Self> {
        match text.strip_prefix(TOOL_PREFIX) {
            Some(name) => Self::tool(name),
            None => parse_kind(text).map(Self::Kind),
        }
    }

    /// The stored form.
    pub fn render(&self) -> String {
        match self {
            Self::Kind(kind) => kind_name(*kind).to_owned(),
            Self::Tool(name) => format!("{TOOL_PREFIX}{name}"),
        }
    }

    /// Whether "don't ask again" may exist for this key.
    pub fn rememberable(&self) -> bool {
        match self {
            Self::Kind(kind) => kind.rememberable(),
            Self::Tool(_) => true,
        }
    }

    pub fn is_tool(&self) -> bool {
        matches!(self, Self::Tool(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_round_trips_through_its_stored_name() {
        for kind in ActionKind::ALL {
            assert_eq!(parse_kind(kind_name(kind)), Some(kind));
        }
        assert_eq!(parse_kind("unknown"), None);
    }

    #[test]
    fn tool_keys_exclude_prompts_and_setup_and_bad_names() {
        assert_eq!(GrantKey::parse("tool:shell"), Some(GrantKey::Tool("shell".into())));
        assert_eq!(
            GrantKey::parse("tool:mcp__srv__do.it-1:x").map(|k| k.render()),
            Some("tool:mcp__srv__do.it-1:x".to_owned())
        );
        for name in ["setup", "ask_user", "handoff_user", "", "has space", "no/slash"] {
            assert_eq!(GrantKey::tool(name), None, "{name}");
        }
        assert_eq!(GrantKey::tool(&"a".repeat(121)), None);
        assert!(GrantKey::tool(&"a".repeat(120)).is_some());
    }

    #[test]
    fn payments_and_permanent_deletes_are_not_rememberable() {
        assert!(!GrantKey::Kind(ActionKind::Payment).rememberable());
        assert!(!GrantKey::Kind(ActionKind::Delete).rememberable());
        assert!(GrantKey::Kind(ActionKind::Trash).rememberable());
        assert!(GrantKey::Tool("shell".into()).rememberable());
    }
}
