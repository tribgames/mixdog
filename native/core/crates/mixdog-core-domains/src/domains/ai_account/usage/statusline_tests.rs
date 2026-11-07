//! Which routes a route change refreshes the statusline usage reading for, against Node's
//! `refreshStatuslineUsageSnapshot` (`record-statusline-usage.mjs`).

use std::cell::RefCell;

use mixdog_core_ports::ports::route::Route;
use serde_json::Value;

use super::statusline_target;

const GOLDEN: &str = include_str!("../../../../../../fixtures/statusline-usage/golden.json");

#[test]
fn the_routes_that_refresh_are_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let all: Vec<&str> = golden["registered"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let route: Route = case["route"].as_object().cloned().unwrap_or_default();
        let registered = case["registered"] == true;
        let asked = RefCell::new(Vec::new());
        let got = statusline_target(&route, &|name| {
            asked.borrow_mut().push(name.to_owned());
            registered && all.contains(&name)
        });
        let want_asked: Vec<String> = case["asked"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_owned()).collect();
        assert_eq!(*asked.borrow(), want_asked, "{}: registry lookups", case["route"]);
        let want = case["calls"].as_array().unwrap().first().map(|call| (call["route"]["provider"].as_str().unwrap().to_owned(), call["route"]["model"].as_str().unwrap().to_owned()));
        assert_eq!(got, want, "{} registered={registered}", case["route"]);
    }
}