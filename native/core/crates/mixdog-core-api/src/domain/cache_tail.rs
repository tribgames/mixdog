//! The admission seam between one provider attempt and the session that owns the prompt-cache entry of its transcript.
//!
//! The adapter lowers the request, picks the credential that serves this attempt and describes the wire prefix it is about
//! to send ([`WireManifest`]); immediately before transport it asks the owner's [`TailGate`] to admit that attempt with the
//! current clock. The owner answers send (with a one-attempt [`Permit`]), rebuild (compact first) or skip; the response's
//! usage comes back on the permit, and only the owner turns it into durable evidence.

use std::sync::Arc;

use super::provider::Usage;

pub const TTL_5M_MS: u64 = 300_000;
pub const TTL_1H_MS: u64 = 3_600_000;

/// How many positions before a marker the provider looks back for an earlier entry (Anthropic: 20). A position is one
/// block, but a run of consecutive `tool_use` blocks is one position and so is a run of consecutive `tool_result` blocks
/// ([`WireManifest::positions`]): a step's parallel calls and their results cost two positions, whatever their number.
pub const LOOKBACK_BLOCKS: usize = 20;

/// The digest of a wire prefix through one block, `cache_control` excluded.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub struct Digest(pub [u8; 32]);

/// Where a cache marker sits on the wire.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Zone {
    Tools,
    System,
    Messages,
}

/// One `cache_control` marker of the final body.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Marker {
    pub zone: Zone,
    pub ttl_ms: u64,
    /// The ordinal of the marked block in wire order (tools, system, messages).
    pub block: usize,
    /// The prefix digest through the marked block.
    pub digest: Digest,
}

/// The cache layout of the body an attempt is about to send.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct WireManifest {
    /// Every marker, in wire order.
    pub markers: Vec<Marker>,
    /// The prefix digest after each block, in wire order.
    pub boundaries: Vec<Digest>,
    /// The marker that covers the owning transcript (the last one in the messages), when there is one.
    pub tail: Option<usize>,
    /// The lookback position of each block, in wire order: blocks of one run of `tool_use` or of `tool_result` share
    /// one. Empty for a manifest whose blocks' kinds are not known: every block is then its own position.
    pub positions: Vec<usize>,
}

impl WireManifest {
    pub fn tail_marker(&self) -> Option<&Marker> {
        self.tail.and_then(|index| self.markers.get(index))
    }

    fn position(&self, block: usize) -> usize {
        self.positions.get(block).copied().unwrap_or(block)
    }

    /// Whether an entry ending at `block` with `digest` can be read by this request: the prefix through `block` is the same,
    /// and some marker at or after it lies within the provider's lookback, counted in positions as the provider counts.
    pub fn reaches(&self, block: usize, digest: Digest) -> bool {
        self.boundaries.get(block) == Some(&digest)
            && self.markers.iter().any(|m| m.block >= block && self.position(m.block).saturating_sub(self.position(block)) < LOOKBACK_BLOCKS)
    }
}

/// What an attempt is for. Only an ordinary turn (main loop, retry, later tool round) may ask the owner to compact.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Purpose {
    #[default]
    Turn,
    SideQuestion,
    /// A side question asked on the history its own idle compaction just committed: like a turn, it may be that base's
    /// first write. Any other side question never is (its body may predate a rewrite a running turn made).
    SideAfterCompaction,
    SummaryFork,
    Warm,
}

/// The cache namespace of one attempt: provider endpoint, model and the serving credential's opaque identity. Never holds
/// a credential.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct TailRoute(pub String);

/// One attempt asking to be dispatched.
pub struct Admission<'a> {
    pub purpose: Purpose,
    pub route: &'a TailRoute,
    pub manifest: &'a WireManifest,
    /// The book generation the transcript was prepared against (`None`: now).
    pub generation: Option<u64>,
    /// The leave of a failed rewrite ([`RewriteLease::resolve`]), when this is the attempt it was decided for.
    pub unreduced: Option<Unreduced>,
}

/// The leave a failed rewrite hands back to the caller that owned it (and told the user): the one request it was decided
/// for goes out on its unchanged history. The owner keeps nothing of it, so no other caller can spend it and it cannot
/// outlive that request.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Unreduced {
    /// The tail of the history the rewrite was decided for.
    pub block: usize,
    pub digest: Digest,
}

/// The owner's leave to dispatch exactly one attempt; its usage comes back with [`TailGate::settle`].
#[derive(Clone, Debug)]
pub struct Permit {
    pub id: u64,
    pub route: TailRoute,
    pub purpose: Purpose,
    pub manifest: Arc<WireManifest>,
    /// When the owner admitted it: the conservative touch time of whatever the attempt writes or reads.
    pub dispatched_at: i64,
    /// The history the attempt was judged against.
    pub generation: u64,
    /// How long after its admission the judgement holds: the remaining lifetime of the entry a live verdict reads (`None`:
    /// the verdict does not lapse with time). A host that posts later than that has no permit: it asks again. The contract
    /// is "live at admission", not "live when the provider reads it" (the provider's lifetime is not ours to hold), and a
    /// rewrite the owner commits after its judgement is not visible to a host already posting.
    pub holds_ms: Option<u64>,
}

/// Why the transcript's entry is not usable.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cold {
    /// The tail's lifetime ran out since the session last sent (or last warmed it on this route).
    Expired,
    /// No send of the session is on record (a session of an earlier version, an import, a clock that went back).
    Unproven,
}

/// The owner's request to compact before this attempt; `ticket` names the decision the run resolves.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ColdRequest {
    pub ticket: u64,
    pub cold: Cold,
}

/// A refused attempt, carried on the error the adapter returns instead of sending.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TailRefusal {
    /// Compact (or explain) first, then rebuild and admit the attempt again. The rewrite is offered, not held: the caller
    /// takes it with [`TailGateHandle::claim`].
    Rebuild(ColdRequest),
    /// The attempt is optional (a warm, a summary fork) or is not the rewrite's owner (a side question): it is not sent.
    Skip(Cold),
    /// Another caller is rewriting this history under the ticket: wait for its outcome ([`TailGate::wait_for`]), then
    /// admit again.
    Wait(u64),
    /// The transcript was prepared before a rewrite of the history: it is not sent.
    Stale,
    /// The owner, on another host, could not be reached to judge the attempt (the link to it went): it is not sent.
    Unjudged,
}

pub enum Verdict {
    Send(Permit),
    Refuse(TailRefusal),
}

/// What became of a [`ColdRequest`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Resolution {
    /// The transcript was replaced by a smaller one.
    Compacted,
    /// No smaller valid transcript: it is resent unchanged.
    Irreducible,
    /// The session knows no context window to size a compaction by: resent unchanged.
    NoSizing,
    /// The compaction failed and the user was told: the request it was decided for goes out unchanged under the
    /// [`Unreduced`] leave its caller is handed. It decides nothing about the history.
    Failed,
    /// Nothing was decided (cancelled, or a failure the run surfaces): the history stays undecided.
    Abandoned,
}

/// The input-cache counters of one response, absent kept apart from zero.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Counters {
    pub read: Option<u64>,
    pub created: Option<u64>,
    pub created_5m: Option<u64>,
    pub created_1h: Option<u64>,
}

impl Counters {
    /// The counters Anthropic's usage object reports (`cache_read_input_tokens`, `cache_creation_input_tokens` and its
    /// `cache_creation` split), read from the raw object so a missing field is not a zero.
    pub fn of_usage(usage: &Usage) -> Self {
        let raw = usage.raw.as_ref();
        let field = |key: &str| raw.and_then(|r| r.get(key)).and_then(serde_json::Value::as_u64);
        let split = |key: &str| raw.and_then(|r| r.get("cache_creation")).and_then(|c| c.get(key)).and_then(serde_json::Value::as_u64);
        Self {
            read: field("cache_read_input_tokens"),
            created: field("cache_creation_input_tokens"),
            created_5m: split("ephemeral_5m_input_tokens"),
            created_1h: split("ephemeral_1h_input_tokens"),
        }
    }
}

/// What became of a caller's claim on an offered rewrite ([`TailRefusal::Rebuild`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Claim {
    /// The caller owns the rewrite now.
    Owner,
    /// Another caller owns a rewrite of this history: wait for its outcome, then admit again.
    Wait(u64),
    /// The offer ended (the history was rewritten, or another caller's rewrite of it was decided): admit again on the
    /// history as it is now.
    Stale,
}

/// The owner of one session's transcript-cache book.
pub trait TailGate: Send + Sync {
    /// Judges the attempt now, immediately before transport. A gate whose book lives on another host answers once that
    /// host has judged it; an attempt is never sent before its verdict.
    fn admit<'a>(&'a self, admission: Admission<'a>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Verdict> + Send + 'a>>;
    /// What the permitted attempt reported (`None`: no usage arrived). Stale or duplicate settlements change nothing.
    fn settle(&self, permit: &Permit, counters: Option<Counters>);
    /// Takes the rewrite a [`TailRefusal::Rebuild`] offered. Only [`TailGateHandle::claim`] calls it: ownership is held by
    /// the [`RewriteLease`] it returns.
    fn claim(&self, request: ColdRequest) -> Claim;
    /// What the owner did with a rewrite it claimed ([`Resolution::Abandoned`]: nothing; the history is offered again and
    /// every waiter re-admits). A failed one hands back the leave of the attempt it was decided for.
    fn resolve(&self, ticket: u64, resolution: Resolution) -> Option<Unreduced>;
    /// The run replaced the transcript (any compaction): earlier evidence belongs to the retired history. Returns the
    /// generation of the replacing history.
    fn rebuilt(&self) -> u64;
    /// The book as it is to be persisted, when it changed since the last snapshot.
    fn snapshot(&self) -> Option<serde_json::Value>;
    /// The history's current generation (a rewrite moves it on).
    fn generation(&self) -> u64;
    /// Resolves once the rewrite under `ticket` is decided (or retired).
    fn wait_for(&self, ticket: u64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
}

/// A gate on request options: options compare equal whatever gate they carry.
#[derive(Clone)]
pub struct TailGateHandle(pub Arc<dyn TailGate>);

impl PartialEq for TailGateHandle {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl Eq for TailGateHandle {}

/// The outcome of [`TailGateHandle::claim`].
pub enum Claimed {
    Owner(RewriteLease),
    Wait(u64),
    Stale,
}

impl TailGateHandle {
    /// Claims the rewrite `request` offered. The lease is the ownership: resolved, it records the outcome; dropped without
    /// one (the owner's future cancelled or dropped, a failure surfaced), the rewrite is released and its waiters woken to
    /// admit again, one of whom becomes the next owner.
    pub fn claim(&self, request: ColdRequest) -> Claimed {
        match self.0.claim(request) {
            Claim::Owner => Claimed::Owner(RewriteLease { gate: self.0.clone(), ticket: request.ticket, decided: false }),
            Claim::Wait(ticket) => Claimed::Wait(ticket),
            Claim::Stale => Claimed::Stale,
        }
    }
}

/// The ownership of one rewrite of a session's history.
pub struct RewriteLease {
    gate: Arc<dyn TailGate>,
    ticket: u64,
    decided: bool,
}

impl RewriteLease {
    pub fn ticket(&self) -> u64 {
        self.ticket
    }

    /// Records what the owner did; the history is no longer being rewritten. A failed rewrite hands back the leave of the
    /// one request it was decided for ([`Unreduced`]), which only this caller holds.
    pub fn resolve(mut self, resolution: Resolution) -> Option<Unreduced> {
        self.decided = true;
        self.gate.resolve(self.ticket, resolution)
    }
}

impl Drop for RewriteLease {
    fn drop(&mut self) {
        if !self.decided {
            self.gate.resolve(self.ticket, Resolution::Abandoned);
        }
    }
}

impl std::fmt::Debug for TailGateHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TailGateHandle")
    }
}
