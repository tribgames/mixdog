//! `diagnose` (`observation/inspect.ts` `diagnoseComputer`): the report of the windows, accessibility, OCR, input observation and,
//! where the desktop serves them, the displays, on every platform; a Linux session adds the probed capabilities as permissions.

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ToolPart;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::ProcessComputerBackend;
use super::computer_command::text;
use super::computer_gnome;

/// `ACCESSIBILITY_GUIDANCE` and `SCREEN_RECORDING_GUIDANCE` (`shared/permissions.ts`).
const ACCESSIBILITY_GUIDANCE: &str = "macOS Accessibility is not granted to Mixdog; allow Mixdog in System Settings > Privacy & Security > Accessibility";
const SCREEN_RECORDING_GUIDANCE: &str = "macOS Screen Recording is not granted to Mixdog; allow Mixdog in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen Mixdog (a grant made while Mixdog runs applies only after it restarts)";

/// `accessibilityBlocked` and `screenCaptureBlocked` (`MACOS_GRANT_REQUIRED`): a grant the system says is still to be given.
fn grant_required(permissions: &Value, key: &str) -> bool {
    matches!(permissions.get(key).and_then(Value::as_str), Some("not-determined" | "denied" | "restricted"))
}

/// The report with the guidance a missing macOS grant earns (`diagnoseIssues`): Accessibility names the grant in place of the
/// accessibility probe's own restatement of it, Screen Recording follows the other issues.
fn name_missing_grants(report: &mut Value, permissions: &Value) {
    let Some(mut issues) = report.get("issues").and_then(Value::as_array).cloned() else { return };
    if grant_required(permissions, "accessibility") {
        let restated = report
            .pointer("/capabilities/semantic_accessibility")
            .filter(|probe| probe.get("available") == Some(&json!(false)))
            .map(|probe| probe.get("reason").and_then(Value::as_str).filter(|reason| !reason.is_empty()).unwrap_or("accessibility unavailable").to_owned());
        match restated.and_then(|reason| issues.iter().position(|issue| issue.as_str() == Some(reason.as_str()))) {
            Some(at) => issues[at] = json!(ACCESSIBILITY_GUIDANCE),
            None => {
                let at = issues.iter().position(|issue| issue.as_str().is_some_and(|text| text.starts_with("OCR language is unavailable"))).unwrap_or(issues.len());
                issues.insert(at, json!(ACCESSIBILITY_GUIDANCE));
            }
        }
    }
    if grant_required(permissions, "screen_capture") {
        issues.push(json!(SCREEN_RECORDING_GUIDANCE));
    }
    report["issues"] = Value::Array(issues);
}

/// `host/computer/permissions`: the grants as the desktop reads them, in the report's own field names (`ComputerPermissions`).
fn grants(answer: &Value) -> Option<Value> {
    let word = |key: &str| answer.get(key).and_then(Value::as_str).map(|word| json!(word));
    let mut grants = serde_json::Map::new();
    grants.insert("screen_capture".into(), word("screenCapture")?);
    grants.insert("accessibility".into(), word("accessibility")?);
    grants.insert("input".into(), word("input")?);
    if let Some(linux) = answer.get("linux").filter(|linux| !linux.is_null()) {
        grants.insert("linux".into(), linux.clone());
    }
    Some(Value::Object(grants))
}

/// Node's `process.platform` of the machine this process runs on.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

impl ProcessComputerBackend {
    /// Every command of the host starts with a read of the windows through its arrivals worker; the answer is not used here.
    async fn peek_arrivals(&self, cancel: &CancellationToken) -> Result<(), ComputerError> {
        match self.host_read("window_snapshot", Vec::new(), Some(computer_gnome::ARRIVALS_SESSION_ID), cancel).await {
            Err(ComputerError::Cancelled) => Err(ComputerError::Cancelled),
            _ => Ok(()),
        }
    }

    /// `diagnose`: each probe answers in place, a failure is a finding and never an error out of the call (`diagnose-probes.ts`).
    pub(super) async fn diagnose(&self, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        self.peek_arrivals(cancel).await?;
        let probe = |outcome: Result<Map<String, Value>, ComputerError>| match outcome {
            Err(ComputerError::Cancelled) => Err(ComputerError::Cancelled),
            Err(ComputerError::Failed { message, .. }) => Ok(Err(message)),
            Err(other) => Ok(Err(format!("{other:?}"))),
            Ok(result) => Ok(Ok(result)),
        };
        let windows = match self.host_read("list_windows", Vec::new(), None, cancel).await {
            Ok(result) => Some(computer_gnome::window_rows(&result)),
            Err(ComputerError::Cancelled) => return Err(ComputerError::Cancelled),
            Err(_) => None,
        };
        let requested = text(command, "window_id").to_owned();
        let target = match &windows {
            Some(windows) if requested.is_empty() => windows.iter().find(|window| window.focused),
            Some(windows) => windows.iter().find(|window| window.id == requested),
            None => None,
        };
        let accessibility = match target {
            Some(target) => Some(probe(self.host_read("accessibility_probe", vec![("window_id", json!(target.id))], None, cancel).await)?),
            None => None,
        };
        let ocr_language = command.get("ocr_language").and_then(Value::as_str);
        // Node always names the language, null when none was asked (`diagnose-probes.ts` `probeOcr`).
        let ocr_extra = vec![("ocr_language", json!(ocr_language))];
        let ocr = probe(self.host_read("ocr_status", ocr_extra, None, cancel).await)?;
        let input = probe(self.host_read("input_idle_state", Vec::new(), None, cancel).await)?;
        let (platform, permissions, displays) = match &self.linux {
            Some(linux) => {
                let readiness = computer_gnome::readiness(self.manager.clone(), (linux.env)()).await;
                let displays = self.ask_desktop("host/computer/displays", json!({}), cancel).await?;
                ("linux", Some(computer_gnome::linux_permissions(&readiness)), Some(displays))
            }
            // Where a desktop serves Computer its displays and the grants it reads are reported; a run without one leaves them out.
            None => {
                let displays = self.ask_desktop("host/computer/displays", json!({}), cancel).await;
                let permissions = self.ask_desktop("host/computer/permissions", json!({}), cancel).await;
                if matches!(displays, Err(ComputerError::Cancelled)) || matches!(permissions, Err(ComputerError::Cancelled)) {
                    return Err(ComputerError::Cancelled);
                }
                (platform(), permissions.ok().as_ref().and_then(grants), displays.ok())
            }
        };
        let report = computer_gnome::Diagnosis {
            platform,
            requested_window_id: &requested,
            ocr_language,
            windows,
            accessibility,
            ocr,
            input,
            displays: displays.as_ref(),
            permissions,
            observe_only: self.observe_only(),
        };
        let mut shown = computer_gnome::diagnose_text(&report);
        if let Some(permissions) = report.permissions.as_ref().filter(|_| self.linux.is_none())
            && let Ok(mut parsed) = serde_json::from_str::<Value>(&shown)
        {
            name_missing_grants(&mut parsed, permissions);
            shown = parsed.to_string();
        }
        Ok(vec![ToolPart::Text(shown)])
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerRequest;

    use super::super::computer_backend::ComputerConfig;
    use super::super::computer_backend::ComputerShared;
    use super::super::computer_targets::testing::Scripted;
    use super::*;

    fn helper(request: &Value) -> Result<Value, String> {
        match request["action"].as_str() {
            Some("list_windows" | "window_snapshot") => Ok(json!({"windows": [
                {"id": "hwnd:0x2", "focused": true, "app": "notepad", "title": "a.txt", "class_name": "Notepad"},
                {"id": "hwnd:0x3", "focused": false, "app": "calc", "title": "Calculator", "class_name": "CalcFrame"},
            ]})),
            Some("accessibility_probe") => Ok(json!({"interactive": true})),
            Some("ocr_status") => Ok(json!({
                "available": request.get("ocr_language") != Some(&json!("xx")),
                "requested_language": request["ocr_language"],
                "active_language": "en-US",
                "installed_languages": ["en-US"],
            })),
            Some("input_idle_state") => Ok(json!({"observer_ready": true, "desktop_ready": true, "ready": true, "held": false, "idleMs": 900})),
            _ => Ok(json!({"text": "ok"})),
        }
    }

    async fn diagnose_with(manager: &Arc<Scripted>, observe_only: bool, input: Value) -> Value {
        let shared = ComputerShared { observe_only: Arc::new(move || observe_only), ..ComputerShared::default() };
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared);
        let parts = backend.run(ComputerRequest { action: ComputerAction::Diagnose, input }, CancellationToken::new()).await.unwrap();
        let ToolPart::Text(report) = &parts[0] else { panic!("a text part") };
        serde_json::from_str(report).unwrap()
    }

    /// Off Linux the report is the host's own: the windows and the focused one, the probes of the requested or focused window, the
    /// OCR language reaching `ocr_status`, the input mode and the issues.
    #[tokio::test]
    async fn the_report_is_the_hosts_on_every_platform() {
        let manager = Scripted::new(helper);
        let report = diagnose_with(&manager, false, json!({"ocr_language": "ko"})).await;

        assert_eq!(report["action"], "diagnose");
        assert_eq!(report["platform"], platform());
        assert_eq!(report["ok"], true);
        assert_eq!(report["ready"], true);
        assert_eq!(report["windows"], json!({"available": true, "count": 2, "focused_window_id": "hwnd:0x2"}));
        assert_eq!(report["capabilities"]["input_mode"], "enabled");
        assert_eq!(report["capabilities"]["semantic_accessibility"]["target_window_id"], "hwnd:0x2");
        assert_eq!(report["capabilities"]["ocr"]["requested_language"], "ko");
        assert_eq!(report["issues"], json!([]));
        assert!(report.get("permissions").is_none() && report.get("displays").is_none(), "no desktop serves them here");
        let sent = manager.lines();
        let ocr = sent.iter().find(|line| line["action"] == "ocr_status").expect("the OCR probe");
        assert_eq!(ocr["ocr_language"], "ko");
        let access = sent.iter().find(|line| line["action"] == "accessibility_probe").expect("the accessibility probe");
        assert_eq!(access["window_id"], "hwnd:0x2");
        assert!(sent.iter().all(|line| line["read_only"] == json!(true)), "every probe is a read: {sent:?}");
    }

    /// A requested window that is not listed, an OCR language that is not installed and observation-only mode are all reported.
    #[tokio::test]
    async fn findings_are_reported_as_issues() {
        let manager = Scripted::new(helper);
        let report = diagnose_with(&manager, true, json!({"window_id": "hwnd:0x9", "ocr_language": "xx"})).await;

        assert_eq!(report["ready"], false);
        assert_eq!(report["capabilities"]["input_mode"], "observation_only");
        assert_eq!(report["issues"], json!(["requested window is unavailable: hwnd:0x9", "OCR language is unavailable: xx"]));
    }

    /// A desktop that answers the display list and the grants it reads.
    struct Grants(Value);

    #[async_trait::async_trait]
    impl mixdog_core_api::HostChannel for Grants {
        async fn request(&self, _: mixdog_core_api::HostCapability, method: mixdog_core_api::ids::Method, _: Value) -> Result<Value, mixdog_core_api::HostError> {
            match method.0 {
                "host/computer/displays" => Ok(json!([])),
                "host/computer/permissions" => Ok(self.0.clone()),
                // The window lists a desktop shows no window of its own in.
                "host/computer/internalWindows" => Ok(json!({"windowIds": []})),
                "host/computer/appWindows" => Ok(json!({"windows": []})),
                other => panic!("the diagnose asked the desktop for {other}"),
            }
        }

        fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            Ok(())
        }
    }

    async fn diagnose_granting(grants: Value) -> Value {
        let manager = Scripted::new(helper);
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager).with_desktop(Arc::new(Grants(grants)));
        let parts = backend.run(ComputerRequest { action: ComputerAction::Diagnose, input: json!({}) }, CancellationToken::new()).await.unwrap();
        let ToolPart::Text(report) = &parts[0] else { panic!("a text part") };
        serde_json::from_str(report).unwrap()
    }

    /// Where the desktop reads the grants they are the report's `permissions`, and a macOS grant still to be given is named as an issue
    /// (`diagnoseIssues`): the Screen Recording one after the others.
    #[tokio::test]
    async fn the_grants_the_desktop_reads_are_reported_and_a_missing_one_is_named() {
        let report = diagnose_granting(json!({"screenCapture": "denied", "accessibility": "not-determined", "input": "granted"})).await;
        assert_eq!(report["permissions"], json!({"screen_capture": "denied", "accessibility": "not-determined", "input": "granted"}));
        assert_eq!(report["issues"], json!([ACCESSIBILITY_GUIDANCE, SCREEN_RECORDING_GUIDANCE]));

        let granted = diagnose_granting(json!({"screenCapture": "not_required_on_windows", "accessibility": "target_integrity_dependent", "input": "accessibility_dependent"})).await;
        assert_eq!(granted["issues"], json!([]));
        assert_eq!(granted["permissions"]["accessibility"], "target_integrity_dependent");
    }

    /// A grant that blocks accessibility is named in place of the accessibility probe's own restatement of it.
    #[test]
    fn a_blocked_accessibility_grant_replaces_the_probes_restatement() {
        let mut report = json!({
            "capabilities": {"semantic_accessibility": {"available": false, "reason": "UI Automation is unavailable"}},
            "issues": ["UI Automation is unavailable", "OCR language is unavailable: xx"],
        });
        name_missing_grants(&mut report, &json!({"screen_capture": "granted", "accessibility": "denied", "input": "granted"}));
        assert_eq!(report["issues"], json!([ACCESSIBILITY_GUIDANCE, "OCR language is unavailable: xx"]));
    }
}
