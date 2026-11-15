//! The operations the test host registers in place of Office's. A request says what the stand-in does in its `scenario`
//! object:
//!
//! - `hold`: how many handles the request acquires (each stands for a COM reference: `EVENT Acquire hN` when taken and
//!   `EVENT Release hN` when given back, on stderr);
//! - `fail`: the request fails with this message;
//! - `panic`: the request panics with this message;
//! - `cleanupFail`: the cleanup at the end reports a failure;
//! - `closeFails` (session): `close_session` reports an incomplete cleanup and keeps the state;
//! - `identity` (session): the open writes the early identity line before it answers.
//!
//! `EVENT Finish` / `EVENT EndCleanup` mark the cleanup of a one-shot host and of a session host, and the apartment the
//! test host enters writes `EVENT CoInitialize` and, when it is left, `EVENT CoUninitialize`.

use std::any::Any;
use std::io::Write;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;

use mixdog_office_com::host::Closed;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::host::Handlers;
use mixdog_office_com::host::HostEnv;
use mixdog_office_com::host::OneShotHandler;
use mixdog_office_com::host::SessionHandler;
use mixdog_office_com::ps::ObjectKind;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::convert;
use mixdog_office_com::ps::payload;

const BACKEND: &str = "microsoft-office-com";
const APP_PID: i32 = 4242;

/// One line of the test host's event log, on stderr.
pub fn event(text: &str) {
    let mut err = std::io::stderr().lock();
    let _ = write!(err, "EVENT {text}\r\n");
    let _ = err.flush();
}

/// A stand-in for a COM reference: its release is on the event log.
struct Handle(u32);

impl Handle {
    fn take() -> Handle {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let id = NEXT.fetch_add(1, Ordering::SeqCst) + 1;
        event(&format!("Acquire h{id}"));
        Handle(id)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        event(&format!("Release h{}", self.0));
    }
}

/// The stand-in for the apartment: `CoUninitialize` is the last event.
struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        event("CoUninitialize");
    }
}

fn enter_apartment() -> Result<Box<dyn Any>, String> {
    event("CoInitialize");
    Ok(Box::new(Apartment))
}

fn object(pairs: Vec<(&str, Value)>) -> Value {
    Value::object(ObjectKind::Ordered, pairs)
}

fn scenario(request: &Value, key: &str) -> Value {
    payload::property(&payload::property(request, "scenario"), key)
}

fn text(request: &Value, key: &str) -> String {
    convert::to_ps_string(&scenario(request, key))
}

fn flag(request: &Value, key: &str) -> bool {
    convert::to_bool(&scenario(request, key))
}

fn acquire(request: &Value) -> Vec<Handle> {
    let count = convert::to_int(&scenario(request, "hold")).unwrap_or(0);
    (0..count).map(|_| Handle::take()).collect()
}

/// What a request that is told to fail or panic does.
fn misbehave(request: &Value) -> Result<(), String> {
    if flag(request, "panic") {
        panic!("{}", text(request, "panic"));
    }
    match text(request, "fail") {
        message if message.is_empty() => Ok(()),
        message => Err(message),
    }
}

fn failed_cleanup(message: &str) -> Value {
    object(vec![("ok", Value::Bool(false)), ("errors", Value::Array(vec![Value::string(message)]))])
}

struct OneShot<'a> {
    _env: HostEnv<'a>,
    handles: Vec<Handle>,
    cleanup_fails: bool,
}

impl OneShotHandler for OneShot<'_> {
    fn handle(&mut self, _out: &mut Emitter, request: &Value) -> Result<Value, String> {
        self.handles = acquire(request);
        self.cleanup_fails = flag(request, "cleanupFail");
        misbehave(request)?;
        Ok(object(vec![
            ("ok", Value::Bool(true)),
            ("backend", Value::string(BACKEND)),
            ("action", payload::property(request, "action")),
        ]))
    }

    fn finish(&mut self, out: &mut Emitter) {
        event("Finish");
        self.handles.clear();
        if self.cleanup_fails {
            out.cleanup_failure(&failed_cleanup("Document close failed: scripted"));
        }
    }
}

struct State {
    id: String,
    handles: Vec<Handle>,
    cleanup_fails: bool,
}

struct Session<'a> {
    _env: HostEnv<'a>,
    state: Option<State>,
}

impl SessionHandler for Session<'_> {
    fn session_id(&self) -> Option<String> {
        self.state.as_ref().map(|state| state.id.clone())
    }

    fn app_pid(&self) -> Value {
        Value::Int(APP_PID)
    }

    fn open(&mut self, out: &mut Emitter, request: &Value) -> Result<Value, String> {
        let id = convert::to_ps_string(&payload::property(request, "session"));
        if flag(request, "identity") {
            out.line(&object(vec![
                ("session", Value::string(&id)),
                ("ok", Value::Bool(true)),
                ("ownership", Value::string("owned")),
                ("appPid", Value::Int(APP_PID)),
                ("lifecycle", Value::string("initializing")),
            ]));
        }
        let handles = acquire(request);
        self.state = Some(State { id: id.clone(), handles, cleanup_fails: flag(request, "cleanupFail") });
        misbehave(request)?;
        Ok(object(vec![
            ("ok", Value::Bool(true)),
            ("backend", Value::string(BACKEND)),
            ("opened", Value::Bool(true)),
            ("session", Value::String(id)),
            ("appPid", Value::Int(APP_PID)),
        ]))
    }

    fn record_foreground(&mut self) {}

    fn action(&mut self, _out: &mut Emitter, request: &Value) -> Result<Value, String> {
        misbehave(request)?;
        Ok(object(vec![
            ("ok", Value::Bool(true)),
            ("backend", Value::string(BACKEND)),
            ("action", payload::property(request, "action")),
        ]))
    }

    fn close(&mut self, _out: &mut Emitter, request: &Value) -> Result<Closed, String> {
        misbehave(request)?;
        if flag(request, "closeFails") {
            let cleanup = failed_cleanup("scripted");
            let result = object(vec![
                ("ok", Value::Bool(false)),
                ("closed", Value::Bool(false)),
                ("cleanup", cleanup),
                ("error", Value::string("Office cleanup incomplete: scripted")),
            ]);
            return Ok(Closed { result, closed: false });
        }
        self.state = None;
        let cleanup = object(vec![("ok", Value::Bool(true)), ("errors", Value::Array(Vec::new()))]);
        Ok(Closed { result: object(vec![("ok", Value::Bool(true)), ("closed", Value::Bool(true)), ("cleanup", cleanup)]), closed: true })
    }

    fn end(&mut self) -> Result<Value, String> {
        event("EndCleanup");
        let Some(state) = self.state.take() else { return Ok(Value::Null) };
        drop(state.handles);
        Ok(if state.cleanup_fails { failed_cleanup("Document close failed: scripted") } else { object(vec![("ok", Value::Bool(true))]) })
    }
}

fn one_shot(env: HostEnv<'_>) -> Box<dyn OneShotHandler + '_> {
    Box::new(OneShot { _env: env, handles: Vec::new(), cleanup_fails: false })
}

fn session(env: HostEnv<'_>) -> Box<dyn SessionHandler + '_> {
    Box::new(Session { _env: env, state: None })
}

/// The test host's parts: the scripted operations and an apartment that logs its entry and exit.
pub fn scripted() -> Handlers {
    Handlers { apartment: Box::new(enter_apartment), one_shot: Box::new(one_shot), session: Box::new(session) }
}

/// A Word session opened through the dispatch layer, for the live test: the host's apartment is the one the real
/// `Apartment` entered, and the cleanup at the end closes the document and quits the application when it is empty.
#[cfg(windows)]
pub mod live {
    use mixdog_office_com::com::Obj;
    use mixdog_office_com::com::Value as ComValue;
    use mixdog_office_com::com::live::create_object;
    use windows::Win32::System::Com::APTTYPE;
    use windows::Win32::System::Com::APTTYPEQUALIFIER;
    use windows::Win32::System::Com::CoGetApartmentType;

    use super::*;

    /// `CoGetApartmentType` of the calling thread (0 STA, 1 MTA, 2 NA, 3 main STA).
    fn apartment_type() -> i32 {
        let mut kind = APTTYPE::default();
        let mut qualifier = APTTYPEQUALIFIER::default();
        // SAFETY: both out parameters are valid for the call.
        match unsafe { CoGetApartmentType(&mut kind, &mut qualifier) } {
            Ok(()) => kind.0,
            Err(_) => -1,
        }
    }

    struct Word {
        app: Obj,
        document: Option<Obj>,
    }

    pub struct LiveSession<'a> {
        _env: HostEnv<'a>,
        id: Option<String>,
        word: Option<Word>,
    }

    fn obj_of(value: ComValue) -> Result<Obj, String> {
        value.into_obj().ok_or_else(|| "the application answered no object".to_owned())
    }

    impl SessionHandler for LiveSession<'_> {
        fn session_id(&self) -> Option<String> {
            self.id.clone()
        }

        fn app_pid(&self) -> Value {
            Value::Int(0)
        }

        fn open(&mut self, _out: &mut Emitter, request: &Value) -> Result<Value, String> {
            let id = convert::to_ps_string(&payload::property(request, "session"));
            let app = create_object("Word.Application").map_err(|error| error.message.clone())?;
            self.id = Some(id.clone());
            self.word = Some(Word { app, document: None });
            let word = self.word.as_mut().expect("just set");
            word.app.put("Visible", ComValue::Bool(false)).map_err(|error| error.to_string())?;
            let documents = obj_of(word.app.get("Documents").map_err(|error| error.to_string())?)?;
            word.document = Some(obj_of(documents.call("Add", &[]).map_err(|error| error.to_string())?)?);
            Ok(object(vec![
                ("ok", Value::Bool(true)),
                ("backend", Value::string(BACKEND)),
                ("opened", Value::Bool(true)),
                ("session", Value::String(id)),
                ("apartmentType", Value::Int(apartment_type())),
            ]))
        }

        fn record_foreground(&mut self) {}

        fn action(&mut self, _out: &mut Emitter, request: &Value) -> Result<Value, String> {
            if flag(request, "busy") {
                // A call that keeps the host busy while stdin is closed: the cleanup must wait for it.
                let word = self.word.as_ref().ok_or("no application")?;
                for _ in 0..30 {
                    word.app.get("Name").map_err(|error| error.to_string())?;
                }
            }
            Ok(object(vec![("ok", Value::Bool(true)), ("apartmentType", Value::Int(apartment_type()))]))
        }

        fn close(&mut self, _out: &mut Emitter, _request: &Value) -> Result<Closed, String> {
            let cleanup = self.end()?;
            let ok = convert::to_bool(&payload::property(&cleanup, "ok"));
            Ok(Closed { result: object(vec![("ok", Value::Bool(ok)), ("closed", Value::Bool(ok)), ("cleanup", cleanup)]), closed: ok })
        }

        fn end(&mut self) -> Result<Value, String> {
            let Some(word) = self.word.take() else { return Ok(Value::Null) };
            let mut errors = Vec::new();
            if let Some(document) = &word.document {
                if let Err(error) = document.call("Close", &[ComValue::I4(0)]) {
                    errors.push(Value::String(format!("Document close failed: {error}")));
                }
            }
            let empty = word
                .app
                .get("Documents")
                .ok()
                .and_then(ComValue::into_obj)
                .and_then(|documents| documents.count().ok())
                .is_some_and(|count| count == 0);
            if empty {
                if let Err(error) = word.app.call("Quit", &[]) {
                    errors.push(Value::String(format!("Application quit failed: {error}")));
                }
            }
            drop(word);
            self.id = None;
            let ok = errors.is_empty();
            Ok(object(vec![("ok", Value::Bool(ok)), ("errors", Value::Array(errors))]))
        }
    }

    fn live_session(env: HostEnv<'_>) -> Box<dyn SessionHandler + '_> {
        Box::new(LiveSession { _env: env, id: None, word: None })
    }

    /// The real apartment of the host with the live Word session.
    pub fn handlers() -> Handlers {
        let real = mixdog_office_com::host::handlers::registered();
        Handlers { apartment: real.apartment, one_shot: Box::new(super::one_shot), session: Box::new(live_session) }
    }
}
