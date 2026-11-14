#![allow(clippy::disallowed_methods, reason = "test setup: scratch files are written and read on the test thread")]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use serde_json::Value;
use serde_json::json;

use super::*;

const POSIX: PathFlavor = PathFlavor { windows: false, drive: 'C' };
const WINDOWS: PathFlavor = PathFlavor { windows: true, drive: 'C' };

fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

// ---- transcript-file-links.test.mjs ----------------------------------------------------------------------------------

#[test]
fn an_href_is_decoded_the_way_markdown_link_decodes_it_and_a_web_link_names_no_file() {
    let cwd = "/work/project";
    let at = |href: &str| requested_link_path(POSIX, href, cwd);
    assert_eq!(at("file:///srv/out/deck.pptx").as_deref(), Some("/srv/out/deck.pptx"));
    assert_eq!(at("out/shot%20one.png").as_deref(), Some("/work/project/out/shot one.png"));
    assert_eq!(at("out/report.pdf:12").as_deref(), Some("/work/project/out/report.pdf"));
    assert_eq!(at("src/app.ts#L4").as_deref(), Some("/work/project/src/app.ts"));
    assert_eq!(at("./notes.md.").as_deref(), Some("/work/project/notes.md"));
    assert_eq!(at("https://example.com/a/b.txt"), None);
    assert_eq!(at(""), None);
    // Locations: a range, a column, a drive letter never taken for a line, an invalid position dropped with its suffix.
    assert_eq!(at("a.ts:12:4-9").as_deref(), Some("/work/project/a.ts"));
    assert_eq!(at("a.ts#L12C4-L20").as_deref(), Some("/work/project/a.ts"));
    assert_eq!(at("a.ts:0").as_deref(), Some("/work/project/a.ts"));
    assert_eq!(at("mailto:x@y.z"), None);
    assert_eq!(at("#section"), None);
    assert_eq!(at("//server/share/a.pdf"), None);
    assert_eq!(at("bad%zz.txt").as_deref(), Some("/work/project/bad%zz.txt"));
}

#[test]
fn windows_hrefs_resolve_with_node_win32_rules() {
    let cwd = "C:\\work\\project";
    let at = |href: &str| requested_link_path(WINDOWS, href, cwd);
    assert_eq!(at("file:///c:/srv/out/deck.pptx").as_deref(), Some("c:\\srv\\out\\deck.pptx"));
    assert_eq!(at("D:\\out\\a.txt:3").as_deref(), Some("D:\\out\\a.txt"));
    assert_eq!(at("D:/out/a.txt").as_deref(), Some("D:\\out\\a.txt"));
    assert_eq!(at("out/shot%20one.png").as_deref(), Some("C:\\work\\project\\out\\shot one.png"));
    assert_eq!(at("../up.txt").as_deref(), Some("C:\\work\\up.txt"));
    assert_eq!(at("/rooted/x.txt").as_deref(), Some("C:\\rooted\\x.txt"));
    assert_eq!(at("\\\\server\\share\\a.pdf"), None);
    assert_eq!(resolve_linked_path(WINDOWS, "a/../../..", "C:\\work").as_deref(), Some("C:\\"));
}

#[test]
fn a_link_resolves_against_the_session_folder_and_network_paths_never_resolve() {
    let cwd = "/work/project";
    assert_eq!(resolve_linked_path(POSIX, "out/a.pdf", cwd).as_deref(), Some("/work/project/out/a.pdf"));
    assert_eq!(resolve_linked_path(POSIX, "../b.pdf", cwd).as_deref(), Some("/work/b.pdf"));
    assert_eq!(resolve_linked_path(POSIX, "out/a.pdf", ""), None);
    assert_eq!(resolve_linked_path(POSIX, "out/a.pdf", "relative"), None);
    assert_eq!(resolve_linked_path(POSIX, "//server/share/a.pdf", cwd), None);
    assert_eq!(resolve_linked_path(POSIX, "/a/./b//c/", cwd).as_deref(), Some("/a/b/c"));
    assert_eq!(resolve_linked_path(WINDOWS, "out\\a.pdf", "C:/work").as_deref(), Some("C:\\work\\out\\a.pdf"));
}

#[test]
fn a_task_reports_and_a_room_speechs_returned_files_are_attachments_and_other_notices_carry_none() {
    let id = "a".repeat(64);
    let record = |id: &str| json!({ "id": id, "attachmentRef": id, "kind": "image", "name": "chart.png", "mimeType": "image/png", "size": 3 });
    let snapshot = json!({ "items": [
        { "kind": "notice", "routine": { "kind": "task", "files": [{ "path": "/work/project/clip.mp4" }, { "path": "relative.txt" }] }, "attachments": [record(&id)] },
        { "kind": "notice", "routine": { "kind": "schedule", "files": [{ "path": "/etc/x" }] }, "attachments": [record(&"b".repeat(64))] },
        { "kind": "notice", "room": { "kind": "speech" }, "attachments": [record(&"c".repeat(64))] },
    ] });
    let ids: Vec<String> = session_attachments(&snapshot).into_iter().map(|a| a.id).collect();
    assert_eq!(ids, [id, "c".repeat(64)]);
}

// ---- session-attachments.test.mjs ------------------------------------------------------------------------------------

struct Fixture {
    ids: HashMap<&'static str, String>,
    store: Mutex<HashMap<String, Vec<u8>>>,
    transcripts: HashMap<&'static str, Value>,
    histories: HashMap<&'static str, Value>,
    with_history: bool,
}

#[async_trait]
impl AttachmentHost for Fixture {
    async fn session_transcript(&self, session_id: &str) -> Option<Value> {
        self.transcripts.get(session_id).cloned()
    }

    async fn session_history(&self, session_id: &str) -> Option<Value> {
        self.with_history.then(|| self.histories.get(session_id).cloned()).flatten()
    }

    async fn attachment_bytes(&self, id: &str) -> Option<Vec<u8>> {
        self.store.lock().unwrap().get(id).cloned()
    }
}

fn fixture(with_history: bool) -> Fixture {
    let blobs: [(&'static str, Vec<u8>); 6] = [
        ("pdf", b"%PDF-1.7\nspec body".to_vec()),
        ("note", "notes ".repeat(200).into_bytes()),
        ("shot", b"png bytes".to_vec()),
        ("old", b"legacy image bytes".to_vec()),
        ("secret", b"another session attachment".to_vec()),
        ("archived", b"image pasted before a compaction".to_vec()),
    ];
    let ids: HashMap<&'static str, String> = blobs.iter().map(|(name, bytes)| (*name, sha(bytes))).collect();
    let store = Mutex::new(blobs.iter().map(|(_, bytes)| (sha(bytes), bytes.clone())).collect());
    let record = |name: &str, kind: &str, file: &str, mime: &str, size: usize| {
        json!({ "id": ids[name], "attachmentRef": ids[name], "kind": kind, "name": file, "mimeType": mime, "size": size })
    };
    let transcripts = HashMap::from([
        ("s1", json!({ "items": [
            { "id": "u1", "kind": "user", "text": "hello", "attachments": [
                record("pdf", "file", "spec.pdf", "application/pdf", 18),
                record("note", "text", "notes.md", "text/markdown", 1200),
                record("shot", "image", "shot.png", "image/png", 9),
            ] },
            { "id": "u0", "kind": "user", "text": "old", "images": [{ "id": 1, "name": "old.png", "mimeType": "image/png", "attachmentRef": ids["old"] }] },
            { "id": "a1", "kind": "assistant", "text": ids["secret"], "attachments": [record("secret", "file", "x.bin", "x/y", 1)] },
            { "id": "t1", "kind": "tool", "name": "shell", "result": ids["secret"] },
        ] })),
        ("s2", json!({ "items": [
            { "id": "u2", "kind": "user", "text": "other", "attachments": [record("secret", "file", "secret.bin", "application/octet-stream", 1)] },
        ] })),
    ]);
    let histories = HashMap::from([(
        "s1",
        json!({ "items": [
            { "id": "arch1_0_1", "kind": "user", "archived": true,
              "attachments": [record("archived", "image", "image.png", "image/png", 1)],
              "images": [{ "id": 1, "name": "image.png", "mimeType": "image/png", "attachmentRef": ids["archived"] }] },
            { "id": "arch1_1_1", "kind": "assistant", "archived": true, "attachments": [record("secret", "file", "x.bin", "x/y", 1)] },
        ] }),
    )]);
    Fixture { ids, store, transcripts, histories, with_history }
}

fn refused(result: Result<(SessionAttachment, Vec<u8>), AttachmentError>, reason: &str) {
    match result {
        Err(AttachmentError::Refused { reason: got, .. }) => assert_eq!(got, reason),
        other => panic!("expected a {reason} refusal, got {:?}", other.map(|(meta, _)| meta.id)),
    }
}

#[tokio::test]
async fn a_session_names_its_attachments_from_user_rows_only_legacy_images_included() {
    let host = fixture(true);
    let found = session_attachments(&host.transcripts["s1"]);
    let mut got: Vec<&str> = found.iter().map(|a| a.id.as_str()).collect();
    got.sort_unstable();
    let mut want: Vec<&str> = ["pdf", "note", "shot", "old"].iter().map(|n| host.ids[n].as_str()).collect();
    want.sort_unstable();
    assert_eq!(got, want);
    let pdf = found.iter().find(|a| a.id == host.ids["pdf"]).unwrap();
    assert_eq!((pdf.name.as_str(), pdf.size), ("spec.pdf", 18.0));
    assert_eq!(found.iter().find(|a| a.id == host.ids["old"]).unwrap().kind, json!("image"));
    assert!(found.iter().all(|a| a.id != host.ids["secret"]));
    let bad = json!({ "items": [{ "kind": "user", "attachments": [{ "id": "../x" }, { "id": "a".repeat(63) }] }] });
    assert!(session_attachments(&bad).is_empty());
}

#[tokio::test]
async fn an_attachment_reads_by_id_for_its_own_session_and_for_no_other() {
    let host = fixture(true);
    let (meta, bytes) = read_session_attachment(&host, "s1", &host.ids["pdf"]).await.unwrap();
    assert_eq!(meta.name, "spec.pdf");
    assert_eq!(bytes, b"%PDF-1.7\nspec body");
    // Another session's id, an id nothing names, a printed hash, a malformed id.
    refused(read_session_attachment(&host, "s1", &host.ids["secret"]).await, "not-linked");
    refused(read_session_attachment(&host, "s2", &host.ids["pdf"]).await, "not-linked");
    refused(read_session_attachment(&host, "missing", &host.ids["pdf"]).await, "not-linked");
    refused(read_session_attachment(&host, "s1", &sha(b"guess")).await, "not-linked");
    assert_eq!(read_session_attachment(&host, "s1", "../../etc/passwd").await.unwrap_err(), AttachmentError::InvalidId);
    assert_eq!(read_session_attachment(&host, "s1", &host.ids["pdf"].to_uppercase()).await.unwrap_err(), AttachmentError::InvalidId);
    // The legacy image resolves by its own ref.
    assert_eq!(read_session_attachment(&host, "s1", &host.ids["old"]).await.unwrap().0.kind, json!("image"));
}

#[tokio::test]
async fn an_attachment_only_the_compacted_history_names_opens_and_another_sessions_id_is_still_refused() {
    let host = fixture(true);
    let archived = &host.ids["archived"];
    // The transcript window the host holds does not name it.
    assert!(session_attachments(&host.transcripts["s1"]).iter().all(|a| &a.id != archived));
    let (meta, bytes) = read_session_attachment(&host, "s1", archived).await.unwrap();
    assert_eq!(meta.name, "image.png");
    assert_eq!(bytes, b"image pasted before a compaction");
    // The history belongs to s1 alone, and only its user rows grant an id.
    refused(read_session_attachment(&host, "s2", archived).await, "not-linked");
    refused(read_session_attachment(&host, "s1", &host.ids["secret"]).await, "not-linked");
    refused(read_session_attachment(&host, "s1", &sha(b"guess")).await, "not-linked");
    refused(read_session_attachment(&host, "missing", archived).await, "not-linked");
    // A host that cannot read the stored history serves the window alone.
    let window_only = fixture(false);
    refused(read_session_attachment(&window_only, "s1", &window_only.ids["archived"]).await, "not-linked");
    assert_eq!(read_session_attachment(&window_only, "s1", &window_only.ids["pdf"]).await.unwrap().0.name, "spec.pdf");
}

#[tokio::test]
async fn a_named_attachment_the_store_no_longer_holds_or_holds_corrupted_is_not_served() {
    let host = fixture(true);
    host.store.lock().unwrap().remove(&host.ids["note"]);
    refused(read_session_attachment(&host, "s1", &host.ids["note"]).await, "not-found");
    host.store.lock().unwrap().insert(host.ids["pdf"].clone(), b"tampered".to_vec());
    refused(read_session_attachment(&host, "s1", &host.ids["pdf"]).await, "changed");
    host.store.lock().unwrap().insert(host.ids["shot"].clone(), Vec::new());
    refused(read_session_attachment(&host, "s1", &host.ids["shot"]).await, "not-found");
}

#[test]
fn an_attachment_stages_under_the_temp_directory_with_a_previewable_name() {
    let meta = |name: &str, mime: &str| SessionAttachment { id: "0123456789abcdef".repeat(4), name: name.into(), mime_type: mime.into(), kind: json!("file"), size: 1.0 };
    assert_eq!(attachment_view_name(&meta("spec.pdf", "application/pdf")), "spec.pdf");
    assert_eq!(attachment_view_name(&meta("shot", "IMAGE/PNG")), "shot.png");
    assert_eq!(attachment_view_name(&meta("notes", "application/zip")), "notes");
    assert_eq!(attachment_view_name(&meta(".hidden", "text/plain")), "hidden.txt");
    assert_eq!(attachment_view_name(&meta("a/b:c*.md", "x/y")), "a-b-c-.md");
    assert_eq!(attachment_view_name(&meta("", "text/markdown")), "download.md");
    assert_eq!(attachment_view_name(&meta("  ..name. ", "image/gif")), "name.gif");
    let temp = tempfile::tempdir().unwrap();
    let path = stage_session_attachment(temp.path(), &meta("spec.pdf", "application/pdf"), b"bytes").unwrap();
    assert_eq!(path, temp.path().join("mixdog-attachments").join("0123456789abcdef-spec.pdf"));
    assert_eq!(std::fs::read(&path).unwrap(), b"bytes");
    // Staged twice, the file is replaced.
    stage_session_attachment(temp.path(), &meta("spec.pdf", "application/pdf"), b"again").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"again");
    assert_eq!(stage_session_attachment(Path::new(""), &meta("a", "x/y"), b"").unwrap_err(), "Unable to open file: no temporary directory.");
}

// ---- workflow-config.ts ----------------------------------------------------------------------------------------------

#[test]
fn jsonc_comments_and_trailing_commas_are_read_and_strings_are_left_alone() {
    let text = "{\n  // line\n  \"a\": 1, /* block\n  spanning */ \"b\": [1, 2,],\n  \"url\": \"http://x/*y*/ // z\",\n  \"c\": {\"d\": \"q\\\"//\",},\n}\n";
    assert_eq!(parse_jsonc(text).unwrap(), json!({ "a": 1, "b": [1, 2], "url": "http://x/*y*/ // z", "c": { "d": "q\"//" } }));
    assert!(parse_jsonc("{\"a\": }").is_err());
    assert_eq!(parse_jsonc(&format!("\"{}\"", "x".repeat(2_000_000))).unwrap_err(), "JSON configuration is too large.");
    assert_eq!(object_record(json!([1])), None);
    assert_eq!(object_record(json!({ "a": 1 })).unwrap()["a"], 1);
}

#[test]
fn a_jsonc_file_that_is_missing_empty_or_nul_filled_holds_no_settings() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("config.jsonc");
    assert_eq!(read_jsonc_file(&file).unwrap(), None);
    std::fs::write(&file, "").unwrap();
    assert_eq!(read_jsonc_file(&file).unwrap(), None);
    std::fs::write(&file, "\0\0 \r\n\0").unwrap();
    assert_eq!(read_jsonc_file(&file).unwrap(), None);
    std::fs::write(&file, "[1, 2]").unwrap();
    assert_eq!(read_jsonc_file(&file).unwrap(), None);
    std::fs::write(&file, "{ // mine\n \"mode\": \"x\", }").unwrap();
    assert_eq!(Value::Object(read_jsonc_file(&file).unwrap().unwrap()), json!({ "mode": "x" }));
    std::fs::write(&file, "{ broken").unwrap();
    assert!(read_jsonc_file(&file).is_err());
    // A directory is a read failure, not "no settings".
    assert!(read_jsonc_file(dir.path()).is_err());
}

// ---- system-fonts.test.mjs -------------------------------------------------------------------------------------------

#[test]
fn font_listings_become_sorted_unique_family_names() {
    let mut sorted = ["Arial", "Segoe UI", "맑은 고딕"];
    sorted.sort_by(|a, b| mixdog_js::locale_compare(a, b));
    assert_eq!(parse_font_families("win32", "Segoe UI\r\nArial\r\n맑은 고딕\r\nArial\r\n\r\n"), sorted);
    // fontconfig joins a family's localized names with commas.
    assert_eq!(
        parse_font_families("linux", "DejaVu Sans\nNoto Sans CJK KR,Noto Sans CJK KR Bold\n"),
        ["DejaVu Sans", "Noto Sans CJK KR", "Noto Sans CJK KR Bold"]
    );
    // Hidden macOS system faces start with a dot.
    assert_eq!(parse_font_families("darwin", ".SF NS\nHelvetica Neue\nMenlo"), ["Helvetica Neue", "Menlo"]);
    assert_eq!(parse_font_families("win32", &format!("{}\nArial", "x".repeat(101))), ["Arial"]);
    // A comma is part of a name outside fontconfig.
    assert_eq!(parse_font_families("win32", "A, B"), ["A, B"]);
    // `localeCompare` order: a letter's cases stay together, whatever their code points.
    let cased = parse_font_families("win32", "b\nB\nA\na");
    assert_eq!(cased[..2].iter().map(|name| name.to_lowercase()).collect::<Vec<_>>(), ["a", "a"]);
    assert_eq!(cased[2..].iter().map(|name| name.to_lowercase()).collect::<Vec<_>>(), ["b", "b"]);
}

#[test]
fn a_platform_without_a_listing_answers_an_empty_list_and_free_text_stays() {
    assert!(list_system_fonts_uncached("aix").is_empty());
}

// ---- the service -----------------------------------------------------------------------------------------------------

fn service(host: Fixture) -> DesktopResidualService {
    DesktopResidualService::new(Arc::new(host), &mixdog_rt::testing::tokens())
}

#[tokio::test]
async fn the_service_answers_links_attachments_and_settings() {
    let host = fixture(true);
    let pdf = host.ids["pdf"].clone();
    let secret = host.ids["secret"].clone();
    let service = service(host);
    let ask = |method: &'static str, params: Value| value(&service, request(method, params, None));

    let link = ask("desktop/link/resolve", json!({ "href": "out/a.pdf:3", "cwd": std::env::temp_dir() })).await.unwrap();
    let expected = resolve_linked_path(PathFlavor::host(), "out/a.pdf", &std::env::temp_dir().to_string_lossy());
    assert_eq!(link["path"], json!(expected));
    assert_eq!(ask("desktop/link/resolve", json!({ "href": "https://example.com/a" })).await.unwrap(), json!({ "path": null }));
    assert_eq!(ask("desktop/link/resolvePath", json!({ "path": "//server/share" })).await.unwrap(), json!({ "path": null }));

    let resolved = ask("desktop/attachment/resolve", json!({ "sessionId": "s1", "attachmentId": pdf })).await.unwrap();
    assert_eq!(resolved["attachment"]["name"], "spec.pdf");
    assert_eq!(resolved["bytes"], 18);
    assert_eq!(resolved["viewName"], "spec.pdf");
    assert_eq!(resolved["dataUrl"], "data:application/pdf;base64,JVBERi0xLjcKc3BlYyBib2R5");
    let error = ask("desktop/attachment/resolve", json!({ "sessionId": "s2", "attachmentId": pdf })).await.unwrap_err();
    assert!(format!("{error:?}").contains("file-download:not-linked"), "{error:?}");
    let error = ask("desktop/attachment/resolve", json!({ "sessionId": "s1", "attachmentId": secret })).await.unwrap_err();
    assert!(format!("{error:?}").contains("file-download:not-linked"), "{error:?}");
    assert!(ask("desktop/attachment/resolve", json!({ "sessionId": "s1", "attachmentId": "../x" })).await.is_err());
    assert!(ask("desktop/attachment/resolve", json!({ "sessionId": "s1", "attachmentId": pdf, "extra": 1 })).await.is_err());

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("w.jsonc");
    std::fs::write(&file, "{ \"a\": 1, }").unwrap();
    assert_eq!(ask("desktop/workflowConfig/read", json!({ "path": file })).await.unwrap(), json!({ "config": { "a": 1 } }));
    assert_eq!(ask("desktop/workflowConfig/read", json!({ "path": dir.path().join("none.jsonc") })).await.unwrap(), json!({ "config": null }));
}

#[test]
fn a_session_id_is_trimmed_and_holds_only_id_characters() {
    assert_eq!(required_session_id("  s_1-A "), Some("s_1-A"));
    for bad in ["", "   ", "a b", "a/b", "..", "é", &"x".repeat(257)] {
        assert_eq!(required_session_id(bad), None, "{bad:?}");
    }
    assert!(required_session_id(&"x".repeat(256)).is_some());
}
