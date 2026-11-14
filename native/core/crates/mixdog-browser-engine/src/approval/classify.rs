//! Owner: s4-engine-approval
//! Which Browser Use steps ask, and what the person is shown: the classes of `action-approval.ts` (`submit`, `post`, `upload`,
//! `confirm`, and the payment floor of `payment-evidence.ts`), no class added. Whether an ask is then let through (a standing
//! allow, an unattended run, "Allow all actions", a session grant) is not decided here: the core gate decides it from the
//! [`BrowserApprovalPrompt`] through [`crate::ApprovalPort`].
//!
//! The flow of a step that may ask: [`plan`] (the operator's policy and the command say whether it asks at all), then the
//! caller reads what the plan names (upload files through `binding::resolve_upload_files`, the receiving frame, the payment
//! evidence of the page when [`AskPlan::probes_payment`]), then [`classify`] makes the ask and its [`Binding`]; after the
//! answer `binding::verify` is the precondition of the dispatch.

use std::fmt;
use std::sync::LazyLock;

use mixdog_app_protocol::v2::browser_engine::BrowserApprovalFile;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind as Remember;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_js::JsRegex;
use mixdog_protocol::ThreadId;

use super::binding::command_hash;
use crate::types::Binding;
use crate::types::BoundFile;
use crate::types::BrowserApprovalAsk;
use crate::types::BrowserApprovalKind;
use crate::types::BrowserApprovalPrompt;

/// Accessible names of controls that send or post (word match, any case; `\b` is ASCII-only as in V8).
static POST_CONTROL_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(?:submit|send|post|publish|tweet|reply|comment)\b", "i"));

/// Why a step is refused or fails closed before or after the person was asked. [`fmt::Display`] is the text the agent is told
/// (the wording of `action-approval.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalError {
    /// `MIXDOG_BROWSER_DENY_ACTIONS` names the action (or `*`).
    DeniedByPolicy,
    /// A name of an action policy is no Browser Use action.
    InvalidPolicy,
    /// The command cannot be approved as given (upload paths, an unreadable file).
    Invalid(String),
    /// The person did not approve; `reason` is their note.
    NotApproved { reason: String },
    /// The command was cancelled while it waited.
    Cancelled,
    /// The document, its URL, the command or the receiving frame is not what the person was shown.
    TargetChanged,
    /// An approved upload file has another size or modification time, or is gone.
    FileChanged,
    /// The page changed in the last moment before dispatch.
    TargetChangedBeforeDispatch,
}

/// What the agent is told when a person did not approve a step: the wording of every tool denial, with the person's note as the
/// reason when they gave one.
pub fn browser_not_approved(reason: &str) -> String {
    let why = reason.trim().trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    let why = if why.is_empty() { String::new() } else { format!(": {why}") };
    format!("tool \"browser\" was not approved{why}. Do not retry it or reach the same result another way; report it.")
}

impl fmt::Display for ApprovalError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DeniedByPolicy => out.write_str("Browser Use action is denied by policy; nothing was dispatched"),
            Self::InvalidPolicy => out.write_str("invalid Browser Use action policy; refusing dispatch"),
            Self::Invalid(message) => out.write_str(message),
            Self::NotApproved { reason } => out.write_str(&browser_not_approved(reason)),
            Self::Cancelled => out.write_str("approval cancelled"),
            Self::TargetChanged => out.write_str("Browser Use approval target changed; nothing was dispatched"),
            Self::FileChanged => out.write_str("approved upload file changed; nothing was dispatched"),
            Self::TargetChangedBeforeDispatch => out.write_str("approval target changed before dispatch"),
        }
    }
}

impl std::error::Error for ApprovalError {}

/// The operator's policy (`MIXDOG_BROWSER_CONFIRM_ACTIONS`, `MIXDOG_BROWSER_DENY_ACTIONS`, `MIXDOG_BROWSER_CONFIRM_SUBMIT`).
/// The two action lists are checked when a step is planned, not when the policy is made: a bad name refuses dispatch then.
#[derive(Debug, Clone)]
pub struct ActionPolicy {
    confirm_actions: String,
    deny_actions: String,
    confirm_submit: bool,
    is_action: fn(&str) -> bool,
}

impl ActionPolicy {
    /// `is_action` is the registry's rule for a Browser Use action name; `*` is always valid.
    pub fn new(confirm_actions: &str, deny_actions: &str, confirm_submit: bool, is_action: fn(&str) -> bool) -> Self {
        Self { confirm_actions: confirm_actions.to_owned(), deny_actions: deny_actions.to_owned(), confirm_submit, is_action }
    }

    /// From the three environment values (`None` when unset). Submits, posts and uploads ask by default; `0`, `false`, `no` or
    /// `off` (any case) turns that default off.
    pub fn from_env(confirm_actions: Option<&str>, deny_actions: Option<&str>, confirm_submit: Option<&str>, is_action: fn(&str) -> bool) -> Self {
        let off = confirm_submit.map(str::trim).is_some_and(|value| ["0", "false", "no", "off"].iter().any(|word| value.eq_ignore_ascii_case(word)));
        Self::new(confirm_actions.unwrap_or(""), deny_actions.unwrap_or(""), !off, is_action)
    }

    fn names(&self, raw: &str) -> Result<Vec<String>, ApprovalError> {
        let names: Vec<String> = raw.split(',').map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned).collect();
        if names.iter().any(|name| name != "*" && !(self.is_action)(name)) {
            return Err(ApprovalError::InvalidPolicy);
        }
        Ok(names)
    }
}

/// One step as the policy reads it: the top-level command, a `sequence` step.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepFacts {
    pub action: String,
    pub submit: bool,
    /// The key of a `press`.
    pub key: String,
    /// The accessible name of the target (`target.name`).
    pub target_name: String,
    /// What the card shows for the target: `describeBrowserTarget` of a target spec, else the redacted ref, snapshot id, name or
    /// the page identity. Describes actions and addresses only, never a typed value.
    pub describe: String,
}

/// The command an approval is asked for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApprovalCommand {
    pub step: StepFacts,
    /// A `sequence`'s steps.
    pub steps: Vec<StepFacts>,
    /// A batch `fill`'s fields, each as its card description.
    pub fields: Vec<String>,
    pub thread_id: Option<ThreadId>,
    pub session_id: String,
    /// Runtime-set life mark of the asking session.
    pub session_life: String,
    /// Runtime-set `unattended_run`: the command belongs to a schedule or webhook run.
    pub unattended: bool,
    /// Runtime-set `unattended_agent`: the bot that owns that run; empty when unknown.
    pub unattended_agent: String,
    /// An upload's paths as given.
    pub paths: Vec<String>,
}

fn step_kind(step: &StepFacts) -> Option<Remember> {
    if step.submit {
        return Some(Remember::Submit);
    }
    if step.action == "press" && step.key.to_lowercase() == "enter" {
        return Some(Remember::Submit);
    }
    (step.action == "click" && POST_CONTROL_NAME.is_match(&step.target_name)).then_some(Remember::Post)
}

/// Every kind of gated step the command holds, first seen first.
fn submit_kinds(command: &ApprovalCommand) -> Vec<Remember> {
    let mut kinds = Vec::new();
    for kind in std::iter::once(&command.step).chain(command.steps.iter()).filter_map(step_kind) {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds
}

/// A step that asks: why, and what the caller must read before [`classify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskPlan {
    kinds: Vec<Remember>,
    submits: bool,
    upload: bool,
}

impl AskPlan {
    /// The command is an `upload`: its files and receiving frame are read and bound.
    pub fn is_upload(&self) -> bool {
        self.upload
    }

    /// The step submits or posts: the page's payment evidence is read (`payment-evidence.ts`; an unreadable page counts as evidence).
    pub fn probes_payment(&self) -> bool {
        self.submits
    }
}

/// Whether the command asks under the policy: `Ok(None)` when nothing about it is gated.
pub fn plan(policy: &ActionPolicy, command: &ApprovalCommand) -> Result<Option<AskPlan>, ApprovalError> {
    let denied = policy.names(&policy.deny_actions)?;
    let confirmation = policy.names(&policy.confirm_actions)?;
    let names: Vec<&str> = std::iter::once(command.step.action.as_str()).chain(command.steps.iter().map(|step| step.action.as_str())).collect();
    if denied.iter().any(|name| name == "*") || names.iter().any(|name| denied.iter().any(|denied| denied == name)) {
        return Err(ApprovalError::DeniedByPolicy);
    }
    let kinds_of_steps = submit_kinds(command);
    let submits = policy.confirm_submit && !kinds_of_steps.is_empty();
    let confirmed = confirmation.iter().any(|name| name == "*") || names.iter().any(|name| confirmation.iter().any(|confirmed| confirmed == name));
    let upload = command.step.action == "upload";
    let uploads = policy.confirm_submit && upload;
    if !submits && !uploads && !confirmed {
        return Ok(None);
    }
    let mut kinds = if submits { kinds_of_steps } else { Vec::new() };
    if uploads {
        kinds.push(Remember::Upload);
    }
    if confirmed {
        kinds.push(Remember::Confirm);
    }
    Ok(Some(AskPlan { kinds, submits, upload }))
}

/// What was read about the target for a planned step.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetFacts {
    /// The page's URL and document id now: what the approval is bound to.
    pub url: String,
    pub document_id: String,
    /// The command as it will be dispatched, serialized after an upload's target is resolved to a ref and its paths made
    /// canonical: its hash is bound.
    pub command_json: String,
    /// An upload's files (`binding::resolve_upload_files`); empty for any other step.
    pub files: Vec<BoundFile>,
    /// The receiving frame document's URL and key; empty when it could not be confirmed.
    pub receiver_url: String,
    pub receiver_key: String,
    /// The page shows payment evidence; read only when [`AskPlan::probes_payment`].
    pub payment: bool,
}

/// `scheme://host[:port]` of a URL; empty when it has no tuple origin.
pub fn origin_of_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => match parsed.origin() {
            url::Origin::Opaque(_) => String::new(),
            origin => origin.ascii_serialization(),
        },
        Err(_) => String::new(),
    }
}

/// Describe only actions and addresses, never form values or typed secrets.
fn describe_targets(command: &ApprovalCommand) -> String {
    let mut summary = command.step.describe.clone();
    if command.step.action == "sequence" && !command.steps.is_empty() {
        summary = command
            .steps
            .iter()
            .enumerate()
            .map(|(index, step)| format!("{}. {}{}: {}", index + 1, redact_browser_text(&step.action), if step.submit { " (submit)" } else { "" }, step.describe))
            .collect::<Vec<_>>()
            .join("\n");
    } else if command.step.action == "fill" && !command.fields.is_empty() {
        summary = command.fields.iter().enumerate().map(|(index, field)| format!("{}. fill: {field}", index + 1)).collect::<Vec<_>>().join("\n");
    }
    if command.step.submit { format!("{summary}\nSubmit form") } else { summary }
}

fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
}

/// The ask for a planned step: its class, what the person is shown, and what an approval binds. The payment floor is its own
/// class (`kind` is [`BrowserApprovalKind::Payment`]): every time, no standing allow of any kind covers it; `prompt.kinds` keeps
/// the kinds the command holds either way. `prompt.files[..].outside` is left false: it needs the asking session's working
/// directory, which the gate marks with `binding::mark_outside`.
pub fn classify(plan: &AskPlan, command: &ApprovalCommand, facts: TargetFacts) -> BrowserApprovalAsk {
    let payment = plan.submits && facts.payment;
    let kind = if payment {
        BrowserApprovalKind::Payment
    } else {
        match plan.kinds[0] {
            Remember::Submit => BrowserApprovalKind::Submit,
            Remember::Post => BrowserApprovalKind::Post,
            Remember::Upload => BrowserApprovalKind::Upload,
            Remember::Confirm => BrowserApprovalKind::Confirm,
        }
    };
    let paths = if plan.upload { facts.files.iter().map(|file| file.path.clone()).collect() } else { command.paths.clone() };
    let files = facts
        .files
        .iter()
        .map(|file| BrowserApprovalFile { name: base_name(&file.path), path: file.path.clone(), size: i64::try_from(file.size).unwrap_or(i64::MAX), outside: false })
        .collect();
    let prompt = BrowserApprovalPrompt {
        thread_id: command.thread_id.clone(),
        action: command.step.action.clone(),
        url: facts.url.clone(),
        session_id: command.session_id.clone(),
        target: describe_targets(command),
        paths,
        kinds: plan.kinds.clone(),
        files,
        receiver_origin: if plan.upload { origin_of_url(&facts.receiver_url) } else { String::new() },
        unattended: command.unattended,
        unattended_agent: if command.unattended { command.unattended_agent.trim().to_owned() } else { String::new() },
        session_life: command.session_life.clone(),
        payment,
    };
    let binding = Binding { url: facts.url, document_id: facts.document_id, command_hash: command_hash(&facts.command_json), files: facts.files, receiver_key: facts.receiver_key };
    BrowserApprovalAsk { kind, prompt, binding }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(name: &str) -> bool {
        ["click", "fill", "press", "upload", "sequence", "navigate", "snapshot", "type"].contains(&name)
    }

    fn policy() -> ActionPolicy {
        ActionPolicy::from_env(None, None, None, known)
    }

    fn click(name: &str) -> ApprovalCommand {
        ApprovalCommand { step: StepFacts { action: "click".into(), target_name: name.into(), describe: format!("name={name}"), ..Default::default() }, ..Default::default() }
    }

    fn kinds_of(command: &ApprovalCommand) -> Option<Vec<Remember>> {
        plan(&policy(), command).expect("plan").map(|plan| plan.kinds)
    }

    #[test]
    fn a_send_or_post_control_asks_as_post_and_any_other_click_does_not() {
        for name in ["Send", "submit", "Post comment", "Publish now", "Tweet", "reply", "ADD COMMENT", "Please send."] {
            assert_eq!(kinds_of(&click(name)), Some(vec![Remember::Post]), "{name}");
        }
        for name in ["Resend", "Sender", "Compost", "Open", "", "commenting"] {
            assert_eq!(kinds_of(&click(name)), None, "{name}");
        }
        // `\b` is ASCII-only as in V8: a letter of another script is no word character.
        assert_eq!(kinds_of(&click("send\u{ACBD}")), Some(vec![Remember::Post]));
    }

    #[test]
    fn a_submit_flag_and_enter_ask_as_submit() {
        let mut fill = click("");
        fill.step.action = "fill".into();
        fill.step.submit = true;
        assert_eq!(kinds_of(&fill), Some(vec![Remember::Submit]));
        let enter = ApprovalCommand { step: StepFacts { action: "press".into(), key: "ENTER".into(), ..Default::default() }, ..Default::default() };
        assert_eq!(kinds_of(&enter), Some(vec![Remember::Submit]));
        let tab = ApprovalCommand { step: StepFacts { action: "press".into(), key: "Tab".into(), ..Default::default() }, ..Default::default() };
        assert_eq!(kinds_of(&tab), None);
    }

    #[test]
    fn a_command_names_its_kinds_apart_in_first_seen_order() {
        let mut sequence = ApprovalCommand { step: StepFacts { action: "sequence".into(), ..Default::default() }, ..Default::default() };
        sequence.steps = vec![click("Send").step, StepFacts { action: "fill".into(), submit: true, ..Default::default() }, click("Post").step];
        assert_eq!(kinds_of(&sequence), Some(vec![Remember::Post, Remember::Submit]));
        let confirm = ActionPolicy::from_env(Some("click"), None, None, known);
        let both = plan(&confirm, &click("Send")).unwrap().unwrap();
        assert_eq!(both.kinds, vec![Remember::Post, Remember::Confirm]);
    }

    #[test]
    fn nothing_else_asks_by_default() {
        for action in ["snapshot", "navigate", "type", "fill"] {
            let command = ApprovalCommand { step: StepFacts { action: action.into(), ..Default::default() }, ..Default::default() };
            assert_eq!(kinds_of(&command), None, "{action}");
        }
    }

    #[test]
    fn the_opt_out_turns_only_the_defaults_off() {
        for value in ["0", "false", "No", " OFF "] {
            let off = ActionPolicy::from_env(None, None, Some(value), known);
            assert_eq!(plan(&off, &click("Send")).unwrap(), None, "{value}");
        }
        let on = ActionPolicy::from_env(None, None, Some("1"), known);
        assert!(plan(&on, &click("Send")).unwrap().is_some());
        let named = ActionPolicy::from_env(Some("click"), None, Some("0"), known);
        assert_eq!(plan(&named, &click("Open")).unwrap().unwrap().kinds, vec![Remember::Confirm]);
        let upload = ApprovalCommand { step: StepFacts { action: "upload".into(), ..Default::default() }, ..Default::default() };
        let off = ActionPolicy::from_env(None, None, Some("off"), known);
        assert_eq!(plan(&off, &upload).unwrap(), None);
        assert_eq!(kinds_of(&upload), Some(vec![Remember::Upload]));
    }

    #[test]
    fn the_deny_policy_refuses_before_asking_and_a_bad_name_refuses_dispatch() {
        let deny = ActionPolicy::from_env(None, Some("click"), None, known);
        assert_eq!(plan(&deny, &click("Open")), Err(ApprovalError::DeniedByPolicy));
        let mut sequence = ApprovalCommand { step: StepFacts { action: "sequence".into(), ..Default::default() }, ..Default::default() };
        sequence.steps = vec![click("Open").step];
        assert_eq!(plan(&deny, &sequence), Err(ApprovalError::DeniedByPolicy));
        let all = ActionPolicy::from_env(None, Some("*"), None, known);
        assert_eq!(plan(&all, &sequence), Err(ApprovalError::DeniedByPolicy));
        let bad = ActionPolicy::from_env(Some("click, nope"), None, None, known);
        assert_eq!(plan(&bad, &click("Open")), Err(ApprovalError::InvalidPolicy));
        assert_eq!(ApprovalError::InvalidPolicy.to_string(), "invalid Browser Use action policy; refusing dispatch");
        assert_eq!(ApprovalError::DeniedByPolicy.to_string(), "Browser Use action is denied by policy; nothing was dispatched");
        let star = ActionPolicy::from_env(Some("*"), None, None, known);
        assert_eq!(plan(&star, &ApprovalCommand::default()).unwrap().unwrap().kinds, vec![Remember::Confirm]);
    }

    #[test]
    fn a_denial_is_worded_as_every_tool_denial_with_the_persons_note() {
        assert_eq!(browser_not_approved(""), "tool \"browser\" was not approved. Do not retry it or reach the same result another way; report it.");
        assert_eq!(
            browser_not_approved("  not now. "),
            "tool \"browser\" was not approved: not now. Do not retry it or reach the same result another way; report it."
        );
    }

    #[test]
    fn the_card_describes_every_step_and_field_and_the_explicit_submit() {
        let mut sequence = ApprovalCommand { step: StepFacts { action: "sequence".into(), describe: "ignored".into(), ..Default::default() }, ..Default::default() };
        sequence.steps = vec![click("Send").step, StepFacts { action: "fill".into(), submit: true, describe: "ref e3".into(), ..Default::default() }];
        assert_eq!(describe_targets(&sequence), "1. click: name=Send\n2. fill (submit): ref e3");
        let fill = ApprovalCommand {
            step: StepFacts { action: "fill".into(), submit: true, describe: "one".into(), ..Default::default() },
            fields: vec!["a".into(), "b".into()],
            ..Default::default()
        };
        assert_eq!(describe_targets(&fill), "1. fill: a\n2. fill: b\nSubmit form");
    }

    #[test]
    fn the_ask_carries_the_prompt_and_the_binding_of_the_step() {
        let mut command = click("Send");
        command.session_id = "sess_home_ann".into();
        command.session_life = "life-1".into();
        command.unattended = true;
        command.unattended_agent = "  ann ".into();
        let step = plan(&policy(), &command).unwrap().unwrap();
        assert!(step.probes_payment() && !step.is_upload());
        let facts = TargetFacts { url: "https://a.test/x".into(), document_id: "p:1".into(), command_json: "{\"a\":1}".into(), payment: true, ..Default::default() };
        let ask = classify(&step, &command, facts);
        assert_eq!(ask.kind, BrowserApprovalKind::Payment);
        assert!(ask.prompt.payment && ask.prompt.unattended);
        assert_eq!((ask.prompt.unattended_agent.as_str(), ask.prompt.session_life.as_str()), ("ann", "life-1"));
        assert_eq!(ask.prompt.kinds, vec![Remember::Post]);
        assert_eq!((ask.binding.url.as_str(), ask.binding.document_id.as_str()), ("https://a.test/x", "p:1"));
        assert_eq!(ask.binding.command_hash, command_hash("{\"a\":1}"));
        assert_ne!(ask.binding.command_hash, command_hash("{\"a\":2}"));
    }

    #[test]
    fn payment_evidence_counts_only_for_a_step_that_submits_or_posts() {
        let confirm = ActionPolicy::from_env(Some("click"), None, None, known);
        let step = plan(&confirm, &click("Open")).unwrap().unwrap();
        assert!(!step.probes_payment());
        let ask = classify(&step, &click("Open"), TargetFacts { payment: true, ..Default::default() });
        assert_eq!((ask.kind, ask.prompt.payment), (BrowserApprovalKind::Confirm, false));
    }

    #[test]
    fn an_upload_ask_lists_its_files_and_the_receiving_origin() {
        let command = ApprovalCommand { step: StepFacts { action: "upload".into(), ..Default::default() }, paths: vec!["/raw".into()], ..Default::default() };
        let step = plan(&policy(), &command).unwrap().unwrap();
        assert!(step.is_upload() && !step.probes_payment());
        let file = BoundFile { path: "C:\\tmp\\a b.txt".into(), size: 7, mtime: None, realpath: "C:\\tmp\\a b.txt".into() };
        let ask = classify(&step, &command, TargetFacts { files: vec![file], receiver_url: "https://up.test:8443/form?x=1".into(), receiver_key: "k".into(), ..Default::default() });
        assert_eq!(ask.kind, BrowserApprovalKind::Upload);
        assert_eq!(ask.prompt.paths, vec!["C:\\tmp\\a b.txt".to_string()]);
        assert_eq!((ask.prompt.files[0].name.as_str(), ask.prompt.files[0].size), ("a b.txt", 7));
        assert_eq!(ask.prompt.receiver_origin, "https://up.test:8443");
        let unconfirmed = classify(&step, &command, TargetFacts::default());
        assert_eq!(unconfirmed.prompt.receiver_origin, "");
    }

    #[test]
    fn an_origin_is_the_tuple_origin_or_empty() {
        assert_eq!(origin_of_url("https://a.test/x?y"), "https://a.test");
        assert_eq!(origin_of_url("http://a.test:81/"), "http://a.test:81");
        for opaque in ["file:///C:/x", "about:blank", "data:text/html,hi", "not a url", ""] {
            assert_eq!(origin_of_url(opaque), "", "{opaque}");
        }
    }
}
