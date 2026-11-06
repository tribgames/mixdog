//! `ask_user`: 1–4 multiple-choice questions put to the user through the session's approval
//! gate (`item/tool/requestUserInput`); the call waits until the user answers or dismisses the
//! card or the turn is cancelled. There is no wait limit.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::JsonValue;
use mixdog_protocol::QuestionAnswer;
use serde_json::Value;

use crate::orch::util::JsStr;
use serde_json::json;

use super::todo::TodoStore;
use crate::orch::ports::CallerFacts;
use crate::orch::util::cancelled;
use crate::orch::util::invalid;
use crate::orch::util::spec_from_def;
use crate::orch::util::text;

pub const ASK_USER_MAX_QUESTIONS: usize = 4;
/// Longest typed answer or composer reply, in UTF-16 code units (as the wire counts them).
pub const ASK_USER_MAX_TEXT: usize = 4000;

const ASK_USER_DISMISSED: &str = "User closed the questions without answering. Proceed with your best judgment; ask again only if something new depends on it.";
const NO_USER: &str = "No user is available to answer in this session. Proceed with your best judgment and state the choices you made.";
const CONTINUE: &str = "You can now continue with these answers in mind.";

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Question {
    pub question: String,
    pub labels: Vec<String>,
    pub multi_select: bool,
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn nonblank(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.js_trim().is_empty())
}

/// Validates the questions of an `ask_user` call with the existing wordings.
pub fn validate_questions(args: &Value) -> Result<Vec<Question>, String> {
    if args.get("handoff").is_some_and(|v| !v.is_null()) {
        return Err("ask_user takes questions only; a page or app step goes to handoff_user".to_owned());
    }
    let questions = match args.get("questions") {
        Some(Value::Array(q)) if (1..=ASK_USER_MAX_QUESTIONS).contains(&q.len()) => q,
        _ => return Err(format!("ask_user requires 1-{ASK_USER_MAX_QUESTIONS} questions")),
    };
    let mut seen_questions = HashSet::new();
    let mut out = Vec::with_capacity(questions.len());
    for (i, q) in questions.iter().enumerate() {
        let at = format!("ask_user question {}", i + 1);
        let Some(q) = q.as_object() else {
            return Err(format!("{at} must be an object"));
        };
        let Some(question) = nonblank(q.get("question")) else {
            return Err(format!("{at} needs question text"));
        };
        match q.get("header").and_then(Value::as_str) {
            Some(h) if !h.js_trim().is_empty() && utf16_len(h) <= 12 => {}
            _ => return Err(format!("{at} needs a header of at most 12 characters")),
        }
        if !seen_questions.insert(question.to_owned()) {
            return Err(format!("{at} duplicates another question text"));
        }
        let options = match q.get("options") {
            Some(Value::Array(o)) if (2..=4).contains(&o.len()) => o,
            _ => return Err(format!("{at} needs 2-4 options")),
        };
        let mut labels = HashSet::new();
        let mut label_list = Vec::with_capacity(options.len());
        for option in options {
            let label = option.get("label").and_then(Value::as_str).filter(|s| !s.js_trim().is_empty());
            let Some(label) = label else {
                return Err(format!("{at} has an option without a label"));
            };
            if utf16_len(label) > 80 {
                return Err(format!("{at} has an option label over 80 characters"));
            }
            let Some(description) = nonblank(option.get("description")) else {
                return Err(format!("{at} option \"{label}\" needs a one-sentence description"));
            };
            if utf16_len(description) > 200 {
                return Err(format!("{at} has an option description over 200 characters"));
            }
            if option
                .as_object()
                .is_some_and(|o| o.keys().any(|k| k != "label" && k != "description"))
            {
                return Err(format!("{at}: options take only a label and a description"));
            }
            if !labels.insert(label.to_owned()) {
                return Err(format!("{at} has duplicate option label \"{label}\""));
            }
            label_list.push(label.to_owned());
        }
        match q.get("recommended") {
            None | Some(Value::Null) => {}
            Some(r) => {
                let ok = r.as_u64().is_some_and(|i| (i as usize) < options.len());
                if !ok {
                    return Err(format!("{at} recommended must be an index below {}", options.len()));
                }
            }
        }
        out.push(Question {
            question: question.to_owned(),
            labels: label_list,
            multi_select: q.get("multi_select").and_then(Value::as_bool) == Some(true),
        });
    }
    Ok(out)
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct Answer {
    selected: Vec<String>,
    text: String,
}

/// Wire answers aligned with the questions; invalid entries become `None`.
fn normalize_answers(answers: &[Option<QuestionAnswer>], questions: &[Question]) -> Vec<Option<Answer>> {
    questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let entry = answers.get(i)?.as_ref()?;
            if !entry.selected.iter().all(|l| q.labels.contains(l)) {
                return None;
            }
            if entry.text.as_deref().is_some_and(|t| utf16_len(t) > ASK_USER_MAX_TEXT) {
                return None;
            }
            let selected: Vec<String> = if q.multi_select {
                let mut seen = HashSet::new();
                entry.selected.iter().filter(|l| seen.insert((*l).clone())).cloned().collect()
            } else {
                entry.selected.iter().take(1).cloned().collect()
            };
            let text = entry.text.as_deref().map(str::trim).unwrap_or_default().to_owned();
            (!selected.is_empty() || !text.is_empty()).then_some(Answer { selected, text })
        })
        .collect()
}

fn quote(text: &str) -> String {
    serde_json::to_string(text).expect("strings serialize")
}

fn format_answers(questions: &[Question], answers: &[Option<Answer>]) -> String {
    let parts: Vec<String> = questions
        .iter()
        .zip(answers)
        .map(|(q, a)| match a {
            None => format!("{}=(no answer)", quote(&q.question)),
            Some(a) => {
                let picked = if a.selected.is_empty() { String::new() } else { quote(&a.selected.join(", ")) };
                let typed = if a.text.is_empty() { String::new() } else { format!("{} (typed)", quote(&a.text)) };
                let joined = [picked, typed].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" + ");
                format!("{}={joined}", quote(&q.question))
            }
        })
        .collect();
    format!("User has answered your questions: {}. {CONTINUE}", parts.join("; "))
}

/// The text of an `ask_user` call for the user's decision: the answers, or the dismissal.
pub fn result_text(questions: &[Question], resolution: &ApprovalResolution) -> String {
    let ApprovalResolution::Decided { decision, .. } = resolution else {
        return ASK_USER_DISMISSED.to_owned();
    };
    if !decision.approved {
        return ASK_USER_DISMISSED.to_owned();
    }
    let answers = normalize_answers(decision.answers.as_deref().unwrap_or_default(), questions);
    let reply = decision
        .reply
        .as_deref()
        .filter(|r| utf16_len(r) <= ASK_USER_MAX_TEXT)
        .map(str::trim)
        .unwrap_or_default();
    if reply.is_empty() {
        return format_answers(questions, &answers);
    }
    let lead = format!("User replied in chat: {}. ", quote(reply));
    if answers.iter().any(Option::is_some) {
        format!("{lead}{}", format_answers(questions, &answers))
    } else {
        format!("{lead}{CONTINUE}")
    }
}

pub struct AskUserTool {
    spec: ToolSpec,
    facts: Arc<dyn CallerFacts>,
    todos: Arc<dyn TodoStore>,
}

impl AskUserTool {
    pub fn new(facts: Arc<dyn CallerFacts>, todos: Arc<dyn TodoStore>) -> Self {
        Self {
            spec: spec_from_def(include_str!("defs/ask_user.json"), false, &[]),
            facts,
            todos,
        }
    }
}

#[async_trait]
impl Tool for AskUserTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let questions = validate_questions(&args).map_err(|m| invalid("questions", m))?;
        if !self.facts.user_available(&ctx.thread_id) {
            return text(NO_USER);
        }
        let ask = ApprovalAsk {
            kind: ApprovalKind::UserInput,
            call_id: Some(ctx.call_id.clone()),
            tool: Some("ask_user".to_owned()),
            action_kind: None,
            reason: None,
            payload: json!({ "questions": args["questions"] }),
            remember: Vec::new(),
            expires_after: None,
        };
        let resolution = ctx.approvals.request(ask).await;
        if matches!(resolution, ApprovalResolution::Cancelled { .. }) {
            return Err(cancelled());
        }
        // No approval surface: Node's `ask_user` without a hook (`ask-user-tool.mjs:243`).
        if matches!(resolution, ApprovalResolution::Unavailable { .. }) {
            return text(NO_USER);
        }
        // A question left unanswered: the turn may end waiting on the user.
        let answered = matches!(&resolution, ApprovalResolution::Decided { decision, .. } if decision.approved);
        if !answered {
            self.todos.note_user_wait(&ctx.thread_id);
        }
        text(result_text(&questions, &resolution))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::ConnectionKind;
    use mixdog_protocol::ToolApprovalDecision;

    use super::*;

    fn questions() -> Vec<Question> {
        validate_questions(&json!({"questions":[
            {"question":"Pick \"one\"","header":"Pick","options":[
                {"label":"A","description":"first"},{"label":"B","description":"second"}]},
            {"question":"Many","header":"Many","multi_select":true,"options":[
                {"label":"X","description":"x"},{"label":"Y","description":"y"}]}
        ]}))
        .expect("valid")
    }

    fn decided(decision: ToolApprovalDecision) -> ApprovalResolution {
        ApprovalResolution::Decided {
            decision,
            device: "d".into(),
            connection_kind: ConnectionKind::Desktop,
            at: 0,
        }
    }

    fn decision(approved: bool) -> ToolApprovalDecision {
        ToolApprovalDecision {
            approved,
            reason: None,
            answers: None,
            reply: None,
            response: None,
            edited_args: None,
            remember: None,
            scope: None,
        }
    }

    #[test]
    fn answers_are_quoted_and_typed_text_stays_apart() {
        let mut d = decision(true);
        d.answers = Some(vec![
            Some(QuestionAnswer { selected: vec!["A".into()], text: None }),
            Some(QuestionAnswer { selected: vec!["X".into(), "X".into(), "Y".into()], text: Some(" more ".into()) }),
        ]);
        assert_eq!(
            result_text(&questions(), &decided(d)),
            "User has answered your questions: \"Pick \\\"one\\\"\"=\"A\"; \"Many\"=\"X, Y\" + \"more\" (typed). You can now continue with these answers in mind."
        );
    }

    #[test]
    fn invalid_entries_and_dismissals_read_as_no_answer() {
        let mut d = decision(true);
        d.answers = Some(vec![Some(QuestionAnswer { selected: vec!["nope".into()], text: None }), None]);
        d.reply = Some("  go on ".into());
        assert_eq!(
            result_text(&questions(), &decided(d)),
            "User replied in chat: \"go on\". You can now continue with these answers in mind."
        );
        assert_eq!(result_text(&questions(), &decided(decision(false))), ASK_USER_DISMISSED);
        assert_eq!(
            result_text(&questions(), &ApprovalResolution::TimedOut { at: 1 }),
            ASK_USER_DISMISSED
        );
    }

    #[test]
    fn validation_reports_the_existing_wordings() {
        assert_eq!(
            validate_questions(&json!({})).unwrap_err(),
            "ask_user requires 1-4 questions"
        );
        assert_eq!(
            validate_questions(&json!({"questions":[{"question":"q","header":"h","options":[
                {"label":"A","description":"d"},{"label":"A","description":"d"}]}]}))
            .unwrap_err(),
            "ask_user question 1 has duplicate option label \"A\""
        );
        assert_eq!(
            validate_questions(&json!({"handoff":{},"questions":[]})).unwrap_err(),
            "ask_user takes questions only; a page or app step goes to handoff_user"
        );
    }
}
