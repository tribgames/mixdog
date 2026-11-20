//! The Win32 and process layer: the path normalisation the ROT lookup compares with, the tick arithmetic, the GUID text
//! and the scripted answers of the fake. No COM call is made here; the Windows layer is compared in `platform_live`.

use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use mixdog_office_com::platform::FILETIME_TO_TICKS_OFFSET;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FakeWindow;
use mixdog_office_com::platform::FontSet;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::guid_text_n;
use mixdog_office_com::platform::normalize_path;
use mixdog_office_com::platform::office_process_name;
use mixdog_office_com::platform::ticks_from_filetime;

#[test]
fn normalize_path_drops_the_bang_and_the_trailing_separators() {
    assert_eq!(normalize_path("!C:\\a\\b.xlsx"), "C:\\a\\b.xlsx");
    assert_eq!(normalize_path("!!C:\\a\\b.xlsx  "), "C:\\a\\b.xlsx");
    assert_eq!(normalize_path("  !C:\\a\\b.xlsx"), "C:\\a\\b.xlsx");
    assert_eq!(normalize_path("C:\\a\\b\\"), "C:\\a\\b");
    assert_eq!(normalize_path("C:\\a\\b\\\\"), "C:\\a\\b");
    assert_eq!(normalize_path("C:/a/b/"), "C:\\a\\b");
    assert_eq!(normalize_path("C:\\"), "C:");
}

#[test]
fn normalize_path_resolves_dots_and_repeated_separators_as_get_full_path_does() {
    assert_eq!(normalize_path("C:\\a\\.\\x\\..\\b.xlsx"), "C:\\a\\b.xlsx");
    assert_eq!(normalize_path("C:/a//b.xlsx"), "C:\\a\\b.xlsx");
    assert_eq!(normalize_path("C:\\..\\a"), "C:\\a");
    assert_eq!(normalize_path("c:\\A\\b.xlsx"), "c:\\A\\b.xlsx");
}

#[test]
fn normalize_path_turns_a_file_uri_into_its_local_path() {
    assert_eq!(normalize_path("file:///C:/a/b%20c.docx"), "C:\\a\\b c.docx");
    assert_eq!(normalize_path("FILE:///C:/a/b.docx"), "C:\\a\\b.docx");
    assert_eq!(normalize_path("file:///C:/a/b.docx#page"), "C:\\a\\b.docx");
    assert_eq!(normalize_path("file:///C:/d%C3%A9j%C3%A0.xlsx"), "C:\\d\u{e9}j\u{e0}.xlsx");
    assert_eq!(normalize_path("file://server/share/x.xlsx"), "\\\\server\\share\\x.xlsx");
    assert_eq!(normalize_path("!file:///C:/a/b.docx"), "C:\\a\\b.docx");
}

#[test]
fn normalize_path_keeps_unc_paths_and_gives_nothing_for_blank_or_invalid_text() {
    assert_eq!(normalize_path("\\\\server\\share\\x\\y\\"), "\\\\server\\share\\x\\y");
    assert_eq!(normalize_path(""), "");
    assert_eq!(normalize_path(" \t\r\n"), "");
    assert_eq!(normalize_path("!"), "");
    assert_eq!(normalize_path("C:\\a\0b"), "");
}

#[cfg(windows)]
#[test]
fn normalize_path_makes_a_relative_path_absolute() {
    let expected = std::path::absolute("a\\b.xlsx").unwrap().to_string_lossy().into_owned();
    assert_eq!(normalize_path("a\\b.xlsx"), expected);
    assert_eq!(normalize_path("!a\\b.xlsx\\"), expected);
}

#[test]
fn ticks_add_the_distance_between_the_filetime_and_the_dotnet_epoch() {
    assert_eq!(FILETIME_TO_TICKS_OFFSET, 504_911_232_000_000_000);
    assert_eq!(ticks_from_filetime(0), 504_911_232_000_000_000);
    // 1970-01-01T00:00:00Z is 116444736000000000 in FILETIME and 621355968000000000 in .NET ticks.
    assert_eq!(ticks_from_filetime(116_444_736_000_000_000), 621_355_968_000_000_000);
}

#[test]
fn guid_text_is_thirty_two_lowercase_hex_digits_in_field_order() {
    let text = guid_text_n(0x0123_4567, 0x89ab, 0xcdef, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
    assert_eq!(text, "0123456789abcdef0123456789abcdef");
    let padded = guid_text_n(1, 2, 3, [0, 0, 0, 0, 0, 0, 0, 255]);
    assert_eq!(padded, "000000010002000300000000000000ff");
    assert_eq!(padded.len(), 32);
}

#[test]
fn process_names_of_the_formats() {
    assert_eq!(office_process_name("docx"), "WINWORD");
    assert_eq!(office_process_name("xlsx"), "EXCEL");
    assert_eq!(office_process_name("pptx"), "POWERPNT");
    assert_eq!(office_process_name("pdf"), "");
    assert_eq!(office_process_name(""), "");
}

#[test]
fn the_fake_finds_a_running_file_by_any_spelling_of_its_path() {
    let platform = FakePlatform::new();
    platform.add_running_file("C:\\Docs\\Book.xlsx", "excel-book");
    platform.add_running_file("C:\\Docs\\Report.docx", "word-report");
    let label = |path: &str| platform.try_get_running_file(path).and_then(|object| object.downcast::<String>().ok());
    assert_eq!(label("c:\\docs\\BOOK.XLSX").as_deref(), Some("excel-book"));
    assert_eq!(label("file:///C:/Docs/Report.docx").as_deref(), Some("word-report"));
    assert_eq!(label("!C:\\Docs\\Book.xlsx\\").as_deref(), Some("excel-book"));
    assert_eq!(label("C:\\Docs\\Other.xlsx"), None);
    assert_eq!(label(""), None);
}

#[test]
fn the_fake_registers_excel_instances_and_counts_them() {
    let platform = FakePlatform::new();
    assert_eq!(platform.excel_registrations(), 0);
    platform.register_excel_instances();
    platform.register_excel_instances();
    assert_eq!(platform.excel_registrations(), 2);
}

fn two_process_windows(platform: &FakePlatform) {
    platform.add_window(FakeWindow::new(10, 100, "XLMAIN", "Book1 - Excel"));
    platform.add_window(FakeWindow::new(11, 100, "EXCEL7", "Book1"));
    let mut hidden = FakeWindow::new(12, 100, "XLDESK", "");
    hidden.visible = false;
    platform.add_window(hidden);
    platform.add_window(FakeWindow::new(20, 200, "OpusApp", "Doc1 - Word"));
}

#[test]
fn the_fake_counts_describes_and_hides_the_visible_windows_of_one_process() {
    let platform = FakePlatform::new();
    two_process_windows(&platform);
    assert_eq!(platform.visible_window_count_for_process(100), 2);
    assert_eq!(platform.visible_window_count_for_process(0), 0);
    assert_eq!(platform.visible_window_count_for_process(-3), 0);
    assert_eq!(platform.visible_window_descriptions_for_process(100), vec!["XLMAIN|Book1 - Excel".to_string(), "EXCEL7|Book1".to_string()]);
    assert_eq!(platform.hide_visible_windows_for_process(100), 2);
    assert_eq!(platform.visible_window_count_for_process(100), 0);
    assert_eq!(platform.hide_visible_windows_for_process(100), 0);
    assert_eq!(platform.visible_window_count_for_process(200), 1);
    assert!(!platform.window_visible(10));
    assert!(platform.window_visible(20));
    assert!(!platform.window_visible(0));
}

#[test]
fn the_fake_cuts_a_description_at_the_buffer_limits() {
    let platform = FakePlatform::new();
    platform.add_window(FakeWindow::new(1, 5, &"c".repeat(200), &"t".repeat(2000)));
    let described = platform.visible_window_descriptions_for_process(5);
    assert_eq!(described.len(), 1);
    assert_eq!(described[0], format!("{}|{}", "c".repeat(127), "t".repeat(1023)));
}

#[test]
fn the_fake_finds_a_visible_window_by_class_and_title_part_ignoring_case() {
    let platform = FakePlatform::new();
    two_process_windows(&platform);
    assert_eq!(platform.find_window_by_class_and_title("xlmain", "BOOK1"), 10);
    assert_eq!(platform.find_window_by_class_and_title("OpusApp", ""), 20);
    assert_eq!(platform.find_window_by_class_and_title("XLDESK", ""), 0);
    assert_eq!(platform.find_window_by_class_and_title("XLMAIN", "Sheet"), 0);
    assert_eq!(platform.process_id_for_window(20), 200);
    assert_eq!(platform.process_id_for_window(999), 0);
}

#[test]
fn the_fake_moves_the_foreground_and_restores_it() {
    let platform = FakePlatform::new();
    two_process_windows(&platform);
    platform.set_foreground(20);
    assert_eq!(platform.foreground_window(), 20);
    assert!(platform.activate_window(10));
    assert_eq!(platform.foreground_window(), 10);
    assert!(platform.restore_foreground_window(20));
    assert_eq!(platform.foreground_window(), 20);
    assert!(!platform.activate_window(0));
    assert!(!platform.activate_window(777));
    assert_eq!(platform.foreground_window(), 20);
    platform.set_refuse_foreground(true);
    assert!(!platform.activate_window(10));
    assert_eq!(platform.foreground_window(), 20);
    assert!(platform.hide_window(20));
    assert!(!platform.hide_window(0));
}

#[test]
fn the_fake_lists_office_processes_and_ends_one() {
    let platform = FakePlatform::new();
    platform.add_process(100, "EXCEL", 5);
    platform.add_process(101, "excel", 6);
    platform.add_process(200, "WINWORD", 7);
    assert_eq!(platform.office_process_ids("xlsx"), vec![100, 101]);
    assert_eq!(platform.excel_process_ids(), vec![100, 101]);
    assert_eq!(platform.office_process_ids("docx"), vec![200]);
    assert!(platform.office_process_ids("pptx").is_empty());
    assert!(platform.office_process_ids("other").is_empty());
    assert_eq!(platform.process_start_ticks(100), 5);
    assert_eq!(platform.process_start_ticks(4242), 0);
    assert!(platform.process_exists(100));
    assert!(platform.kill_process(100));
    assert!(!platform.kill_process(100));
    assert!(!platform.process_exists(100));
    assert_eq!(platform.process_start_ticks(100), 0);
    assert_eq!(platform.excel_process_ids(), vec![101]);
}

#[test]
fn the_fake_clock_advances_by_what_is_slept_and_a_wait_for_a_live_process_times_out() {
    let platform = FakePlatform::new();
    platform.add_process(100, "EXCEL", 5);
    let start = platform.now();
    platform.sleep(250);
    platform.sleep(750);
    assert_eq!(platform.now() - start, Duration::from_millis(1000));
    assert_eq!(platform.slept_ms(), 1000);
    assert!(!platform.wait_for_exit(100, 8000));
    assert_eq!(platform.now() - start, Duration::from_millis(9000));
    assert!(platform.kill_process(100));
    assert!(platform.wait_for_exit(100, 8000));
    assert_eq!(platform.slept_ms(), 9000);
    assert!(platform.wait_for_exit(31337, 8000));
}

#[test]
fn the_fake_knows_the_installed_prog_ids_and_the_font_names_in_any_case() {
    let platform = FakePlatform::new();
    platform.install("Excel.Application");
    assert!(platform.installed("excel.application"));
    assert!(!platform.installed("Word.Application"));
    assert!(!platform.installed(""));
    let fonts: FontSet = ["Malgun Gothic", "\u{b9d1}\u{c740} \u{ace0}\u{b515}", "Arial"].into_iter().map(String::from).collect();
    platform.set_fonts(fonts);
    let read = platform.installed_office_fonts();
    assert_eq!(read.len(), 3);
    assert!(read.contains("malgun gothic"));
    assert!(read.contains("ARIAL"));
    assert!(!read.contains("Calibri"));
}

#[test]
fn a_font_set_keeps_the_first_spelling_of_a_name() {
    let mut fonts = FontSet::default();
    assert!(fonts.is_empty());
    fonts.insert("Arial");
    fonts.insert("ARIAL");
    assert_eq!(fonts.iter().collect::<Vec<_>>(), vec!["Arial"]);
}

#[test]
fn the_fake_file_is_open_when_locked_or_missing_and_closed_otherwise() {
    let platform = FakePlatform::new();
    platform.put_file("C:\\Docs\\Book.xlsx", b"PK");
    assert!(!platform.file_appears_open(Path::new("c:\\docs\\book.xlsx")));
    platform.set_locked("C:\\Docs\\Book.xlsx", true);
    assert!(platform.file_appears_open(Path::new("C:\\Docs\\Book.xlsx")));
    platform.set_locked("C:\\Docs\\Book.xlsx", false);
    assert!(!platform.file_appears_open(Path::new("C:\\Docs\\Book.xlsx")));
    // As in PowerShell: a file that cannot be opened, for whatever reason, appears open.
    assert!(platform.file_appears_open(Path::new("C:\\Docs\\Missing.xlsx")));
}

#[test]
fn the_fake_exclusive_stream_reads_writes_and_seeks() {
    let platform = FakePlatform::new();
    platform.put_file("C:\\Docs\\Book.xlsx", b"hello");
    let mut stream = platform.open_exclusive(Path::new("C:\\Docs\\Book.xlsx")).unwrap();
    let mut text = String::new();
    stream.read_to_string(&mut text).unwrap();
    assert_eq!(text, "hello");
    stream.seek(SeekFrom::Start(0)).unwrap();
    stream.write_all(b"J").unwrap();
    stream.seek(SeekFrom::Start(0)).unwrap();
    let mut again = String::new();
    stream.read_to_string(&mut again).unwrap();
    assert_eq!(again, "Jello");
}

#[test]
fn the_fake_temp_dir_and_guids() {
    let platform = FakePlatform::new();
    assert_eq!(platform.temp_dir(), std::path::PathBuf::from("C:\\Temp\\"));
    platform.set_temp_dir("D:\\Scratch\\");
    assert_eq!(platform.temp_dir(), std::path::PathBuf::from("D:\\Scratch\\"));
    let first = platform.new_guid_n();
    let second = platform.new_guid_n();
    assert_ne!(first, second);
    for guid in [first, second] {
        assert_eq!(guid.len(), 32);
        assert!(guid.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }
}
