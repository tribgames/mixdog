//! Whether a URL may be opened at all (`url-admission.ts`). A name that passes the policy is resolved and checked again against the
//! address it actually points at, so a host that answers with a private address cannot slip through the name check.
//!
//! Every address of the answer is checked, as `dns.lookup(host, { all: true, verbatim: true })` returned them (Rust has no
//! `node:dns`: the [`Resolve`] the engine injects is the daemon's resolver, and it must return the whole answer in the order the
//! system gave it). An answer is never cached: a later request resolves again, so a DNS rebinding to a private address is seen.
//! [`UrlAdmission`] coalesces only the lookups that are in flight at once for one name, and refuses a new name while 256 (or the
//! configured number of) others are pending; [`admit_resolved`] is the same check without that shared state.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use tokio::sync::OnceCell;
use url::Url;

use crate::url_policy::MailLink;
use crate::url_policy::Refusal;
use crate::url_policy::UrlPolicy;
use crate::url_policy::assert_resolved_address_allowed;
use crate::url_policy::ip_version;
use crate::url_policy::normalize_agent_url;
use crate::url_policy::normalize_page_url;

/// The default number of names that may be resolving at once.
pub const MAX_PENDING_RESOLUTIONS: usize = 256;

/// A name that could not be resolved (the reason is the resolver's own business: the refusal does not carry it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolveFailed;

/// Resolution of a host name to every address it has.
#[async_trait]
pub trait Resolve: Send + Sync {
    async fn lookup(&self, hostname: &str) -> Result<Vec<String>, ResolveFailed>;
}

/// What is left to do for a URL that passed the policy.
enum Step {
    Done,
    Lookup(String),
}

fn page_or_agent(url: &str, policy: &UrlPolicy, page_generated: bool, now_ms: i64) -> Result<String, Refusal> {
    if page_generated { normalize_page_url(url, policy) } else { normalize_agent_url(url, policy, None, now_ms) }
}

/// The policy check, then whether the host needs a lookup: loopback names and IP literals are decided on the spot.
fn prepare(url: &str, policy: &UrlPolicy, page_generated: bool, now_ms: i64) -> Result<Step, Refusal> {
    let normalized = page_or_agent(url, policy, page_generated, now_ms)?;
    let parsed = Url::parse(&normalized).map_err(|_| Refusal::new("Invalid URL"))?;
    let raw_host = parsed.host_str().unwrap_or_default();
    if raw_host.is_empty() || raw_host == "localhost" || raw_host.ends_with(".localhost") {
        return Ok(Step::Done);
    }
    let hostname = raw_host.strip_prefix('[').unwrap_or(raw_host);
    let hostname = hostname.strip_suffix(']').unwrap_or(hostname);
    if ip_version(hostname) != 0 {
        assert_resolved_address_allowed(hostname, hostname, policy)?;
        return Ok(Step::Done);
    }
    Ok(Step::Lookup(hostname.to_owned()))
}

/// One lookup and the check of every address it returned.
async fn resolve_check(hostname: &str, policy: &UrlPolicy, resolver: &dyn Resolve) -> Result<(), Refusal> {
    let Ok(addresses) = resolver.lookup(hostname).await else {
        return Err(Refusal::new(format!("navigation to {hostname} could not be resolved for private-network validation")));
    };
    if addresses.is_empty() {
        return Err(Refusal::new(format!("navigation to {hostname} returned no addresses for private-network validation")));
    }
    if addresses.len() > 64 {
        return Err(Refusal::new(format!("navigation to {hostname} returned too many resolved addresses")));
    }
    for address in &addresses {
        assert_resolved_address_allowed(address, hostname, policy)?;
    }
    Ok(())
}

/// The agent-URL check of [`UrlAdmission::assert_resolved_url_allowed`] without shared state: no coalescing and no pending cap.
pub async fn admit_resolved(url: &str, policy: &UrlPolicy, resolver: &dyn Resolve) -> Result<(), Refusal> {
    match prepare(url, policy, false, 0)? {
        Step::Done => Ok(()),
        Step::Lookup(hostname) => resolve_check(&hostname, policy, resolver).await,
    }
}

type Pending = Arc<OnceCell<Result<(), Refusal>>>;

/// Removes a name from the pending table when the call that put it there ends, however it ends (a dropped future included).
struct PendingEntry<'a> {
    table: &'a Mutex<HashMap<String, Pending>>,
    hostname: String,
    cell: Pending,
}

impl Drop for PendingEntry<'_> {
    fn drop(&mut self) {
        let mut table = self.table.lock().unwrap_or_else(PoisonError::into_inner);
        if table.get(&self.hostname).is_some_and(|current| Arc::ptr_eq(current, &self.cell)) {
            table.remove(&self.hostname);
        }
    }
}

/// The admission of one host under one policy: resolved answers are checked again, concurrent resolutions of a name are one
/// lookup, and a bounded number of names may be pending.
pub struct UrlAdmission {
    policy: UrlPolicy,
    max_pending: usize,
    pending: Mutex<HashMap<String, Pending>>,
}

impl UrlAdmission {
    pub fn new(policy: UrlPolicy) -> Self {
        Self::with_max_pending(policy, MAX_PENDING_RESOLUTIONS)
    }

    pub fn with_max_pending(policy: UrlPolicy, max_pending: usize) -> Self {
        Self { policy, max_pending: max_pending.max(1), pending: Mutex::new(HashMap::new()) }
    }

    pub fn policy(&self) -> &UrlPolicy {
        &self.policy
    }

    /// The policy check, then the check of the addresses the host resolves to. `page_generated` skips only the agent-input
    /// secret refusal (a page's own request may carry the tokens its site needs).
    pub async fn assert_resolved_url_allowed(&self, url: &str, page_generated: bool, resolver: &dyn Resolve) -> Result<(), Refusal> {
        let hostname = match prepare(url, &self.policy, page_generated, 0)? {
            Step::Done => return Ok(()),
            Step::Lookup(hostname) => hostname,
        };
        let (cell, creator) = {
            let mut table = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(cell) = table.get(&hostname) {
                (Arc::clone(cell), false)
            } else if table.len() >= self.max_pending {
                return Err(Refusal::new("too many concurrent browser DNS validations"));
            } else {
                let cell: Pending = Arc::new(OnceCell::new());
                table.insert(hostname.clone(), Arc::clone(&cell));
                (cell, true)
            }
        };
        let _entry = creator.then(|| PendingEntry { table: &self.pending, hostname: hostname.clone(), cell: Arc::clone(&cell) });
        cell.get_or_init(|| resolve_check(&hostname, &self.policy, resolver)).await.clone()
    }

    /// The normalized form of a URL an agent typed (`mail_link`: the runtime-set provenance of a navigate, read against `now_ms`),
    /// once the host it names is known to be admitted.
    pub async fn validated_agent_url(
        &self,
        raw: &str,
        mail_link: Option<&MailLink>,
        now_ms: i64,
        resolver: &dyn Resolve,
    ) -> Result<String, Refusal> {
        let normalized = normalize_agent_url(raw, &self.policy, mail_link, now_ms)?;
        self.assert_resolved_url_allowed(&normalized, true, resolver).await?;
        Ok(normalized)
    }

    /// A network resource a page requests: `ws` and `wss` are checked as `http` and `https`, any other scheme is refused.
    pub async fn assert_resolved_resource_url_allowed(&self, raw: &str, resolver: &dyn Resolve) -> Result<(), Refusal> {
        let mut parsed = Url::parse(raw).map_err(|_| Refusal::new("Invalid URL"))?;
        match parsed.scheme() {
            "ws" => parsed.set_scheme("http").map_err(|()| Refusal::new("Invalid URL"))?,
            "wss" => parsed.set_scheme("https").map_err(|()| Refusal::new("Invalid URL"))?,
            "http" | "https" => {}
            other => return Err(Refusal::new(format!("unsupported browser network protocol {other}:"))),
        }
        self.assert_resolved_url_allowed(parsed.as_str(), true, resolver).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use tokio::sync::Notify;

    use super::*;

    struct Counting {
        calls: AtomicUsize,
        gate: Option<Arc<Notify>>,
        answers: Vec<Vec<&'static str>>,
    }

    #[async_trait]
    impl Resolve for Counting {
        async fn lookup(&self, _hostname: &str) -> Result<Vec<String>, ResolveFailed> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0
                && let Some(gate) = &self.gate
            {
                gate.notified().await;
            }
            let answer = self.answers.get(call).or(self.answers.last()).ok_or(ResolveFailed)?;
            Ok(answer.iter().map(|address| (*address).to_owned()).collect())
        }
    }

    #[tokio::test]
    async fn concurrent_lookups_are_one_and_a_completed_answer_is_not_kept() {
        let gate = Arc::new(Notify::new());
        let resolver = Counting {
            calls: AtomicUsize::new(0),
            gate: Some(Arc::clone(&gate)),
            answers: vec![vec!["93.184.216.34"], vec!["192.168.1.10"]],
        };
        let admission = UrlAdmission::new(UrlPolicy::default());
        let first = admission.assert_resolved_url_allowed("https://rebind.example.test/", false, &resolver);
        let second = admission.assert_resolved_url_allowed("https://rebind.example.test/image.png", false, &resolver);
        let release = async {
            tokio::task::yield_now().await;
            gate.notify_one();
        };
        let (first, second, ()) = tokio::join!(first, second, release);
        assert_eq!((first, second), (Ok(()), Ok(())));
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
        let again = admission.assert_resolved_url_allowed("https://rebind.example.test/private", false, &resolver).await;
        assert_eq!(
            again.unwrap_err().reason,
            "navigation to rebind.example.test resolved to blocked private or internal address 192.168.1.10"
        );
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_name_over_the_pending_cap_is_refused_and_a_finished_one_frees_its_place() {
        let gate = Arc::new(Notify::new());
        let resolver =
            Counting { calls: AtomicUsize::new(0), gate: Some(Arc::clone(&gate)), answers: vec![vec!["93.184.216.34"]] };
        let admission = UrlAdmission::with_max_pending(UrlPolicy::default(), 1);
        let occupied = admission.assert_resolved_url_allowed("https://one.example.test/", false, &resolver);
        let refused = async {
            tokio::task::yield_now().await;
            let refused = admission.assert_resolved_url_allowed("https://two.example.test/", false, &resolver).await;
            gate.notify_one();
            refused
        };
        let (occupied, refused) = tokio::join!(occupied, refused);
        assert_eq!(occupied, Ok(()));
        assert_eq!(refused.unwrap_err().reason, "too many concurrent browser DNS validations");
        assert_eq!(admission.assert_resolved_url_allowed("https://two.example.test/", false, &resolver).await, Ok(()));
    }

    #[tokio::test]
    async fn every_address_of_the_answer_counts_and_an_empty_one_is_refused() {
        let resolver = Counting { calls: AtomicUsize::new(0), gate: None, answers: vec![vec!["93.184.216.34", "10.0.0.1"]] };
        let refusal = admit_resolved("https://mixed.example.test/", &UrlPolicy::default(), &resolver).await.unwrap_err();
        assert!(refusal.reason.ends_with("blocked private or internal address 10.0.0.1"));
        let empty = Counting { calls: AtomicUsize::new(0), gate: None, answers: vec![vec![]] };
        let refusal = admit_resolved("https://empty.example.test/", &UrlPolicy::default(), &empty).await.unwrap_err();
        assert!(refusal.reason.ends_with("returned no addresses for private-network validation"));
    }
}
