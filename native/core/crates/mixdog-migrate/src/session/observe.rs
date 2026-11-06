//! `ObservableState` (SM §11.6, FORMAT.md §10.6): what a user can observe of a session,
//! computed on the source side from the old-format model and on the target side from
//! the store fold, then compared by digest.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::RunPhase;
use serde_json::Value;
use serde_json::json;

use super::model::Row;
use super::model::SessionModel;
use crate::error::Result;
use crate::framework::BlobStatus;
use crate::framework::ItemContext;

#[derive(Debug, Clone, PartialEq)]
pub struct RunView {
    pub rid: String,
    pub phases: Vec<(RunPhase, Option<Value>)>,
    pub input_iids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Observable {
    pub header: Header,
    /// Visible model message rows: `(iid, body)`.
    pub transcript: Vec<(String, Value)>,
    pub model_context: Vec<String>,
    /// `(seq, index in its segment or job, form, visible, body)`.
    pub archive: Vec<(u64, u64, Form, bool, Value)>,
    pub runs: Vec<RunView>,
    pub queue: Vec<(String, Value)>,
    pub attachments: BTreeMap<String, BlobStatus>,
}

/// Bare SHA-256 hex of every `attachmentRef` inside a body (content parts at any depth).
pub fn attachment_refs(body: &Value, out: &mut BTreeSet<String>) {
    match body {
        Value::Object(map) => {
            for (k, v) in map {
                match (k.as_str(), v) {
                    ("attachmentRef", Value::String(s))
                        if s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
                    {
                        out.insert(s.clone());
                    }
                    _ => attachment_refs(v, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| attachment_refs(v, out)),
        _ => {}
    }
}

/// Positions of archive rows within their segment or job, in emission order.
pub fn archive_view<'a>(rows: impl Iterator<Item = (u64, Form, bool, &'a Value)>) -> Vec<(u64, u64, Form, bool, Value)> {
    let mut next: BTreeMap<(u64, bool), u64> = BTreeMap::new();
    rows.map(|(seq, form, visible, body)| {
        let slot = next.entry((seq, form == Form::Display)).or_insert(0);
        let index = *slot;
        *slot += 1;
        (seq, index, form, visible, body.clone())
    })
    .collect()
}

pub fn statuses(cx: &ItemContext<'_>, refs: BTreeSet<String>) -> Result<BTreeMap<String, BlobStatus>> {
    refs.into_iter()
        .map(|r| cx.blob_status(&r).map(|s| (r, s)))
        .collect()
}

impl Observable {
    /// The source side: from the old-format model.
    pub fn of_source(cx: &ItemContext<'_>, model: &SessionModel) -> Result<Self> {
        let mut header = model.header.clone();
        for set in &model.metas {
            for (k, v) in set {
                header.insert(k.clone(), v.clone());
            }
        }
        let live: Vec<&Row> = model.messages.iter().chain(&model.checkpoint_rows).collect();
        let mut refs = BTreeSet::new();
        for row in model.archive.iter().chain(live.iter().copied()) {
            attachment_refs(&row.body, &mut refs);
        }
        Ok(Self {
            header,
            transcript: live
                .iter()
                .filter(|r| r.visible)
                .map(|r| (r.iid.clone(), r.body.clone()))
                .collect(),
            model_context: live.iter().map(|r| r.iid.clone()).collect(),
            archive: archive_view(model.archive.iter().map(|r| {
                (r.archive.as_ref().map_or(0, |a| a.seq), r.form, r.visible, &r.body)
            })),
            runs: model
                .runs
                .iter()
                .map(|run| RunView {
                    rid: run.rid.clone(),
                    phases: run.phases.clone(),
                    input_iids: model
                        .checkpoint_rows
                        .iter()
                        .filter(|r| r.turn.as_deref() == Some(run.rid.as_str()))
                        .map(|r| r.iid.clone())
                        .collect(),
                })
                .collect(),
            queue: model.queue.clone(),
            attachments: statuses(cx, refs)?,
        })
    }

    pub fn to_value(&self) -> Value {
        let form = |f: Form| if f == Form::Display { "display" } else { "message" };
        let visible = self.archive.iter().filter(|r| r.3).count();
        json!({
            "header": Value::Object(self.header.clone()),
            "transcript": self.transcript.iter().map(|(i, b)| json!([i, b])).collect::<Vec<_>>(),
            "model_context": self.model_context,
            "archive": {
                "rows": self.archive.iter().map(|(s, i, f, v, b)| json!([s, i, form(*f), v, b])).collect::<Vec<_>>(),
                "visible": visible,
                "hidden": self.archive.len() - visible,
            },
            "runs": self.runs.iter().map(|r| json!([
                r.rid,
                r.phases.iter().map(|(p, d)| json!([p, d])).collect::<Vec<_>>(),
                r.input_iids,
            ])).collect::<Vec<_>>(),
            "queue": self.queue.iter().map(|(q, e)| json!([q, e])).collect::<Vec<_>>(),
            "attachments": self.attachments,
        })
    }

    /// Key order counts: migrated bodies keep 1.4.5's bytes, so a reordered key is a change.
    pub fn digest(&self) -> String {
        let bytes = serde_json::to_vec(&self.to_value()).expect("a Value always encodes");
        format!("sha256:{}", crate::durable::sha256_hex(&bytes))
    }
}
