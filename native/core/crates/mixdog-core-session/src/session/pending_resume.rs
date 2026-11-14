//! The pending-resume feed (`tui/session/agent-job-feed/pending-resume.mjs`): execution completions that land while
//! the thread is busy, or while a pending-resume turn is already queued, accumulate here and are merged into ONE resume
//! turn, their bodies joined by blank lines. A completion the user discarded with Esc leaves a short-lived tombstone, so
//! a late duplicate racing the abort is dropped.

use std::collections::VecDeque;

use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Value;

/// How long a discarded completion is remembered.
pub const TOMBSTONE_TTL_MS: i64 = 30_000;
/// How many discarded completions are remembered.
pub const TOMBSTONE_LIMIT: usize = 128;

/// The resume turn the accumulated completions become (`makeQueueEntry(body, { mode: 'pending-resume', priority:
/// 'next', abortDiscardOnAbort: true, resumeCompletionKeys })`).
#[derive(Clone, Debug, PartialEq)]
pub struct ResumeEntry {
    pub body: String,
    pub completion_keys: Vec<String>,
}

/// Whether a thread takes completions (`getAdmission()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Open,
    /// A close is under way: completions wait; a failed close flushes them.
    Closing,
    /// Closed: a completion never resumes it.
    Terminal,
}

/// The thread the feed resumes.
pub trait ResumeHost {
    fn busy(&self) -> bool;
    fn disposed(&self) -> bool;
    fn admission(&self) -> Admission;
    /// Whether a pending-resume entry is queued already.
    fn has_queued_resume(&self) -> bool;
    /// Queues the entry (`pending.push(entry)`) and starts the drain.
    fn queue_resume(&self, entry: ResumeEntry);
    fn now_ms(&self) -> i64;
}

/// `shortTextFingerprint(text)`: FNV-1a over the trimmed text's UTF-16 units, in base 36.
pub fn short_text_fingerprint(text: &str) -> String {
    let mut hash: u32 = 2_166_136_261;
    for unit in js_trim(text).encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    let mut digits = Vec::new();
    let mut rest = hash;
    loop {
        digits.push(char::from_digit(rest % 36, 36).unwrap_or('0'));
        rest /= 36;
        if rest == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// `executionResumeKey(body, completionKey)`: the key a completion is known by: an explicit `execution:` or `body:` key
/// as it is, any other explicit key (a string, or an object's `executionId` or `key`) as an execution, else a
/// fingerprint of the body; empty when it has neither.
pub fn execution_resume_key(body: &str, completion_key: &Value) -> String {
    let named = match completion_key {
        Value::Object(object) => ["executionId", "key"].iter().find_map(|key| object.get(*key).filter(|value| is_truthy(value))).cloned().unwrap_or(Value::Null),
        other => other.clone(),
    };
    let explicit = if is_truthy(&named) { js_trim(&value_to_string(&named)).to_owned() } else { String::new() };
    if explicit.starts_with("execution:") || explicit.starts_with("body:") {
        return explicit;
    }
    if !explicit.is_empty() {
        return format!("execution:{explicit}");
    }
    let value = js_trim(body);
    if value.is_empty() { String::new() } else { format!("body:{}", short_text_fingerprint(value)) }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// The feed of one thread.
pub struct PendingResume<H: ResumeHost> {
    host: H,
    deferred: bool,
    /// The completion keys abandoned by Esc, oldest first, each with when it expires. Per feed (so per thread),
    /// short-lived and bounded: they catch a late duplicate racing the abort without permanently reserving execution
    /// ids or retaining completion bodies.
    discarded: VecDeque<(String, i64)>,
    /// The model-visible body of every completion that arrived while busy, oldest first: one slot would drop all but the
    /// last body when parallel completions land.
    bodies: Vec<(String, String)>,
    tombstone_ttl_ms: i64,
    tombstone_limit: usize,
}

impl<H: ResumeHost> PendingResume<H> {
    pub fn new(host: H) -> Self {
        Self::with_limits(host, TOMBSTONE_TTL_MS, TOMBSTONE_LIMIT)
    }

    pub fn with_limits(host: H, tombstone_ttl_ms: i64, tombstone_limit: usize) -> Self {
        Self { host, deferred: false, discarded: VecDeque::new(), bodies: Vec::new(), tombstone_ttl_ms, tombstone_limit }
    }

    fn prune_discarded(&mut self) {
        let now = self.host.now_ms();
        self.discarded.retain(|(_, expires_at)| *expires_at > now);
    }

    /// Whether the completion was discarded and its tombstone still stands.
    pub fn is_discarded(&mut self, key: &str) -> bool {
        if key.is_empty() {
            return false;
        }
        self.prune_discarded();
        self.discarded.iter().any(|(held, _)| held == key)
    }

    fn remember_discarded(&mut self, key: &str) {
        if key.is_empty() {
            return;
        }
        self.prune_discarded();
        let limit = self.tombstone_limit.max(1);
        while !self.discarded.iter().any(|(held, _)| held == key) && self.discarded.len() >= limit {
            self.discarded.pop_front();
        }
        // Re-inserted at the back, so the bounded set evicts the oldest tombstone.
        self.discarded.retain(|(held, _)| held != key);
        self.discarded.push_back((key.to_owned(), self.host.now_ms() + self.tombstone_ttl_ms.max(1)));
    }

    /// Every accumulated body drained into ONE resume turn, so no completion body is lost when several deferred while busy.
    fn queue_resume_turn(&mut self) {
        let resumed = std::mem::take(&mut self.bodies);
        let body = resumed.iter().map(|(body, _)| body.as_str()).filter(|body| !body.is_empty()).collect::<Vec<_>>().join("\n\n");
        let completion_keys = resumed.into_iter().map(|(_, key)| key).filter(|key| !key.is_empty()).collect();
        self.host.queue_resume(ResumeEntry { body, completion_keys });
    }

    /// A completion arrived (`kick(body, completionKey)`; empty arguments re-try the deferred resume). It carries the
    /// model-visible body straight into the pending-resume entry, so the resumed turn sends it. A closed thread never
    /// resumes from a completion, a closing one defers, a busy one or one with a resume queued defers.
    pub fn kick(&mut self, body: &str, completion_key: &Value) {
        let key = execution_resume_key(body, completion_key);
        if !body.is_empty() && self.is_discarded(&key) {
            return;
        }
        let admission = self.host.admission();
        if admission == Admission::Terminal {
            self.bodies.clear();
            self.deferred = false;
            return;
        }
        if !body.is_empty() {
            self.bodies.push((body.to_owned(), key));
        }
        if self.host.disposed() {
            return;
        }
        if admission == Admission::Closing || self.host.busy() || self.host.has_queued_resume() {
            self.deferred = true;
            return;
        }
        self.deferred = false;
        self.queue_resume_turn();
    }

    /// The deferred resume, once the thread is idle and open again.
    pub fn flush_deferred(&mut self) {
        if !self.deferred || self.host.disposed() || self.host.busy() || self.host.admission() != Admission::Open {
            return;
        }
        self.kick("", &Value::Null);
    }

    /// `discard(completionKeys)`: the completions the user abandoned: they leave tombstones and the bodies not yet resumed.
    pub fn discard(&mut self, completion_keys: &[Value]) {
        let keys: Vec<String> = completion_keys.iter().map(|key| execution_resume_key("", key)).filter(|key| !key.is_empty()).collect();
        if keys.is_empty() {
            return;
        }
        for key in &keys {
            self.remember_discarded(key);
        }
        let held: Vec<(String, String)> = std::mem::take(&mut self.bodies);
        self.bodies = held.into_iter().filter(|(_, key)| !self.discarded.iter().any(|(tombstone, _)| tombstone == key)).collect();
        self.deferred = !self.bodies.is_empty();
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::cell::RefCell;
    use std::rc::Rc;

    use serde_json::json;

    use super::*;

    struct Thread {
        busy: Cell<bool>,
        admission: Cell<Admission>,
        queued_resume: Cell<bool>,
        now: Cell<i64>,
        queued: RefCell<Vec<ResumeEntry>>,
    }

    impl ResumeHost for Rc<Thread> {
        fn busy(&self) -> bool {
            self.busy.get()
        }
        fn disposed(&self) -> bool {
            false
        }
        fn admission(&self) -> Admission {
            self.admission.get()
        }
        fn has_queued_resume(&self) -> bool {
            self.queued_resume.get()
        }
        fn queue_resume(&self, entry: ResumeEntry) {
            self.queued.borrow_mut().push(entry);
        }
        fn now_ms(&self) -> i64 {
            self.now.get()
        }
    }

    fn thread() -> Rc<Thread> {
        Rc::new(Thread { busy: Cell::new(false), admission: Cell::new(Admission::Open), queued_resume: Cell::new(false), now: Cell::new(1000), queued: RefCell::new(Vec::new()) })
    }

    #[test]
    fn keys_are_explicit_executions_or_a_fingerprint_of_the_body() {
        assert_eq!(execution_resume_key("b", &json!("execution:7")), "execution:7");
        assert_eq!(execution_resume_key("b", &json!(" body:abc ")), "body:abc");
        assert_eq!(execution_resume_key("b", &json!(" 42 ")), "execution:42");
        assert_eq!(execution_resume_key("b", &json!({ "executionId": "e1", "key": "k" })), "execution:e1");
        assert_eq!(execution_resume_key("b", &json!({ "key": "k" })), "execution:k");
        assert_eq!(execution_resume_key("  ", &json!(null)), "");
        let fingerprint = short_text_fingerprint("hello");
        assert_eq!(execution_resume_key(" hello ", &Value::Null), format!("body:{fingerprint}"));
        // The values Node's `shortTextFingerprint` gives.
        assert_eq!(fingerprint, "m3bicr");
        assert_eq!(short_text_fingerprint(""), "ztntfp");
    }

    #[test]
    fn completions_that_land_while_busy_become_one_resume_turn() {
        let host = thread();
        let mut feed = PendingResume::new(host.clone());
        host.busy.set(true);
        feed.kick("first result", &json!("a"));
        feed.kick("second result", &json!("b"));
        feed.kick("third result", &Value::Null);
        assert!(host.queued.borrow().is_empty());
        host.busy.set(false);
        feed.flush_deferred();
        let queued = host.queued.borrow().clone();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].body, "first result\n\nsecond result\n\nthird result");
        assert_eq!(queued[0].completion_keys, vec!["execution:a".to_owned(), "execution:b".to_owned(), format!("body:{}", short_text_fingerprint("third result"))]);
        // Nothing is left to flush.
        feed.flush_deferred();
        assert_eq!(host.queued.borrow().len(), 1);
    }

    #[test]
    fn an_idle_thread_resumes_at_once_but_never_a_second_resume_while_one_is_queued() {
        let host = thread();
        let mut feed = PendingResume::new(host.clone());
        feed.kick("one", &json!("a"));
        assert_eq!(host.queued.borrow().len(), 1);
        host.queued_resume.set(true);
        feed.kick("two", &json!("b"));
        assert_eq!(host.queued.borrow().len(), 1);
        host.queued_resume.set(false);
        feed.flush_deferred();
        assert_eq!(host.queued.borrow()[1].body, "two");
    }

    #[test]
    fn a_discarded_completion_is_dropped_when_it_arrives_late_until_its_tombstone_expires() {
        let host = thread();
        let mut feed = PendingResume::new(host.clone());
        host.busy.set(true);
        feed.kick("held", &json!("a"));
        feed.kick("kept", &json!("b"));
        feed.discard(&[json!("a"), json!(""), json!({ "executionId": "z" })]);
        host.busy.set(false);
        feed.kick("late duplicate", &json!("a"));
        feed.kick("", &Value::Null);
        assert_eq!(host.queued.borrow().len(), 1);
        assert_eq!(host.queued.borrow()[0].body, "kept");
        host.now.set(1000 + TOMBSTONE_TTL_MS + 1);
        feed.kick("again", &json!("a"));
        assert_eq!(host.queued.borrow().len(), 2);
        // Discarding the only deferred body leaves nothing to resume.
        host.busy.set(true);
        feed.kick("only", &json!("c"));
        feed.discard(&[json!("c")]);
        host.busy.set(false);
        feed.flush_deferred();
        assert_eq!(host.queued.borrow().len(), 2);
    }

    #[test]
    fn tombstones_are_bounded_and_the_oldest_goes_first() {
        let host = thread();
        let mut feed = PendingResume::with_limits(host.clone(), 10_000, 2);
        feed.discard(&[json!("a")]);
        feed.discard(&[json!("b")]);
        feed.discard(&[json!("c")]);
        assert!(!feed.is_discarded("execution:a") && feed.is_discarded("execution:b") && feed.is_discarded("execution:c"));
        // A key remembered again moves to the back.
        feed.discard(&[json!("b")]);
        feed.discard(&[json!("d")]);
        assert!(feed.is_discarded("execution:b") && feed.is_discarded("execution:d") && !feed.is_discarded("execution:c"));
    }

    #[test]
    fn a_closing_thread_defers_and_a_closed_one_never_resumes() {
        let host = thread();
        let mut feed = PendingResume::new(host.clone());
        host.admission.set(Admission::Closing);
        feed.kick("while closing", &json!("a"));
        assert!(host.queued.borrow().is_empty());
        feed.flush_deferred();
        assert!(host.queued.borrow().is_empty());
        // The close failed: the thread is open again and the deferred completion goes.
        host.admission.set(Admission::Open);
        feed.flush_deferred();
        assert_eq!(host.queued.borrow().len(), 1);
        host.admission.set(Admission::Terminal);
        feed.kick("after close", &json!("b"));
        host.admission.set(Admission::Open);
        feed.flush_deferred();
        assert_eq!(host.queued.borrow().len(), 1);
    }
}
