//! The engine catalog: what tidy knows how to resolve and run. The data is the 1.4.5 catalog
//! (`engines.mjs`) serialized; runner behaviour lives in the runners.
//!
//! `toolchain` engines (rustfmt, gofmt, zig fmt, ...) are PATH-detected only and never
//! downloaded; a missing one reports its install hint. `managed` engines can be installed from the
//! engines manifest into `<data>/tools/<id>/<version>/`. `project_local` names the project roots
//! that may provide the binary: `node` → `node_modules/.bin`, `venv` → `.venv|venv/{bin,Scripts}`.

use std::sync::OnceLock;

use serde::Deserialize;

const DATA: &str = include_str!("../../data/tidy-engines.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TomlConfig {
    pub file: String,
    pub section: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEntry {
    pub id: String,
    pub title: String,
    pub bin: String,
    pub alt_bins: Vec<String>,
    pub kind: Vec<String>,
    pub languages: Vec<String>,
    pub managed: bool,
    pub managed_module: bool,
    pub toolchain: bool,
    pub project_local: Vec<String>,
    pub project_local_only: bool,
    pub config_files: Vec<String>,
    pub toml_config: Option<TomlConfig>,
    pub requires_config: bool,
    pub suppressed_by: Vec<String>,
    pub version_args: Option<Vec<String>>,
    /// argv prefix for engines reached through a subcommand (`dotnet format`).
    pub command: Option<Vec<String>>,
    pub install_hint: String,
    pub host_install_hint: String,
}

pub fn engines() -> &'static [EngineEntry] {
    static ENGINES: OnceLock<Vec<EngineEntry>> = OnceLock::new();
    ENGINES.get_or_init(|| serde_json::from_str(DATA).expect("the bundled engine catalog is valid"))
}

pub fn engine_entry(id: &str) -> Option<&'static EngineEntry> {
    engines().iter().find(|e| e.id == id)
}

/// Engines that can touch at least one of `languages`; all of them when none are named.
/// Structural rules are not in this catalog: mixdog-graph runs them.
pub fn engines_for_languages(languages: &[String]) -> Vec<&'static EngineEntry> {
    engines().iter().filter(|e| languages.is_empty() || e.languages.iter().any(|l| languages.contains(l))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_has_every_engine_and_language_routing() {
        assert_eq!(engines().len(), 20);
        assert_eq!(engine_entry("biome").unwrap().suppressed_by, ["prettier", "eslint"]);
        assert!(engine_entry("prettier").unwrap().project_local_only);
        assert_eq!(engine_entry("dotnet-format").unwrap().command.as_deref().unwrap(), ["dotnet", "format"]);
        assert!(engine_entry("psscriptanalyzer").unwrap().version_args.is_some());
        assert!(engine_entry("dprint").unwrap().requires_config);
        let python: Vec<&str> = engines_for_languages(&["python".into()]).iter().map(|e| e.id.as_str()).collect();
        assert_eq!(python, ["ruff"]);
        assert_eq!(engines_for_languages(&[]).len(), 20);
    }
}
