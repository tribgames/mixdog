// The rule bundles of `native/mixdog-graph/build.rs`, for the core's build of the library (see Cargo.toml).
#[path = "../../../mixdog-graph/build_rules.rs"]
mod build_rules;

fn main() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    build_rules::bundle_outline_rules(&manifest_dir.join("../../../mixdog-graph"));
}
