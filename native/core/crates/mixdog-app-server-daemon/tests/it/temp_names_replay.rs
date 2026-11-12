//! Node's recording `fixtures/atomic-file-temp-name-cases` (`record-atomic-file-temp-name-cases.mjs`, b6f10295a), case "every
//! stale-temp sweep still recognises the temp name the writer produces": the names Node's atomic writer created beside each target
//! (the code-graph cache and manifest, a crash capture, the session-summary index), `<target>.mixdog-tmp-<16 hex>` with the random
//! suffix written `<hex16>` in the recording. Whatever the previous version left of them, the core's startup recognises as the
//! temp of its target (the migration's stale-temp classifier), so a stale one is reclaimed and a user's file is not.

use mixdog_migrate::temp_files::atomic_publish_base;
use serde_json::Value;

#[test]
fn every_temp_name_node_wrote_is_recognised_as_the_temp_of_its_target() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/atomic-file-temp-name-cases/golden.json")).expect("golden.json");
    let observed = &golden["cases"][0]["observed"];
    let targets: Vec<&str> = observed["written"].as_array().expect("written").iter().map(|t| t.as_str().expect("a target")).collect();
    let names = observed["names"].as_object().expect("names");
    assert_eq!(names.len(), targets.len(), "one temp name per written target");
    for ((kind, recorded), target) in names.iter().zip(&targets) {
        let recorded = recorded.as_array().expect("names of one write");
        assert_eq!(recorded.len(), 1, "{kind}: the writer creates one temp file");
        // The recording writes the writer's random suffix as `<hex16>`: any 16 lowercase hex digits stand for it.
        let name = recorded[0].as_str().expect("a name").replace("<hex16>", "0123456789abcdef");
        assert_eq!(atomic_publish_base(&name), Some(*target), "{kind}: {name}");
    }
}
