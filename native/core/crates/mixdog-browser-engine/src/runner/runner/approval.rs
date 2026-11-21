use super::*;
use crate::approval::binding::ObservedTarget;
use crate::approval::binding::Rebind;
use crate::approval::binding::resolve_upload_files;
use crate::approval::binding::verify;
use crate::approval::classify::ApprovalCommand;
use crate::approval::classify::StepFacts;
use crate::approval::classify::TargetFacts;
use crate::approval::classify::classify;
use crate::approval::payment::page_has_payment_evidence;
use crate::refs::target_resolve::TargetSpec;
use crate::types::BrowserApprovalAsk;

/// One step as the approval policy reads it: describes actions and addresses only, never a typed value.
pub(super) fn step_facts(step: &Value, fallback: &str) -> StepFacts {
    let text = |key: &str| step.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let target = step.get("target").filter(|target| !target.is_null());
    let describe = match target {
        Some(target) => TargetSpec::normalize(target).map(|spec| spec.describe()).unwrap_or_default(),
        None => {
            let named = ["ref", "snapshotId", "name"].iter().find(|key| truthy(step.get(**key))).map(|key| text_of(step.get(*key)));
            redact_browser_text(&named.unwrap_or_else(|| fallback.to_owned()))
        }
    };
    StepFacts {
        action: mixdog_js::js_to_lowercase(mixdog_js::js_trim(&text("action"))),
        submit: step.get("submit") == Some(&Value::Bool(true)),
        key: text("key"),
        target_name: target.and_then(|target| target.get("name")).and_then(Value::as_str).unwrap_or_default().to_owned(),
        describe,
    }
}

pub(super) fn approval_command(thread: &ThreadId, command: &Value, identity: &str) -> ApprovalCommand {
    let listed = |key: &str| command.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let unattended = command.get("unattended_run") == Some(&Value::Bool(true));
    ApprovalCommand {
        step: step_facts(command, identity),
        steps: listed("steps").iter().map(|step| step_facts(step, identity)).collect(),
        fields: listed("fields").iter().map(|field| step_facts(field, identity).describe).collect(),
        thread_id: Some(thread.clone()),
        session_id: thread.as_str().to_owned(),
        session_life: command.get("session_life").and_then(Value::as_str).unwrap_or_default().to_owned(),
        unattended,
        unattended_agent: if unattended {
            command.get("unattended_agent").and_then(Value::as_str).unwrap_or_default().trim().to_owned()
        } else {
            String::new()
        },
        paths: listed("paths").iter().map(|path| text_of(Some(path))).collect(),
    }
}

impl Inner {
    /// Asks the person about a step that asks (a submit, a post, an upload, or one the operator listed), and binds what they
    /// approved to what is dispatched: the document, the URL, the command and an upload's files and receiving frame must be the
    /// same after the answer. Answers the binding of an upload; every other approved step needs none.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn approve(
        &self,
        thread: &ThreadId,
        command: &mut Value,
        page: Option<&PageCtx>,
        cancel: &CancelView,
        user_wait: &UserWait,
    ) -> Result<Option<Binding>, RunError> {
        let session = thread.as_str();
        let identity = page.map_or_else(|| session.to_owned(), |page| page.page_facts().document_id);
        let approval = approval_command(thread, command, &identity);
        let Some(asked) = plan(&self.ports.approval_policy, &approval)? else { return Ok(None) };
        let mut files = Vec::new();
        let mut receiver = upload::Receiver::default();
        if asked.is_upload() {
            files = resolve_upload_files(&*self.ports.files, &approval.paths).await?;
            // What is dispatched is exactly what was approved: the canonical files.
            command["paths"] = Value::Array(files.iter().map(|file| Value::String(file.realpath.to_string_lossy().into_owned())).collect());
            if let Some(page) = page {
                receiver = page.upload_receiver(command).await?;
            }
        }
        let payment = match page {
            Some(page) if asked.probes_payment() => page_has_payment_evidence(page.host(), &page.page_id, page.token()).await,
            _ => false,
        };
        let (url, document_id) = match page {
            Some(page) => {
                let facts = page.page_facts();
                (facts.url, facts.document_id)
            }
            None => (String::new(), session.to_owned()),
        };
        let command_json = command.to_string();
        let ask: BrowserApprovalAsk = classify(
            &asked,
            &approval,
            TargetFacts { url, document_id, command_json: command_json.clone(), files, receiver_url: receiver.url, receiver_key: receiver.key, payment },
        );
        let binding = ask.binding.clone();
        // The command's clock stands still while the person is asked: the time they take is not the page's slowness.
        let waiting = user_wait.begin();
        let answered = Scope::new().cancel(cancel.token()).run(self.ports.approvals.ask(ask.prompt)).await;
        drop(waiting);
        let answer: ApprovalAnswer = match answered {
            Scoped::Done(answer) => answer.map_err(RunError::Tool)?,
            Scoped::Cancelled | Scoped::DeadlineExceeded => return Err(RunError::Cancelled(cancel.reason())),
        };
        let current: &Value = command;
        match page {
            Some(page) => verify(&binding, &answer, &command_json, &PageRebind { page, command: current }, &*self.ports.files, cancel.token()).await?,
            None => verify(&binding, &answer, &command_json, &SessionRebind { identity }, &*self.ports.files, cancel.token()).await?,
        };
        Ok((!binding.files.is_empty()).then_some(binding))
    }
}

// the approval

/// What an upload's approval is bound to read again: the page's document and URL, and the frame that would receive the files.
struct PageRebind<'a> {
    page: &'a PageCtx,
    command: &'a Value,
}

#[async_trait]
impl Rebind for PageRebind<'_> {
    fn target(&self) -> ObservedTarget {
        let facts = self.page.page_facts();
        ObservedTarget { url: facts.url, document_id: facts.document_id }
    }

    async fn receiver_key(&self) -> String {
        self.page.upload_receiver(self.command).await.map(|receiver| receiver.key).unwrap_or_default()
    }
}

/// A step of the session itself: the identity is the session, there is no page to read again.
struct SessionRebind {
    identity: String,
}

#[async_trait]
impl Rebind for SessionRebind {
    fn target(&self) -> ObservedTarget {
        ObservedTarget { url: String::new(), document_id: self.identity.clone() }
    }

    async fn receiver_key(&self) -> String {
        String::new()
    }
}
