//! What a card offers to remember: one rule, read by the gate that builds the
//! card, by the row a client is shown ([`row_fields`] carry its inputs), and by
//! the writer that stores an answer. A scope is offered only where its writer
//! can store it, so no path can offer or store more than another.
//!
//! A bot's outbound approval covers its action category (or its tool when a
//! hook also asked); a hook ask covers only the one tool it names; a payment
//! or permanent delete is answered once, whatever else is known.

use mixdog_core_api::domain::approval::ActionKind;
use mixdog_protocol::ApprovalRemember;

use super::action::GrantKey;

/// The question a card puts.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Card {
    /// A PreToolUse hook's own `ask` on a call no bot's outbound rule covers.
    HookAsk,
    /// A bot's outbound call, whatever its hooks said short of a deny.
    Outbound,
    /// A connector tool the acting contact bot is set to ask for: "this agent"
    /// is that bot's own connector policy of the tool.
    ConnectorPolicy,
}

impl Card {
    /// The audit's and the row's `kind`.
    pub const fn kind(self) -> &'static str {
        match self {
            Self::HookAsk | Self::ConnectorPolicy => "approval",
            Self::Outbound => "outbound",
        }
    }
}

/// Who answers for the session asking.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Caller {
    /// A person attends the session.
    Attended,
    /// An unattended run owns the session (a group-room member's turn).
    Unattended,
}

/// The fields of a card's row that carry the rule's inputs besides `kind`,
/// `grantAction` and an outbound card's `outbound.category`.
pub mod row_fields {
    /// `true` on a [`super::Card::ConnectorPolicy`] card.
    pub const CONNECTOR_POLICY: &str = "connectorPolicy";
    /// The action category of a hook's ask on a classified call.
    pub const ACTION_KIND: &str = "actionKind";
    /// `true` when the caller is [`super::Caller::Unattended`].
    pub const UNATTENDED: &str = "unattended";
}

/// The scopes a card offers, `Once` first:
///
/// | card | key | category | caller | offered |
/// |---|---|---|---|---|
/// | any | any | payment, permanent delete | any | once |
/// | hook ask | a tool | other or none | attended | once, this conversation, every agent |
/// | outbound | rememberable | other | attended | once, this conversation, this agent |
/// | outbound | rememberable | other | unattended | once, this agent |
/// | hook ask | category or none | any | any | once |
/// | outbound | none or unrememberable | any | any | once |
/// | hook ask | a tool | any | unattended | once |
/// | connector policy | — | other or none | any | once, this agent |
///
/// "This conversation" needs a person (an unattended session has no
/// conversation of its own to hold it); "every agent" is never offered for a
/// bot's outbound call or for an action category; a hook ask requires a tool
/// key, and a missing or unrememberable key stores nothing.
pub fn offered_scopes(card: Card, key: Option<&GrantKey>, category: Option<ActionKind>, caller: Caller) -> Vec<ApprovalRemember> {
    use ApprovalRemember::*;
    if category.is_some_and(|kind| !kind.rememberable()) {
        return vec![Once];
    }
    match (card, key, caller) {
        (Card::ConnectorPolicy, _, _) => vec![Once, Agent],
        (Card::HookAsk, Some(key), Caller::Attended) if key.is_tool() => vec![Once, Session, Always],
        (Card::Outbound, Some(key), Caller::Attended) if key.rememberable() => vec![Once, Session, Agent],
        (Card::Outbound, Some(key), Caller::Unattended) if key.rememberable() => vec![Once, Agent],
        (Card::HookAsk | Card::Outbound, _, _) => vec![Once],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ApprovalRemember::*;

    fn tool(name: &str) -> GrantKey {
        GrantKey::tool(name).expect("a tool key")
    }

    #[test]
    fn a_bots_outbound_card_never_offers_every_agent() {
        for category in [ActionKind::Comment, ActionKind::Email, ActionKind::Trash] {
            for caller in [Caller::Attended, Caller::Unattended] {
                let offered = offered_scopes(Card::Outbound, Some(&GrantKey::Kind(category)), Some(category), caller);
                assert!(!offered.contains(&Always), "{category:?} {caller:?}: {offered:?}");
            }
        }
        assert_eq!(
            offered_scopes(Card::Outbound, Some(&GrantKey::Kind(ActionKind::Comment)), Some(ActionKind::Comment), Caller::Attended),
            [Once, Session, Agent]
        );
        assert_eq!(offered_scopes(Card::Outbound, Some(&GrantKey::Kind(ActionKind::Comment)), Some(ActionKind::Comment), Caller::Unattended), [Once, Agent]);
        assert_eq!(offered_scopes(Card::Outbound, Some(&tool("mcp__gmail__send_email")), Some(ActionKind::Email), Caller::Attended), [Once, Session, Agent]);
        assert_eq!(offered_scopes(Card::Outbound, Some(&tool("mcp__gmail__send_email")), Some(ActionKind::Email), Caller::Unattended), [Once, Agent]);
    }

    #[test]
    fn a_payment_or_permanent_delete_is_once_whatever_else_is_known() {
        for card in [Card::HookAsk, Card::Outbound, Card::ConnectorPolicy] {
            for category in [ActionKind::Payment, ActionKind::Delete] {
                assert_eq!(offered_scopes(card, Some(&tool("mcp__shop__buy")), Some(category), Caller::Attended), [Once], "{card:?} {category:?}");
                assert_eq!(offered_scopes(card, Some(&GrantKey::Kind(category)), Some(category), Caller::Attended), [Once], "{card:?} {category:?}");
            }
        }
    }

    #[test]
    fn nothing_but_once_is_offered_without_a_rememberable_key_or_for_a_category_hook_ask() {
        for card in [Card::HookAsk, Card::Outbound] {
            assert_eq!(offered_scopes(card, None, Some(ActionKind::Email), Caller::Attended), [Once], "{card:?}");
            assert_eq!(offered_scopes(card, Some(&GrantKey::Kind(ActionKind::Payment)), None, Caller::Attended), [Once], "{card:?}");
        }
        for category in [ActionKind::Email, ActionKind::BrowserSubmit] {
            assert_eq!(
                offered_scopes(Card::HookAsk, Some(&GrantKey::Kind(category)), Some(category), Caller::Attended),
                [Once],
                "a hook ask never offers standing scopes for a category: {category:?}"
            );
        }
        assert_eq!(offered_scopes(Card::HookAsk, Some(&tool("mcp__gmail__send_email")), Some(ActionKind::Email), Caller::Attended), [Once, Session, Always]);
    }

    #[test]
    fn a_hook_ask_offers_this_conversation_and_every_agent_only_where_a_person_attends() {
        assert_eq!(offered_scopes(Card::HookAsk, Some(&tool("shell")), None, Caller::Attended), [Once, Session, Always]);
        assert_eq!(offered_scopes(Card::HookAsk, Some(&tool("shell")), None, Caller::Unattended), [Once]);
    }

    #[test]
    fn a_connector_policy_card_offers_this_agent() {
        for caller in [Caller::Attended, Caller::Unattended] {
            assert_eq!(offered_scopes(Card::ConnectorPolicy, None, None, caller), [Once, Agent]);
        }
    }
}
