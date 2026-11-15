//! The office engine of the process that runs the shipped pptx skill scripts (`mixdogd skill-run`): the scripts read a deck, a
//! document or a workbook through one office tool call and measure a saved deck, as `source-extract.mjs` and `qc-pages.mjs` did
//! through `executeOfficeTool`, `issuesPortableOoxml` and `snapshotPortableOoxml`.
//!
//! The engine is the same one `office.run` serves, over the same platform (lanes, fonts, Office transport, validator). A skill-run
//! process has no extension-host call to ask a browser of, so a call that needs one answers what the engine answers without one.
//! The scripts are synchronous: the engine runs on a runtime of its own.

use std::path::Path;

use mixdog_fsio::Unlaned;
use mixdog_office_quality::structure::review_office_structure;
use mixdog_ooxml::snapshot::snapshot_portable_ooxml;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::validation::issues_portable_ooxml;
use mixdog_rt::CancellationToken;
use mixdog_skill_scripts::source_extract::Measured;
use mixdog_skill_scripts::source_extract::OfficeEngine;
use serde_json::Value;
use serde_json::json;
use tokio::runtime::Runtime;

use super::office_run::office;
use super::pdf_render::fonts;
use super::pdf_render::lanes;

/// The office engine of this process, for the scripts of a skill.
pub struct SkillOfficeEngine {
    runtime: Runtime,
}

impl SkillOfficeEngine {
    /// An engine running on a runtime of its own.
    pub fn new() -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|error| error.to_string())?;
        Ok(Self { runtime })
    }
}

/// What `executeOfficeTool` answered, as the script took it: the parsed text of the result, or the text of an error result.
fn answer(result: &Value) -> Result<Value, String> {
    let body = result.get("content").and_then(|content| content.get(0)).and_then(|part| part.get("text")).and_then(Value::as_str).unwrap_or_default();
    if result.get("isError").and_then(Value::as_bool).unwrap_or(false) {
        return Err(if body.is_empty() { "office call failed".to_owned() } else { body.to_owned() });
    }
    serde_json::from_str(body).map_err(|error| error.to_string())
}

impl OfficeEngine for SkillOfficeEngine {
    fn call(&self, args: &Value, cwd: &Path) -> Result<Value, String> {
        let cancel = CancellationToken::new();
        let result = self.runtime.block_on(async {
            let office = office(&cancel).await.map_err(|error| error.message)?;
            Ok::<_, String>(office.engine.execute(args.clone(), cwd.to_path_buf(), None, None, cancel.clone()).await.0)
        })?;
        answer(&result)
    }

    fn measure(&self, deck: &Path) -> Result<Measured, String> {
        let cancel = CancellationToken::new();
        let registry = self.runtime.block_on(async {
            let lanes = lanes().map_err(|error| error.message)?;
            fonts(lanes, &cancel).await.map_err(|error| error.message)
        })?;
        let lane = &Unlaned;
        let measurer = TextMeasurer::new(lane, &registry);
        let structure = |document: &Value| review_office_structure(Some("pptx"), document, "");
        let found = issues_portable_ooxml(lane, &measurer, &structure, deck, "pptx", &json!({}))?;
        let document = snapshot_portable_ooxml(lane, &measurer, deck, "pptx", &json!({}))?;
        Ok(Measured { issues: found.get("issues").and_then(Value::as_array).cloned().unwrap_or_default(), document })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_result_answers_its_text_and_a_result_its_parsed_body() {
        let error = json!({"content": [{"type": "text", "text": "Error: no"}], "isError": true});
        assert_eq!(answer(&error), Err("Error: no".to_owned()));
        let empty = json!({"content": [], "isError": true});
        assert_eq!(answer(&empty), Err("office call failed".to_owned()));
        let ok = json!({"content": [{"type": "text", "text": "{\"session\":\"s1\"}"}]});
        assert_eq!(answer(&ok), Ok(json!({"session": "s1"})));
    }
}
