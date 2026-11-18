use mixdog_office_design::library::core::{
    canonical_office_design_pack, compare_office_design_versions, is_format, safe_id_text, template_format,
};
use serde_json::json;

#[test]
fn an_id_is_trimmed_and_lowercased_and_must_start_with_a_letter_or_digit() {
    assert_eq!(safe_id_text("  Report_2.v1-A ", "pack id"), Ok("report_2.v1-a".to_owned()));
    let refusal = "Office design pack id must use 1-64 lowercase letters, digits, dots, underscores, or hyphens".to_owned();
    for bad in ["", "-leading", ".dot", "has space", "slash/inside", "한글"] {
        assert_eq!(safe_id_text(bad, "pack id"), Err(refusal.clone()), "{bad:?}");
    }
    assert!(safe_id_text(&"a".repeat(64), "x").is_ok());
    assert!(safe_id_text(&"a".repeat(65), "x").is_err());
}

#[test]
fn versions_order_by_number_and_a_prerelease_sorts_before_its_release() {
    assert_eq!(compare_office_design_versions("1.2.3", "1.2.3"), Ok(0));
    assert_eq!(compare_office_design_versions("1.10.0", "1.9.9"), Ok(1), "numbers, not text");
    assert_eq!(compare_office_design_versions("v1.0.0", "1.0.1"), Ok(-1), "a leading v is allowed");
    assert_eq!(compare_office_design_versions("2.0.0-rc.1", "2.0.0"), Ok(-1));
    assert_eq!(compare_office_design_versions("2.0.0", "2.0.0-rc.1"), Ok(1));
    assert_eq!(compare_office_design_versions("2.0.0-beta", "2.0.0-alpha"), Ok(1));
    assert_eq!(
        compare_office_design_versions("1.2", "1.2.3"),
        Err("Office design pack versions must be semantic versions: 1.2, 1.2.3".to_owned())
    );
    assert!(compare_office_design_versions("1.2.3-", "1.2.3").is_err());
}

#[test]
fn a_canonical_pack_sorts_every_objects_keys_and_keeps_list_order() {
    let pack = json!({ "b": 1, "a": { "z": [3, 1, 2], "y": null }, "c": "x" });
    assert_eq!(canonical_office_design_pack(&pack), r#"{"a":{"y":null,"z":[3,1,2]},"b":1,"c":"x"}"#);
    let reordered = json!({ "c": "x", "a": { "y": null, "z": [3, 1, 2] }, "b": 1 });
    assert_eq!(canonical_office_design_pack(&reordered), canonical_office_design_pack(&pack));
}

#[test]
fn template_extensions_map_to_their_format_and_other_extensions_have_none() {
    assert_eq!(template_format(".dotx"), Some("docx"));
    assert_eq!(template_format(".docm"), Some("docx"));
    assert_eq!(template_format(".txt"), None);
    assert!(is_format("pptx"));
    assert!(!is_format("odt"));
}
