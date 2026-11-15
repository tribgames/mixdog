//! The brief readings the tests run the document brief against: the authoring crate's own.

use mixdog_office_quality::document_brief::BriefReadings;
use serde_json::Value;

pub struct Authoring;

impl BriefReadings for Authoring {
    fn html_brief_script(&self, html: &str) -> String {
        mixdog_office_author::brief::html_brief_script(html)
    }
    fn parse_authoring_brief(&self, script: &str) -> Value {
        mixdog_office_author::brief::parse_authoring_brief(script)
    }
    fn review_fact_coverage(&self, document: &Value, brief: &Value) -> Vec<Value> {
        mixdog_office_author::brief::review_fact_coverage(document, brief)
    }
    fn review_source_grounding(&self, brief: &Value) -> Vec<Value> {
        mixdog_office_author::brief::review_source_grounding(brief)
    }
}
