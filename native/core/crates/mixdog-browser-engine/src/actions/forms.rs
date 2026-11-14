//! Owner: s4-engine-actions-forms
//! Form controls addressed by ref (`actions/forms.ts`): text entry, selection, checkboxes, and answering the dialog that a
//! submit may have opened. File uploads are the upload module's.
//!
//! A handler reads the command and drives the page through a [`FormContext`], which the command runner implements over the
//! page's state: it resolves targets to refs, runs a mutation behind the read-only recovery preflight (`mutate_ref`), keeps the
//! effect baseline and builds the settled reply. The handlers never reach the host except for the keys and the dialog answer.

use std::future::Future;
use std::pin::Pin;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageDialogAnswerParams;
use mixdog_rt::CancelView;
use serde_json::Value;

use crate::error::HostCallError;
use crate::refs::access::RefError;
use crate::refs::control_state::SelectOptions;
use crate::refs::ref_actions::RefActions;
use crate::reply::reply::ToolReply;

/// A fill takes at most this many fields.
const MAX_FILL_FIELDS: usize = 30;

/// A mutation of one ref, run on the ref recovery settled on (`operation` of `mutateRef`).
pub type Mutation = Box<dyn FnOnce(String) -> Pin<Box<dyn Future<Output = Result<(), RefError>> + Send>> + Send>;

fn mutation<F, Fut>(operation: F) -> Mutation
where
    F: FnOnce(String) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), RefError>> + Send + 'static,
{
    Box::new(move |ref_id| Box::pin(operation(ref_id)))
}

/// What a stored login's fill reports: whether the form took the password, and if not why.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StoredLoginFill {
    pub password_filled: bool,
    /// `no-password-field` when the page has no visible password field of its own document.
    pub reason: Option<String>,
}

/// What every form handler receives (the part of `BrowserActionContext` and its services they use).
#[async_trait]
pub trait FormContext: Send {
    /// The command as the caller gave it.
    fn command(&self) -> &Value;
    fn cancel(&self) -> &CancelView;
    /// The page's gesture handles at this moment (a resolved target or a recovery moves the snapshot they are decided against).
    fn ref_actions(&self) -> RefActions;
    /// `actionRef`: the command's own ref, or the one its `target` resolves to now (the context adopts the fresh observation for
    /// recovery and the effect baseline); `None` when it names neither.
    async fn action_ref(&mut self) -> Result<Option<String>, RefError>;
    /// `resolveTargetRefs` and `adoptResolvedTargets` for several targets, resolved against ONE observation.
    async fn resolve_target_refs(&mut self, targets: &[Value]) -> Result<Vec<String>, RefError>;
    /// `mutateRef`: the read-only preflight (with ref recovery), then `operation` once; a failure of the operation retires the
    /// page's refs and is reported as possibly executed and never replayed.
    async fn mutate_ref(&mut self, source_ref: &str, operation: Mutation, editable: bool) -> Result<(), RefError>;
    /// The options of a select, read under ref recovery (a read never changes the page).
    async fn list_select_options(&mut self, source_ref: &str) -> Result<SelectOptions, RefError>;
    /// A stored login: the host matches the account to the page origin and writes the password itself.
    async fn fill_stored(&mut self, account: &str) -> Result<StoredLoginFill, RefError>;
    /// `invalidateInteraction`: the refs the page held before the control changed are forgotten.
    fn invalidate_interaction(&mut self);
    /// The settled, verified snapshot reply for a completed gesture.
    async fn action_snapshot(&mut self) -> Result<ToolReply, RefError>;
    /// `decorateRecovery`: what recovery did before dispatch, stated first.
    fn decorate_recovery(&self, reply: ToolReply) -> ToolReply;
    /// A fresh observation to show after a failed fill: the snapshot text, or `Fresh observation failed: <why>`. Fails only when
    /// the command was cancelled.
    async fn observation_after_failure(&mut self) -> Result<String, RefError>;
}

/// JavaScript's `String(value)` for the scalar a command field holds.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// JavaScript truthiness of an optional command field (`Boolean(command.submit)`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|found| !found.is_null())
}

fn failed(message: impl Into<String>) -> RefError {
    RefError::Failed(message.into())
}

fn check_cancel(context: &dyn FormContext) -> Result<(), RefError> {
    if context.cancel().is_cancelled() { Err(HostCallError::Cancelled.into()) } else { Ok(()) }
}

/// After the control changed: forget the old refs, optionally submit, and reply with the settled snapshot plus any recovery
/// notes.
async fn after_edit(context: &mut dyn FormContext, submit: bool) -> Result<ToolReply, RefError> {
    check_cancel(context)?;
    context.invalidate_interaction();
    if submit {
        context.ref_actions().press_key("Enter").await?;
    }
    let reply = context.action_snapshot().await?;
    Ok(context.decorate_recovery(reply))
}

/// The strings of a field's `values`, when it is a non-empty array of strings.
fn field_values(field: &Value) -> Option<Vec<String>> {
    let list = field.get("values")?.as_array()?;
    if list.is_empty() {
        return None;
    }
    list.iter().map(|value| value.as_str().map(str::to_string)).collect()
}

/// `fill`: one control (text, or a checked state), many controls, or a stored login.
pub async fn fill(context: &mut dyn FormContext) -> Result<ToolReply, RefError> {
    let command = context.command().clone();
    let submit = truthy(command.get("submit"));
    if let Some(account) = command.get("savedAccount").and_then(Value::as_str) {
        // A stored login: the host writes the password itself; the handler only learns whether the form took it.
        check_cancel(context)?;
        let filled = context.fill_stored(account).await?;
        check_cancel(context)?;
        if !filled.password_filled {
            return Err(failed(if filled.reason.as_deref() == Some("no-password-field") {
                "no visible password field in this page (a sign-in form inside an embedded frame is never filled); open the sign-in form or its password step first"
            } else {
                "the password field did not accept the stored login"
            }));
        }
        return after_edit(context, submit).await;
    }
    let fields: Vec<Value> = command.get("fields").and_then(Value::as_array).cloned().unwrap_or_default();
    // A code or secret the caller marked: registered before the page sees it, so no reply, snapshot or error of this session
    // repeats it.
    if command.get("sensitive") == Some(&Value::Bool(true)) {
        let actions = context.ref_actions();
        let marked = std::iter::once(command.get("text")).chain(fields.iter().flat_map(|field| [field.get("text"), field.get("value")]));
        for value in marked.flatten().filter_map(Value::as_str).filter(|value| !value.is_empty()) {
            (actions.remember_secret)(value);
        }
    }
    if fields.is_empty() {
        let Some(ref_id) = context.action_ref().await? else {
            return Err(failed("fill requires ref, target, or fields"));
        };
        // One control: text for an input, or a checked state for a checkbox or radio; exactly one of the two.
        let text = command.get("text").and_then(Value::as_str).map(str::to_string);
        let checked = command.get("checked").and_then(Value::as_bool);
        if text.is_some() == checked.is_some() {
            return Err(failed("fill requires text or checked"));
        }
        let actions = context.ref_actions();
        let editable = text.is_some();
        let operation = match (text, checked) {
            (Some(text), _) => mutation(move |ref_id| async move { actions.fill_ref(&ref_id, &text).await.map(|_| ()) }),
            (None, Some(checked)) => mutation(move |ref_id| async move { actions.set_checked_ref(&ref_id, checked).await }),
            (None, None) => return Err(failed("fill requires text or checked")),
        };
        context.mutate_ref(&ref_id, operation, editable).await?;
        return after_edit(context, submit).await;
    }
    if fields.len() > MAX_FILL_FIELDS {
        return Err(failed(format!("fill requires at most {MAX_FILL_FIELDS} fields")));
    }
    // Targets are resolved against ONE fresh observation before any field changes; refs and targets cannot mix because that
    // observation would retire the caller's refs.
    let targets: Vec<Value> = fields.iter().filter_map(|field| present(field, "target").cloned()).collect();
    if !targets.is_empty() && targets.len() != fields.len() {
        return Err(failed("fill.fields must address every item by ref or every item by target, not a mix"));
    }
    let field_refs: Vec<String> = if targets.is_empty() {
        fields.iter().map(|field| field.get("ref").and_then(Value::as_str).unwrap_or_default().to_string()).collect()
    } else {
        context.resolve_target_refs(&targets).await?
    };
    let mut completed = 0;
    for (field, field_ref) in fields.iter().zip(&field_refs) {
        if let Err(error) = fill_field(context, field, field_ref).await {
            if completed > 0 {
                context.invalidate_interaction();
            }
            if context.cancel().is_cancelled() {
                return Err(HostCallError::Cancelled.into());
            }
            let observation = context.observation_after_failure().await?;
            return Err(failed(format!(
                "Fill stopped at field {} of {}; {completed} field(s) completed. Input was not replayed. Do not repeat completed fields; inspect the failing field before continuing. {error}\n\n{observation}",
                completed + 1,
                fields.len()
            )));
        }
        completed += 1;
    }
    after_edit(context, submit).await
}

/// One field of a multi-field fill: exactly one of `text`/`value`, `values`, or `checked`.
async fn fill_field(context: &mut dyn FormContext, field: &Value, field_ref: &str) -> Result<(), RefError> {
    let text = field.get("text").and_then(Value::as_str);
    let value = field.get("value").and_then(Value::as_str);
    let values = field_values(field);
    let checked = field.get("checked").and_then(Value::as_bool);
    let payloads = usize::from(text.is_some() || value.is_some()) + usize::from(values.is_some()) + usize::from(checked.is_some());
    if field_ref.is_empty() || payloads != 1 || (text.is_some() && value.is_some()) {
        return Err(failed("each fill field requires ref or target and exactly one of text/value, values, or checked"));
    }
    let actions = context.ref_actions();
    let editable = values.is_none() && checked.is_none();
    let operation = if let Some(values) = values {
        mutation(move |ref_id| async move { actions.select_ref(&ref_id, &values).await.map(|_| ()) })
    } else if let Some(checked) = checked {
        mutation(move |ref_id| async move { actions.set_checked_ref(&ref_id, checked).await })
    } else {
        let text = text.or(value).map(str::to_string).unwrap_or_default();
        mutation(move |ref_id| async move { actions.fill_ref(&ref_id, &text).await.map(|_| ()) })
    };
    context.mutate_ref(field_ref, operation, editable).await
}

/// `type`: real keystrokes into one control, for the controls that only react while a person types.
pub async fn type_text(context: &mut dyn FormContext) -> Result<ToolReply, RefError> {
    let command = context.command().clone();
    let Some(ref_id) = context.action_ref().await? else {
        return Err(failed("type requires ref (from snapshot) or target"));
    };
    let Some(text) = command.get("text").and_then(Value::as_str).map(str::to_string) else {
        return Err(failed("type requires text"));
    };
    let actions = context.ref_actions();
    context.mutate_ref(&ref_id, mutation(move |ref_id| async move { actions.type_ref(&ref_id, &text).await }), true).await?;
    after_edit(context, truthy(command.get("submit"))).await
}

/// `select`: without values it lists the options and leaves the page exactly as it was; with values it chooses them.
pub async fn select(context: &mut dyn FormContext) -> Result<ToolReply, RefError> {
    let command = context.command().clone();
    let Some(ref_id) = context.action_ref().await? else {
        return Err(failed("select requires ref (from snapshot) or target"));
    };
    let values: Vec<String> = command.get("values").and_then(Value::as_array).map(|list| list.iter().map(js_string).collect()).unwrap_or_default();
    if values.is_empty() {
        let SelectOptions { options, total } = context.list_select_options(&ref_id).await?;
        let actions = context.ref_actions();
        let count = match total {
            Some(total) if total > 0 => format!("first {} of {total}", options.len()),
            _ => options.len().to_string(),
        };
        let text = if options.is_empty() {
            format!("{ref_id} has no options.")
        } else {
            let lines: Vec<String> = options.iter().map(|option| format!("- {}", (actions.redact)(option))).collect();
            format!("Options for {ref_id} ({count}):\n{}", lines.join("\n"))
        };
        return Ok(context.decorate_recovery(ToolReply::text(text)));
    }
    let actions = context.ref_actions();
    context.mutate_ref(&ref_id, mutation(move |ref_id| async move { actions.select_ref(&ref_id, &values).await.map(|_| ()) }), false).await?;
    after_edit(context, false).await
}

/// `handle_dialog`: answers the JavaScript dialog that blocks the page (a submit may have opened it).
pub async fn handle_dialog(context: &mut dyn FormContext) -> Result<ToolReply, RefError> {
    let command = context.command().clone();
    let accept = command.get("accept") == Some(&Value::Bool(true));
    let prompt_text = command.get("promptText").filter(|text| truthy(Some(*text))).map(js_string).unwrap_or_default();
    let actions = context.ref_actions();
    let params = HostBrowserPageDialogAnswerParams { page_id: actions.page_id.clone(), accept, prompt_text: Some(prompt_text), expect: actions.expect.clone() };
    if !actions.host.page_dialog_answer(params, actions.cancel.token()).await?.answered {
        return Err(failed("no JavaScript dialog is currently open"));
    }
    context.invalidate_interaction();
    context.action_snapshot().await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use mixdog_rt::CancellationToken;
    use serde_json::json;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::ref_actions::tests::actions;
    use crate::refs::ref_actions::tests::batch_done;
    use crate::refs::ref_actions::tests::call;

    /// A context over a scripted host: `mutate_ref` runs the operation on the ref as given and the log records each step.
    struct Context {
        command: Value,
        actions: RefActions,
        log: Arc<Mutex<Vec<String>>>,
        targets: Vec<String>,
        stored: StoredLoginFill,
        options: SelectOptions,
    }

    fn context(command: Value, script: Vec<Expect>) -> (Context, Arc<FakeHost>, Arc<Mutex<Vec<String>>>) {
        let host = Arc::new(FakeHost::scripted(script));
        let log = Arc::new(Mutex::new(Vec::new()));
        let context = Context {
            command,
            actions: actions(host.clone()),
            log: log.clone(),
            targets: Vec::new(),
            stored: StoredLoginFill::default(),
            options: SelectOptions::default(),
        };
        (context, host, log)
    }

    #[async_trait]
    impl FormContext for Context {
        fn command(&self) -> &Value {
            &self.command
        }
        fn cancel(&self) -> &CancelView {
            &self.actions.cancel
        }
        fn ref_actions(&self) -> RefActions {
            self.actions.clone()
        }
        async fn action_ref(&mut self) -> Result<Option<String>, RefError> {
            Ok(self.command.get("ref").and_then(Value::as_str).map(str::to_string))
        }
        async fn resolve_target_refs(&mut self, targets: &[Value]) -> Result<Vec<String>, RefError> {
            self.log.lock().expect("log").push(format!("resolve {}", targets.len()));
            Ok(self.targets.clone())
        }
        async fn mutate_ref(&mut self, source_ref: &str, operation: Mutation, editable: bool) -> Result<(), RefError> {
            self.log.lock().expect("log").push(format!("mutate {source_ref} editable={editable}"));
            operation(source_ref.to_string()).await
        }
        async fn list_select_options(&mut self, _source_ref: &str) -> Result<SelectOptions, RefError> {
            Ok(self.options.clone())
        }
        async fn fill_stored(&mut self, account: &str) -> Result<StoredLoginFill, RefError> {
            self.log.lock().expect("log").push(format!("stored {account}"));
            Ok(self.stored.clone())
        }
        fn invalidate_interaction(&mut self) {
            self.log.lock().expect("log").push("invalidate".into());
        }
        async fn action_snapshot(&mut self) -> Result<ToolReply, RefError> {
            Ok(ToolReply::text("settled"))
        }
        fn decorate_recovery(&self, mut reply: ToolReply) -> ToolReply {
            reply.text = format!("decorated {}", reply.text);
            reply
        }
        async fn observation_after_failure(&mut self) -> Result<String, RefError> {
            Ok("observation".into())
        }
    }

    fn fill_value(value: &str) -> Expect {
        call(json!({"value": value}))
    }

    #[tokio::test]
    async fn one_control_is_filled_then_the_settled_reply_is_decorated() {
        let (mut context, host, log) = context(json!({"ref": "p1-s2-e3", "text": "hello"}), vec![fill_value("hello")]);
        let reply = fill(&mut context).await.expect("filled");
        assert_eq!(reply.text, "decorated settled");
        assert_eq!(*log.lock().expect("log"), ["mutate p1-s2-e3 editable=true", "invalidate"]);
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn a_submit_presses_enter_after_the_edit() {
        let (mut context, host, _) = context(json!({"ref": "p1-s2-e3", "text": "q", "submit": true}), vec![fill_value("q"), batch_done().with_params(json!({"steps": [{"op": "press", "key": "Enter"}]}))]);
        fill(&mut context).await.expect("filled and submitted");
        host.finish().expect("fill, then the key");
    }

    #[tokio::test]
    async fn a_checked_state_is_set_and_text_with_checked_is_refused() {
        let (mut context, host, log) = context(json!({"ref": "p1-s2-e3", "checked": true}), vec![call(json!({"checked": true, "radio": false}))]);
        fill(&mut context).await.expect("already checked");
        assert_eq!(log.lock().expect("log")[0], "mutate p1-s2-e3 editable=false");
        host.finish().expect("state read");
        for command in [json!({"ref": "r", "text": "a", "checked": true}), json!({"ref": "r"})] {
            let (mut context, _, _) = self::context(command, Vec::new());
            assert_eq!(fill(&mut context).await, Err(failed("fill requires text or checked")));
        }
        let (mut context, _, _) = self::context(json!({}), Vec::new());
        assert_eq!(fill(&mut context).await, Err(failed("fill requires ref, target, or fields")));
    }

    #[tokio::test]
    async fn a_stored_login_reports_why_the_form_did_not_take_it() {
        let (mut context, _, log) = context(json!({"savedAccount": "work"}), Vec::new());
        context.stored = StoredLoginFill { password_filled: false, reason: Some("no-password-field".into()) };
        let error = fill(&mut context).await.expect_err("no field");
        assert!(error.to_string().starts_with("no visible password field in this page"));
        context.stored = StoredLoginFill { password_filled: false, reason: None };
        assert_eq!(fill(&mut context).await, Err(failed("the password field did not accept the stored login")));
        assert_eq!(log.lock().expect("log")[0], "stored work");
        context.stored = StoredLoginFill { password_filled: true, reason: None };
        assert_eq!(fill(&mut context).await.expect("filled").text, "decorated settled");
    }

    #[tokio::test]
    async fn a_cancelled_stored_login_passes_the_cancel_through_and_never_submits() {
        let token = CancellationToken::new();
        let (mut context, host, log) = context(json!({"savedAccount": "work", "submit": true}), Vec::new());
        context.stored = StoredLoginFill { password_filled: true, reason: None };
        context.actions.cancel = token.clone().into();
        token.cancel();
        assert_eq!(fill(&mut context).await, Err(RefError::Host(HostCallError::Cancelled)));
        assert!(log.lock().expect("log").is_empty(), "no fill, no invalidation");
        host.finish().expect("no Enter");
    }

    #[tokio::test]
    async fn many_fields_are_filled_in_order_each_with_its_own_gesture() {
        let fields = json!([{"ref": "p1-s2-e1", "text": "a"}, {"ref": "p1-s2-e2", "checked": true}, {"ref": "p1-s2-e3", "values": ["x"]}]);
        let script = vec![fill_value("a"), call(json!({"checked": true})), call(json!({"values": ["x"]}))];
        let (mut context, host, log) = context(json!({"fields": fields}), script);
        fill(&mut context).await.expect("all filled");
        assert_eq!(
            *log.lock().expect("log"),
            ["mutate p1-s2-e1 editable=true", "mutate p1-s2-e2 editable=false", "mutate p1-s2-e3 editable=false", "invalidate"]
        );
        host.finish().expect("three calls");
    }

    #[tokio::test]
    async fn a_failing_field_stops_the_fill_and_says_what_completed() {
        let fields = json!([{"ref": "p1-s2-e1", "text": "a"}, {"ref": "p1-s2-e2", "text": "b"}, {"ref": "p1-s2-e3", "text": "c"}]);
        let (mut context, host, log) = context(json!({"fields": fields}), vec![fill_value("a"), call(json!({"error": "element is readonly"}))]);
        let error = fill(&mut context).await.expect_err("stopped").to_string();
        assert_eq!(
            error,
            "Fill stopped at field 2 of 3; 1 field(s) completed. Input was not replayed. Do not repeat completed fields; inspect the failing field before continuing. element is readonly\n\nobservation"
        );
        assert_eq!(log.lock().expect("log").last().map(String::as_str), Some("invalidate"));
        host.finish().expect("the third field was never tried");
    }

    #[tokio::test]
    async fn fields_follow_the_shape_rules() {
        let many: Vec<Value> = (0..31).map(|index| json!({"ref": format!("p1-s2-e{index}"), "text": "x"})).collect();
        let cases = [
            (json!({"fields": many}), "fill requires at most 30 fields"),
            (json!({"fields": [{"target": {"name": "a"}, "text": "x"}, {"ref": "p1-s2-e1", "text": "y"}]}), "fill.fields must address every item by ref or every item by target, not a mix"),
        ];
        for (command, message) in cases {
            let (mut context, _, _) = self::context(command, Vec::new());
            assert_eq!(fill(&mut context).await, Err(failed(message)));
        }
        let bad = "Fill stopped at field 1 of 1; 0 field(s) completed. Input was not replayed. Do not repeat completed fields; inspect the failing field before continuing. each fill field requires ref or target and exactly one of text/value, values, or checked\n\nobservation";
        for field in [json!({"ref": "p1-s2-e1"}), json!({"ref": "p1-s2-e1", "text": "a", "value": "b"}), json!({"ref": "p1-s2-e1", "text": "a", "checked": true}), json!({"text": "a"})] {
            let (mut context, _, _) = self::context(json!({"fields": [field]}), Vec::new());
            assert_eq!(fill(&mut context).await, Err(failed(bad)));
        }
    }

    #[tokio::test]
    async fn targets_resolve_once_for_all_fields_and_a_value_key_fills_like_text() {
        let fields = json!([{"target": {"name": "a"}, "value": "one"}, {"target": {"name": "b"}, "text": "two"}]);
        let (mut context, host, log) = context(json!({"fields": fields}), vec![fill_value("one"), fill_value("two")]);
        context.targets = vec!["p1-s2-e4".into(), "p1-s2-e5".into()];
        fill(&mut context).await.expect("filled");
        assert_eq!(log.lock().expect("log")[..3], ["resolve 2", "mutate p1-s2-e4 editable=true", "mutate p1-s2-e5 editable=true"]);
        host.finish().expect("two fills");
    }

    #[tokio::test]
    async fn a_sensitive_fill_registers_every_text_before_the_page_sees_it() {
        let (mut context, _, _) = context(json!({"sensitive": true, "text": "t0", "fields": [{"ref": "p1-s2-e1", "text": "t1", "value": ""}, {"ref": "p1-s2-e2", "value": "t2"}]}), vec![]);
        let secrets = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = secrets.clone();
        context.actions.remember_secret = Arc::new(move |value: &str| sink.lock().expect("secrets").push(value.to_string()));
        let _ = fill(&mut context).await;
        assert_eq!(*secrets.lock().expect("secrets"), ["t0", "t1", "t2"]);
    }

    #[tokio::test]
    async fn a_cancelled_fill_ends_as_a_cancel_not_as_a_field_failure() {
        let token = CancellationToken::new();
        let fields = json!([{"ref": "p1-s2-e1", "text": "a"}]);
        let (mut context, _, _) = context(json!({"fields": fields}), vec![fill_value("a")]);
        context.actions.cancel = token.clone().into();
        token.cancel();
        assert_eq!(fill(&mut context).await, Err(RefError::Host(HostCallError::Cancelled)));
    }

    #[tokio::test]
    async fn type_needs_a_ref_and_text_and_types_in_one_batch() {
        let (mut context, _, _) = context(json!({"text": "x"}), Vec::new());
        assert_eq!(type_text(&mut context).await, Err(failed("type requires ref (from snapshot) or target")));
        let (mut context, _, _) = self::context(json!({"ref": "p1-s2-e1"}), Vec::new());
        assert_eq!(type_text(&mut context).await, Err(failed("type requires text")));
        let (mut context, host, log) = self::context(json!({"ref": "p1-s2-e1", "text": "abc"}), vec![call(json!({})), batch_done().with_params(json!({"steps": [{"op": "press"}, {"op": "press", "key": "Backspace"}, {"op": "type", "text": "abc"}]}))]);
        assert_eq!(type_text(&mut context).await.expect("typed").text, "decorated settled");
        assert_eq!(log.lock().expect("log")[0], "mutate p1-s2-e1 editable=true");
        host.finish().expect("focus, then one batch");
    }

    #[tokio::test]
    async fn select_without_values_lists_the_options_and_changes_nothing() {
        let (mut context, host, log) = context(json!({"ref": "p1-s2-e1"}), Vec::new());
        context.options = SelectOptions { options: vec!["Red [selected]".into(), "token hunter2".into()], total: None };
        assert_eq!(select(&mut context).await.expect("listed").text, "decorated Options for p1-s2-e1 (2):\n- Red [selected]\n- token [REDACTED]");
        context.options = SelectOptions { options: vec!["A".into()], total: Some(900) };
        assert_eq!(select(&mut context).await.expect("listed").text, "decorated Options for p1-s2-e1 (first 1 of 900):\n- A");
        context.options = SelectOptions::default();
        assert_eq!(select(&mut context).await.expect("listed").text, "decorated p1-s2-e1 has no options.");
        assert!(log.lock().expect("log").is_empty(), "no mutation, no invalidation");
        host.finish().expect("no host call");
    }

    #[tokio::test]
    async fn select_with_values_chooses_them_and_never_submits() {
        let (mut context, host, log) = context(json!({"ref": "p1-s2-e1", "values": ["US", 7], "submit": true}), vec![call(json!({"values": ["us", "7"]}))]);
        select(&mut context).await.expect("selected");
        assert_eq!(*log.lock().expect("log"), ["mutate p1-s2-e1 editable=false", "invalidate"]);
        host.finish().expect("one call, no Enter");
        let (mut context, _, _) = self::context(json!({}), Vec::new());
        assert_eq!(select(&mut context).await, Err(failed("select requires ref (from snapshot) or target")));
    }

    fn dialog_answer(answered: bool) -> Expect {
        Expect::ok("host/browser/page/dialog/answer", json!({"answered": answered, "facts": page_facts("p1", 6)}))
    }

    #[tokio::test]
    async fn a_dialog_is_answered_with_the_decision_and_the_prompt_text() {
        let (mut context, host, log) = context(json!({"accept": true, "promptText": "yes"}), vec![dialog_answer(true).with_params(json!({"pageId": "p1", "accept": true, "promptText": "yes"}))]);
        assert_eq!(handle_dialog(&mut context).await.expect("answered").text, "settled");
        assert_eq!(*log.lock().expect("log"), ["invalidate"]);
        host.finish().expect("one answer");
        let (mut context, host, _) = self::context(json!({"accept": "true"}), vec![dialog_answer(true).with_params(json!({"accept": false, "promptText": ""}))]);
        handle_dialog(&mut context).await.expect("dismissed");
        host.finish().expect("only an explicit true accepts");
    }

    #[tokio::test]
    async fn no_open_dialog_is_the_failure() {
        let (mut context, _, _) = context(json!({"accept": true}), vec![dialog_answer(false)]);
        assert_eq!(handle_dialog(&mut context).await, Err(failed("no JavaScript dialog is currently open")));
    }
}
