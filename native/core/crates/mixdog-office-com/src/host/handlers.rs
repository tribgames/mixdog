//! What the host runs requests through. The loops of `oneshot.rs` and `session_loop.rs` are the protocol (what is read,
//! what is answered, what always runs at the end); the operations behind it are handlers, built on the host's apartment
//! thread inside its lane job and dropped, with every COM handle they hold, before the apartment is left.
//!
//! [`registered`] is the one place the operations are registered: the one-shot handler and the session handler. Until an
//! operation is registered it answers as the PowerShell host did for an action it does not know.

use std::any::Any;

use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;

use super::apartment::Apartment;
use super::emit::Emitter;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;

/// What a handler may use of the host it runs in.
#[derive(Clone, Copy)]
pub struct HostEnv<'a> {
    lane: &'a InLane<MaintenanceIo>,
    data_dir: Option<&'a std::path::Path>,
}

impl<'a> HostEnv<'a> {
    pub(super) fn new(lane: &'a InLane<MaintenanceIo>, data_dir: Option<&'a std::path::Path>) -> Self {
        Self { lane, data_dir }
    }

    /// The data directory the host keeps its record of the application under; none for a hand-started host.
    pub fn data_dir(&self) -> Option<&'a std::path::Path> {
        self.data_dir
    }

    /// The proof that the host's thread is a job of the maintenance lane: file work on the apartment thread (checkpoint
    /// copies, the DPI repair, the render size poll, deleting temporary files) goes through `mixdog-fsio` with it.
    pub fn lane(&self) -> &'a InLane<MaintenanceIo> {
        self.lane
    }
}

/// The one-shot host's operations (`office-com-host.ps1`'s `try` and `finally`).
pub trait OneShotHandler {
    /// Runs the request. `Ok` is the answer (one JSON line, exit code 0); `Err` is the exception's message (an error line,
    /// exit code 1).
    fn handle(&mut self, out: &mut Emitter, payload: &Value) -> Result<Value, String>;

    /// The `finally` block: closes the document, quits the application when it is empty, runs the chart Excel cleanup, and
    /// writes the failures with [`Emitter::cleanup_failure`]. It runs after the answer was written, whatever the answer was.
    fn finish(&mut self, out: &mut Emitter);
}

/// What `close_session` answered.
pub struct Closed {
    /// The answer, with its `cleanup`, `ok` and `closed`.
    pub result: Value,
    /// The cleanup succeeded and the state is gone: the host answers and ends.
    pub closed: bool,
}

/// The session host's operations (`office-com-session-host.ps1`'s `$state` and what the loop calls on it).
pub trait SessionHandler {
    /// `$state.Id`: `Some` while a session is open in this host.
    fn session_id(&self) -> Option<String>;

    /// `$state.AppPid`, for the error answer.
    fn app_pid(&self) -> Value;

    /// `open_session`: opens the session and keeps it as the state. It may write the early identity line (no `requestId`)
    /// before a blocking open.
    fn open(&mut self, out: &mut Emitter, payload: &Value) -> Result<Value, String>;

    /// `$state.ForegroundBeforeAction = ForegroundWindow()`: before every action of an open session.
    fn record_foreground(&mut self);

    /// Any other action of an open session (`Invoke-SessionAction`).
    fn action(&mut self, out: &mut Emitter, payload: &Value) -> Result<Value, String>;

    /// `close_session`: the save, the answer, `Close-SessionState`. A failed cleanup keeps the state.
    fn close(&mut self, out: &mut Emitter, payload: &Value) -> Result<Closed, String>;

    /// `Close-SessionState $state $false` at the end of the host (stdin's end or after the loop): the cleanup object, which
    /// the loop writes when it is not ok.
    fn end(&mut self) -> Result<Value, String>;
}

/// Enters the apartment; what it answers is dropped last (the real one is [`Apartment`], `CoUninitialize` on drop).
pub type ApartmentFactory = Box<dyn FnOnce() -> Result<Box<dyn Any>, String> + Send>;
/// Builds the one-shot handler on the apartment thread.
pub type OneShotFactory = Box<dyn for<'a> FnOnce(HostEnv<'a>) -> Box<dyn OneShotHandler + 'a> + Send>;
/// Builds the session handler on the apartment thread.
pub type SessionFactory = Box<dyn for<'a> FnOnce(HostEnv<'a>) -> Box<dyn SessionHandler + 'a> + Send>;

/// The parts a host is made of.
pub struct Handlers {
    pub apartment: ApartmentFactory,
    pub one_shot: OneShotFactory,
    pub session: SessionFactory,
}

/// The hosts' real parts: a single-threaded apartment and the registered operations.
pub fn registered() -> Handlers {
    Handlers {
        apartment: Box::new(|| Apartment::enter().map(|apartment| Box::new(apartment) as Box<dyn Any>)),
        one_shot: Box::new(unregistered_one_shot),
        session: Box::new(unregistered_session),
    }
}

fn unregistered_one_shot(_env: HostEnv<'_>) -> Box<dyn OneShotHandler + '_> {
    Box::new(Unregistered)
}

fn unregistered_session(_env: HostEnv<'_>) -> Box<dyn SessionHandler + '_> {
    Box::new(Unregistered)
}

/// The handler of an operation nobody registered: `throw "Unsupported Office host action: $($payload.action)"`.
struct Unregistered;

fn unsupported(payload: &Value) -> String {
    format!("Unsupported Office host action: {}", convert::to_ps_string(&payload::property(payload, "action")))
}

impl OneShotHandler for Unregistered {
    fn handle(&mut self, _out: &mut Emitter, payload: &Value) -> Result<Value, String> {
        Err(unsupported(payload))
    }

    fn finish(&mut self, _out: &mut Emitter) {}
}

impl SessionHandler for Unregistered {
    fn session_id(&self) -> Option<String> {
        None
    }

    fn app_pid(&self) -> Value {
        Value::Null
    }

    fn open(&mut self, _out: &mut Emitter, payload: &Value) -> Result<Value, String> {
        Err(unsupported(payload))
    }

    fn record_foreground(&mut self) {}

    fn action(&mut self, _out: &mut Emitter, payload: &Value) -> Result<Value, String> {
        Err(unsupported(payload))
    }

    fn close(&mut self, _out: &mut Emitter, payload: &Value) -> Result<Closed, String> {
        Err(unsupported(payload))
    }

    fn end(&mut self) -> Result<Value, String> {
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::super::emit::testing::emitter;
    use super::*;

    fn request(text: &str) -> Value {
        payload::parse_payload(text).expect("a request")
    }

    #[test]
    fn an_unregistered_action_is_unsupported_as_the_powershell_host_said() {
        let (mut out, _, _) = emitter();
        let mut handler = Unregistered;
        assert_eq!(
            OneShotHandler::handle(&mut handler, &mut out, &request("{\"action\":\"frobnicate\"}")).unwrap_err(),
            "Unsupported Office host action: frobnicate"
        );
        assert_eq!(
            OneShotHandler::handle(&mut handler, &mut out, &request("{}")).unwrap_err(),
            "Unsupported Office host action: "
        );
    }
}
