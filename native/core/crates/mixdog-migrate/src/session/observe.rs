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
                    ("attachmentRef", Value::String(s)) if s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {
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
    refs.into_iter().map(|r| cx.blob_status(&r).map(|s| (r, s))).collect()
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
        // The rows in the order they are written: the archive (with the requests a compaction carried over, which
        // `source::place_retained` wrote among its rows), the messages, the recovered turn's.
        let written: Vec<&Row> = model.archive.iter().chain(&model.messages).chain(&model.checkpoint_rows).collect();
        let live: Vec<&Row> = written.iter().copied().filter(|r| r.form == Form::Message && r.model).collect();
        let mut refs = BTreeSet::new();
        for row in &written {
            attachment_refs(&row.body, &mut refs);
        }
        for (_, entry) in &model.queue {
            attachment_refs(entry, &mut refs);
        }
        Ok(Self {
            header,
            transcript: live.iter().filter(|r| r.visible).map(|r| (r.iid.clone(), r.body.clone())).collect(),
            // 1.4.5's order of the messages: the context the written log restarts at when rows moved, else the rows'.
            model_context: match &model.context {
                Some(context) => context.iter().map(|(iid, _)| iid.clone()).collect(),
                None => live.iter().map(|r| r.iid.clone()).collect(),
            },
            archive: archive_view(model.archive.iter().filter_map(|r| r.archive.as_ref().map(|a| (a.seq, r.form, r.visible, &r.body)))),
            runs: model
                .runs
                .iter()
                .map(|run| RunView {
                    rid: run.rid.clone(),
                    phases: run.phases.clone(),
                    input_iids: written.iter().filter(|r| r.turn.as_deref() == Some(run.rid.as_str())).map(|r| r.iid.clone()).collect(),
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

    /// The SHA-256 of [`Self::to_value`]'s compact JSON. Key order counts: migrated bodies keep 1.4.5's bytes, so a reordered
    /// key is a change.
    pub fn digest(&self) -> String {
        use sha2::Digest as _;
        struct Hashing(sha2::Sha256);
        impl std::io::Write for Hashing {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.update(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut hashing = Hashing(sha2::Sha256::new());
        self.write_json(&mut hashing).expect("hashing never fails");
        format!("sha256:{}", crate::json::hex(&hashing.0.finalize()))
    }

    /// The bytes `serde_json::to_vec(&self.to_value())` makes, written as they go: the bodies are neither copied nor built
    /// into one value first.
    fn write_json(&self, w: &mut impl std::io::Write) -> std::io::Result<()> {
        fn list<T>(w: &mut dyn std::io::Write, items: &[T], mut each: impl FnMut(&mut dyn std::io::Write, &T) -> std::io::Result<()>) -> std::io::Result<()> {
            w.write_all(b"[")?;
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    w.write_all(b",")?;
                }
                each(w, item)?;
            }
            w.write_all(b"]")
        }
        fn json(w: &mut dyn std::io::Write, value: &(impl serde::Serialize + ?Sized)) -> std::io::Result<()> {
            serde_json::to_writer(w, value).map_err(std::io::Error::other)
        }
        let form = |f: Form| if f == Form::Display { "display" } else { "message" };
        let visible = self.archive.iter().filter(|r| r.3).count();
        write!(w, "{{\"header\":{},\"transcript\":", Value::Object(self.header.clone()))?;
        list(w, &self.transcript, |w, (iid, body)| {
            w.write_all(b"[")?;
            json(w, iid)?;
            write!(w, ",{body}]")
        })?;
        w.write_all(b",\"model_context\":")?;
        json(w, &self.model_context)?;
        w.write_all(b",\"archive\":{\"rows\":")?;
        list(w, &self.archive, |w, (seq, index, f, shown, body)| {
            write!(w, "[{seq},{index},")?;
            json(w, form(*f))?;
            write!(w, ",{shown},{body}]")
        })?;
        write!(w, ",\"visible\":{visible},\"hidden\":{}}},\"runs\":", self.archive.len() - visible)?;
        list(w, &self.runs, |w, run| {
            w.write_all(b"[")?;
            json(w, &run.rid)?;
            w.write_all(b",")?;
            list(w, &run.phases, |w, (phase, detail)| {
                w.write_all(b"[")?;
                json(w, phase)?;
                w.write_all(b",")?;
                match detail {
                    Some(detail) => write!(w, "{detail}")?,
                    None => w.write_all(b"null")?,
                }
                w.write_all(b"]")
            })?;
            w.write_all(b",")?;
            json(w, &run.input_iids)?;
            w.write_all(b"]")
        })?;
        w.write_all(b",\"queue\":")?;
        list(w, &self.queue, |w, (id, entry)| {
            w.write_all(b"[")?;
            json(w, id)?;
            write!(w, ",{entry}]")
        })?;
        w.write_all(b",\"attachments\":")?;
        json(w, &self.attachments)?;
        w.write_all(b"}")
    }
}

#[cfg(test)]
mod digest_tests {
    use super::*;

    /// The digest is that of the observable built into one value and encoded compactly, whatever it holds.
    #[test]
    fn the_digest_is_the_hash_of_the_value_encoded_whole() {
        let empty = Observable {
            header: Header::new(),
            transcript: Vec::new(),
            model_context: Vec::new(),
            archive: Vec::new(),
            runs: Vec::new(),
            queue: Vec::new(),
            attachments: BTreeMap::new(),
        };
        let body = json!({"role": "user", "z": 1, "a": [1.5, -0.0, 1e300, "\u{2028}\"\\\u{1}é😀"], "n": null, "t": true});
        let header = json!({"title": "T \"q\"", "b": {"y": 2, "x": [{}]}, "a": 3});
        let full = Observable {
            header: header.as_object().unwrap().clone(),
            transcript: vec![("i\"1".into(), body.clone()), ("i2".into(), json!("text"))],
            model_context: vec!["i\"1".into(), "i2".into()],
            archive: vec![(3, 0, Form::Display, true, body.clone()), (3, 1, Form::Message, false, json!([]))],
            runs: vec![
                RunView { rid: "r\n".into(), phases: vec![(RunPhase::Started, None), (RunPhase::Attempt, Some(body.clone()))], input_iids: vec!["i2".into()] },
                RunView { rid: "r2".into(), phases: Vec::new(), input_iids: Vec::new() },
            ],
            queue: vec![("q1".into(), body)],
            attachments: BTreeMap::from([("b".repeat(64), BlobStatus::Ok), ("a".repeat(64), BlobStatus::Dangling)]),
        };
        for observable in [empty, full] {
            let whole = serde_json::to_vec(&observable.to_value()).unwrap();
            assert_eq!(observable.digest(), format!("sha256:{}", crate::durable::sha256_hex(&whole)));
            let mut written = Vec::new();
            observable.write_json(&mut written).unwrap();
            assert_eq!(String::from_utf8(written).unwrap(), String::from_utf8(whole).unwrap());
        }
    }
}
