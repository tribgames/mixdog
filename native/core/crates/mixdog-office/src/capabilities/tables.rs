//! The capability tables, loaded once from `data/capabilities.json` and `data/tool-defs.json`.
//!
//! Both files are exported from Node's capability modules by
//! `benchmarks/rust-core/recorders/record-office-capability-tables.mjs` with key order kept. The text in them is the
//! model-facing contract and stays byte for byte as Node wrote it, Korean examples included; nothing here rewrites it.

use std::sync::OnceLock;

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

const CAPABILITIES_JSON: &str = include_str!("../../data/capabilities.json");
const TOOL_DEFS_JSON: &str = include_str!("../../data/tool-defs.json");

const BACKEND_OFFICE: &str = "microsoft-office-com";
const BACKEND_OOXML: &str = "mixdog-ooxml";
const BACKEND_TABULAR: &str = "mixdog-tabular";
const BACKEND_PDF: &str = "mixdog-pdf";

/// The operations a format takes, split by who can run them: both backends, Microsoft Office only, the portable OOXML
/// engine only.
#[derive(Debug, Clone, Deserialize)]
pub struct OperationCatalog {
    pub common: Vec<String>,
    pub office: Vec<String>,
    pub portable: Vec<String>,
}

/// One format's catalogue: the stable paths, the operations and the property groups.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatCatalog {
    pub paths: Vec<String>,
    /// PPTX only: the note on slide and shape ids.
    #[serde(default)]
    pub stable_targets: Option<String>,
    pub operations: OperationCatalog,
    pub properties: IndexMap<String, Vec<String>>,
}

impl FormatCatalog {
    /// Every operation name once, in catalogue order: common, then Office-only, then portable-only.
    pub fn all_operations(&self) -> Vec<&str> {
        let mut seen: Vec<&str> = Vec::new();
        for name in self.operations.common.iter().chain(&self.operations.office).chain(&self.operations.portable) {
            if !seen.contains(&name.as_str()) {
                seen.push(name);
            }
        }
        seen
    }
}

/// An operation's input signature: the fields it requires, accepts, takes as alternatives, the property groups it
/// reads and the note the model sees.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub required: Vec<String>,
    pub optional: Vec<String>,
    pub one_of: Vec<Vec<String>>,
    pub property_sets: Vec<String>,
    pub property_backends: IndexMap<String, Vec<String>>,
    pub notes: String,
}

/// The XLSX data-validation vocabulary the signatures embed.
#[derive(Debug, Clone, Deserialize)]
pub struct XlsxValidation {
    pub operators: Vec<String>,
    pub types: Vec<String>,
}

/// One entry of the operation registry: the input signature and the backends that run the operation.
#[derive(Debug, Clone)]
pub struct Operation {
    pub input: Signature,
    pub supported_backends: Vec<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    actions: Vec<String>,
    common: Value,
    catalog: IndexMap<String, FormatCatalog>,
    backends: Vec<String>,
    virtual_operations: Vec<String>,
    common_signatures: IndexMap<String, Signature>,
    format_signatures: IndexMap<String, IndexMap<String, Signature>>,
    field_aliases: IndexMap<String, IndexMap<String, IndexMap<String, String>>>,
    property_aliases: IndexMap<String, String>,
    operation_aliases: IndexMap<String, IndexMap<String, String>>,
    xlsx_validation: XlsxValidation,
}

/// Every table Node's capability modules export, plus the operation registry built from them.
#[derive(Debug)]
pub struct Capabilities {
    /// `OFFICE_ACTIONS`.
    pub actions: Vec<String>,
    /// `COMMON`: the notes shared by every format (`actions` repeats `OFFICE_ACTIONS`).
    pub common: Value,
    /// `CATALOG`, by format name, in Node's key order.
    pub catalog: IndexMap<String, FormatCatalog>,
    /// `BACKENDS`.
    pub backends: Vec<String>,
    /// `VIRTUAL_OPERATIONS`: `compose_document`, `compose_sheet`, `use_template_page` and the per-format
    /// `docx:add_chart`.
    pub virtual_operations: Vec<String>,
    /// `COMMON_SIGNATURES`.
    pub common_signatures: IndexMap<String, Signature>,
    /// `FORMAT_SIGNATURES`, by format.
    pub format_signatures: IndexMap<String, IndexMap<String, Signature>>,
    /// `FIELD_ALIASES`: format, operation, then alias to field.
    pub field_aliases: IndexMap<String, IndexMap<String, IndexMap<String, String>>>,
    /// `PROPERTY_ALIASES`.
    pub property_aliases: IndexMap<String, String>,
    /// `OPERATION_ALIASES`: format, then alias to operation.
    pub operation_aliases: IndexMap<String, IndexMap<String, String>>,
    /// `XLSX_VALIDATION_OPERATORS` and `XLSX_VALIDATION_TYPES`.
    pub xlsx_validation: XlsxValidation,
    registry: IndexMap<String, IndexMap<String, Operation>>,
}

fn operation_backends(format: &str, catalog: &FormatCatalog, operation: &str) -> Vec<&'static str> {
    if format == "pdf" {
        return vec![BACKEND_PDF];
    }
    if format == "csv" || format == "tsv" {
        return vec![BACKEND_TABULAR];
    }
    let has = |names: &[String]| names.iter().any(|name| name == operation);
    let common = has(&catalog.operations.common);
    let mut backends = Vec::new();
    if common || has(&catalog.operations.office) {
        backends.push(BACKEND_OFFICE);
    }
    if common || has(&catalog.operations.portable) {
        backends.push(BACKEND_OOXML);
    }
    backends
}

impl Raw {
    fn explicit_signature(&self, format: &str, operation: &str) -> Option<&Signature> {
        let by_format = if format == "csv" || format == "tsv" { "xlsx" } else { format };
        self.format_signatures
            .get(by_format)
            .and_then(|signatures| signatures.get(operation))
            .or_else(|| self.common_signatures.get(operation))
    }

    /// The registry Node's `capabilities.mjs` builds at load; a catalogue operation with no signature is a fault of the
    /// data, which Node also refuses to start with.
    fn registry(&self) -> IndexMap<String, IndexMap<String, Operation>> {
        let mut registry = IndexMap::new();
        for (format, catalog) in &self.catalog {
            let mut operations = IndexMap::new();
            for name in catalog.all_operations() {
                let input = self
                    .explicit_signature(format, name)
                    .unwrap_or_else(|| panic!("Office operation registry is missing a signature for {format}.{name}"));
                operations.insert(
                    name.to_owned(),
                    Operation { input: input.clone(), supported_backends: operation_backends(format, catalog, name) },
                );
            }
            registry.insert(format.clone(), operations);
        }
        registry
    }
}

impl Capabilities {
    fn load() -> Self {
        let raw: Raw =
            serde_json::from_str(CAPABILITIES_JSON).expect("data/capabilities.json is the recorder's output");
        let registry = raw.registry();
        Self {
            actions: raw.actions,
            common: raw.common,
            catalog: raw.catalog,
            backends: raw.backends,
            virtual_operations: raw.virtual_operations,
            common_signatures: raw.common_signatures,
            format_signatures: raw.format_signatures,
            field_aliases: raw.field_aliases,
            property_aliases: raw.property_aliases,
            operation_aliases: raw.operation_aliases,
            xlsx_validation: raw.xlsx_validation,
            registry,
        }
    }

    /// The formats the tool takes, in catalogue order.
    pub fn formats(&self) -> impl Iterator<Item = &str> {
        self.catalog.keys().map(String::as_str)
    }

    pub fn format(&self, format: &str) -> Option<&FormatCatalog> {
        self.catalog.get(format)
    }

    /// The operations of a format in registry order (`catalogOperations`); empty for an unknown format.
    pub fn operations(&self, format: &str) -> Vec<&str> {
        self.registry.get(format).map(|operations| operations.keys().map(String::as_str).collect()).unwrap_or_default()
    }

    /// The registry entry of one operation of one format.
    pub fn operation(&self, format: &str, operation: &str) -> Option<&Operation> {
        self.registry.get(format)?.get(operation)
    }

    /// The operations a backend runs for a format, or every operation when no backend is named
    /// (`operationsForBackend`).
    pub fn operations_for_backend(&self, format: &str, backend: Option<&str>) -> Vec<&str> {
        let Some(operations) = self.registry.get(format) else { return Vec::new() };
        operations
            .iter()
            .filter(|(_, operation)| backend.is_none_or(|backend| operation.supported_backends.contains(&backend)))
            .map(|(name, _)| name.as_str())
            .collect()
    }

    /// The backends of an operation (`supportedBackends`); empty when it is unknown.
    pub fn supported_backends(&self, format: &str, operation: &str) -> Vec<&'static str> {
        self.operation(format, operation).map(|operation| operation.supported_backends.clone()).unwrap_or_default()
    }

    /// The input signature of an operation, or the empty signature of an unknown one (`operationSignature`).
    pub fn operation_signature(&self, format: &str, operation: &str) -> Signature {
        self.operation(format, operation).map(|operation| operation.input.clone()).unwrap_or_default()
    }

    /// An alias resolves to the operation it names when the format knows that one; a known name and an unknown alias
    /// stay as written (`resolveOperationAlias`).
    pub fn resolve_operation_alias<'a>(&'a self, format: &str, name: &'a str) -> &'a str {
        if self.operation(format, name).is_some() {
            return name;
        }
        match self.operation_aliases.get(format).and_then(|aliases| aliases.get(name)) {
            Some(target) if self.operation(format, target).is_some() => target,
            _ => name,
        }
    }

    /// The field aliases of one operation: the word a caller wrote, to the field it reaches.
    pub fn field_aliases(&self, format: &str, operation: &str) -> Option<&IndexMap<String, String>> {
        self.field_aliases.get(format)?.get(operation)
    }

    /// Whether the runtime turns the operation into others before a backend sees it: a bare name is virtual in every
    /// format, a `format:operation` entry in that format alone.
    pub fn is_virtual(&self, format: &str, operation: &str) -> bool {
        let scoped = format!("{format}:{operation}");
        self.virtual_operations.iter().any(|name| name == operation || *name == scoped)
    }
}

/// `TOOL_DEFS` and the routing sentence its description embeds.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefs {
    pub tool_defs: Vec<Value>,
    pub skill_routing: String,
}

/// The capability tables, loaded on first use.
pub fn capabilities() -> &'static Capabilities {
    static TABLES: OnceLock<Capabilities> = OnceLock::new();
    TABLES.get_or_init(Capabilities::load)
}

/// The text of `data/capabilities.json` exactly as exported.
pub fn capabilities_json() -> &'static str {
    CAPABILITIES_JSON
}

/// The tool definitions, loaded on first use.
pub fn tool_defs() -> &'static ToolDefs {
    static DEFS: OnceLock<ToolDefs> = OnceLock::new();
    DEFS.get_or_init(|| serde_json::from_str(TOOL_DEFS_JSON).expect("data/tool-defs.json is the recorder's output"))
}

/// The text of `data/tool-defs.json` exactly as exported.
pub fn tool_defs_json() -> &'static str {
    TOOL_DEFS_JSON
}

/// The `office` tool definition (`TOOL_DEFS[0]`).
pub fn office_tool_def() -> &'static Value {
    tool_defs().tool_defs.first().expect("TOOL_DEFS holds the office tool")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_every_catalogue_operation() {
        let tables = capabilities();
        assert_eq!(tables.formats().collect::<Vec<_>>(), ["docx", "xlsx", "pptx", "pdf", "csv", "tsv"]);
        assert!(tables.operations("docx").contains(&"append_text"));
        assert_eq!(tables.supported_backends("docx", "append_text").len(), 2);
        assert_eq!(tables.supported_backends("pdf", "add_text"), ["mixdog-pdf"]);
    }

    #[test]
    fn aliases_resolve_only_onto_known_operations() {
        let tables = capabilities();
        assert_eq!(tables.resolve_operation_alias("docx", "add_paragraph"), "append_text");
        assert_eq!(tables.resolve_operation_alias("docx", "append_text"), "append_text");
        assert_eq!(tables.resolve_operation_alias("docx", "no_such_op"), "no_such_op");
    }

    #[test]
    fn virtual_operations_are_scoped_by_format() {
        let tables = capabilities();
        assert!(tables.is_virtual("docx", "add_chart"));
        assert!(!tables.is_virtual("xlsx", "add_chart"));
        assert!(tables.is_virtual("xlsx", "compose_sheet"));
    }

    #[test]
    fn tool_definition_lists_the_actions() {
        let actions = office_tool_def()["inputSchema"]["properties"]["action"]["enum"].as_array().expect("enum");
        assert_eq!(actions.len(), capabilities().actions.len());
    }
}
