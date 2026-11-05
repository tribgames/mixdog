//! Ordered relay input (DS-COMP-4): per client × session, the stream, the run, the last
//! sequence number and whether the run is poisoned. Judged where relay page input executes,
//! which is serialized in decode order, so a failure poisons everything behind it.

use std::collections::HashMap;

use serde_json::Value;

const VERSION: u64 = 1;
/// JavaScript's largest safe integer: the order travels as a JSON number.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The order beside a relay control.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputOrder {
    /// Opaque id of one input queue (one pane's page view).
    pub stream: String,
    pub run: u64,
    pub seq: u64,
}

/// A malformed order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MalformedOrder(pub &'static str);

impl InputOrder {
    pub fn parse(value: &Value) -> Result<Self, MalformedOrder> {
        let object = value.as_object().ok_or(MalformedOrder("input order"))?;
        if object.get("v").and_then(Value::as_u64) != Some(VERSION) {
            return Err(MalformedOrder("input order version"));
        }
        let stream = object
            .get("stream")
            .and_then(Value::as_str)
            .filter(|s| (1..=256).contains(&s.len()) && s.bytes().all(is_id_byte))
            .ok_or(MalformedOrder("input stream"))?;
        let positive = |key: &'static str, what: &'static str| {
            object
                .get(key)
                .and_then(Value::as_u64)
                .filter(|n| (1..=MAX_SAFE_INTEGER).contains(n))
                .ok_or(MalformedOrder(what))
        };
        Ok(Self {
            stream: stream.to_owned(),
            run: positive("run", "input run")?,
            seq: positive("seq", "input seq")?,
        })
    }
}

fn is_id_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Dispatch,
    /// Not sent; the text is the reply to the phone.
    Refuse(&'static str),
}

struct State {
    stream: String,
    run: u64,
    last_seq: u64,
    poisoned: bool,
}

#[derive(Default)]
pub struct RelayInputOrder {
    states: HashMap<(String, String), State>,
}

impl RelayInputOrder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether this ordered control may be dispatched now.
    pub fn admit(&mut self, client_id: &str, session_id: &str, order: &InputOrder) -> Verdict {
        let key = (client_id.to_owned(), session_id.to_owned());
        let fresh = || State {
            stream: order.stream.clone(),
            run: order.run,
            last_seq: 0,
            poisoned: false,
        };
        let state = self.states.entry(key).or_insert_with(fresh);
        if state.stream != order.stream {
            *state = fresh();
        }
        if order.run < state.run {
            return Verdict::Refuse("Remote Browser Use input of an older run; input was not sent.");
        }
        if order.run > state.run {
            state.run = order.run;
            state.poisoned = false;
        }
        if order.seq <= state.last_seq {
            return Verdict::Refuse("Remote Browser Use input repeated; input was not sent.");
        }
        state.last_seq = order.seq;
        if state.poisoned {
            return Verdict::Refuse("Remote Browser Use input behind a failed one; input was not sent.");
        }
        Verdict::Dispatch
    }

    /// The dispatch of `order` failed: the rest of its run is refused.
    pub fn failed(&mut self, client_id: &str, session_id: &str, order: &InputOrder) {
        if let Some(state) = self
            .states
            .get_mut(&(client_id.to_owned(), session_id.to_owned()))
            && state.stream == order.stream
            && state.run == order.run
        {
            state.poisoned = true;
        }
    }

    /// The client left the relay.
    pub fn drop_client(&mut self, client_id: &str) {
        self.states.retain(|(client, _), _| client != client_id);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn order(run: u64, seq: u64, stream: &str) -> InputOrder {
        InputOrder {
            stream: stream.to_owned(),
            run,
            seq,
        }
    }

    #[test]
    fn repeats_older_runs_and_a_poisoned_run_are_refused_and_a_newer_run_clears_it() {
        let mut o = RelayInputOrder::new();
        let dispatches = |o: &mut RelayInputOrder, value: InputOrder| o.admit("c1", "s1", &value) == Verdict::Dispatch;
        assert!(dispatches(&mut o, order(1, 1, "q1")));
        assert!(!dispatches(&mut o, order(1, 1, "q1")), "a repeat is never applied twice");
        assert!(dispatches(&mut o, order(1, 2, "q1")));
        o.failed("c1", "s1", &order(1, 2, "q1"));
        assert!(!dispatches(&mut o, order(1, 3, "q1")), "nothing behind a failure of its run");
        assert!(dispatches(&mut o, order(2, 4, "q1")), "a newer run is adopted and clean");
        assert!(!dispatches(&mut o, order(1, 5, "q1")), "an older run is refused");
        assert_eq!(o.admit("c2", "s1", &order(1, 1, "q1")), Verdict::Dispatch, "per client");
        // A new stream starts fresh.
        assert!(dispatches(&mut o, order(1, 1, "q2")));
        o.drop_client("c1");
        assert!(dispatches(&mut o, order(1, 1, "q2")), "a departed client is forgotten");
    }

    #[test]
    fn refusals_carry_the_phone_facing_text() {
        let mut o = RelayInputOrder::new();
        o.admit("c", "s", &order(2, 1, "q"));
        assert_eq!(
            o.admit("c", "s", &order(1, 2, "q")),
            Verdict::Refuse("Remote Browser Use input of an older run; input was not sent.")
        );
        assert_eq!(
            o.admit("c", "s", &order(2, 1, "q")),
            Verdict::Refuse("Remote Browser Use input repeated; input was not sent.")
        );
        o.failed("c", "s", &order(2, 1, "q"));
        assert_eq!(
            o.admit("c", "s", &order(2, 2, "q")),
            Verdict::Refuse("Remote Browser Use input behind a failed one; input was not sent.")
        );
    }

    #[test]
    fn a_malformed_order_is_refused() {
        let good = json!({"v": 1, "stream": "q1", "run": 1, "seq": 2});
        assert_eq!(InputOrder::parse(&good).unwrap(), order(1, 2, "q1"));
        for bad in [
            json!(null),
            json!({"v": 2, "stream": "q1", "run": 1, "seq": 2}),
            json!({"v": 1, "stream": "q1", "run": 0, "seq": 1}),
            json!({"v": 1, "stream": "q1", "run": 1, "seq": 0}),
            json!({"v": 1, "stream": "bad id!", "run": 1, "seq": 1}),
        ] {
            assert!(InputOrder::parse(&bad).is_err(), "{bad}");
        }
    }
}
