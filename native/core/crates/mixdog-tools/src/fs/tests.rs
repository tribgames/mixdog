//! The file tools (read, list, glob, find, grep, edit, apply_patch) against trees and fake services built by the tests.
//! Cases replay in the recorder's order over one in-memory workspace (edits
//! and patches mutate it for the cases after them). `list-meta` needs real
//! mtimes and modes, which the in-memory file service does not carry.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the golden tests build and inspect real work trees with blocking filesystem calls"
)]

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::{DirEntry, FsError, FsErrorKind};
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::fs::WritePrecondition;
use mixdog_core_api::domain::fs::WriteRequest;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use tokio_util::sync::CancellationToken;

use super::*;

fn seed() -> Vec<(&'static str, Vec<u8>)> {
    let lines: String = (1..=120).map(|i| format!("line-{i}\n")).collect();
    vec![
        ("README.md", b"# Fixture\n\nalpha beta\ngamma\n".to_vec()),
        ("src/main.mjs", b"import { add } from './lib/math.mjs';\n\nexport function main() {\n  return add(1, 2);\n}\n".to_vec()),
        ("src/lib/math.mjs", b"export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n".to_vec()),
        ("src/lib/notes.txt", b"TODO: first\nplain\nTODO: second\n".to_vec()),
        ("docs/guide.md", b"# Guide\n\n- item one\n- item two\n".to_vec()),
        (".hidden", b"secret-free\n".to_vec()),
        ("data/bin.dat", vec![0x41, 0x00, 0x42, 0x43]),
        ("lines.txt", lines.into_bytes()),
    ]
}


pub(super) fn text_of(outcome: mixdog_core_api::domain::tool::ToolOutcome) -> (bool, String) {
    match outcome {
        Ok(out) => match &out.parts[0] {
            ToolPart::Text(t) => (false, t.clone()),
            _ => panic!("not text"),
        },
        Err(e) => (true, e.message_for_model),
    }
}







/// The expansion's root is Node's `path.parse(raw).root` (Node v22 `path.win32.parse`, the runtime of b6f10295a).
#[cfg(windows)]
#[test]
fn the_expansion_root_is_nodes_parse_root() {
    for (raw, root) in [
        ("//server/share/j*/x.ts", "//server/share/"),
        ("//server/share", "//server/share"),
        ("//server/share/", "//server/share/"),
        ("//server", "/"),
        ("//./C:/a/*.ts", "//./C:/"),
        ("//?/C:/a/*.ts", "//?/C:/"),
        ("//?/UNC/srv/sh/*.ts", "//?/UNC/"),
        ("C:/a/*.ts", "C:/"),
        ("c:/a/*.ts", "c:/"),
        ("C:", "C:"),
        ("C:a/*", "C:"),
        ("/a/*.ts", "/"),
        ("///x/y/*", "/"),
        ("//server//share/x*", "//server//share/"),
    ] {
        assert_eq!(&raw[..super::search::parse_root_len(raw)], root, "{raw}");
    }
}

use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ExtWorkerId;
use mixdog_core_api::domain::ext::ExtWorkerStatus;

/// An extension host serving a two-page PDF whose second page has no text layer; its page image streams in two chunks.
struct ScriptedPdfHost;

struct ShortPdfImageHost;

impl ExtPool for ShortPdfImageHost {
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
        if call.method != "pdf.render" {
            return ScriptedPdfHost.call(call);
        }
        let frames = [
            ExtFrame::Chunk(b"PN".to_vec()),
            ExtFrame::Done(Ok(serde_json::json!({
                "images": [{ "page": 2, "mimeType": "image/png", "bytes": 4 }],
            }))),
        ];
        Ok(Box::new(ScriptedFrames(frames.into())))
    }

    fn status(&self) -> Vec<ExtWorkerStatus> { Vec::new() }

    fn stop_worker(&self, worker: ExtWorkerId) -> Result<(), ExtError> {
        ScriptedPdfHost.stop_worker(worker)
    }
}

struct ScriptedFrames(std::collections::VecDeque<ExtFrame>);

#[async_trait::async_trait]
impl EventSource<ExtFrame> for ScriptedFrames {
    async fn next(&mut self) -> Option<ExtFrame> {
        self.0.pop_front()
    }
}

impl ExtPool for ScriptedPdfHost {
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
        let done = |value: JsonValue| ExtFrame::Done(Ok(value));
        let frames = match call.method.as_str() {
            "pdf.inspect" if call.params.get("extractText").is_none() => {
                let mut value = serde_json::json!({ "pageCount": 2 });
                if call.params["includeSha256"] == true {
                    use sha2::{Digest, Sha256};
                    let digest = if call.params["path"].as_str().unwrap().ends_with("/big.pdf") {
                        Sha256::digest(large_pdf())
                    } else {
                        Sha256::digest(b"%PDF-1.7 scripted")
                    };
                    value["sha256"] = serde_json::json!(format!("{digest:x}"));
                }
                vec![done(value)]
            }
            "pdf.inspect" => {
                let range = &call.params["pageRange"];
                let (from, to) = (range["from"].as_u64().unwrap(), range["to"].as_u64().unwrap());
                let pages: Vec<JsonValue> = [(1_u64, "MIXED-TEXT-PAGE-7701 hello there"), (2_u64, "")]
                    .into_iter()
                    .filter(|(page, _)| (from..=to).contains(page))
                    .map(|(page, text)| serde_json::json!({ "page": page, "text": text }))
                    .collect();
                vec![done(serde_json::json!({ "pageCount": 2, "pages": pages }))]
            }
            "pdf.render" => {
                assert_eq!(call.params["pages"], serde_json::json!([2]), "only the page without a text layer is rendered");
                let images = serde_json::json!({ "images": [{ "page": 2, "width": 800, "height": 600, "mimeType": "image/png", "bytes": 4 }] });
                vec![ExtFrame::Chunk(b"PN".to_vec()), ExtFrame::Chunk(b"G2".to_vec()), done(images)]
            }
            "pdf.ocr" => {
                assert_eq!(call.params["pages"], serde_json::json!([2]), "only the page without a text layer is recognized");
                vec![done(serde_json::json!([{ "page": 2, "text": "OCR-READ-PAGE-TWO" }]))]
            }
            other => panic!("unexpected extension call {other}"),
        };
        Ok(Box::new(ScriptedFrames(frames.into())))
    }

    fn status(&self) -> Vec<ExtWorkerStatus> {
        Vec::new()
    }

    fn stop_worker(&self, _worker: ExtWorkerId) -> Result<(), ExtError> {
        Ok(())
    }
}

async fn read_pdf(read: &ReadTool, ctx: &ToolContext, pages: JsonValue) -> ToolOutcome {
    read.call(ctx, serde_json::json!({ "file_path": "mixed.pdf", "pages": pages })).await
}

/// A PDF past the read tool's 10 MiB buffered cap, which the scripted host answers for as it does for `mixed.pdf`.
fn large_pdf() -> Vec<u8> {
    let mut bytes = b"%PDF-1.7 ".to_vec();
    bytes.resize(11 * 1024 * 1024, b'x');
    bytes
}

/// An extension host that extracts an OOXML file, answering with the output budget it was asked for.
struct ScriptedOoxmlHost;








// ---- turn review ----

/// A turn review that keeps the calls it was told about and answers a card diff for each.
#[derive(Default)]
struct FakeReview {
    calls: std::sync::Mutex<Vec<(String, String, String, Vec<mixdog_core_api::turn_review::CallChange>)>>,
}

#[async_trait::async_trait]
impl mixdog_core_api::turn_review::TurnReviewApi for FakeReview {
    async fn record_call(&self, call_id: &str, session_id: &str, base_path: &str, changes: Vec<mixdog_core_api::turn_review::CallChange>) {
        self.calls.lock().unwrap().push((call_id.to_owned(), session_id.to_owned(), base_path.to_owned(), changes));
    }
    async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<mixdog_core_api::turn_review::CallChange>) {}
    fn take_call_diff(&self, call_id: &str) -> Option<String> {
        self.calls.lock().unwrap().iter().any(|c| c.0 == call_id).then(|| format!("card:{call_id}"))
    }
    fn note_change(&self, _: Option<&[String]>) {}
    async fn begin_turn(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::TurnOpen) -> Option<mixdog_core_api::turn_review::TurnToken> {
        None
    }
    async fn complete_turn(&self, _: &str, _: Option<&mixdog_core_api::turn_review::TurnToken>) -> bool {
        false
    }
    fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn mixdog_core_api::turn_review::AgentReview>> {
        None
    }
    fn forget_session(&self, _: &str) {}
    async fn turn_review_diff(&self, _: &str, _: &str, _: mixdog_core_api::turn_review::ReviewRead) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn session_review_diff(&self, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn session_review_file_patch(&self, _: &str, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn turn_review_file_patch(&self, _: &str, _: &str, _: &str) -> mixdog_core_api::turn_review::Reply {
        Default::default()
    }
    async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn turn_changes(&self, _: &str, _: mixdog_core_api::turn_review::ChangesRead) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
    async fn clear_change_history(&self, _: &str) -> Result<mixdog_core_api::turn_review::Reply, mixdog_core_api::turn_review::ReviewError> {
        Ok(Default::default())
    }
}

fn card_of(output: &ToolOutput) -> Option<&str> {
    output.meta.as_ref().and_then(|m| m["uiDiff"].as_str())
}
/// A link whose real path is a UNC share or a device namespace is refused by `read`: opening it would authenticate to
/// a remote host (Node's `symlinkTargetGuard`).
#[test]
fn a_link_to_a_unc_share_or_a_device_namespace_is_refused_by_read() {
    use super::common::target_refusal;
    assert_eq!(
        target_refusal(Path::new("//srv/share/f.txt"), "docs/f.txt").as_deref(),
        Some("Error: cannot read UNC / SMB path via symlink (network credential leak risk): docs/f.txt → //srv/share/f.txt")
    );
    assert_eq!(target_refusal(Path::new("/tmp/ordinary"), "p"), None);
}

// ---- locks, renames, rollback bounds ----

fn link_dir(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().is_ok_and(|o| o.status.success());
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(target, link).is_ok();
    linked
}

pub(super) fn small_dir() -> (tempfile::TempDir, AbsPath) {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    (dir, root)
}

fn local_ctx_files() -> Arc<dyn FileService> {
    Arc::new(mixdog_workspace::localfs::LocalFileService::new())
}

/// The local file service, except that removing `a.txt` fails as a busy file does.
struct BusyRemove(Arc<dyn FileService>);

#[cfg(windows)]
const BUSY: i32 = 32;
#[cfg(unix)]
const BUSY: i32 = libc::EBUSY;

#[async_trait::async_trait]
impl FileService for BusyRemove {
    async fn stat(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.stat(lane, path).await
    }
    async fn read(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath, range: mixdog_core_api::domain::fs::ReadRange) -> Result<mixdog_core_api::domain::fs::FileBytes, mixdog_core_api::domain::fs::FsError> {
        self.0.read(lane, path, range).await
    }
    async fn list_dir(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<Vec<mixdog_core_api::domain::fs::DirEntry>, mixdog_core_api::domain::fs::FsError> {
        self.0.list_dir(lane, path).await
    }
    async fn write(&self, lane: mixdog_rt::DurabilityIo, request: WriteRequest) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.write(lane, request).await
    }
    async fn write_batch(&self, lane: mixdog_rt::DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<mixdog_core_api::domain::fs::FileStat>, mixdog_core_api::domain::fs::FsError> {
        self.0.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.create_dir(lane, path, recursive).await
    }
    async fn rename(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.rename(lane, from, to, overwrite).await
    }
    async fn copy(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.copy(lane, from, to, overwrite).await
    }
    async fn remove(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        if path.as_path().ends_with("a.txt") {
            return Err(mixdog_core_api::domain::fs::FsError::new(mixdog_core_api::domain::fs::FsErrorKind::Io { os_code: Some(BUSY) }, Some(path)));
        }
        self.0.remove(lane, path, recursive).await
    }
    fn walk(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::WalkRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>> {
        self.0.walk(lane, request)
    }
    fn search_text(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::SearchRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::SearchMatch, mixdog_core_api::domain::fs::FsError>>> {
        self.0.search_text(lane, request)
    }
}
/// A flat-colour 8-bit RGB PNG in stored zlib blocks: the recipe `record_image.mjs` builds, so the
/// bytes can be rebuilt from `image_cases.json` and checked against its recorded hash.
fn flat_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff_u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
        out
    }
    let mut row = vec![0_u8];
    for _ in 0..width {
        row.extend_from_slice(&rgb);
    }
    let raw: Vec<u8> = (0..height).flat_map(|_| row.clone()).collect();
    let (mut a, mut b) = (1_u32, 0_u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65521;
        b = (b + a) % 65521;
    }
    let mut zlib = vec![0x78, 0x01];
    let mut at = 0;
    loop {
        let part = &raw[at..raw.len().min(at + 65535)];
        let last = at + 65535 >= raw.len();
        zlib.push(u8::from(last));
        zlib.extend_from_slice(&(part.len() as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(part.len() as u16)).to_le_bytes());
        zlib.extend_from_slice(part);
        at += 65535;
        if last {
            break;
        }
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &zlib));
    png.extend(chunk(b"IEND", &[]));
    png
}








/// The decided changes to `read`'s delivery (batched windows by requested interval; an explicit read always returns its
/// body), asserted on source text rather than on recordings.
#[path = "read_delivery_tests.rs"]
mod read_delivery_tests;


/// One entry of a summary: its path, its rows by line number, and the number of complete lines its output-cap footer says
/// it delivered (`[lines a-B of N; output capped …]` or `…; B of N lines shown …`), which is how a recording shows that a
/// row past `B` was cut at the byte cap.
struct EntryRows {
    path: String,
    status: String,
    content: Vec<String>,
    rows: std::collections::BTreeMap<u64, String>,
    complete_end: Option<u64>,
}

/// The entries of a summary's text parts: a `path [status]` header opens an entry and each `[lines a-b]` marker is followed
/// by its rows.
fn entry_rows(parts: &[(String, String)]) -> Vec<EntryRows> {
    let header = regex::Regex::new(r"^(.+?) \[(ok|error|absent)\](?: \(truncated \d+L/\d+KB\))?(?: (\[= entry #\d+, identical result omitted\]))?$").unwrap();
    let marker = regex::Regex::new(r"^\[lines (\d+)-(\d+)\]$").unwrap();
    let ranged_cap = regex::Regex::new(r"^\[lines \d+-(\d+) of \d+;[^\]]*output capped").unwrap();
    let shown_cap = regex::Regex::new(r"^\[output capped[^\]]*; (\d+) of \d+ lines shown").unwrap();
    let footer = regex::Regex::new(concat!(
        r"^(?:\[lines \d+-\d+(?: of \d+)?(?:; output capped at [^;\]]+)?(?:; offset:\d+ for more)?",
        r"(?:; lines \d+-\d+ NOT returned \(output budget\) — re-read this file with offset:\d+ limit:\d+)?\]",
        r"|\[output capped at [^;\]]+; (?:\d+ KB file|\d+ of \d+ lines shown \(\d+ KB file\))(?:; offset:\d+ for more)?\]",
        r"|\[window lines \d+-\d+ NOT returned \(output budget\) — re-read this file with offset:\d+ limit:\d+\])$",
    )).unwrap();
    let mut out: Vec<EntryRows> = Vec::new();
    let empty = || EntryRows { path: String::new(), status: String::new(), content: Vec::new(), rows: Default::default(), complete_end: None };
    for (_, text) in parts.iter().filter(|(kind, _)| kind == "text") {
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            if let Some(c) = header.captures(lines[i]) {
                let mut entry = empty();
                entry.path = c[1].to_owned();
                entry.status = c[2].to_owned();
                entry.content.extend(c.get(3).map(|m| m.as_str().to_owned()));
                out.push(entry);
            } else if let Some(c) = marker.captures(lines[i]) {
                // A single read has no header: its rows are one unnamed entry.
                if out.is_empty() {
                    out.push(empty());
                }
                let entry = out.last_mut().unwrap();
                let (start, end): (u64, u64) = (c[1].parse().unwrap(), c[2].parse().unwrap());
                let count = (end + 1).saturating_sub(start) as usize;
                for (k, row) in lines[i + 1..].iter().take(count).enumerate() {
                    entry.rows.insert(start + k as u64, (*row).to_owned());
                }
                i += count;
            } else if !lines[i].is_empty() {
                if let Some(c) = ranged_cap.captures(lines[i]).or_else(|| shown_cap.captures(lines[i])) {
                    if let Some(entry) = out.last_mut() {
                        entry.complete_end = c[1].parse().ok();
                    }
                } else if !footer.is_match(lines[i]) {
                    if out.is_empty() {
                        out.push(empty());
                    }
                    out.last_mut().unwrap().content.push(lines[i].to_owned());
                }
            }
            i += 1;
        }
    }
    out
}

/// Whether a departing case still agrees with the recording: no error; the same entries in the same order; every image
/// part identical; and every row both deliver identical. The one exception: a recorded row that the recording itself shows
/// cut at its byte cap (its last row, one past the complete lines its cap footer counts) may be a prefix of the same row
/// delivered whole, in that direction only. Different window lengths may omit rows, but not every recorded row.
fn agrees_with_recording(got: &[(String, String)], expected: &[(String, String)]) -> bool {
    let media = |parts: &[(String, String)]| parts.iter().filter(|(kind, _)| kind != "text").cloned().collect::<Vec<_>>();
    if media(got) != media(expected) || got.iter().any(|(_, t)| t.starts_with("Error")) {
        return false;
    }
    let (got, expected) = (entry_rows(got), entry_rows(expected));
    got.len() == expected.len()
        && got.iter().zip(&expected).all(|(g, e)| {
            let last = e.rows.keys().next_back().copied();
            let cut_row = e.complete_end.map(|complete| complete + 1).filter(|cut| Some(*cut) == last);
            g.path == e.path
                && g.status == e.status
                && g.content == e.content
                && (e.rows.is_empty() || g.rows.keys().next() == e.rows.keys().next())
                && g.rows.iter().all(|(n, row)| {
                    e.rows.get(n).is_none_or(|recorded| recorded == row || (Some(*n) == cut_row && row.starts_with(recorded.as_str())))
                })
        })
}

fn summary_text(text: &str) -> Vec<(String, String)> {
    vec![("text".to_owned(), text.to_owned())]
}

#[test]
fn the_departure_checker_accepts_equal_rows_and_a_row_the_recording_shows_cut_delivered_whole() {
    let cut = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn tr\n[lines 1-1 of 9; output capped at 1 KB; offset:2 for more]");
    let whole = summary_text("f.txt [ok]\n[lines 1-3]\nfn a() {\nreturn true;\n}\n[lines 1-3 of 9; output capped at 2 KB; offset:4 for more]");
    assert!(agrees_with_recording(&whole, &cut), "the cut row delivered whole agrees");
    assert!(agrees_with_recording(&cut, &cut), "identical output agrees");
    let unranged = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn tr\n\n[output capped at 1 KB; 1 of 9 lines shown (3 KB file); offset:1 for more]");
    assert!(agrees_with_recording(&whole, &unranged), "the cap footer of an unwindowed read shows the cut too");
}

#[test]
fn the_departure_checker_rejects_a_complete_recorded_final_row_that_was_extended() {
    let extended = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn true; WRONG\n[lines 1-2 of 2]");
    let uncapped = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn true;\n[lines 1-2 of 2]");
    assert!(!agrees_with_recording(&extended, &uncapped), "an uncapped recording's rows are compared exactly");
    let complete = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn true;\n[lines 1-2 of 9; output capped at 1 KB; offset:3 for more]");
    assert!(!agrees_with_recording(&extended, &complete), "a capped recording whose footer counts the row complete was not cut");
}

#[test]
fn the_departure_checker_rejects_a_wrongly_shortened_produced_final_row() {
    let complete = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn true;\n[lines 1-2 of 9; output capped at 1 KB; offset:3 for more]");
    let shortened = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn\n[lines 1-2 of 9; output capped at 1 KB; offset:3 for more]");
    assert!(!agrees_with_recording(&shortened, &complete), "only a row the recording shows cut may be the shorter one");
    let cut = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn tr\n[lines 1-1 of 9; output capped at 1 KB; offset:2 for more]");
    let other = summary_text("f.txt [ok]\n[lines 1-2]\nfn a() {\nreturn false;\n[lines 1-2 of 9; output capped at 1 KB; offset:3 for more]");
    assert!(!agrees_with_recording(&other, &cut), "a cut recorded row must be a prefix of the produced one");
    assert!(!agrees_with_recording(&shortened, &cut), "a produced row shorter than the recorded cut row is no extension of it");
}

#[test]
fn the_departure_checker_preserves_entry_status_and_unwindowed_content() {
    let expected = summary_text("read 2\n\nfile with spaces.txt [ok]\n[lines 1-1]\nrow\n\nscan.pdf [ok]\nPDF result");
    for lost in [
        "read 2\n\nfile with spaces.txt [absent]\n[lines 1-1]\nrow\n\nscan.pdf [ok]\nPDF result",
        "read 2\n\nfile with spaces.txt [ok]\n[lines 1-1]\nrow\n\nscan.pdf [ok]",
        "read 2\n\nfile with spaces.txt [ok]\n[lines 9-9]\nunrelated row\n\nscan.pdf [ok]\nPDF result",
        "read 2\n\nfile with spaces.txt [ok]\nscan.pdf [ok]\nPDF result",
    ] {
        assert!(!agrees_with_recording(&summary_text(lost), &expected), "{lost}");
    }
}










/// The local file service, except that stating a file with one of `names` fails, one with a name of the third list
/// never answers (a dead mount) and one named in the control's `delays` answers after that many virtual milliseconds.
pub(super) struct StatFails(pub(super) Arc<dyn FileService>, pub(super) &'static [&'static str], pub(super) &'static [&'static str], pub(super) Arc<StatControl>);

#[derive(Default)]
pub(super) struct StatControl {
    /// Signalled as a stat that never answers starts.
    hung: tokio::sync::Notify,
    delays: &'static [(&'static str, u64)],
    pub(super) reads: Option<std::sync::Mutex<Vec<AbsPath>>>,
    pub(super) stats: Option<std::sync::Mutex<Vec<AbsPath>>>,
    missed_walk_entry: bool,
    pub(super) repeated_walk_entry: Option<DirEntry>,
    reject_probes: bool,
    unprobeable_suffixes: &'static [&'static str],
    fail_first_read: std::sync::atomic::AtomicBool,
}

impl StatControl {
    pub(super) fn record_locator_io() -> Self {
        Self { reads: Some(Default::default()), stats: Some(Default::default()), ..Self::default() }
    }
}

// ---------------------------------------------------------------------------
// One broad search at a time (`search-admission-*`, `record-tools-fs-search.mjs` `recordAdmission`)












/// The local file service, whose walks ignore the caller's name rule: they enter every folder, as an unpruned walk does.
struct Unpruned(Arc<dyn FileService>);

#[async_trait::async_trait]
impl FileService for Unpruned {
    async fn stat(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.stat(lane, path).await
    }
    async fn read(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath, range: mixdog_core_api::domain::fs::ReadRange) -> Result<mixdog_core_api::domain::fs::FileBytes, mixdog_core_api::domain::fs::FsError> {
        self.0.read(lane, path, range).await
    }
    async fn list_dir(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<Vec<mixdog_core_api::domain::fs::DirEntry>, mixdog_core_api::domain::fs::FsError> {
        self.0.list_dir(lane, path).await
    }
    async fn write(&self, lane: mixdog_rt::DurabilityIo, request: WriteRequest) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.write(lane, request).await
    }
    async fn write_batch(&self, lane: mixdog_rt::DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<mixdog_core_api::domain::fs::FileStat>, mixdog_core_api::domain::fs::FsError> {
        self.0.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.create_dir(lane, path, recursive).await
    }
    async fn rename(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.rename(lane, from, to, overwrite).await
    }
    async fn copy(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.copy(lane, from, to, overwrite).await
    }
    async fn remove(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.remove(lane, path, recursive).await
    }
    fn walk(&self, lane: mixdog_rt::MaintenanceIo, mut request: mixdog_core_api::domain::fs::WalkRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>> {
        request.descent.guard = None;
        self.0.walk(lane, request)
    }
    fn search_text(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::SearchRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::SearchMatch, mixdog_core_api::domain::fs::FsError>>> {
        self.0.search_text(lane, request)
    }
}

async fn context(root: &AbsPath) -> ToolContext {
    context_over(root, Arc::new(MockFileService::default())).await
}
async fn context_over(root: &AbsPath, files: Arc<dyn FileService>) -> ToolContext {
    let seeds = seed().into_iter().map(|(rel, bytes)| (rel.to_owned(), bytes)).collect();
    context_seeded(root, files, seeds).await
}
pub(super) async fn context_seeded(root: &AbsPath, files: Arc<dyn FileService>, seeds: Vec<(String, Vec<u8>)>) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    for (rel, bytes) in seeds {
        let path = AbsPath::new(root.as_path().join(rel)).unwrap();
        files
            .create_dir(tokens.durability_io, AbsPath::new(path.as_path().parent().unwrap()).unwrap(), true)
            .await
            .unwrap();
        files
            .write(tokens.durability_io, WriteRequest { path, content: bytes, precondition: WritePrecondition::Unconditional })
            .await
            .unwrap();
    }
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        tool: "fs".into(),
        cwd: root.clone(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        },
        approvals: Arc::new(MockApprovalGate::default()),
        files,
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}
/// Node's answers in `fixtures/tools-fs-search/<scenario>.json` (`record-tools-fs-search.mjs`), replayed whole, in order,
/// over the scenario's workspace on disk. As the recorder does, files are dated 2026-01-02T03:04:05Z unless the scenario
/// dates them, and dated directories are dated after their files are written.
/// `wait`'s outcome; a wait past a minute (a call that never ends: a replayed search's hard timer only passes for a
/// call whose server the recording left silent, and the context has no deadline) fails the replay naming `what`.
async fn within<T>(what: impl FnOnce() -> String, wait: impl Future<Output = T>) -> T {
    const LIMIT: std::time::Duration = std::time::Duration::from_secs(60);
    match tokio::time::timeout(LIMIT, wait).await {
        Ok(value) => value,
        Err(_) => panic!("{} did not end within {LIMIT:?}", what()),
    }
}
/// A replayed call that never ends (its hard timer never passes, the context has no deadline) fails the replay after
/// the wait's limit, naming the call, rather than hanging it.
#[tokio::test(start_paused = true)]
#[should_panic(expected = "grep-timeout #6 grep {\"pattern\":\"needle\"} did not end within 60s")]
async fn a_replayed_call_that_never_ends_fails_naming_it() {
    within(|| "grep-timeout #6 grep {\"pattern\":\"needle\"}".to_owned(), std::future::pending::<()>()).await;
}
/// `arg-guard.mjs` (glob): `sort` is natural or mtime (trimmed) and nothing else; any other value is refused, not read as mtime.
#[tokio::test]
async fn glob_refuses_a_sort_that_is_not_natural_or_mtime_as_node_does() {
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("a.txt"), "x\n").unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    for (sort, got) in [(serde_json::json!("newest"), "\"newest\""), (serde_json::json!(" nat "), "\"nat\""), (serde_json::json!(3), "number"), (serde_json::json!(null), "null")] {
        let (is_error, text) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "sort": sort })).await);
        assert!(is_error, "{text}");
        assert_eq!(text, format!("Error: glob arg \"sort\" must be one of natural|mtime (got {got})"));
    }
    for sort in ["natural", " mtime "] {
        let (is_error, text) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "*.txt", "sort": sort })).await);
        assert!(!is_error, "{text}");
    }
}
/// The `meta` mode column is the entry's real permission bits where the OS has them (Node's `mode & 0o7777` of the
/// `lstat`, a mode 000 included); Windows has the server's spelling: 777 for a directory, 666 for a file.
#[tokio::test]
async fn list_meta_reports_the_modes_node_reports() {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(mixdog_workspace::pathguard::canonical(dir.path()).unwrap()).unwrap();
    std::fs::write(root.join("f.txt").as_path(), "x\n").unwrap();
    std::fs::create_dir(root.join("d").as_path()).unwrap();
    std::fs::write(root.join("z.txt").as_path(), "x\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(root.join("z.txt").as_path(), std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::set_permissions(root.join("f.txt").as_path(), std::fs::Permissions::from_mode(0o640)).unwrap();
        std::fs::set_permissions(root.join("d").as_path(), std::fs::Permissions::from_mode(0o750)).unwrap();
    }
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    let (failed, text) = text_of(ListTool::new().call(&ctx, serde_json::json!({ "meta": true })).await);
    assert!(!failed, "{text}");
    let row = |name: &str| {
        text.lines().find(|l| l.split('\t').next() == Some(name)).unwrap_or_else(|| panic!("{text}")).split('\t').nth(4).unwrap().to_owned()
    };
    let (file, dir, none) = if cfg!(windows) { ("666", "777", "666") } else { ("640", "750", "000") };
    assert_eq!((row("f.txt"), row("d"), row("z.txt")), (file.to_owned(), dir.to_owned(), none.to_owned()), "{text}");
}
/// `-i` makes a grep of one root case-insensitive, as ripgrep's `-i` did in Node; without it the case matters.
#[tokio::test]
async fn a_single_root_grep_honours_dash_i() {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(mixdog_workspace::pathguard::canonical(dir.path()).unwrap()).unwrap();
    std::fs::write(root.join("a.txt").as_path(), "Foo\n").unwrap();
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    let (_, plain) = text_of(GrepTool::new().call(&ctx, serde_json::json!({ "pattern": "foo", "mode": "files" })).await);
    let (_, folded) = text_of(GrepTool::new().call(&ctx, serde_json::json!({ "pattern": "foo", "mode": "files", "-i": true })).await);
    assert!(!plain.contains("a.txt"), "{plain}");
    assert!(folded.contains("a.txt"), "{folded}");
}
/// A grep over far more matches than its window: the scan produces exactly the anchor stream's bound (`limit: 10`:
/// `min(4000, max(200, 0 + 10 + 4)) + 1` = 201 of 20,000 matches, no margin), and when the call returns no producer of
/// the search is alive.
#[tokio::test]
async fn a_grep_scan_ends_at_its_window_and_before_the_call_returns() {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(mixdog_workspace::pathguard::canonical(dir.path()).unwrap()).unwrap();
    let body: String = (0..200).map(|i| format!("needle {i}\n")).collect();
    for f in 0..100 {
        std::fs::write(root.join(&format!("f{f:03}.txt")).as_path(), &body).unwrap();
    }
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    let (failed, text) = text_of(GrepTool::new().call(&ctx, serde_json::json!({ "pattern": "needle", "limit": 10 })).await);
    assert!(!failed && text.contains("[warning] anchor output capped at 200 matches"), "{text}");
    let probe = mixdog_workspace::localfs::probe::search(root.as_path());
    assert_eq!(probe, mixdog_workspace::localfs::probe::SearchProbe { found: 201, live: 0 });
}
/// A PDF read is `extractPdfText`'s answer: the pages argument refused in Node's words, a page range as each page's text
/// under the range's header, and a page without a text layer as its page image (the render's chunks joined).
#[tokio::test]
async fn read_answers_a_pdf_by_its_pages_as_node_does() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-pdf").join("ws")).unwrap();
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), vec![("mixed.pdf".to_owned(), b"%PDF-1.7 scripted".to_vec())]).await;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    for (pages, want) in [
        (serde_json::json!(3), "Error: pages must be a string like \"1-5\"; got number"),
        (serde_json::json!("2-x"), "Error: pages \"2-x\" not in \"N\" or \"N-M\" form (1-based positive integers)"),
        (serde_json::json!("0"), "Error: pages \"0\" out of range — page numbers are 1-based"),
        (serde_json::json!("3-1"), "Error: pages \"3-1\" inverted — end (1) precedes start (3)"),
        (serde_json::json!("1-30"), "Error: pages \"1-30\" spans 30 pages; max 20 per request — narrow the range"),
        (serde_json::json!("9"), "Error: pages \"9\" out of range — this PDF has 2 pages"),
        (serde_json::json!(" 1 "), "[PDF mixed.pdf: pages 1-1 of 2; every page has a text layer]\n\n--- Page 1 ---\nMIXED-TEXT-PAGE-7701 hello there"),
    ] {
        assert_eq!(text_of(read_pdf(&read, &ctx, pages.clone()).await).1, want, "pages {pages}");
    }
    let whole = read_pdf(&read, &ctx, JsonValue::Null).await.unwrap();
    assert_eq!(
        whole.parts,
        vec![
            ToolPart::Text(
                "[PDF mixed.pdf: pages 1-2 of 2; scanned (no text layer): 2]\n\n--- Page 1 ---\nMIXED-TEXT-PAGE-7701 hello there\n\n--- Page 2 (scanned; page image follows) ---".to_owned()
            ),
            ToolPart::Image { mime: "image/png".to_owned(), data: ImageData::Bytes(b"PNG2".to_vec()), width: Some(800), height: Some(600) },
        ]
    );
}

#[tokio::test]
async fn read_does_not_attach_a_short_pdf_image_stream() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), vec![("mixed.pdf".to_owned(), b"%PDF-1.7 scripted".to_vec())]).await;
    let read = ReadTool::new(Some(Arc::new(ShortPdfImageHost)), None);
    let output = read_pdf(&read, &ctx, serde_json::json!("2")).await.unwrap();
    assert!(matches!(output.parts.as_slice(), [ToolPart::Text(text)] if text.contains("page image could not be rendered")));
}
/// A model that sees no images gets a scanned page as the OCR engine's text (`pageMode: 'ocr'`), titled as such.
#[tokio::test]
async fn read_gives_a_text_only_model_the_ocr_text_of_a_scanned_page() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-pdf-ocr").join("ws")).unwrap();
    let mut ctx = context_seeded(&root, Arc::new(MockFileService::default()), vec![("mixed.pdf".to_owned(), b"%PDF-1.7 scripted".to_vec())]).await;
    ctx.options.pdf_page_ocr = true;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    assert_eq!(
        text_of(read_pdf(&read, &ctx, JsonValue::Null).await).1,
        "[PDF mixed.pdf: pages 1-2 of 2; scanned (no text layer): 2]\n\n--- Page 1 ---\nMIXED-TEXT-PAGE-7701 hello there\n\n--- Page 2 (OCR of a scanned page) ---\nOCR-READ-PAGE-TWO"
    );
}
/// A PDF past the 10 MiB buffered cap goes to `extractPdfText` like any other (`readMediaFile` comes before the size
/// cap), not to the binary preview of a large file.
#[tokio::test]
async fn read_answers_a_pdf_past_the_buffered_cap_by_its_pages_as_node_does() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-pdf-large").join("ws")).unwrap();
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), vec![("big.pdf".to_owned(), large_pdf())]).await;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    let whole = read.call(&ctx, serde_json::json!({ "file_path": "big.pdf" })).await.unwrap();
    assert_eq!(
        whole.parts[0],
        ToolPart::Text(
            "[PDF big.pdf: pages 1-2 of 2; scanned (no text layer): 2]\n\n--- Page 1 ---\nMIXED-TEXT-PAGE-7701 hello there\n\n--- Page 2 (scanned; page image follows) ---".to_owned()
        )
    );
}
/// A short PDF read whole by a session whose provider takes PDFs natively and whose model sees images is the document
/// itself (`mode === 'image' && nativeDocument`), up to `MAX_PDF_BYTES` whatever the buffered cap; a page range, a batch
/// entry and a model that sees no images still read the pages.
#[tokio::test]
async fn read_answers_a_short_pdf_with_the_document_when_the_model_reads_pdfs_natively() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-pdf-native").join("ws")).unwrap();
    let seeds = vec![("mixed.pdf".to_owned(), b"%PDF-1.7 scripted".to_vec()), ("big.pdf".to_owned(), large_pdf())];
    let mut ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    ctx.options.pdf_native_document = true;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    let pages = "[PDF mixed.pdf: pages 1-2 of 2; scanned (no text layer): 2]\n\n--- Page 1 ---\nMIXED-TEXT-PAGE-7701 hello there\n\n--- Page 2 (scanned; page image follows) ---";
    assert_eq!(text_of(read_pdf(&read, &ctx, JsonValue::Null).await).1, pages, "a model that sees no images reads the pages");
    ctx.options.pdf_page_images = true;
    let document = |data: Vec<u8>| vec![ToolPart::Document { mime: "application/pdf".to_owned(), data }];
    assert_eq!(read_pdf(&read, &ctx, JsonValue::Null).await.unwrap().parts, document(b"%PDF-1.7 scripted".to_vec()));
    assert_eq!(read.call(&ctx, serde_json::json!({ "file_path": "big.pdf" })).await.unwrap().parts, document(large_pdf()));
    assert_eq!(
        text_of(read_pdf(&read, &ctx, serde_json::json!("1")).await).1,
        "[PDF mixed.pdf: pages 1-1 of 2; every page has a text layer]\n\n--- Page 1 ---\nMIXED-TEXT-PAGE-7701 hello there"
    );
    let batch = read.call(&ctx, serde_json::json!({ "file_path": ["mixed.pdf", "big.pdf"] })).await.unwrap();
    assert!(batch.parts.iter().all(|part| matches!(part, ToolPart::Text(_))), "{batch:?}");
}

#[tokio::test]
async fn read_rejects_native_pdf_bytes_that_differ_from_the_inspected_pdf() {
    let (_dir, root) = small_dir();
    let seeds = vec![("mixed.pdf".to_owned(), b"%PDF-1.7 modified".to_vec())];
    let mut ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    ctx.options.pdf_native_document = true;
    ctx.options.pdf_page_images = true;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost)), None);
    let (failed, text) = text_of(read_pdf(&read, &ctx, JsonValue::Null).await);
    assert!(failed && text.contains("changed during inspection"), "{text}");
}

#[tokio::test]
async fn read_applies_an_explicit_page_range_to_each_pdf_in_a_batch() {
    let (_dir, root) = small_dir();
    let seeds = ["a.pdf", "b.pdf"].map(|name| (name.to_owned(), b"%PDF-1.7 scripted".to_vec())).to_vec();
    let mut ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    ctx.options.pdf_page_images = true;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    let batch = read.call(&ctx, serde_json::json!({ "file_path": ["a.pdf", "b.pdf"], "pages": "2" })).await.unwrap();
    assert_eq!(batch.parts.len(), 7);
    for (parts, name) in batch.parts[1..].chunks_exact(3).zip(["a.pdf", "b.pdf"]) {
        assert_eq!(parts[0], ToolPart::Text(format!("{name} [ok]")));
        let ToolPart::Text(text) = &parts[1] else { panic!("{parts:?}") };
        assert!(text.starts_with(&format!("[PDF {name}: pages 2-2 of 2; scanned (no text layer): 2]")), "{text}");
        assert!(!text.contains("MIXED-TEXT-PAGE-7701"), "{text}");
        assert!(matches!(&parts[2], ToolPart::Image { data: ImageData::Bytes(bytes), .. } if bytes.as_slice() == b"PNG2"));
    }
}

#[tokio::test]
async fn read_applies_an_explicit_page_range_with_ocr_to_each_pdf_matched_by_a_glob() {
    let (_dir, root) = small_dir();
    let seeds = ["a.pdf", "b.pdf"].map(|name| (name.to_owned(), b"%PDF-1.7 scripted".to_vec())).to_vec();
    let mut ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    ctx.options.pdf_page_ocr = true;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    let out = text_of(read.call(&ctx, serde_json::json!({ "file_path": "*.pdf", "pages": "2" })).await).1;
    for name in ["a.pdf", "b.pdf"] {
        assert!(out.contains(&format!("{name} [ok]\n[PDF {name}: pages 2-2 of 2; scanned (no text layer): 2]")), "{out}");
    }
    assert_eq!(out.matches("OCR-READ-PAGE-TWO").count(), 2, "{out}");
    assert!(!out.contains("MIXED-TEXT-PAGE-7701"), "{out}");
}

#[tokio::test]
async fn read_keeps_media_rows_and_the_skipped_path_in_a_partial_batch() {
    let (_dir, root) = small_dir();
    let names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt", "h.txt", "i.txt"];
    let mut seeds = vec![("scan.pdf".to_owned(), b"%PDF-1.7 scripted".to_vec())];
    seeds.extend(names.iter().map(|&name| (name.to_owned(), format!("row-{name}\n").into_bytes())));
    seeds.push(("skipped.txt".to_owned(), b"undelivered".to_vec()));
    let mut ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    ctx.options.pdf_page_images = true;
    let read = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    let file_path: Vec<_> = ["scan.pdf"].into_iter().chain(names).chain(["skipped.txt"]).collect();
    let out = read.call(&ctx, serde_json::json!({ "file_path": file_path, "pages": "2" })).await.unwrap();
    assert_eq!(out.meta.unwrap()["complete"], false);
    assert_eq!(out.parts.iter().filter(|part| matches!(part, ToolPart::Image { .. })).count(), 1);
    let text = out.parts.iter().filter_map(|part| match part { ToolPart::Text(s) => Some(s.as_str()), _ => None }).collect::<Vec<_>>().join("\n");
    for name in names {
        assert!(text.contains(&format!("{name} [ok]\n[lines 1-1]\nrow-{name}")), "{text}");
    }
    assert!(text.contains("[skipped 1 more file(s) over the per-call limit: skipped.txt — read them in another call]"), "{text}");
    assert!(!text.contains("undelivered"), "{text}");
}

impl ExtPool for ScriptedOoxmlHost {
    fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
        assert_eq!(call.method, "ooxml.text", "only an OOXML file goes to the extractor");
        let text = format!("OOXML within {}", call.params["maxOutputBytes"]);
        Ok(Box::new(ScriptedFrames(vec![ExtFrame::Done(Ok(serde_json::json!({ "text": text })))].into())))
    }

    fn status(&self) -> Vec<ExtWorkerStatus> {
        Vec::new()
    }

    fn stop_worker(&self, _worker: ExtWorkerId) -> Result<(), ExtError> {
        Ok(())
    }
}
/// An OOXML file is `extractOoxmlText`'s text within the read's 50 KiB output budget (`READ_MAX_OUTPUT_BYTES`), on its
/// own and in a batch.
#[tokio::test]
async fn read_extracts_an_ooxml_file_within_the_read_budget_as_node_does() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-ooxml").join("ws")).unwrap();
    let seeds = vec![("report.docx".to_owned(), b"PK\x03\x04[Content_Types].xml".to_vec()), ("plain.txt".to_owned(), b"plain\n".to_vec())];
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let read = ReadTool::new(Some(Arc::new(ScriptedOoxmlHost) as Arc<dyn ExtPool>), None);
    let budget = format!("OOXML within {}", 50 * 1024);
    assert_eq!(text_of(read.call(&ctx, serde_json::json!({ "file_path": "report.docx" })).await).1, budget);
    let batch = read.call(&ctx, serde_json::json!({ "file_path": ["report.docx", "plain.txt"] })).await.unwrap();
    assert!(batch.parts.iter().any(|part| matches!(part, ToolPart::Text(text) if text.contains(&budget))), "{batch:?}");
}
/// `readMediaFile` records a read snapshot for an OOXML file and none for a PDF.
#[tokio::test]
async fn read_records_a_snapshot_for_an_ooxml_file_and_none_for_a_pdf_as_node_does() {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    let seeds = vec![("mixed.pdf".to_owned(), b"%PDF-1.7 scripted".to_vec()), ("report.docx".to_owned(), b"PK[Content_Types].xml".to_vec())];
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), seeds).await;
    let state = Arc::new(ReadState::new(None));
    let pdf = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None).with_state(Arc::clone(&state));
    let ooxml = ReadTool::new(Some(Arc::new(ScriptedOoxmlHost) as Arc<dyn ExtPool>), None).with_state(Arc::clone(&state));
    read_pdf(&pdf, &ctx, serde_json::json!("1")).await.unwrap();
    ooxml.call(&ctx, serde_json::json!({ "file_path": "report.docx" })).await.unwrap();
    let snapshot = |name: &str| state.snapshot(Some("t"), &read_state_key(&root.as_path().join(name)));
    assert!(snapshot("mixed.pdf").is_none(), "a PDF read records no snapshot");
    assert!(snapshot("report.docx").is_some(), "an OOXML read records one");
}
/// A repeated read returns the body (decided departure: Node answered `[file unchanged]`); a same-size rewrite that keeps
/// the file's modification time returns the new bytes.
#[tokio::test]
async fn a_same_size_rewrite_with_the_old_modification_time_is_read_again_not_called_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), vec![("a.txt".to_owned(), b"one\n".to_vec())]).await;
    let state = Arc::new(ReadState::new(None));
    let read = ReadTool::new(None, None).with_state(Arc::clone(&state));
    let first = text_of(read.call(&ctx, serde_json::json!({ "file_path": "a.txt" })).await).1;
    assert!(first.contains("one"), "{first}");
    let again = text_of(read.call(&ctx, serde_json::json!({ "file_path": "a.txt" })).await).1;
    assert!(again.contains("one") && !again.starts_with("[file unchanged"), "a repeated read returns the body: {again}");
    let path = root.as_path().join("a.txt");
    let stamp = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, b"two\n").unwrap();
    std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(stamp).unwrap();
    let after = text_of(read.call(&ctx, serde_json::json!({ "file_path": "a.txt" })).await).1;
    assert!(after.contains("two") && !after.starts_with("[file unchanged"), "{after}");
}
/// A file is a document by its name, as `readMediaFile` tells it: a PDF by `.pdf`, or by its signature only on a path with
/// no extension; an OOXML file by its extension. A text file that starts like a PDF reads as text, and an OOXML package
/// under any other name is a binary file.
#[tokio::test]
async fn read_tells_a_document_by_its_name_as_node_does() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-document-kind").join("ws")).unwrap();
    let package = b"PK\x03\x04\x14\x00\x00\x00[Content_Types].xml".to_vec();
    let seeds = vec![
        ("pdf-magic.txt".to_owned(), b"%PDF-1.4 this is really a text file\nsecond line\n".to_vec()),
        ("archive.zip".to_owned(), package.clone()),
        ("template.xltx".to_owned(), package.clone()),
        ("noext-office".to_owned(), package),
        ("noext-pdf".to_owned(), b"%PDF-1.7 scripted".to_vec()),
    ];
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    // The OOXML host fails the test on any call but `ooxml.text`: none of these files reaches the PDF extractor.
    let read = ReadTool::new(Some(Arc::new(ScriptedOoxmlHost) as Arc<dyn ExtPool>), None);
    let text = text_of(read.call(&ctx, serde_json::json!({ "file_path": "pdf-magic.txt" })).await).1;
    assert!(text.contains("%PDF-1.4 this is really a text file") && text.contains("second line"), "{text}");
    for name in ["archive.zip", "template.xltx", "noext-office"] {
        let text = text_of(read.call(&ctx, serde_json::json!({ "file_path": name })).await).1;
        assert!(text.contains("\nbinary, 27 bytes\n50 4b 03 04"), "{name}: {text}");
    }
    let pdf = ReadTool::new(Some(Arc::new(ScriptedPdfHost) as Arc<dyn ExtPool>), None);
    let text = text_of(pdf.call(&ctx, serde_json::json!({ "file_path": "noext-pdf" })).await).1;
    assert!(text.starts_with("[PDF "), "{text}");
}
/// `countTextStatsStreaming`, `streamHeadWindow`, the tail window and the summary scan: a glance mode over a text file past the
/// buffered range size decodes the invalid UTF-8 bytes as U+FFFD, while a small one still reports the invalid encoding. The calls name `path`: a `file_path` call always carries a window, which beats `head` (Node `executeReadTool`) and decodes lossily.
#[tokio::test]
async fn count_of_a_streaming_size_file_with_invalid_utf8_decodes_it_lossily() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-count-lossy").join("ws")).unwrap();
    let mut big = b"alpha \xff beta\n".to_vec();
    big.resize(130 * 1024, b'x');
    let seeds = vec![("big.txt".to_owned(), big.clone()), ("small.txt".to_owned(), b"alpha \xff beta\n".to_vec())];
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let read = ReadTool::new(None, None);
    let counted = text_of(read.call(&ctx, serde_json::json!({ "path": "big.txt", "mode": "count" })).await).1;
    assert_eq!(counted, format!("lines\t2\twords\t4\tbytes\t{}", big.len()));
    let head = text_of(read.call(&ctx, serde_json::json!({ "path": "big.txt", "mode": "head" })).await).1;
    assert!(head.contains("alpha \u{fffd} beta"), "{head}");
    let tail = text_of(read.call(&ctx, serde_json::json!({ "path": "big.txt", "mode": "tail", "n": 1 })).await).1;
    assert!(!tail.starts_with("Error:"), "{tail}");
    for mode in ["count", "head"] {
        let small = text_of(read.call(&ctx, serde_json::json!({ "path": "small.txt", "mode": mode })).await).1;
        assert!(small.starts_with("Error: invalid UTF-8 in text file"), "{mode}: {small}");
    }
}
/// Two routes to one file (a symlinked directory and its referent) share a lock: an edit through
/// the link waits for a holder of the referent's own path.
#[tokio::test]
async fn an_edit_through_a_symlink_waits_for_the_referents_lock() {
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    std::fs::write(root.as_path().join("real").join("a.txt"), "one two\n").unwrap();
    let link = root.as_path().join("link");
    // A junction needs no privilege, unlike a Windows symlink; it routes to the file the same way.
    #[cfg(windows)]
    let linked = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(root.as_path().join("real"))
        .output()
        .map_err(|e| e.to_string())
        .and_then(|o| if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stdout).into_owned()) });
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(root.as_path().join("real"), &link);
    // Creating a symlink needs a privilege some Windows accounts lack; there is nothing to
    // serialise without one.
    if let Err(error) = linked {
        eprintln!("symlink test skipped: {error}");
        return;
    }
    let ctx = Arc::new(
        context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await,
    );
    let referent = std::fs::canonicalize(root.as_path().join("real").join("a.txt")).unwrap();
    let referent = AbsPath::new(referent.to_string_lossy().trim_start_matches(r"\\?\")).unwrap();
    let held = crate::git::path_locks::lock_paths(&[referent.as_path()], &ctx.cancel).await.unwrap();

    let through_link = {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let args = serde_json::json!({ "file_path": "link/a.txt", "old_string": "one", "new_string": "ONE" });
            text_of(EditTool::new().call(&ctx, args).await)
        })
    };
    mixdog_rt::time::sleep(Duration::from_millis(100)).await;
    assert!(!through_link.is_finished(), "an edit through a symlink ran under its referent's lock");
    drop(held);
    let (is_error, text) = through_link.await.unwrap();
    assert!(!is_error, "{text}");
    assert_eq!(std::fs::read_to_string(root.as_path().join("real").join("a.txt")).unwrap(), "ONE two\n");
}
#[tokio::test]
async fn writes_to_one_path_wait_for_its_path_lock() {
    use std::time::Duration;

    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-lock").join("ws")).unwrap();
    let ctx = Arc::new(context(&root).await);
    let readme = AbsPath::new(root.as_path().join("README.md")).unwrap();

    // A holder of the README lock (a git write in that work tree, or another session's edit).
    let held = crate::git::path_locks::lock_paths(&[readme.as_path()], &ctx.cancel).await.unwrap();

    let spawn_edit = |old: &'static str, new: &'static str, file: &'static str| {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let args = serde_json::json!({ "file_path": file, "old_string": old, "new_string": new });
            text_of(EditTool::new().call(&ctx, args).await)
        })
    };
    let first = spawn_edit("alpha", "ALPHA", "README.md");
    let second = spawn_edit("gamma", "GAMMA", "README.md");
    // A different path is not held up.
    let unrelated = spawn_edit("line-1\n", "LINE-1\n", "lines.txt");
    let (unrelated_error, text) = unrelated.await.unwrap();
    assert!(!unrelated_error, "{text}");

    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    assert!(!first.is_finished() && !second.is_finished(), "edits ran under a held path lock");
    drop(held);

    // Serialized, both land: neither sees the other's write as a stale precondition.
    for task in [first, second] {
        let (is_error, text) = task.await.unwrap();
        assert!(!is_error, "{text}");
    }
    let bytes = ctx.files.read(ctx.io.interactive, readme, Default::default()).await.unwrap().bytes;
    assert_eq!(String::from_utf8(bytes).unwrap(), "# Fixture\n\nALPHA beta\nGAMMA\n");
}
/// A committed patch joins the turn review with the targets it really changed (a move carries its
/// destination) and hands its card diff back; a dry run, a failed patch and an untouched file
/// record nothing.
#[tokio::test]
async fn committed_writes_join_the_turn_review_and_carry_the_card_diff() {
    use mixdog_core_api::turn_review::CallChange;
    use mixdog_core_api::turn_review::ReviewContent;

    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    std::fs::write(root.as_path().join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(root.as_path().join("old.txt"), "keep\nme\n").unwrap();
    std::fs::write(root.as_path().join("bin.dat"), [0x61u8, 0, 0x62, 0x80, 0, 1]).unwrap();
    let review = Arc::new(FakeReview::default());
    let mut ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), Vec::new()).await;
    ctx.review = Some(review.clone());
    let path = |name: &str| root.as_path().join(name).to_string_lossy().into_owned();

    // A dry run and a refused patch leave no entry.
    let dry = serde_json::json!({ "patch": "*** Update File: a.txt\n@@\n-one\n+ONE\n", "dry_run": true });
    assert!(card_of(&ApplyPatchTool::new().call(&ctx, dry).await.unwrap()).is_none());
    let stale = serde_json::json!({ "patch": "*** Update File: a.txt\n@@\n-nope\n+X\n" });
    assert!(ApplyPatchTool::new().call(&ctx, stale).await.is_err());
    assert!(review.calls.lock().unwrap().is_empty());

    // A move that also edits: one change carrying both ends.
    let moved = serde_json::json!({ "patch": "*** Update File: a.txt\n*** Move to: b.txt\n@@\n-one\n+ONE\n" });
    let output = ApplyPatchTool::new().call(&ctx, moved).await.unwrap();
    assert_eq!(card_of(&output), Some("card:c"));
    {
        let calls = review.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let (call, session, base, changes) = &calls[0];
        assert_eq!((call.as_str(), session.as_str(), base.as_str()), ("c", "t", root.as_path().to_string_lossy().as_ref()));
        assert_eq!(
            changes,
            &vec![CallChange {
                path: path("a.txt"),
                new_path: Some(path("b.txt")),
                before: ReviewContent::bytes(&b"one\ntwo\n"[..]),
                after: ReviewContent::bytes(&b"ONE\ntwo\n"[..]),
            }]
        );
    }

    // A delete of an unreadable-as-text file is listed as omitted, never as empty bytes.
    review.calls.lock().unwrap().clear();
    let gone = serde_json::json!({ "patch": "*** Delete File: bin.dat\n*** Update File: old.txt\n@@\n-keep\n+KEEP\n" });
    ApplyPatchTool::new().call(&ctx, gone).await.unwrap();
    {
        let calls = review.calls.lock().unwrap();
        let changes = &calls[0].3;
        assert_eq!(changes.len(), 2);
        let bin = changes.iter().find(|c| c.path == path("bin.dat")).unwrap();
        assert_eq!(bin.before, ReviewContent::Omitted { size: 6, reason: Some("binary".to_owned()) });
        assert_eq!(bin.after, ReviewContent::Absent);
        let old = changes.iter().find(|c| c.path == path("old.txt")).unwrap();
        assert_eq!((&old.before, &old.after), (&ReviewContent::bytes(&b"keep\nme\n"[..]), &ReviewContent::bytes(&b"KEEP\nme\n"[..])));
    }

    // `edit` records its write too: a replacement, then a created file.
    review.calls.lock().unwrap().clear();
    let edit = serde_json::json!({ "file_path": "old.txt", "old_string": "me", "new_string": "you" });
    let output = EditTool::new().call(&ctx, edit).await.unwrap();
    assert_eq!(card_of(&output), Some("card:c"));
    let create = serde_json::json!({ "file_path": "fresh.txt", "old_string": "", "new_string": "hi\n" });
    EditTool::new().call(&ctx, create).await.unwrap();
    let calls = review.calls.lock().unwrap();
    assert_eq!(calls[0].3[0].before, ReviewContent::bytes(&b"KEEP\nme\n"[..]));
    assert_eq!(calls[0].3[0].after, ReviewContent::bytes(&b"KEEP\nyou\n"[..]));
    assert_eq!(calls[1].3[0].before, ReviewContent::Absent);
    assert_eq!(calls[1].3[0].after, ReviewContent::bytes(&b"hi\n"[..]));
}
/// `edit(real/a.txt)` and `apply_patch(alias/a.txt)` reach one file through a junction: run
/// together they serialize and both edits land, whichever way each is spelled.
#[tokio::test]
async fn edit_and_apply_patch_through_a_junction_serialize_and_keep_both_edits() {
    let (_dir, root) = small_dir();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    std::fs::write(root.as_path().join("real").join("a.txt"), "one\ntwo\nthree\n").unwrap();
    if !link_dir(&root.as_path().join("alias"), &root.as_path().join("real")) {
        eprintln!("junction test skipped");
        return;
    }
    let ctx = Arc::new(context_seeded(&root, local_ctx_files(), Vec::new()).await);
    for round in 0..6 {
        std::fs::write(root.as_path().join("real").join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let edit = {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let args = serde_json::json!({ "file_path": "real/a.txt", "old_string": "one", "new_string": "ONE" });
                text_of(EditTool::new().call(&ctx, args).await)
            })
        };
        let patch = {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let args = serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: alias/a.txt\n@@\n-three\n+THREE\n*** End Patch\n" });
                text_of(ApplyPatchTool::new().call(&ctx, args).await)
            })
        };
        for task in [edit, patch] {
            let (is_error, text) = task.await.unwrap();
            assert!(!is_error, "round {round}: {text}");
        }
        assert_eq!(std::fs::read_to_string(root.as_path().join("real").join("a.txt")).unwrap(), "ONE\ntwo\nTHREE\n", "round {round}");
    }
}
/// A holder of the real file's in-process lock holds up a patch aimed at it through a junction.
#[tokio::test]
async fn apply_patch_through_a_junction_waits_for_the_referents_lock() {
    use std::time::Duration;
    let (_dir, root) = small_dir();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    std::fs::write(root.as_path().join("real").join("a.txt"), "one\n").unwrap();
    if !link_dir(&root.as_path().join("alias"), &root.as_path().join("real")) {
        return;
    }
    let ctx = Arc::new(context_seeded(&root, local_ctx_files(), Vec::new()).await);
    let referent = super::advisory::canonical_lock_target(&root.as_path().join("alias").join("a.txt"));
    let held = crate::git::path_locks::lock_paths(&[referent.as_path()], &ctx.cancel).await.unwrap();
    let task = {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let args = serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: alias/a.txt\n@@\n-one\n+ONE\n*** End Patch\n" });
            text_of(ApplyPatchTool::new().call(&ctx, args).await)
        })
    };
    mixdog_rt::time::sleep(Duration::from_millis(150)).await;
    assert!(!task.is_finished(), "a patch through a junction ran under its referent's lock");
    drop(held);
    let (is_error, text) = task.await.unwrap();
    assert!(!is_error, "{text}");
}
/// The advisory lock excludes another holder of the same real file, takes a lock a dead process
/// left, and releases only a lock that still carries its own token.
#[tokio::test]
async fn the_advisory_lock_waits_for_a_live_holder_reclaims_a_dead_one_and_releases_only_its_own() {
    use std::time::Duration;
    let (_dir, root) = small_dir();
    let locks = root.as_path().join("locks");
    let ctx = context(&root).await;
    let target = root.as_path().join("t.txt");
    let (short, poll) = (Duration::from_millis(200), Duration::from_millis(10));

    let first = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], short, poll).await.unwrap();
    let blocked = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], short, poll).await.err().expect("a held lock is not shared");
    let file = super::advisory::lock_file_for(&locks, &target);
    assert_eq!(
        blocked.message_for_model,
        format!("Error: advisory lock timeout: {} ({}) held by pid {}", target.display(), file.display(), std::process::id())
    );
    // The blocked waiter left the holder's token alone, and another file is not held by it.
    let holder_token = std::fs::read_to_string(&file).unwrap();
    assert!(holder_token.starts_with(&format!("{}.", std::process::id())), "{holder_token}");
    let independent = root.as_path().join("independent.md");
    drop(super::advisory::lock_in(&ctx, &locks, &[independent.as_path()], short, poll).await.expect("an independent file is free"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), holder_token);
    drop(first);
    assert!(!file.exists());
    let second = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], short, poll).await.unwrap();
    // Another process took the file over meanwhile: this holder must not delete it.
    std::fs::write(&file, "1.someone-else").unwrap();
    drop(second);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "1.someone-else");

    // A lock whose holder is gone is cleared and taken.
    std::fs::write(&file, "2147483646.deadbeef").unwrap();
    let taken = super::advisory::lock_in(&ctx, &locks, &[target.as_path()], Duration::from_secs(2), poll).await.unwrap();
    assert!(std::fs::read_to_string(&file).unwrap().starts_with(&format!("{}.", std::process::id())));
    drop(taken);
    let left: Vec<_> = std::fs::read_dir(&locks).unwrap().map(|entry| entry.unwrap().file_name()).collect();
    assert!(left.is_empty(), "lock files left after the reclaimed lock was released: {left:?}");
    // One real file under two spellings is one lock, taken once.
    let again = root.as_path().join("sub").join("..").join("t.txt");
    let both = super::advisory::lock_in(&ctx, &locks, &[target.as_path(), again.as_path()], short, poll).await;
    assert!(both.is_ok());
}
/// `edit` and `apply_patch` wait for another process holding the file's advisory lock.
#[tokio::test]
async fn edit_and_apply_patch_wait_for_the_advisory_lock_of_their_file() {
    use std::time::Duration;
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("a.txt"), "one\n").unwrap();
    std::fs::write(root.as_path().join("b.txt"), "two\n").unwrap();
    let ctx = Arc::new(context_seeded(&root, local_ctx_files(), Vec::new()).await);
    for (name, is_edit) in [("a.txt", true), ("b.txt", false)] {
        let lock_file = super::advisory::lock_file_for(&super::advisory::lock_directory(), &root.as_path().join(name));
        std::fs::create_dir_all(lock_file.parent().unwrap()).unwrap();
        std::fs::write(&lock_file, format!("{}.foreign", std::process::id())).unwrap();
        let task = {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let args = if is_edit {
                    serde_json::json!({ "file_path": "a.txt", "old_string": "one", "new_string": "ONE" })
                } else {
                    serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: b.txt\n@@\n-two\n+TWO\n*** End Patch\n" })
                };
                text_of(if is_edit { EditTool::new().call(&ctx, args).await } else { ApplyPatchTool::new().call(&ctx, args).await })
            })
        };
        mixdog_rt::time::sleep(Duration::from_millis(200)).await;
        assert!(!task.is_finished(), "{name} was written under another holder's advisory lock");
        std::fs::remove_file(&lock_file).unwrap();
        let (is_error, text) = task.await.unwrap();
        assert!(!is_error, "{text}");
    }
}
/// `edit` refuses the targets Node's `guardWritePath` refuses, in its words, before touching them:
/// a UNC share, a device, and on Windows a trailing dot or a stream suffix. Nothing is written.
#[tokio::test]
async fn edit_refuses_the_write_targets_node_refuses() {
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("keep.txt"), "keep me\n").unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let ads = "Error: cannot write Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard)";
    let mut cases = vec![
        ("//127.0.0.1/no-such-share/x.txt", "", "Error: cannot write UNC / SMB path (network credential leak risk): //127.0.0.1/no-such-share/x.txt".to_owned()),
        ("/dev/zero", "a", "Error: cannot write device file (would block or corrupt a device): /dev/zero".to_owned()),
    ];
    if cfg!(windows) {
        cases.extend([
            ("keep.txt.", "keep me", format!("{ads}: keep.txt.")),
            ("dir./new.txt", "", format!("{ads}: dir./new.txt")),
            ("ads.txt:hidden", "", format!("{ads}: ads.txt:hidden")),
            ("NUL", "", "Error: cannot write Windows device path (reserved name or raw-device namespace): NUL".to_owned()),
        ]);
    }
    for (path, old, want) in cases {
        let args = serde_json::json!({ "file_path": path, "old_string": old, "new_string": "CHANGED\n" });
        assert_eq!(text_of(EditTool::new().call(&ctx, args).await), (true, want), "{path}");
    }
    assert_eq!(std::fs::read_to_string(root.as_path().join("keep.txt")).unwrap(), "keep me\n");
    let names: Vec<_> = std::fs::read_dir(root.as_path()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["keep.txt"]);
}
/// B-1: the public guard's default limit is not a range, so a notebook named without a window reads; one named with a
/// window is still refused.
#[tokio::test]
async fn a_notebook_read_without_a_window_is_not_refused() {
    let (_dir, root) = small_dir();
    let nb = r##"{"cells":[{"cell_type":"markdown","source":["# Title"]}],"metadata":{},"nbformat":4,"nbformat_minor":5}"##;
    std::fs::write(root.as_path().join("nb.ipynb"), nb).unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let read = ReadTool::new(None, None);
    let (is_error, text) = text_of(read.call(&ctx, serde_json::json!({ "file_path": "nb.ipynb" })).await);
    assert!(!is_error && text.contains("# Title"), "{text}");
    let (is_error, text) = text_of(read.call(&ctx, serde_json::json!({ "file_path": "nb.ipynb", "limit": 5 })).await);
    assert!(is_error && text.contains("range args (offset/limit/line) are not supported"), "{text}");
}
/// A-46: an edit target that is a URL is refused as one, in Node's words, not as a trailing-dot or stream path.
#[tokio::test]
async fn an_edit_of_a_url_names_web_fetch() {
    let (_dir, root) = small_dir();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    for target in ["https://example.com/a.txt", "  HTTP://example.com/a.txt"] {
        let args = serde_json::json!({ "file_path": target, "old_string": "", "new_string": "x\n" });
        assert_eq!(text_of(EditTool::new().call(&ctx, args).await), (true, "Error: this is a URL; use web_fetch".to_owned()), "{target}");
    }
}
/// A-46 (`assertPathsReachable`): a target whose stat never answers (a dead mount) is refused once the 15 s bound passes,
/// as Node words it; no other filesystem call has been made on it.
#[tokio::test]
async fn an_edit_of_a_path_that_never_answers_is_refused_as_unreachable() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-edit-hang").join("ws")).unwrap();
    let control = Arc::new(StatControl::default());
    let ctx = context_seeded(&root, Arc::new(StatFails(Arc::new(MockFileService::default()), &[], &["hang.txt"], control.clone())), Vec::new()).await;
    tokio::time::pause();
    let tool = EditTool::new();
    let mut call = Box::pin(tool.call(&ctx, serde_json::json!({ "file_path": "hang.txt", "old_string": "", "new_string": "x\n" })));
    tokio::select! {
        biased;
        () = control.hung.notified() => {}
        out = &mut call => panic!("answered before the never-answering stat started: {out:?}"),
    }
    assert!(futures::poll!(&mut call).is_pending());
    tokio::time::advance(std::time::Duration::from_millis(14_999)).await;
    assert!(futures::poll!(&mut call).is_pending());
    tokio::time::advance(std::time::Duration::from_millis(2)).await;
    let std::task::Poll::Ready(outcome) = futures::poll!(&mut call) else { panic!("no answer past the bound") };
    let (is_error, text) = text_of(outcome);
    assert!(is_error && text.starts_with("Error: path unreachable: stat exceeded 15000ms (possible dead mount / hung filesystem): ") && text.ends_with("hang.txt"), "{text}");
}
/// A file another handle holds open without sharing still stats (as libuv's stat does), so `read`
/// and `edit` answer with the open's own cause in Node's words, not a missing target.
#[cfg(windows)]
#[tokio::test]
async fn a_file_held_without_sharing_reads_as_busy() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_dir, root) = small_dir();
    let held = root.as_path().join("held.txt");
    std::fs::write(&held, "locked body\n").unwrap();
    let _hold = std::fs::OpenOptions::new().read(true).share_mode(0).open(&held).unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let (is_error, text) = text_of(ReadTool::new(None, None).call(&ctx, serde_json::json!({ "file_path": "held.txt" })).await);
    assert!(is_error && text.starts_with("Error: EBUSY: resource busy or locked, open '") && text.ends_with("/ws/held.txt'"), "{text}");
    let open = format!("EBUSY: resource busy or locked, open '{}'", held.display());
    for old in ["locked body", ""] {
        let args = serde_json::json!({ "file_path": "held.txt", "old_string": old, "new_string": "EDITED\n" });
        assert_eq!(text_of(EditTool::new().call(&ctx, args).await), (true, format!("Error: cannot read {} ({open})", held.display())), "{old:?}");
    }
}
/// An Add under a parent that is a file fails at the parent's mkdir, named as Node names it, and
/// the batch is rolled back.
#[tokio::test]
async fn an_add_under_a_file_parent_names_the_failed_mkdir() {
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("p"), "a file\n").unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let args = serde_json::json!({ "patch": "*** Begin Patch\n*** Add File: p/child.txt\n+x\n*** End Patch\n" });
    let (_, text) = text_of(ApplyPatchTool::new().call(&ctx, args).await);
    let want = format!(
        "Error: EEXIST: file already exists, mkdir '{}'\n--- rolled back: every touched path was restored to its pre-patch state ---",
        root.as_path().join("p").display()
    );
    assert_eq!(text, want);
    assert_eq!(std::fs::read_to_string(root.as_path().join("p")).unwrap(), "a file\n");
}
/// An edit that creates under a parent that is a file fails at its temp file's open, worded as
/// Node's adapter words a failed `atomicWrite` of `createEditTarget`.
#[cfg(windows)]
#[tokio::test]
async fn an_edit_create_under_a_file_parent_names_the_failed_open() {
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("e"), "a file\n").unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let args = serde_json::json!({ "file_path": "e/child.txt", "old_string": "", "new_string": "x\n" });
    let (is_error, text) = text_of(EditTool::new().call(&ctx, args).await);
    let open = "Error: edit failed (ENOENT: no such file or directory, open '";
    assert!(is_error && text.starts_with(open) && text.contains("\\e\\child.txt.mixdog-tmp-") && text.ends_with("')"), "{text}");
    assert_eq!(std::fs::read_to_string(root.as_path().join("e")).unwrap(), "a file\n");
}
/// An ordered rename whose source cannot be removed puts both paths back and fails as its own
/// unit; the unit before it, already on disk, still reaches the review.
#[tokio::test]
async fn a_failed_source_removal_restores_both_paths_and_earlier_units_are_still_reviewed() {
    use mixdog_core_api::turn_review::ReviewContent;
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("c.txt"), "keep\n").unwrap();
    std::fs::write(root.as_path().join("a.txt"), "one\ntwo\n").unwrap();
    let review = Arc::new(FakeReview::default());
    let mut ctx = context_seeded(&root, Arc::new(BusyRemove(local_ctx_files())), Vec::new()).await;
    ctx.review = Some(review.clone());
    let patch = "*** Begin Patch\n*** Update File: c.txt\n@@\n-keep\n+KEEP\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-one\n+ONE\n*** End Patch\n";
    let (is_error, text) = text_of(ApplyPatchTool::new().call(&ctx, serde_json::json!({ "patch": patch, "sequence": true })).await);
    assert!(is_error);
    let a = root.as_path().join("a.txt");
    let (code, description) = if cfg!(windows) { ("EBUSY", "resource busy or locked") } else { ("EBUSY", "resource busy or locked") };
    let why = format!("apply_patch: V4A rename failed for a.txt → b.txt ({code}: {description}, unlink '{}')", a.display());
    assert!(text.contains(&why), "{text}");
    assert!(text.contains("sequence stopped at section 2/2 (a.txt)"), "{text}");
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "one\ntwo\n");
    assert!(!root.as_path().join("b.txt").exists());
    assert_eq!(std::fs::read_to_string(root.as_path().join("c.txt")).unwrap(), "KEEP\n");
    let calls = review.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].3.len(), 1);
    assert_eq!(calls[0].3[0].path, root.as_path().join("c.txt").to_string_lossy());
    assert_eq!(calls[0].3[0].after, ReviewContent::bytes(&b"KEEP\n"[..]));
}
/// A delete-only target keeps the 8 MiB snapshot limit in an ordered patch, so a larger one is
/// reviewed as an omitted state, not read whole.
#[tokio::test]
async fn an_ordered_delete_of_a_file_over_8_mib_is_reviewed_as_omitted() {
    use mixdog_core_api::turn_review::ReviewContent;
    let (_dir, root) = small_dir();
    let big = "x\n".repeat(5 * 1024 * 1024);
    std::fs::write(root.as_path().join("big.txt"), &big).unwrap();
    std::fs::write(root.as_path().join("s.txt"), "one\n").unwrap();
    let review = Arc::new(FakeReview::default());
    let mut ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    ctx.review = Some(review.clone());
    let patch = "*** Begin Patch\n*** Delete File: big.txt\n*** Update File: s.txt\n@@\n-one\n+ONE\n*** End Patch\n";
    let (is_error, text) = text_of(ApplyPatchTool::new().call(&ctx, serde_json::json!({ "patch": patch, "sequence": true })).await);
    assert!(!is_error, "{text}");
    let calls = review.calls.lock().unwrap();
    let change = calls[0].3.iter().find(|c| c.path.ends_with("big.txt")).unwrap();
    assert_eq!(change.before, ReviewContent::Omitted { size: big.len() as u64, reason: Some("oversized".to_owned()) });
    assert_eq!(change.after, ReviewContent::Absent);
}
/// A native failure over a file past 8 MiB carries no nearest-line hints, as Node's bounded read.
#[tokio::test]
async fn native_failure_context_reads_no_more_than_8_mib() {
    let (_dir, root) = small_dir();
    std::fs::write(root.as_path().join("small.txt"), "one\n").unwrap();
    std::fs::write(root.as_path().join("big.txt"), "one\n".repeat(2 * 1024 * 1024 + 1)).unwrap();
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let stale = |name: &str| serde_json::json!({ "patch": format!("--- a/{name}\n+++ b/{name}\n@@ -1,1 +1,1 @@\n-nope\n+X\n") });
    let (_, small) = text_of(ApplyPatchTool::new().call(&ctx, stale("small.txt")).await);
    assert!(small.contains("nearest line 1: \"one\""), "{small}");
    let (_, big) = text_of(ApplyPatchTool::new().call(&ctx, stale("big.txt")).await);
    assert!(big.starts_with("Error: native patch failed"), "{big}");
    assert!(!big.contains("nearest line") && big.contains("expected first old/context line in big.txt: \"nope\"; use exact"), "{big}");
}
/// A rename between two spellings of one file (a junction alias) is an edit in place: allowed,
/// nothing removed. Node's `renameTargetsSamePhysicalFile` allows it; its own advisory lock set
/// holds both spellings of the one lock file and times out first, so only Rust gets this far.
#[tokio::test]
async fn a_rename_between_two_spellings_of_one_file_edits_it_in_place() {
    let (_dir, root) = small_dir();
    std::fs::create_dir_all(root.as_path().join("real")).unwrap();
    if !link_dir(&root.as_path().join("alias"), &root.as_path().join("real")) {
        return;
    }
    let ctx = context_seeded(&root, local_ctx_files(), Vec::new()).await;
    let file = root.as_path().join("real").join("a.txt");
    for extra in [serde_json::json!({}), serde_json::json!({ "sequence": true })] {
        std::fs::write(&file, "one\ntwo\n").unwrap();
        let mut args = serde_json::json!({ "patch": "*** Begin Patch\n*** Update File: real/a.txt\n*** Move to: alias/a.txt\n@@\n-one\n+ONE\n*** End Patch\n" });
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let (is_error, text) = text_of(ApplyPatchTool::new().call(&ctx, args).await);
        assert!(!is_error, "{text}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "ONE\ntwo\n", "{text}");
    }
}
/// With no resizer the read is Node without `sharp`: an original over 3,750,000 bytes is refused
/// with Node's text, a smaller one goes through as the bare image block. A resizer whose host
/// failed is a tool error, never that refusal.
#[tokio::test]
async fn an_image_without_a_resizer_keeps_the_inline_cap_and_a_failed_host_is_an_error() {
    struct DeadHost;
    #[async_trait::async_trait]
    impl mixdog_core_api::domain::ext::ImageResizer for DeadHost {
        async fn resize(
            &self,
            _thread: &ThreadId,
            _bytes: &[u8],
            _ext: &str,
        ) -> Result<Option<mixdog_core_api::domain::ext::ResizedImage>, mixdog_core_api::domain::ext::ImageResizeError> {
            Err(mixdog_core_api::domain::ext::ImageResizeError::Host(mixdog_core_api::domain::ext::ExtError::UnknownWorker))
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let root = AbsPath::new(dir.path().join("ws")).unwrap();
    std::fs::create_dir_all(root.as_path()).unwrap();
    let big = flat_png(2000, 1000, [200, 30, 90]);
    let small = flat_png(30, 20, [1, 2, 3]);
    let seeds = vec![("big.png".to_owned(), big.clone()), ("small.PNG".to_owned(), small.clone()), ("held.txt".to_owned(), small.clone())];
    let ctx = context_seeded(&root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), seeds).await;

    let bare = ReadTool::new(None, None);
    let (is_error, refused) = text_of(bare.call(&ctx, serde_json::json!({ "file_path": "big.png" })).await);
    assert!(is_error);
    assert_eq!(
        refused,
        format!(
            "Error: image \"big.png\" is {} bytes, over the 3750000-byte inline-view cap (image resizing unavailable: install the optional \"sharp\" dependency to auto-downsample). Convert/resize before reading.",
            big.len()
        )
    );
    let out = bare.call(&ctx, serde_json::json!({ "file_path": "small.PNG" })).await.unwrap();
    assert_eq!(out.parts, vec![ToolPart::Image { mime: "image/png".to_owned(), data: ImageData::Bytes(small), width: None, height: None }]);
    // An image by content under another extension is not an image to `read`: it is a binary file.
    let (_, text) = text_of(bare.call(&ctx, serde_json::json!({ "file_path": "held.txt" })).await);
    assert!(!text.contains("inline-view"), "{text}");

    let dead = ReadTool::new(None, Some(Arc::new(DeadHost)));
    let error = dead.call(&ctx, serde_json::json!({ "file_path": "big.png" })).await.unwrap_err();
    assert!(matches!(error.code, ToolErrorCode::Unavailable { .. }), "{error:?}");
}
#[async_trait::async_trait]
impl FileService for StatFails {
    async fn stat(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        assert!(!self.3.reject_probes, "unexpected stat: {path:?}");
        assert!(!self.3.unprobeable_suffixes.iter().any(|suffix| path.as_path().ends_with(suffix)), "unexpected literal stat: {path:?}");
        if let Some(stats) = &self.3.stats {
            stats.lock().unwrap().push(path.clone());
        }
        if self.2.iter().any(|name| path.as_path().ends_with(name)) {
            self.3.hung.notify_one();
            std::future::pending::<()>().await;
        }
        if let Some((_, ms)) = self.3.delays.iter().find(|(name, _)| path.as_path().ends_with(name)) {
            tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
        }
        if self.1.iter().any(|name| path.as_path().ends_with(name)) {
            return Err(mixdog_core_api::domain::fs::FsError::new(mixdog_core_api::domain::fs::FsErrorKind::PermissionDenied, Some(path)));
        }
        self.0.stat(lane, path).await
    }
    async fn read(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath, range: mixdog_core_api::domain::fs::ReadRange) -> Result<mixdog_core_api::domain::fs::FileBytes, mixdog_core_api::domain::fs::FsError> {
        if path.as_path().ends_with("tail.txt") && self.3.fail_first_read.swap(false, std::sync::atomic::Ordering::Relaxed) {
            return Err(FsError::new(FsErrorKind::PermissionDenied, Some(path)));
        }
        if let Some(reads) = &self.3.reads {
            reads.lock().unwrap().push(path.clone());
        }
        self.0.read(lane, path, range).await
    }
    async fn list_dir(&self, lane: mixdog_rt::InteractiveIo, path: AbsPath) -> Result<Vec<mixdog_core_api::domain::fs::DirEntry>, mixdog_core_api::domain::fs::FsError> {
        self.0.list_dir(lane, path).await
    }
    async fn write(&self, lane: mixdog_rt::DurabilityIo, request: WriteRequest) -> Result<mixdog_core_api::domain::fs::FileStat, mixdog_core_api::domain::fs::FsError> {
        self.0.write(lane, request).await
    }
    async fn write_batch(&self, lane: mixdog_rt::DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<mixdog_core_api::domain::fs::FileStat>, mixdog_core_api::domain::fs::FsError> {
        self.0.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.create_dir(lane, path, recursive).await
    }
    async fn rename(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.rename(lane, from, to, overwrite).await
    }
    async fn copy(&self, lane: mixdog_rt::DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.copy(lane, from, to, overwrite).await
    }
    async fn remove(&self, lane: mixdog_rt::DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), mixdog_core_api::domain::fs::FsError> {
        self.0.remove(lane, path, recursive).await
    }
    fn walk(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::WalkRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::DirEntry, mixdog_core_api::domain::fs::FsError>>> {
        assert!(!self.3.reject_probes, "unexpected walk: {:?}", request.root);
        let missed = self.3.missed_walk_entry.then(|| request.root.clone());
        let walk = self.0.walk(lane, request);
        let extra = missed.map(|path| Err(FsError::new(FsErrorKind::PermissionDenied, Some(path))))
            .or_else(|| self.3.repeated_walk_entry.clone().map(Ok));
        match extra {
            Some(extra) => Box::new(WalkWithExtra { walk, extra: Some(extra) }),
            None => walk,
        }
    }
    fn search_text(&self, lane: mixdog_rt::MaintenanceIo, request: mixdog_core_api::domain::fs::SearchRequest) -> Box<dyn mixdog_core_api::domain::common::EventSource<Result<mixdog_core_api::domain::fs::SearchMatch, mixdog_core_api::domain::fs::FsError>>> {
        self.0.search_text(lane, request)
    }
}

struct WalkWithExtra {
    walk: Box<dyn EventSource<Result<DirEntry, FsError>>>,
    extra: Option<Result<DirEntry, FsError>>,
}

#[async_trait::async_trait]
impl EventSource<Result<DirEntry, FsError>> for WalkWithExtra {
    async fn next(&mut self) -> Option<Result<DirEntry, FsError>> {
        if let Some(extra) = self.extra.take() {
            return Some(extra);
        }
        self.walk.next().await
    }

    async fn close(&mut self) {
        self.walk.close().await;
    }
}

#[tokio::test]
async fn read_reports_an_incomplete_glob_without_losing_the_readable_match() {
    let (_dir, root) = small_dir();
    let control = Arc::new(StatControl { missed_walk_entry: true, ..StatControl::default() });
    let files = Arc::new(StatFails(Arc::new(MockFileService::default()), &[], &[], control));
    let ctx = context_seeded(&root, files, vec![("found.txt".to_owned(), b"keep this row\n".to_vec())]).await;
    let out = ReadTool::new(None, None).call(&ctx, serde_json::json!({
        "file_path": [{"file_path": "*.txt", "offset": 1, "limit": 1}, {"file_path": "*.txt", "offset": 2, "limit": 1}]
    })).await.unwrap();
    assert_eq!(out.meta.as_ref().unwrap()["complete"], false);
    let text = text_of(Ok(out)).1;
    assert!(text.contains("found.txt [ok]\n[lines 1-1]\nkeep this row"), "{text}");
    assert!(text.contains("glob search incomplete"), "{text}");
    assert!(text.contains("(no lines in range"), "{text}");
}

#[tokio::test]
async fn read_refuses_a_guarded_pattern_without_stating_or_expanding_it() {
    let (_dir, root) = small_dir();
    let control = Arc::new(StatControl { reject_probes: true, ..StatControl::default() });
    let files = Arc::new(StatFails(Arc::new(MockFileService::default()), &[], &[], control));
    let ctx = context_seeded(&root, files, Vec::new()).await;
    let text = text_of(ReadTool::new(None, None).call(&ctx, serde_json::json!({
        "file_path": ["//server/share/*.txt", "//server/share/file#L9"], "tail": 2
    })).await).1;
    assert_eq!(text.matches("cannot read UNC / SMB path").count(), 2, "{text}");
}

#[tokio::test]
async fn a_refused_literal_coordinate_tail_does_not_read_the_stripped_path() {
    let (_dir, root) = small_dir();
    let control = Arc::new(StatControl { reads: Some(std::sync::Mutex::default()), ..StatControl::default() });
    let files = Arc::new(StatFails(local_ctx_files(), &["tail.txt#L2"], &[], control.clone()));
    let ctx = context_seeded(&root, files, vec![("tail.txt".to_owned(), b"first\nnot requested\n".to_vec())]).await;
    let read = ReadTool::new(None, None);
    let (error, text) = text_of(read.call(&ctx, serde_json::json!({ "file_path": "tail.txt#L2", "tail": 1 })).await);
    assert!(error && !text.contains("not requested"), "{text}");
    assert!(!control.reads.as_ref().unwrap().lock().unwrap().iter().any(|p| p.as_path().ends_with("tail.txt")));
}

#[cfg(windows)]
#[tokio::test]
async fn windows_colon_coordinates_read_only_the_guarded_base_file() {
    let (_dir, root) = small_dir();
    let control = Arc::new(StatControl { unprobeable_suffixes: &["rows.txt:2-3", "rows.txt:2:$DATA"], ..StatControl::default() });
    let files = Arc::new(StatFails(local_ctx_files(), &[], &[], control));
    let ctx = context_seeded(&root, files, vec![("rows.txt".to_owned(), b"one\ntwo\nthree\nfour\n".to_vec())]).await;
    let read = ReadTool::new(None, None);
    let rows = text_of(read.call(&ctx, serde_json::json!({ "file_path": "rows.txt:2-3" })).await).1;
    assert!(rows.contains("[lines 2-3]\ntwo\nthree") && !rows.contains("four"), "{rows}");
    let refused = text_of(read.call(&ctx, serde_json::json!({ "file_path": "rows.txt:2:$DATA" })).await).1;
    assert!(refused.contains("NTFS ADS") && !refused.contains("three"), "{refused}");
}

#[tokio::test]
async fn a_failed_tail_read_reports_the_error_without_reading_the_head() {
    let (_dir, root) = small_dir();
    let control = Arc::new(StatControl {
        fail_first_read: std::sync::atomic::AtomicBool::new(true),
        reads: Some(std::sync::Mutex::default()),
        ..StatControl::default()
    });
    let files = Arc::new(StatFails(local_ctx_files(), &[], &[], control.clone()));
    let ctx = context_seeded(&root, files, vec![("tail.txt".to_owned(), b"first\nmiddle\nlast\n".to_vec())]).await;
    let (error, text) = text_of(ReadTool::new(None, None).call(&ctx, serde_json::json!({ "file_path": "tail.txt", "tail": 1 })).await);
    assert!(error && !text.lines().any(|line| line == "first" || line == "last"), "{text}");
    assert!(!control.reads.as_ref().unwrap().lock().unwrap().iter().any(|p| p.as_path().ends_with("tail.txt")));
}

#[tokio::test]
async fn whole_file_write_reads_previous_contents_only_for_review() {
    let (_dir, root) = small_dir();
    let control = Arc::new(StatControl { reads: Some(std::sync::Mutex::default()), ..StatControl::default() });
    let files = Arc::new(StatFails(local_ctx_files(), &[], &[], control.clone()));
    let mut ctx = context_seeded(&root, files, vec![("a.txt".to_owned(), b"old\n".to_vec())]).await;
    let write = WriteTool::new();
    let write_args = |contents| serde_json::json!({ "file_path": "a.txt", "contents": contents });
    let first = write.call(&ctx, write_args("first\n")).await.unwrap();
    assert!(text_of(Ok(first)).1.contains("Updated "));
    let reads = control.reads.as_ref().unwrap();
    assert!(reads.lock().unwrap().is_empty(), "without review the old content is not read");
    let review = Arc::new(FakeReview::default());
    ctx.review = Some(review.clone());
    let second = write.call(&ctx, write_args("second\n")).await.unwrap();
    assert_eq!(card_of(&second), Some("card:c"));
    assert_eq!(reads.lock().unwrap().as_slice(), &[AbsPath::new(root.as_path().join("a.txt")).unwrap()]);
    let calls = review.calls.lock().unwrap();
    let change = &calls[0].3[0];
    assert_eq!(change.before, mixdog_core_api::turn_review::ReviewContent::bytes(&b"first\n"[..]));
    assert_eq!(change.after, mixdog_core_api::turn_review::ReviewContent::bytes(&b"second\n"[..]));
    assert_eq!(std::fs::read(root.as_path().join("a.txt")).unwrap().as_slice(), b"second\n");
}

#[tokio::test]
async fn repeated_patch_excerpts_name_the_resolved_target_and_show_its_current_text() {
    let (_dir, root) = small_dir();
    let seeds = vec![("src/a.txt".to_owned(), b"one\n".to_vec()), ("b.txt".to_owned(), b"start\n".to_vec())];
    let ctx = context_seeded(&root, local_ctx_files(), seeds).await;
    let patch = ApplyPatchTool::new();
    let first = "*** Begin Patch\n*** Update File: src/a.txt\n@@\n-one\n+two\n*** Update File: b.txt\n@@\n-start\n+ready\n*** End Patch\n";
    let first = patch.call(&ctx, serde_json::json!({ "patch": first })).await.unwrap();
    assert!(!text_of(Ok(first)).1.contains("post-patch state"));
    let second = "*** Begin Patch\n*** Update File: extra/src/a.txt\n@@\n-two\n+three\n*** Update File: b.txt\n@@\n-ready\n+done\n*** End Patch\n";
    let second = patch.call(&ctx, serde_json::json!({ "patch": second })).await.unwrap();
    let text = text_of(Ok(second)).1;
    let (_, excerpt) = text.split_once("post-patch state (verbatim — use for follow-up patches):\n").unwrap();
    assert_eq!(excerpt, "src/a.txt lines 1-1:\n    1| three\nb.txt lines 1-1:\n    1| done");
}
/// A glob-shaped `list` path bounds each candidate's stat by 1 000 ms, 64 at a time (Node `collectFindMatches`,
/// `statPathsForMtime(…, 64, { deadlineMs: FIND_STAT_DEADLINE_MS })`), not the whole pass: a stat that never answers
/// leaves its row with `-` at its own deadline, a stat that starts late (the 65th, once a slow one ends at 900 ms)
/// still answers 600 ms into its own bound, past 1 000 ms of the pass, and every metadata read stays in the answer.
/// Virtual time moves only by the advances below.
#[tokio::test]
async fn a_glob_shaped_list_bounds_each_stat_and_keeps_what_it_read() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-list-stat").join("ws")).unwrap();
    let mut names = vec!["a-slow.ts".to_owned()];
    names.extend((0..62).map(|i| format!("f{i:02}.ts")));
    names.extend(["hang.ts".to_owned(), "z-late.ts".to_owned()]);
    let seeds = names.iter().map(|n| (n.clone(), b"x\n".to_vec())).collect();
    let control = Arc::new(StatControl { delays: &[("a-slow.ts", 900), ("z-late.ts", 600)], ..StatControl::default() });
    let ctx = context_seeded(&root, Arc::new(StatFails(Arc::new(MockFileService::default()), &[], &["hang.ts"], control.clone())), seeds).await;
    tokio::time::pause();
    let tool = ListTool::new();
    let mut call = Box::pin(tool.call(&ctx, serde_json::json!({ "path": "*.ts", "limit": 0 })));
    // No timer is pending until the stats start, so the clock stands still while the walk runs on its lane.
    tokio::select! {
        biased;
        () = control.hung.notified() => {}
        out = &mut call => panic!("answered before the never-answering stat started: {out:?}"),
    }
    let pending = |poll: std::task::Poll<_>, what: &str| assert!(poll.is_pending(), "answered {what}");
    pending(futures::poll!(&mut call), "with the stats just started");
    tokio::time::advance(std::time::Duration::from_millis(899)).await;
    pending(futures::poll!(&mut call), "before the slow stat ended");
    // tokio rounds a timer up to its next whole millisecond tick; the 65th stat starts here.
    tokio::time::advance(std::time::Duration::from_millis(2)).await;
    pending(futures::poll!(&mut call), "before the late stat started");
    tokio::time::advance(std::time::Duration::from_millis(100)).await;
    pending(futures::poll!(&mut call), "when the never-answering stat reached its deadline, with a later stat in its own bound");
    tokio::time::advance(std::time::Duration::from_millis(501)).await;
    let std::task::Poll::Ready(outcome) = futures::poll!(&mut call) else { panic!("no answer once the late stat answered") };
    let (is_error, text) = text_of(outcome);
    assert!(!is_error, "{text}");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 66, "{text}");
    assert_eq!(lines.iter().filter(|l| l.ends_with("\t-\t-")).copied().collect::<Vec<_>>(), ["hang.ts\t-\t-"], "{text}");
    assert!(lines.iter().any(|l| l.starts_with("z-late.ts\t") && !l.ends_with("\t-\t-")), "{text}");
    assert!(lines.iter().any(|l| l.starts_with("a-slow.ts\t") && !l.ends_with("\t-\t-")), "{text}");
    assert_eq!(lines[65], "... 1 path(s) had no metadata within 1000ms; listed with \"-\" for size/date");
}
/// A glob or find rooted at a POSIX filesystem root walks neither `/proc`, `/sys` nor `/dev`;
/// rooted inside one of them it lists that tree (Node `rootScanIgnoreGlobs`). The filesystem
/// root here is the in-memory service's, the drive root on Windows.
#[tokio::test]
async fn a_scan_of_the_filesystem_root_skips_the_kernel_trees() {
    let root = AbsPath::new(if cfg!(windows) { "C:\\" } else { "/" }).unwrap();
    let seeds = ["proc/1/status", "sys/block/sda/size", "dev/null-ish", "home/u/a.txt", "procfs.txt"]
        .iter()
        .map(|rel| (rel.to_string(), b"x\n".to_vec()))
        .collect();
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let listed = |entries: Vec<mixdog_core_api::domain::fs::DirEntry>| {
        entries.into_iter().map(|e| super::common::display_under(e.path.as_path(), root.as_path())).collect::<Vec<_>>()
    };
    let walked = super::search::walk_entries_pruned(&ctx, &root, false, |_| true, super::search::root_scan_prunes(&root, true), None, None).await.unwrap();
    assert!(walked.complete);
    assert_eq!(listed(walked.entries), ["home/u/a.txt", "procfs.txt"]);
    let proc_root = AbsPath::new(root.as_path().join("proc")).unwrap();
    let walked = super::search::walk_entries_pruned(&ctx, &proc_root, false, |_| true, super::search::root_scan_prunes(&proc_root, true), None, None).await.unwrap();
    assert_eq!(walked.entries.len(), 1);
}
/// Past 50 000 files a bounded glob still ranks and counts every match (Node's windowed pass
/// reports its total over the whole scope) and find still scores every file (Node's native
/// inventory has no entry cap); an unbounded glob keeps 50 000 and says the list is incomplete.
#[tokio::test]
async fn glob_and_find_see_files_past_fifty_thousand_entries() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-cap").join("ws")).unwrap();
    let mut seeds: Vec<(String, Vec<u8>)> = (0..50_000).map(|i| (format!("f/{i:05}.txt"), Vec::new())).collect();
    seeds.push(("zz/last-one.txt".to_owned(), Vec::new()));
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let (_, glob) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "**/*.txt" })).await);
    assert!(glob.ends_with("[entries 1-100 of 50001; offset:100 for more]"), "{}", &glob[glob.len().saturating_sub(200)..]);
    let (_, find) = text_of(FindTool::new().call(&ctx, serde_json::json!({ "query": "last-one" })).await);
    assert_eq!(find, "zz/last-one.txt");
    let walked = super::search::walk_entries_pruned(&ctx, &root, false, |_| true, Vec::new(), Some(super::search::GLOB_ACCUM_CAP), None).await.unwrap();
    assert!(walked.capped && walked.entries.len() == 50_000);
}
/// find ranks with the matcher of Node's native search server (nucleo): an equal score is ordered by path,
/// not by length, and every whitespace-separated fragment has to match the path.
#[tokio::test]
async fn find_ranks_with_nucleo_and_breaks_ties_by_path() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-fs-fuzzy").join("ws")).unwrap();
    let seeds = ["b/zz.rs", "aaa/zz.rs", "aaa/other.rs", "aaa/n-e-e-d-l-e", "late/needle"]
        .into_iter().map(|name| (name.to_owned(), Vec::new())).collect();
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let (_, find) = text_of(FindTool::new().call(&ctx, serde_json::json!({ "query": "zz" })).await);
    assert_eq!(find, "aaa/zz.rs
b/zz.rs");
    let (_, both) = text_of(FindTool::new().call(&ctx, serde_json::json!({ "query": "zz aaa" })).await);
    assert_eq!(both, "aaa/zz.rs");
    let (_, top) = text_of(FindTool::new().call(&ctx, serde_json::json!({ "query": "zz", "limit": 1 })).await);
    assert_eq!(top, "aaa/zz.rs\n... (top 1; additional matches omitted)");
    let (_, best_late) = text_of(FindTool::new().call(&ctx, serde_json::json!({ "query": "needle", "limit": 1 })).await);
    assert_eq!(best_late, "late/needle\n... (top 1; additional matches omitted)");
}
/// `tool-output-limit.mjs`: each cap is its default unless its `MIXDOG_*_OUTPUT_MAX_BYTES` names a positive integer.
#[test]
fn the_output_caps_default_to_the_documented_sizes() {
    for (name, got, default) in [
        ("MIXDOG_TOOL_OUTPUT_MAX_BYTES", super::common::output_max_bytes(), 50 * 1024),
        ("MIXDOG_LOCATOR_OUTPUT_MAX_BYTES", super::common::locator_max_bytes(), 20 * 1024),
        ("MIXDOG_GREP_OUTPUT_MAX_BYTES", super::common::grep_max_bytes(), 5 * 1024),
    ] {
        if std::env::var(name).is_err() {
            assert_eq!(got, default, "{name}");
        }
    }
    assert_eq!(crate::github::positive_env_int(Some(" 4096kb"), 1), 4096);
    assert_eq!(crate::github::positive_env_int(Some("0"), 7), 7);
    assert_eq!(crate::github::positive_env_int(None, 7), 7);
}
/// A named find over the real tree, whose walk does not enter a folder the name's ancestor rule keeps nothing under, lists
/// exactly what a walk of everything lists, byte for byte over the same tree (that the pruned walk reads fewer folders is
/// `a_guarded_walk_reads_no_folder_the_name_rule_fails_and_a_bad_rule_is_an_error`): every name shape crossed with `hidden`,
/// `include_noise`, `depth`, paging and the type and sort filters.
#[tokio::test]
async fn a_named_find_that_skips_folders_it_keeps_nothing_under_lists_what_a_full_walk_lists() {
    let dir = tempfile::tempdir().unwrap();
    let real_root = AbsPath::new(dir.path().join("real")).unwrap();
    let seeds: Vec<(String, Vec<u8>)> = [
        "node_modules/foo/x.js",
        "node_modules/bar/foo/y.js",
        "node_modules/foo.js",
        "node_modules/.bin/foo",
        "node_modules/a/b/c/foo.js",
        ".cache/a/foo",
        ".foo/z.js",
        // (No `.git`: the real walk never reads one, guard or not, where the mock lists it.)
        "x/.vscode/foo",
        "x/foo/bar.js",
        "src/foo.js",
        "src/deep/foo/inner.ts",
        "src/.hidden/foo.js",
        "venv/lib/foo.py",
        "a/b/a/b/c.txt",
    ]
    .iter()
    .map(|rel| (rel.to_string(), b"1\n".to_vec()))
    .collect();
    // One tree, walked with the guard and (through `Unpruned`) without it, so sizes and dates are the same files'.
    let pruned = context_seeded(&real_root, Arc::new(mixdog_workspace::localfs::LocalFileService::new()), seeds).await;
    let unpruned = context_seeded(&real_root, Arc::new(Unpruned(local_ctx_files())), Vec::new()).await;
    let tool = ListTool::new();
    let pages = [
        serde_json::json!({ "sort": "name", "head_limit": 0 }),
        serde_json::json!({ "sort": "name", "head_limit": 3, "offset": 2 }),
        serde_json::json!({ "sort": "size", "type": "file", "head_limit": 0 }),
        serde_json::json!({ "sort": "mtime", "type": "dir", "head_limit": 2 }),
    ];
    // `None`: a find with no name, which keeps a noise folder's direct children.
    for name in [None, Some("foo"), Some("*.js"), Some("**/foo*"), Some("node_modules/foo/*"), Some("a/**/b"), Some("FOO"), Some("foo/*"), Some("*"), Some(".foo"), Some("b")] {
        for hidden in [false, true] {
            for include_noise in [false, true] {
                for depth in [serde_json::Value::Null, 1.into(), 2.into(), 3.into()] {
                    for page in &pages {
                        let mut args = serde_json::json!({ "mode": "find", "hidden": hidden, "include_noise": include_noise, "depth": depth });
                        if let Some(name) = name {
                            args["name"] = name.into();
                        }
                        args.as_object_mut().unwrap().extend(page.as_object().unwrap().clone());
                        let got = text_of(tool.call(&pruned, args.clone()).await);
                        let want = text_of(tool.call(&unpruned, args.clone()).await);
                        assert!(!got.0, "{args}: {}", got.1);
                        assert_eq!(got, want, "{args}");
                    }
                }
            }
        }
    }
}
#[cfg(unix)]
#[tokio::test]
async fn sorted_list_and_find_do_not_certify_followed_symlink_metadata() {
    let workspace = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let dir = workspace.path().canonicalize().unwrap();
    let target = external.path().join("outside.txt");
    std::fs::write(&target, "external").unwrap();
    std::os::unix::fs::symlink(target, dir.join("link.txt")).unwrap();
    let root = AbsPath::new(dir).unwrap();
    let ctx = context_over(&root, local_ctx_files()).await;
    let tool = ListTool::new();
    for (args, safe) in [
        (serde_json::json!({"sort": "name"}), true),
        (serde_json::json!({"sort": "size"}), false),
        (serde_json::json!({"mode": "find", "name": "link.txt"}), false),
    ] {
        let answer = tool.call(&ctx, args).await.unwrap();
        let meta = answer.meta.unwrap();
        assert_eq!(meta["complete"], true);
        assert_eq!(meta["cacheSafe"], safe);
    }
}

/// `list` keeps the arguments the schema does not show (`list-tool.mjs`): `mode: "tree"`, `mode: "find"` with its name and
/// filters, `sort`, `type` and `include_noise`.
#[tokio::test]
async fn list_answers_tree_find_sort_type_and_include_noise() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-list-modes").join("ws")).unwrap();
    let seeds = [
        ("src/a.ts", "aaaa\naaaa\n"),
        ("src/b.ts", "b\n"),
        ("docs/readme.md", "hello world, hello world\n"),
        ("node_modules/x/i.js", "i\n"),
        ("top.txt", "t\n"),
    ]
    .iter()
    .map(|(rel, body)| (rel.to_string(), body.as_bytes().to_vec()))
    .collect();
    let ctx = context_seeded(&root, Arc::new(MockFileService::default()), seeds).await;
    let tool = ListTool::new();
    let run = |args: serde_json::Value| {
        let (ctx, tool) = (&ctx, &tool);
        async move {
            let (is_error, text) = text_of(tool.call(ctx, args).await);
            assert!(!is_error, "{text}");
            text
        }
    };

    let tree = run(serde_json::json!({ "mode": "tree" })).await;
    let lines: Vec<&str> = tree.lines().collect();
    // The noise folder the tree left out is counted, as a flat list counts it (issue #339).
    assert_eq!(
        lines[1..],
        ["├── docs/", "│   └── readme.md", "├── src/", "│   ├── a.ts", "│   └── b.ts", "└── top.txt", "1 noise entries excluded (include_noise:true to show)"],
        "{tree}"
    );
    let paged = run(serde_json::json!({ "mode": "tree", "head_limit": 2, "offset": 1 })).await;
    assert!(paged.ends_with("[entries 2-3 of 4+; offset:3 for more]\n1 noise entries excluded (include_noise:true to show)"), "{paged}");
    let tree_noise = run(serde_json::json!({ "mode": "tree", "include_noise": true, "depth": 1 })).await;
    assert!(tree_noise.contains("├── node_modules/"), "{tree_noise}");

    let by_size = run(serde_json::json!({ "path": ".", "depth": 3, "type": "file", "sort": "size" })).await;
    assert_eq!(
        by_size.lines().map(|l| l.split('\t').next().unwrap()).collect::<Vec<_>>(),
        ["docs/readme.md", "src/a.ts", "src/b.ts", "top.txt"],
        "{by_size}"
    );
    // Below the first level the listing is the search server's inventory: it names a noise directory itself, and nothing in it.
    let dirs = run(serde_json::json!({ "path": ".", "depth": 2, "type": "dir" })).await;
    assert_eq!(dirs.lines().collect::<Vec<_>>(), ["docs\tdir", "node_modules\tdir", "src\tdir"], "{dirs}");
    let first_level = run(serde_json::json!({ "path": ".", "type": "dir" })).await;
    // The one noise folder the walk left out is counted (issue #339).
    assert_eq!(first_level.lines().collect::<Vec<_>>(), ["docs\tdir", "src\tdir", "1 noise entries excluded (include_noise:true to show)"], "{first_level}");
    let none = run(serde_json::json!({ "path": "src", "type": "dir" })).await;
    assert_eq!(none, "(no entries match filter) type=dir, hidden=false path=src", "{none}");
    let noisy = run(serde_json::json!({ "path": ".", "depth": 2, "include_noise": true, "type": "dir" })).await;
    assert!(noisy.lines().any(|l| l == "node_modules\tdir"), "{noisy}");

    let found = run(serde_json::json!({ "mode": "find", "name": ".ts", "sort": "name" })).await;
    let names: Vec<&str> = found.lines().map(|l| l.split('\t').next().unwrap()).collect();
    assert_eq!(names, ["src/a.ts", "src/b.ts"], "{found}");
    let big = run(serde_json::json!({ "mode": "find", "min_size": 8, "sort": "name" })).await;
    assert_eq!(big.lines().map(|l| l.split('\t').next().unwrap()).collect::<Vec<_>>(), ["docs/readme.md", "src/a.ts"], "{big}");
    let named_glob_path = run(serde_json::json!({ "path": "src", "name": "b.ts", "mode": "find" })).await;
    assert!(named_glob_path.starts_with("b.ts\t"), "{named_glob_path}");
    let (is_error, bad) = text_of(tool.call(&ctx, serde_json::json!({ "mode": "find", "modified_after": "nonsense" })).await);
    assert!(is_error, "{bad}");
    assert_eq!(bad, "Error: invalid modified_after \"nonsense\"; expected an ISO date/time or a relative window like 90m / 12h / 7d");
}




/// Broad searches of different sessions run at once up to the gate's limit; at a limit of 1 the second session's search
/// waits behind the first, as Node's one search at a time does, and is refused once its budget has passed.
#[tokio::test(start_paused = true)]
async fn broad_searches_of_different_sessions_run_at_once_up_to_the_limit() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-broad-search-limit")).unwrap();
    let ctx = context(&root).await;
    let gate = super::search::broad_search_gate();
    gate.set_limit(2);
    let held = gate.enter("other-session", &CancellationToken::new()).await.unwrap();
    let out = GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "**/*.md" })).await.unwrap();
    let telemetry = &out.meta.as_ref().unwrap()[super::common::LOCAL_SEARCH_META];
    assert_eq!(telemetry["broad_admissions"], 1, "admitted beside the other session's search: {telemetry}");
    assert_eq!(telemetry["broad_wait_ms"], 0, "{telemetry}");
    gate.set_limit(1);
    let (is_error, text) = text_of(GlobTool::new().call(&ctx, serde_json::json!({ "pattern": "**/*.md" })).await);
    assert!(is_error && text.contains("broad search not started: waited "), "{text}");
    drop(held);
    assert!(!gate.is_busy());
}

/// A search that waited for its turn tells the call's trace how long it waited apart from how long it ran.
#[tokio::test(start_paused = true)]
async fn a_broad_search_records_its_admission_wait_apart_from_its_run() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-broad-search-wait")).unwrap();
    let ctx = context(&root).await;
    let gate = super::search::broad_search_gate();
    gate.set_limit(1);
    let held = gate.enter("other-session", &CancellationToken::new()).await.unwrap();
    let release = async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        drop(held);
    };
    let glob = GlobTool::new();
    let (out, ()) = tokio::join!(glob.call(&ctx, serde_json::json!({ "pattern": "**/*.md" })), release);
    let out = out.unwrap();
    let telemetry = &out.meta.as_ref().unwrap()[super::common::LOCAL_SEARCH_META];
    assert_eq!(telemetry["broad_searches"], 1, "{telemetry}");
    let (wait, run) = (telemetry["broad_wait_ms"].as_u64().unwrap(), telemetry["broad_run_ms"].as_u64().unwrap());
    assert!(wait >= 300 && run < 300, "waited {wait}ms, ran {run}ms");
    // Node's own keys stay Node's: a search that waited reports no admission of its own.
    assert!(telemetry.get("broad_admissions").is_none(), "{telemetry}");
    assert!(!gate.is_busy());
}

/// A tree listing's walk is a broad search: it waits for its turn behind a held gate and tells its wait.
#[tokio::test(start_paused = true)]
async fn a_tree_listing_takes_its_turn_as_a_broad_search() {
    let root = AbsPath::new(std::env::temp_dir().join("mixdog-broad-search-tree")).unwrap();
    let ctx = context(&root).await;
    let gate = super::search::broad_search_gate();
    gate.set_limit(1);
    let held = gate.enter("other-session", &CancellationToken::new()).await.unwrap();
    let release = async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        drop(held);
    };
    let list = ListTool::new();
    let (out, ()) = tokio::join!(list.call(&ctx, serde_json::json!({ "mode": "tree" })), release);
    let out = out.unwrap();
    let telemetry = &out.meta.as_ref().unwrap()[super::common::LOCAL_SEARCH_META];
    assert_eq!(telemetry["broad_searches"], 1, "{telemetry}");
    assert!(telemetry["broad_wait_ms"].as_u64().unwrap() >= 200, "{telemetry}");
    assert!(!gate.is_busy());
}
