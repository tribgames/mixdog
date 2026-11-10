//! The hub follows a runtime's life: a started thread shows the copies of its hand-offs (waiting
//! ones included) in its approvals section, an answered copy leaves, a stopped thread shows none.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadApprovals;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::{Section, ThreadState};
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value, json};

use super::{HandoffQuestionsHub, RuntimeHooks};
use crate::session::delegated_host::{Answered, Delegated, DelegatedApprovalHost};

#[derive(Default)]
struct Feed(Mutex<Vec<(String, Vec<Value>)>>, tokio::sync::Notify);

#[async_trait]
impl ThreadState for Feed {
    async fn header(&self, _: &ThreadId) -> Result<Header, PortError> {
        unreachable!("the hub only publishes sections")
    }
    async fn patch_header(&self, _: &ThreadId, _: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        unreachable!("the hub only publishes sections")
    }
    async fn patch_header_if(&self, _: &ThreadId, _: Map<String, Value>, _: Map<String, Value>, _: Vec<String>) -> Result<Option<Map<String, Value>>, PortError> {
        unreachable!("the hub only publishes sections")
    }
    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        let Section::Approvals(ThreadApprovals { handoff_questions: Some(questions), .. }) = section else { panic!("only handoff questions are published") };
        self.0.lock().unwrap().push((thread.as_str().to_owned(), questions));
        self.1.notify_waiters();
        Ok(())
    }
}

fn question(id: &str, to: &str) -> Delegated {
    Delegated { id: id.into(), session_id: to.into(), request: json!({ "id": id, "kind": "question", "sessionId": "task" }), answer: Arc::new(|answered: &Answered| answered.approved) }
}

/// Returns once the feed's last publication is want.
async fn shown(feed: &Feed, want: Option<(String, Vec<Value>)>) {
    crate::eventually_on!(&[&feed.1], || (last(feed) == want).then_some(())).await;
}

fn last(feed: &Feed) -> Option<(String, Vec<Value>)> {
    feed.0.lock().unwrap().last().cloned()
}

#[tokio::test]
async fn a_runtime_shows_the_questions_waiting_for_it_and_those_that_come_until_it_stops() {
    let host = DelegatedApprovalHost::new();
    let hub = HandoffQuestionsHub::new(host.clone());
    let feed = Arc::new(Feed::default());
    hub.bind(feed.clone()).ok().unwrap();
    let thread = ThreadId::from("home".to_owned());

    // Waiting before the runtime exists: adopted when it starts.
    host.delegate_approval(question("q1", "home"));
    hub.started(&thread);
    let q1 = json!({ "id": "q1", "kind": "question", "sessionId": "task" });
    shown(&feed, Some(("home".into(), vec![q1.clone()]))).await;
    assert_eq!(last(&feed), Some(("home".into(), vec![q1.clone()])));

    host.delegate_approval(question("q2", "home"));
    host.delegate_approval(question("elsewhere", "other"));
    let q2 = json!({ "id": "q2", "kind": "question", "sessionId": "task" });
    shown(&feed, Some(("home".into(), vec![q1, q2.clone()]))).await;
    let ids = |feed: &Feed| last(feed).unwrap().1.iter().map(|request| request["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(ids(&feed), ["q1", "q2"]);

    // Answered here: forwarded to the owner, the copy leaves.
    let answered = Answered { approved: true, ..Answered::default() };
    assert_eq!(hub.finish_question(&thread, "q1", &answered), Some(true));
    assert_eq!(hub.finish_question(&thread, "q1", &answered), None);
    shown(&feed, Some(("home".into(), vec![q2]))).await;
    assert_eq!(ids(&feed), ["q2"]);

    // Stopped: nothing more is shown, and the copies were dropped silently.
    hub.stopped(&thread);
    host.delegate_approval(question("q3", "home"));
    assert_eq!(hub.finish_question(&thread, "q2", &answered), None);
    // A publisher that survived the stop would still hold q3. Its drain task ends only when every owner of the queue is
    // gone, and publishes whatever was queued first, so what the feed holds once the tasks have ended is final.
    let publishers = hub.take_publishers();
    drop(hub);
    drop(host);
    for publisher in publishers {
        crate::session::testing::awaiting(|| "a drain task to end once every owner of its queue is gone".to_owned(), publisher).await.unwrap();
    }
    assert_eq!(ids(&feed), ["q2"]);
}

#[tokio::test]
async fn a_runtime_that_starts_before_the_feed_is_bound_holds_nothing() {
    let host = DelegatedApprovalHost::new();
    let hub = HandoffQuestionsHub::new(host.clone());
    hub.started(&ThreadId::from("home".to_owned()));
    host.delegate_approval(question("q1", "home"));
    assert!(host.delegated_approvals_for("home").len() == 1);
    assert_eq!(hub.finish_question(&ThreadId::from("home".to_owned()), "q1", &Answered::default()), None);
}
