//! The production [`AttemptSink`]: keeps the events of the attempt in
//! progress and forwards each to a consumer. A retry drops everything the
//! failed attempt showed (`discard`) and tells the consumer once, so a client
//! that rendered deltas can withdraw them.

use mixdog_core_api::domain::provider::StreamEvent;

use super::accounting::SendAccounting;
use crate::broker::AttemptSink;

/// What the consumer of a send hears.
#[derive(Clone, PartialEq, Debug)]
pub enum Attempted {
    Event(StreamEvent),
    /// The attempt failed and a retry begins: everything heard since the
    /// previous `Restart` (or the start) is void.
    Restart,
}

/// Records the current attempt and forwards to `forward`.
pub struct RecordingSink<F: FnMut(Attempted) + Send> {
    events: Vec<StreamEvent>,
    forward: F,
    accounting: Option<SendAccounting>,
}

impl<F: FnMut(Attempted) + Send> RecordingSink<F> {
    pub fn new(forward: F) -> Self {
        Self { events: Vec::new(), forward, accounting: None }
    }

    /// Records every retried attempt the provider billed into `accounting`.
    pub fn with_accounting(mut self, accounting: SendAccounting) -> Self {
        self.accounting = Some(accounting);
        self
    }

    /// The send's accounting, for `finish` once the broker returns.
    pub fn accounting(&mut self) -> Option<&mut SendAccounting> {
        self.accounting.as_mut()
    }

    /// The events of the attempt that is current (the last one after a send).
    pub fn events(&self) -> &[StreamEvent] {
        &self.events
    }

    /// The last usage the current attempt reported: what a cancelled send
    /// records (`SendAccounting::finish` with `Outcome::Cancelled`).
    pub fn last_usage(&self) -> Option<&mixdog_core_api::domain::provider::Usage> {
        self.events.iter().rev().find_map(|event| match event {
            StreamEvent::Usage(usage) => Some(usage),
            _ => None,
        })
    }

    pub fn into_events(self) -> Vec<StreamEvent> {
        self.events
    }
}

impl RecordingSink<fn(Attempted)> {
    /// A sink that only records.
    pub fn collecting() -> Self {
        Self::new(|_| {})
    }
}

impl<F: FnMut(Attempted) + Send> AttemptSink for RecordingSink<F> {
    fn event(&mut self, event: StreamEvent) {
        self.events.push(event.clone());
        (self.forward)(Attempted::Event(event));
    }

    fn abandoned(&mut self, usage: &mixdog_core_api::domain::provider::Usage, model: &str) {
        if let Some(accounting) = &mut self.accounting {
            accounting.note_abandoned(usage, Some(model.to_owned()));
        }
    }

    fn discard(&mut self) {
        if self.events.is_empty() {
            return;
        }
        self.events.clear();
        (self.forward)(Attempted::Restart);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_retry_drops_what_the_failed_attempt_showed() {
        let mut heard = Vec::new();
        let mut sink = RecordingSink::new(|a| heard.push(a));
        sink.event(StreamEvent::TextDelta("a".into()));
        sink.discard();
        sink.discard();
        sink.event(StreamEvent::TextDelta("b".into()));
        assert_eq!(sink.events(), &[StreamEvent::TextDelta("b".into())]);
        drop(sink);
        assert_eq!(
            heard,
            vec![
                Attempted::Event(StreamEvent::TextDelta("a".into())),
                Attempted::Restart,
                Attempted::Event(StreamEvent::TextDelta("b".into())),
            ]
        );
    }
}