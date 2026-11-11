//! The core's half of Node's recording `fixtures/agent-room-cases/golden.json` cases 3, 25, 27, 45, 47 and 48
//! (`record-agent-room-cases.mjs`): what the core gives for each case's inputs (case 48: a user's files taken in by the
//! room's `SessionFiles` as the room host posts the row), the room rows it stores, the
//! group-room lines a client reads of a room log (`thread/read`) and the rows the room host reads back
//! (`DirectoryRoomDaemon::room_rows`). The whole of it is `packages/protocol-client/test/agent-room-core.json`;
//! `packages/protocol-client/test/agent-room-rows.test.ts` turns its lines into rows with the client's `rowOf`
//! and compares each case whole with the recording. One chain: recorded input → core → this file → client → recorded
//! value.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::{Method, ThreadId};
use mixdog_core_api::{CoreRequest, Reply, ThreadHandle};
use mixdog_core_rooms::rooms::config::{MemberName, room_member_named};
use mixdog_core_rooms::rooms::live::RoomDaemon;
use mixdog_core_rooms::rooms::row_message::{normalize_room_row, room_row_message};
use mixdog_core_rooms::rooms::rows::rows_since_cursor;
use mixdog_core_session::session::{SessionDirectory, StoreThreads};
use mixdog_core_session::session::testing::{RecordTranscript, Rig};
use mixdog_core_rooms::rooms::live::RoomFiles;
use mixdog_core_session::session::room_log::{RoomLog, SessionRoomLog};
use mixdog_store::blobs::BlobStore;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::record::Header;
use mixdog_testkit::exact::Exact;
use serde_json::{Value, json};

use super::room_daemon::DirectoryRoomDaemon;
use super::room_files::SessionFiles;
use super::room_files::tests::NoDocuments;

fn golden() -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-room-cases/golden.json"))
}

fn core_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/protocol-client/test/agent-room-core.json")
}

fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap_or_else(|e| panic!("recording: {e}"))
}

fn observed<'a>(golden: &'a Exact, index: usize) -> &'a Exact {
    golden.get("cases").as_array()[index].get("observed")
}

/// One room log over the real session directory on the real thread store, posted to through the room log's append and
/// read by a client; a row's files are taken in by the room's [`SessionFiles`] over the same data folder's attachment store.
pub(super) struct Log {
    pub(super) directory: Arc<SessionDirectory>,
    pub(super) daemon: Arc<DirectoryRoomDaemon>,
    pub(super) files: Arc<SessionFiles>,
    store: Arc<StoreThreads>,
    republish: Arc<dyn Fn() + Send + Sync>,
    _rig: Rig,
    _data: tempfile::TempDir,
}

impl Log {
    async fn new() -> Self {
        Self::over(Arc::new(|| {})).await
    }

    /// The same, the room log's catalog republish being `republish` (`DirectoryRoomDaemon::new`).
    pub(super) async fn over(republish: Arc<dyn Fn() + Send + Sync>) -> Self {
        use mixdog_core_api::domain::mock::MockOwnership;
        use mixdog_store::sqlite::SqliteStore;

        let data = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let root = data.path().to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let store = Arc::new(StoreThreads::over_data_dir(data.path(), index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"));
        let rig = Rig::new();
        let (directory, daemon, files) = Self::sessions(&rig, &store, data.path(), &republish);
        Self { directory, daemon, files, store, republish, _rig: rig, _data: data }
    }

    /// The session directory over `store`, the room log's daemon and the room's file intake, as the daemon composes them.
    fn sessions(
        rig: &Rig,
        store: &Arc<StoreThreads>,
        data: &std::path::Path,
        republish: &Arc<dyn Fn() + Send + Sync>,
    ) -> (Arc<SessionDirectory>, Arc<DirectoryRoomDaemon>, Arc<SessionFiles>) {
        let tokens = mixdog_rt::testing::tokens();
        let mut deps = rig.deps_parts(store.clone());
        // The transcript the daemon composes (`compose_flip.rs` `RecordTranscript::new()`).
        deps.transcript = Arc::new(RecordTranscript::new());
        let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
        let daemon = Arc::new(DirectoryRoomDaemon::new(directory.clone(), republish.clone()));
        let files = Arc::new(SessionFiles::new(directory.clone(), tokens.durability_io, data.to_path_buf(), Vec::new(), Arc::new(NoDocuments), Arc::new(|_: &str| {})));
        (directory, daemon, files)
    }

    /// A restart of the sessions: the directory shuts down (its threads close) and a new one opens them again from the same
    /// data folder.
    pub(super) async fn restart(&mut self) {
        self.directory.shutdown().await;
        (self.directory, self.daemon, self.files) = Self::sessions(&self._rig, &self.store, self._data.path(), &self.republish);
    }

    /// A fresh room log `sess_room_<room>`.
    pub(super) async fn create(&self, room: &str) -> ThreadId {
        let thread = ThreadId::from(format!("sess_room_{room}"));
        let mut header = Header::new();
        header.insert("createdAt".into(), json!(1));
        header.insert("updatedAt".into(), json!(1));
        self.directory.create_with_id(thread.clone(), header, json!({})).await.unwrap();
        thread
    }

    /// A fresh room log holding `messages` (each `roomRowMessage`), posted in one append: its lines as
    /// `thread/read` gives them, and its rows as the room host reads them back.
    async fn post(&self, room: &str, messages: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
        let thread = self.create(room).await;
        self.daemon.append_rows(thread.as_str(), messages).await.unwrap();
        self.read(&thread).await
    }

    /// `rows` posted into a fresh log as the room host posts them (`View::post`): each row's files taken in, the row in
    /// its canonical shape, its message appended. How many were added, the rows as stored and their messages.
    async fn post_rows(&self, room: &str, rows: Vec<Value>, now: i64) -> (ThreadId, usize, Vec<Value>, Vec<Value>) {
        let thread = self.create(room).await;
        let mut kept = Vec::new();
        for row in rows {
            kept.push(normalize_room_row(&self.files.take_in(room, row).await.unwrap()).unwrap());
        }
        let messages: Vec<Value> = kept.iter().map(|row| room_row_message(row, now).unwrap()).collect();
        let added = SessionRoomLog::new(self.directory.clone()).append_rows(thread.as_str(), messages.clone()).await.unwrap();
        (thread, added, kept, messages)
    }

    /// Every file of the data folder but the index databases (the room log's bytes, the attachment store): name and bytes.
    pub(super) fn data_files(&self) -> Vec<(String, Vec<u8>)> {
        mixdog_testkit::tree(self._data.path()).into_iter().filter(|(name, _)| !name.contains(".sqlite")).collect()
    }

    /// Every table of every index database of the data folder, by file name.
    pub(super) fn database_tables(&self) -> Vec<(String, Vec<(String, Vec<Vec<String>>)>)> {
        mixdog_testkit::tree(self._data.path())
            .into_iter()
            .filter(|(name, _)| name.ends_with(".sqlite"))
            .map(|(name, _)| {
                let tables = mixdog_store::state::dump_tables(&self._data.path().join(&name));
                (name, tables)
            })
            .collect()
    }

    /// The attachment store's files (their names under the store, sorted).
    #[allow(clippy::disallowed_methods, reason = "the test lists the attachment store it checks")]
    pub(super) fn stored_files(&self) -> Vec<String> {
        fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    out.push(path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
        }
        let root = self._data.path().join(mixdog_store::schema::blob::BLOB_DIR);
        let mut out = Vec::new();
        walk(&root, &root, &mut out);
        out.sort();
        out
    }

    /// The text of a stored attachment.
    pub(super) async fn stored_text(&self, reference: &str) -> String {
        let (blobs, digest) = (BlobStore::new(self._data.path()), Digest::try_from(format!("sha256:{reference}")).unwrap());
        let lane = mixdog_rt::testing::tokens().durability_io;
        let bytes = mixdog_rt::LaneToken::submit(lane, &mixdog_rt::CancellationToken::new(), move |lane| blobs.read(lane, &digest).unwrap()).unwrap().await.unwrap();
        String::from_utf8(bytes).unwrap()
    }

    /// The log's lines as `thread/read` gives them, and its rows as the room host reads them back.
    async fn read(&self, thread: &ThreadId) -> (Vec<Value>, Vec<Value>) {
        let thread = thread.clone();
        let handle = self.directory.open_handle(&thread, &CallContext::internal("test")).await.unwrap();
        let read = CoreRequest { method: Method("thread/read"), params: json!({ "threadId": thread }), op: None, ctx: CallContext::internal("test") };
        let Reply::Value(read) = handle.request(read).await.unwrap() else { panic!("thread/read answers a value") };
        // A line's item id is minted per run (the manifest's `replay.normalised.lineItemId`).
        let lines = read["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "roomRow")
            .map(|item| {
                let mut line = item.clone();
                line["id"] = json!("<item-id>");
                line
            })
            .collect();
        (lines, self.daemon.room_rows(thread.as_str()).await.unwrap())
    }
}

/// What the core gives for the five cases, keyed by case index.
async fn core_values() -> Value {
    let golden = golden();
    let now = golden.get("clock").get("dateNow").as_f64() as i64;
    let message = |row: Value| room_row_message(&row, now).unwrap();
    let log = Log::new().await;

    // Case 3 (`record-agent-room-cases.mjs:103`): the canonical row, and an older stored line whose addressees are single strings.
    let three = observed(&golden, 3);
    let normalized_row = normalize_room_row(&json!({ "id": "u", "kind": "user", "text": "x", "to": ["b", "a", "b"], "toName": ["B", "A", "B"] })).unwrap();
    let (legacy_lines, _) = log.post("case03", vec![plain(three.get("legacyInput"))]).await;

    // Case 25 (`:193`): names, a row from another session, the lines of a bot's, the Lead's and the user's own message. Its
    // exchange that serves only the member asked is the room crate's (`agent_room_replay`, `agent-room-core-exchange.json`).
    let members: Vec<MemberName> = observed(&golden, 0)
        .get("members")
        .as_array()
        .iter()
        .map(|m| MemberName { id: m.get("id").as_str().into(), name: m.get("name").as_str().into() })
        .collect();
    let named: Vec<Value> = ["bench lead", "Bench", "Ben", ""].iter().map(|text| json!({ "text": text, "id": room_member_named(text, &members).unwrap_or_default() })).collect();
    let row = normalize_room_row(&json!({ "id": "ask_1", "kind": "user", "text": "status?", "to": ["gh"], "fromSession": "sess_home_rel", "fromAgent": "rel", "fromName": "Release" })).unwrap();
    let (sender_lines, _) = log
        .post(
            "case25",
            vec![
                message(row.clone()),
                message(json!({ "id": "ask_2", "kind": "user", "text": "hi", "fromSession": "sess_lead_1" })),
                message(json!({ "id": "u1", "kind": "user", "text": "mine" })),
            ],
        )
        .await;

    // Case 27 (`:217`): what a member is handed since its cursor, and the time a stored line reads back with.
    let twenty_seven = observed(&golden, 27);
    let calls: Vec<Value> = twenty_seven
        .get("calls")
        .as_array()
        .iter()
        .map(|call| {
            let cursor = match call.get("cursor") {
                Exact::Undefined => "",
                cursor => cursor.as_str(),
            };
            let rows = plain(call.get("rows"));
            Value::Array(rows_since_cursor(rows.as_array().unwrap(), cursor, call.get("self").as_str(), call.get("handedId").as_str()))
        })
        .collect();
    let (_, at_rows) = log.post("case27", vec![message(json!({ "id": "u9", "kind": "user", "text": "hi", "at": 7 }))]).await;

    // Case 45 (`:353`): a user line and a member's speech, and the rows they read back as.
    let (restore_lines, restore_rows) = log
        .post(
            "case45",
            vec![
                message(json!({ "id": "u1", "kind": "user", "text": "hi", "to": "gh", "toName": "GH", "at": 5 })),
                message(json!({ "id": "s1", "kind": "speech", "speaker": "gh", "name": "GH", "text": "ok" })),
            ],
        )
        .await;

    // Case 47 (`:383`): a user row's stored files through the log and a restore; a peer's speech and pass with files.
    let forty_seven = observed(&golden, 47);
    let row_input = plain(forty_seven.get("rowInput"));
    let files = json!({
        "parts": row_input["parts"], "attachments": row_input["attachments"], "images": row_input["images"],
    });
    let mut speech = json!({ "id": "s1", "kind": "speech", "speaker": "gh", "text": "x" });
    let mut pass = json!({ "id": "p1", "kind": "pass", "speaker": "gh", "text": "" });
    for key in ["parts", "attachments", "images"] {
        speech[key] = files[key].clone();
    }
    for key in ["parts", "attachments"] {
        pass[key] = files[key].clone();
    }
    let speech_row = normalize_room_row(&speech).unwrap();
    let (file_lines, file_rows) = log.post("case47", vec![message(row_input.clone())]).await;
    let (speech_lines, _) = log.post("case47speech", vec![message(speech_row.clone())]).await;

    // Case 48 (`:400`): a user row's upload taken in by the log's intake, into `sess_room_abc123`.
    let input = plain(observed(&golden, 48).get("input"));
    let (thread, added, rows, messages) = log.post_rows("abc123", input.as_array().unwrap().clone(), now).await;
    let (upload_lines, _) = log.read(&thread).await;
    let part_ref = |kind: &str| rows[0]["parts"].as_array().unwrap().iter().find(|part| part["type"] == kind).unwrap()["attachmentRef"].as_str().unwrap().to_owned();
    let stored_bytes = json!({
        "image": log.stored_text(&part_ref("image")).await,
        "file": log.stored_text(&part_ref("file")).await,
        "text": log.stored_text(&part_ref("text")).await,
    });

    // `normalizedRow` (written to agent-room-core.json) is the name of Node's observed value in case 3, the row as the log
    // stores it; nothing of it is normalised.
    json!({
        "3": { "normalizedRow": normalized_row, "legacyLines": legacy_lines },
        "25": { "named": named, "row": row, "lines": sender_lines },
        "27": { "calls": calls, "readBack": at_rows },
        "45": { "lines": restore_lines, "readBack": restore_rows },
        "47": {
            "message": message(row_input),
            "lines": file_lines,
            "readBack": file_rows,
            "speechRow": speech_row,
            "speechMessage": message(speech_row.clone()),
            "speechLines": speech_lines,
            "passRow": normalize_room_row(&pass).unwrap(),
        },
        "48": { "added": added, "rows": rows, "storedBytes": stored_bytes, "sessionMessages": messages, "lines": upload_lines },
    })
}

/// The file the client test reads holds what the core gives now (`mixdog_testkit::chain_output`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_core_gives_the_client_the_room_lines_the_recording_was_made_from() {
    let set = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-room-cases");
    mixdog_testkit::chain_output(&core_file(), &set, core_values().await, "the core's room lines");
}
