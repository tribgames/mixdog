//! The two tests of `document-brief.test.mjs`: a brief with or without a concept is accepted for every format, and the
//! source-grounding check is not waived by it. The readings are the authoring crate's (the brief parser lives there).

use crate::common::Authoring;
use mixdog_office_quality::document_brief::{document_brief, document_brief_issues};
use serde_json::json;

#[test]
fn document_briefs_accept_custom_or_absent_concepts_without_prescribing_a_style() {
    let plain = document_brief(&Authoring, "facts: F1 38 — log").expect("plain brief");
    let named = document_brief(&Authoring, "concept: ledger — the figures lead\nfacts: F1 38 — log").expect("named brief");
    assert_eq!(plain["concept"], "");
    assert_eq!(named["concept"], "ledger — the figures lead");
    for format in ["docx", "xlsx", "pdf"] {
        let document = json!({
            "paragraphs": [{ "text": "38" }],
            "tables": [],
            "sheets": [{ "name": "Report", "cells": [{ "value": "38" }] }],
        });
        assert!(document_brief_issues(&Authoring, format, &document, Some(&plain)).is_empty(), "{format}");
        assert!(document_brief_issues(&Authoring, format, &document, Some(&named)).is_empty(), "{format}");
    }
    assert!(document_brief_issues(&Authoring, "docx", &json!({}), None).is_empty());
    assert!(document_brief(&Authoring, "   ").is_none());
}

#[test]
fn optional_design_choices_do_not_waive_source_grounding_checks() {
    let brief = document_brief(&Authoring, "facts: F1 38 — log").expect("brief");
    for format in ["docx", "xlsx"] {
        let document = json!({
            "paragraphs": [{ "text": "999건" }],
            "sheets": [{ "name": "Report", "cells": [{ "value": "999건" }] }],
        });
        let issues = document_brief_issues(&Authoring, format, &document, Some(&brief));
        assert!(issues.iter().any(|entry| entry["code"] == "number_without_fact"), "{format}");
    }
}
