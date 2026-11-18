//! A user Stop is the terminal disposition of the work it stops: that work never runs again without a new user action. Its
//! `work_stop` record (FORMAT.md §5.2) folds into the header, as completion receipts do, so the store's fold and the session's
//! fold share one owner of it:
//! - `stoppedWork` maps every identity the stopped work could run or be recreated through (`work:`, `queue:`, `submission:`) to
//!   its Stop. It is a terminal receipt that outlives the queue entry and is never aged out.
//! - `owedStops` holds each Stop's body until its `settled` record says the owed outcome (the hand-back, or the cancelled
//!   outcome) is final: what a restart finishes.
//!
//! The queue copies of the stopped work leave the queue in the same fold, and a stopped completion gets its receipt, so the
//! same completion delivered again is consumed rather than queued.

use serde_json::Map;
use serde_json::Value;

use crate::schema::record::Header;
use crate::schema::record::WorkStopPhase;

const STOPPED: &str = "stoppedWork";
const OWED: &str = "owedStops";

pub fn work(id: &str) -> String {
    format!("work:{id}")
}

pub fn queued(qid: &str) -> String {
    format!("queue:{qid}")
}

pub fn submission(id: &str) -> String {
    format!("submission:{id}")
}

fn strings<'b>(body: &'b Value, key: &str) -> impl Iterator<Item = &'b str> {
    body.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|id| !id.is_empty())
}

/// Every identity a `stopped` body names.
pub fn identities(body: &Value) -> Vec<String> {
    strings(body, "work").map(work).chain(strings(body, "queues").map(queued)).chain(strings(body, "submissions").map(submission)).collect()
}

/// The queue ids a `stopped` body names.
pub fn queues(body: &Value) -> Vec<String> {
    strings(body, "queues").map(str::to_owned).collect()
}

/// The Stop that made `identity` terminal, if one did.
pub fn stopped<'h>(header: &'h Header, identity: &str) -> Option<&'h str> {
    header.get(STOPPED).and_then(Value::as_object).and_then(|stopped| stopped.get(identity)).and_then(Value::as_str)
}

/// The Stops whose outcome is still owed, with their bodies, in record order.
pub fn owed(header: &Header) -> Vec<(String, Value)> {
    header.get(OWED).and_then(Value::as_object).map(|owed| owed.iter().map(|(sid, body)| (sid.clone(), body.clone())).collect()).unwrap_or_default()
}

fn map<'h>(header: &'h mut Header, key: &str) -> Option<&'h mut Map<String, Value>> {
    header.entry(key).or_insert_with(|| Value::Object(Map::new())).as_object_mut()
}

/// The fold of one `work_stop` record: the queue ids whose copies leave the queue.
pub fn apply(header: &mut Header, sid: &str, phase: WorkStopPhase, body: Option<&Value>) -> Vec<String> {
    match phase {
        WorkStopPhase::Stopped => {
            let Some(body) = body else { return Vec::new() };
            if let Some(stopped) = map(header, STOPPED) {
                for identity in identities(body) {
                    stopped.entry(identity).or_insert_with(|| Value::String(sid.to_owned()));
                }
            }
            if let Some(owed) = map(header, OWED) {
                owed.entry(sid.to_owned()).or_insert_with(|| body.clone());
            }
            let queues = queues(body);
            for qid in queues.iter().filter(|qid| qid.starts_with("completion_")) {
                crate::completion_receipts::record(header, qid);
            }
            queues
        }
        WorkStopPhase::Settled => {
            if let Some(owed) = header.get_mut(OWED).and_then(Value::as_object_mut) {
                owed.shift_remove(sid);
            }
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::fold::Fold;
    use crate::fold::NoIndex;
    use crate::schema::blob::Slot;
    use crate::schema::checkpoint::FramePos;
    use crate::schema::record::QueueAction;
    use crate::schema::record::QueueRecord;
    use crate::schema::record::Record;
    use crate::schema::record::SessionRecord;
    use crate::schema::record::WorkStopRecord;

    fn id(text: &str) -> crate::schema::bounded::Id {
        text.try_into().expect("an id")
    }

    fn fold(records: &[Record]) -> Fold {
        let session = SessionRecord { v: 2, id: id("s"), log_id: "0".repeat(24).as_str().try_into().expect("log id"), base: None, origin: None, op: None, control: false, header: Slot::Inline(Header::new()) };
        let mut fold = Fold::from_session(&session, Header::new(), FramePos { ordinal: 0, file_no: 0, offset: 0 });
        let effects = fold.prepare(records, &NoIndex, &mut |_| Err("no blob".into())).expect("prepared");
        for effect in effects {
            let pos = FramePos { ordinal: fold.next_ordinal, file_no: 0, offset: 0 };
            fold.apply(effect, pos);
        }
        fold
    }

    fn enqueue(qid: &str) -> Record {
        Record::Queue(QueueRecord { qid: id(qid), action: QueueAction::Enqueue, reason: None, op: None, entry: Some(Slot::Inline(json!({ "message": "m" }))) })
    }

    fn stop(sid: &str, phase: WorkStopPhase, body: Option<Value>) -> Record {
        Record::WorkStop(WorkStopRecord { sid: id(sid), phase, at: Some(1), body: body.map(Slot::Inline) })
    }

    /// The store's fold of a Stop: its queue copies leave, a stopped completion has its receipt, every identity is terminal, and
    /// the owed outcome stays owed until the Stop settles; an unrelated entry queued later stays queued.
    #[test]
    fn a_stop_folds_terminal_receipts_and_an_owed_outcome_until_settled() {
        let body = json!({ "work": ["completion_a"], "queues": ["completion_a"], "submissions": [], "disposition": "cancelled" });
        let stopped = fold(&[enqueue("completion_a"), stop("stop-1", WorkStopPhase::Stopped, Some(body.clone())), enqueue("completion_b")]);
        assert_eq!(stopped.queue.iter().map(|q| q.qid.as_str()).collect::<Vec<_>>(), ["completion_b"]);
        assert!(crate::completion_receipts::contains(&stopped.header, "completion_a"));
        assert!(!crate::completion_receipts::contains(&stopped.header, "completion_b"));
        assert_eq!(super::stopped(&stopped.header, &queued("completion_a")), Some("stop-1"));
        assert_eq!(super::stopped(&stopped.header, &queued("completion_b")), None);
        assert_eq!(owed(&stopped.header), vec![("stop-1".to_owned(), body.clone())]);
        let settled = fold(&[enqueue("completion_a"), stop("stop-1", WorkStopPhase::Stopped, Some(body)), stop("stop-1", WorkStopPhase::Settled, None)]);
        assert!(owed(&settled.header).is_empty(), "the outcome is final");
        assert_eq!(super::stopped(&settled.header, &work("completion_a")), Some("stop-1"), "the receipt outlives the settlement");
        // The checkpoint carries the header, so a reopened fold keeps both.
        let state = settled.checkpoint_state();
        assert_eq!(super::stopped(&state.header, &queued("completion_a")), Some("stop-1"));
    }

    #[test]
    fn a_work_stop_record_round_trips_its_vector() {
        let text = r#"{"k":"work_stop","sid":"stop-1","phase":"stopped","at":1,"body":{"inline":{"work":["w"],"queues":["q"],"submissions":["s"],"turn":"t","disposition":"handedBack","restore":{"text":"hi","ids":["s"],"device":"d"}}}}"#;
        let record: Record = serde_json::from_str(text).expect("parses");
        assert_eq!(serde_json::to_string(&record).expect("encodes"), text);
        assert!(serde_json::from_str::<Record>(r#"{"k":"work_stop","sid":"s","phase":"stopped","extra":1}"#).is_err());
    }
}
