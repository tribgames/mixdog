//! The room supervisor's model call: one tool-free request on the Maintainer's own route
//! (Node `room-supervisor-completion.mjs` `decideRoomTurn`), resolved through the compaction route
//! plan, its reply read as a decision and one line per step written to the daemon's log.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::compact::summary_run::{RouteResolver, RouteStep, SummaryCall, SummaryFailure};
use mixdog_agent::one_shot::CallShape;
use mixdog_js::slice_utf16;

use super::exchange::{Action, Decision, Scene};
use super::exchange_run::SupervisorStep;
use super::supervisor::{SupervisorInput, parse_room_decision, supervisor_prompt};

/// One supervisor step on the Maintainer model (`decideRoomTurn`).
#[async_trait]
pub trait Maintainer: Send + Sync {
    /// `Ok(None)`: an unusable reply; `Ok(Some(Unmanaged))`: no Maintainer model is configured;
    /// `Err`: the model could not be asked or failed.
    async fn decide(&self, step: &SupervisorStep) -> Result<Option<Decision>, String>;
}

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_TOKENS: u64 = 400;
/// The head of an unusable reply the step's log line shows.
const REPLY_HEAD: usize = 160;

/// The daemon's raw log (`process.stderr.write` of the daemon, Node's default `log`).
pub type RawLog = Arc<dyn Fn(&str) + Send + Sync>;

/// [`Maintainer`] over a [`RouteResolver`] (`SummaryRoutes`).
///
/// The request is shaped as Node's step shapes it (`CallShape::room_supervisor`): the route's own
/// effort, no request kind, no 529 retry and no prompt cache.
pub struct RouteMaintainer {
    routes: Arc<dyn RouteResolver>,
    log: RawLog,
    timeout: Duration,
}

/// `decision=…` of the step's log line.
fn outcome(decision: Option<&Decision>, reply: &str) -> String {
    let scene = |scene: Option<Scene>| if scene == Some(Scene::Casual) { "casual" } else { "work" };
    match decision {
        None => format!("none reply={}", serde_json::to_string(&slice_utf16(reply, REPLY_HEAD)).expect("a string serializes")),
        Some(Decision { action: Action::Speak { agent_id, .. }, scene: s }) => format!("speak:{agent_id} scene={}", scene(*s)),
        Some(Decision { action: Action::Finish, scene: s }) => format!("finish scene={}", scene(*s)),
        Some(Decision { action: Action::Unmanaged, scene: s }) => format!("unmanaged scene={}", scene(*s)),
    }
}

/// The failure's message, as the room's `supervisor failed: …` line shows Node's `error.message`.
fn failure_text(failure: SummaryFailure) -> String {
    match failure {
        SummaryFailure::Overflow(text) | SummaryFailure::NextRoute(text) | SummaryFailure::Failed(text) => text,
        SummaryFailure::Aborted => TIMED_OUT.into(),
    }
}

/// `AbortSignal.timeout`'s error message.
const TIMED_OUT: &str = "The operation was aborted due to timeout";

impl RouteMaintainer {
    pub fn new(routes: Arc<dyn RouteResolver>, log: RawLog) -> Self {
        Self { routes, log, timeout: TIMEOUT }
    }

    /// One deadline over route resolution (which brings the provider up) and the send, as
    /// Node's single `AbortSignal.timeout` covers `initProviders` and `provider.send`.
    async fn step(&self, step: &SupervisorStep) -> Result<Option<Decision>, String> {
        // Members without an id are no candidates, and a step with none has no usable decision: no
        // route is resolved and nothing is asked or logged (`if (!members.length) return null`).
        // The exchange reaches this with every member it had called gone from the room since.
        let members: Vec<_> = step.members.iter().filter(|member| !member.id.is_empty()).cloned().collect();
        if members.is_empty() {
            return Ok(None);
        }
        // The Maintainer's own route only; without one the room is unmoderated.
        let route = match self.routes.resolve(RouteStep::Maintainer).await {
            Ok(Some(route)) => route,
            Ok(None) => return Ok(Some(Decision { action: Action::Unmanaged, scene: None })),
            Err(error) => return Err(failure_text(error)),
        };
        let prompt = supervisor_prompt(&SupervisorInput { room_name: &step.room_name, members: &members, rows: &step.rows, decide: &step.decide });
        let call = SummaryCall {
            model: route.model.clone(),
            max_output_tokens: MAX_OUTPUT_TOKENS,
            fast: route.fast,
            shape: CallShape::room_supervisor(route.effort.as_deref()),
        };
        let started = tokio::time::Instant::now();
        let reply = route.sender.send(&prompt.system, &prompt.user, &call).await.map_err(failure_text)?;
        let decision = parse_room_decision(&reply.text, &members);
        // One line per step: its latency and outcome, and for an unusable reply its bounded head.
        let ms = started.elapsed().as_millis();
        (self.log)(&format!("[room-supervisor] model={} ms={ms} decision={}\n", route.model, outcome(decision.as_ref(), &reply.text)));
        Ok(decision)
    }
}

#[async_trait]
impl Maintainer for RouteMaintainer {
    async fn decide(&self, step: &SupervisorStep) -> Result<Option<Decision>, String> {
        mixdog_rt::time::timeout(self.timeout, self.step(step)).await.unwrap_or_else(|_| Err(TIMED_OUT.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rooms::exchange::{DecideInput, Remaining};
    use crate::rooms::supervisor::SupervisorMember;
    use mixdog_agent::compact::summary_run::{SummaryFailure, SummaryResponse, SummaryRoute, SummarySender};
    use std::sync::Mutex;

    /// Answers `reply`, recording the effort and output cap of each call.
    struct Echo(&'static str, Arc<Mutex<Vec<String>>>);
    #[async_trait]
    impl SummarySender for Echo {
        async fn send(&self, _system: &str, _prompt: &str, call: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
            self.1.lock().unwrap().push(format!("{}|{}|{}|{}", call.model, call.max_output_tokens, call.fast, call.shape.effort));
            if self.0 == "boom" {
                return Err(SummaryFailure::Failed("x".into()));
            }
            Ok(SummaryResponse { text: self.0.to_owned(), tool_call: false, usage: None })
        }
    }

    struct Routes(Result<Option<()>, ()>, Option<&'static str>, &'static str, Arc<Mutex<Vec<String>>>);
    #[async_trait]
    impl RouteResolver for Routes {
        async fn resolve(&self, step: RouteStep) -> Result<Option<SummaryRoute>, SummaryFailure> {
            assert_eq!(step, RouteStep::Maintainer);
            match &self.0 {
                Err(()) => Err(SummaryFailure::Failed("provider".into())),
                Ok(None) => Ok(None),
                Ok(Some(())) => Ok(Some(SummaryRoute {
                    step,
                    provider_name: "p".into(),
                    model: "m".into(),
                    context_window: 1,
                    calibration: 1.0,
                    fast: true,
                    effort: self.1.map(str::to_owned),
                    sender: Arc::new(Echo(self.2, self.3.clone())),
                })),
            }
        }
    }

    fn step() -> SupervisorStep {
        SupervisorStep {
            room_name: "R".into(),
            members: vec![SupervisorMember { id: "gh".into(), name: "GitHub".into(), description: String::new() }],
            rows: vec![],
            decide: DecideInput { must_pick: false, turns: vec![], last: String::new(), mention: None, remaining: Remaining { messages: 1, steps: 1 } },
        }
    }

    fn maintainer(routes: Result<Option<()>, ()>, effort: Option<&'static str>, reply: &'static str) -> (RouteMaintainer, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::default();
        (RouteMaintainer::new(Arc::new(Routes(routes, effort, reply, Arc::clone(&calls))), Arc::new(|_: &str| {})), calls)
    }

    /// A resolution that never finishes (a provider that will not come up) ends at the deadline.
    struct Stuck;
    #[async_trait]
    impl RouteResolver for Stuck {
        async fn resolve(&self, _: RouteStep) -> Result<Option<SummaryRoute>, SummaryFailure> {
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn slow_provider_initialisation_times_out_too() {
        let maintainer = RouteMaintainer { routes: Arc::new(Stuck), log: Arc::new(|_: &str| {}), timeout: Duration::from_millis(50) };
        assert!(maintainer.decide(&step()).await.is_err());
    }

    /// Every member the exchange had called left the room: no route is resolved (the resolver here
    /// never finishes), nothing is asked or logged, and the step has no usable decision.
    #[tokio::test]
    async fn a_step_with_no_member_left_asks_nothing_and_decides_nothing() {
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = { let lines = lines.clone(); Arc::new(move |line: &str| lines.lock().unwrap().push(line.to_owned())) };
        let maintainer = RouteMaintainer { routes: Arc::new(Stuck), log, timeout: Duration::from_secs(5) };
        for members in [vec![], vec![SupervisorMember { id: String::new(), name: "Nobody".into(), description: String::new() }]] {
            let step = SupervisorStep { members, ..step() };
            assert_eq!(maintainer.decide(&step).await, Ok(None));
        }
        assert!(lines.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_route_without_effort_asks_low_and_a_blank_one_too() {
        for effort in [None, Some("  ")] {
            let (maintainer, calls) = maintainer(Ok(Some(())), effort, "{\"action\":\"finish\"}");
            assert_eq!(maintainer.decide(&step()).await, Ok(Some(Decision { action: Action::Finish, scene: Some(Scene::Work) })));
            assert_eq!(*calls.lock().unwrap(), ["m|400|true|low"]);
        }
    }

    #[tokio::test]
    async fn the_maintainers_route_answers_and_failures_and_no_route_are_told_apart() {
        let (answers, calls) = maintainer(Ok(Some(())), Some(" high "), "{\"action\":\"speak\",\"member\":\"gh\"}");
        let speak = Decision { action: Action::Speak { agent_id: "gh".into(), instruction: String::new() }, scene: Some(Scene::Work) };
        assert_eq!(answers.decide(&step()).await, Ok(Some(speak)));
        assert_eq!(*calls.lock().unwrap(), ["m|400|true|high"]);
        assert_eq!(maintainer(Ok(None), None, "").0.decide(&step()).await, Ok(Some(Decision { action: Action::Unmanaged, scene: None })));
        // A failure is its message, as the room's `supervisor failed: …` line shows Node's `error.message`.
        assert_eq!(maintainer(Err(()), None, "").0.decide(&step()).await, Err("provider".into()));
        assert_eq!(maintainer(Ok(Some(())), None, "boom").0.decide(&step()).await, Err("x".into()));
        assert_eq!(maintainer(Ok(Some(())), None, "").0.decide(&step()).await, Ok(None));
    }
}