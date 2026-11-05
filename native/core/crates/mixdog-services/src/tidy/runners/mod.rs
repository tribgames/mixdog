//! Runner registry: engine id → runner. An engine in the catalog with no runner here is
//! resolved and reported (so `scan` stays honest) but never run.

pub mod biome;
pub mod dotnet_format;
pub mod psscriptanalyzer;
pub mod shared;
pub mod simple;

pub use shared::{Diagnostic, RunRequest, Runner, RunnerResult, Spawn, SystemSpawn};

use shared::ListFormatter;

pub fn runner_for(id: &str) -> Option<Box<dyn Runner>> {
    Some(match id {
        "biome" => Box::new(biome::Biome),
        "ruff" => Box::new(simple::Ruff),
        "clang-format" => Box::new(simple::ClangFormat),
        "shfmt" => Box::new(ListFormatter { id: "shfmt", list_args: &["-l"], write_args: &["-w"] }),
        "shellcheck" => Box::new(simple::Shellcheck),
        "stylua" => Box::new(simple::Stylua),
        "gofumpt" => Box::new(ListFormatter { id: "gofumpt", list_args: &["-l"], write_args: &["-w"] }),
        "dprint" => Box::new(simple::Dprint),
        "air" => Box::new(simple::Air),
        "mago" => Box::new(simple::Mago),
        "rustfmt" => Box::new(simple::Rustfmt),
        "gofmt" => Box::new(ListFormatter { id: "gofmt", list_args: &["-l"], write_args: &["-w"] }),
        "psscriptanalyzer" => Box::new(psscriptanalyzer::PsScriptAnalyzer),
        "dotnet-format" => Box::new(dotnet_format::DotnetFormat),
        "prettier" => Box::new(ListFormatter { id: "prettier", list_args: &["--list-different"], write_args: &["--write"] }),
        "eslint" => Box::new(simple::Eslint),
        _ => return None,
    })
}

#[cfg(test)]
mod twin_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_runnable_catalog_engine_has_a_runner_and_the_rest_are_report_only() {
        let without: Vec<&str> = crate::tidy::catalog::engines().iter().filter(|e| runner_for(&e.id).is_none()).map(|e| e.id.as_str()).collect();
        assert_eq!(without, ["zig", "dart", "swift-format", "mix"]);
        assert_eq!(runner_for("prettier").unwrap().id(), "prettier");
        assert!(runner_for("").is_none());
    }
}
