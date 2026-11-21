//! A synthetic 1.4.5 upgrade interrupted after the queue has been published.

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_protocol::PromptContent;
use mixdog_protocol::SubmitOptions;
use serde_json::Value;
use serde_json::json;

use super::target::read_sessions;
use super::*;
use crate::run::tests::migrator;
use crate::run::tests::write;

struct PendingCorpus {
    _dir: tempfile::TempDir,
    roots: MigrationRoots,
    digest: String,
    parts: Value,
    fresh: i64,
}

fn pending_corpus() -> PendingCorpus {
    let dir = tempfile::tempdir().unwrap();
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    durable::create_dir_all(&roots.home).unwrap();
    let seed = |path: &str, value: Value| {
        write(&roots.data, path, &serde_json::to_vec(&value).unwrap());
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    let fresh = now - 10_000;
    let stale = now - 31 * 60 * 1000;
    seed(
        "sessions/lead.json",
        json!({
            "id": "lead",
            "deliveredPendingMessageIds": ["delivered"],
            "messages": [
                {"role":"user", "content":[{"type":"text", "text":"Wrapped: repeat this, please"}], "meta":{"transcript":{
                    "checkpointId":"it_1", "submissionIds":["already-steered"]
                }}}
            ]
        }),
    );
    // The steering key is reserved, even if there is a session with that literal ID.
    seed("sessions/tui_lead.json", json!({"id":"tui_lead", "messages":[]}));
    seed("sessions/other.json", json!({"id":"other", "messages":[]}));
    let bytes = b"synthetic attachment";
    let digest = durable::sha256_hex(bytes);
    write(&roots.data, &format!("blobs/sha256/{}/{digest}", &digest[..2]), bytes);
    let parts = json!([
        {"type":"text", "text":"read the attachment"},
        {"type":"text", "textKind":"paste", "attachmentRef":digest, "sizeBytes":bytes.len()},
        {"type":"image", "attachmentRef":digest, "mimeType":"image/png", "sizeBytes":bytes.len()}
    ]);
    let pasted = json!({
        "1":{"attachmentRef":digest, "sizeBytes":bytes.len(), "chars":bytes.len()}
    });
    let images = json!({
        "2":{"id":"2", "attachmentRef":digest, "sizeBytes":bytes.len()},
        "3":{"id":3, "ref":"att_image_3"}
    });
    let tui_texts = json!({
        "1":{"attachmentRef":digest, "sizeBytes":bytes.len(), "chars":bytes.len()},
        "4":{"id":4, "ref":"att_text_4"}
    });
    seed(
        "session-pending/lead.json",
        json!({"version":1, "sessions":{"lead":[
            {"id":"delivered", "content":"do not replay", "options":{"id":"delivered-submission"}, "enqueuedAt":fresh},
            {"message":"no manager id", "enqueuedAt":fresh},
            "not a manager record",
            {"id":"same-id", "message":"repeat this", "enqueuedAt":fresh+20},
            {"id":"multipart", "content":parts, "text":"read [Pasted text #1]", "enqueuedAt":fresh+40,
             "options":{"id":"multipart-submission", "pastedTexts":pasted, "displayText":"read [Pasted text #1]", "priority":"later",
                        "skipSlashCommands":true, "retryFailedTurn":true, "retryTurnId":"failed",
                        "retryAttemptId":"attempt"}}
        ]}}),
    );
    seed(
        "session-pending/tui_lead.json",
        json!({"version":1, "sessionTouchedAt":{"tui_lead":fresh}, "sessions":{"tui_lead":[
            "anonymous live",
            "repeat this",
            {"id":"old-tui", "submissionId":"already-steered", "text":"do not replay", "at":fresh+5},
            {"id":"delivered-mirror", "submissionId":"delivered-submission", "text":"do not replay", "at":fresh+5},
            {"id":"multipart-mirror", "submissionId":"multipart-submission", "text":"read [Pasted text #1]", "at":fresh+10},
            {"id":"local-id", "submissionId":"it_1", "text":"repeat this", "at":fresh+6},
            {"id":"expired", "text":"expired despite fresh bucket", "at":stale},
            {"id":"same-id", "submissionId":"stable-new", "text":"repeat this", "at":fresh+20},
            {"id":"retry", "submissionId":"retry-submission", "submittedAt":fresh+21, "at":fresh+30,
             "text":"retry [Pasted text #1]", "content":parts, "pastedTexts":tui_texts, "suppressDisplay":true,
             "pastedImages":images,
             "retryFailedTurn":true, "retryTurnId":"failed", "retryAttemptId":"attempt",
             "transcriptMeta":{"device":"terminal"}}
        ]}}),
    );
    seed(
        "session-pending/tui_other.json",
        json!({"version":1, "updatedAt":stale, "sessions":{"tui_other":[
            "expired using store timestamp",
            {"text":"fresh despite stale bucket", "at":fresh}
        ]}}),
    );
    seed(
        source::LEGACY_SPOOL,
        json!({"version":1, "sessions":{
            "lead":[
                {"id":"multipart", "message":"older copy without attachments", "enqueuedAt":fresh+3},
                {"id":"delivered", "message":"do not replay", "enqueuedAt":fresh+4},
                {"id":"first", "message":"run first", "enqueuedAt":fresh+20}
            ],
            "tui_lead":[
                {"id":"retry", "submissionId":"retry-submission", "text":"older retry copy", "at":fresh+30},
                {"id":"first-tui", "text":"legacy steering at the same time", "at":fresh+20},
                "anonymous live", "legacy before shard", "legacy before shard", "anonymous live", "repeat this"
            ]
        }}),
    );
    PendingCorpus { _dir: dir, roots, digest, parts, fresh }
}

fn migrated_pending_corpus() -> (PendingCorpus, BTreeMap<String, target::Folded>) {
    let corpus = pending_corpus();
    let complete = migrator(&corpus.roots, None).run().unwrap();
    let sessions = read_sessions(&corpus.roots, &complete.manifest_sha256).unwrap();
    (corpus, sessions)
}

#[test]
fn pending_input_resumes_once_after_publish_is_interrupted() {
    let PendingCorpus { roots, _dir, .. } = pending_corpus();
    let fault = Arc::new(|point: &str| {
        if point == "publish:session/lead:after" {
            return Err(Blocked::journal("stop after queue publish"));
        }
        Ok(())
    });
    let interrupted = migrator(&roots, Some(fault)).run().unwrap_err();
    assert!(interrupted.to_string().contains("stop after queue publish"));
    let published = durable::read(&roots.data.join("sessions/lead/log.000000")).unwrap();
    let complete = migrator(&roots, None).run().unwrap();
    assert_eq!(complete.kinds.data.quarantined_unexpected, 0);
    assert_eq!(complete.kinds.data.dangling, 0);
    assert_eq!(durable::read(&roots.data.join("sessions/lead/log.000000")).unwrap(), published);
}

#[test]
fn a_stale_steering_bucket_keeps_only_its_fresh_rows_and_a_session_mirror_holds_none() {
    let (_corpus, sessions) = migrated_pending_corpus();
    assert!(sessions["tui_lead"].queue.is_empty());
    let other = &sessions["other"].queue;
    assert_eq!(other.len(), 1);
    assert_eq!(other[0].1["message"], "fresh despite stale bucket");
}

#[test]
fn the_lead_queue_merges_both_buckets_in_order_with_unique_ids() {
    let (PendingCorpus { parts, .. }, sessions) = migrated_pending_corpus();
    let queue = &sessions["lead"].queue;
    assert_eq!(
        queue.iter().map(|(_, entry)| &entry["message"]).collect::<Vec<_>>(),
        [
            &json!("legacy before shard"),
            &json!("legacy before shard"),
            &json!("anonymous live"),
            &json!("run first"),
            &json!("legacy steering at the same time"),
            &json!("repeat this"),
            &json!("repeat this"),
            &parts,
            &parts
        ],
    );
    assert_eq!(queue.iter().map(|(id, _)| id).collect::<BTreeSet<_>>().len(), queue.len());
    assert_eq!(queue[5].0, "same-id");
}

#[test]
fn a_steering_retry_keeps_its_options_and_pasted_attachments() {
    let (PendingCorpus { digest, fresh, .. }, sessions) = migrated_pending_corpus();
    let queue = &sessions["lead"].queue;
    assert_eq!(queue[7].1["transcriptMeta"]["device"], "terminal");
    let restored = serde_json::from_value::<SubmitOptions>(queue[7].1["options"].clone()).unwrap();
    assert_eq!(restored.client_submission_id.as_deref(), Some("retry-submission"));
    assert_eq!(restored.submitted_at, Some(fresh + 21));
    assert_eq!(restored.display_text.as_deref(), Some("retry [Pasted text #1]"));
    assert_eq!(restored.kickoff, Some(true));
    let restored_image = &restored.pasted_images.as_ref().unwrap()["2"];
    assert_eq!(restored_image.attachment_ref.as_deref(), Some(digest.as_str()));
    assert_eq!(restored_image.media_type, "image/png");
    let linked = &restored.pasted_images.as_ref().unwrap()["3"];
    assert_eq!(linked.attachment_ref.as_deref(), Some("att_image_3"));
    assert_eq!(restored.pasted_texts.as_ref().unwrap()["4"].attachment_ref.as_deref(), Some("att_text_4"));
}

#[test]
fn a_manager_entry_keeps_its_submission_display_text_and_queue_controls() {
    let (_corpus, sessions) = migrated_pending_corpus();
    let queue = &sessions["lead"].queue;
    let manager = serde_json::from_value::<SubmitOptions>(queue[8].1["options"].clone()).unwrap();
    assert_eq!(manager.client_submission_id.as_deref(), Some("multipart-submission"));
    assert_eq!(manager.display_text.as_deref(), Some("read [Pasted text #1]"));
    assert_eq!(queue[8].1["priority"], "later");
    assert_eq!(queue[8].1["skipSlashCommands"], true);
}

#[test]
fn multipart_entries_keep_their_prompt_retry_options_and_pasted_text() {
    let (PendingCorpus { digest, .. }, sessions) = migrated_pending_corpus();
    let queue = &sessions["lead"].queue;
    for index in [7, 8] {
        let options = serde_json::from_value::<SubmitOptions>(queue[index].1["options"].clone()).unwrap();
        let prompt = serde_json::from_value::<PromptContent>(queue[index].1["message"].clone()).unwrap();
        assert!(matches!(prompt, PromptContent::Parts(parts) if parts.len() == 3));
        assert_eq!(options.retry_failed_turn, Some(true));
        assert_eq!(options.retry_turn_id.as_deref(), Some("failed"));
        assert_eq!(options.retry_attempt_id.as_deref(), Some("attempt"));
        let pasted = &options.pasted_texts.as_ref().unwrap()["1"];
        assert_eq!(pasted.id, 1);
        assert_eq!(pasted.attachment_ref.as_deref(), Some(digest.as_str()));
    }
}

#[test]
fn reused_local_ids_do_not_merge_distinct_submissions_in_either_bucket() {
    let dir = tempfile::tempdir().unwrap();
    let roots = MigrationRoots { data: dir.path().join("data"), home: dir.path().join("home"), profile: None };
    durable::create_dir_all(&roots.home).unwrap();
    let seed = |path: &str, value: Value| {
        write(&roots.data, path, &serde_json::to_vec(&value).unwrap());
    };
    // Keep this about identity, not the wall clock used by the TUI's expiry.
    let at = 4_102_444_800_000_i64;
    seed(
        "sessions/lead.json",
        json!({
            "id":"lead", "deliveredPendingMessageIds":["local"],
            "messages":[{"role":"user", "content":"already delivered", "meta":{"submissionIds":["sent"]}}]
        }),
    );
    seed(
        source::LEGACY_SPOOL,
        json!({"sessions":{
            "lead":[
                {"id":"local", "content":"old manager", "options":{"id":"manager-old"}, "enqueuedAt":at},
                {"id":"stale-manager-copy", "content":"discard manager copy", "options":{"id":"manager-new"}, "enqueuedAt":at}
            ],
            "tui_lead":[
                {"id":"local", "text":"old steering", "submissionId":"tui-old", "at":at},
                {"id":"stale-steering-copy", "text":"discard steering copy", "submissionId":"tui-new", "at":at}
            ]
        }}),
    );
    seed(
        "session-pending/lead.json",
        json!({"sessions":{"lead":[
            {"id":"local", "content":"manager copy without submission ID", "enqueuedAt":at},
            {"id":"local", "content":"already delivered", "options":{"id":"sent"}, "enqueuedAt":at},
            {"id":"local", "content":"keep manager", "options":{"id":"manager-new"}, "enqueuedAt":at},
            {"id":"local", "content":"keep another manager", "options":{"id":"manager-other"}, "enqueuedAt":at},
            {"id":"manager-copy", "content":"discard in-bucket manager copy", "submissionId":"manager-new", "enqueuedAt":at}
        ]}}),
    );
    seed(
        "session-pending/tui_lead.json",
        json!({"sessions":{"tui_lead":[
            {"id":"local", "text":"steering copy without submission ID", "at":at},
            {"id":"local", "text":"keep steering", "submissionId":"tui-new", "at":at},
            {"id":"local", "text":"keep another steering", "submissionId":"tui-other", "at":at},
            {"id":"steering-copy", "text":"discard in-bucket steering copy", "submissionId":"tui-new", "at":at},
            {"id":"manager-mirror", "text":"discard cross-bucket copy", "submissionId":"manager-new", "at":at}
        ]}}),
    );
    let complete = migrator(&roots, None).run().unwrap();
    let sessions = read_sessions(&roots, &complete.manifest_sha256).unwrap();
    let queue = &sessions["lead"].queue;
    assert_eq!(
        queue.iter().map(|(_, entry)| (entry["options"]["clientSubmissionId"].as_str().unwrap(), entry["message"].as_str().unwrap(),)).collect::<Vec<_>>(),
        [
            ("manager-old", "old manager"),
            ("tui-old", "old steering"),
            ("manager-new", "keep manager"),
            ("manager-other", "keep another manager"),
            ("tui-new", "keep steering"),
            ("tui-other", "keep another steering"),
        ]
    );
    assert_eq!(queue.iter().map(|(id, _)| id).collect::<BTreeSet<_>>().len(), queue.len());
}
