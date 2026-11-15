//! The template side of the design library, ported from `src/runtime/office/design/library/design-template-*.mjs`:
//!
//! - [`inspect`]: the regex reading of a template's XML (shape blocks, placeholders, `{{TOKEN}}` slots, native layouts,
//!   theme), the directory walk, the slide selection into a new package and the coverage summary.
//! - [`induct`]: the roles of a drawn deck induced from geometry, and the annotation of a deck snapshot with them.
//! - [`index`]: the template index cached by file, sidecar and inspector version ([`OfficeTemplateIndexer`] is the
//!   [`crate::library::TemplateIndexer`] of the design library).
//! - [`fill`]: the choice of a template page by role and capacity, its fill by slot, and the expansion of
//!   `use_template_page` operations.
//!
//! The two packaged templates sit in `assets/templates` (copied byte for byte with their sidecar).

pub mod fill;
pub mod index;
pub mod induct;
pub mod inspect;

pub use self::fill::{Group, TemplateFill, expand_template_page_operations, select_template_page, template_page_fill};
pub use self::index::{OfficeTemplateIndexer, index_office_templates, inspect_office_template};
pub use self::induct::{Roles, annotate_pptx_snapshot_roles, induce_pptx_sample_roles, role_key};
pub use self::inspect::{
    ShapeBlock, SlideEntry, create_pptx_slide_selection, direct_pptx_shape_blocks, infer_pptx_sample_kind, number_from_path, office_template_coverage, pptx_sample_capacity, pptx_shape_metadata,
    pptx_slide_entries, pptx_slot, walk_template_directory, xml_attribute,
};

/// `JSZip.loadAsync(bytes)`: jszip words a file that does not begin as a zip with a pointer to its documentation.
pub(crate) fn load_zip(bytes: &[u8]) -> Result<mixdog_ooxml::zipio::Package, String> {
    mixdog_ooxml::zipio::Package::load_unchecked(bytes).map_err(|message| {
        if message == "Can't find end of central directory" {
            format!("{message} : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html")
        } else {
            message
        }
    })
}
