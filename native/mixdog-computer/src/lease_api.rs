//! The desktop host's foreground-lock lease, as a background delivery asks
//! for it when this process may not take the lock itself (IMixLeaseChannel
//! and MixForegroundLock.Acquire, MixForegroundLock.cs:155-194, :317-326).
//! lease-channel-stdin implements it over stdio; activation-guard asks it.

/// The host's answer to one acquire, in the words the reply's facts use.
#[derive(Clone, Debug, PartialEq)]
pub enum LeaseAnswer {
    /// This host was started without a lease channel.
    NotOffered,
    /// The delivery belongs to no request the host could check it against.
    NoRequest,
    /// No answer naming the request arrived in time; the host may still take
    /// the lock, so a release is still asked for.
    NoAnswer,
    /// The host answered without a lock, saying why.
    Refused(String),
    /// The lease's deadline had passed when its answer arrived. The host
    /// opened it all the same, so its release names `lease`.
    ExpiredOnArrival { lease: u32, deadline_at: f64 },
    /// The host holds the lock for this request until `deadline_at`, on the
    /// lease clock (QueryPerformanceCounter milliseconds).
    Locked { lease: u32, deadline_at: f64 },
}

impl LeaseAnswer {
    /// The `host_answer` fact.
    pub fn as_str(&self) -> &str {
        match self {
            LeaseAnswer::NotOffered => "not_offered",
            LeaseAnswer::NoRequest => "no_request",
            LeaseAnswer::NoAnswer => "no_answer",
            LeaseAnswer::Refused(answer) => answer,
            LeaseAnswer::ExpiredOnArrival { .. } => "expired_on_arrival",
            LeaseAnswer::Locked { .. } => "locked",
        }
    }
}

pub trait ForegroundLease {
    /// Asks the host to hold the foreground lock for `hold_ms` on behalf of
    /// request `action`; `seq` numbers this process's asks and `answer_by` is
    /// the lease-clock time after which no answer counts.
    fn acquire(&self, action: i64, seq: u32, hold_ms: u32, answer_by: f64) -> LeaseAnswer;
    /// Ends the lease and says how the host ended it: released, failed,
    /// unknown or none, or no_ack when no answer arrived in time.
    fn release(&self, action: i64, seq: u32, lease: u32) -> String;
    /// Whether this host was started with a lease channel at all.
    fn offered(&self) -> bool;
}

/// No lease channel: every acquire answers not_offered.
pub struct NoLease;

impl ForegroundLease for NoLease {
    fn acquire(&self, _action: i64, _seq: u32, _hold_ms: u32, _answer_by: f64) -> LeaseAnswer {
        LeaseAnswer::NotOffered
    }
    fn release(&self, _action: i64, _seq: u32, _lease: u32) -> String {
        "none".into()
    }
    fn offered(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_lease_offers_nothing() {
        assert_eq!(NoLease.acquire(7, 1, 100, 0.0), LeaseAnswer::NotOffered);
        assert_eq!(NoLease.acquire(7, 1, 100, 0.0).as_str(), "not_offered");
        assert_eq!(NoLease.release(7, 1, 0), "none");
        assert!(!NoLease.offered());
    }

    #[test]
    fn answers_name_the_host_answer_fact() {
        assert_eq!(LeaseAnswer::Refused("refused".into()).as_str(), "refused");
        assert_eq!(
            LeaseAnswer::ExpiredOnArrival { lease: 1, deadline_at: 0.0 }.as_str(),
            "expired_on_arrival"
        );
        assert_eq!(
            LeaseAnswer::Locked { lease: 3, deadline_at: 1.5 }.as_str(),
            "locked"
        );
    }
}
