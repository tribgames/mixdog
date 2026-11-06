//! One bounded room exchange, strictly serial, steered by a supervisor. The caller supplies the
//! members' turns and the supervisor step through `ExchangeHost`; this module owns the order, the
//! caps and the deterministic fallbacks.
//!
//! Members the user addressed answer first, once each, in that order; cut by the message cap, the
//! outcome lists the ones still owed a turn. After that each step asks the supervisor for the next
//! speaker. Until some member has spoken the exchange cannot finish while the user waits. The caps
//! stay hard: `max_messages` bounds speeches, `max_rounds × members` bounds the supervisor's steps.

use async_trait::async_trait;

/// The kind of talk the newest usable decision saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scene {
    Casual,
    Work,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnResult {
    Speech,
    Pass,
    /// A stop cut the turn short; it leaves no trace.
    Stopped,
    /// A newer user message cut the turn short; it leaves no trace.
    Superseded,
    /// The member left or was switched off; counts as a pass.
    Unavailable,
}

/// A usage-limit stop a member's failed turn recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageLimit {
    pub kind: String,
    pub provider: String,
    pub model: String,
    pub reset_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub result: TurnResult,
    /// The peer the speech addressed by `@Name`.
    pub mention: Option<String>,
    pub failed: bool,
    pub usage: Option<UsageLimit>,
}

impl Answer {
    pub fn of(result: TurnResult) -> Self {
        Self { result, mention: None, failed: false, usage: None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
    pub addressed: Vec<String>,
    pub instruction: String,
    pub mentioned_by: String,
    pub scene: Scene,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Speak { agent_id: String, instruction: String },
    Finish,
    /// No Maintainer model: nobody moderates.
    Unmanaged,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    pub scene: Option<Scene>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TakenTurn {
    pub id: String,
    pub result: TurnResult,
    pub failed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Remaining {
    pub messages: u32,
    pub steps: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecideInput {
    pub must_pick: bool,
    pub turns: Vec<TakenTurn>,
    pub last: String,
    pub mention: Option<String>,
    pub remaining: Remaining,
}

#[async_trait]
pub trait ExchangeHost: Send + Sync {
    async fn speak(&self, agent_id: &str, turn: &Turn) -> Answer;
    /// `None`: no usable answer (failed or invalid); the fallback decides.
    async fn decide(&self, input: &DecideInput) -> Option<Decision>;
    fn stopped(&self) -> bool;
    /// A newer user message arrived.
    fn superseded(&self) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Capped,
    Stopped,
    Superseded,
    /// A member met the provider's usage limit; every other would too.
    Limited,
    /// Every member failed in a row.
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapLimit {
    Messages,
    Rounds,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExchangeResult {
    pub outcome: Outcome,
    pub rounds: u32,
    pub steps: u32,
    pub messages: u32,
    pub limit: Option<CapLimit>,
    pub remaining: Vec<String>,
    pub usage: Option<UsageLimit>,
}

pub struct ExchangeParams {
    pub members: Vec<String>,
    /// The members the request named; empty is the whole room.
    pub to: Vec<String>,
    pub max_rounds: u32,
    pub max_messages: u32,
    /// The user's newest message has no answer yet.
    pub waiting: bool,
    /// The called members answer and nobody else follows.
    pub only: bool,
    /// A request that also addressed the whole room keeps the room's turn after its named
    /// members; `None` means "whole room iff nobody was named".
    pub whole_room: Option<bool>,
}

struct State<'a, H: ExchangeHost> {
    host: &'a H,
    members: &'a [String],
    max_rounds: u32,
    max_messages: u32,
    waiting: bool,
    turns: Vec<TakenTurn>,
    messages: u32,
    steps: u32,
    heard: bool,
    mention: Option<String>,
    scene: Scene,
    limited_by: Option<UsageLimit>,
}

impl<H: ExchangeHost> State<'_, H> {
    fn end(&self, outcome: Outcome, limit: Option<CapLimit>, remaining: Vec<String>) -> ExchangeResult {
        let members = self.members.len().max(1) as u32;
        let rounds = (self.turns.len() as u32).div_ceil(members).clamp(1, self.max_rounds.max(1));
        ExchangeResult {
            outcome,
            rounds,
            steps: self.steps,
            messages: self.messages,
            limit,
            remaining,
            usage: if outcome == Outcome::Limited { self.limited_by.clone() } else { None },
        }
    }

    fn halted(&self) -> Option<ExchangeResult> {
        if self.host.stopped() {
            return Some(self.end(Outcome::Stopped, None, vec![]));
        }
        if self.host.superseded() {
            return Some(self.end(Outcome::Superseded, None, vec![]));
        }
        None
    }

    /// One member's turn; `Some(outcome)` when the exchange must end because of it.
    async fn take(&mut self, agent_id: &str, turn: Turn) -> Option<Outcome> {
        let answer = self.host.speak(agent_id, &turn).await;
        match answer.result {
            TurnResult::Stopped => return Some(Outcome::Stopped),
            TurnResult::Superseded => return Some(Outcome::Superseded),
            TurnResult::Unavailable => {}
            _ => self.heard = true,
        }
        let result = if answer.result == TurnResult::Unavailable { TurnResult::Pass } else { answer.result };
        self.turns.push(TakenTurn { id: agent_id.to_owned(), result, failed: answer.failed });
        let speech = answer.result == TurnResult::Speech;
        if speech {
            self.messages += 1;
        }
        self.mention = answer
            .mention
            .filter(|addressee| speech && addressee != agent_id && self.members.contains(addressee));
        if let Some(usage) = answer.usage {
            self.limited_by = Some(usage);
            return Some(Outcome::Limited);
        }
        // Every member failed in a row: another round would only fail the same way.
        if answer.failed && self.failed_everywhere() {
            return Some(Outcome::Failed);
        }
        None
    }

    fn failed_everywhere(&self) -> bool {
        let failing: Vec<&str> =
            self.turns.iter().rev().take_while(|turn| turn.failed).map(|turn| turn.id.as_str()).collect();
        self.members.iter().all(|id| failing.contains(&id.as_str()))
    }

    /// Every member but the newest speech's author has passed since it (no speech yet and the
    /// user not waiting: every member has passed): nobody has anything to add.
    fn spoken_out(&self) -> bool {
        let at = self.turns.iter().rposition(|turn| turn.result == TurnResult::Speech);
        if at.is_none() && (self.waiting || self.turns.is_empty()) {
            return false;
        }
        let after = at.map_or(0, |at| at + 1);
        self.members.iter().all(|id| {
            at.is_some_and(|at| self.turns[at].id == *id) || self.turns[after..].iter().any(|turn| turn.id == *id)
        })
    }

    /// Each of `called` answers once, in order; `None` when all did.
    async fn call_each(&mut self, called: &[String]) -> Option<ExchangeResult> {
        for (index, agent_id) in called.iter().enumerate() {
            if let Some(halt) = self.halted() {
                return Some(halt);
            }
            let turn = Turn {
                addressed: called.to_vec(),
                instruction: String::new(),
                mentioned_by: String::new(),
                scene: self.scene,
            };
            if let Some(cut) = self.take(agent_id, turn).await {
                return Some(self.end(cut, None, vec![]));
            }
            if self.messages >= self.max_messages {
                let remaining = called[index + 1..].to_vec();
                return Some(self.end(Outcome::Capped, Some(CapLimit::Messages), remaining));
            }
        }
        None
    }

    /// The member the supervisor's `decision` gives the next turn, or `None` to finish. A decision
    /// that names no other member than the last one to take a turn, or that finishes while nobody
    /// has spoken (`must_pick`), falls back deterministically: first the member the user
    /// addressed, else the first member, preferring one that has not had a turn yet; later, the
    /// peer the last speech @mentioned, else finish.
    fn next_speaker(
        &self,
        decision: Option<&Decision>,
        targets: &[String],
        must_pick: bool,
    ) -> Option<(String, String)> {
        let last = self.turns.last().map(|turn| turn.id.as_str()).unwrap_or("");
        match decision.map(|d| &d.action) {
            Some(Action::Speak { agent_id, instruction })
                if self.members.contains(agent_id) && agent_id != last =>
            {
                return Some((agent_id.clone(), instruction.clone()));
            }
            Some(Action::Finish) if !must_pick => return None,
            _ => {}
        }
        if !must_pick {
            return self.mention.clone().map(|id| (id, String::new()));
        }
        let mut order: Vec<&String> = Vec::new();
        for id in targets.iter().chain(self.members) {
            if id != last && !order.contains(&id) {
                order.push(id);
            }
        }
        let pick = order
            .iter()
            .find(|candidate| !self.turns.iter().any(|turn| &turn.id == **candidate))
            .or(order.first())?;
        Some(((*pick).clone(), String::new()))
    }
}

pub async fn run_room_exchange<H: ExchangeHost>(host: &H, params: ExchangeParams) -> ExchangeResult {
    let ExchangeParams { members, to, max_rounds, max_messages, waiting, only, whole_room } = params;
    let mut state = State {
        host,
        members: &members,
        max_rounds,
        max_messages,
        waiting,
        turns: Vec::new(),
        messages: 0,
        steps: 0,
        heard: false,
        mention: None,
        scene: Scene::Work,
        limited_by: None,
    };
    let nobody = |state: &State<'_, H>| state.end(Outcome::Done, None, vec![]);
    // A room whose last member was removed has nobody to hear it: finished, no turns.
    if members.is_empty() {
        return ExchangeResult { rounds: 0, ..nobody(&state) };
    }
    let mut targets: Vec<String> = Vec::new();
    for id in &to {
        if !id.is_empty() && members.contains(id) && !targets.contains(id) {
            targets.push(id.clone());
        }
    }
    let named = to.iter().any(|id| !id.is_empty());
    let open = whole_room.unwrap_or(!named);
    // Every recipient the request named is gone: it is not a call to the whole room.
    if !open && targets.is_empty() {
        return ExchangeResult { rounds: 0, ..nobody(&state) };
    }
    let max_steps = max_rounds * members.len() as u32;
    if let Some(answered) = state.call_each(&targets).await {
        return answered;
    }
    // Every named member turned out unavailable: no other member is called instead.
    if !open && !targets.is_empty() && !state.heard {
        return nobody(&state);
    }
    if only && !targets.is_empty() {
        return nobody(&state);
    }
    loop {
        if let Some(halt) = state.halted() {
            return halt;
        }
        if state.spoken_out() {
            return nobody(&state);
        }
        if state.steps >= max_steps {
            // Turns that were all passes since the last speech are no live talk cut off.
            let last_spoke = state.turns.last().is_some_and(|turn| turn.result == TurnResult::Speech);
            return if (state.messages > 0 || !state.waiting) && !last_spoke {
                nobody(&state)
            } else {
                state.end(Outcome::Capped, Some(CapLimit::Rounds), vec![])
            };
        }
        state.steps += 1;
        let must_pick = state.waiting && state.messages == 0;
        let input = DecideInput {
            must_pick,
            turns: state.turns.clone(),
            last: state.turns.last().map(|turn| turn.id.clone()).unwrap_or_default(),
            mention: state.mention.clone(),
            remaining: Remaining {
                messages: state.max_messages - state.messages,
                steps: max_steps - state.steps + 1,
            },
        };
        let decision = host.decide(&input).await;
        if let Some(halt) = state.halted() {
            return halt;
        }
        // No Maintainer model: the called members answered once above; a call to the whole room
        // gives every member one turn, in order. No further rounds, no follow-ups.
        if matches!(decision.as_ref().map(|d| &d.action), Some(Action::Unmanaged)) {
            if state.waiting && targets.is_empty() {
                if let Some(result) = state.call_each(&members).await {
                    return result;
                }
            }
            return nobody(&state);
        }
        if let Some(scene) = decision.as_ref().and_then(|d| d.scene) {
            state.scene = scene;
        }
        let Some((next, instruction)) = state.next_speaker(decision.as_ref(), &targets, must_pick) else {
            return nobody(&state);
        };
        let last = state.turns.last().map(|turn| turn.id.clone()).unwrap_or_default();
        let mentioned_by = if state.mention.as_deref() == Some(next.as_str()) { last } else { String::new() };
        let turn = Turn { addressed: vec![], instruction, mentioned_by, scene: state.scene };
        if let Some(cut) = state.take(&next, turn).await {
            return state.end(cut, None, vec![]);
        }
        if state.messages >= state.max_messages {
            return state.end(Outcome::Capped, Some(CapLimit::Messages), vec![]);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;

    /// Scripted model: per-agent answers in order, supervisor decisions in order.
    struct Script {
        answers: Mutex<Vec<(String, VecDeque<Answer>)>>,
        decisions: Mutex<VecDeque<Option<Decision>>>,
        log: Mutex<Vec<String>>,
        stop_after: Option<usize>,
    }

    impl Script {
        fn new(answers: &[(&str, Vec<Answer>)], decisions: Vec<Option<Decision>>) -> Self {
            Self {
                answers: Mutex::new(answers.iter().map(|(id, a)| ((*id).to_owned(), a.clone().into())).collect()),
                decisions: Mutex::new(decisions.into()),
                log: Mutex::new(vec![]),
                stop_after: None,
            }
        }
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl ExchangeHost for Script {
        async fn speak(&self, agent_id: &str, _turn: &Turn) -> Answer {
            self.log.lock().unwrap().push(agent_id.to_owned());
            let mut answers = self.answers.lock().unwrap();
            let queue = &mut answers.iter_mut().find(|(id, _)| id == agent_id).unwrap().1;
            queue.pop_front().unwrap_or(Answer::of(TurnResult::Pass))
        }
        async fn decide(&self, _input: &DecideInput) -> Option<Decision> {
            self.decisions.lock().unwrap().pop_front().flatten()
        }
        fn stopped(&self) -> bool {
            self.stop_after.is_some_and(|n| self.log.lock().unwrap().len() >= n)
        }
        fn superseded(&self) -> bool {
            false
        }
    }

    fn speech() -> Answer {
        Answer::of(TurnResult::Speech)
    }
    fn pass() -> Answer {
        Answer::of(TurnResult::Pass)
    }
    fn speak(id: &str) -> Option<Decision> {
        Some(Decision { action: Action::Speak { agent_id: id.into(), instruction: String::new() }, scene: None })
    }
    fn finish() -> Option<Decision> {
        Some(Decision { action: Action::Finish, scene: None })
    }
    fn params(members: &[&str], to: &[&str]) -> ExchangeParams {
        ExchangeParams {
            members: members.iter().map(|m| (*m).into()).collect(),
            to: to.iter().map(|m| (*m).into()).collect(),
            max_rounds: 3,
            max_messages: 8,
            waiting: true,
            only: false,
            whole_room: None,
        }
    }

    #[tokio::test]
    async fn addressees_answer_first_in_order_then_the_supervisor_steers() {
        let host = Script::new(
            &[("a", vec![speech()]), ("b", vec![speech(), speech()]), ("c", vec![speech()])],
            vec![speak("c"), finish()],
        );
        let result = run_room_exchange(&host, params(&["a", "b", "c"], &["b", "a"])).await;
        assert_eq!(host.log(), ["b", "a", "c"]);
        assert_eq!((result.outcome, result.messages, result.steps), (Outcome::Done, 3, 2));
    }

    #[tokio::test]
    async fn the_user_waiting_forces_a_first_speaker_when_the_supervisor_finishes() {
        let host = Script::new(&[("a", vec![speech()]), ("b", vec![])], vec![finish(), finish()]);
        let result = run_room_exchange(&host, params(&["a", "b"], &[])).await;
        assert_eq!(host.log(), ["a"]);
        assert_eq!((result.outcome, result.messages), (Outcome::Done, 1));
    }

    #[tokio::test]
    async fn a_supervisor_without_an_answer_falls_back_to_the_mention() {
        let host = Script::new(
            &[
                ("a", vec![Answer { mention: Some("b".into()), ..speech() }]),
                ("b", vec![speech()]),
            ],
            vec![None, None, None],
        );
        let result = run_room_exchange(&host, params(&["a", "b"], &[])).await;
        assert_eq!(host.log(), ["a", "b"]);
        assert_eq!(result.outcome, Outcome::Done);
    }

    #[tokio::test]
    async fn message_cap_lists_members_still_owed() {
        let host = Script::new(&[("a", vec![speech()]), ("b", vec![speech()]), ("c", vec![speech()])], vec![]);
        let mut p = params(&["a", "b", "c"], &["a", "b", "c"]);
        p.max_messages = 2;
        let result = run_room_exchange(&host, p).await;
        assert_eq!(host.log(), ["a", "b"]);
        assert_eq!(
            (result.outcome, result.limit, result.remaining),
            (Outcome::Capped, Some(CapLimit::Messages), vec!["c".to_string()])
        );
    }

    #[tokio::test]
    async fn rounds_cap_bounds_supervisor_steps() {
        let host = Script::new(
            &[("a", vec![speech(); 9]), ("b", vec![speech(); 9])],
            vec![speak("a"), speak("b"), speak("a"), speak("b"), speak("a"), speak("b"), speak("a")],
        );
        let mut p = params(&["a", "b"], &[]);
        p.max_rounds = 2;
        p.max_messages = 30;
        let result = run_room_exchange(&host, p).await;
        assert_eq!(host.log().len(), 4);
        assert_eq!((result.outcome, result.limit, result.steps), (Outcome::Capped, Some(CapLimit::Rounds), 4));
    }

    #[tokio::test]
    async fn everyone_passing_after_a_speech_ends_the_talk() {
        let host = Script::new(
            &[("a", vec![speech()]), ("b", vec![pass()]), ("c", vec![pass()])],
            vec![speak("a"), speak("b"), speak("c"), speak("a")],
        );
        let result = run_room_exchange(&host, params(&["a", "b", "c"], &[])).await;
        assert_eq!(host.log(), ["a", "b", "c"]);
        assert_eq!(result.outcome, Outcome::Done);
    }

    #[tokio::test]
    async fn unmanaged_gives_a_whole_room_call_one_turn_each() {
        let unmanaged = Some(Decision { action: Action::Unmanaged, scene: None });
        let host = Script::new(&[("a", vec![speech()]), ("b", vec![speech()])], vec![unmanaged]);
        let result = run_room_exchange(&host, params(&["a", "b"], &[])).await;
        assert_eq!(host.log(), ["a", "b"]);
        assert_eq!(result.outcome, Outcome::Done);
    }

    #[tokio::test]
    async fn usage_limit_ends_at_once_and_repeated_failures_end_failed() {
        let limit = UsageLimit { kind: "quota_exhausted".into(), provider: "p".into(), model: "m".into(), reset_at: None };
        let host = Script::new(
            &[("a", vec![Answer { failed: true, usage: Some(limit.clone()), ..pass() }]), ("b", vec![])],
            vec![speak("a")],
        );
        let result = run_room_exchange(&host, params(&["a", "b"], &[])).await;
        assert_eq!((result.outcome, result.usage), (Outcome::Limited, Some(limit)));

        let fail = Answer { failed: true, ..pass() };
        let host = Script::new(&[("a", vec![fail.clone()]), ("b", vec![fail])], vec![speak("a"), speak("b"), speak("a")]);
        let result = run_room_exchange(&host, params(&["a", "b"], &[])).await;
        assert_eq!((result.outcome, host.log()), (Outcome::Failed, vec!["a".to_string(), "b".to_string()]));
    }

    #[tokio::test]
    async fn stop_ends_the_exchange_between_turns() {
        let mut host = Script::new(&[("a", vec![speech()]), ("b", vec![speech()])], vec![speak("b")]);
        host.stop_after = Some(1);
        let result = run_room_exchange(&host, params(&["a", "b"], &["a", "b"])).await;
        assert_eq!((result.outcome, host.log()), (Outcome::Stopped, vec!["a".to_string()]));
    }

    #[tokio::test]
    async fn named_members_that_are_gone_call_nobody() {
        let host = Script::new(&[("a", vec![]), ("b", vec![])], vec![]);
        let result = run_room_exchange(&host, params(&["a", "b"], &["ghost"])).await;
        assert!(host.log().is_empty());
        assert_eq!((result.outcome, result.rounds), (Outcome::Done, 0));
        let empty = run_room_exchange(&host, params(&[], &[])).await;
        assert_eq!(empty.outcome, Outcome::Done);
    }

    #[tokio::test]
    async fn only_stops_after_the_called_members() {
        let host = Script::new(&[("a", vec![speech()]), ("b", vec![speech()])], vec![speak("b")]);
        let mut p = params(&["a", "b"], &["a"]);
        p.only = true;
        let result = run_room_exchange(&host, p).await;
        assert_eq!((host.log(), result.outcome), (vec!["a".to_string()], Outcome::Done));
    }
}
