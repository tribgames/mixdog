//! Runner registry: engine id → runner. An engine in the catalog with no runner here is
//! resolved and reported (so `scan` stays honest) but never run.

pub mod biome;
pub mod dotnet_format;
pub mod formatters;
pub mod linters;
pub mod mago;
pub mod psscriptanalyzer;
pub mod ruff;
pub mod rustfmt;
pub mod shared;
pub mod stdin;
pub mod stdin_formatters;

pub use shared::{Diagnostic, RunRequest, Runner, RunnerResult, Spawn, SystemSpawn};

use shared::{ListFormatter, exited_zero};
use stdin_formatters::StdinFormatter;

use crate::tidy::process::ProcessResult;

/// shfmt exits 1 both for "listed a file" and for a file it could not parse; only the second
/// writes to stderr.
fn shfmt_listed(r: &ProcessResult) -> bool {
    r.code == 0 || (r.code == 1 && mixdog_js::js_trim(&r.stderr).is_empty())
}

/// Prettier exits 1 for "listed a file" and 2 when it could not format one.
fn prettier_listed(r: &ProcessResult) -> bool {
    r.code == 0 || r.code == 1
}

pub fn runner_for(id: &str) -> Option<Box<dyn Runner>> {
    Some(match id {
        "biome" => Box::new(biome::Biome),
        "ruff" => Box::new(ruff::Ruff),
        "clang-format" => Box::new(formatters::ClangFormat),
        "shfmt" => Box::new(ListFormatter { id: "shfmt", list_args: &["-l"], write_args: &["-w"], listed: shfmt_listed }),
        "shellcheck" => Box::new(linters::Shellcheck),
        "stylua" => Box::new(formatters::Stylua),
        // gofmt and gofumpt list with exit 0 and keep 2 for a file they could not parse.
        "gofumpt" => Box::new(ListFormatter { id: "gofumpt", list_args: &["-l"], write_args: &["-w"], listed: exited_zero }),
        "dprint" => Box::new(formatters::Dprint),
        "air" => Box::new(formatters::Air),
        "mago" => Box::new(mago::Mago),
        "rustfmt" => Box::new(rustfmt::Rustfmt),
        "gofmt" => Box::new(ListFormatter { id: "gofmt", list_args: &["-l"], write_args: &["-w"], listed: exited_zero }),
        "psscriptanalyzer" => Box::new(psscriptanalyzer::PsScriptAnalyzer),
        "dotnet-format" => Box::new(dotnet_format::DotnetFormat),
        "prettier" => Box::new(ListFormatter { id: "prettier", list_args: &["--list-different"], write_args: &["--write"], listed: prettier_listed }),
        "eslint" => Box::new(linters::Eslint),
        "google-java-format" => Box::new(StdinFormatter { id: "google-java-format", call: stdin_formatters::google_java_format }),
        "ktfmt" => Box::new(StdinFormatter { id: "ktfmt", call: stdin_formatters::ktfmt }),
        "taplo" => Box::new(formatters::Taplo),
        "zig" => Box::new(StdinFormatter { id: "zig", call: stdin_formatters::zig }),
        "dart" => Box::new(formatters::Dart),
        // `mix format` has no runner: it evaluates the project's `.formatter.exs`, whose output
        // shares stdout with the formatted text, and given a path it formats files the project's
        // `inputs` leave out.
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_runnable_catalog_engine_has_a_runner_and_the_rest_are_report_only() {
        let without: Vec<&str> = crate::tidy::catalog::engines().iter().filter(|e| runner_for(&e.id).is_none()).map(|e| e.id.as_str()).collect();
        assert_eq!(without, ["swift-format", "mix"]);
        assert_eq!(runner_for("prettier").unwrap().id(), "prettier");
        assert!(runner_for("").is_none());
    }
}
