//! The office capability catalogue, operation signatures, aliases and tool definition.

mod tables;

pub use tables::{
    Capabilities, FormatCatalog, Operation, OperationCatalog, Signature, ToolDefs, XlsxValidation, capabilities,
    capabilities_json, office_tool_def, tool_defs, tool_defs_json,
};
