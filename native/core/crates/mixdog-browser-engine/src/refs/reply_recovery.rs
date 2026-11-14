//! Owner: s4-engine-refset
//! Refs that went stale between the snapshot and the command (`reply-ref-recovery.ts`). A read-only operation or an
//! input preflight may retry once against a fresh snapshot when the same element can be found again: never across a
//! navigation, and never for a mutation, whose replay could act twice. The reply says which refs were swapped so the swap
//! is visible, not silent.

use std::collections::HashMap;
use std::collections::HashSet;
use std::future::Future;

use async_trait::async_trait;

use crate::error::HostCallError;

use super::recovery::Recovery;
use super::recovery::Refind;
use super::recovery::is_stale_ref_error;
use super::ref_set::RefSet;

/// Refs a command may address, and which of them were transparently swapped for a fresh equivalent before dispatch.
#[derive(Debug, Clone, Default)]
pub struct RefRecoveryContext {
    pub source: Option<RefSet>,
    pub replacements: HashMap<String, String>,
    pub attempted: HashSet<String>,
    pub notes: Vec<String>,
    /// Snapshot-free targets the host resolved to refs for this command.
    pub resolved_targets: Vec<String>,
}

impl RefRecoveryContext {
    /// `refRecoveryFor`: the page's latest snapshot is the one refs are recovered from.
    pub fn new(source: Option<RefSet>) -> Self {
        Self { source, ..Self::default() }
    }

    /// The ref the operation actually runs on: the swapped one when recovery already replaced it.
    pub fn effective_ref<'a>(&'a self, source_ref: &'a str) -> &'a str {
        self.replacements.get(source_ref).map_or(source_ref, String::as_str)
    }
}

/// A fresh observation of the page for recovery.
pub struct FreshSnapshot {
    pub refs: RefSet,
    /// The snapshot as the reply shows it (`reportSnapshot`), appended to a refusal so the agent sees the page.
    pub report: String,
}

/// What recovery reads of the page. Implemented by the command runner over the host.
#[async_trait]
pub trait RecoveryHost: Send + Sync {
    /// The page's URL now.
    async fn page_url(&self) -> Result<String, HostCallError>;
    /// The text of the reply for a JavaScript dialog that blocks the page, if one does (`dialogResult(guest, false)`).
    fn dialog_text(&self) -> Option<String>;
    /// A fresh snapshot of up to 500 elements, also stored as the page's latest ref set.
    async fn fresh_snapshot(&self) -> Result<FreshSnapshot, HostCallError>;
}

/// Why an operation under recovery failed.
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryFailure {
    /// The operation's own error (not stale, or stale a second time).
    Host(HostCallError),
    /// A refusal the agent reads: the ref is not from the snapshot, recovery stopped, or the page navigated.
    Message(String),
}

impl std::fmt::Display for RecoveryFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Host(error) => error.fmt(out),
            Self::Message(message) => out.write_str(message),
        }
    }
}

impl std::error::Error for RecoveryFailure {}

/// The reply text with what recovery did stated first (`decorateRecovery`).
pub fn decorate_recovery(text: &str, context: &RefRecoveryContext) -> String {
    let mut prefix = Vec::new();
    if !context.resolved_targets.is_empty() {
        prefix.push(format!("Target resolved before input dispatch: {}", context.resolved_targets.join(", ")));
    }
    if !context.notes.is_empty() {
        prefix.push(format!("Automatic ref recovery before input dispatch (no action replay): {}", context.notes.join(", ")));
    }
    if prefix.is_empty() {
        return text.to_string();
    }
    format!("{}\n\n{text}", prefix.join("\n"))
}

/// Recover a ref for a read-only operation or input preflight. Mutations and their post-dispatch verification must
/// execute outside this callback.
pub async fn with_ref_recovery<T, F, Fut>(
    host: &dyn RecoveryHost,
    context: &mut RefRecoveryContext,
    source_ref: &str,
    mut operation: F,
) -> Result<T, RecoveryFailure>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<T, HostCallError>>,
{
    let Some(source) = context.source.as_ref().and_then(|set| set.get(source_ref)).cloned() else {
        return Err(RecoveryFailure::Message(format!("ref {source_ref} is not from the latest snapshot; take a fresh snapshot first")));
    };
    let effective = context.effective_ref(source_ref).to_string();
    let error = match operation(effective).await {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    if !is_stale_ref_error(&error.to_string()) || context.attempted.contains(source_ref) {
        return Err(RecoveryFailure::Host(error));
    }
    context.attempted.insert(source_ref.to_string());
    if host.page_url().await.map_err(RecoveryFailure::Host)? != source.url {
        return Err(RecoveryFailure::Message(format!(
            "ref {source_ref} became stale after navigation; automatic recovery will not cross URLs"
        )));
    }
    // Recovery runs before the gesture is dispatched.
    if let Some(dialog) = host.dialog_text() {
        return Err(RecoveryFailure::Message(dialog));
    }
    let fresh = host.fresh_snapshot().await.map_err(RecoveryFailure::Host)?;
    if let Some(origin) = context.source.as_ref() {
        for fingerprint in origin.iter() {
            if let Refind::Found(found) = Recovery::refind(fingerprint, &fresh.refs) {
                context.replacements.insert(fingerprint.ref_id.clone(), found);
            }
        }
    }
    match Recovery::refind(&source, &fresh.refs) {
        Refind::Stopped(reason) => Err(RecoveryFailure::Message(format!(
            "ref {source_ref} became stale; automatic recovery stopped because {reason}.\n\n{}",
            fresh.report
        ))),
        Refind::Found(found) => {
            context.replacements.insert(source_ref.to_string(), found.clone());
            context.notes.push(format!("{source_ref} -> {found}"));
            operation(found).await.map_err(RecoveryFailure::Host)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::ref_set::tests::element;
    use super::super::ref_set::tests::payload;
    use super::*;

    struct Page {
        url: String,
        dialog: Option<String>,
        fresh: Mutex<Option<RefSet>>,
    }

    #[async_trait]
    impl RecoveryHost for Page {
        async fn page_url(&self) -> Result<String, HostCallError> {
            Ok(self.url.clone())
        }
        fn dialog_text(&self) -> Option<String> {
            self.dialog.clone()
        }
        async fn fresh_snapshot(&self) -> Result<FreshSnapshot, HostCallError> {
            let refs = self.fresh.lock().unwrap().clone().expect("a fresh snapshot");
            Ok(FreshSnapshot { refs, report: "REPORT".into() })
        }
    }

    const URL: &str = "https://a.test/";

    fn set(snapshot_id: &str, ids: &[&str]) -> RefSet {
        let elements = ids.iter().map(|id| element(id, "button", "Continue")).collect();
        RefSet::from_payload(snapshot_id, &payload(snapshot_id, elements, URL))
    }

    fn page(url: &str, fresh: RefSet) -> Page {
        Page { url: url.into(), dialog: None, fresh: Mutex::new(Some(fresh)) }
    }

    fn stale() -> HostCallError {
        HostCallError::Failed { message: "Node with given id not found".into() }
    }

    #[tokio::test]
    async fn a_stale_ref_is_swapped_once_and_the_swap_is_noted() {
        let mut context = RefRecoveryContext::new(Some(set("p1-s1", &["p1-s1-e1"])));
        let host = page(URL, set("p1-s2", &["p1-s2-e1"]));
        let ran = Mutex::new(Vec::new());
        let outcome = with_ref_recovery(&host, &mut context, "p1-s1-e1", |ref_id| {
            ran.lock().unwrap().push(ref_id.clone());
            async move { if ref_id == "p1-s1-e1" { Err(stale()) } else { Ok(ref_id) } }
        })
        .await;
        assert_eq!(outcome, Ok("p1-s2-e1".to_string()));
        assert_eq!(*ran.lock().unwrap(), ["p1-s1-e1", "p1-s2-e1"]);
        assert_eq!(context.effective_ref("p1-s1-e1"), "p1-s2-e1");
        assert_eq!(
            decorate_recovery("body", &context),
            "Automatic ref recovery before input dispatch (no action replay): p1-s1-e1 -> p1-s2-e1\n\nbody"
        );
    }

    #[tokio::test]
    async fn recovery_does_not_cross_a_navigation_or_retry_twice_or_swallow_other_errors() {
        let sources = || RefRecoveryContext::new(Some(set("p1-s1", &["p1-s1-e1"])));
        let moved = page("https://a.test/next", set("p1-s2", &["p1-s2-e1"]));
        let outcome = with_ref_recovery(&moved, &mut sources(), "p1-s1-e1", |_| async { Err::<(), _>(stale()) }).await;
        assert!(matches!(outcome, Err(RecoveryFailure::Message(text)) if text.contains("will not cross URLs")));

        let host = page(URL, set("p1-s2", &["p1-s2-e1"]));
        let mut once = sources();
        let second = with_ref_recovery(&host, &mut once, "p1-s1-e1", |_| async { Err::<(), _>(stale()) }).await;
        assert_eq!(second, Err(RecoveryFailure::Host(stale())));
        let third = with_ref_recovery(&host, &mut once, "p1-s1-e1", |_| async { Err::<(), _>(stale()) }).await;
        assert_eq!(third, Err(RecoveryFailure::Host(stale())));

        let disabled = HostCallError::Failed { message: "element is disabled".into() };
        let plain = with_ref_recovery(&host, &mut sources(), "p1-s1-e1", |_| async { Err::<(), _>(disabled.clone()) }).await;
        assert_eq!(plain, Err(RecoveryFailure::Host(disabled)));

        let unknown = with_ref_recovery(&host, &mut sources(), "p1-s1-e9", |_| async { Ok(()) }).await;
        assert!(matches!(unknown, Err(RecoveryFailure::Message(text)) if text.contains("not from the latest snapshot")));
    }

    #[tokio::test]
    async fn an_ambiguous_match_stops_with_the_fresh_report_and_a_dialog_stops_first() {
        let ambiguous = page(URL, set("p1-s2", &["p1-s2-e1", "p1-s2-e2"]));
        let mut context = RefRecoveryContext::new(Some(set("p1-s1", &["p1-s1-e1"])));
        let outcome = with_ref_recovery(&ambiguous, &mut context, "p1-s1-e1", |_| async { Err::<(), _>(stale()) }).await;
        let Err(RecoveryFailure::Message(text)) = outcome else { panic!("expected a refusal") };
        assert!(text.contains("2 exact semantic matches are ambiguous") && text.ends_with("REPORT"));

        let mut blocked = page(URL, set("p1-s2", &["p1-s2-e1"]));
        blocked.dialog = Some("A dialog is open".into());
        let mut context = RefRecoveryContext::new(Some(set("p1-s1", &["p1-s1-e1"])));
        let outcome = with_ref_recovery(&blocked, &mut context, "p1-s1-e1", |_| async { Err::<(), _>(stale()) }).await;
        assert_eq!(outcome, Err(RecoveryFailure::Message("A dialog is open".into())));
    }
}
