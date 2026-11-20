//! A backend with the same handle API that replays a call log.
//!
//! [`Fake`] answers each call from the recording and panics, failing the test, on the first call that differs from the
//! next recorded one in order, receiver, kind, member, flags, or the type and value of an argument. The message names
//! the first difference and shows both calls. A recording may carry reviewed allowances (see [`super::calllog`]) for a
//! property PowerShell's binder read twice where the port reads once.
//!
//! Boundary markers (`operation`, `snapshot`, `issues`) are consumed with [`Fake::boundary`]; a call that meets one
//! fails, unless the fake was told to [`ignore_boundaries`](Fake::ignore_boundaries).
//!
//! The recording's object ids stand for objects: the object an id names is the same object every time it is answered,
//! so [`Obj::same_object`] and the identity key behave as the recorded COM identity did.

use std::any::Any;
use std::cell::Cell;
use std::cell::RefCell;
use std::rc::Rc;
use std::rc::Weak;
use std::time::Duration;

use serde_json::Value as Json;

use super::Call;
use super::ComError;
use super::ComObject;
use super::ItemSource;
use super::Kind;
use super::Obj;
use super::Value;
use super::calllog::Allowance;
use super::calllog::CallEntry;
use super::calllog::CallLog;
use super::calllog::Entry;
use super::calllog::Outcome;
use super::calllog::decode_value;
use super::calllog::encode_value;
use super::retry::Pause;

struct State {
    entries: Vec<Entry>,
    allowances: Vec<Allowance>,
    position: usize,
    played: usize,
    ignore_boundaries: bool,
}

/// The replaying backend; objects of the recording come from [`Fake::object`] and from the answers.
pub struct Fake {
    state: Rc<RefCell<State>>,
}

struct FakeObject {
    id: u64,
    state: Weak<RefCell<State>>,
}

struct FakeEnum {
    id: u64,
    state: Weak<RefCell<State>>,
}

fn object_id(object: &Obj) -> u64 {
    object.log_id().unwrap_or(u64::MAX)
}

fn make_object(id: u64, state: &Weak<RefCell<State>>) -> Obj {
    Obj::new(Rc::new(FakeObject { id, state: state.clone() }))
}

/// One call, as the port made it (or as the recording holds it), with its arguments typed.
struct Probe<'a> {
    id: u64,
    kind: Kind,
    member: &'a str,
    flags: u32,
    args: &'a [Json],
    named: &'a [(String, Json)],
    value: Option<&'a Json>,
}

fn describe_call(probe: &Probe<'_>) -> String {
    let mut text = format!("{} obj#{} \"{}\" flags={} args={}", probe.kind.name(), probe.id, probe.member, probe.flags, Json::Array(probe.args.to_vec()));
    if !probe.named.is_empty() {
        let pairs = probe.named.iter().map(|(name, value)| Json::Array(vec![Json::String(name.clone()), value.clone()])).collect();
        text.push_str(&format!(" named={}", Json::Array(pairs)));
    }
    if let Some(value) = probe.value {
        text.push_str(&format!(" value={value}"));
    }
    text
}

fn describe_entry(entry: &Entry) -> String {
    match entry {
        Entry::Boundary(boundary) => format!("boundary {} \"{}\"", boundary.kind, boundary.name),
        Entry::Call(call) => describe_call(&Probe {
            id: call.obj,
            kind: call.kind,
            member: &call.member,
            flags: call.flags,
            args: &call.args,
            named: &call.named,
            value: call.value.as_ref(),
        }),
    }
}

fn mismatch(state: &State, what: &str, actual: &str) -> ! {
    let recorded = state.entries.get(state.position).map_or_else(|| "(the recording has no further call)".to_owned(), describe_entry);
    panic!("call log mismatch at call #{} (recorded entry {}): {what}\n  recorded: {recorded}\n  actual:   {actual}", state.played + 1, state.position);
}

impl State {
    fn skip_boundaries(&mut self) {
        while self.ignore_boundaries && matches!(self.entries.get(self.position), Some(Entry::Boundary(_))) {
            self.position += 1;
        }
    }

    /// Takes the next recorded call, which must be the call described; the first difference fails.
    fn take(&mut self, probe: &Probe<'_>) -> CallEntry {
        let Probe { id, kind, member, flags, args, named, value } = *probe;
        self.skip_boundaries();
        let actual = describe_call(probe);
        let recorded = match self.entries.get(self.position) {
            None => mismatch(self, "the port made a call the recording does not have", &actual),
            Some(Entry::Boundary(boundary)) => {
                mismatch(self, &format!("the recording is at the boundary {} \"{}\" and the port made a call", boundary.kind, boundary.name), &actual)
            }
            Some(Entry::Call(call)) => call.clone(),
        };
        if recorded.kind != kind {
            mismatch(self, &format!("kind: recorded {}, actual {}", recorded.kind.name(), kind.name()), &actual);
        }
        if recorded.obj != id {
            mismatch(self, &format!("receiver: recorded obj#{}, actual obj#{id}", recorded.obj), &actual);
        }
        if recorded.member != member {
            mismatch(self, &format!("member: recorded \"{}\", actual \"{member}\"", recorded.member), &actual);
        }
        if recorded.flags != flags {
            mismatch(self, &format!("flags: recorded {}, actual {flags}", recorded.flags), &actual);
        }
        if recorded.args.len() != args.len() {
            mismatch(self, &format!("argument count: recorded {}, actual {}", recorded.args.len(), args.len()), &actual);
        }
        for (index, (expected, got)) in recorded.args.iter().zip(args).enumerate() {
            if expected != got {
                mismatch(self, &format!("argument {index}: recorded {expected}, actual {got}"), &actual);
            }
        }
        if recorded.named.as_slice() != named {
            mismatch(self, "named arguments differ", &actual);
        }
        if recorded.value.as_ref() != value {
            mismatch(self, "the assigned value differs", &actual);
        }
        self.position += 1;
        self.played += 1;
        self.skip_allowed_repeats(&recorded);
        recorded
    }

    fn skip_allowed_repeats(&mut self, consumed: &CallEntry) {
        let Some(repeats) =
            self.allowances.iter().find(|allowance| allowance.kind == consumed.kind && allowance.member == consumed.member).map(|allowance| allowance.repeats)
        else {
            return;
        };
        for _ in 0..repeats {
            match self.entries.get(self.position) {
                Some(Entry::Call(next))
                    if next.obj == consumed.obj
                        && next.kind == consumed.kind
                        && next.member == consumed.member
                        && next.flags == consumed.flags
                        && next.args == consumed.args
                        && next.value == consumed.value =>
                {
                    self.position += 1;
                }
                _ => break,
            }
        }
    }
}

fn error_of(outcome: &Outcome) -> Option<ComError> {
    match outcome {
        Outcome::Error(error) => Some(ComError {
            hresult: error.hresult,
            inner_hresult: error.inner_hresult,
            message: error.message.clone(),
            inner_message: error.inner_message.clone(),
            unknown_member: error.unknown_member,
        }),
        _ => None,
    }
}

fn decode(json: &Json, state: &Weak<RefCell<State>>) -> Value {
    match decode_value(json, &mut |id| make_object(id, state)) {
        Ok(value) => value,
        Err(error) => panic!("call log: a recorded value cannot be read: {error}"),
    }
}

impl ComObject for FakeObject {
    fn invoke(&self, call: &Call<'_>) -> Result<Value, ComError> {
        let state = self.state.upgrade().expect("the fake was dropped while an object of it is still used");
        let ids = |object: &Obj| object_id(object);
        let args: Vec<Json> = call.args.iter().map(|value| encode_value(value, &ids)).collect();
        let named: Vec<(String, Json)> = call.named.iter().map(|(name, value)| ((*name).to_owned(), encode_value(value, &ids))).collect();
        let value = call.value.map(|value| encode_value(value, &ids));
        let recorded = state.borrow_mut().take(&Probe {
            id: self.id,
            kind: call.kind,
            member: call.member,
            flags: call.flags,
            args: &args,
            named: &named,
            value: value.as_ref(),
        });
        match &recorded.outcome {
            Outcome::Result(result) => Ok(decode(result, &self.state)),
            Outcome::End => Ok(Value::Null),
            Outcome::Error(_) => Err(error_of(&recorded.outcome).expect("an error outcome")),
        }
    }

    fn enum_open(&self) -> Result<Box<dyn ItemSource>, ComError> {
        Ok(Box::new(FakeEnum { id: self.id, state: self.state.clone() }))
    }

    fn same_object(&self, other: &dyn ComObject) -> bool {
        other.as_any().downcast_ref::<FakeObject>().is_some_and(|other| other.id == self.id)
    }

    fn identity_key(&self) -> String {
        format!("rcw:{}", self.id)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn log_id(&self) -> Option<u64> {
        Some(self.id)
    }
}

impl ItemSource for FakeEnum {
    fn next_item(&mut self) -> Result<Option<Value>, ComError> {
        let state = self.state.upgrade().expect("the fake was dropped while an enumeration of it is still used");
        let recorded = state.borrow_mut().take(&Probe { id: self.id, kind: Kind::EnumNext, member: "", flags: 0, args: &[], named: &[], value: None });
        match &recorded.outcome {
            Outcome::Result(result) => Ok(Some(decode(result, &self.state))),
            Outcome::End => Ok(None),
            Outcome::Error(_) => Err(error_of(&recorded.outcome).expect("an error outcome")),
        }
    }
}

impl Fake {
    /// A fake that replays `log`.
    pub fn new(log: CallLog) -> Fake {
        Fake { state: Rc::new(RefCell::new(State { entries: log.entries, allowances: log.allowances, position: 0, played: 0, ignore_boundaries: false })) }
    }

    /// A fake over a log's JSON lines. Panics on a log that does not parse.
    pub fn from_lines(source: &str) -> Fake {
        match CallLog::parse(source) {
            Ok(log) => Fake::new(log),
            Err(error) => panic!("{error}"),
        }
    }

    /// Calls meet boundary markers without failing: they are skipped.
    pub fn ignore_boundaries(&self) {
        self.state.borrow_mut().ignore_boundaries = true;
    }

    /// The object the recording's id names.
    pub fn object(&self, id: u64) -> Obj {
        make_object(id, &Rc::downgrade(&self.state))
    }

    /// Consumes the next recorded entry, which must be the boundary `kind` `name`.
    pub fn boundary(&self, kind: &str, name: &str) {
        let mut state = self.state.borrow_mut();
        let here = matches!(state.entries.get(state.position), Some(Entry::Boundary(boundary)) if boundary.kind == kind && boundary.name == name);
        if here {
            state.position += 1;
        } else {
            mismatch(&state, &format!("the port reached the boundary {kind} \"{name}\""), &format!("boundary {kind} \"{name}\""));
        }
    }

    /// How many calls were answered.
    pub fn calls_played(&self) -> usize {
        self.state.borrow().played
    }

    /// How many recorded calls were not played (boundary markers do not count).
    pub fn unplayed(&self) -> usize {
        let state = self.state.borrow();
        state.entries[state.position..].iter().filter(|entry| matches!(entry, Entry::Call(_))).count()
    }

    /// Fails unless every recorded call was played.
    pub fn finish(&self) {
        let state = self.state.borrow();
        let left: Vec<&Entry> = state.entries[state.position..].iter().filter(|entry| matches!(entry, Entry::Call(_))).collect();
        if let Some(first) = left.first() {
            panic!("call log: the port stopped with {} recorded calls unplayed; the next is {}", left.len(), describe_entry(first));
        }
    }
}

/// A clock for [`retry`](super::retry) that does not wait: it records the pauses asked of it.
#[derive(Default)]
pub struct ManualClock {
    pauses: RefCell<Vec<Duration>>,
    now: Cell<Duration>,
}

impl ManualClock {
    /// A clock at zero.
    pub fn new() -> ManualClock {
        ManualClock::default()
    }

    /// The pauses asked of the clock, in order.
    pub fn pauses(&self) -> Vec<Duration> {
        self.pauses.borrow().clone()
    }

    /// The time the pauses add up to.
    pub fn elapsed(&self) -> Duration {
        self.now.get()
    }
}

impl Pause for ManualClock {
    fn pause(&self, duration: Duration) {
        self.pauses.borrow_mut().push(duration);
        self.now.set(self.now.get() + duration);
    }
}
