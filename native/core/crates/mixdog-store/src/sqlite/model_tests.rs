//! Randomized model test of the catalog's message state. Operation sequences (append,
//! amend, rewind, fork at any position, compaction, header change, a base projected late,
//! a restart at any step) run against the real writer with tiny step budgets; after every
//! settle the catalog rows must equal an oracle that recomputes each session naively from
//! its log, with no incremental state. Seeds that ever failed stay in `REGRESSIONS`.
#![allow(clippy::disallowed_types, reason = "test-only model over the sqlite projection")]

use std::path::PathBuf;

use serde_json::json;

use super::*;
use crate::message_state::INCOMING_TAIL_MAX;
use crate::message_state::MessageRow;
use crate::message_state::StatsRows;

const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

/// Seeds that once failed: each is a fixed regression case.
const REGRESSIONS: &[u64] = &[2, 3, 26, 80, 296];

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

#[derive(Clone)]
enum F {
    Session(Option<(usize, i64)>),
    Item(String, MessageRow),
    Amend(String, MessageRow),
    Rewind(i64),
    Compact(String, Vec<(String, MessageRow)>),
    Title(String),
}

struct Sess {
    id: String,
    start: i64,
    frames: Vec<F>,
    submitted: usize,
}

/// A frame that is live in a session's context, and the session whose log holds it (an
/// amend reaches only the messages of its own session).
#[derive(Clone)]
struct Live {
    ordinal: i64,
    f: F,
    owner: usize,
}

/// The frames live in session `i` after its frames below `upto`: a fork starts with the
/// frames its base had live below the fork point; a rewind drops the frames from `to` on.
fn live(model: &[Sess], i: usize, upto: i64) -> Vec<Live> {
    let s = &model[i];
    let mut lf: Vec<Live> = Vec::new();
    for (k, f) in s.frames.iter().enumerate() {
        let ordinal = s.start + k as i64;
        if ordinal >= upto {
            break;
        }
        match f {
            F::Session(Some((b, end))) => {
                lf = live(model, *b, *end);
            }
            F::Session(None) | F::Title(_) => {}
            F::Rewind(to) => lf.retain(|x| x.ordinal < *to),
            other => lf.push(Live { ordinal, f: other.clone(), owner: i }),
        }
    }
    lf
}

struct Entry {
    ordinal: i64,
    idx: usize,
    iid: String,
    row: MessageRow,
    owner: usize,
}

/// The catalog stats of the live frames, by replaying them.
fn stats_of(lf: &[Live], session: &str) -> crate::summary::MessageStats {
    let mut entries: Vec<Entry> = Vec::new();
    let mut epoch = 0;
    for x in lf {
        match &x.f {
            F::Item(iid, row) => {
                entries.push(Entry { ordinal: x.ordinal, idx: 0, iid: iid.clone(), row: row.clone(), owner: x.owner })
            }
            F::Compact(_, rows) => {
                epoch = entries.len();
                for (idx, (iid, row)) in rows.iter().enumerate() {
                    entries.push(Entry { ordinal: x.ordinal, idx, iid: iid.clone(), row: row.clone(), owner: x.owner });
                }
            }
            F::Amend(iid, new) => {
                if let Some(e) =
                    entries.iter_mut().filter(|e| e.iid == *iid && e.owner == x.owner).max_by_key(|e| (e.ordinal, e.idx))
                {
                    let counted = e.row.counted;
                    e.row = MessageRow { counted, incoming: new.incoming && counted, ..new.clone() };
                }
            }
            _ => {}
        }
    }
    let (mut count, mut real) = (0u64, 0u64);
    let (mut preview, mut last) = (String::new(), None);
    let mut incoming: Vec<u64> = Vec::new();
    for e in &entries[epoch..] {
        count += u64::from(e.row.counted);
        real += u64::from(e.row.real);
        if preview.is_empty() && !e.row.preview.is_empty() {
            preview.clone_from(&e.row.preview);
        }
        if !e.row.line.is_empty() {
            last = Some((e.row.line.clone(), e.row.routine.clone()));
        }
        if e.row.incoming {
            incoming.push(count);
        }
    }
    let skip = incoming.len().saturating_sub(INCOMING_TAIL_MAX);
    incoming.drain(..skip);
    StatsRows { count, real, incoming, preview, last }.into_stats(session)
}

struct World {
    _dir: tempfile::TempDir,
    path: PathBuf,
    w: Writer,
    model: Vec<Sess>,
    rng: Rng,
    counter: u64,
    append_rows: usize,
    step_rows: usize,
}

impl World {
    fn new(seed: u64) -> World {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("i.sqlite");
        let (append_rows, step_rows) =
            if seed.is_multiple_of(7) { (APPEND_ROWS, STEP_ROWS) } else { (1 + (seed % 3) as usize, 1 + ((seed / 3) % 3) as usize) };
        let mut w = Writer::start(&path).expect("writer");
        w.conn.pragma_update(None, "synchronous", "OFF").expect("pragma");
        w.append_rows = append_rows;
        w.step_rows = step_rows;
        World { _dir: dir, path, w, model: Vec::new(), rng: Rng::new(seed), counter: 0, append_rows, step_rows }
    }

    fn message(&mut self) -> MessageRow {
        self.counter += 1;
        let n = self.counter;
        let text = if self.rng.below(8) == 0 { String::new() } else { format!("text {n}") };
        let v = match self.rng.below(5) {
            0 | 1 => json!({"role": "user", "content": text}),
            2 | 3 => json!({"role": "assistant", "content": text}),
            _ => json!({"role": "tool", "content": text}),
        };
        MessageRow::of(&v)
    }

    fn head(&self, i: usize, upto: usize) -> CatalogHead {
        let s = &self.model[i];
        let title = s.frames[..upto]
            .iter()
            .rev()
            .find_map(|f| if let F::Title(t) = f { Some(t.clone()) } else { None })
            .unwrap_or_else(|| "t0".into());
        let mut header = serde_json::Map::new();
        header.insert("title".into(), json!(title));
        header.insert("updatedAt".into(), json!(1000.0));
        header.insert("createdAt".into(), json!(500.0));
        let base_session = match &s.frames[0] {
            F::Session(Some((b, _))) => Some(self.model[*b].id.clone()),
            _ => None,
        };
        CatalogHead { session: s.id.clone(), log_id: LOG_ID.into(), base_session, header }
    }

    fn create(&mut self, base: Option<(usize, i64)>) {
        let i = self.model.len();
        let id = if i.is_multiple_of(2) { format!("sess_room_ab{i:04}") } else { format!("sess_plain_{i}") };
        self.model.push(Sess { id, start: base.map_or(0, |b| b.1), frames: vec![F::Session(base)], submitted: 0 });
        let head = self.head(i, 1);
        let id = self.model[i].id.clone();
        self.w.take(Command::Upsert { head: Box::new(head), dirty: DirtyMark::Set, ack: None });
        // The row exists before the session's first projection (creation acks its upsert).
        for _ in 0..100_000 {
            if !self.w.upserts.contains_key(&id) {
                return;
            }
            self.w.append_transaction();
        }
        panic!("the creation upsert is not written");
    }

    fn next_ordinal(&self, i: usize) -> i64 {
        self.model[i].start + self.model[i].frames.len() as i64
    }

    fn frame(&self, i: usize, k: usize) -> ProjectedFrame {
        let s = &self.model[i];
        let ordinal = (s.start + k as i64) as u64;
        let kind = match &s.frames[k] {
            F::Session(b) => FrameKind::Session {
                base: b.map(|(b, end)| {
                    serde_json::from_value(
                        json!({"session": self.model[b].id, "log_id": LOG_ID, "end_ordinal_exclusive": end}),
                    )
                    .expect("base")
                }),
            },
            F::Item(iid, row) => FrameKind::Item {
                iid: iid.clone(),
                turn: None,
                form: crate::schema::record::Form::Message,
                model: true,
                visible: true,
                refs: Vec::new(),
                prompt: None,
                msg: Some(row.clone()),
                facets: None,
            },
            F::Amend(iid, row) => FrameKind::Amend { iid: iid.clone(), refs: Vec::new(), msg: Some(row.clone()) },
            F::Rewind(to) => FrameKind::Rewind { to_ordinal: *to as u64 },
            F::Compact(cid, rows) => FrameKind::Compacted {
                cid: cid.clone(),
                at: None,
                rows: rows.clone(),
                mode: crate::compaction_view::DropMode::All,
                dropped: None,
                silent: false,
            },
            F::Title(_) => FrameKind::Other,
        };
        ProjectedFrame {
            pos: FramePos { ordinal, file_no: 0, offset: ordinal * 10 },
            frame_len: 10,
            kind,
            op: None,
            history_rev: k as u64,
            rows: k as u64,
            visible_rows: k as u64,
        }
    }

    fn submit(&mut self, i: usize, upto: usize) {
        if upto <= self.model[i].submitted {
            return;
        }
        let frames: Vec<ProjectedFrame> = (self.model[i].submitted..upto).map(|k| self.frame(i, k)).collect();
        let head = self.head(i, upto);
        let session = self.model[i].id.clone();
        self.w.take(Command::Project { projection: Projection { session, frames, head, pins: Vec::new() }, ack: None });
        self.model[i].submitted = upto;
    }

    fn cycle(&mut self) {
        self.w.append_transaction();
        if self.w.views {
            self.w.view_step();
        }
    }

    /// Runs the writer until nothing is queued and no view can advance.
    fn settle(&mut self) {
        for _ in 0..200_000 {
            self.w.append_transaction();
            self.w.views = true;
            self.w.view_step();
            if self.w.projections.is_empty() && self.w.upserts.is_empty() && !self.w.views {
                return;
            }
        }
        panic!("the writer does not settle");
    }

    /// A restart: the queues and the heads waiting for a view are lost; what the index
    /// holds is the cursor each session resumes from, and the rows are re-derived.
    fn crash(&mut self) {
        let mut w = Writer::start(&self.path).expect("reopen");
        w.conn.pragma_update(None, "synchronous", "OFF").expect("pragma");
        w.append_rows = self.append_rows;
        w.step_rows = self.step_rows;
        self.w = w;
        for i in 0..self.model.len() {
            let projected: i64 = self
                .w
                .conn
                .query_row("SELECT projected_ordinal FROM sessions WHERE id = ?1", [&self.model[i].id], |r| r.get(0))
                .expect("row");
            self.model[i].submitted = if projected == 0 { 0 } else { (projected - self.model[i].start) as usize };
            // A rewind cut off mid-way left partial effects behind; the open-time
            // reconcile re-projects from the cursor, which completes it.
            let next = self.model[i].submitted;
            if matches!(self.model[i].frames.get(next), Some(F::Rewind(_))) {
                self.submit(i, next + 1);
            }
        }
        self.reconcile();
    }

    fn reconcile(&mut self) {
        for i in 0..self.model.len() {
            let head = self.head(i, self.model[i].submitted.max(1));
            self.w.take(Command::Upsert { head: Box::new(head), dirty: DirtyMark::Keep, ack: None });
        }
    }

    fn compare(&mut self, strict: bool) {
        for i in 0..self.model.len() {
            let s = &self.model[i];
            let view: Option<(String, i64, String)> = self
                .w
                .conn
                .query_row(
                    "SELECT state, position, base FROM message_views WHERE session = ?1
                     ORDER BY valid_from DESC LIMIT 1",
                    [&s.id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .expect("view");
            if let Some((state, position, base)) = view
                && state == "pending"
            {
                assert!(!strict, "{}: a view is still pending at the end", s.id);
                let (projected, base_pending): (i64, bool) = self
                    .w
                    .conn
                    .query_row(
                        "SELECT projected_ordinal, EXISTS (SELECT 1 FROM message_views w WHERE w.session = ?1
                           AND w.state = 'pending') FROM sessions WHERE id = ?1",
                        [&base],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .expect("base row");
                assert!(projected < position || base_pending, "{}: pending although its base is ready", s.id);
                continue;
            }
            let lf = live(&self.model, i, s.start + s.submitted as i64);
            let head = self.head(i, s.submitted.max(1));
            let want = crate::summary::catalog_row(&head, &stats_of(&lf, &s.id), 0.0).summary;
            let got: String =
                self.w.conn.query_row("SELECT summary FROM sessions WHERE id = ?1", [&s.id], |r| r.get(0)).expect("row");
            let (want, got): (serde_json::Value, serde_json::Value) =
                (serde_json::from_str(&want).expect("json"), serde_json::from_str(&got).expect("json"));
            if got != want {
                let (g, w) = (got.as_object().expect("object"), want.as_object().expect("object"));
                let keys: Vec<String> = w
                    .keys()
                    .chain(g.keys())
                    .filter(|k| g.get(*k) != w.get(*k))
                    .map(|k| format!("{k}: got {:?} want {:?}", g.get(k), w.get(k)))
                    .collect();
                panic!("{}: catalog row differs after {} submitted frames: {keys:?}", s.id, s.submitted);
            }
        }
    }

    fn op(&mut self) {
        if self.model.is_empty() {
            return self.create(None);
        }
        let i = self.rng.below(self.model.len());
        match self.rng.below(100) {
            0..=7 if self.model.len() < 6 => self.create(None),
            8..=17 if self.model.len() < 6 => {
                let len = self.model[i].frames.len();
                let end = self.model[i].start + 1 + self.rng.below(len) as i64;
                self.create(Some((i, end)));
            }
            18..=45 => {
                let (iid, row) = (format!("i{}", self.counter + 1), self.message());
                self.model[i].frames.push(F::Item(iid, row));
            }
            46..=55 => {
                let target = self.pick_iid(i);
                let row = self.message();
                self.model[i].frames.push(F::Amend(target, row));
            }
            56..=63 => {
                let next = self.next_ordinal(i);
                if next > 1 {
                    let to = 1 + self.rng.below((next - 1) as usize) as i64;
                    self.model[i].frames.push(F::Rewind(to));
                }
            }
            64..=69 => {
                let mut rows = Vec::new();
                for _ in 0..self.rng.below(3) {
                    let kept = self.pick_iid(i);
                    let row = self.message();
                    rows.push((kept, row));
                }
                let summary = (format!("s{}", self.counter + 1), self.message());
                rows.insert(0, summary);
                let cid = format!("k{}", self.counter);
                self.model[i].frames.push(F::Compact(cid, rows));
            }
            70..=73 => {
                self.counter += 1;
                let title = format!("title {}", self.counter);
                self.model[i].frames.push(F::Title(title));
            }
            74..=89 => {
                let len = self.model[i].frames.len();
                let submitted = self.model[i].submitted;
                if len > submitted {
                    let upto = submitted + 1 + self.rng.below(len - submitted);
                    self.submit(i, upto);
                }
            }
            90..=94 => {
                for _ in 0..1 + self.rng.below(4) {
                    self.cycle();
                }
            }
            95..=96 => self.crash(),
            _ => {
                self.settle();
                self.compare(false);
            }
        }
    }

    /// An iid of session `i` (or, now and then, of another session: such an amend is ignored).
    fn pick_iid(&mut self, i: usize) -> String {
        let from = if self.rng.below(7) == 0 { self.rng.below(self.model.len()) } else { i };
        let iids: Vec<String> = self.model[from]
            .frames
            .iter()
            .flat_map(|f| match f {
                F::Item(iid, _) => vec![iid.clone()],
                F::Compact(_, rows) => rows.iter().map(|(iid, _)| iid.clone()).collect(),
                _ => Vec::new(),
            })
            .collect();
        if iids.is_empty() { "none".into() } else { iids[self.rng.below(iids.len())].clone() }
    }

    fn finish(&mut self) {
        let mut order: Vec<usize> = (0..self.model.len()).collect();
        for k in (1..order.len()).rev() {
            let j = self.rng.below(k + 1);
            order.swap(k, j);
        }
        for i in order {
            let len = self.model[i].frames.len();
            self.submit(i, len);
        }
        self.settle();
        self.reconcile();
        self.settle();
        self.compare(true);
    }
}

fn describe(f: &F) -> String {
    match f {
        F::Session(b) => format!("session {b:?}"),
        F::Item(iid, row) => format!("item {iid} counted={} preview={:?}", row.counted, row.preview),
        F::Amend(iid, row) => format!("amend {iid} counted={} preview={:?}", row.counted, row.preview),
        F::Rewind(to) => format!("rewind {to}"),
        F::Compact(cid, rows) => format!("compact {cid} {:?}", rows.iter().map(|r| r.0.clone()).collect::<Vec<_>>()),
        F::Title(t) => format!("title {t}"),
    }
}

fn run(seed: u64) {
    let world = std::cell::RefCell::new(None::<World>);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        *world.borrow_mut() = Some(World::new(seed));
        let mut w = world.borrow_mut();
        let world = w.as_mut().expect("set");
        for _ in 0..30 + seed % 40 {
            world.op();
        }
        world.settle();
        world.compare(false);
        world.finish();
    }));
    if outcome.is_err() && std::env::var("MIXDOG_MODEL_DUMP").is_ok() && let Ok(w) = world.try_borrow() {
        {
            let w = w.as_ref().expect("set");
            let mut stmt = w
                .w
                .conn
                .prepare(
                    "SELECT session, valid_from, base, position, cut, state, scanning, hop_session, hop_time, hop_cut,
                     cur_ordinal, cur_idx FROM message_views",
                )
                .expect("views");
            let rows = stmt
                .query_map([], |r| {
                    Ok(format!(
                        "view {:?}",
                        (0..12).map(|i| format!("{:?}", r.get_ref(i).unwrap())).collect::<Vec<_>>()
                    ))
                })
                .expect("rows");
            for r in rows {
                eprintln!("{}", r.expect("row"));
            }
            for (id, p) in w
                .w
                .conn
                .prepare("SELECT id, projected_ordinal FROM sessions")
                .expect("sessions")
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .expect("rows")
                .map(|r| r.expect("row"))
            {
                eprintln!("session {id} projected {p}");
            }
            for s in &w.model {
                eprintln!("{} start={} submitted={}", s.id, s.start, s.submitted);
                for (k, f) in s.frames.iter().enumerate() {
                    eprintln!("  {} {}", s.start + k as i64, describe(f));
                }
            }
        }
    }
    if let Err(e) = outcome {
        let message = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()));
        panic!("seed {seed}: {}", message.unwrap_or_default());
    }
}

/// The seeds every run covers; `MIXDOG_MODEL_SEEDS` raises the count for a longer search.
const DEFAULT_SEEDS: u64 = 100;
/// Seeds per test: each seed is an independent random walk.
const SEED_CHUNK: usize = 5;

fn seeds_chunk(chunk: usize) {
    for seed in mixdog_rt::testing::chunk_range(DEFAULT_SEEDS as usize, chunk, SEED_CHUNK) {
        run(seed as u64);
    }
}

mixdog_rt::replay_chunks!(SEED_TESTS, #[test] seeds_chunk; [
    random_operations_match_the_oracle_00 = 0,
    random_operations_match_the_oracle_01 = 1,
    random_operations_match_the_oracle_02 = 2,
    random_operations_match_the_oracle_03 = 3,
    random_operations_match_the_oracle_04 = 4,
    random_operations_match_the_oracle_05 = 5,
    random_operations_match_the_oracle_06 = 6,
    random_operations_match_the_oracle_07 = 7,
    random_operations_match_the_oracle_08 = 8,
    random_operations_match_the_oracle_09 = 9,
    random_operations_match_the_oracle_10 = 10,
    random_operations_match_the_oracle_11 = 11,
    random_operations_match_the_oracle_12 = 12,
    random_operations_match_the_oracle_13 = 13,
    random_operations_match_the_oracle_14 = 14,
    random_operations_match_the_oracle_15 = 15,
    random_operations_match_the_oracle_16 = 16,
    random_operations_match_the_oracle_17 = 17,
    random_operations_match_the_oracle_18 = 18,
    random_operations_match_the_oracle_19 = 19,
]);

#[test]
fn every_default_seed_has_its_test() {
    mixdog_rt::testing::assert_chunks_registered(SEED_TESTS, DEFAULT_SEEDS as usize, SEED_CHUNK);
}

#[test]
fn the_regression_seeds_match_the_oracle() {
    for seed in REGRESSIONS.iter().copied() {
        run(seed);
    }
}

/// `MIXDOG_MODEL_SEEDS` above the default runs the further seeds here.
#[test]
fn the_seeds_past_the_default_match_the_oracle() {
    let seeds: u64 = std::env::var("MIXDOG_MODEL_SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_SEEDS);
    for seed in DEFAULT_SEEDS..seeds {
        run(seed);
    }
}
