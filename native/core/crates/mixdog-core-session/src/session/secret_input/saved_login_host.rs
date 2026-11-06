//! The production [`SavedLoginVault`] of a Computer Use saved-login fill: one host method on
//! `host/browser/command` (`saved_login_admit`, `saved_login_value`, `saved_login_release`; the desktop
//! side is `apps/desktop/src/main/browser/saved-login-host.ts`).
//!
//! The desktop keeps the vault and the Auto login setting. For one fill it admits the fill (the core's
//! session and agent turn), answers the exact-origin lookup of the account's value only for an admitted
//! fill, and forgets the admission when the turn settles. The value comes to the core once per lookup;
//! this type holds none of it (no field can): the caller owns the [`SavedLoginValue`], which wipes
//! itself when dropped, and the registry keeps only the redaction spellings.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::desktop::host::BROWSER_UNAVAILABLE;
use mixdog_tools::desktop::host::HostCommandError;
use mixdog_tools::desktop::host::HostCommands;
use serde_json::Value;
use serde_json::json;

use super::ComputerCommands;
use super::saved_login::SavedLoginField;
use super::saved_login::SavedLoginValue;
use super::saved_login::SavedLoginVault;
use super::saved_login::SavedLoginWorker;
use super::saved_login::SavedLogins;
use super::saved_login::WindowPids;
use super::saved_login::wipe;
use super::saved_login::wipe_json;

/// One fill's view of the desktop's saved logins: its host, the session, the agent turn and what the
/// desktop last said about Auto login.
pub struct HostSavedLogins {
    host: Arc<dyn HostCommands>,
    thread: ThreadId,
    turn: u64,
    enabled: AtomicBool,
}

fn failure(error: HostCommandError) -> String {
    match error {
        HostCommandError::NoHost => BROWSER_UNAVAILABLE.to_owned(),
        HostCommandError::Cancelled => "saved login request cancelled".to_owned(),
        HostCommandError::Rpc { message, .. } if mixdog_js::js_trim(&message).is_empty() => "saved login request failed".to_owned(),
        HostCommandError::Rpc { message, .. } => message,
    }
}

impl HostSavedLogins {
    /// Asks the desktop to admit this fill; it answers whether Auto login is on (an off setting admits
    /// nothing, and every later lookup is refused).
    pub async fn admit(host: Arc<dyn HostCommands>, thread: ThreadId, turn: u64) -> Result<Self, String> {
        let reply = host.browser(&thread, "saved_login_admit", json!({ "turn_id": turn }), &mixdog_rt::CancellationToken::new()).await.map_err(failure)?;
        let enabled = reply.get("enabled") == Some(&Value::Bool(true));
        Ok(Self { host, thread, turn, enabled: AtomicBool::new(enabled) })
    }

    /// The fill's turn settled: the desktop ends its admission (and those of older turns of the session).
    pub async fn release(&self) {
        // Nothing to undo when the desktop is gone: its admissions went with it.
        let _ = self.host.browser(&self.thread, "saved_login_release", json!({ "turn_id": self.turn }), &mixdog_rt::CancellationToken::new()).await;
    }
}

impl HostSavedLogins {
    /// The worker steps of this fill on the desktop's computer host: `account` and `window_id` are the
    /// fill command's (the saved login to use, the exact browser window).
    pub fn worker(&self, account: &str, window_id: &str) -> HostSavedLoginWorker {
        HostSavedLoginWorker { host: self.host.clone(), thread: self.thread.clone(), turn: self.turn, account: account.to_owned(), window_id: window_id.to_owned() }
    }
}

/// The Windows worker of a fill (`saved_login_check`, `saved_login_type`), run by the desktop through its
/// computer host's own dispatch (`saved-login-host.ts`): the worker's response comes back as it is. A host
/// that fails or refuses is the call's error text, as a thrown error is in Node.
pub struct HostSavedLoginWorker {
    host: Arc<dyn HostCommands>,
    thread: ThreadId,
    turn: u64,
    account: String,
    window_id: String,
}

#[async_trait]
impl SavedLoginWorker for HostSavedLoginWorker {
    async fn call(&self, request: &Value, before_send: Option<&mut (dyn FnMut() -> Result<(), String> + Send)>) -> Result<Value, String> {
        let action = match request.get("action").and_then(Value::as_str) {
            Some(action @ ("saved_login_check" | "saved_login_type")) => action,
            other => return Err(format!("saved login worker has no step {other:?}")),
        };
        let mut input = json!({ "turn_id": self.turn, "window_id": self.window_id, "account": self.account, "field": request.get("field").cloned().unwrap_or(Value::Null) });
        if action == "saved_login_type" {
            input["text"] = request.get("text").cloned().unwrap_or(Value::Null);
            input["expected"] = request.get("expected").cloned().unwrap_or(Value::Null);
        }
        // The last core-side check, with no await between it and the request leaving.
        if let Some(before_send) = before_send {
            before_send()?;
        }
        self.host.browser(&self.thread, action, input, &mixdog_rt::CancellationToken::new()).await.map_err(failure)
    }
}

/// The process of a window, read from the computer helper's window list (`list_windows`, whose records carry
/// `id` and `pid`), as the capture gate needs it (`readWindowOwnerPid`).
pub struct HelperWindowPids {
    commands: Arc<dyn ComputerCommands>,
    thread: ThreadId,
}

impl HelperWindowPids {
    pub fn new(commands: Arc<dyn ComputerCommands>, thread: ThreadId) -> Self {
        Self { commands, thread }
    }
}

#[async_trait]
impl WindowPids for HelperWindowPids {
    async fn window_pid(&self, window_id: &str) -> Result<Option<String>, String> {
        let reply = self.commands.execute(&self.thread, json!({ "action": "list_windows", "session_id": self.thread.as_str() })).await?;
        let wanted = window_id.to_lowercase();
        let owner = reply.get("windows").and_then(Value::as_array).and_then(|windows| windows.iter().find(|window| mixdog_js::value_to_string(window.get("id").unwrap_or(&Value::Null)).to_lowercase() == wanted));
        // `owner?.pid ? String(owner.pid) : undefined`
        Ok(owner.and_then(|window| window.get("pid")).filter(|pid| !matches!(pid, Value::Null | Value::Bool(false)) && pid.as_f64() != Some(0.0) && pid.as_str() != Some("")).map(mixdog_js::value_to_string))
    }
}

impl SavedLogins for HostSavedLogins {
    fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    fn vault(&self) -> &dyn SavedLoginVault {
        self
    }
}

#[async_trait]
impl SavedLoginVault for HostSavedLogins {
    async fn value(&self, url: &str, account: &str, field: SavedLoginField) -> Result<SavedLoginValue, String> {
        let input = json!({ "turn_id": self.turn, "origin": url, "account": account, "field": field.as_str() });
        let mut reply = self.host.browser(&self.thread, "saved_login_value", input, &mixdog_rt::CancellationToken::new()).await.map_err(failure)?;
        let malformed = || "saved login answer is malformed".to_owned();
        // Auto login read at the desktop, with each answer.
        self.enabled.store(reply.get("enabled") == Some(&Value::Bool(true)), Ordering::SeqCst);
        let text = |reply: &mut Value, key: &str| match reply.get_mut(key).map(Value::take) {
            Some(Value::String(text)) => Some(text),
            _ => None,
        };
        let found = (text(&mut reply, "value"), text(&mut reply, "label"), text(&mut reply, "origin"));
        // Whatever else the reply held is not the core's to keep.
        wipe_json(&mut reply);
        match found {
            (Some(value), Some(label), Some(origin)) => Ok(SavedLoginValue { value, label, origin }),
            (Some(mut value), _, _) => {
                wipe(&mut value);
                Err(malformed())
            }
            _ => Err(malformed()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_protocol::JsonValue;

    use super::super::saved_login::FillContext;
    use super::super::saved_login::SavedLoginRegistry;
    use super::super::saved_login::SavedLoginTurn;
    use super::super::saved_login::SavedLoginWorker;
    use super::super::saved_login::fill_saved_login;
    use super::*;

    const PASSWORD: &str = "Pa55-\"word\"\\x";
    const SESSION: &str = "S1";

    /// The desktop: it answers the three actions the way `saved-login-host.ts` does and keeps every
    /// call it was sent.
    struct Desktop {
        calls: Mutex<Vec<(String, JsonValue)>>,
        auto_login: Mutex<bool>,
        refuse: Option<HostCommandError>,
    }

    impl Desktop {
        fn new() -> Arc<Self> {
            Arc::new(Self { calls: Mutex::new(Vec::new()), auto_login: Mutex::new(true), refuse: None })
        }
        fn actions(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|(action, _)| action.clone()).collect()
        }
    }

    #[async_trait]
    impl HostCommands for Desktop {
        async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
            assert_eq!(thread.as_str(), SESSION);
            self.calls.lock().unwrap().push((action.to_owned(), input));
            if let Some(error) = &self.refuse {
                return Err(error.clone());
            }
            let on = *self.auto_login.lock().unwrap();
            Ok(match action {
                "saved_login_admit" => json!({ "enabled": on }),
                "saved_login_release" => json!({ "released": true }),
                "saved_login_check" => json!({ "ok": true, "result": { "saved_login_target": { "window_id": "hwnd:0x1", "pid": "4242", "origin": "https://login.example.com" } } }),
                "saved_login_type" => json!({ "ok": true, "result": { "action": "fill_saved_login", "effect": "confirmed" } }),
                _ => json!({ "enabled": on, "value": PASSWORD, "label": "j•••e@example.com", "origin": "https://login.example.com" }),
            })
        }
        async fn visualize(&self, _: &ThreadId, _: &str, _: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
            unreachable!("a saved login asks the browser host only")
        }
    }

    /// The worker proves the page and writes whatever it is sent.
    struct Worker(Mutex<Vec<Value>>);

    #[async_trait]
    impl SavedLoginWorker for Worker {
        async fn call(&self, request: &Value, before_send: Option<&mut (dyn FnMut() -> Result<(), String> + Send)>) -> Result<Value, String> {
            if let Some(before_send) = before_send {
                before_send()?;
            }
            self.0.lock().unwrap().push(request.clone());
            if request["action"] == "saved_login_check" {
                Ok(json!({ "ok": true, "result": { "saved_login_target": { "window_id": "hwnd:0x1", "pid": "4242", "origin": "https://login.example.com" } } }))
            } else {
                Ok(json!({ "ok": true, "result": { "action": "fill_saved_login", "effect": "confirmed" } }))
            }
        }
    }

    fn command() -> Value {
        json!({ "action": "fill_saved_login", "session_id": SESSION, "window_id": "hwnd:0x1", "saved_account": "j•••e@example.com", "field": "password", "turn_id": 7, "runtime_id": "core" })
    }

    async fn fill(desktop: &Arc<Desktop>, registry: &Arc<SavedLoginRegistry>) -> (Result<Value, String>, Arc<Worker>) {
        let logins = HostSavedLogins::admit(desktop.clone(), ThreadId::from(SESSION), 7).await.unwrap();
        let worker = Arc::new(Worker(Mutex::new(Vec::new())));
        let turn = SavedLoginTurn { session: SESSION.to_owned(), turn: 7 };
        let admitted = registry.admit(&turn).unwrap();
        let hide = |text: &str| registry.redact(text);
        let runnable = || Ok(());
        let context = FillContext { registry, windows: true, assert_runnable: &runnable, redact: &hide };
        let outcome = fill_saved_login(&command(), &logins, &*worker, &context).await;
        drop(admitted);
        logins.release().await;
        (outcome, worker)
    }

    /// The password comes to the core for the one write and is not kept: the desktop is asked
    /// admit -> value -> release with no value in any request, the only copy left in the core is the
    /// registry's redaction spellings, and those go with the turn.
    #[tokio::test]
    async fn the_password_is_fetched_for_the_write_and_kept_only_as_redaction_spellings() {
        let desktop = Desktop::new();
        let registry = SavedLoginRegistry::new();
        let (outcome, worker) = fill(&desktop, &registry).await;
        let reply = outcome.unwrap();
        assert!(reply["result"]["text"].as_str().unwrap().starts_with("filled the saved password of j•••e@example.com"));
        assert_eq!(desktop.actions(), ["saved_login_admit", "saved_login_value", "saved_login_release"]);
        let calls = desktop.calls.lock().unwrap().clone();
        assert_eq!(calls[0].1, json!({ "turn_id": 7 }));
        assert_eq!(calls[1].1, json!({ "turn_id": 7, "origin": "https://login.example.com", "account": "j•••e@example.com", "field": "password" }));
        assert!(calls.iter().all(|(_, input)| !input.to_string().contains(PASSWORD)), "no request to the desktop carries the value");
        // The one write carried it, and nothing else of the worker's traffic did.
        let sent = worker.0.lock().unwrap().clone();
        assert_eq!(sent.iter().filter(|request| request["text"] == PASSWORD).count(), 1);
        // What the core still holds is the redaction: the registry's spellings, nothing else.
        assert_eq!(registry.redact(&format!("x {PASSWORD} y")), "x [saved login] y");
        assert_eq!(registry.spellings(), [PASSWORD.to_owned(), serde_json::to_string(PASSWORD).unwrap().trim_matches('"').to_owned()]);
        // The turn settles: not even the spellings are left.
        registry.settle(&SavedLoginTurn { session: SESSION.to_owned(), turn: 7 }).await;
        assert!(registry.spellings().is_empty());
        assert_eq!(registry.redact(&format!("x {PASSWORD} y")), format!("x {PASSWORD} y"));
    }

    #[tokio::test]
    async fn auto_login_off_at_the_desktop_stops_the_fill_before_any_lookup() {
        let desktop = Desktop::new();
        *desktop.auto_login.lock().unwrap() = false;
        let registry = SavedLoginRegistry::new();
        let (outcome, worker) = fill(&desktop, &registry).await;
        assert_eq!(outcome.unwrap_err(), "saved_login_unavailable: Auto login is off in Settings (인증 관리); no input was sent");
        assert_eq!(desktop.actions(), ["saved_login_admit", "saved_login_release"]);
        assert!(worker.0.lock().unwrap().is_empty());
        assert!(registry.spellings().is_empty());
    }

    #[tokio::test]
    async fn a_desktop_that_is_gone_or_refuses_is_an_error_text_and_a_malformed_answer_keeps_nothing() {
        let gone = Arc::new(Desktop { calls: Mutex::new(Vec::new()), auto_login: Mutex::new(true), refuse: Some(HostCommandError::NoHost) });
        assert_eq!(HostSavedLogins::admit(gone, ThreadId::from(SESSION), 7).await.err().unwrap(), BROWSER_UNAVAILABLE);
        let refusing = Arc::new(Desktop { calls: Mutex::new(Vec::new()), auto_login: Mutex::new(true), refuse: Some(HostCommandError::Rpc { code: -32000, message: "no saved login for this origin".into(), timing: None }) });
        assert_eq!(HostSavedLogins::admit(refusing, ThreadId::from(SESSION), 7).await.err().unwrap(), "no saved login for this origin");
        // A lookup answer without the label and origin is no value.
        struct Odd;
        #[async_trait]
        impl HostCommands for Odd {
            async fn browser(&self, _: &ThreadId, action: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
                Ok(if action == "saved_login_admit" { json!({ "enabled": true }) } else { json!({ "enabled": true, "value": "v" }) })
            }
            async fn visualize(&self, _: &ThreadId, _: &str, _: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
                unreachable!()
            }
        }
        let logins = HostSavedLogins::admit(Arc::new(Odd), ThreadId::from(SESSION), 7).await.unwrap();
        assert_eq!(logins.vault().value("https://login.example.com", "a", SavedLoginField::Password).await.err().unwrap(), "saved login answer is malformed");
    }

    #[test]
    fn a_wiped_value_is_zeros_and_a_request_loses_every_string() {
        let mut text = String::from("Pa55-word");
        assert_eq!(super::super::saved_login::zeroed(&mut text), vec![0u8; 9]);
        assert!(text.is_empty());
        let mut request = json!({ "text": "secret", "nested": [{ "k": "also" }], "n": 3 });
        wipe_json(&mut request);
        assert_eq!(request, json!({ "text": "", "nested": [{ "k": "" }], "n": 3 }));
    }

    /// The whole fill over the desktop alone: admit, the check, the one lookup, the one write, release. The
    /// value is in the lookup's answer and the write's request, nowhere else.
    #[tokio::test]
    async fn a_fill_runs_every_step_on_the_desktop_in_nodes_order() {
        let desktop = Desktop::new();
        let registry = SavedLoginRegistry::new();
        let logins = HostSavedLogins::admit(desktop.clone(), ThreadId::from(SESSION), 7).await.unwrap();
        let worker = logins.worker("j•••e@example.com", "hwnd:0x1");
        let admitted = registry.admit(&SavedLoginTurn { session: SESSION.to_owned(), turn: 7 }).unwrap();
        let hide = |text: &str| registry.redact(text);
        let runnable = || Ok(());
        let context = FillContext { registry: &registry, windows: true, assert_runnable: &runnable, redact: &hide };
        let reply = fill_saved_login(&command(), &logins, &worker, &context).await.unwrap();
        drop(admitted);
        logins.release().await;
        assert_eq!(reply["result"]["saved_login"], json!({ "account": "j•••e@example.com", "origin": "https://login.example.com", "field": "password" }));
        assert_eq!(desktop.actions(), ["saved_login_admit", "saved_login_check", "saved_login_value", "saved_login_type", "saved_login_release"]);
        let calls = desktop.calls.lock().unwrap().clone();
        let target = json!({ "window_id": "hwnd:0x1", "pid": "4242", "origin": "https://login.example.com" });
        assert_eq!(calls[1].1, json!({ "turn_id": 7, "window_id": "hwnd:0x1", "account": "j•••e@example.com", "field": "password" }));
        assert_eq!(calls[3].1, json!({ "turn_id": 7, "window_id": "hwnd:0x1", "account": "j•••e@example.com", "field": "password", "text": PASSWORD, "expected": target }));
        let escaped = serde_json::to_string(PASSWORD).unwrap();
        let spelled = &escaped[1..escaped.len() - 1];
        assert_eq!(calls.iter().filter(|(_, input)| input.to_string().contains(spelled)).count(), 1, "only the write carries the value");
    }

    #[tokio::test]
    async fn the_worker_stops_before_sending_when_the_last_core_check_refuses_and_unknown_steps_are_errors() {
        let desktop = Desktop::new();
        let logins = HostSavedLogins::admit(desktop.clone(), ThreadId::from(SESSION), 7).await.unwrap();
        let worker = logins.worker("a", "w1");
        let mut refuse = || -> Result<(), String> { Err("Auto login is off".to_owned()) };
        let request = json!({ "action": "saved_login_type", "field": "password", "text": "pw", "expected": {} });
        assert_eq!(worker.call(&request, Some(&mut refuse)).await.unwrap_err(), "Auto login is off");
        assert_eq!(desktop.actions(), ["saved_login_admit"], "nothing was sent");
        assert!(worker.call(&json!({ "action": "type" }), None).await.unwrap_err().contains("no step"));
        let failing = Arc::new(Desktop { calls: Mutex::new(Vec::new()), auto_login: Mutex::new(true), refuse: Some(HostCommandError::NoHost) });
        let broken = HostSavedLoginWorker { host: failing, thread: ThreadId::from(SESSION), turn: 7, account: "a".into(), window_id: "w1".into() };
        assert_eq!(broken.call(&json!({ "action": "saved_login_check", "field": "password" }), None).await.unwrap_err(), BROWSER_UNAVAILABLE);
    }

    /// The computer helper: it keeps what it was asked and lists windows as the host's reads do.
    struct Helper(Mutex<Vec<Value>>, Result<Value, String>);

    #[async_trait]
    impl ComputerCommands for Helper {
        async fn execute(&self, _: &ThreadId, command: Value) -> Result<Value, String> {
            self.0.lock().unwrap().push(command);
            self.1.clone()
        }
    }

    fn windows(list: Value) -> Arc<Helper> {
        Arc::new(Helper(Mutex::new(Vec::new()), Ok(json!({ "windows": list }))))
    }

    #[tokio::test]
    async fn a_windows_process_is_read_from_the_helpers_window_list() {
        let helper = windows(json!([{ "id": "HWND:0x1", "pid": 4242 }, { "id": "hwnd:0x2", "pid": "77" }, { "id": "hwnd:0x3", "pid": 0 }, { "id": "hwnd:0x4", "pid": "" }, { "id": "hwnd:0x5" }]));
        let pids = HelperWindowPids::new(helper.clone(), ThreadId::from(SESSION));
        assert_eq!(pids.window_pid("hwnd:0x1").await, Ok(Some("4242".to_owned())));
        assert_eq!(pids.window_pid("hwnd:0x2").await, Ok(Some("77".to_owned())));
        for unreadable in ["hwnd:0x3", "hwnd:0x4", "hwnd:0x5", "hwnd:0x9"] {
            assert_eq!(pids.window_pid(unreadable).await, Ok(None), "{unreadable}");
        }
        assert_eq!(helper.0.lock().unwrap()[0], json!({ "action": "list_windows", "session_id": SESSION }));
        let failing = HelperWindowPids::new(Arc::new(Helper(Mutex::new(Vec::new()), Err("helper gone".to_owned()))), ThreadId::from(SESSION));
        assert_eq!(failing.window_pid("hwnd:0x1").await, Err("helper gone".to_owned()));
    }

    /// The capture gate over the helper's list: another window of the guarded browser process is withheld.
    #[tokio::test]
    async fn the_capture_gate_reads_the_process_of_a_window_through_the_helper() {
        let registry = SavedLoginRegistry::new();
        assert!(registry.arm_pixels(super::super::saved_login::PixelGuard { turn: SavedLoginTurn { session: SESSION.to_owned(), turn: 7 }, window_id: "hwnd:0x1".to_owned(), pid: "4242".to_owned() }));
        let pids = HelperWindowPids::new(windows(json!([{ "id": "hwnd:0x1", "pid": 4242 }, { "id": "hwnd:0x2", "pid": 4242 }, { "id": "hwnd:0x3", "pid": 99 }])), ThreadId::from(SESSION));
        assert!(super::super::saved_login::pixels_allowed(&registry, "screen", "hwnd:0x2", &pids).await.unwrap_err().starts_with("capture_withheld"));
        assert!(super::super::saved_login::pixels_allowed(&registry, "screen", "hwnd:0x3", &pids).await.is_ok());
        assert!(super::super::saved_login::pixels_allowed(&registry, "ax", "hwnd:0x2", &pids).await.is_ok());
    }
}