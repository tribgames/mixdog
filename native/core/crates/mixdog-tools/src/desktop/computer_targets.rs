//! A call's `app` resolved to the exact window it names before dispatch (`host/command-admission.ts:115-122`,
//! `input/targeting.ts:87-115` `resolveAppWindowId`), so every step of an `act` and the capture after it name that one window.

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::HelperFailure;
use super::computer_backend::ProcessComputerBackend;
use super::computer_command::text;
use super::computer_gnome::WindowRow;
use super::computer_gnome::window_rows;

/// The most candidates an ambiguity names (`matches.slice(0, 12)`).
const MAX_CANDIDATES: usize = 12;

/// Rewrites a command that names an `app` to the `window_id` it resolves to, for every action but `launch` (whose `app` is what
/// to start), `list_apps` (whose query it is) and `diagnose` (answered before targeting). A command with no `app` goes as it is.
pub(super) async fn resolve(backend: &ProcessComputerBackend, command: &mut Map<String, Value>, cancel: &CancellationToken) -> Result<(), ComputerError> {
    if matches!(text(command, "action"), "launch" | "list_apps" | "diagnose") {
        return Ok(());
    }
    let Some(app) = command.get("app").and_then(Value::as_str).filter(|app| !js_trim(app).is_empty()).map(str::to_owned) else {
        return Ok(());
    };
    let windows = match backend.host_read("list_windows", Vec::new(), None, cancel).await {
        Ok(result) => window_rows(&result),
        Err(ComputerError::Cancelled) => return Err(ComputerError::Cancelled),
        Err(_) => return Err(refusal("could not enumerate windows for app targeting")),
    };
    let window_id = match_app(&windows, &app).map_err(refusal)?;
    command.shift_remove("app");
    command.shift_remove("window");
    command.insert("window_id".into(), json!(window_id));
    Ok(())
}

/// The id of the one window `app` names: the windows whose app is exactly it, else those whose app, title or class contains it,
/// compared case-insensitively.
fn match_app(windows: &[WindowRow], app: &str) -> Result<String, String> {
    let requested = js_to_lowercase(js_trim(app));
    let exact: Vec<&WindowRow> = windows.iter().filter(|window| js_to_lowercase(&window.app) == requested).collect();
    let matches: Vec<&WindowRow> = if exact.is_empty() {
        windows
            .iter()
            .filter(|window| [&window.app, &window.title, &window.class_name].iter().any(|field| js_to_lowercase(field).contains(&requested)))
            .collect()
    } else {
        exact
    };
    match matches.as_slice() {
        [] => Err(format!("window_target_not_found: no visible window matched app \"{app}\"")),
        [only] => Ok(only.id.clone()),
        many => {
            let candidates = many
                .iter()
                .take(MAX_CANDIDATES)
                .map(|window| format!("{} \"{}\"", window.id, if window.title.is_empty() { "<untitled>" } else { &window.title }))
                .collect::<Vec<_>>()
                .join(" | ");
            Err(format!("ambiguous_window_target: app \"{app}\" matched {} windows ({candidates}); retry with one exact window_id", many.len()))
        }
    }
}

/// The host's refusal: the text, with the code it leads with.
fn refusal(text: impl Into<String>) -> ComputerError {
    HelperFailure { text: text.into(), result: None }.into_error()
}

#[cfg(test)]
pub(super) mod testing {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use async_trait::async_trait;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::process::ExitStatus;
    use mixdog_core_api::domain::process::KillReason;
    use mixdog_core_api::domain::process::OutputStream;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessEvent;
    use mixdog_core_api::domain::process::ProcessExit;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::ProcessManager;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnRequest;
    use mixdog_core_api::domain::process::SpawnedProcess;
    use mixdog_protocol::ProcessHandle;
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio::sync::mpsc::UnboundedSender;

    use super::super::computer_backend::RESPONSE_MARKER;
    use super::*;

    /// What the scripted helper answers one request line with: a `result`, or the text of a failure.
    type Answer = Box<dyn Fn(&Value) -> Result<Value, String> + Send + Sync>;

    struct Feed(UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Feed {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    /// A helper that answers each request line as the script says, with no OS process behind it: the backend's own launch, write
    /// and reply code runs on every platform. It keeps every request line and counts the resident helpers started (a cleanup run
    /// exits at once and is not counted).
    pub(crate) struct Scripted {
        answer: Answer,
        senders: Mutex<HashMap<String, UnboundedSender<ProcessEvent>>>,
        receivers: Mutex<HashMap<String, UnboundedReceiver<ProcessEvent>>>,
        seq: AtomicU64,
        starts: AtomicUsize,
        lines: Mutex<Vec<Value>>,
    }

    fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    impl Scripted {
        pub(crate) fn new(answer: impl Fn(&Value) -> Result<Value, String> + Send + Sync + 'static) -> Arc<Self> {
            Arc::new(Self {
                answer: Box::new(answer),
                senders: Mutex::default(),
                receivers: Mutex::default(),
                seq: AtomicU64::new(0),
                starts: AtomicUsize::new(0),
                lines: Mutex::default(),
            })
        }

        /// The resident helpers started.
        pub(crate) fn starts(&self) -> usize {
            self.starts.load(Ordering::SeqCst)
        }

        /// Every request line written, in order.
        pub(crate) fn lines(&self) -> Vec<Value> {
            locked(&self.lines).clone()
        }

        fn emit(&self, handle: &ProcessHandle, event: impl FnOnce(u64) -> ProcessEvent) {
            let seq = self.seq.fetch_add(1, Ordering::SeqCst);
            let sender = locked(&self.senders).get(&handle.0).cloned().expect("a spawned handle");
            sender.send(event(seq)).expect("the pump is listening");
        }

        fn exit(seq: u64, killed: Option<KillReason>) -> ProcessEvent {
            ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(0), killed } }
        }
    }

    #[async_trait]
    impl ProcessManager for Scripted {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            let (send, receive) = tokio::sync::mpsc::unbounded_channel();
            locked(&self.senders).insert(request.handle.0.clone(), send);
            locked(&self.receivers).insert(request.handle.0.clone(), receive);
            if request.stdin_piped {
                self.starts.fetch_add(1, Ordering::SeqCst);
            } else {
                self.emit(&request.handle, |seq| Self::exit(seq, None));
            }
            Ok(SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let receive = locked(&self.receivers).remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
            Ok(Box::new(Feed(receive)))
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let request: Value = serde_json::from_slice(&bytes).expect("a request line");
            locked(&self.lines).push(request.clone());
            let reply = match (self.answer)(&request) {
                Ok(result) => json!({"id": request["id"], "ok": true, "result": result}),
                Err(error) => json!({"id": request["id"], "ok": false, "error": error}),
            };
            self.emit(handle, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: format!("{RESPONSE_MARKER}{reply}\n").into_bytes() });
            Ok(())
        }

        fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Err(ProcessError::StdinClosed)
        }

        fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
            Err(ProcessError::NotPty)
        }

        fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.emit(handle, |seq| Self::exit(seq, Some(KillReason::Requested)));
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerRequest;

    use super::super::computer_backend::ComputerConfig;
    use super::testing::Scripted;
    use super::*;

    fn row(id: &str, app: &str, title: &str, class_name: &str) -> WindowRow {
        WindowRow { id: id.into(), focused: false, app: app.into(), title: title.into(), class_name: class_name.into() }
    }

    fn windows() -> Vec<WindowRow> {
        vec![
            row("hwnd:0x1", "notepad", "a.txt - Notepad", "Notepad"),
            row("hwnd:0x2", "chrome", "Docs - Chrome", "Chrome_WidgetWin_1"),
            row("hwnd:0x3", "chrome", "", "Chrome_WidgetWin_1"),
            row("hwnd:0x4", "code", "mixdog - Visual Studio Code", "Chrome_WidgetWin_1"),
        ]
    }

    /// An app that is exactly one window's app wins over contains-matches; else app, title or class that contains it, any case.
    #[test]
    fn an_app_resolves_to_the_one_window_it_names() {
        assert_eq!(match_app(&windows(), "  NotePad "), Ok("hwnd:0x1".into()), "exact, trimmed, any case");
        assert_eq!(match_app(&windows(), "visual studio"), Ok("hwnd:0x4".into()), "contained in a title");
        assert_eq!(match_app(&windows(), "a.txt"), Ok("hwnd:0x1".into()));
        assert_eq!(
            match_app(&windows(), "chrome"),
            Err("ambiguous_window_target: app \"chrome\" matched 2 windows (hwnd:0x2 \"Docs - Chrome\" | hwnd:0x3 \"<untitled>\"); retry with one exact window_id".into())
        );
        assert_eq!(match_app(&windows(), "Chrome_Widget").unwrap_err().matches("hwnd:").count(), 3, "class matches count");
        assert_eq!(match_app(&windows(), "calc"), Err("window_target_not_found: no visible window matched app \"calc\"".into()));
    }

    /// Only twelve candidates are named; the count is all of them.
    #[test]
    fn an_ambiguity_names_twelve_candidates() {
        let many: Vec<WindowRow> = (0..15).map(|n| row(&format!("hwnd:{n}"), "app", "t", "c")).collect();
        let error = match_app(&many, "app").unwrap_err();
        assert!(error.contains("matched 15 windows"), "{error}");
        assert_eq!(error.matches("hwnd:").count(), 12, "{error}");
    }

    fn backend(manager: &Arc<Scripted>) -> ProcessComputerBackend {
        ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone())
    }

    fn listing(request: &Value) -> Result<Value, String> {
        match request["action"].as_str() {
            Some("list_windows") => Ok(json!({"windows": [
                {"id": "hwnd:0x2", "app": "notepad", "title": "a.txt", "class_name": "Notepad"},
                {"id": "hwnd:0x3", "app": "calc", "title": "Calculator", "class_name": "CalcFrame"},
            ]})),
            _ => Ok(json!({"text": "ok"})),
        }
    }

    /// An `act` that names an app sends the window it resolves to on every step and on the capture after it, never the app.
    #[tokio::test]
    async fn an_act_on_an_app_sends_its_window_on_every_step() {
        let manager = Scripted::new(listing);
        let act = ComputerRequest {
            action: ComputerAction::Act,
            input: json!({"app": "Notepad", "actions": [{"type": "key", "keys": "a"}, {"type": "key", "keys": "b"}]}),
        };
        backend(&manager).run(act, CancellationToken::new()).await.unwrap();

        let sent = manager.lines();
        let steps: Vec<&Value> = sent.iter().filter(|line| line["action"] == "sequence_step").collect();
        assert_eq!(steps.len(), 2, "{sent:?}");
        assert!(steps.iter().all(|line| line["step"]["window_id"] == "hwnd:0x2"), "{sent:?}");
        let after: Vec<&Value> = sent.iter().filter(|line| matches!(line["action"].as_str(), Some("snapshot" | "window_capture"))).collect();
        assert!(!after.is_empty() && after.iter().all(|line| line["window_id"] == "hwnd:0x2"), "{sent:?}");
        assert!(sent.iter().all(|line| line.get("app").is_none() && line["step"].get("app").is_none()), "the app is resolved once: {sent:?}");
        assert_eq!(sent.iter().filter(|line| line["action"] == "list_windows").count(), 1, "once per call");
    }

    /// An app that matches no window is refused in the host's words before anything is sent to act on it.
    #[tokio::test]
    async fn an_app_that_names_no_single_window_is_refused() {
        let manager = Scripted::new(listing);
        let backend = backend(&manager);
        let focus = ComputerRequest { action: ComputerAction::Window, input: json!({"operation": "focus", "app": "paint"}) };

        assert_eq!(
            backend.run(focus, CancellationToken::new()).await,
            Err(ComputerError::Failed {
                code: "window_target_not_found".into(),
                message: "window_target_not_found: no visible window matched app \"paint\"".into()
            })
        );
        assert!(manager.lines().iter().all(|line| line["action"] == "list_windows"), "nothing but the list was sent");
    }

    /// `launch` keeps its `app` as it is: it names what to start, not a window.
    #[tokio::test]
    async fn a_launch_is_not_resolved() {
        let manager = Scripted::new(listing);
        let launch = ComputerRequest { action: ComputerAction::Launch, input: json!({"app": "notepad"}) };
        backend(&manager).run(launch, CancellationToken::new()).await.unwrap();
        let sent = manager.lines();
        // Nothing resolves the app before the launch is sent (the launch's own settle lists the windows afterwards).
        let launch = sent.iter().position(|line| line["action"] == "launch" && line["app"] == "notepad").expect("the launch was sent");
        assert!(sent[..launch].iter().all(|line| line["action"] != "list_windows"), "{sent:?}");
    }
}
