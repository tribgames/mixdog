//! Which host program a call or a session starts: with a test list of formats served by the Rust host, a docx session
//! and `detect` (whatever format it probes) start the configured Rust host program as `office-com-host --session` / `office-com-host`, and xlsx and
//! pptx start the PowerShell command line; with the shipped list docx, xlsx, pptx (and `detect`) start the Rust host program. The stand-in
//! host (`tests/fake_host.rs`) reports the arguments it was started with.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_office_com::CallOptions;
use mixdog_office_com::CloseOptions;
use mixdog_office_com::OfficeCom;
use mixdog_office_com::OfficeComConfig;
use serde_json::Value;
use serde_json::json;

fn scratch() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mixdog-office-com-route-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    mixdog_testkit::create_dir_all(&dir);
    dir
}

fn fake() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-office-host"))
}

/// A transport whose PowerShell command is `fake -NoLogo -File <script>` and whose Rust host program is the same
/// stand-in; `rust_formats` is the test list (`None`: the shipped list).
fn office(rust_formats: Option<&[&str]>) -> OfficeCom {
    office_in(rust_formats).0
}

/// The transport and the data directory it was given.
fn office_in(rust_formats: Option<&[&str]>) -> (OfficeCom, PathBuf) {
    let dir = scratch();
    let mut config = OfficeComConfig::new(dir.clone(), mixdog_rt::testing::tokens())
        .with_host_command(fake(), vec![OsString::from("-NoLogo"), OsString::from("-File")]);
    config.rust_host_program = fake();
    if let Some(formats) = rust_formats {
        config = config.with_rust_host_formats(formats);
    }
    (OfficeCom::new(config), dir)
}

fn argv(value: &Value) -> Vec<String> {
    value["argv"]
        .as_array()
        .unwrap_or_else(|| panic!("no argv in {value}"))
        .iter()
        .map(|arg| arg.as_str().unwrap_or_default().to_owned())
        .collect()
}

fn is_powershell_line(args: &[String], script: &str) -> bool {
    args.len() == 3 && args[0] == "-NoLogo" && args[1] == "-File" && args[2].ends_with(script)
}

async fn session_argv(office: &OfficeCom, format: &str) -> Vec<String> {
    let id = format!("route-{format}");
    let opened = office
        .open_session(&json!({"session": id, "format": format, "path": "a"}), CallOptions::default())
        .await;
    assert_eq!(opened["ok"], json!(true), "{opened}");
    let args = argv(&opened);
    let closed = office.close_session(&id, CloseOptions::default()).await;
    assert_eq!(closed["ok"], json!(true), "{closed}");
    args
}

async fn call_argv(office: &OfficeCom, format: &str) -> Vec<String> {
    let reply = office.call(&json!({"action": "snapshot", "format": format, "path": "a"}), CallOptions::default()).await;
    assert_eq!(reply.value["ok"], json!(true), "{}", reply.value);
    argv(&reply.value)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listed_format_starts_the_rust_host_program_and_the_others_start_powershell() {
    let (office, dir) = office_in(Some(&["docx"]));
    let dir = dir.to_string_lossy().into_owned();
    assert_eq!(session_argv(&office, "docx").await, ["office-com-host", "--session", "--data-dir", dir.as_str()]);
    assert_eq!(call_argv(&office, "docx").await, ["office-com-host", "--data-dir", dir.as_str()]);
    assert!(is_powershell_line(&session_argv(&office, "xlsx").await, "office-com-session-host.ps1"));
    assert!(is_powershell_line(&session_argv(&office, "pptx").await, "office-com-session-host.ps1"));
    assert!(is_powershell_line(&call_argv(&office, "pptx").await, "office-com-host.ps1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detect_follows_the_docx_entry() {
    let (listed, dir) = office_in(Some(&["docx"]));
    let dir = dir.to_string_lossy().into_owned();
    assert_eq!(argv(&listed.detect("docx", "a.docx").await.value), ["office-com-host", "--data-dir", dir.as_str()]);
    assert_eq!(argv(&listed.detect("xlsx", "a.xlsx").await.value), ["office-com-host", "--data-dir", dir.as_str()]);
    let other = office(Some(&["xlsx"]));
    assert!(is_powershell_line(&argv(&other.detect("xlsx", "a.xlsx").await.value), "office-com-host.ps1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shipped_list_starts_the_rust_host_for_word_excel_and_powerpoint() {
    let (office, dir) = office_in(None);
    let dir = dir.to_string_lossy().into_owned();
    for format in ["docx", "xlsx", "pptx"] {
        assert_eq!(session_argv(&office, format).await, ["office-com-host", "--session", "--data-dir", dir.as_str()], "{format}");
        assert_eq!(call_argv(&office, format).await, ["office-com-host", "--data-dir", dir.as_str()], "{format}");
    }
    assert_eq!(argv(&office.detect("docx", "a.docx").await.value), ["office-com-host", "--data-dir", dir.as_str()]);
    assert_eq!(argv(&office.detect("pptx", "a.pptx").await.value), ["office-com-host", "--data-dir", dir.as_str()]);
    let no_format = office.call(&json!({"action": "snapshot"}), CallOptions::default()).await;
    assert!(is_powershell_line(&argv(&no_format.value), "office-com-host.ps1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_test_list_starts_powershell_for_everything() {
    let office = office(Some(&[]));
    for format in ["docx", "xlsx", "pptx"] {
        assert!(is_powershell_line(&session_argv(&office, format).await, "office-com-session-host.ps1"), "{format}");
        assert!(is_powershell_line(&call_argv(&office, format).await, "office-com-host.ps1"), "{format}");
    }
    assert!(is_powershell_line(&argv(&office.detect("docx", "a.docx").await.value), "office-com-host.ps1"));
}
