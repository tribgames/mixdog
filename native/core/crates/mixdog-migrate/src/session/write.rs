//! Frames of a migrated session (SM §11.4.1 order): `session`, archive rows, transcript
//! rows, recovered checkpoint rows and runs, queue entries, header `meta`s, and a final
//! `checkpoint`; rotated at `ROTATE_AT` with a `checkpoint` first in each later file. A
//! message row's `meta.modelSwitches` entries follow it as `model_switch` records.
//! Byte-identical on every run (SM §11.3.4).

use mixdog_protocol::INLINE_MAX;
use mixdog_protocol::MAX_BLOB_BYTES;
use mixdog_store::encode::EncodeError;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::bounded::List;
use mixdog_store::schema::bounded::Name;
use mixdog_store::schema::bounded::Text;
use mixdog_store::schema::checkpoint::CheckpointState;
use mixdog_store::schema::checkpoint::FramePos;
use mixdog_store::schema::checkpoint::OpenRun;
use mixdog_store::schema::checkpoint::QueuedEntry;
use mixdog_store::schema::frame::FRAME_OVERHEAD;
use mixdog_store::schema::frame::MAX_FRAME_PAYLOAD;
use mixdog_store::schema::frame::ROTATE_AT;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::record::Anchor;
use mixdog_store::schema::record::CheckpointRecord;
use mixdog_store::schema::record::CompactedRecord;
use mixdog_store::schema::record::ReplacementEntry;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::MetaRecord;
use mixdog_store::schema::record::MigrationOrigin;
use mixdog_store::schema::record::ModelSwitchEntry;
use mixdog_store::schema::record::ModelSwitchRecord;
use mixdog_store::schema::record::Origin;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::QueueRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::RunPhase;
use mixdog_store::schema::record::RunRecord;
use mixdog_store::schema::record::SESSION_RECORD_VERSION;
use mixdog_store::schema::record::SessionRecord;
use serde::Serialize;
use serde_json::Value;

use super::model::Row;
use super::model::SessionModel;
use super::observe::attachment_refs;
use super::source::Fail;
use super::source::R;
use crate::durable;
use crate::framework::ItemContext;

fn violation<T>(detail: impl Into<String>) -> R<T> {
    Err(Fail::Quarantine(QuarantineCode::SchemaViolation, detail.into()))
}

fn bounded<const N: usize>(text: &str, what: &str) -> R<Text<N>> {
    Text::try_from(text).or_else(|e| violation(format!("{what}: {e}")))
}

/// `hex(sha256(manifest_sha256 ‖ session id))[0..24]`.
pub fn log_id(manifest_sha256: &str, id: &str) -> String {
    durable::sha256_hex(format!("{manifest_sha256}{id}").as_bytes())[..24].to_string()
}

/// A body slot: inline up to `INLINE_MAX` encoded bytes, else a published blob.
fn slot<T: Serialize>(cx: &ItemContext<'_>, value: T) -> R<(Slot<T>, Option<String>)> {
    slot_within(cx, value, INLINE_MAX).map(|(slot, hex, _)| (slot, hex))
}

/// The store's slot rule with `budget` inline bytes (FORMAT.md §4.2), its blob published:
/// the slot, the blob's hex, and the inline bytes taken (0 for a blob).
fn slot_within<T: Serialize>(cx: &ItemContext<'_>, value: T, budget: usize) -> R<(Slot<T>, Option<String>, usize)> {
    match mixdog_store::encode::slot_within(value, budget) {
        Ok((slot, None, used)) => Ok((slot, None, used)),
        Ok((slot, Some(blob), used)) => Ok((slot, Some(cx.put_blob(&blob.bytes)?), used)),
        Err(EncodeError::ItemTooLarge { bytes }) => Err(Fail::Quarantine(
            QuarantineCode::ItemTooLarge,
            format!("a body of {bytes} bytes exceeds {MAX_BLOB_BYTES}"),
        )),
        Err(e) => panic!("a slot value encodes: {e}"),
    }
}

/// A message row's `meta.modelSwitches` entries (1.4.5 `recordModelSwitchBoundary`) as
/// `model_switch` entries, in order, and its body without them (FORMAT.md §5.2: the store
/// appends the boundary instead of rewriting the row). None when there are none, or when any
/// entry is not exactly a record's entry or repeats an earlier one's time and model (a reader
/// shows such a repeat once), or when another `meta` key follows `modelSwitches` (a reader
/// appends the folded list last; 1.4.5 kept its first position when a later boundary list
/// such as `workflowSwitches` joined): the row then keeps them as 1.4.5 wrote them.
fn model_switches(row: &Row) -> Option<(Value, Vec<ModelSwitchEntry>)> {
    if row.form != Form::Message {
        return None;
    }
    let meta = row.body.get("meta")?.as_object()?;
    if meta.keys().next_back().map(String::as_str) != Some("modelSwitches") {
        return None;
    }
    let switches = meta["modelSwitches"].as_array()?;
    if switches.is_empty() {
        return None;
    }
    let mut entries: Vec<ModelSwitchEntry> = Vec::new();
    for value in switches {
        let entry: ModelSwitchEntry = serde_json::from_value(value.clone()).ok()?;
        let same = |e: &ModelSwitchEntry| e.at == entry.at && e.model_id == entry.model_id;
        if serde_json::to_value(&entry).ok()? != *value || entries.iter().any(same) {
            return None;
        }
        entries.push(entry);
    }
    let mut body = row.body.clone();
    body["meta"].as_object_mut()?.shift_remove("modelSwitches");
    Some((body, entries))
}

struct Builder<'a> {
    cx: &'a ItemContext<'a>,
    files: Vec<Vec<u8>>,
    ordinal: u64,
    log_id: String,
    header: Header,
    rows: u64,
    visible_rows: u64,
    /// The `compacted` record the model context restarts at, once written.
    context: Option<FramePos>,
    runs: Vec<OpenRun>,
    queue: Vec<QueuedEntry>,
}

impl Builder<'_> {
    fn checkpoint_payload(&self) -> R<Vec<u8>> {
        let state = CheckpointState {
            log_id: self.log_id.clone(),
            covers_ordinal: self.ordinal,
            history_rev: 0,
            rows: self.rows,
            visible_rows: self.visible_rows,
            base: None,
            base_cut: None,
            control: false,
            context: self.context,
            runs: self.runs.clone(),
            approvals: Vec::new(),
            queue: self.queue.clone(),
            header: self.header.clone(),
        };
        let (state, _) = slot(self.cx, state)?;
        Ok(serde_json::to_vec(&Record::Checkpoint(CheckpointRecord { state })).expect("records encode"))
    }

    fn append(&mut self, payload: &[u8]) -> FramePos {
        let file_no = (self.files.len() - 1) as u32;
        let file = self.files.last_mut().expect("a file");
        let pos = FramePos {
            ordinal: self.ordinal,
            file_no,
            offset: file.len() as u64,
        };
        crate::frame::encode_into(file, self.ordinal, payload);
        self.ordinal += 1;
        pos
    }

    fn push(&mut self, record: &Record) -> R<FramePos> {
        let payload = serde_json::to_vec(record).expect("records encode");
        if payload.len() > MAX_FRAME_PAYLOAD {
            return violation(format!("a record of {} bytes exceeds a frame", payload.len()));
        }
        let current = self.files.last().map_or(0, Vec::len) as u64;
        if current > 0 && current + (FRAME_OVERHEAD + payload.len()) as u64 > ROTATE_AT {
            let checkpoint = self.checkpoint_payload()?;
            self.files.push(Vec::new());
            self.append(&checkpoint);
        }
        Ok(self.append(&payload))
    }

    /// The row, then one `model_switch` per entry it carried, anchored on the row.
    fn row(&mut self, row: &Row) -> R<()> {
        let Some((body, entries)) = model_switches(row) else {
            return self.item(row, row.body.clone()).map(drop);
        };
        let anchor = self.item(row, body)?;
        for entry in entries {
            self.push(&Record::ModelSwitch(ModelSwitchRecord {
                anchor: Anchor {
                    iid: bounded(&row.iid, "iid")?,
                    ordinal: anchor.ordinal,
                },
                op: None,
                entry: slot(self.cx, entry)?.0,
            }))?;
        }
        Ok(())
    }

    fn item(&mut self, row: &Row, body: Value) -> R<FramePos> {
        let (body, blob, used) = slot_within(self.cx, body, INLINE_MAX)?;
        let (prompt, prompt_blob) = match row.prompt.clone() {
            Some(text) => {
                let (slot, hex, _) = slot_within(self.cx, text, INLINE_MAX - used)?;
                (Some(slot), hex)
            }
            None => (None, None),
        };
        let mut refs = std::collections::BTreeSet::new();
        attachment_refs(&row.body, &mut refs);
        refs.extend(blob);
        refs.extend(prompt_blob);
        let refs: Vec<Digest> = refs
            .into_iter()
            .map(|h| Digest::try_from(format!("sha256:{h}")).expect("hex digest"))
            .collect();
        let record = Record::Item(ItemRecord {
            iid: bounded(&row.iid, "iid")?,
            turn: row.turn.as_deref().map(|t| bounded(t, "turn")).transpose()?,
            // The role is an index aid; the body keeps it whatever its length.
            role: row.role.as_deref().and_then(|r| Name::try_from(r).ok()),
            form: row.form,
            model: row.model,
            visible: row.visible,
            archive: row.archive.clone(),
            op: None,
            prompt,
            refs: List::try_from(refs).or_else(|e| violation(format!("refs: {e}")))?,
            body,
        });
        let pos = self.push(&record)?;
        self.rows += 1;
        self.visible_rows += u64::from(row.visible);
        Ok(pos)
    }
}

/// The staged log files of `model`.
pub fn frames(
    cx: &ItemContext<'_>,
    model: &SessionModel,
    item_key: &str,
    source_digest: &str,
) -> R<Vec<Vec<u8>>> {
    let log_id = log_id(cx.manifest_sha256, &model.id);
    let mut b = Builder {
        cx,
        files: vec![Vec::new()],
        ordinal: 0,
        log_id: log_id.clone(),
        header: model.header.clone(),
        rows: 0,
        visible_rows: 0,
        context: None,
        runs: Vec::new(),
        queue: Vec::new(),
    };
    let (header, _) = slot(cx, model.header.clone())?;
    b.push(&Record::Session(SessionRecord {
        v: SESSION_RECORD_VERSION,
        id: bounded(&model.id, "session id")?,
        log_id: bounded(&log_id, "log id")?,
        base: None,
        origin: Some(Origin {
            migration: MigrationOrigin {
                manifest_sha256: bounded(cx.manifest_sha256, "manifest digest")?,
                item_key: bounded(item_key, "item key")?,
                source_digest: Digest::try_from(source_digest.to_string())
                    .or_else(|e| violation(format!("source digest: {e}")))?,
            },
        }),
        op: None,
        control: false,
        header,
    }))?;
    for row in model.archive.iter().chain(&model.messages).chain(&model.checkpoint_rows) {
        b.row(row)?;
    }
    // Rows written out of 1.4.5's message order (`source::place_retained`): the context restarts at the messages in
    // that order, after every row, so none is in it twice. Silent: no divider is listed for it, and it takes nothing
    // out of the transcript.
    if let Some(context) = &model.context {
        let entries: Vec<ReplacementEntry> = context.iter().map(|(iid, body)| ReplacementEntry { iid: iid.clone(), body: body.clone() }).collect();
        let (replacement, _) = slot(cx, entries)?;
        let pos = b.push(&Record::Compacted(CompactedRecord {
            cid: bounded("migrated-context", "compaction id")?,
            summary_iid: None,
            op: None,
            at: None,
            dropped_count: Some(0),
            dropped: None,
            silent: Some(true),
            replacement,
        }))?;
        b.context = Some(pos);
    }
    for run in &model.runs {
        for (phase, detail) in &run.phases {
            let detail = detail.clone().map(|d| slot(cx, d)).transpose()?.map(|(s, _)| s);
            let pos = b.push(&Record::Run(RunRecord {
                rid: bounded(&run.rid, "run id")?,
                phase: *phase,
                attribution: None,
                attempt: None,
                at: run.at,
                op: None,
                detail,
            }))?;
            match phase {
                RunPhase::Started => b.runs.push(OpenRun {
                    rid: run.rid.clone(),
                    started: pos,
                }),
                _ => b.runs.retain(|r| r.rid != run.rid),
            }
        }
    }
    for (qid, entry) in &model.queue {
        let (entry, _) = slot(cx, entry.clone())?;
        let pos = b.push(&Record::Queue(QueueRecord {
            qid: bounded::<{ mixdog_store::schema::bounded::ID_MAX }>(qid, "queue id")?,
            action: QueueAction::Enqueue,
            reason: None,
            op: None,
            entry: Some(entry),
        }))?;
        b.queue.push(QueuedEntry {
            qid: qid.clone(),
            enqueued: pos,
            updated: None,
        });
    }
    for set in &model.metas {
        let (change, _) = slot(
            cx,
            HeaderChange {
                set: set.clone(),
                unset: Vec::new(),
            },
        )?;
        b.push(&Record::Meta(MetaRecord { op: None, change }))?;
        for (k, v) in set {
            b.header.insert(k.clone(), v.clone());
        }
    }
    let checkpoint = b.checkpoint_payload()?;
    let current = b.files.last().map_or(0, Vec::len) as u64;
    if current + (FRAME_OVERHEAD + checkpoint.len()) as u64 > ROTATE_AT {
        b.files.push(Vec::new());
    }
    b.append(&checkpoint);
    Ok(b.files)
}
