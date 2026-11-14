//! Layer A golden: the host's recorded answers (`browser-engine-transcript.jsonl`, every `host/browser/*` call of the product's
//! script and what the Electron host answered) are replayed into the engine, which is then given each request of the corpus
//! (`browser-golden.json`, the model-visible text the product's Node engine produced). The text the engine answers must be the
//! corpus's, once what differs per run (ports, paths, durations, ids numbered by the run) is normalised as the corpus's recorder
//! (`golden-twin.integration.ts`) did.
//!
//! Both fixtures are required: a missing one fails the test, it never skips it.

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_browser_engine::ApprovalPort;
use mixdog_browser_engine::BlobPort;
use mixdog_browser_engine::FilePort;
use mixdog_browser_engine::TakeoverPort;
use mixdog_browser_engine::actions::registry::is_action;
use mixdog_browser_engine::approval::classify::ActionPolicy;
use mixdog_browser_engine::fake::FakeHost;
use mixdog_browser_engine::lane::mirror::Mirror;
use mixdog_browser_engine::lane::sink::EngineSinkImpl;
use mixdog_browser_engine::queue::user_hold::UserHold;
use mixdog_browser_engine::runner::guard::SecretGuard;
use mixdog_browser_engine::runner::runner::BrowserEngine;
use mixdog_browser_engine::runner::runner::EnginePorts;
use mixdog_browser_engine::types::ApprovalAnswer;
use mixdog_browser_engine::types::BrowserApprovalPrompt;
use mixdog_browser_engine::types::FileFacts;
use mixdog_browser_engine::types::Remember;
use mixdog_browser_engine::types::TakeoverGuard;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use regex::Captures;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;

/// A session that filled no secret.
struct NoSecrets;

impl SecretGuard for NoSecrets {
    fn redact(&self, _session_id: &str, text: &str) -> String {
        text.to_owned()
    }

    fn remember(&self, _session_id: &str, _secret: &str) {}
}

/// The product's recorded host ran with `requestApproval` answering yes.
struct Allows;

#[async_trait]
impl ApprovalPort for Allows {
    async fn ask(&self, _prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        Ok(ApprovalAnswer::Allow { remember: Remember::Once })
    }
}

struct NoTakeover;

impl TakeoverPort for NoTakeover {
    fn begin(&self, _session_id: &str) -> Result<TakeoverGuard, String> {
        Ok(TakeoverGuard::new(CancellationToken::new(), None))
    }
}

/// Everything the host handed over is inline in the transcript: no blob is read.
struct NoBlobs;

#[async_trait]
impl BlobPort for NoBlobs {
    async fn read(&self, digest: &str) -> Result<Bytes, String> {
        Err(format!("the transcript holds no blob {digest}"))
    }
}

/// The files the script's uploads name belonged to the recorder: the replay answers as if they were there, never reads the disk.
struct RecordedFiles;

#[async_trait]
impl FilePort for RecordedFiles {
    async fn stat(&self, path: &Path) -> FileFacts {
        FileFacts { exists: true, is_file: true, size: 22, canonical: Some(path.to_path_buf()), modified: None }
    }

    async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
        Ok(run_dir.to_path_buf())
    }
}

/// What the corpus stores for what differs per run, and the numbering of the ids a run hands out (by first appearance, as the
/// recorder compared its two passes). One normaliser reads one run's texts in order.
struct Normalizer {
    frame_origin: Regex,
    socket: Regex,
    origin: Regex,
    profile: Regex,
    millis: Regex,
    page: Regex,
    download: Regex,
    rule: Regex,
    download_prefix: Regex,
    pages: Vec<String>,
    downloads: Vec<String>,
    rules: Vec<String>,
}

fn ordinal(table: &mut Vec<String>, id: String) -> usize {
    match table.iter().position(|seen| *seen == id) {
        Some(index) => index + 1,
        None => {
            table.push(id);
            table.len()
        }
    }
}

impl Normalizer {
    fn new() -> Self {
        let re = |pattern: &str| Regex::new(pattern).expect("a valid pattern");
        Self {
            frame_origin: re(r"http://127\.0\.0\.2:\d+"),
            socket: re(r"ws://127\.0\.0\.1:\d+/socket"),
            origin: re(r"http://127\.0\.0\.1:\d+"),
            profile: re(r#"(?:[A-Za-z]:)?[\\/][^\s"'<>()]*?mixdog-browser-golden-profile-[A-Za-z0-9]+"#),
            millis: re(r"\b\d+(?:\.\d+)? ?ms\b"),
            page: re(r#"\bp(\d+)\b(-s\d|[ \]"):,.]|$)"#),
            download: re(r"\[d(\d+)\]"),
            rule: re(r"\b(is?)(\d+)\b([\] .,:]|$)"),
            download_prefix: re(r"[a-z0-9]{8}-(browser-fixture\.txt)"),
            pages: Vec::new(),
            downloads: Vec::new(),
            rules: Vec::new(),
        }
    }

    fn text(&mut self, text: &str) -> String {
        let text = self.frame_origin.replace_all(text, "<FRAME_ORIGIN>");
        let text = self.socket.replace_all(&text, "<SOCKET>");
        let text = self.origin.replace_all(&text, "<ORIGIN>");
        let text = self.profile.replace_all(&text, "<PROFILE>");
        let text = self.millis.replace_all(&text, "<N>ms");
        let pages = &mut self.pages;
        let text = self.page.replace_all(&text, |found: &Captures| format!("p#{}{}", ordinal(pages, found[1].to_owned()), &found[2]));
        let downloads = &mut self.downloads;
        let text = self.download.replace_all(&text, |found: &Captures| format!("[d#{}]", ordinal(downloads, found[1].to_owned())));
        let rules = &mut self.rules;
        let text = self.rule.replace_all(&text, |found: &Captures| format!("{}#{}{}", &found[1], ordinal(rules, format!("{}{}", &found[1], &found[2])), &found[3]));
        self.download_prefix.replace_all(&text, "$1").into_owned()
    }
}

const TRACE_STOPPED: &str = "Performance trace stopped.\n";

/// The structure of a performance trace result (`trace-compare.ts`): a header of duration and event count, then the heading and
/// one line per event name. The durations are wall-clock and compare only after normalisation; the rest compares as text.
fn trace_shape(text: &str) -> Result<(), String> {
    let matches = |pattern: &str, text: &str| Regex::new(pattern).expect("a valid pattern").is_match(text);
    let lines: Vec<&str> = text.strip_prefix(TRACE_STOPPED).ok_or("not a performance trace result")?.split('\n').collect();
    if !matches(r"^Trace duration: \d+ms$", lines[0]) || !lines.get(1).is_some_and(|events| matches(r"^Events: \d+(; dropped after cap: \d+)?$", events)) {
        return Err(format!("unexpected trace header: {:?}", &lines[..lines.len().min(2)]));
    }
    if lines.len() > 2 {
        if lines[2] != "Top trace events:" {
            return Err(format!("unexpected trace heading: {:?}", lines[2]));
        }
        if let Some(entry) = lines[3..].iter().find(|entry| !matches(r"^- (.+): (\d+) event\(s\), \d+\.\d{2}ms total$", entry)) {
            return Err(format!("unexpected trace entry: {entry:?}"));
        }
    }
    Ok(())
}

/// The origin the transcript's host listened on, so a request's `<ORIGIN>` is the address the recorded host saw; a transcript
/// that already holds the placeholder keeps it.
fn recorded_origin(transcript: &str) -> String {
    Regex::new(r"http://127\.0\.0\.1:\d+").expect("a valid pattern").find(transcript).map_or_else(|| "<ORIGIN>".to_owned(), |found| found.as_str().to_owned())
}

fn shorten(text: &str) -> String {
    text.chars().take(400).collect()
}

#[tokio::test]
async fn golden_texts_match_recorded_host() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/desktop-host/browser-golden.json")).expect("browser-golden.json is JSON");
    let transcript = mixdog_testkit::fixture!("../../fixtures/desktop-host/browser-engine-transcript.jsonl");
    let steps = golden["steps"].as_array().expect("the corpus has steps");
    let origin = recorded_origin(transcript);

    let host = Arc::new(FakeHost::from_transcript_str(transcript).expect("the transcript is readable"));
    let mirror = Arc::new(Mirror::new());
    let hold = Arc::new(UserHold::new());
    let engine = BrowserEngine::new(
        host.clone(),
        EnginePorts {
            mirror: mirror.clone(),
            hold: hold.clone(),
            approvals: Arc::new(Allows),
            takeover: Arc::new(NoTakeover),
            blobs: Arc::new(NoBlobs),
            files: Arc::new(RecordedFiles),
            secrets: Arc::new(NoSecrets),
            approval_policy: ActionPolicy::from_env(None, None, None, is_action),
            urls: UrlPolicy::default(),
            frame_dir: PathBuf::from("frames"),
        },
    );
    host.attach_sink(engine.sink(Arc::new(EngineSinkImpl::new(mirror, hold))));

    let thread = ThreadId::from("golden-bridge");
    let mut corpus = Normalizer::new();
    let mut engine_run = Normalizer::new();
    let mut mismatches = Vec::new();
    let mut succeeded = BTreeSet::new();
    for step in steps {
        let name = step["name"].as_str().expect("a step has a name");
        let request = step["request"].as_object().expect("a step has its request");
        let action = request["action"].as_str().expect("a request has its action");
        let ok = step["ok"].as_bool().expect("a step says whether it succeeded");
        let wanted = step[if ok { "text" } else { "error" }].as_str().unwrap_or_else(|| panic!("{name}: the corpus has no text"));
        if ok {
            succeeded.insert(action.to_owned());
        }

        let mut input: Map<String, Value> = serde_json::from_str(&Value::Object(request.clone()).to_string().replace("<ORIGIN>", &origin)).expect("a request is JSON");
        input.remove("action");
        let answer = engine.run(&thread, "1", action, &input, &CancellationToken::new()).await;
        let (got_ok, got, image_mime, has_timing) = match &answer {
            Ok(reply) => (true, reply.text.clone(), reply.image.as_ref().map(|image| image.mime_type.clone()), reply.timing.is_some()),
            Err(error) => (false, error.message_for_model.clone(), None, false),
        };

        let wanted = corpus.text(wanted);
        let got = engine_run.text(&got);
        // A trace's durations are wall-clock: it is held to the full text apart from them.
        let shape = if ok && got_ok && wanted.starts_with(TRACE_STOPPED) { trace_shape(&got).err() } else { None };
        // The product attached a failure's timing to the error's data; the engine's failure carries none, so it is compared on success.
        let same = got_ok == ok
            && got == wanted
            && shape.is_none()
            && image_mime.as_deref() == step["imageMime"].as_str()
            && (!ok || has_timing == step["hasTiming"].as_bool().unwrap_or(false));
        if !same {
            mismatches.push(format!(
                "{name}\n  corpus: {:?}\n  engine: {:?}{}",
                (ok, shorten(&wanted)),
                (got_ok, shorten(&got), image_mime, has_timing),
                shape.map(|shape| format!("\n  {shape}")).unwrap_or_default()
            ));
        }
    }

    host.finish().expect("every recorded host call was made, in order");
    assert!(mismatches.is_empty(), "{} of {} steps differ from the corpus:\n{}", mismatches.len(), steps.len(), mismatches.join("\n"));
    let unexercised: Vec<&str> = golden["actions"].as_array().expect("the corpus lists its actions").iter().filter_map(Value::as_str).filter(|action| !succeeded.contains(*action)).collect();
    assert!(unexercised.is_empty(), "every browser action must succeed at least once: {unexercised:?}");
}
