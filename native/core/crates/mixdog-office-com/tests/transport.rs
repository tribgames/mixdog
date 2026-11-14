//! The Office COM transport against a stand-in host (`tests/fake_host.rs`) that speaks the hosts' line protocol, and
//! the ported cases of `office-cleanup.test.mjs` and the transport cases of `office-runtime-com.test.mjs`.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_office_com::CallOptions;
use mixdog_office_com::CloseOptions;
use mixdog_office_com::OfficeCom;
use mixdog_office_com::OfficeComConfig;
use mixdog_office_com::Ownership;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const CLEANUP_FAILURE: &str = r#"MIXDOG_OFFICE_CLEANUP {"ok":false,"errors":["document close failed"]}"#;

fn scratch() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mixdog-office-com-transport-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    mixdog_testkit::create_dir_all(&dir);
    dir
}

/// A transport whose hosts are the stand-in; `grace_ms` is how long it waits for a host it asked to end.
fn office(grace_ms: u64) -> (OfficeCom, PathBuf) {
    let dir = scratch();
    let mut config = OfficeComConfig::new(dir.clone(), mixdog_rt::testing::tokens())
        .with_host_command(PathBuf::from(env!("CARGO_BIN_EXE_fake-office-host")), Vec::<OsString>::new());
    config.drain_grace = Duration::from_millis(grace_ms);
    (OfficeCom::new(config), dir)
}

fn within(millis: u64) -> CallOptions {
    CallOptions { timeout: Duration::from_millis(millis), cancel: CancellationToken::new() }
}

fn session_payload(session: &str, fake: Value) -> Value {
    json!({"session": session, "format": "pptx", "path": "deck.pptx", "fake": fake})
}

/// Polls `ready` for up to ten seconds.
async fn eventually(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..200 {
        if ready() {
            return;
        }
        mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never happened: {what}");
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("no {key} in {value}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_one_shot_call_answers_with_the_last_stdout_line_and_the_scripts_are_written_once() {
    let (office, data) = office(2_000);
    let payload = json!({"action": "snapshot", "path": "a.docx"});
    let reply = office.call(&payload, CallOptions::default()).await;
    assert_eq!(reply.value["ok"], json!(true));
    assert_eq!(reply.value["echo"], payload);
    assert!(reply.host_exit.is_none());
    let scripts: Vec<_> = mixdog_testkit::tree(data.join("office").join("com"));
    let names: Vec<&str> = scripts.iter().map(|(path, _)| path.as_str()).collect();
    for name in ["office-com-host.ps1", "office-com-session-host.ps1", "office-com-cleanup.ps1", "office-word-formatting.ps1"] {
        assert!(names.iter().any(|path| path.ends_with(name)), "{name} was not written: {names:?}");
    }
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_one_shot_whose_stderr_reports_a_cleanup_failure_is_a_failure_that_must_not_be_replayed() {
    let (office, data) = office(2_000);
    let payload = json!({"action": "snapshot", "fake": {"stderr": CLEANUP_FAILURE}});
    let reply = office.call(&payload, CallOptions::default()).await;
    assert_eq!(reply.value["ok"], json!(false));
    assert_eq!(reply.value["operationCompleted"], json!(true));
    assert_eq!(
        text(&reply.value, "error"),
        "Office operation finished but cleanup failed; do not replay the operation."
    );
    assert_eq!(reply.value["cleanup"], json!({"ok": false, "errors": [CLEANUP_FAILURE]}));
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_one_shot_that_prints_no_json_fails_with_what_it_wrote() {
    let (office, data) = office(2_000);
    let reply = office.call(&json!({"fake": {"print": "garbage", "exit_code": 2}}), CallOptions::default()).await;
    assert_eq!(reply.value, json!({"ok": false, "error": "garbage"}));
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_one_shot_timeout_sends_eof_and_reports_the_cleanup_pending_without_killing_the_host() {
    let (office, data) = office(200);
    let reply = office.call(&json!({"action": "snapshot", "fake": {"busy_ms": 1500}}), within(100)).await;
    assert_eq!(reply.value["ok"], json!(false));
    assert_eq!(reply.value["cancelled"], json!(false));
    assert_eq!(reply.value["operationMayHaveCompleted"], json!(true));
    assert_eq!(reply.value["cleanup"]["pending"], json!(true));
    assert_eq!(reply.value["cleanup"]["hostExited"], json!(false));
    assert_eq!(
        text(&reply.value, "error"),
        "Microsoft Office operation timed out after 100ms; cleanup unconfirmed: \
         Office cleanup is still pending; the host was not force-killed."
    );
    // The answer came while the host was still finishing; the host-exit signal settles when it is gone.
    let exit = reply.host_exit.expect("a cancelled or timed-out answer carries the host's exit");
    mixdog_rt::time::timeout(Duration::from_secs(10), exit.wait()).await.expect("the host ends by itself");
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_one_shot_drains_the_host_through_eof() {
    let (office, data) = office(2_000);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let options = CallOptions { timeout: Duration::from_secs(30), cancel };
    let reply = office.call(&json!({"action": "snapshot"}), options).await;
    assert_eq!(reply.value["ok"], json!(false));
    assert_eq!(reply.value["cancelled"], json!(true));
    assert_eq!(reply.value["operationMayHaveCompleted"], json!(true));
    assert_eq!(text(&reply.value, "error"), "Microsoft Office operation was cancelled");
    assert_eq!(reply.value["cleanup"], json!({"ok": true, "hostExited": true}));
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_opens_takes_calls_and_closes() {
    let (office, data) = office(2_000);
    let opened = office.open_session(&session_payload("s1", json!({})), CallOptions::default()).await;
    assert_eq!(opened["ok"], json!(true));
    assert!(opened.get("requestId").is_none());
    let identity = office.session_identity("s1").expect("the session is live");
    assert_eq!(identity.ownership, Some(Ownership::Owned));
    assert_eq!(identity.owns_application, Some(true));
    assert_eq!(identity.app_pid, Some(101));

    let reply = office.call(&json!({"session": "s1", "action": "snapshot"}), CallOptions::default()).await;
    assert_eq!(reply.value["ok"], json!(true));
    assert_eq!(reply.value["echo"]["action"], json!("snapshot"));
    assert!(reply.value.get("requestId").is_none());
    assert!(reply.value["echo"]["requestId"].as_str().is_some_and(|id| id.starts_with("office_request_")));

    let closed = office.close_session("s1", CloseOptions::default()).await;
    assert_eq!(closed["ok"], json!(true));
    assert!(closed.get("forcedHostCleanup").is_none());
    assert!(closed.get("reaped").is_none());
    assert!(office.session_identity("s1").is_none());
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_refuses_an_empty_or_duplicate_id_and_calls_to_an_unknown_session_fail() {
    let (office, data) = office(2_000);
    let empty = office.open_session(&json!({"format": "pptx"}), CallOptions::default()).await;
    assert_eq!(empty, json!({"ok": false, "error": "Microsoft Office session id is required"}));
    let first = office.open_session(&session_payload("dup", json!({})), CallOptions::default()).await;
    assert_eq!(first["ok"], json!(true));
    let again = office.open_session(&session_payload("dup", json!({})), CallOptions::default()).await;
    assert_eq!(again, json!({"ok": false, "error": "Microsoft Office session already exists: dup"}));
    let unknown = office.call(&json!({"session": "nope", "action": "snapshot"}), CallOptions::default()).await;
    assert_eq!(
        unknown.value,
        json!({"ok": false, "backend": "microsoft-office-com", "error": "Unknown Microsoft Office session: nope"})
    );
    let missing = office.close_session("nope", CloseOptions::default()).await;
    assert_eq!(
        missing,
        json!({
            "ok": false,
            "closed": false,
            "reaped": true,
            "error": "Office session host is unavailable; application cleanup cannot be confirmed.",
        })
    );
    office.shutdown().await;
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_an_open_drains_the_host_through_eof_and_the_late_identity_is_captured() {
    let (office, data) = office(5_000);
    let cancel = CancellationToken::new();
    let options = CallOptions { timeout: Duration::from_secs(60), cancel: cancel.clone() };
    let opening = {
        let office = office.clone();
        tokio::spawn(async move {
            office
                .open_session(&session_payload("late", json!({"late_identity": true, "hang": true})), options)
                .await
        })
    };
    // The host announces its application before it answers: the identity is known while the open is in flight.
    eventually("the late identity arrives", || {
        office.session_identity("late").is_some_and(|identity| identity.app_pid == Some(101))
    })
    .await;
    cancel.cancel();
    let result = opening.await.expect("the open settles");
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["cancelled"], json!(true));
    assert_eq!(result["cleanup"], json!({"ok": true, "hostExited": true}));
    assert_eq!(text(&result, "error"), "Microsoft Office operation was cancelled");
    assert!(office.session_identity("late").is_none());
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanup_that_outlasts_the_grace_is_pending_and_the_host_is_left_alone() {
    let (office, data) = office(200);
    let opened = office.open_session(&session_payload("slow", json!({})), CallOptions::default()).await;
    assert_eq!(opened["ok"], json!(true));
    let result = office
        .call(&json!({"session": "slow", "action": "export", "fake": {"busy_ms": 1500}}), within(100))
        .await
        .value;
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["cleanup"]["pending"], json!(true));
    assert_eq!(result["cleanup"]["hostExited"], json!(false));
    assert_eq!(
        text(&result, "error"),
        "Microsoft Office operation timed out after 100ms; cleanup unconfirmed: \
         Office cleanup is still pending; the host was not force-killed."
    );
    // Nothing stopped the client: the host still holds its session until it ends on its own.
    assert!(office.session_identity("slow").is_some());
    eventually("the host ends after its call returns", || office.session_identity("slow").is_none()).await;
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_cleanup_errors_are_returned_instead_of_treating_host_exit_as_success() {
    let (office, data) = office(5_000);
    let on_eof = json!({"stderr": CLEANUP_FAILURE, "exit_code": 1});
    let opened = office.open_session(&session_payload("dirty", json!({"on_eof": on_eof})), CallOptions::default()).await;
    assert_eq!(opened["ok"], json!(true));
    let result = office
        .call(&json!({"session": "dirty", "action": "export", "fake": {"hang": true}}), within(100))
        .await
        .value;
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["cleanup"]["ok"], json!(false));
    assert_eq!(result["cleanup"]["hostExited"], json!(true));
    assert!(result["cleanup"]["errors"][0].as_str().is_some_and(|line| line.contains("document close failed")));
    assert!(text(&result, "error").contains("cleanup unconfirmed: MIXDOG_OFFICE_CLEANUP"));
    assert!(office.session_identity("dirty").is_none());
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_that_crashes_fails_what_was_waiting_with_its_stderr_and_the_session_is_gone() {
    let (office, data) = office(2_000);
    let opened = office.open_session(&session_payload("crash", json!({})), CallOptions::default()).await;
    assert_eq!(opened["ok"], json!(true));
    let result = office
        .call(&json!({"session": "crash", "action": "export", "fake": {"crash": true, "stderr": "COM exploded"}}), CallOptions::default())
        .await
        .value;
    assert_eq!(result, json!({"ok": false, "backend": "microsoft-office-com", "error": "COM exploded"}));
    eventually("the session is forgotten", || office.session_identity("crash").is_none()).await;
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_whose_application_is_gone_is_reaped_with_the_failure() {
    let (office, data) = office(2_000);
    let opened = office.open_session(&session_payload("gone", json!({"rpc_gone": true})), CallOptions::default()).await;
    assert_eq!(opened["ok"], json!(true));
    let closed = office.close_session("gone", CloseOptions::default()).await;
    assert_eq!(closed["ok"], json!(false));
    assert_eq!(closed["reaped"], json!(true));
    assert!(text(&closed, "error").contains("0x800706BA"));
    assert!(office.session_identity("gone").is_none());
    mixdog_testkit::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_that_does_not_exit_after_close_is_ended_and_the_result_says_so() {
    let (office, data) = office(2_000);
    let slow_exit = json!({"on_eof": {"delay_ms": 3000}});
    let opened = office.open_session(&session_payload("stuck", slow_exit), CallOptions::default()).await;
    assert_eq!(opened["ok"], json!(true));
    let options = CloseOptions { close_timeout: Duration::from_millis(150), ..CloseOptions::default() };
    let closed = office.close_session("stuck", options).await;
    assert_eq!(closed["ok"], json!(true));
    assert_eq!(closed["forcedHostCleanup"], json!(true));
    assert!(office.session_identity("stuck").is_none());
    mixdog_testkit::remove_dir_all(&data);
}

/// `office-runtime-com.test.mjs`, "process exit requests EOF cleanup without force-closing owned or attached
/// applications": the shutdown gives every session host its EOF, waits for it, and fails what was waiting as a host
/// that left does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_gives_every_session_host_its_eof_without_killing_it() {
    let (office, data) = office(5_000);
    for id in ["a", "b"] {
        let opened = office.open_session(&session_payload(id, json!({})), CallOptions::default()).await;
        assert_eq!(opened["ok"], json!(true));
    }
    let waiting = {
        let office = office.clone();
        tokio::spawn(async move {
            office
                .call(&json!({"session": "a", "action": "export", "fake": {"hang": true}}), within(60_000))
                .await
                .value
        })
    };
    mixdog_rt::time::sleep(Duration::from_millis(300)).await;
    mixdog_rt::time::timeout(Duration::from_secs(20), office.shutdown()).await.expect("shutdown returns");
    let failure = waiting.await.expect("the call settles");
    assert_eq!(failure["ok"], json!(false));
    assert_eq!(failure["error"], json!("Microsoft Office session host exited with code 0"));
    assert!(office.session_identity("a").is_none());
    assert!(office.session_identity("b").is_none());
    mixdog_testkit::remove_dir_all(&data);
}

#[cfg(not(windows))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn off_windows_every_entry_point_says_so_without_starting_a_host() {
    let dir = scratch();
    let office = OfficeCom::new(OfficeComConfig::new(dir.clone(), mixdog_rt::testing::tokens()));
    let said = json!({"ok": false, "available": false, "error": "Microsoft Office COM is available on Windows only"});
    assert_eq!(office.detect("docx", "").await.value, said);
    assert_eq!(office.call(&json!({"action": "snapshot"}), CallOptions::default()).await.value, said);
    assert_eq!(office.open_session(&json!({"session": "x"}), CallOptions::default()).await, said);
    assert!(!mixdog_testkit::exists(dir.join("office")));
    mixdog_testkit::remove_dir_all(&dir);
}

/// The PowerShell test of `Close-SessionState` from `office-cleanup.test.mjs`, run against the embedded copy of
/// `office-com-cleanup.ps1` (which is byte for byte the Node tree's file): cleanup closes by format, preserves shared
/// documents and exposes failures. It only runs PowerShell over stand-in objects; no Office application is started.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn powershell_cleanup_closes_by_format_preserves_shared_documents_and_exposes_failures() {
    let cleanup = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets").join("office-com-cleanup.ps1");
    let dir = scratch();
    let probe = dir.join("cleanup-probe.ps1");
    let quoted = cleanup.to_string_lossy().replace("'", "''");
    mixdog_testkit::write(&probe, CLEANUP_PROBE.replace("{CLEANUP}", &quoted));
    let output = tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&probe)
        .output()
        .await
        .expect("run powershell");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("cleanup behavior passed"), "{stdout}{}", String::from_utf8_lossy(&output.stderr));
    mixdog_testkit::remove_dir_all(&dir);
}

#[cfg(windows)]
const CLEANUP_PROBE: &str = r##"
$ErrorActionPreference = 'Stop'
. '{CLEANUP}'
Add-Type -TypeDefinition @'
using System;
public class CollectionProbe { public int Count = 1; }
public class AppProbe {
  public CollectionProbe Documents = new CollectionProbe();
  public CollectionProbe Workbooks = new CollectionProbe();
  public CollectionProbe Presentations = new CollectionProbe();
  public int Quits;
  public bool FailQuit;
  public void Quit() { if (FailQuit) throw new Exception("quit rejected"); Quits++; }
}
public class PptProbe {
  public CollectionProbe Collection;
  public bool Fail;
  public int Closes;
  public void Close() { if (Fail) throw new Exception("close rejected"); Closes++; Collection.Count--; }
}
public class WordProbe {
  public CollectionProbe Collection;
  public int Closes;
  public void Close(int save) { if (save != 0) throw new Exception("unexpected save"); Closes++; Collection.Count--; }
}
public class ExcelProbe {
  public CollectionProbe Collection;
  public int Closes;
  public void Close(bool save) { if (save) throw new Exception("unexpected save"); Closes++; Collection.Count--; }
}
'@
function Check($condition, $message) { if (-not $condition) { throw $message } }
function Make-State($format, $ownership, $ownsApplication, $otherDocuments = 0, $fail = $false) {
  $app = New-Object AppProbe
  switch ($format) {
    'pptx' { $doc = New-Object PptProbe; $doc.Collection = $app.Presentations; $doc.Fail = $fail }
    'docx' { $doc = New-Object WordProbe; $doc.Collection = $app.Documents }
    'xlsx' { $doc = New-Object ExcelProbe; $doc.Collection = $app.Workbooks }
  }
  $doc.Collection.Count = 1 + $otherDocuments
  return [pscustomobject]@{ Format=$format; Mode='background'; Ownership=$ownership; OwnsApplication=$ownsApplication; App=$app; Document=$doc; AppPid=0; AppStartTicks=0 }
}
foreach ($format in @('pptx', 'docx', 'xlsx')) {
  $state = Make-State $format 'owned' $true
  $app = $state.App; $doc = $state.Document
  $result = Close-SessionState $state $false
  Check ($result.ok -and $doc.Closes -eq 1 -and $app.Quits -eq 1) "wrong close signature for $format"
}
$state = Make-State 'pptx' 'owned' $false
$app = $state.App; $doc = $state.Document
$result = Close-SessionState $state $false
Check ($result.ok -and $doc.Closes -eq 1 -and $app.Quits -eq 0 -and $result.applicationRetained) 'shared application was quit'
$state = Make-State 'pptx' 'attached' $false
$app = $state.App; $doc = $state.Document
$result = Close-SessionState $state $false
Check ($result.ok -and $doc.Closes -eq 0 -and $app.Quits -eq 0 -and $result.detached) 'attached user document was closed'
$state = Make-State 'pptx' 'owned' $true 1
$app = $state.App
$result = Close-SessionState $state $false
Check ($result.ok -and $app.Presentations.Count -eq 1 -and $app.Quits -eq 0) 'another user document was closed'
$state = Make-State 'pptx' 'owned' $true 0 $true
$result = Close-SessionState $state $false
Check (-not $result.ok -and $result.errors.Count -gt 0 -and $null -ne $state.Document) 'close failure was hidden or cannot retry'
$state.Document.Fail = $false
$result = Close-SessionState $state $false
Check $result.ok 'explicit close retry failed'
$state = Make-State 'pptx' 'owned' $true
$state.App.FailQuit = $true
$result = Close-SessionState $state $false
Check (-not $result.ok -and $result.errors.Count -gt 0 -and $null -ne $state.App) 'quit failure was hidden or cannot retry'
$state.App.FailQuit = $false
$result = Close-SessionState $state $false
Check $result.ok 'explicit quit retry failed'
# An application that accepted Quit shuts itself down in its own time. Waiting
# one second killed it mid-shutdown on every background close, and reported a
# visible session — which is never killed — as still running.
$child = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 2500' -PassThru -WindowStyle Hidden
$state = Make-State 'xlsx' 'owned' $true
$state.AppPid = $child.Id
$state.AppStartTicks = $child.StartTime.ToUniversalTime().Ticks
$result = Close-SessionState $state $false
Check ($result.processExited -and -not $result.forcedProcessCleanup) 'a quitting application was killed instead of allowed to exit'
Check ($result.ok -and $result.errors.Count -eq 0) 'a clean exit was reported as a cleanup failure'
[Console]::Out.WriteLine('cleanup behavior passed')
"##;
