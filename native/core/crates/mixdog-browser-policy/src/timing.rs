//! Per-command diagnostics only (`timing.ts`). Parallel pages never share a collector; phases may overlap, so their durations must
//! not be added to `commandMs`. [`CommandTiming`] is the `BrowserCommandTiming` wire record, byte for byte in its JSON shape.
//!
//! The collector takes the time as an argument (milliseconds on any monotonic clock, as `performance.now()`), so a caller holds one
//! per command and a test drives it with a clock it controls.

use serde::Deserialize;
use serde::Serialize;

/// The phases a command spends its time in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Wait,
    Snapshot,
    Screenshot,
    Target,
    Actionability,
    Input,
}

/// Every phase, in the order the phase table of a collector keeps them.
pub const PHASES: [Phase; 6] = [Phase::Wait, Phase::Snapshot, Phase::Screenshot, Phase::Target, Phase::Actionability, Phase::Input];

impl Phase {
    fn slot(self) -> usize {
        self as usize
    }
}

/// The mouse events whose dispatch is timed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseEventKind {
    Moved,
    Pressed,
    Released,
}

/// A sequence step's own timing: its phase durations are deltas of the command's, because steps run one after another.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepTiming {
    pub index: u32,
    pub command_ms: f64,
    pub wait_ms: f64,
    pub snapshot_ms: f64,
    pub target_ms: f64,
    pub actionability_ms: f64,
    pub input_ms: f64,
}

/// The count and total duration of one kind of mouse event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseStat {
    pub count: u32,
    pub total_ms: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseEvents {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouse_moved: Option<MouseStat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouse_pressed: Option<MouseStat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouse_released: Option<MouseStat>,
}

impl MouseEvents {
    fn stat_mut(&mut self, kind: MouseEventKind) -> &mut MouseStat {
        let slot = match kind {
            MouseEventKind::Moved => &mut self.mouse_moved,
            MouseEventKind::Pressed => &mut self.mouse_pressed,
            MouseEventKind::Released => &mut self.mouse_released,
        };
        slot.get_or_insert_with(MouseStat::default)
    }
}

/// The record a command result carries as `timing`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTiming {
    pub queue_ms: f64,
    pub command_ms: f64,
    pub wait_ms: f64,
    pub snapshot_ms: f64,
    pub screenshot_ms: f64,
    pub snapshots: u32,
    pub screenshots: u32,
    pub target_ms: f64,
    pub actionability_ms: f64,
    pub input_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<StepTiming>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouse_events: Option<MouseEvents>,
}

impl CommandTiming {
    fn phase_ms_mut(&mut self, phase: Phase) -> &mut f64 {
        match phase {
            Phase::Wait => &mut self.wait_ms,
            Phase::Snapshot => &mut self.snapshot_ms,
            Phase::Screenshot => &mut self.screenshot_ms,
            Phase::Target => &mut self.target_ms,
            Phase::Actionability => &mut self.actionability_ms,
            Phase::Input => &mut self.input_ms,
        }
    }
}

/// What a host process measured for the command on its side (the Electron host's page work), reported to the core that owns the
/// command's record.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HostPhaseTimes {
    pub wait_ms: f64,
    pub snapshot_ms: f64,
    pub screenshot_ms: f64,
    pub target_ms: f64,
    pub actionability_ms: f64,
    pub input_ms: f64,
    pub snapshots: u32,
    pub screenshots: u32,
    pub mouse_events: Option<MouseEvents>,
}

/// A duration a host reported, as the record may hold it: finite and not negative (an invalid one counts as zero).
fn valid_ms(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 { value } else { 0.0 }
}

/// Adds what the host measured to the command's record: phase durations, counts and mouse events. The host's time was spent inside
/// the command, so `command_ms` and `queue_ms` stay the core's own and the steps are not touched.
pub fn merge_host(timing: &mut CommandTiming, host: &HostPhaseTimes) {
    for (phase, ms) in [
        (Phase::Wait, host.wait_ms),
        (Phase::Snapshot, host.snapshot_ms),
        (Phase::Screenshot, host.screenshot_ms),
        (Phase::Target, host.target_ms),
        (Phase::Actionability, host.actionability_ms),
        (Phase::Input, host.input_ms),
    ] {
        *timing.phase_ms_mut(phase) += valid_ms(ms);
    }
    timing.snapshots = timing.snapshots.saturating_add(host.snapshots);
    timing.screenshots = timing.screenshots.saturating_add(host.screenshots);
    let Some(reported) = host.mouse_events else { return };
    let events = timing.mouse_events.get_or_insert_with(MouseEvents::default);
    for kind in [MouseEventKind::Moved, MouseEventKind::Pressed, MouseEventKind::Released] {
        let source = match kind {
            MouseEventKind::Moved => reported.mouse_moved,
            MouseEventKind::Pressed => reported.mouse_pressed,
            MouseEventKind::Released => reported.mouse_released,
        };
        if let Some(stat) = source {
            let target = events.stat_mut(kind);
            target.count = target.count.saturating_add(stat.count);
            target.total_ms += valid_ms(stat.total_ms);
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Slot {
    depth: u32,
    started: f64,
}

/// What a step remembers of the command's record when it begins.
pub struct StepMark {
    before: CommandTiming,
    started: f64,
}

/// The record of one command being timed.
pub struct Collector {
    timing: CommandTiming,
    active: [Slot; 6],
    closed: bool,
    started: f64,
}

impl Collector {
    /// A collector for a command that waited `queue_ms` in the queue and starts at `now_ms`.
    pub fn start(queue_ms: f64, now_ms: f64) -> Self {
        Self {
            timing: CommandTiming { queue_ms, ..CommandTiming::default() },
            active: [Slot::default(); 6],
            closed: false,
            started: now_ms,
        }
    }

    /// A phase begins. A phase inside the same phase is counted once: only the outermost one holds the clock; a snapshot or a
    /// screenshot is counted each time it begins.
    pub fn enter(&mut self, phase: Phase, now_ms: f64) {
        if self.closed {
            return;
        }
        let slot = &mut self.active[phase.slot()];
        if slot.depth == 0 {
            slot.started = now_ms;
        }
        slot.depth += 1;
        match phase {
            Phase::Snapshot => self.timing.snapshots += 1,
            Phase::Screenshot => self.timing.screenshots += 1,
            _ => {}
        }
    }

    /// A phase ends; the outermost one adds its duration to the record.
    pub fn exit(&mut self, phase: Phase, now_ms: f64) {
        if self.closed {
            return;
        }
        let slot = &mut self.active[phase.slot()];
        slot.depth = slot.depth.saturating_sub(1);
        if slot.depth == 0 {
            let started = slot.started;
            *self.timing.phase_ms_mut(phase) += now_ms - started;
        }
    }

    /// One mouse event of `kind` took `elapsed_ms` to dispatch.
    pub fn mouse_event(&mut self, kind: MouseEventKind, elapsed_ms: f64) {
        if self.closed {
            return;
        }
        let events = self.timing.mouse_events.get_or_insert_with(MouseEvents::default);
        let stat = events.stat_mut(kind);
        stat.count += 1;
        stat.total_ms += elapsed_ms;
    }

    /// A sequence step begins (steps are sequential, so phase deltas belong to exactly one step).
    pub fn step_begin(&self, now_ms: f64) -> StepMark {
        StepMark { before: self.timing.clone(), started: now_ms }
    }

    /// The step `index` (1 to 6, at most six recorded) ends.
    pub fn step_end(&mut self, mark: &StepMark, index: u32, now_ms: f64) {
        if self.closed || !(1..=6).contains(&index) {
            return;
        }
        let timing = &self.timing;
        let step = StepTiming {
            index,
            command_ms: now_ms - mark.started,
            wait_ms: timing.wait_ms - mark.before.wait_ms,
            snapshot_ms: timing.snapshot_ms - mark.before.snapshot_ms,
            target_ms: timing.target_ms - mark.before.target_ms,
            actionability_ms: timing.actionability_ms - mark.before.actionability_ms,
            input_ms: timing.input_ms - mark.before.input_ms,
        };
        let steps = self.timing.steps.get_or_insert_with(Vec::new);
        if steps.len() < 6 {
            steps.push(step);
        }
    }

    /// Adds the host's measurements while the command is open (see [`merge_host`]).
    pub fn merge_host(&mut self, host: &HostPhaseTimes) {
        if !self.closed {
            merge_host(&mut self.timing, host);
        }
    }

    /// The command ended, whether it returned or failed: its duration is set, a phase still open ends now, and the record is
    /// closed to every later call.
    pub fn finish(mut self, now_ms: f64) -> CommandTiming {
        self.timing.command_ms = now_ms - self.started;
        for phase in PHASES {
            let slot = self.active[phase.slot()];
            if slot.depth > 0 {
                *self.timing.phase_ms_mut(phase) += now_ms - slot.started;
            }
        }
        self.closed = true;
        self.timing
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_phases_count_once_and_counts_go_by_entry() {
        let mut c = Collector::start(12.0, 100.0);
        c.enter(Phase::Wait, 100.0);
        c.enter(Phase::Wait, 101.0);
        c.exit(Phase::Wait, 102.0);
        c.exit(Phase::Wait, 110.0);
        c.enter(Phase::Snapshot, 110.0);
        c.exit(Phase::Snapshot, 114.0);
        c.enter(Phase::Screenshot, 114.0);
        c.exit(Phase::Screenshot, 115.0);
        let t = c.finish(120.0);
        assert_eq!((t.queue_ms, t.command_ms, t.wait_ms, t.snapshot_ms, t.screenshot_ms), (12.0, 20.0, 10.0, 4.0, 1.0));
        assert_eq!((t.snapshots, t.screenshots), (1, 1));
    }

    #[test]
    fn an_open_phase_ends_with_the_command_and_the_record_is_then_closed() {
        let mut c = Collector::start(0.0, 0.0);
        c.enter(Phase::Input, 5.0);
        let t = c.finish(9.0);
        assert_eq!((t.input_ms, t.command_ms), (4.0, 9.0));
        let mut closed = Collector::start(0.0, 0.0);
        closed.closed = true;
        closed.enter(Phase::Snapshot, 1.0);
        closed.mouse_event(MouseEventKind::Moved, 1.0);
        let t = closed.finish(2.0);
        assert_eq!((t.snapshots, t.mouse_events), (0, None));
    }

    #[test]
    fn steps_hold_phase_deltas_and_stop_at_six() {
        let mut c = Collector::start(0.0, 0.0);
        let mark = c.step_begin(0.0);
        c.enter(Phase::Target, 0.0);
        c.enter(Phase::Snapshot, 1.0);
        c.exit(Phase::Snapshot, 3.0);
        c.exit(Phase::Target, 4.0);
        c.step_end(&mark, 1, 4.0);
        for index in 0..8 {
            let mark = c.step_begin(4.0);
            c.step_end(&mark, index, 4.0);
        }
        let t = c.finish(5.0);
        let steps = t.steps.unwrap_or_default();
        assert_eq!(steps.iter().map(|s| s.index).collect::<Vec<_>>(), [1, 1, 2, 3, 4, 5]);
        assert_eq!((steps[0].command_ms, steps[0].snapshot_ms, steps[0].target_ms), (4.0, 2.0, 4.0));
        assert_eq!(steps[1].target_ms, 0.0);
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_omits_what_is_absent() {
        let mut c = Collector::start(3.0, 0.0);
        c.mouse_event(MouseEventKind::Pressed, 2.0);
        let value = serde_json::to_value(c.finish(1.0)).unwrap_or_default();
        assert_eq!(value["queueMs"], 3.0);
        assert_eq!(value["mouseEvents"]["mousePressed"]["count"], 1);
        assert!(value.get("steps").is_none() && value["mouseEvents"].get("mouseMoved").is_none());
        assert!(value.get("snapshotMs").is_some() && value.get("actionabilityMs").is_some());
    }

    #[test]
    fn host_times_are_added_without_touching_the_command_duration() {
        let mut t = CommandTiming { queue_ms: 1.0, command_ms: 50.0, input_ms: 2.0, ..CommandTiming::default() };
        let host: HostPhaseTimes = serde_json::from_str(
            r#"{"inputMs":3,"waitMs":-4,"snapshotMs":1.5,"snapshots":2,"mouseEvents":{"mousePressed":{"count":1,"totalMs":2}}}"#,
        )
        .unwrap_or_default();
        merge_host(&mut t, &host);
        merge_host(&mut t, &host);
        assert_eq!((t.queue_ms, t.command_ms, t.input_ms, t.wait_ms, t.snapshot_ms, t.snapshots), (1.0, 50.0, 8.0, 0.0, 3.0, 4));
        assert_eq!(t.mouse_events.and_then(|m| m.mouse_pressed), Some(MouseStat { count: 2, total_ms: 4.0 }));
    }
}
