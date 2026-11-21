//! Ignored: starts Office; run with `-- --ignored` on Windows with it and `MIXDOG_TEST_LIVE_OFFICE=1`, else a requested test ends at once.
#![cfg(windows)]

use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use mixdog_office_com::platform::FontSet;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::process::Command;
use windows::Win32::System::Com::IDispatch;
use windows::core::IUnknown;
use windows::core::Interface;

const POWERSHELL: &str = "powershell.exe";

/// How long a child gets to print what the test waits for.
const CHILD_STEP: Duration = Duration::from_secs(120);

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn powershell(script: &str) -> Command {
    let mut command = Command::new(POWERSHELL);
    command
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn lines_until(child: &mut Child, stop: &str) -> Vec<String> {
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout).lines();
    let mut lines = Vec::new();
    let read = async {
        while let Some(line) = reader.next_line().await.expect("read a line") {
            let done = line.trim() == stop;
            lines.push(line.trim().to_string());
            if done {
                break;
            }
        }
    };
    mixdog_rt::time::timeout(CHILD_STEP, read).await.expect("the child printed its marker in time");
    lines
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-platform-{name}-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&dir);
    dir
}

#[tokio::test]
#[ignore = "reads the installed fonts and starts a Windows PowerShell child"]
async fn installed_fonts_equal_what_system_drawing_lists() {
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; \
        $c = [System.Drawing.Text.InstalledFontCollection]::new(); \
        foreach ($f in @($c.Families)) { $f.Name; try { $f.GetName(1033) } catch {} }; 'END'";
    let mut child = powershell(script).spawn().expect("start powershell");
    let lines = lines_until(&mut child, "END").await;
    let expected: FontSet = lines.into_iter().filter(|line| line != "END" && !line.is_empty()).collect();
    let platform = WindowsPlatform::new().expect("platform");
    let found = platform.installed_office_fonts();
    assert!(!found.is_empty());
    let sorted = |set: &FontSet| {
        let mut names: Vec<String> = set.iter().map(str::to_lowercase).collect();
        names.sort();
        names
    };
    assert_eq!(sorted(&found), sorted(&expected));
}

#[test]
#[ignore = "opens files and reads the process table"]
fn the_process_and_file_helpers_answer_for_this_process() {
    let platform = WindowsPlatform::new().expect("platform");
    let me = std::process::id() as i32;
    assert!(platform.process_exists(me));
    assert!(platform.process_start_ticks(me) > 0);
    assert_eq!(platform.process_start_ticks(0x7FFF_FFF0), 0);
    assert!(!platform.process_ids_by_name("explorer").is_empty());
    assert!(platform.installed("Scripting.FileSystemObject"));
    assert!(!platform.installed("Mixdog.NoSuchProgram"));
    assert!(!platform.installed(""));
    let guid = platform.new_guid_n();
    assert_eq!(guid.len(), 32);
    assert!(guid.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert!(mixdog_testkit::is_dir(platform.temp_dir()));
    let dir = scratch("files");
    let file = dir.join("lock.txt");
    mixdog_testkit::write(&file, b"x");
    assert!(!platform.file_appears_open(&file));
    let held = platform.open_exclusive(&file).expect("exclusive open");
    assert!(platform.file_appears_open(&file));
    drop(held);
    assert!(!platform.file_appears_open(&file));
    assert!(platform.file_appears_open(&dir.join("missing.txt")));
    mixdog_testkit::remove_dir_all(&dir);
}

struct Office {
    child: Child,
    stdin: Option<ChildStdin>,
    excel_book: PathBuf,
    second_book: PathBuf,
    word_doc: PathBuf,
}

impl Office {
    async fn start(dir: &Path) -> Self {
        let excel_book = dir.join("first.xlsx");
        let second_book = dir.join("second.xlsx");
        let word_doc = dir.join("doc.docx");
        let script = format!(
            "$ErrorActionPreference = 'Stop'; \
             $xl = New-Object -ComObject Excel.Application; $xl.Visible = $true; $wb = $xl.Workbooks.Add(); \
             $wb.SaveAs('{excel}'); \
             $x2 = New-Object -ComObject Excel.Application; $x2.Visible = $true; $wb2 = $x2.Workbooks.Add(); \
             $wb2.SaveAs('{second}'); \
             $wd = New-Object -ComObject Word.Application; $wd.Visible = $true; $doc = $wd.Documents.Add(); \
             $doc.SaveAs([ref]'{word}'); \
             'READY'; [Console]::In.ReadLine() | Out-Null; \
             try {{ $wb.Close($false); $wb2.Close($false); $doc.Close(0); $xl.Quit(); $x2.Quit(); $wd.Quit() }} catch {{}}; 'DONE'",
            excel = excel_book.display(),
            second = second_book.display(),
            word = word_doc.display(),
        );
        let mut child = powershell(&script).spawn().expect("start powershell");
        let stdin = child.stdin.take();
        lines_until(&mut child, "READY").await;
        Self { child, stdin, excel_book, second_book, word_doc }
    }

    /// Closes the documents and the applications, and waits for the child to be done.
    async fn finish(mut self) {
        drop(self.stdin.take());
        let _ = mixdog_rt::time::timeout(CHILD_STEP, self.child.wait()).await;
    }
}

fn found_dispatch(platform: &WindowsPlatform, path: &str) -> bool {
    platform.try_get_running_file(path).and_then(|object| object.downcast::<IUnknown>().ok()).is_some_and(|unknown| unknown.cast::<IDispatch>().is_ok())
}

fn rot_finds_an_open_file_by_cased_path_and_file_uri(platform: &WindowsPlatform, office: &Office, dir: &Path) {
    let upper = office.excel_book.display().to_string().to_uppercase();
    let uri = format!("file:///{}", office.word_doc.display().to_string().replace('\\', "/").replace(' ', "%20"));
    assert!(found_dispatch(platform, &upper));
    assert!(found_dispatch(platform, &uri));
    assert!(!found_dispatch(platform, &dir.join("absent.xlsx").display().to_string()));
}

fn a_second_excel_registers_its_workbook_only_when_asked(platform: &WindowsPlatform, office: &Office) {
    let mut seen = false;
    for _ in 0..20 {
        platform.register_excel_instances();
        if found_dispatch(platform, &office.second_book.display().to_string()) {
            seen = true;
            break;
        }
        platform.sleep(500);
    }
    assert!(seen, "the second instance's workbook is visible to the ROT after RegisterExcelInstances");
}

fn a_word_window_is_found_described_activated_and_hidden(platform: &WindowsPlatform) {
    let before = platform.foreground_window();
    let word = platform.find_window_by_class_and_title("opusapp", "doc");
    assert_ne!(word, 0, "Word's window is found by class and title part");
    let word_pid = platform.process_id_for_window(word);
    assert!(word_pid > 0);
    assert!(platform.window_visible(word));
    assert!(platform.visible_window_descriptions_for_process(word_pid).iter().any(|text| text.starts_with("OpusApp|")));
    platform.activate_window(word);
    if before != 0 && before != word {
        let restored = platform.restore_foreground_window(before);
        assert_eq!(restored, platform.foreground_window() == before);
    }
    let mut remaining = platform.visible_window_count_for_process(word_pid);
    for _ in 0..20 {
        if remaining == 0 {
            break;
        }
        platform.hide_visible_windows_for_process(word_pid);
        platform.sleep(25);
        remaining = platform.visible_window_count_for_process(word_pid);
    }
    assert_eq!(remaining, 0, "every window of the instance is hidden");
    assert!(!platform.window_visible(word));
}

async fn a_workbook_appears_open_until_excel_closes_it(platform: &WindowsPlatform, office: Office) {
    assert!(platform.file_appears_open(&office.excel_book));
    let book = office.excel_book.clone();
    office.finish().await;
    let mut open = true;
    for _ in 0..20 {
        open = platform.file_appears_open(&book);
        if !open {
            break;
        }
        platform.sleep(500);
    }
    assert!(!open, "the workbook is free once Excel closed it");
}

#[tokio::test]
#[ignore = "starts Excel and Word and moves windows; needs MIXDOG_TEST_LIVE_OFFICE=1"]
async fn the_running_object_table_and_the_windows_of_a_live_office() {
    if !live_office() {
        return;
    }
    let dir = scratch("office");
    let office = Office::start(&dir).await;
    let platform = WindowsPlatform::new().expect("platform");
    rot_finds_an_open_file_by_cased_path_and_file_uri(&platform, &office, &dir);
    a_second_excel_registers_its_workbook_only_when_asked(&platform, &office);
    a_word_window_is_found_described_activated_and_hidden(&platform);
    a_workbook_appears_open_until_excel_closes_it(&platform, office).await;
    mixdog_testkit::remove_dir_all(&dir);
}
