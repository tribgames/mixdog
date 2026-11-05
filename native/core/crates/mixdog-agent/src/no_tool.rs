//! Resolution of a provider turn that returned no client tool calls.
//!
//! Such a turn is not automatically the final answer: the provider may have
//! hit its output ceiling, been cut by a safety classifier, declared the turn
//! unfinished, or returned nothing. Each case owns a bounded recovery ladder,
//! and every ladder terminates — an unbounded one turns a deterministic
//! provider state into an infinite loop.

use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::ToolCall;

use crate::env::DrainStage;
use crate::env::Priority;
use crate::env::RetractReason;
use crate::env::Retracted;
use crate::env::RunEvent;
use crate::env::TextRetraction;
use crate::env::or_cancelled;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::ToolKind;
use crate::response::ModelResponse;
use crate::response::continuation_signal;
use crate::response::intermediate_message;
use crate::response::is_incomplete;
use crate::response::is_output_limit;
use crate::response::stop_text;
use crate::run::AgentError;
use crate::run::Run;
use crate::todo::TODO_TOOL;

const MAX_OUTPUT_RECOVERY_LIMIT: u32 = 3;
const EMPTY_NUDGE_MAX: u32 = 3;
const MAX_OUTPUT_EXHAUSTED_NOTICE: &str = "[mixdog-runtime] The model hit its output limit and the response stayed truncated after 3 recovery attempts.";
const MAX_OUTPUT_RESUME_PROMPT: &str = "[mixdog-runtime] Output token limit hit. Resume directly — no apology, no recap. Pick up exactly where you left off, and break the remaining work into smaller pieces.";
const STREAM_CUT_RESUME_PROMPT: &str = "[mixdog-runtime] The previous response was cut off by a network interruption mid-stream. Resume directly — no apology, no recap. Pick up exactly where the previous text stopped.";
const REFUSAL_RECOVERY_PROMPT: &str = "[mixdog-runtime] The previous completion was refused by the provider safety classifier (stopReason=refusal). Do not repeat it. Complete your assigned output within policy by omitting or reframing disallowed content; if no compliant output is possible, briefly state the refusal.";

/// What the loop does after a no-tool turn.
pub(crate) enum Outcome {
    /// The recovery appended to the transcript; send again.
    Continue,
    /// The terminal response, aggregated over the turn's segments.
    Break(Box<ModelResponse>),
}

/// Per-turn counters of the ladders and the caller-facing text aggregate.
#[derive(Default)]
pub struct NoToolState {
    max_output_recovery_count: u32,
    output_escalation_used: bool,
    refusal_retry_used: bool,
    empty_nudge_streak: u32,
    provider_continuation_count: u32,
    /// Bounds a text-only continuation runaway.
    continuations_since_tool_batch: u32,
    /// Committed-but-unsealed text segments of this user turn.
    parts: Vec<String>,
    /// Segments before this index are answers the turn went on past.
    ended_parts_end: usize,
    carried_answers: Vec<String>,
    /// The newest kept answer was followed by nothing but todo bookkeeping.
    report_stands: bool,
    /// Successful reactions: the input each was left against and whether it
    /// answered that input.
    reactions: Vec<(String, bool)>,
}

pub(crate) fn join_reports<S: AsRef<str>>(parts: &[S]) -> String {
    parts
        .iter()
        .map(|part| mixdog_js::js_trim(part.as_ref()))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

impl NoToolState {
    /// Input taken into the turn is new work: its outcome is the turn's, not
    /// the kept answer's.
    pub(crate) fn note_new_input(&mut self) {
        self.report_stands = false;
    }

    fn reset_output_limit(&mut self) {
        self.max_output_recovery_count = 0;
        self.output_escalation_used = false;
    }

    /// A turn that produced tool calls is never an empty contract violation,
    /// and it is real progress: a later output-limit cut starts a fresh ladder.
    pub(crate) fn note_tool_call_turn(&mut self) {
        self.empty_nudge_streak = 0;
        self.reset_output_limit();
    }

    pub(crate) fn report_stands(&self) -> bool {
        self.report_stands
    }

    pub(crate) fn provider_continuations(&self) -> u32 {
        self.provider_continuation_count
    }

    /// Every answer the turn went on past, for a turn that fails after them.
    pub(crate) fn ended_report(&self) -> String {
        let mut all = self.carried_answers.clone();
        all.push(self.parts[..self.ended_parts_end.min(self.parts.len())].join(""));
        join_reports(&all)
    }

    /// The terminal response of a turn that ended any other way gets the same
    /// report as one that ended through [`Run::resolve_no_tool`].
    pub(crate) fn finalize(&self, mut response: ModelResponse) -> ModelResponse {
        let earlier = join_reports(&self.carried_answers);
        if earlier.is_empty() {
            return response;
        }
        let own = response
            .report_content
            .clone()
            .unwrap_or_else(|| response.content.clone());
        response.report_content = Some(join_reports(&[earlier, own]));
        response
    }
}

impl Run {
    fn commit_intermediate(&mut self, response: &ModelResponse) -> bool {
        match intermediate_message(response) {
            Some(mut message) => {
                message.turn_reminder = self.last_reminder.clone();
                self.push(message);
                true
            }
            None => false,
        }
    }

    /// Records a mid-turn segment for the caller-facing aggregate and surfaces
    /// it live. `committed` text is the just-committed message's own: a break
    /// keeps the aggregate from running two messages together, whereas a part
    /// that was cut off resumes right where it stopped.
    fn record_segment(&mut self, text: &str, committed: bool) {
        self.no_tool.parts.push(if committed {
            format!("{}\n\n", mixdog_js::js_trim_end(text))
        } else {
            text.to_owned()
        });
        self.emit(RunEvent::AssistantText {
            text: text.to_owned(),
            committed,
        });
    }

    /// An answer the turn goes on past (queued input or a todo reminder
    /// arrived after it) is committed like any segment and kept as part of the
    /// turn's report.
    fn keep_ended_answer(&mut self, response: &ModelResponse, has_content: bool) -> bool {
        if !self.commit_intermediate(response) || !has_content {
            return false;
        }
        self.record_segment(&response.content, true);
        self.no_tool.ended_parts_end = self.no_tool.parts.len();
        true
    }

    /// A no-tool message ends the turn; earlier committed segments are
    /// re-prepended so the caller receives the whole answer while history
    /// keeps only the terminal segment.
    fn finish_turn(&mut self, response: ModelResponse) -> Outcome {
        if self.no_tool.parts.is_empty() {
            return Outcome::Break(Box::new(self.no_tool.finalize(response)));
        }
        let terminal = response.content.clone();
        let attempts = self.no_tool.max_output_recovery_count;
        let aggregated = ModelResponse {
            content: format!("{}{terminal}", self.no_tool.parts.join("")),
            history_content: Some(terminal),
            max_output_recovery_attempts: (attempts > 0).then_some(attempts),
            ..response
        };
        Outcome::Break(Box::new(self.no_tool.finalize(aggregated)))
    }

    pub(crate) async fn resolve_no_tool(
        &mut self,
        response: ModelResponse,
    ) -> Result<Outcome, AgentError> {
        let has_content = response.has_content();
        let output_limit = is_output_limit(response.stop.as_ref());
        if output_limit || (has_content && response.stream_cut) {
            return Ok(self.resolve_output_limit(response, has_content));
        }
        if response.stop == Some(StopReason::Refusal) {
            return Ok(self.resolve_refusal(response, has_content));
        }
        // Structural only: no lexical or progress-text heuristic is consulted.
        if continuation_signal(response.stop.as_ref()).is_some()
            && self.resume_continuation(&response, has_content)
        {
            return Ok(Outcome::Continue);
        }
        // Hidden roles define a different output contract: a text-only or
        // empty terminal turn is the correct shape for them. Nor does a turn
        // whose kept answer only todo bookkeeping followed: that answer is its
        // reply.
        if !has_content
            && !self.config.hidden_agent
            && !self.reaction_answers_latest()
            && !self.no_tool.report_stands
        {
            return Ok(self.nudge_empty_turn(response));
        }
        // Pending-input rule: queued user input is folded into the turn
        // before terminal completion. Commit the terminal text first.
        let merged = self.take_steering(DrainStage::Terminal, Priority::Next).await?;
        if !merged.is_empty() {
            self.keep_ended_answer(&response, has_content);
            self.inject_steering(merged, DrainStage::Terminal);
            self.no_tool.empty_nudge_streak = 0;
            self.no_tool.reset_output_limit();
            return Ok(Outcome::Continue);
        }
        let completion = or_cancelled(
            &self.cancel,
            self.env.guards.completion_reminder(self.turn_limit_noticed),
        )
        .await
        .ok_or(AgentError::Aborted)?;
        if let Some(reminder) = completion {
            if self.keep_ended_answer(&response, has_content) {
                self.no_tool.report_stands = true;
            }
            self.push(AgentMessage::user(reminder));
            return Ok(Outcome::Continue);
        }
        Ok(self.finish_turn(response))
    }

    /// The single rule for every turn the provider cut at its output ceiling,
    /// with or without visible text. A turn that spent its whole budget would
    /// repeat identically if re-sent unchanged, so each step changes the
    /// request: escalate max_tokens once, then up to three resume prompts,
    /// then end with a visible notice. Real progress resets the ladder.
    fn resolve_output_limit(&mut self, response: ModelResponse, has_content: bool) -> Outcome {
        if !self.no_tool.output_escalation_used && is_output_limit(response.stop.as_ref()) {
            self.no_tool.output_escalation_used = true;
            if let Some(limit) = self.config.escalated_max_output_tokens.filter(|l| *l > 0)
                && self.withdraw_streamed_text()
            {
                self.max_output_override = Some(limit);
                return Outcome::Continue;
            }
        }
        if has_content {
            self.record_segment(&response.content, false);
        }
        if self.no_tool.max_output_recovery_count < MAX_OUTPUT_RECOVERY_LIMIT {
            // The partial assistant turn must be visible to the model so it
            // can resume at the exact cutoff; an empty cut has no output to
            // keep.
            if has_content {
                self.commit_intermediate(&response);
            }
            self.no_tool.max_output_recovery_count += 1;
            let attempt = self.no_tool.max_output_recovery_count;
            let prompt = if response.stream_cut {
                AgentMessage::sourced(Source::StreamCutRecovery, STREAM_CUT_RESUME_PROMPT)
            } else {
                AgentMessage::sourced(Source::MaxOutputRecovery, MAX_OUTPUT_RESUME_PROMPT)
            };
            self.push(prompt.with_attempt(attempt));
            return Outcome::Continue;
        }
        let terminal = if has_content {
            format!("{}\n\n{MAX_OUTPUT_EXHAUSTED_NOTICE}", response.content)
        } else {
            MAX_OUTPUT_EXHAUSTED_NOTICE.to_owned()
        };
        let parts = &self.no_tool.parts;
        let earlier_parts = if has_content {
            &parts[..parts.len().saturating_sub(1)]
        } else {
            &parts[..]
        };
        let earlier = earlier_parts.join("");
        let gap = if !earlier.is_empty() && !has_content {
            "\n\n"
        } else {
            ""
        };
        let attempts = self.no_tool.max_output_recovery_count;
        let ended = ModelResponse {
            content: format!("{earlier}{gap}{terminal}"),
            history_content: Some(terminal),
            max_output_recovery_attempts: Some(attempts),
            ..response
        };
        Outcome::Break(Box::new(self.no_tool.finalize(ended)))
    }

    /// The escalation discards the cut response, so what it already put on
    /// the live stream must be withdrawn; text the owner cannot withdraw would
    /// be shown twice, so that case does not escalate.
    fn withdraw_streamed_text(&self) -> bool {
        let chars = self.last_streamed_chars;
        if chars == 0 {
            return true;
        }
        self.env.observer.retract_text(TextRetraction {
            chars,
            reasoning: false,
            reason: RetractReason::OutputLimitEscalation,
        }) == Retracted::Withdrawn
    }

    /// One context-changing retry after a safety-classifier stop.
    fn resolve_refusal(&mut self, response: ModelResponse, has_content: bool) -> Outcome {
        if self.no_tool.refusal_retry_used {
            return Outcome::Break(Box::new(self.no_tool.finalize(response)));
        }
        self.no_tool.refusal_retry_used = true;
        // Harmless narration before the classifier ended the turn is kept, but
        // never mistaken for a successful completion.
        if has_content && self.commit_intermediate(&response) {
            self.record_segment(&response.content, true);
        }
        self.push(AgentMessage::sourced(Source::RefusalRecovery, REFUSAL_RECOVERY_PROMPT).with_attempt(1));
        Outcome::Continue
    }

    /// Structured provider continuations (`pause_turn`): honored, but they
    /// must not sustain an unbounded text-only loop. The text is mid-turn
    /// output: committed exactly once, sampling resumes in the same turn.
    fn resume_continuation(&mut self, response: &ModelResponse, has_content: bool) -> bool {
        if self.no_tool.continuations_since_tool_batch >= self.config.continuation_no_tool_limit.max(1)
        {
            return false;
        }
        if !self.commit_intermediate(response) {
            return false;
        }
        if has_content {
            self.record_segment(&response.content, true);
        }
        self.no_tool.provider_continuation_count += 1;
        self.no_tool.continuations_since_tool_batch += 1;
        self.no_tool.empty_nudge_streak = 0;
        self.no_tool.reset_output_limit();
        true
    }

    /// The agent contract requires a tool call or final handoff text, so a
    /// public agent's empty turn is re-prompted with a bounded nudge. A model
    /// that answers the same nudge with another empty turn is in a
    /// deterministic livelock; that ends as an explicit empty termination.
    fn nudge_empty_turn(&mut self, response: ModelResponse) -> Outcome {
        self.no_tool.empty_nudge_streak += 1;
        let streak = self.no_tool.empty_nudge_streak;
        if streak > EMPTY_NUDGE_MAX {
            return Outcome::Break(Box::new(self.no_tool.finalize(response)));
        }
        let text = match response.stop.as_ref().filter(|stop| is_incomplete(Some(stop))) {
            Some(stop) => format!(
                "[mixdog-runtime] Empty incomplete turn (stopReason={}). Return the remaining final handoff; use tools only for required evidence still missing.",
                stop_text(stop)
            ),
            None => format!(
                "[mixdog-runtime] Empty response ({streak}/{EMPTY_NUDGE_MAX}). Return final text, or use tools only for required evidence still missing."
            ),
        };
        self.push(AgentMessage::user(text));
        Outcome::Continue
    }

    /// A tool batch ran with `calls`; its result messages start at
    /// `results_from`.
    pub(crate) async fn note_tool_batch_completed(
        &mut self,
        calls: &[ToolCall],
        results_from: usize,
    ) -> Result<(), AgentError> {
        self.no_tool.continuations_since_tool_batch = 0;
        self.env.guards.note_progress();
        let results = self.messages[results_from..].to_vec();
        let stale = or_cancelled(&self.cancel, self.env.guards.stale_reminder(calls, &results))
            .await
            .ok_or(AgentError::Aborted)?;
        if let Some(stale) = stale {
            self.push(AgentMessage::sourced(Source::Hook, stale));
        }
        if self.no_tool.ended_parts_end > 0 {
            let end = self.no_tool.ended_parts_end.min(self.no_tool.parts.len());
            let answer = self.no_tool.parts[..end].join("");
            self.no_tool.carried_answers.push(answer);
        }
        self.no_tool.ended_parts_end = 0;
        if calls.iter().any(|call| call.name != TODO_TOOL) {
            self.no_tool.report_stands = false;
        }
        // The UI sealed its streaming row at a tool boundary; earlier
        // committed parts must not re-prepend at terminal.
        self.no_tool.parts.clear();
        self.note_batch_reactions(calls, results_from);
        Ok(())
    }

    fn latest_input(&self) -> Option<&AgentMessage> {
        let reactions = self.env.reactions.as_ref()?;
        self.messages
            .iter()
            .rev()
            .find(|m| reactions.is_reactable(m) || reactions.room_row(m).is_some())
    }

    fn latest_input_id(&self) -> String {
        self.latest_input()
            .and_then(|m| m.message_id.clone())
            .unwrap_or_default()
    }

    /// A reaction exempts the input only while no newer input arrived since it
    /// landed and it answered that input.
    pub(crate) fn reaction_answers_latest(&self) -> bool {
        let id = self.latest_input_id();
        self.no_tool
            .reactions
            .iter()
            .any(|(input, answered)| *answered && *input == id)
    }

    /// What this batch's react calls hit, from the target each recorded. Every
    /// record is consumed; a success that recorded none exempts nothing.
    fn note_batch_reactions(&mut self, calls: &[ToolCall], results_from: usize) {
        let Some(reactions) = self.env.reactions.clone() else {
            return;
        };
        let input_id = self.latest_input_id();
        let input_row = self.latest_input().and_then(|m| reactions.room_row(m));
        let mut hits = Vec::new();
        for call in calls.iter().filter(|c| reactions.is_reaction_call(c)) {
            let target = reactions.take_target(&call.id);
            let succeeded = self.messages[results_from..].iter().any(|m| {
                m.tool_call_id() == Some(call.id.as_str()) && m.tool_kind == Some(ToolKind::Normal)
            });
            let Some(target) = target.filter(|_| succeeded) else {
                continue;
            };
            let answered = if target.room {
                input_row.as_deref() == Some(target.message_id.as_str())
            } else {
                !input_id.is_empty() && target.message_id == input_id
            };
            hits.push((input_id.clone(), answered));
        }
        self.no_tool.reactions.extend(hits);
    }
}
