//! The invalidation token of each group of sessions the Agents pool lists (a Lead and the agents
//! under it), kept for the pool rows to carry (`runtime/shared/llm/usage-group-tokens.mjs`
//! `groupUsageTokens`). A token changes when a number the usage ledger would give for the group can
//! have changed, so a reader holding a ledger read re-reads on it and on nothing else.
//!
//! The pool is listed far more often than the ledger changes, and a listing must not wait on the
//! ledger: [`GroupUsageTokens::tokens`] answers the tokens known now and, when the ledger has
//! committed since the tokens were asked for (or the groups changed), asks again in the background
//! and wakes the pool once they differ.

// Transparent callback/state names; existing ownership and call signatures are unchanged.
type QueuedLedgerWrites = (Arc<dyn TokenLedger>, Vec<(String, Vec<String>)>);

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ledger::ledger::UsageLedger;
use tokio::sync::Notify;

/// The `{ owner, ids }` groups of one listing: the owner session and the ids listed under it.
pub type Groups = [(String, Vec<String>)];

/// What the tokens are read from: the ledger's commit stamp and `readUsageToken` of each group.
#[async_trait]
pub trait TokenLedger: Send + Sync {
    /// `commitStamp()`; `None` when it could not be read (the next listing asks again).
    async fn stamp(&self) -> Option<String>;
    /// `usageTokensAsync(groups)`: one token per group, in order.
    async fn tokens(&self, groups: &Groups) -> Result<Vec<String>, String>;
}

#[async_trait]
impl TokenLedger for UsageLedger {
    async fn stamp(&self) -> Option<String> {
        self.writer.commit_stamp().await.ok()
    }

    async fn tokens(&self, groups: &Groups) -> Result<Vec<String>, String> {
        let mut out = Vec::with_capacity(groups.len());
        for (owner, ids) in groups {
            out.push(self.reader.usage_token(ids.clone(), vec![owner.clone()]).await.map_err(|error| error.to_string())?);
        }
        Ok(out)
    }
}

/// `usageLedgerIfOpen()`: asking never opens one.
pub trait LedgerIfOpen: Send + Sync {
    fn if_open(&self) -> Option<Arc<dyn TokenLedger>>;
}

impl LedgerIfOpen for super::ledger_source::LedgerSource {
    fn if_open(&self) -> Option<Arc<dyn TokenLedger>> {
        super::ledger_source::LedgerSource::if_open(self).map(|ledger| ledger as Arc<dyn TokenLedger>)
    }
}

#[derive(Default)]
struct State {
    known: HashMap<String, String>,
    wanted: HashSet<String>,
    /// What the tokens were last asked for: the ledger's stamp and the groups' shape.
    asked: (Option<String>, String),
    in_flight: bool,
    queued: Option<QueuedLedgerWrites>,
}

pub struct GroupUsageTokens {
    source: Arc<dyn LedgerIfOpen>,
    /// `emitSessionActivityChange()`: the pool is listed again.
    wake: Arc<dyn Fn() + Send + Sync>,
    state: Mutex<State>,
    /// The background reads (stamp check or token read) still running, and the signal that the last one
    /// finished: what a test waits on instead of a clock.
    busy: AtomicUsize,
    idle: Notify,
}

/// One running background read; released when its task ends, after any read it handed on has started.
struct Busy(Arc<GroupUsageTokens>);

impl Busy {
    fn new(owner: &Arc<GroupUsageTokens>) -> Self {
        owner.busy.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(owner))
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        if self.0.busy.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

impl GroupUsageTokens {
    pub fn new(source: Arc<dyn LedgerIfOpen>, wake: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { source, wake, state: Mutex::default(), busy: AtomicUsize::new(0), idle: Notify::new() })
    }

    /// Resolves once no background read is running (every read asked for so far has finished and
    /// woken the pool if its tokens differed).
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
    async fn idle(&self) {
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.busy.load(Ordering::SeqCst) == 0 {
                return;
            }
            notified.await;
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The tokens known for `groups` (owner to token). Never waits; a group whose token is not known
    /// yet is absent.
    pub fn tokens(self: &Arc<Self>, groups: &Groups) -> HashMap<String, String> {
        let wanted: HashSet<String> = groups.iter().map(|(owner, _)| owner.clone()).collect();
        {
            let mut state = self.state();
            state.known.retain(|owner, _| wanted.contains(owner));
            state.wanted = wanted;
            if groups.is_empty() {
                // Nothing is listed: nothing is kept, and a refresh still out has nothing to add.
                state.queued = None;
                state.asked = (None, String::new());
                return state.known.clone();
            }
        }
        let Some(ledger) = self.source.if_open() else { return self.state().known.clone() };
        let shape = serde_json::to_string(
            &groups
                .iter()
                .map(|(owner, ids)| {
                    (owner, {
                        let mut ids = ids.clone();
                        ids.sort();
                        ids
                    })
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default();
        let (this, groups, busy) = (Arc::clone(self), groups.to_vec(), Busy::new(self));
        drop(tokio::spawn(async move {
            let _busy = busy;
            // The stamp is read on the ledger's writer; the listing that asked has already answered.
            let Some(stamp) = ledger.stamp().await else { return };
            {
                let mut state = this.state();
                if state.asked == (Some(stamp.clone()), shape.clone()) {
                    return;
                }
                state.asked = (Some(stamp), shape);
            }
            this.refresh(ledger, groups);
        }));
        self.state().known.clone()
    }

    fn refresh(self: &Arc<Self>, ledger: Arc<dyn TokenLedger>, groups: Vec<(String, Vec<String>)>) {
        {
            let mut state = self.state();
            if state.in_flight {
                state.queued = Some((ledger, groups));
                return;
            }
            state.in_flight = true;
        }
        let (this, busy) = (Arc::clone(self), Busy::new(self));
        drop(tokio::spawn(async move {
            let _busy = busy;
            match ledger.tokens(&groups).await {
                Ok(tokens) => {
                    let changed = {
                        let mut state = this.state();
                        // Only the groups wanted now: a group dropped while this was in flight stays dropped.
                        let before = state.known.len();
                        let wanted = state.wanted.clone();
                        state.known.retain(|owner, _| wanted.contains(owner));
                        let mut changed = state.known.len() != before;
                        for ((owner, _), token) in groups.iter().zip(tokens) {
                            if !wanted.contains(owner) {
                                continue;
                            }
                            if state.known.get(owner) != Some(&token) {
                                changed = true;
                            }
                            state.known.insert(owner.clone(), token);
                        }
                        changed
                    };
                    if changed {
                        (this.wake)();
                    }
                }
                // The next listing asks again.
                Err(_) => this.state().asked = (None, String::new()),
            }
            let next = {
                let mut state = this.state();
                state.in_flight = false;
                state.queued.take()
            };
            if let Some((ledger, groups)) = next {
                this.refresh(ledger, groups);
            }
        }));
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    struct Fake {
        stamp: Mutex<String>,
        token: Mutex<String>,
        reads: AtomicUsize,
    }

    #[async_trait]
    impl TokenLedger for Fake {
        async fn stamp(&self) -> Option<String> {
            Some(self.stamp.lock().unwrap().clone())
        }

        async fn tokens(&self, groups: &Groups) -> Result<Vec<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(groups.iter().map(|(owner, _)| format!("{owner}:{}", self.token.lock().unwrap())).collect())
        }
    }

    struct Open(Mutex<Option<Arc<Fake>>>);

    impl LedgerIfOpen for Open {
        fn if_open(&self) -> Option<Arc<dyn TokenLedger>> {
            self.0.lock().unwrap().clone().map(|ledger| ledger as Arc<dyn TokenLedger>)
        }
    }

    fn groups() -> Vec<(String, Vec<String>)> {
        vec![("lead".to_owned(), vec!["lead".to_owned(), "w1".to_owned()])]
    }

    fn rig() -> (Arc<Fake>, Arc<Open>, Arc<AtomicUsize>, Arc<GroupUsageTokens>) {
        let ledger = Arc::new(Fake { stamp: Mutex::new("s1".into()), token: Mutex::new("t1".into()), reads: AtomicUsize::new(0) });
        let open = Arc::new(Open(Mutex::new(Some(ledger.clone()))));
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        let tokens = GroupUsageTokens::new(
            open.clone(),
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        );
        (ledger, open, wakes, tokens)
    }

    #[tokio::test]
    async fn a_listing_never_waits_and_the_pool_wakes_when_the_tokens_arrive() {
        let (ledger, _open, wakes, tokens) = rig();
        assert!(tokens.tokens(&groups()).is_empty(), "nothing known on the first listing");
        tokens.idle().await;
        assert_eq!(wakes.load(Ordering::SeqCst), 1);
        assert_eq!(tokens.tokens(&groups())["lead"], "lead:t1");
        tokens.idle().await;
        assert_eq!(ledger.reads.load(Ordering::SeqCst), 1, "same stamp and groups: not asked again");
    }

    #[tokio::test]
    async fn a_commit_or_a_changed_group_asks_again_and_a_changed_token_wakes() {
        let (ledger, _open, wakes, tokens) = rig();
        tokens.tokens(&groups());
        tokens.idle().await;
        *ledger.stamp.lock().unwrap() = "s2".into();
        tokens.tokens(&groups());
        tokens.idle().await;
        assert_eq!(ledger.reads.load(Ordering::SeqCst), 2);
        assert_eq!(wakes.load(Ordering::SeqCst), 1, "the token did not change: no wake");
        *ledger.stamp.lock().unwrap() = "s3".into();
        *ledger.token.lock().unwrap() = "t2".into();
        tokens.tokens(&groups());
        tokens.idle().await;
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        assert_eq!(tokens.tokens(&groups())["lead"], "lead:t2");
    }

    #[tokio::test]
    async fn without_an_open_ledger_or_a_group_nothing_is_kept() {
        let (_ledger, open, _wakes, tokens) = rig();
        tokens.tokens(&groups());
        tokens.idle().await;
        assert!(tokens.tokens(&[]).is_empty(), "nothing listed: nothing kept");
        *open.0.lock().unwrap() = None;
        assert!(tokens.tokens(&groups()).is_empty(), "asking never opens a ledger");
    }
}
