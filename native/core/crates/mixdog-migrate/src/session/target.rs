//! The target side of verification: reads a published `sessions/<id>/` with the frozen
//! record types, checks every frame and checkpoint, folds it (FORMAT.md §5.3), and
//! derives the observable state. It never reads an old format. (Stand-in for the
//! runtime store reader until WP-STORE lands; same frame and record rules.)

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;

use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::frame::LOG_FILE_DIGITS;
use mixdog_store::schema::frame::LOG_FILE_PREFIX;
use mixdog_store::schema::frame::ScanEnd;
use mixdog_store::schema::migration::MANIFEST_PATH;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::record::ArchiveTag;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::MigrationOrigin;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::RunPhase;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::observe::Observable;
use super::observe::RunView;
use super::observe::archive_view;
use super::observe::statuses;
use crate::durable;
use crate::framework::BlobStatuses;
use crate::framework::ItemContext;
use crate::framework::MigrationRoots;

pub struct FoldedRow {
    pub ordinal: u64,
    pub iid: String,
    pub turn: Option<String>,
    pub form: Form,
    pub model: bool,
    pub visible: bool,
    pub archive: Option<ArchiveTag>,
    pub prompt: Option<String>,
    /// Attachment references (the body blob's own digest excluded), bare hex.
    pub refs: BTreeSet<String>,
    pub body: Value,
}

/// A run: its id, its phases (with their payloads) and the ordinal of its `run` frame.
pub type FoldedRun = (String, Vec<(RunPhase, Option<Value>)>, u64);

pub struct Folded {
    pub id: String,
    pub origin: Option<MigrationOrigin>,
    pub header: Header,
    pub rows: Vec<FoldedRow>,
    /// Ordinal of the newest `compacted` frame and its replacement iids.
    pub context: Option<(u64, Vec<String>)>,
    pub runs: Vec<FoldedRun>,
    pub queue: Vec<(String, Value)>,
    pub newest_file_size: u64,
}

fn resolve<T: DeserializeOwned>(cx: &ItemContext<'_>, slot: Slot<T>) -> Result<(T, Option<String>), String> {
    match slot {
        Slot::Inline(v) => Ok((v, None)),
        Slot::Blob(blob) => {
            let d = blob.descriptor();
            let hex = d.digest.as_str().trim_start_matches("sha256:").to_string();
            let bytes = durable::read(&cx.blob_path(&hex)).map_err(|e| format!("blob {hex}: {e}"))?;
            if bytes.len() as u64 != d.bytes || durable::sha256_hex(&bytes) != hex {
                return Err(format!("blob {hex} does not hash to its reference"));
            }
            let v = serde_json::from_slice(&bytes).map_err(|e| format!("blob {hex}: {e}"))?;
            Ok((v, Some(hex)))
        }
    }
}

/// The log files `log.000000 …` of a session directory, contiguous.
fn log_files(dir: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut names = Vec::new();
    for (name, is_dir) in durable::list_dir(dir).map_err(|e| e.to_string())? {
        let Some(no) = name.strip_prefix(LOG_FILE_PREFIX) else {
            return Err(format!("{name} is not a log file"));
        };
        if is_dir || no.len() != LOG_FILE_DIGITS || !no.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("{name} is not a log file"));
        }
        names.push(name);
    }
    names.sort();
    for (i, name) in names.iter().enumerate() {
        if *name != format!("{LOG_FILE_PREFIX}{i:06}") {
            return Err(format!("log files are not contiguous at {name}"));
        }
    }
    if names.is_empty() {
        return Err("no log files".into());
    }
    Ok(names.into_iter().map(|n| dir.join(n)).collect())
}

pub fn read_session(cx: &ItemContext<'_>, dir: &Path) -> Result<Folded, String> {
    let mut folded = Folded {
        id: String::new(),
        origin: None,
        header: Header::new(),
        rows: Vec::new(),
        context: None,
        runs: Vec::new(),
        queue: Vec::new(),
        newest_file_size: 0,
    };
    let mut log_id = String::new();
    let mut ordinal = 0u64;
    for (file_no, path) in log_files(dir)?.into_iter().enumerate() {
        let bytes = durable::read(&path).map_err(|e| e.to_string())?;
        let (frames, end) = crate::frame::scan(&bytes, ordinal);
        if end != ScanEnd::Clean {
            return Err(format!("{}: {end:?}", path.display()));
        }
        folded.newest_file_size = bytes.len() as u64;
        for (i, frame) in frames.iter().enumerate() {
            ordinal = frame.ordinal + 1;
            let record: Record = serde_json::from_slice(&bytes[frame.payload.clone()])
                .map_err(|e| format!("frame {}: {e}", frame.ordinal))?;
            let first = i == 0;
            match record {
                Record::Session(s) if first && file_no == 0 && frame.ordinal == 0 => {
                    folded.id = s.id.as_str().to_string();
                    log_id = s.log_id.as_str().to_string();
                    folded.origin = s.origin.map(|o| o.migration);
                    folded.header = resolve(cx, s.header)?.0;
                }
                Record::Session(_) => return Err(format!("frame {}: a misplaced session", frame.ordinal)),
                _ if file_no == 0 && frame.ordinal == 0 => return Err("log does not open with session".into()),
                Record::Checkpoint(c) => {
                    let (state, _) = resolve(cx, c.state)?;
                    let rows = folded.rows.len() as u64;
                    let visible = folded.rows.iter().filter(|r| r.visible).count() as u64;
                    let queue: Vec<&str> = folded.queue.iter().map(|q| q.0.as_str()).collect();
                    let state_queue: Vec<&str> = state.queue.iter().map(|q| q.qid.as_str()).collect();
                    if state.covers_ordinal != frame.ordinal
                        || state.log_id != log_id
                        || state.rows != rows
                        || state.visible_rows != visible
                        || state.header != folded.header
                        || state_queue != queue
                    {
                        return Err(format!("checkpoint {} disagrees with the frames", frame.ordinal));
                    }
                }
                _ if first && file_no > 0 => {
                    return Err(format!("{} does not start with a checkpoint", path.display()));
                }
                Record::Meta(m) => {
                    let (change, _) = resolve(cx, m.change)?;
                    for k in &change.unset {
                        folded.header.shift_remove(k);
                    }
                    folded.header.extend(change.set);
                }
                Record::Item(item) => {
                    let (body, blob) = resolve(cx, item.body)?;
                    let (prompt, prompt_blob) = match item.prompt {
                        Some(slot) => {
                            let (text, blob) = resolve(cx, slot)?;
                            (Some(text), blob)
                        }
                        None => (None, None),
                    };
                    let refs = item
                        .refs
                        .as_slice()
                        .iter()
                        .map(|d| d.as_str().trim_start_matches("sha256:").to_string())
                        .filter(|h| Some(h) != blob.as_ref() && Some(h) != prompt_blob.as_ref())
                        .collect();
                    folded.rows.push(FoldedRow {
                        ordinal: frame.ordinal,
                        iid: item.iid.as_str().to_string(),
                        turn: item.turn.map(|t| t.as_str().to_string()),
                        form: item.form,
                        model: item.model,
                        visible: item.visible,
                        archive: item.archive,
                        prompt,
                        refs,
                        body,
                    });
                }
                Record::Amend(a) => {
                    let (body, _) = resolve(cx, a.body)?;
                    let row = folded
                        .rows
                        .iter_mut()
                        .rev()
                        .find(|r| r.iid == a.iid.as_str())
                        .ok_or_else(|| format!("amend of unknown row {}", a.iid.as_str()))?;
                    row.body = body;
                }
                Record::Compacted(c) => {
                    let (replacement, _) = resolve(cx, c.replacement)?;
                    folded.context = Some((frame.ordinal, replacement.into_iter().map(|r| r.iid).collect()));
                }
                Record::Run(r) => {
                    let detail = r.detail.map(|d| resolve(cx, d)).transpose()?.map(|(d, _)| d);
                    match folded.runs.iter_mut().find(|x| x.0 == r.rid.as_str()) {
                        Some(run) => run.1.push((r.phase, detail)),
                        None => folded
                            .runs
                            .push((r.rid.as_str().to_string(), vec![(r.phase, detail)], frame.ordinal)),
                    }
                }
                Record::Queue(qr) => match qr.action {
                    QueueAction::Enqueue => {
                        let entry = qr.entry.ok_or("enqueue without entry")?;
                        folded.queue.push((qr.qid.as_str().to_string(), resolve(cx, entry)?.0));
                    }
                    QueueAction::Dequeue => folded.queue.retain(|q| q.0 != qr.qid.as_str()),
                },
                // Folded back into its anchor's `meta.modelSwitches`, where 1.4.5 kept it
                // (a reader shows it there: `transcript_boundary.rs` `fold_model_switches`).
                Record::ModelSwitch(s) => {
                    let row = folded
                        .rows
                        .iter_mut()
                        .rev()
                        .find(|r| r.ordinal == s.anchor.ordinal && r.ordinal < frame.ordinal)
                        .filter(|r| r.iid == s.anchor.iid.as_str() && r.form == Form::Message)
                        .ok_or_else(|| format!("frame {}: a model switch of no earlier message row", frame.ordinal))?;
                    let entry = serde_json::to_value(resolve(cx, s.entry)?.0).expect("an entry encodes");
                    let body = row.body.as_object_mut().ok_or("a message body is an object")?;
                    let meta = body.entry("meta").or_insert_with(|| Value::Object(Default::default()));
                    let switches = meta
                        .as_object_mut()
                        .ok_or("a message meta is an object")?
                        .entry("modelSwitches")
                        .or_insert_with(|| Value::Array(Vec::new()));
                    switches.as_array_mut().ok_or("modelSwitches is a list")?.push(entry);
                }
                Record::Rewind(_) | Record::Approval(_) | Record::Op(_) => {
                    return Err(format!("frame {}: a record migration never writes", frame.ordinal));
                }
            }
        }
    }
    Ok(folded)
}

/// Every published session of a completed migration of `roots`, folded, by id.
pub fn read_sessions(roots: &MigrationRoots, manifest_sha256: &str) -> Result<BTreeMap<String, Folded>, String> {
    let manifest = durable::read(&roots.data.join(MANIFEST_PATH)).map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_slice(&manifest).map_err(|e| format!("{MANIFEST_PATH}: {e}"))?;
    let states = BTreeMap::new();
    let blobs = BlobStatuses::default();
    let cx = ItemContext {
        roots,
        manifest: &manifest,
        manifest_sha256,
        fault: None,
        blobs: &blobs,
        states: &states,
    };
    let sessions = roots.data.join("sessions");
    let mut out = BTreeMap::new();
    for (id, is_dir) in durable::list_dir(&sessions).map_err(|e| e.to_string())? {
        if is_dir {
            let folded = read_session(&cx, &sessions.join(&id))?;
            out.insert(id, folded);
        }
    }
    Ok(out)
}

impl Folded {
    pub fn observable(&self, cx: &ItemContext<'_>) -> crate::error::Result<Observable> {
        let message = |r: &&FoldedRow| r.form == Form::Message;
        let context_start = self.context.as_ref().map_or(0, |c| c.0);
        let mut model_context: Vec<String> = self.context.as_ref().map(|c| c.1.clone()).unwrap_or_default();
        model_context.extend(
            self.rows
                .iter()
                .filter(message)
                .filter(|r| r.model && r.ordinal > context_start)
                .map(|r| r.iid.clone()),
        );
        let mut refs = BTreeSet::new();
        for r in &self.rows {
            refs.extend(r.refs.iter().cloned());
        }
        Ok(Observable {
            header: self.header.clone(),
            transcript: self
                .rows
                .iter()
                .filter(message)
                .filter(|r| r.model && r.visible)
                .map(|r| (r.iid.clone(), r.body.clone()))
                .collect(),
            model_context,
            archive: archive_view(
                self.rows
                    .iter()
                    .filter_map(|r| r.archive.as_ref().map(|a| (a.seq, r.form, r.visible, &r.body))),
            ),
            runs: self
                .runs
                .iter()
                .map(|(rid, phases, started)| RunView {
                    rid: rid.clone(),
                    phases: phases.clone(),
                    input_iids: self
                        .rows
                        .iter()
                        .filter(|r| r.turn.as_deref() == Some(rid.as_str()) && r.ordinal < *started)
                        .map(|r| r.iid.clone())
                        .collect(),
                })
                .collect(),
            queue: self.queue.clone(),
            attachments: statuses(cx, refs)?,
        })
    }
}
