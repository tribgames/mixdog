//! The question copies against `fixtures/handoff-questions/golden.json`, recorded from the real
//! `tool-approval.mjs` queue driven through the real delegated host: after each scripted step what
//! it returned, what it published as `handoffQuestions` and what the owner's callback received.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::super::delegated_host::{Answer, Answered, ApprovalQueue, Delegated, DelegatedApprovalHost};
use super::{HandoffQuestions, QuestionPublisher};

#[derive(Default)]
struct Published(Mutex<Option<Vec<Value>>>);

impl QuestionPublisher for Published {
    fn publish(&self, questions: Vec<Value>) {
        *self.0.lock().unwrap() = Some(questions);
    }
}

struct Rig {
    host: Arc<DelegatedApprovalHost>,
    published: Arc<Published>,
    session: Arc<Mutex<String>>,
    calls: Arc<Mutex<Vec<Value>>>,
    queue: Option<Arc<HandoffQuestions>>,
}

fn null_or(value: &Option<Value>) -> Value {
    value.clone().unwrap_or(Value::Null)
}

/// Owner callbacks: `yes` accepts; `no`, `truthy` (returns 1, not `true`) and `throws` are refusals.
fn answer(label: &str, calls: &Arc<Mutex<Vec<Value>>>) -> Answer {
    let accept = label == "yes";
    let calls = calls.clone();
    Arc::new(move |answered: &Answered| {
        calls.lock().unwrap().push(json!([answered.approved, answered.reason, answered.device, null_or(&answered.answers), null_or(&answered.reply), null_or(&answered.extra)]));
        accept
    })
}

impl Rig {
    fn queue(&self) -> &Arc<HandoffQuestions> {
        self.queue.as_ref().expect("create comes first")
    }

    fn delegated(&self, to: &str, id: &str, session: &Value, label: &str) -> Delegated {
        let mut request = json!({ "id": id, "kind": "question" });
        if !session.is_null() {
            request["sessionId"] = session.clone();
        }
        Delegated { id: id.to_owned(), session_id: to.to_owned(), request, answer: answer(label, &self.calls) }
    }

    fn step(&mut self, call: &[Value]) -> Value {
        let text = |at: usize| call[at].as_str().unwrap();
        match text(0) {
            "create" => {
                let session = self.session.clone();
                let queue = HandoffQuestions::new(Arc::new(move || session.lock().unwrap().clone()), self.published.clone());
                self.host.register_queue(queue.clone());
                self.queue = Some(queue);
            }
            "offer" => {
                let label = call.get(3).and_then(Value::as_str).unwrap_or("yes");
                let delegated = self.delegated("h1", text(1), &call[2], label);
                self.host.delegate_approval(delegated);
            }
            "offerTo" => {
                let delegated = self.delegated(text(2), text(1), &call[3], "yes");
                self.host.delegate_approval(delegated);
            }
            "withdraw" => self.host.withdraw_delegated_approval(text(1), call.get(2)),
            "finish" => {
                let answered = Answered {
                    approved: call[2].as_bool().unwrap(),
                    reason: text(3).to_owned(),
                    device: text(4).to_owned(),
                    answers: Some(call[5].clone()),
                    reply: Some(call[6].clone()),
                    extra: Some(call[7].clone()),
                };
                return json!(self.queue().finish_question(text(1), &answered).unwrap_or(false));
            }
            "finishBare" => {
                let answered = Answered { approved: call[2].as_bool().unwrap(), ..Answered::default() };
                return json!(self.queue().finish_question(text(1), &answered).unwrap_or(false));
            }
            "adopt" => {
                let own = self.queue().session_id();
                for delegated in self.host.delegated_approvals_for(&own) {
                    self.queue().offer(&delegated);
                }
            }
            "session" => *self.session.lock().unwrap() = text(1).to_owned(),
            "dispose" => self.queue().close(),
            other => panic!("unknown step {other}"),
        }
        Value::Null
    }
}

#[test]
fn every_scripted_step_publishes_what_the_node_queue_published() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/handoff-questions/golden.json");
    let golden: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let mut rig = Rig {
            host: DelegatedApprovalHost::new(),
            published: Arc::default(),
            session: Arc::new(Mutex::new("h1".to_owned())),
            calls: Arc::default(),
            queue: None,
        };
        for (index, recorded) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            rig.calls.lock().unwrap().clear();
            let call = recorded["call"].as_array().unwrap();
            let returned = rig.step(call);
            let published = rig.published.0.lock().unwrap().clone().map_or(Value::Null, Value::Array);
            let answered = Value::Array(rig.calls.lock().unwrap().clone());
            if returned != recorded["returned"] || published != recorded["published"] || answered != recorded["answered"] {
                failures.push(format!(
                    "{} / step {index} {call:?}:\n got  {returned} {published} {answered}\n Node {} {} {}",
                    scenario["name"], recorded["returned"], recorded["published"], recorded["answered"]
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
