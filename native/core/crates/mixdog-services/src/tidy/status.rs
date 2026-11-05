//! The Code Tidy card's inventory: every catalog engine with where it resolves from, plus the
//! live install job. A polled read: it never downloads and never spawns.

use async_trait::async_trait;
use serde_json::{Value, json};

use super::catalog::engines;
use super::install_job::{InstallJob, TIDY_CORE_ENGINE_IDS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolvedSource {
    Managed,
    Host,
    Missing,
}

#[derive(Clone, Debug)]
pub struct ResolvedEngine {
    pub id: String,
    pub source: ResolvedSource,
    pub version: String,
    pub install_hint: Option<String>,
    /// A host-module engine (PSScriptAnalyzer) whose first probe has not answered yet.
    pub probing: bool,
    /// A missing core engine the Install/Retry control can fetch right now.
    pub installable: bool,
    /// On-disk size of a managed engine.
    pub bytes: u64,
}

/// Resolution against the manifest, PATH and the managed tools dir, with no project scope.
#[async_trait]
pub trait EngineResolver: Send + Sync {
    fn tools_dir(&self) -> String;
    async fn resolve_all(&self) -> Vec<ResolvedEngine>;
}

pub async fn tidy_engine_status(resolver: &dyn EngineResolver, install: &InstallJob) -> Value {
    let resolved = resolver.resolve_all().await;
    let engines: Vec<Value> = engines()
        .iter()
        .map(|catalog| {
            let found = resolved.iter().find(|r| r.id == catalog.id);
            let source = found.map_or(ResolvedSource::Missing, |r| r.source);
            let hint = found.and_then(|r| r.install_hint.clone()).filter(|h| !h.is_empty()).unwrap_or_else(|| catalog.install_hint.clone());
            let probing = found.is_some_and(|r| r.probing);
            let mut row = json!({
                "id": catalog.id, "title": catalog.title, "languages": catalog.languages, "kind": catalog.kind,
                "version": found.map_or("", |r| r.version.as_str()),
                "source": match source { ResolvedSource::Managed => "managed", ResolvedSource::Host => "host", ResolvedSource::Missing => "missing" },
                "managed": catalog.managed, "core": TIDY_CORE_ENGINE_IDS.contains(&catalog.id.as_str()), "toolchain": catalog.toolchain,
            });
            if source == ResolvedSource::Managed {
                row["bytes"] = json!(found.map_or(0, |r| r.bytes));
            }
            if source == ResolvedSource::Missing && !hint.is_empty() {
                row["installHint"] = json!(hint);
            }
            if probing {
                row["probing"] = json!(true);
            }
            if source == ResolvedSource::Missing && !probing && found.is_some_and(|r| r.installable) {
                row["installable"] = json!(true);
            }
            row
        })
        .collect();
    json!({
        "toolsDir": resolver.tools_dir(),
        "core": TIDY_CORE_ENGINE_IDS,
        "probing": engines.iter().any(|e| e.get("probing").is_some()),
        "engines": engines,
        "installing": install.status(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Vec<ResolvedEngine>);

    #[async_trait]
    impl EngineResolver for Fixed {
        fn tools_dir(&self) -> String {
            "/tools".into()
        }
        async fn resolve_all(&self) -> Vec<ResolvedEngine> {
            self.0.clone()
        }
    }

    fn engine(id: &str, source: ResolvedSource) -> ResolvedEngine {
        ResolvedEngine { id: id.into(), source, version: "1.0".into(), install_hint: None, probing: false, installable: false, bytes: 7 }
    }

    #[tokio::test]
    async fn every_catalog_engine_is_listed_with_its_source() {
        let mut ruff = engine("ruff", ResolvedSource::Missing);
        ruff.installable = true;
        let status = tidy_engine_status(&Fixed(vec![engine("biome", ResolvedSource::Managed), ruff]), &InstallJob::default()).await;
        let rows = status["engines"].as_array().unwrap();
        assert_eq!(rows.len(), engines().len());
        let row = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap().clone();
        assert_eq!((row("biome")["source"].clone(), row("biome")["bytes"].clone(), row("biome")["core"].clone()), (json!("managed"), json!(7), json!(true)));
        assert_eq!(row("ruff")["installable"], true);
        assert!(row("ruff")["installHint"].as_str().unwrap().contains("pip install ruff"));
        // Unresolved engines are missing; a toolchain engine is never installable.
        assert_eq!(row("rustfmt")["source"], "missing");
        assert!(row("rustfmt").get("installable").is_none());
        assert_eq!(status["installing"], Value::Null);
        assert_eq!(status["probing"], false);
    }

    #[tokio::test]
    async fn a_probing_engine_is_pending_not_missing_installable() {
        let mut ps = engine("psscriptanalyzer", ResolvedSource::Missing);
        ps.probing = true;
        ps.installable = true;
        let status = tidy_engine_status(&Fixed(vec![ps]), &InstallJob::default()).await;
        let row = status["engines"].as_array().unwrap().iter().find(|r| r["id"] == "psscriptanalyzer").unwrap().clone();
        assert_eq!(row["probing"], true);
        assert!(row.get("installable").is_none());
        assert_eq!(status["probing"], true);
    }
}
