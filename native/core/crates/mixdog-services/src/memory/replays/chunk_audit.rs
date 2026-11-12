//! memory-chunk-audit.
//!
//! - Cases 1 and 2 (`assessChunkQuality` on a root and its members) are `assess_chunk_quality`, the assessment compared
//!   whole; the root is read after the call, so its summary and absent record stay as recorded.
//! - Case 4 and the further shapes are `recallSessionRows` calls: here the internal `search_memories` tool's
//!   `Recall::search_memories` (Node's `handleSearch`, which forwards every argument) with the recorded options. The
//!   manifest names the `recall` tool (`Recall::recall`), but that tool forwards only its advertised arguments, in Node
//!   and in the core, so `compactHandoff` never reaches the session browse through it. Over a private cluster (module
//!   `pg`) holding the rows that answer Node's recorded
//!   statements as the test file's stand-in did: the recorded `root` (its answer to the session page) and the source's
//!   member row 2 (with the root, its answer to `chunk_root = ANY([1])`). The source's row 3 (`chunk_root = id = 3`)
//!   is left out: Node's session statement (`… OR chunk_root = id`) selects it from any database holding it, and the
//!   stand-in never answers with it. The returned text is compared whole. Node's `statements` are the stand-in's log
//!   (it answers by SQL text), which the core's real database has no counterpart of.
//!
//! Not replayed:
//! - Case 0 (`auditChunkEntries` / `collectChunkRoots`, test line 38) and case 3 (`readRawRowsInWindow` binding a
//!   non-string `projectScope`, test line 101): the manifest's exclusions name them as having no Rust counterpart a
//!   client reaches (a maintenance diagnostic; a JS typing artefact the core's typed scope cannot take).

use mixdog_testkit::Exact;

use super::chunk_quality_handoff::{assessment_value, qrow};
use super::{assert_case_count, case, golden, object, same, string};
use crate::memory::cycles::quality::{Row, assess_chunk_quality};

const SET: &str = "memory-chunk-audit";

/// A recorded member as the assessment's row: `assessChunkQuality` reads a member's id, session, ts, role and content
/// (`canonicalMembers`, `chunkCompression`), never its `is_root`, `chunk_root` or `summary`, which the Rust row has no
/// field for.
fn member(value: &Exact) -> Row {
    let read: Vec<(String, Exact)> =
        value.entries().iter().filter(|(k, _)| !matches!(k.as_str(), "is_root" | "chunk_root" | "summary")).cloned().collect();
    qrow(&Exact::Object(read))
}

fn assess(root: &Exact) -> Exact {
    let summary = root.get("summary").as_str();
    let quality = root.try_get("chunk_quality").map(|q| q.to_plain().expect("JSON record"));
    let members: Vec<Row> = root.get("members").as_array().iter().map(member).collect();
    object(vec![("result", assessment_value(&assess_chunk_quality(summary, quality.as_ref(), &members)))])
}

#[test]
fn the_recording_has_six_cases() {
    assert_case_count(&golden(SET), 6);
}

#[test]
fn existing_good_chunks_are_usable_without_an_ai_call_or_a_verification_record() {
    let g = golden(SET);
    let name = "existing good chunks are usable without an AI call or a verification record (test line 55)";
    let c = case(&g, 1, name);
    let root = c.get("root");
    // The root the assessment is given, read again after it: its summary and record as the core left them.
    let summary = root.get("summary").as_str().to_owned();
    let quality = root.try_get("chunk_quality").map(|q| q.to_plain().expect("JSON record"));
    let members: Vec<Row> = root.get("members").as_array().iter().map(member).collect();
    let review = object(vec![("result", assessment_value(&assess_chunk_quality(&summary, quality.as_ref(), &members)))]);
    same(&format!("{name}: review"), c.get("review"), &review);
    same(&format!("{name}: summary unchanged"), c.get("summaryUnchanged"), &Exact::Bool(summary == root.get("summary").as_str()));
    same(&format!("{name}: chunk_quality after"), c.get("chunkQualityAfter"), &quality.map_or(Exact::Undefined, |q| Exact::plain(&q)));
}

#[test]
fn legacy_reuse_still_rejects_mixed_sessions_and_expanded_summaries() {
    let g = golden(SET);
    let name = "legacy reuse still rejects mixed sessions and expanded summaries (test line 65)";
    let c = case(&g, 2, name);
    for key in ["mixed", "expanded"] {
        let probe = c.get(key);
        let assessed = assess(probe.get("input"));
        same(&format!("{name}: {key}"), &object(vec![("result", probe.get("result").clone())]), &assessed);
    }
}

mod pg {
    use super::*;
    use crate::memory::replays::pg::{ReplayPg, insert_entries, memory_db, recall};

    /// One session over `pg`, whose memory schema is as a new cluster has it.
    async fn session(pg: &ReplayPg, what: &str, session: &Exact, now_ms: i64) {
        let root = session.get("root");
        let source = session.get("dbEntries").as_array();
        assert_eq!(source[0].get("id"), root.get("id"), "{what}: the root stands in for the source's first row");
        let held: Vec<&Exact> = vec![root, &source[1]];
        insert_entries(&pg.db, &held).await;
        let args = session.get("options").to_plain().expect("JSON options");
        let outcome = recall(&pg.db, now_ms).search_memories(&args, &tokio_util::sync::CancellationToken::new()).await;
        same(what, session.get("result"), &object(vec![("text", string(outcome.text))]));
    }

    fn now_ms(g: &Exact) -> i64 {
        g.get("clock").get("dateNowMs").as_f64() as i64
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn compact_session_retrieval_includes_the_original_root_as_a_member_without_requiring_include_members() {
        let g = golden(SET);
        let name = "compact session retrieval includes the original root as a member without requiring includeMembers (test line 81)";
        session(&memory_db().await, name, case(&g, 4, name).get("session"), now_ms(&g)).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn further_shapes_beyond_the_test_file() {
        let g = golden(SET);
        let name = "further shapes (beyond the test file)";
        let sessions = case(&g, 5, name).get("sessions").as_array();
        // One cluster for every session; each starts from the memory schema a new cluster has.
        let pg = memory_db().await;
        for (at, s) in sessions.iter().enumerate() {
            if at > 0 {
                pg.reset().await;
            }
            session(&pg, &format!("{name}: {}", s.get("label").as_str()), s, now_ms(&g)).await;
        }
    }
}
