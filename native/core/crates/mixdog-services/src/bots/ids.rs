//! The agent ids a routine can name. These mirror the session core's fixed-id rule
//! (`agent_home_session_id` in mixdog-core, which this crate cannot import), so a routine
//! and the home thread it runs in always agree on what a valid owner is.

/// The primary bot (Mixy): the Lead configuration itself, and the owner of ownerless rows.
pub const MIXY_AGENT_ID: &str = "lead";
/// Mixy's bot id once it has its own folder.
pub const MIXY_BOT_ID: &str = "mixy";

const HOME_PREFIX: &str = "sess_home_";
const MAX_AGENT_ID_LENGTH: usize = 200;

/// A normalized agent id: `[a-z0-9][a-z0-9.-]*`.
fn is_agent_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// The home thread id of `agent_id`, or None when it is not a normalized id.
pub fn agent_home_session_id(agent_id: &str) -> Option<String> {
    (agent_id.len() <= MAX_AGENT_ID_LENGTH && is_agent_id(agent_id)).then(|| format!("{HOME_PREFIX}{}", agent_id.replace('.', "_")))
}

/// The agent a routine belongs to; an ownerless or invalid owner means Mixy.
pub fn schedule_owner_agent_id(owner: Option<&str>) -> String {
    match owner.map(str::trim) {
        Some(owner) if !owner.is_empty() && agent_home_session_id(owner).is_some() => owner.to_string(),
        _ => MIXY_AGENT_ID.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owners_fall_back_to_mixy_unless_a_valid_id() {
        assert_eq!(schedule_owner_agent_id(None), "lead");
        assert_eq!(schedule_owner_agent_id(Some("  ")), "lead");
        assert_eq!(schedule_owner_agent_id(Some("Bad Id")), "lead");
        assert_eq!(schedule_owner_agent_id(Some(" gh-bot ")), "gh-bot");
        assert_eq!(agent_home_session_id("a.b").as_deref(), Some("sess_home_a_b"));
        assert_eq!(agent_home_session_id("-a"), None);
    }
}
