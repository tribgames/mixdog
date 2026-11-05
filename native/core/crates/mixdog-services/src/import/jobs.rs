//! Background import jobs.
//!
//! Jobs are shared by the whole daemon, so a job keeps running and stays observable after the
//! dialog closes or the user switches conversations. Every file passes one serialized admission
//! lane shared by all jobs, where the "already imported" check is repeated right before the
//! session is created, against the session catalog read once per batch and every commit of this
//! process since. An import key only counts as imported while its session still exists in
//! storage, so a deleted import can be imported again. Cancel stops admitting further files;
//! committed imports stay.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::candidate::import_origin_key;
use super::convert::{Conversion, Limits, Source};
use super::discovery::{Discovery, Imported, display_title, resolve_source_cwd};
use super::fsutil::ImportError;
use super::turns::WARNING_CWD_MISSING;

const MAX_FINISHED_JOBS: usize = 20;
const EXISTS_CONCURRENCY: usize = 16;

/// Provenance stored on an imported session.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOrigin {
    pub version: u32,
    pub source: Source,
    pub source_path: PathBuf,
    pub foreign_session_id: Option<String>,
    pub source_cwd: Option<String>,
    pub imported_at: i64,
    pub key: String,
}

impl ImportOrigin {
    pub fn new(source: Source, source_path: PathBuf, foreign_session_id: Option<String>, source_cwd: Option<String>, imported_at: i64) -> Self {
        let key = import_origin_key(source, foreign_session_id.as_deref(), &source_path);
        Self { version: 1, source, source_path, foreign_session_id, source_cwd, imported_at, key }
    }
}

/// One conversation to materialize as an ordinary Lead session.
pub struct ImportedSession {
    pub conversation: Conversion,
    pub origin: ImportOrigin,
    /// The project directory, when the conversation's cwd exists here.
    pub project_path: Option<String>,
}

/// The session layer's side of an import.
#[async_trait]
pub trait ImportSessions: Send + Sync {
    /// `(importKey, sessionId)` of every open session that carries an import origin.
    async fn imported_sessions(&self) -> Vec<(String, String)>;
    /// Whether a session is still in storage.
    async fn session_exists(&self, id: &str) -> bool;
    /// Resolves the Lead route a new session starts on; an `Err` code fails the whole job.
    async fn prepare_lead(&self) -> Result<(), String>;
    /// Creates, fills and durably saves the session; returns its id or a failure code.
    async fn create_imported_session(&self, session: ImportedSession) -> Result<String, String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JobState {
    Running,
    Stopping,
    Stopped,
    Completed,
    Failed,
}

impl JobState {
    fn name(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
    fn live(self) -> bool {
        matches!(self, Self::Running | Self::Stopping)
    }
}

#[derive(Default, Clone, Copy)]
struct Counts {
    imported: u64,
    skipped: u64,
    failed: u64,
}

struct Job {
    job_id: String,
    request_id: String,
    seq: u64,
    state: JobState,
    total: usize,
    counts: Counts,
    by_project: Vec<(Option<String>, Counts)>,
    results: Vec<Value>,
    current: Option<Value>,
    error_code: Option<String>,
    cancel_requested: bool,
}

impl Job {
    fn snapshot(&self) -> Value {
        let mut out = json!({
            "jobId": self.job_id,
            "seq": self.seq,
            "state": self.state.name(),
            "total": self.total,
            "processed": self.counts.imported + self.counts.skipped + self.counts.failed,
            "imported": self.counts.imported,
            "skippedAlreadyImported": self.counts.skipped,
            "failed": self.counts.failed,
            "byProject": self.by_project.iter().map(|(path, c)| json!({
                "projectPath": path, "imported": c.imported, "skippedAlreadyImported": c.skipped, "failed": c.failed,
            })).collect::<Vec<_>>(),
            "results": self.results,
            "current": self.current,
        });
        if let Some(code) = &self.error_code {
            out["errorCode"] = json!(code);
        }
        out
    }

    fn touch(&mut self) {
        self.seq += 1;
    }
}

type JobRef = Arc<Mutex<Job>>;

#[derive(Default)]
struct Registry {
    /// Insertion order is start order.
    jobs: Vec<JobRef>,
    by_request: HashMap<String, String>,
    /// import key → session id, imports of this process (summaries can lag a save).
    committed: HashMap<String, String>,
}

/// One import result, before it is recorded.
struct Outcome {
    candidate_id: String,
    status: &'static str,
    error_code: Option<String>,
    session_id: Option<String>,
    warnings: Vec<String>,
    project_path: Option<String>,
}

impl Outcome {
    fn failed(candidate_id: &str, code: &str, project_path: Option<String>, warnings: Vec<String>) -> Self {
        Self { candidate_id: candidate_id.to_owned(), status: "failed", error_code: Some(code.to_owned()), session_id: None, warnings, project_path }
    }
}

pub struct ImportJobs {
    discovery: Arc<Discovery>,
    sessions: Arc<dyn ImportSessions>,
    limits: Limits,
    registry: Mutex<Registry>,
    /// The one serialized admission lane shared by all jobs.
    admission: tokio::sync::Mutex<()>,
}

struct BatchContext {
    imported: Imported,
    titles: Option<Arc<HashMap<String, String>>>,
    lead_prepared: bool,
}

/// A job-level failure that ends the job instead of one file.
struct Fatal(String);

impl ImportJobs {
    pub fn new(discovery: Arc<Discovery>, sessions: Arc<dyn ImportSessions>, limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            discovery,
            sessions,
            limits,
            registry: Mutex::default(),
            admission: tokio::sync::Mutex::new(()),
        })
    }

    /// The import keys that currently exist as sessions. Candidates come from this process's
    /// commits, then the session catalog; every candidate id's existence is checked once, up
    /// front. Committed ids whose session no longer exists are dropped.
    pub async fn imported_lookup(&self) -> Imported {
        let from_catalog = self.sessions.imported_sessions().await;
        let committed_at_start = self.registry.lock().unwrap().committed.clone();
        let ids: Vec<String> = {
            let mut seen = HashSet::new();
            committed_at_start
                .values()
                .cloned()
                .chain(from_catalog.iter().map(|(_, id)| id.clone()))
                .filter(|id| seen.insert(id.clone()))
                .collect()
        };
        let permits = Arc::new(Semaphore::new(EXISTS_CONCURRENCY));
        let mut checks = Vec::new();
        for id in ids {
            let (sessions, permits) = (self.sessions.clone(), permits.clone());
            checks.push(tokio::spawn(async move {
                let _permit = permits.acquire().await.expect("semaphore is never closed");
                let exists = sessions.session_exists(&id).await;
                (id, exists)
            }));
        }
        let mut existing = HashSet::new();
        for check in checks {
            if let Ok((id, true)) = check.await {
                existing.insert(id);
            }
        }
        {
            let mut registry = self.registry.lock().unwrap();
            for (key, id) in &committed_at_start {
                if !existing.contains(id) && registry.committed.get(key) == Some(id) {
                    registry.committed.remove(key);
                }
            }
        }
        let mut map = HashMap::new();
        for (key, id) in &from_catalog {
            if existing.contains(id) {
                map.entry(key.clone()).or_insert_with(|| id.clone());
            }
        }
        for (key, id) in &committed_at_start {
            if existing.contains(id) {
                map.insert(key.clone(), id.clone());
            }
        }
        Imported(map)
    }

    pub fn get_jobs(&self, job_id: Option<&str>) -> Value {
        let registry = self.registry.lock().unwrap();
        let list: Vec<Value> = registry
            .jobs
            .iter()
            .map(|j| j.lock().unwrap())
            .filter(|j| job_id.is_none_or(|id| j.job_id == id))
            .map(|j| j.snapshot())
            .collect();
        json!({ "jobs": list })
    }

    pub fn cancel(&self, job_id: &str) -> Result<Value, ImportError> {
        let job = self.find(job_id).ok_or_else(|| ImportError::new("jobNotFound"))?;
        let mut job = job.lock().unwrap();
        if job.state == JobState::Running {
            job.cancel_requested = true;
            job.state = JobState::Stopping;
            job.touch();
        }
        Ok(job.snapshot())
    }

    fn find(&self, job_id: &str) -> Option<JobRef> {
        self.registry.lock().unwrap().jobs.iter().find(|j| j.lock().unwrap().job_id == job_id).cloned()
    }

    /// The snapshot of the job already started for `request_id`.
    pub fn existing(&self, request_id: &str) -> Option<Value> {
        let id = self.registry.lock().unwrap().by_request.get(request_id).cloned()?;
        let job = self.find(&id)?;
        let snapshot = job.lock().unwrap().snapshot();
        Some(snapshot)
    }

    /// Starts a job over `ids` for `request_id`, or returns the one already started for it (the
    /// check and the registration are one step, so a duplicate request never starts a second
    /// job).
    pub fn start(self: &Arc<Self>, request_id: &str, ids: Vec<String>) -> Value {
        let job: JobRef = {
            let mut registry = self.registry.lock().unwrap();
            if let Some(existing) = registry.by_request.get(request_id).and_then(|id| {
                registry.jobs.iter().find(|j| j.lock().unwrap().job_id == *id).cloned()
            }) {
                let snapshot = existing.lock().unwrap().snapshot();
                return snapshot;
            }
            let job = Job {
                job_id: uuid::Uuid::new_v4().to_string(),
                request_id: request_id.to_owned(),
                seq: 0,
                state: JobState::Running,
                total: ids.len(),
                counts: Counts::default(),
                by_project: Vec::new(),
                results: Vec::new(),
                current: None,
                error_code: None,
                cancel_requested: false,
            };
            registry.by_request.insert(request_id.to_owned(), job.job_id.clone());
            let job: JobRef = Arc::new(Mutex::new(job));
            registry.jobs.push(job.clone());
            job
        };
        let snapshot = job.lock().unwrap().snapshot();
        let runner = self.clone();
        tokio::spawn(async move { runner.run_job(job, ids).await });
        snapshot
    }

    fn describe(&self, candidate_id: &str, ctx: &BatchContext) -> (Option<String>, Option<String>) {
        let Some(candidate) = self.discovery.get_candidate(candidate_id) else { return (None, None) };
        let titles = (candidate.source == Source::Codex).then(|| ctx.titles.as_deref()).flatten();
        let meta = self.discovery.cached_meta(&candidate);
        (
            display_title(meta.as_ref(), titles, candidate.title.as_deref()),
            candidate.path.file_name().map(|n| n.to_string_lossy().into_owned()),
        )
    }

    fn record(&self, job: &JobRef, outcome: Outcome, title: Option<String>, source_name: Option<String>) {
        let mut job = job.lock().unwrap();
        let bump = |c: &mut Counts| match outcome.status {
            "imported" => c.imported += 1,
            "alreadyImported" => c.skipped += 1,
            _ => c.failed += 1,
        };
        bump(&mut job.counts);
        match job.by_project.iter_mut().find(|(p, _)| *p == outcome.project_path) {
            Some((_, counts)) => bump(counts),
            None => {
                let mut counts = Counts::default();
                bump(&mut counts);
                job.by_project.push((outcome.project_path.clone(), counts));
            }
        }
        let mut result = json!({
            "candidateId": outcome.candidate_id,
            "status": outcome.status,
            "warnings": outcome.warnings,
            "title": title,
            "sourceName": source_name,
        });
        if let Some(code) = outcome.error_code {
            result["errorCode"] = json!(code);
        }
        if let Some(id) = outcome.session_id {
            result["sessionId"] = json!(id);
        }
        job.results.push(result);
        job.touch();
    }

    fn prune_finished(&self) {
        let mut registry = self.registry.lock().unwrap();
        let finished: Vec<(String, String)> = registry
            .jobs
            .iter()
            .map(|j| j.lock().unwrap())
            .filter(|j| !j.state.live())
            .map(|j| (j.job_id.clone(), j.request_id.clone()))
            .collect();
        for (job_id, request_id) in finished.iter().take(finished.len().saturating_sub(MAX_FINISHED_JOBS)) {
            registry.jobs.retain(|j| j.lock().unwrap().job_id != *job_id);
            if registry.by_request.get(request_id) == Some(job_id) {
                registry.by_request.remove(request_id);
            }
        }
    }

    async fn run_job(self: Arc<Self>, job: JobRef, candidate_ids: Vec<String>) {
        let outcome = self.run_files(&job, candidate_ids).await;
        {
            let mut job = job.lock().unwrap();
            match outcome {
                Ok(()) => job.state = if job.cancel_requested { JobState::Stopped } else { JobState::Completed },
                Err(Fatal(code)) => {
                    job.state = JobState::Failed;
                    job.current = None;
                    job.error_code = Some(code);
                }
            }
            job.touch();
        }
        self.prune_finished();
    }

    async fn run_files(&self, job: &JobRef, candidate_ids: Vec<String>) -> Result<(), Fatal> {
        // One catalog read per batch; later commits are seen through the committed map.
        let mut ctx = BatchContext {
            imported: self.imported_lookup().await,
            titles: self.discovery.load_stored_titles(Source::Codex).await,
            lead_prepared: false,
        };
        for candidate_id in candidate_ids {
            if job.lock().unwrap().cancel_requested {
                break;
            }
            let admitted = {
                let _lane = self.admission.lock().await;
                // A cancel that arrived while queued behind other jobs wins here.
                if job.lock().unwrap().cancel_requested {
                    None
                } else {
                    {
                        let (title, _) = self.describe(&candidate_id, &ctx);
                        let mut j = job.lock().unwrap();
                        j.current = Some(json!({"candidateId": candidate_id, "title": title}));
                        j.touch();
                    }
                    let result = self.import_one(&candidate_id, &mut ctx).await;
                    job.lock().unwrap().current = None;
                    Some(result)
                }
            };
            let Some(result) = admitted else { break };
            let outcome = result?;
            let (title, source_name) = self.describe(&candidate_id, &ctx);
            self.record(job, outcome, title, source_name);
        }
        Ok(())
    }

    async fn import_one(&self, candidate_id: &str, ctx: &mut BatchContext) -> Result<Outcome, Fatal> {
        let Some(mut candidate) = self.discovery.get_candidate(candidate_id) else {
            return Ok(Outcome::failed(candidate_id, "unknownCandidate", None, Vec::new()));
        };
        // The chat keeps the title the user picked it by: a long file's listing title comes from
        // its prefix and can differ from the converted branch. Codex's own stored title, when it
        // has one, names the chat first.
        let listed_title = self.discovery.cached_meta(&candidate).and_then(|m| m.title);
        let restamped = {
            let discovery = self.discovery.clone();
            tokio::task::spawn_blocking(move || discovery.restamp(&mut candidate).map(|()| candidate)).await
        };
        let Ok(Ok(candidate)) = restamped else {
            return Ok(Outcome::failed(candidate_id, "unreadable", None, Vec::new()));
        };
        let mut conversion = match self.discovery.convert(&candidate, self.limits).await {
            Ok(c) => c,
            Err(_) => return Ok(Outcome::failed(candidate_id, "unreadable", None, Vec::new())),
        };
        let titles = (candidate.source == Source::Codex).then(|| ctx.titles.as_deref()).flatten();
        let title_meta = super::discovery::Meta {
            foreign_session_id: conversion.foreign_session_id.clone(),
            title: listed_title.or_else(|| conversion.title.clone()),
            ..Default::default()
        };
        if let Some(title) = display_title(Some(&title_meta), titles, candidate.title.as_deref()) {
            conversion.title = Some(title);
        }
        self.discovery.record_conversion(&candidate, &conversion);
        let raw_cwd = conversion.cwd.clone();
        let cwd_info = tokio::task::spawn_blocking(move || resolve_source_cwd(raw_cwd.as_deref(), &mut HashMap::new()))
            .await
            .expect("cwd probe does not panic");
        let project_path = if cwd_info.exists { cwd_info.path.clone() } else { None };
        if let Some(code) = &conversion.error_code {
            return Ok(Outcome::failed(candidate_id, code, project_path, conversion.warnings.clone()));
        }
        let mut warnings = conversion.warnings.clone();
        if project_path.is_none() {
            warnings.push(WARNING_CWD_MISSING.to_owned());
        }
        let key = import_origin_key(candidate.source, conversion.foreign_session_id.as_deref(), &candidate.path);
        // The batch's catalog snapshot, then commits made since (by any job; the admission lane
        // serializes them).
        let mut existing = ctx.imported.get(&key).cloned();
        if existing.is_none() {
            let committed = self.registry.lock().unwrap().committed.get(&key).cloned();
            if let Some(id) = committed {
                if self.sessions.session_exists(&id).await {
                    existing = Some(id);
                }
            }
        }
        if let Some(session_id) = existing {
            return Ok(Outcome {
                candidate_id: candidate_id.to_owned(),
                status: "alreadyImported",
                error_code: None,
                session_id: Some(session_id),
                warnings,
                project_path,
            });
        }
        if !ctx.lead_prepared {
            self.sessions.prepare_lead().await.map_err(Fatal)?;
            ctx.lead_prepared = true;
        }
        let origin = ImportOrigin::new(
            candidate.source,
            candidate.path.clone(),
            conversion.foreign_session_id.clone(),
            conversion.cwd.clone(),
            now_ms(),
        );
        let created = self
            .sessions
            .create_imported_session(ImportedSession { conversation: conversion, origin, project_path: project_path.clone() })
            .await;
        match created {
            Ok(session_id) => {
                self.registry.lock().unwrap().committed.insert(key, session_id.clone());
                Ok(Outcome {
                    candidate_id: candidate_id.to_owned(),
                    status: "imported",
                    error_code: None,
                    session_id: Some(session_id),
                    warnings,
                    project_path,
                })
            }
            Err(code) => Ok(Outcome::failed(candidate_id, if code.is_empty() { "importFailed" } else { &code }, project_path, warnings)),
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}
