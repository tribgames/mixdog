//! Owner: s4-engine-reply
//! What the session downloaded, as the agent reads it (the text part of `downloads.ts`): the `downloads` listing, the lines a page
//! report adds for downloads the caller has not heard about, and the wording of the attach and wait refusals. The ledger itself
//! (naming, size limits, the files) is the host's; the engine reads it through `host/browser/downloads`.

use std::collections::HashMap;

use mixdog_app_protocol::v2::browser_engine::DownloadItem;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_browser_policy::redaction::redact_url;

/// The size a download is reported at, in whole KB, at least 1 (`Math.max(1, Math.round(bytes / 1024))`).
fn kilobytes(download: &DownloadItem) -> i64 {
    let bytes = if download.total > 0 { download.total } else { download.received };
    (((bytes as f64) / 1024.0 + 0.5).floor() as i64).max(1)
}

/// Downloads the caller has not heard about from this page yet: started or finished after `reported_at` (`unreportedDownloads`).
pub fn unreported_downloads(downloads: &[DownloadItem], reported_at: i64) -> Vec<&DownloadItem> {
    downloads.iter().filter(|download| download.started_at > reported_at || download.completed_at.unwrap_or(0) > reported_at).collect()
}

/// The state each download of a session was last reported in. Downloads belong to the session, but each page keeps its own cursor,
/// so a second page would announce what a first one already reported.
#[derive(Debug, Default)]
pub struct DownloadReports {
    states: HashMap<String, String>,
}

/// Downloads a reply should mention: new to the page and not yet reported, in their current state, by any page of the session. They
/// are marked reported, and the page's cursor moves to `now_ms` (`takeDownloads`).
pub fn take_downloads(downloads: &[DownloadItem], page_reported_at: &mut i64, reports: &mut DownloadReports, now_ms: i64) -> Vec<DownloadItem> {
    let fresh: Vec<DownloadItem> = unreported_downloads(downloads, *page_reported_at)
        .into_iter()
        .filter(|download| reports.states.get(&download.id).map(String::as_str) != Some(download.state.as_str()))
        .cloned()
        .collect();
    for download in &fresh {
        reports.states.insert(download.id.clone(), download.state.clone());
    }
    *page_reported_at = now_ms;
    fresh
}

/// The `- [id] file — state, N KB → path` line of a download a page report lists.
pub fn report_line(download: &DownloadItem) -> String {
    format!("- [{}] {} — {}, {} KB → {}", download.id, redact_browser_text(&download.file), download.state, kilobytes(download), download.path)
}

/// The `downloads` reply text: every recorded download, newest first (`No downloads this session.` when there is none).
pub fn list_text(recorded: &[DownloadItem]) -> String {
    if recorded.is_empty() {
        return "No downloads this session.".to_owned();
    }
    let lines: Vec<String> = recorded
        .iter()
        .map(|entry| {
            format!(
                "- [{}] {} — {}, {} KB, {} → {}\n  from {}",
                entry.id,
                redact_browser_text(&entry.file),
                entry.state,
                kilobytes(entry),
                entry.mime_type,
                entry.path,
                redact_url(&entry.url)
            )
        })
        .collect();
    format!("Downloads this session (newest first):\n{}", lines.join("\n"))
}

/// What the listing says after it attached a download.
pub fn attached_note(download: &DownloadItem) -> String {
    format!("\n\nAttached download {} as {}.", download.id, download.file)
}

/// Extension-derived type, used only when Chromium reported nothing useful (`downloadMimeType`).
pub fn download_mime_type(path: &str, fallback: &str) -> String {
    let extension = path.rsplit('.').next().unwrap_or_default().to_lowercase();
    let known = match extension.as_str() {
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        _ => "",
    };
    if !known.is_empty() {
        known.to_owned()
    } else if !fallback.is_empty() {
        fallback.to_owned()
    } else {
        "application/octet-stream".to_owned()
    }
}

/// A wait for a download that ended in a state other than completed.
pub fn ended_as(id: &str, state: &str) -> String {
    format!("download {id} ended as {state}")
}

/// A wait that ran out of time; `selected` is the download it was pinned to, if any.
pub fn did_not_complete(selected: Option<&str>, timeout_ms: u64) -> String {
    format!("download {} did not complete within {timeout_ms}ms", selected.filter(|id| !id.is_empty()).unwrap_or("(not started)"))
}

/// An attach with nothing completed to attach.
pub fn none_to_attach() -> &'static str {
    "no completed download is available to attach"
}

/// An attach of a download that has not completed.
pub fn not_complete_to_attach(id: &str, state: &str) -> String {
    format!("download {id} is {state}; wait for completion before attaching")
}

/// An attach of a path that is not a file.
pub fn not_a_file(id: &str) -> String {
    format!("download {id} is not a readable file")
}

/// An attach of a file above the inline limit; the agent reads it by path instead.
pub fn too_large_to_attach(id: &str, size: u64, limit: u64, path: &str) -> String {
    format!("download {id} is {size} bytes; inline attachment limit is {limit} bytes. Use read with path {path}")
}

/// An attach of a file that grew or shrank while it was read.
pub fn changed_while_attaching(id: &str) -> String {
    format!("download {id} changed while it was being attached; retry")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn download(value: serde_json::Value) -> DownloadItem {
        let mut base = json!({"id": "d1", "file": "a.csv", "path": "C:/tmp/a.csv", "url": "https://a.test/f?x=1", "mimeType": "text/csv", "state": "completed", "received": 2048, "total": 2048, "startedAt": 1});
        if let (Some(target), Some(extra)) = (base.as_object_mut(), value.as_object()) {
            target.extend(extra.clone());
        }
        serde_json::from_value(base).expect("download")
    }

    #[test]
    fn unreported_downloads_are_those_started_or_finished_after_the_last_report() {
        let downloads = vec![
            download(json!({"id": "d3", "startedAt": 300, "state": "in_progress"})),
            download(json!({"id": "d2", "startedAt": 150, "completedAt": 250})),
            download(json!({"id": "d1", "startedAt": 50, "completedAt": 90})),
        ];
        let ids = |reported_at| unreported_downloads(&downloads, reported_at).iter().map(|entry| entry.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(200), ["d3", "d2"]);
        assert_eq!(ids(0), ["d3", "d2", "d1"]);
        assert!(ids(400).is_empty());
    }

    #[test]
    fn a_download_state_is_reported_once_for_the_session_not_once_per_page() {
        let mut reports = DownloadReports::default();
        let (mut first_cursor, mut second_cursor) = (0, 0);
        let mut running = download(json!({"id": "d1", "file": "Images.txt", "path": "C:/tmp/Images.txt", "state": "in_progress", "received": 10, "total": 2048, "startedAt": 60_000}));
        let said = take_downloads(std::slice::from_ref(&running), &mut first_cursor, &mut reports, 1);
        assert_eq!(said.iter().map(report_line).collect::<Vec<_>>(), ["- [d1] Images.txt — in_progress, 2 KB → C:/tmp/Images.txt"]);
        assert!(take_downloads(std::slice::from_ref(&running), &mut second_cursor, &mut reports, 1).is_empty(), "the other page already heard this state");
        assert!(take_downloads(std::slice::from_ref(&running), &mut first_cursor, &mut reports, 2).is_empty());

        running.state = "completed".into();
        running.completed_at = Some(60_000);
        let finished = take_downloads(std::slice::from_ref(&running), &mut second_cursor, &mut reports, 2);
        assert_eq!(finished.len(), 1, "a state change is news to the other page");
        assert!(take_downloads(std::slice::from_ref(&running), &mut first_cursor, &mut reports, 3).is_empty(), "a state change is also said once");
    }

    #[test]
    fn a_report_line_rounds_the_size_to_whole_kilobytes_and_names_at_least_one() {
        assert_eq!(report_line(&download(json!({"received": 0, "total": 0}))), "- [d1] a.csv — completed, 1 KB → C:/tmp/a.csv");
        assert_eq!(report_line(&download(json!({"total": 0, "received": 1536}))), "- [d1] a.csv — completed, 2 KB → C:/tmp/a.csv");
        assert_eq!(report_line(&download(json!({"total": 1535}))), "- [d1] a.csv — completed, 1 KB → C:/tmp/a.csv");
    }

    #[test]
    fn the_listing_is_newest_first_with_the_origin_redacted() {
        assert_eq!(list_text(&[]), "No downloads this session.");
        let text = list_text(&[download(json!({})), download(json!({"id": "d0", "file": "b.pdf", "mimeType": "application/pdf"}))]);
        assert_eq!(
            text,
            "Downloads this session (newest first):\n- [d1] a.csv — completed, 2 KB, text/csv → C:/tmp/a.csv\n  from https://a.test/f?x=1\n\
             - [d0] b.pdf — completed, 2 KB, application/pdf → C:/tmp/a.csv\n  from https://a.test/f?x=1"
        );
        let secret = list_text(&[download(json!({"url": "https://a.test/f?token=abc123"}))]);
        assert!(!secret.contains("abc123"), "{secret}");
        assert_eq!(attached_note(&download(json!({}))), "\n\nAttached download d1 as a.csv.");
    }

    #[test]
    fn the_type_follows_the_extension_and_falls_back_to_what_chromium_said() {
        assert_eq!(download_mime_type("C:/x/Report.PDF", "application/octet-stream"), "application/pdf");
        assert_eq!(download_mime_type("a.jpeg", ""), "image/jpeg");
        assert_eq!(download_mime_type("a.unknown", "text/x-thing"), "text/x-thing");
        assert_eq!(download_mime_type("noextension", ""), "application/octet-stream");
    }

    #[test]
    fn the_refusals_read_as_they_always_did() {
        assert_eq!(ended_as("d2", "cancelled"), "download d2 ended as cancelled");
        assert_eq!(did_not_complete(None, 10_000), "download (not started) did not complete within 10000ms");
        assert_eq!(did_not_complete(Some("d3"), 500), "download d3 did not complete within 500ms");
        assert_eq!(none_to_attach(), "no completed download is available to attach");
        assert_eq!(not_complete_to_attach("d1", "in_progress"), "download d1 is in_progress; wait for completion before attaching");
        assert_eq!(not_a_file("d1"), "download d1 is not a readable file");
        assert_eq!(too_large_to_attach("d1", 9, 8, "C:/x"), "download d1 is 9 bytes; inline attachment limit is 8 bytes. Use read with path C:/x");
        assert_eq!(changed_while_attaching("d1"), "download d1 changed while it was being attached; retry");
    }
}
