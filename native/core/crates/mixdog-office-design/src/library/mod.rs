//! The design library, ported from `src/runtime/office/design/library/design-library-core.mjs`,
//! `design-library-pack.mjs` and `design-library.mjs`: signed design packs fetched over HTTPS and cached under the data
//! directory, the template index file, per-document bindings, the composition history and the resolution of a design
//! request against them.
//!
//! - [`core`]: schema, limits, folder layout, configuration (a config file and five environment variables), version
//!   order, atomic JSON write.
//! - [`pack`]: the reading of a pack, its Ed25519 signature check, the network ([`pack::Fetch`]), the cache.
//! - [`store`]: state, sync, bindings, history, resolution and inspection.
//!
//! The template index writer (`indexOfficeTemplates`, `design-template-index.mjs`) belongs to the templates module and is
//! reached through [`store::TemplateIndexer`]; [`store::read_template_index`] and [`store::write_state`] are the shared
//! readers and writers of the index and state files.

pub mod core;
pub mod pack;
pub mod store;

pub use self::core::{
    ALLOWED_LAYOUT_DEFAULTS, Environment, FORMATS, LAYOUT_SLOT_TYPES, LibraryConfig, LibraryPaths, MAX_COMPOSITION_HISTORY, MAX_LOCAL_TEMPLATE_COUNT,
    MAX_MANIFEST_BYTES, MAX_SCAN_DEPTH, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_COUNT, SCHEMA_VERSION, TEMPLATE_FORMATS, TEMPLATE_INSPECTOR_VERSION, canonical_office_design_pack,
    canonical_path, compare_office_design_versions, default_office_template_directories, is_format, library_paths, load_config, parse_version, read_json, safe_id,
    safe_id_text, sha256_file, template_format, write_json_atomic,
};
pub use self::pack::{
    Fetch, FetchRequest, FetchResponse, HttpsFetch, Verified, load_cached_pack, materialize_pack, normalize_layouts, normalize_local_samples, pack_summary,
    response_bytes, verify_office_design_pack_envelope,
};
pub use self::store::{
    CompositionRecord, Context, ResolveRequest, SyncOptions, SyncResult, TemplateIndexer, inspect_office_design_library, iso_string, persist_office_design_binding,
    read_office_composition_history, read_template_index, record_office_composition_history, resolve_office_design_library, sync_office_design_library, write_state,
};
