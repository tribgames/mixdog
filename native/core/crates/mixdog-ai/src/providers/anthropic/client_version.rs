//! The Claude subscription identity used by Messages, listing, and OAuth token exchanges.

use std::cmp::Ordering;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use regex::Regex;
use serde_json::{Value, json};
use tokio::sync::OnceCell;

use crate::client_versions::{RemoteVersion, compare_semver, max_semver};
use crate::oauth::CredentialIo;

use super::codec::DEFAULT_CLI_VERSION;

const LEARNED_FILE: &str = "anthropic-oauth-cli-version.json";

static REQUIREMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Claude Code\s+\d{1,4}\.\d{1,4}\.\d{1,6}\s+does not support this model;\s*version\s+(\d{1,4}\.\d{1,4}\.\d{1,6})\s+or newer is required\b")
        .expect("a valid Claude CLI requirement pattern")
});

pub(super) fn user_agent(version: &str) -> String {
    format!("claude-cli/{version} (external, sdk-cli)")
}

fn normalized_version(raw: &str) -> Option<String> {
    let mut parts = mixdog_js::js_trim(raw).split('.');
    let mut component = |max| {
        let part = parts.next()?;
        (part.len() <= max && part.bytes().all(|b| b.is_ascii_digit())).then(|| part.parse::<u32>().ok()).flatten()
    };
    let (major, minor, patch) = (component(4)?, component(4)?, component(6)?);
    parts.next().is_none().then(|| format!("{major}.{minor}.{patch}"))
}

fn stored_minimum(doc: &Value) -> Option<String> {
    if doc.get("version")?.as_u64()? != 1 {
        return None;
    }
    normalized_version(doc.get("cliVersion")?.as_str()?)
}

struct Store {
    path: PathBuf,
    io: CredentialIo,
}

/// One shared resolver for all users of the Claude subscription identity in the process.
pub struct ClaudeClientVersion {
    live: Option<Arc<RemoteVersion>>,
    store: Option<Store>,
    explicit: String,
    loaded: OnceCell<()>,
    minimum: Mutex<Option<String>>,
}

impl ClaudeClientVersion {
    /// Reuses the routing owner's existing `claude-cli` live version source.
    pub fn new(live: Arc<RemoteVersion>, data_dir: &Path, io: CredentialIo, explicit: &str) -> Arc<Self> {
        Arc::new(Self { live: Some(live), store: Some(Store { path: data_dir.join(LEARNED_FILE), io }), ..Self::fixed(explicit) })
    }

    pub(super) fn fixed(explicit: &str) -> Self {
        Self { live: None, store: None, explicit: mixdog_js::js_trim(explicit).to_owned(), loaded: OnceCell::new(), minimum: Mutex::new(None) }
    }

    pub fn current(&self) -> String {
        if !self.explicit.is_empty() {
            return self.explicit.clone();
        }
        let minimum = self.minimum.lock().unwrap_or_else(PoisonError::into_inner);
        let live = self.live.as_ref().and_then(|live| live.sync());
        max_semver(&[Some(DEFAULT_CLI_VERSION), minimum.as_deref(), live.as_deref()]).unwrap_or_else(|| DEFAULT_CLI_VERSION.to_owned())
    }

    async fn load_minimum(&self) {
        self.loaded
            .get_or_init(|| async {
                let Some(store) = &self.store else { return };
                let path = store.path.clone();
                if let Ok(Some(version)) = store
                    .io
                    .read_job(move |_| {
                        let version = mixdog_statefile::read_content(&path)
                            .ok()
                            .flatten()
                            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                            .as_ref()
                            .and_then(stored_minimum);
                        Ok(version)
                    })
                    .await
                {
                    self.raise_minimum(&version);
                }
            })
            .await;
    }

    pub async fn warm(&self) {
        if self.explicit.is_empty() {
            self.load_minimum().await;
            if let Some(live) = &self.live {
                live.warm().await;
            }
        }
    }

    fn raise_minimum(&self, version: &str) -> bool {
        let mut minimum = self.minimum.lock().unwrap_or_else(PoisonError::into_inner);
        if compare_semver(version, minimum.as_deref().unwrap_or(DEFAULT_CLI_VERSION)) != Ordering::Greater {
            return false;
        }
        *minimum = Some(version.to_owned());
        true
    }

    /// Recognizes only the provider's minimum-version rejection. An override is authoritative, even against a newer minimum.
    pub(super) async fn learn_required(&self, refusal: &str) -> bool {
        let Some(version) = REQUIREMENT.captures(refusal).and_then(|m| normalized_version(&m[1])) else {
            return false;
        };
        self.load_minimum().await;
        if self.raise_minimum(&version)
            && let Some(store) = &self.store
        {
            let path = store.path.clone();
            let persisted = store
                .io
                .write_job(move |lane| {
                    let opts = mixdog_statefile::Opts { lock: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
                    let update = |current: Option<Value>| -> Result<Option<Value>, Infallible> {
                        if let Some(held) = current.as_ref().and_then(stored_minimum)
                            && compare_semver(&held, &version) != Ordering::Less
                        {
                            return Ok(None);
                        }
                        Ok(Some(json!({ "version": 1, "cliVersion": version, "updatedAt": super::oauth::now_ms() })))
                    };
                    Ok(mixdog_statefile::update_json(lane, &path, update, &opts).ok().flatten().as_ref().and_then(stored_minimum))
                })
                .await;
            if let Ok(Some(winner)) = persisted {
                self.raise_minimum(&winner);
            }
        }
        self.explicit.is_empty()
    }
}
