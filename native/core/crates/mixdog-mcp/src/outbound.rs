//! Which MCP tool calls send, post or spend outside the machine (`Tool::outbound_kind`). This is
//! the one place the rule lives: a server's own per-tool declaration first, then the tool's
//! annotations and today's name-token rule. A known send, payment or delete name stays outbound
//! whatever the tool declares; any other tool that declares itself read-only is never outbound;
//! `outboundHint: true` opts a tool in as a message. A connector tool that deletes remote items
//! (`delete_message`, `remove_member`…) without being a recoverable trash is a permanent delete.

use mixdog_core_api::domain::approval::ActionKind;
use serde_json::Value;

/// Bare MCP tool names (lowercase, `-` → `_`) and what they send.
const LISTED: [(&str, ActionKind); 21] = [
    ("add_issue_comment", ActionKind::Comment),
    ("create_issue_comment", ActionKind::Comment),
    ("add_reply_to_pull_request_comment", ActionKind::Comment),
    ("add_comment_to_pending_review", ActionKind::Comment),
    ("add_pull_request_review_comment", ActionKind::Comment),
    ("create_pull_request_review", ActionKind::Review),
    ("create_and_submit_pull_request_review", ActionKind::Review),
    ("submit_pending_pull_request_review", ActionKind::Review),
    ("send_email", ActionKind::Email),
    ("send_mail", ActionKind::Email),
    ("gmail_send", ActionKind::Email),
    ("gmail_send_email", ActionKind::Email),
    ("send_gmail_message", ActionKind::Email),
    ("reply_email", ActionKind::Email),
    ("send_message", ActionKind::Message),
    ("post_message", ActionKind::Message),
    ("reply_to_message", ActionKind::Message),
    ("slack_post_message", ActionKind::Message),
    ("slack_reply_to_thread", ActionKind::Message),
    ("chat_post_message", ActionKind::Message),
    ("submit_form", ActionKind::Form),
];
const PUBLISH: [&str; 5] = ["create_post", "publish_post", "create_tweet", "post_tweet", "send_tweet"];

/// A name opening with a read verb (`list_payments`, `get_purchase`) only reads.
const READ_VERBS: [&str; 10] =
    ["get", "list", "search", "read", "fetch", "retrieve", "find", "view", "describe", "lookup"];
const MAIL_TOKENS: [&str; 5] = ["mail", "email", "gmail", "outlook", "smtp"];
const SEND_TOKENS: [&str; 3] = ["send", "reply", "forward"];
const PAYMENT_TOKENS: [&str; 6] = ["pay", "payment", "purchase", "buy", "checkout", "charge"];
const PAYMENT_NAMES: [&str; 4] = ["place_order", "send_money", "transfer_money", "transfer_funds"];
const PERMANENT_TOKENS: [&str; 4] = ["permanent", "permanently", "hard", "forever"];
const DELETE_TOKENS: [&str; 6] = ["delete", "remove", "destroy", "erase", "purge", "wipe"];

fn bare_name(value: &str) -> String {
    value.to_lowercase().replace('-', "_")
}

fn tokens_of(value: &str) -> Vec<String> {
    bare_name(value)
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

fn listed(bare: &str) -> Option<ActionKind> {
    LISTED
        .iter()
        .find(|(name, _)| *name == bare)
        .map(|(_, kind)| *kind)
        .or_else(|| PUBLISH.contains(&bare).then_some(ActionKind::Publish))
}

/// The category a bare MCP tool name (and its server) makes.
fn category_by_name(bare: &str, server: &str) -> Option<ActionKind> {
    let tokens = tokens_of(bare);
    let known = listed(bare);
    if tokens.first().is_some_and(|t| READ_VERBS.contains(&t.as_str())) {
        return known;
    }
    let has = |set: &[&str]| tokens.iter().any(|t| set.contains(&t.as_str()));
    let mail = tokens.iter().chain(tokens_of(server).iter()).any(|t| MAIL_TOKENS.contains(&t.as_str()));
    if mail && has(&SEND_TOKENS) {
        return Some(ActionKind::Email);
    }
    if known.is_some() {
        return known;
    }
    if PAYMENT_NAMES.contains(&bare) || has(&PAYMENT_TOKENS) {
        return Some(ActionKind::Payment);
    }
    if bare == "empty_trash" || tokens.iter().any(|t| t == "purge") {
        return Some(ActionKind::Delete);
    }
    // Recoverable (Gmail Trash): asks, and unlike a permanent delete it may be remembered.
    if bare == "trash_emails" {
        return Some(ActionKind::Trash);
    }
    if tokens.iter().any(|t| t == "delete") && has(&PERMANENT_TOKENS) {
        return Some(ActionKind::Delete);
    }
    None
}

/// What a tool declares about itself besides its name.
#[derive(Clone, Copy, Default, Debug)]
pub struct Hints {
    pub read_only: bool,
    pub outbound: bool,
}

/// The outbound kind of tool `tool` of server `server` (the second segment of its qualified
/// name) called with `args`. `declared` is the server's own per-tool declaration.
pub fn outbound_kind(
    declared: Option<ActionKind>,
    server: &str,
    tool: &str,
    args: &Value,
    hints: Hints,
) -> Option<ActionKind> {
    if declared.is_some() {
        return declared;
    }
    let bare = bare_name(tool);
    let mut category = category_by_name(&bare, server);
    if category.is_none()
        && tokens_of(&bare).iter().any(|t| t == "delete")
        && args.get("permanent") == Some(&Value::Bool(true))
    {
        category = Some(ActionKind::Delete);
    }
    if category.is_none() && hints.read_only {
        // A tool that only reads is never outbound — except a remote delete, judged below.
    } else if category.is_none() && hints.outbound {
        category = Some(ActionKind::Message);
    }
    if category == Some(ActionKind::Trash) {
        return category;
    }
    if !matches!(category, Some(ActionKind::Delete | ActionKind::Payment)) && is_remote_delete(&bare) {
        return Some(ActionKind::Delete);
    }
    category
}

/// Whether a connector tool deletes remote items by its name tokens. Read-verb names
/// (`list_deleted_items`) stay reads.
fn is_remote_delete(bare: &str) -> bool {
    let tokens = tokens_of(bare);
    if tokens.first().is_some_and(|t| READ_VERBS.contains(&t.as_str())) {
        return false;
    }
    tokens.iter().any(|t| DELETE_TOKENS.contains(&t.as_str()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kind(server: &str, tool: &str, args: &Value, hints: Hints) -> Option<ActionKind> {
        outbound_kind(None, server, tool, args, hints)
    }

    #[test]
    fn a_declared_kind_wins() {
        let declared = Some(ActionKind::Form);
        assert_eq!(outbound_kind(declared, "s", "list_things", &json!({}), Hints::default()), declared);
    }

    #[test]
    fn delete_message_still_asks_as_a_delete() {
        assert_eq!(kind("slack", "delete_message", &json!({}), Hints::default()), Some(ActionKind::Delete));
        assert_eq!(
            kind("slack", "delete_message", &json!({}), Hints { read_only: true, outbound: false }),
            Some(ActionKind::Delete)
        );
        assert_eq!(kind("slack", "list_deleted_items", &json!({}), Hints::default()), None);
    }

    #[test]
    fn read_only_hint_exempts_unknown_names_but_not_known_sends() {
        let read_only = Hints { read_only: true, outbound: false };
        assert_eq!(kind("x", "do_thing", &json!({}), read_only), None);
        assert_eq!(kind("slack", "send_message", &json!({}), read_only), Some(ActionKind::Message));
        assert_eq!(kind("x", "do_thing", &json!({}), Hints { read_only: false, outbound: true }), Some(ActionKind::Message));
    }
}
