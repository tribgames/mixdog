//! Twin test `capability_tables`: the recording of Node's office capability modules
//! (`native/core/fixtures/office-capability-tables/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-capability-tables.mjs`, which also writes `data/*.json`) against the
//! checked-in data and the typed lookups. Re-recording is running that recorder against a product tree.

use std::fmt::Write as _;

use mixdog_office::capabilities::{capabilities, capabilities_json, office_tool_def, tool_defs, tool_defs_json};
use serde_json::Value;
use sha2::{Digest, Sha256};

const GOLDEN: &str = include_str!("../../../fixtures/office-capability-tables/golden.json");
const FRONT_END_OFFICE_DEF: &str = include_str!("../../mixdog-tools/src/orch/defs/office.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden.json parses")
}

fn sha256(text: &str) -> String {
    let mut hex = String::new();
    for byte in Sha256::digest(text.as_bytes()) {
        write!(hex, "{byte:02x}").expect("write to a String");
    }
    hex
}

fn strings(value: &Value) -> Vec<&str> {
    value.as_array().expect("array").iter().map(|item| item.as_str().expect("string")).collect()
}

/// The paths at which two JSON values differ (object key order is not compared).
fn differences(path: &str, left: &Value, right: &Value, out: &mut Vec<String>) {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => differences(&format!("{path}/{key}"), value, other, out),
                    None => out.push(format!("{path}/{key}: only in the data file")),
                }
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                out.push(format!("{path}/{key}: only in the front end's copy"));
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}/{index}"), x, y, out);
            }
        }
        _ if left == right => {}
        _ => out.push(format!("{path}: {left} != {right}")),
    }
}

#[test]
fn data_files_are_the_recorded_export_byte_for_byte() {
    let golden = golden();
    assert_eq!(golden["capabilitiesSha256"], sha256(capabilities_json()));
    assert_eq!(golden["toolDefsSha256"], sha256(tool_defs_json()));
}

#[test]
fn every_format_and_operation_matches_the_registry_node_builds() {
    let golden = golden();
    let tables = capabilities();
    assert_eq!(tables.formats().collect::<Vec<_>>(), strings(&golden["formats"]));
    for (format, operations) in golden["registry"].as_object().expect("registry") {
        let expected: Vec<&str> = operations.as_object().expect("operations").keys().map(String::as_str).collect();
        assert_eq!(tables.operations(format), expected, "operations of {format}");
        for (name, entry) in operations.as_object().expect("operations") {
            let operation = tables.operation(format, name).unwrap_or_else(|| panic!("{format}.{name} is missing"));
            let input = &entry["input"];
            let signature = tables.operation_signature(format, name);
            assert_eq!(signature.required, strings(&input["required"]), "{format}.{name} required");
            assert_eq!(signature.optional, strings(&input["optional"]), "{format}.{name} optional");
            assert_eq!(signature.notes, input["notes"].as_str().expect("notes"), "{format}.{name} notes");
            assert_eq!(signature.property_sets, strings(&input["propertySets"]), "{format}.{name} propertySets");
            let one_of: Vec<Vec<&str>> = input["oneOf"].as_array().expect("oneOf").iter().map(strings).collect();
            assert_eq!(signature.one_of, one_of, "{format}.{name} oneOf");
            let backends: Vec<(&str, Vec<&str>)> = input["propertyBackends"]
                .as_object()
                .expect("propertyBackends")
                .iter()
                .map(|(field, names)| (field.as_str(), strings(names)))
                .collect();
            let actual: Vec<(&str, Vec<&str>)> = signature
                .property_backends
                .iter()
                .map(|(field, names)| (field.as_str(), names.iter().map(String::as_str).collect()))
                .collect();
            assert_eq!(actual, backends, "{format}.{name} propertyBackends");
            assert_eq!(operation.supported_backends, strings(&entry["supportedBackends"]), "{format}.{name} backends");
        }
    }
}

#[test]
fn operations_by_backend_match_for_every_format() {
    let golden = golden();
    let tables = capabilities();
    for (format, by_backend) in golden["operationsByBackend"].as_object().expect("operationsByBackend") {
        assert_eq!(tables.backends.len(), by_backend.as_object().expect("backends").len());
        for (backend, operations) in by_backend.as_object().expect("backends") {
            assert_eq!(
                tables.operations_for_backend(format, Some(backend)),
                strings(operations),
                "{format} operations of {backend}"
            );
        }
        assert_eq!(tables.operations_for_backend(format, None), tables.operations(format));
    }
}

#[test]
fn the_exported_tables_hold_what_the_lookups_serve() {
    let exported: Value = serde_json::from_str(capabilities_json()).expect("capabilities.json parses");
    let tables = capabilities();
    assert_eq!(tables.actions, strings(&exported["actions"]));
    assert_eq!(tables.common, exported["common"]);
    assert_eq!(tables.backends, strings(&exported["backends"]));
    assert_eq!(tables.virtual_operations, strings(&exported["virtualOperations"]));
    assert_eq!(tables.xlsx_validation.operators, strings(&exported["xlsxValidation"]["operators"]));
    assert_eq!(tables.xlsx_validation.types, strings(&exported["xlsxValidation"]["types"]));
    for (format, aliases) in exported["operationAliases"].as_object().expect("operationAliases") {
        for (alias, target) in aliases.as_object().expect("aliases") {
            let target = target.as_str().expect("target");
            let known = tables.operation(format, target).is_some();
            assert_eq!(tables.resolve_operation_alias(format, alias), if known { target } else { alias.as_str() });
        }
    }
    for (format, operations) in exported["fieldAliases"].as_object().expect("fieldAliases") {
        for (operation, aliases) in operations.as_object().expect("operations") {
            let served = tables.field_aliases(format, operation).expect("field aliases");
            let served: Vec<(&str, &str)> = served.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let expected: Vec<(&str, &str)> =
                aliases.as_object().expect("aliases").iter().map(|(k, v)| (k.as_str(), v.as_str().expect("field"))).collect();
            assert_eq!(served, expected, "{format}.{operation} field aliases");
        }
    }
    assert_eq!(tables.property_aliases.len(), exported["propertyAliases"].as_object().expect("object").len());
    for format in tables.formats() {
        let catalog = tables.format(format).expect("format");
        assert_eq!(catalog.paths, strings(&exported["catalog"][format]["paths"]));
    }
}

#[test]
fn tool_definition_equals_the_front_ends_copy() {
    let front_end: Value = serde_json::from_str(FRONT_END_OFFICE_DEF).expect("office.json parses");
    let mut found = Vec::new();
    differences("", office_tool_def(), &front_end, &mut found);
    assert!(
        found.is_empty(),
        "native/core/crates/mixdog-tools/src/orch/defs/office.json differs from data/tool-defs.json; replace it from the data file:\n{}",
        found.join("\n")
    );
    assert_eq!(tool_defs().tool_defs.len(), 1);
    assert!(office_tool_def()["description"].as_str().expect("description").contains(&tool_defs().skill_routing));
}
