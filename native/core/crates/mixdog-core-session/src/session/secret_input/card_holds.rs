//! The holds the core takes on the one human-only lock ([`super::HumanOnlyLock`]) for the cards it raises that only the
//! person may answer: a browser approval (`item/browser/requestApproval`) and a screen takeover. A secret request takes no hold:
//! Node never held the lock for one, so Computer Use is never refused for it. Until
//! the card is answered Computer Use refuses every new operation with the lock's text, exactly as the desktop's own
//! `withHumanOnlyApproval` hold did (`host/humanOnly/begin`), and no connection can free it by naming its id.
//!
//! A hold ends when the card is answered ([`CardHolds::release`]), when its `serverRequest/resolved` is sent (the same call),
//! when its expiry passes, when the connection that has to answer it closes, and when its thread ends
//! ([`CardHolds::release_thread`]).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use mixdog_core_api::Caller;
use mixdog_core_api::ids::ThreadId;
use tokio_util::sync::CancellationToken;

use super::HumanOnlyLock;
use super::Timer;

/// What a card is, which may name the hold in the refusal Computer Use gives meanwhile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HumanOnlyCard {
    /// `item/browser/requestApproval`: the desktop's browser approval dialog.
    BrowserApproval,
    /// A screen takeover the person was shown a card for.
    ScreenTakeover,
}

impl HumanOnlyCard {
    /// The label after `: ` in `Computer Use is blocked while a human-only approval is pending`; empty names nothing, as
    /// the desktop's browser approval dialog held the lock without a label (`approval-dialog.ts`).
    fn label(self) -> &'static str {
        match self {
            Self::BrowserApproval => "",
            Self::ScreenTakeover => "the user has the screen for a takeover and was shown a card for it; try again once it ends",
        }
    }
}

/// A hold on the lock, named by the lock.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct HoldId(String);

impl HoldId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What else ends a hold besides the answer.
#[derive(Clone, Default)]
pub struct CardScope {
    /// The thread the card belongs to: [`CardHolds::release_thread`] ends its holds.
    pub thread: Option<ThreadId>,
    /// Fires when the connection that has to answer the card closes.
    pub answerer_closed: Option<CancellationToken>,
    /// The card's own expiry.
    pub expires_after: Option<Duration>,
}

struct Card {
    hold: HoldId,
    thread: Option<ThreadId>,
    /// The expiry timer; dropped (aborted) with the entry.
    _expiry: Option<Timer>,
}

/// The core's holds for its pending cards, by the request id of each.
pub struct CardHolds {
    lock: Arc<HumanOnlyLock>,
    cards: Arc<Mutex<HashMap<String, Card>>>,
}

fn cards(map: &Mutex<HashMap<String, Card>>) -> MutexGuard<'_, HashMap<String, Card>> {
    map.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Ends the hold of `request_id`; false when it holds nothing.
fn end(lock: &HumanOnlyLock, map: &Mutex<HashMap<String, Card>>, request_id: &str) -> bool {
    let Some(card) = cards(map).remove(request_id) else { return false };
    lock.end(card.hold.as_str(), &Caller::Internal(CALLER))
}

const CALLER: &str = "card-holds";

impl CardHolds {
    pub fn new(lock: Arc<HumanOnlyLock>) -> Self {
        Self { lock, cards: Arc::default() }
    }

    /// Holds the lock for the card of `request_id` until it is answered. A request that holds already keeps its hold.
    pub fn hold_for_request(&self, request_id: &str, kind: HumanOnlyCard) -> HoldId {
        self.hold_for_request_in(request_id, kind, CardScope::default())
    }

    /// [`Self::hold_for_request`] for a card that also ends with its thread, its answering connection or its expiry. Needs a
    /// tokio runtime when `scope.expires_after` is set.
    pub fn hold_for_request_in(&self, request_id: &str, kind: HumanOnlyCard, scope: CardScope) -> HoldId {
        let mut map = cards(&self.cards);
        // A hold whose connection closed is gone from the lock: its entry goes with it.
        map.retain(|_, card| self.lock.holding(card.hold.as_str()));
        if let Some(card) = map.get(request_id) {
            return card.hold.clone();
        }
        let hold = HoldId(self.lock.hold_until(kind.label(), Caller::Internal(CALLER), scope.answerer_closed.unwrap_or_default()));
        let expiry = scope.expires_after.map(|after| {
            let (lock, cards, id) = (self.lock.clone(), self.cards.clone(), request_id.to_owned());
            Timer(tokio::spawn(async move {
                tokio::time::sleep(after).await;
                end(&lock, &cards, &id);
            }))
        });
        map.insert(request_id.to_owned(), Card { hold: hold.clone(), thread: scope.thread, _expiry: expiry });
        hold
    }

    /// The card of `request_id` was answered or its `serverRequest/resolved` was sent: Computer Use is free of it. False when
    /// it held nothing.
    pub fn release(&self, request_id: &str) -> bool {
        end(&self.lock, &self.cards, request_id)
    }

    /// The thread ended: every hold of its cards ends.
    pub fn release_thread(&self, thread: &ThreadId) {
        let ids: Vec<String> = cards(&self.cards).iter().filter(|(_, card)| card.thread.as_ref() == Some(thread)).map(|(id, _)| id.clone()).collect();
        for id in ids {
            end(&self.lock, &self.cards, &id);
        }
    }

    /// Resolves once no Computer Use operation runs (the desktop's dialog waited for this before it showed).
    pub async fn drained(&self) {
        self.lock.drained().await;
    }
}
