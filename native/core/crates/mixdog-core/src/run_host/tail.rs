//! The session's tail reminder source.

use std::sync::Arc;

use mixdog_agent::env::TailReminder;
use mixdog_agent::tail_rules::RuleTailReminder;
use mixdog_agent::tail_rules::TailContext;

/// The built-in rules against the session's provider, language and role.
pub fn session_tail_reminder(context: TailContext) -> Arc<dyn TailReminder> {
    Arc::new(RuleTailReminder { context })
}

#[cfg(test)]
mod tests {
    use mixdog_agent::tail_rules::TailLanguage;
    use mixdog_agent::tail_rules::TailRole;

    use super::*;

    #[test]
    fn opus_korean_lead_gets_the_language_reminder() {
        let reminder = session_tail_reminder(TailContext {
            provider: "anthropic-oauth".into(),
            language: Some(TailLanguage { id: "ko".into(), name: "Korean".into() }),
            role: TailRole::Lead,
        });
        assert_eq!(
            reminder.text("claude-opus-5-5-20260101").as_deref(),
            Some("<system-reminder>Write all user-facing text in Korean.</system-reminder>")
        );
        assert_eq!(reminder.text("gpt-5"), None);
    }
}
