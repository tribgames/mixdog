//! Tail reminder rules: short per-model,
//! per-language nudges appended to the very end of an outgoing request, fresh
//! on every request and never stored as a message of their own. The assistant
//! turn a request produces keeps its reminder text (`AgentMessage::turn_reminder`);
//! how a provider places the reminder on the wire (`splitTailReminder`, the
//! `clear_at` system message) is its codec's.

use std::sync::LazyLock;

use regex::Regex;

use crate::env::TailReminder;

/// The session's role in a rule's `role` tag.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TailRole {
    Lead,
    /// Agent mode.
    Bot,
    /// Agent-owned session.
    Worker,
}

impl TailRole {
    fn name(self) -> &'static str {
        match self {
            Self::Lead => "lead",
            Self::Bot => "bot",
            Self::Worker => "worker",
        }
    }
}

/// The response language block of the session.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TailLanguage {
    pub id: String,
    pub name: String,
}

/// A rule: all given tags must hold, an omitted tag matches anything.
pub struct TailRule {
    pub id: &'static str,
    pub provider: &'static [&'static str],
    pub model: &'static [&'static str],
    pub language: &'static [&'static str],
    pub role: &'static [&'static str],
    /// May use `{language}`.
    pub text: &'static str,
}

/// The built-in rules every session's requests are matched against.
///
/// Claude Opus 5.5 drifts into English in long agentic turns, where English tool results sit between the user's
/// message and its answer. Worded as a condition, so the reminder ending every request does not read as a turn
/// start that asks for a note before the next tool call.
pub const TAIL_REMINDER_RULES: &[TailRule] = &[TailRule {
    id: "opus-5-5-language",
    provider: &[],
    model: &["claude-opus-5-5"],
    language: &["ko", "ja", "zh-Hans", "zh-Hant", "es", "fr", "de", "pt", "ru", "it", "vi", "th", "id", "hi", "ar", "tr", "pl", "nl", "uk"],
    role: &["lead", "bot"],
    text: "If you write user-facing text, use {language}.",
}];

/// A provider id's family, for rules written against the family.
fn provider_family(provider: &str) -> Option<&'static str> {
    matches!(provider, "anthropic-oauth" | "anthropic").then_some("anthropic")
}

struct Folds {
    at_date: Regex,
    bedrock: Regex,
    variant: Regex,
    version: Regex,
    date: Regex,
    thinking: Regex,
}

static FOLDS: LazyLock<Folds> = LazyLock::new(|| {
    let re = |pattern: &str| Regex::new(pattern).expect("fixed pattern");
    Folds {
        at_date: re("@[^\\n\\r\u{2028}\u{2029}]*$"),
        bedrock: re("-v[0-9]+:[0-9]+$"),
        variant: re(":[^/]*$"),
        version: re("-v[0-9]+$"),
        date: re("-[0-9]{8}$"),
        thinking: re("-thinking$"),
    }
});

/// `anthropic/claude-opus-5.5`, `claude-opus-5-5-20260101`,
/// `us.anthropic.claude-opus-5-5-v1:0`, `claude-opus-5-5-thinking` →
/// `claude-opus-5-5`.
pub fn model_family_id(model: &str) -> String {
    let folded = crate::text_only::js_trim(model).to_lowercase().replace('.', "-");
    let id = match folded.find("claude-") {
        Some(at) => &folded[at..],
        None => &folded[folded.rfind('/').map_or(0, |i| i + 1)..],
    };
    let folds = &*FOLDS;
    let mut id = id.to_owned();
    for fold in [&folds.at_date, &folds.bedrock, &folds.variant, &folds.version, &folds.date, &folds.thinking] {
        id = fold.replace(&id, "").into_owned();
    }
    id
}

/// What a rule is matched against.
#[derive(Clone, Debug)]
pub struct TailContext {
    pub provider: String,
    pub language: Option<TailLanguage>,
    pub role: TailRole,
}

fn rule_matches(rule: &TailRule, context: &TailContext, model: &str) -> bool {
    let family = provider_family(&context.provider);
    if !rule.provider.is_empty() && !rule.provider.iter().any(|p| *p == context.provider || family == Some(*p)) {
        return false;
    }
    if !rule.model.is_empty() && !rule.model.contains(&model_family_id(model).as_str()) {
        return false;
    }
    if !rule.language.is_empty() && !context.language.as_ref().is_some_and(|l| rule.language.contains(&l.id.as_str())) {
        return false;
    }
    rule.role.is_empty() || rule.role.contains(&context.role.name())
}

/// The joined text of every matching rule wrapped as one system-reminder, or
/// `None` (`matchTailReminder`).
pub fn match_tail_reminder(context: &TailContext, model: &str, rules: &[TailRule]) -> Option<String> {
    let name = context.language.as_ref().map_or("", |l| l.name.as_str());
    let texts: Vec<String> = rules.iter().filter(|rule| rule_matches(rule, context, model)).map(|rule| rule.text.replace("{language}", name)).collect();
    (!texts.is_empty()).then(|| format!("<system-reminder>{}</system-reminder>", texts.join("\n")))
}

/// The session's tail reminder source: `rules` ([`TAIL_REMINDER_RULES`] for a
/// session) against the session's provider, language and role.
pub struct RuleTailReminder {
    pub context: TailContext,
    pub rules: &'static [TailRule],
}

impl TailReminder for RuleTailReminder {
    fn text(&self, model: &str) -> Option<String> {
        match_tail_reminder(&self.context, model, self.rules)
    }
}
