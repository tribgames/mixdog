//! The slow-tool trace settings.

use mixdog_trace as t;

#[test]
fn slow_tool_settings_follow_the_environment() {
    let get = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_string())
    };
    let default = t::SlowTool::from_env(&get(&[]));
    assert_eq!(default.threshold_ms, 3000);
    assert_eq!(default.names, Some(vec!["recall".into(), "grep".into(), "code_graph".into()]));
    let all = t::SlowTool::from_env(&get(&[("MIXDOG_SLOW_TOOL_TRACE_MS", "10x"), ("MIXDOG_SLOW_TOOL_TRACE_NAMES", " * ")]));
    assert_eq!((all.threshold_ms, all.names), (10, None));
    let bad = t::SlowTool::from_env(&get(&[("MIXDOG_SLOW_TOOL_TRACE_MS", "-5")]));
    assert_eq!(bad.threshold_ms, 3000);
}
