//! Decided departures from Node's recordings (`fixtures/tools-fs-search/departures.json`).
//!
//! A recording stays exactly what Node answered. A case whose expectation changed on purpose is listed in the departures
//! file with its reason, and the replay harnesses ask this module for the expectation of a case: its recorded text with the
//! listed replacements, or (for an answer Node capped by bytes) the invariants a capped answer must keep. A recorded answer
//! that differs without an entry fails the replay; an entry whose recorded text is not in the recording fails
//! [`every_departure_names_text_that_is_in_its_recording`].
use std::sync::LazyLock;

use serde_json::Value;

static DEPARTURES: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-fs-search/departures.json")).expect("departures.json parses"));

fn entry(scenario: &str, case: &str) -> Option<&'static Value> {
    DEPARTURES["departures"].as_array().expect("a list of departures").iter().find(|d| d["scenario"] == scenario && d["case"] == case)
}

/// The expectation for `case` of `scenario` given Node's `recorded` text, and whether the case is a capped answer to be
/// checked by [`capped_invariants`] instead of by text.
pub(crate) fn apply(scenario: &str, case: &str, recorded: String) -> (String, bool) {
    let Some(entry) = entry(scenario, case) else { return (recorded, false) };
    assert!(entry["reason"].as_str().is_some_and(|r| !r.is_empty()), "departure {scenario} {case} has no reason");
    let mut text = recorded;
    for pair in entry["replace"].as_array().into_iter().flatten() {
        let (from, to) = (pair["from"].as_str().expect("from"), pair["to"].as_str().expect("to"));
        assert!(text.contains(from), "departure {scenario} {case}: the recording does not hold {from:?}");
        text = text.replace(from, to);
    }
    let capped = entry["kind"] == "capped";
    if capped {
        assert!(text.contains("[output capped at"), "departure {scenario} {case} is for a capped recording");
    }
    (text, capped)
}

/// Whether `case` of `scenario` is listed as a capped answer, checked by invariants instead of text.
pub(crate) fn is_capped(scenario: &str, case: &str) -> bool {
    entry(scenario, case).is_some_and(|d| d["kind"] == "capped")
}

/// Node's recorded tool definition with only the listed additions and exact property replacements.
pub(crate) fn definition(name: &str, recorded: Value) -> Value {
    let Some(entry) = entry("tool-definitions", name) else { return recorded };
    let mut definition = recorded;
    for add in entry["add"].as_array().into_iter().flatten() {
        let mut at: Vec<&str> = add["at"].as_str().expect("at").split('.').collect();
        let key = at.pop().expect("a key");
        let mut object = &mut definition;
        for part in at {
            object = object.get_mut(part).unwrap_or_else(|| panic!("departure tool-definitions {name}: no {part:?} in the recording"));
        }
        let map = object.as_object_mut().expect("an object to add to");
        assert!(!map.contains_key(key), "departure tool-definitions {name}: the recording already has {key:?}");
        map.insert(key.to_owned(), add["value"].clone());
    }
    for change in entry["replace"].as_array().into_iter().flatten() {
        let at = change["at"].as_str().expect("a JSON pointer");
        let slot = definition.pointer_mut(at).unwrap_or_else(|| panic!("departure tool-definitions {name}: no {at} in the recording"));
        assert_eq!(*slot, change["from"], "departure tool-definitions {name}: recorded value at {at}");
        *slot = change["to"].clone();
    }
    definition
}

/// A step of an admission recording (`search-admission-*`) with its listed override applied: the recorded values it names
/// must be the step's own.
pub(crate) fn step(scenario: &str, index: usize, recorded: &Value) -> Value {
    let Some(entry) = entry(scenario, &format!("step#{index}")) else { return recorded.clone() };
    for (key, value) in entry["recorded"].as_object().into_iter().flatten() {
        assert_eq!(&recorded[key], value, "departure {scenario} step#{index}: the recording's {key} is not what the departure names");
    }
    let mut step = recorded.clone();
    for (key, value) in entry["override"].as_object().into_iter().flatten() {
        step[key] = value.clone();
    }
    step
}

static CONTEXT_HEADER: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^# (.+):([0-9]+) \[lines ([0-9]+)-([0-9]+)\]$").expect("a fixed pattern"));

static PATTERN_LABEL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"pattern:("(?:[^"\\]|\\.)*")"#).expect("a fixed pattern"));
static ADDITIONAL_ROW: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^(.+?):([0-9]+):(.*) \[lines [0-9]+-[0-9]+\]$").expect("a fixed pattern"));

/// A match line's text as an answer shows it either way: a block holds the raw line, an `Additional matches` row the line
/// with its white space squeezed and cut at 400 characters (`compactAnchorContent`).
fn squeezed(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > 400 { format!("{}…", text.chars().take(399).collect::<String>()) } else { text }
}

/// The patterns a part of an answer was searched for: the one its heading names (`pattern:"…"`), else the call's.
fn patterns_of(input: &Value, part: &str) -> Vec<mixdog_js::JsRegex> {
    let flags = if input["-i"] == Value::Bool(true) { "i" } else { "" };
    let heading = part.lines().take(2).collect::<Vec<_>>().join("\n");
    let sources: Vec<String> = match PATTERN_LABEL.captures(&heading).and_then(|found| serde_json::from_str::<String>(&found[1]).ok()) {
        Some(named) => vec![named],
        None => match &input["pattern"] {
            Value::Array(list) => list.iter().filter_map(|p| p.as_str().map(str::to_owned)).collect(),
            Value::String(one) => vec![one.clone()],
            _ => Vec::new(),
        },
    };
    sources.iter().filter_map(|p| mixdog_js::JsRegex::new(p, flags).ok()).collect()
}

/// The matches an answer of context blocks holds, in the order it shows them: path, line and the text of the match line. A
/// block shows its match lines whatever its span (a merged block holds several, a radius-0 block one), and the matches the
/// budget left out of the blocks are listed under `Additional matches`.
/// The fourth field is the block the match is in (each listed row is its own).
type Hit = (String, u64, String, usize);

fn matches_of(text: &str, patterns: &[mixdog_js::JsRegex]) -> Vec<Hit> {
    let lines: Vec<&str> = text.lines().collect();
    let (mut found, mut at, mut additional, mut unit) = (Vec::new(), 0usize, false, 0usize);
    while at < lines.len() {
        let line = lines[at];
        if let Some(header) = CONTEXT_HEADER.captures(line)
            && let (Ok(from), Ok(to)) = (header[3].parse::<u64>(), header[4].parse::<u64>())
        {
            let count = (to + 1).saturating_sub(from) as usize;
            unit += 1;
            for (k, content) in lines[at + 1..].iter().take(count).enumerate() {
                if patterns.iter().any(|p| p.is_match(content)) {
                    found.push((header[1].to_owned(), from + k as u64, squeezed(content), unit));
                }
            }
            (at, additional) = (at + 1 + count, false);
            continue;
        }
        if line == "# Additional matches" {
            additional = true;
        } else if additional && line.starts_with('[') {
            additional = false;
        } else if additional && let Some(row) = ADDITIONAL_ROW.captures(line) {
            unit += 1;
            found.push((row[1].to_owned(), row[2].parse().unwrap_or(0), squeezed(&row[3]), unit));
        }
        at += 1;
    }
    found
}
static SINGLE_CURSOR: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"offset:([0-9]+) for the rest\]").expect("a fixed pattern"));
static SECTION_CURSOR: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"the first not delivered is in section [0-9]+ \((.*)\) at offset ([0-9]+); later sections").expect("a fixed pattern"));

/// The results of a grep answer in order: a match row, a file row, a count row, or a context block (its header with the
/// lines under it). Section headings, group headings, notices and warnings are not results.
fn grep_units(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let blocks = lines.iter().any(|l| CONTEXT_HEADER.is_match(l));
    let mut units: Vec<String> = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        let structural = line.is_empty() || line.starts_with('[') || line.starts_with("# grep ") || line.starts_with("(no matches");
        if blocks {
            if CONTEXT_HEADER.is_match(line) {
                units.push((*line).to_owned());
            } else if !structural && let Some(last) = units.last_mut() {
                last.push('\n');
                last.push_str(line);
            }
        } else if !structural {
            // A group heading (`path (N hits)`) only introduces the indented rows that follow it.
            let heading = !line.starts_with("  ") && lines.get(at + 1).is_some_and(|next| next.starts_with("  "));
            if !heading {
                units.push(line.trim_end().to_owned());
            }
        }
    }
    units
}

/// The results an answer names instead of showing, because one alone passes the cap: the cursor goes on after each, so each
/// counts as a result the answer has dealt with (it is read by its window, not skipped).
fn named_results(text: &str) -> usize {
    text.lines().filter(|l| l.starts_with("[result ") && l.contains("alone is larger than the")).count()
}

/// The first section of an answer (all of a single-section one).
fn first_section(text: &str) -> &str {
    text.split_once("\n\n# grep ").map_or(text, |(first, _)| first)
}

/// What a capped answer must still be about its results: what it delivered is the start of the recording's results (the
/// recording's own last result may be the one Node cut), it delivered one or named the one too large for the cap, and its
/// cursor names the first undelivered result: `offset` plus the results the answer holds, exactly (for context blocks the
/// results are their matches).
fn capped_results(input: &Value, recorded: &str, got: &str) -> Option<String> {
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let delivered = grep_units(first_section(got));
    if delivered.is_empty() && named_results(got) == 0 {
        return Some("delivers no result and names none that is too large for the cap".to_owned());
    }
    let blocks = first_section(got).lines().any(|l| CONTEXT_HEADER.is_match(l));
    if blocks {
        // How many lines a block spans follows the budget it was rendered under (the recording's sections had a share of the
        // cap, a page of the capped answer has what is left), and merged blocks hold several matches. What is comparable is
        // the matches in the order shown: the delivered ones are the start of the recording's (its own last one may be cut).
        let (first, node_first) = (first_section(got), first_section(recorded));
        let (shown, node) = (matches_of(first, &patterns_of(input, first)), matches_of(node_first, &patterns_of(input, node_first)));
        if shown.is_empty() && named_results(got) == 0 {
            return Some("delivers blocks that hold none of the call's matches".to_owned());
        }
        // Every recorded match is held to its place (path and line). Only the text of the recording's last match may differ:
        // Node's cap may have cut that row, so what it recorded must be the start of what is delivered.
        let common = shown.len().min(node.len());
        let plain = |hits: &[Hit]| hits.iter().map(|h| (h.0.clone(), h.1, h.2.clone())).collect::<Vec<_>>();
        let same = (0..common).all(|at| {
            let (got, want) = (&shown[at], &node[at]);
            got.0 == want.0 && got.1 == want.1 && if at + 1 == node.len() { got.2.starts_with(&want.2) } else { got.2 == want.2 }
        });
        if !same {
            return Some(format!("delivers the matches {:?} where the recording's begin {:?}", plain(&shown[..common]), plain(&node[..common])));
        }
    } else {
        let node = grep_units(first_section(recorded));
        let common = delivered.len().min(node.len().saturating_sub(1));
        if delivered[..common] != node[..common] {
            return Some(format!("delivers {:?} where the recording's results begin {:?}", &delivered[..common], &node[..common]));
        }
    }
    let (named, part) = if let Some(found) = SECTION_CURSOR.captures(got) {
        let heading = format!("# grep {}", &found[1]);
        let parts: Vec<String> =
            got.split("\n\n# grep ").enumerate().map(|(at, part)| if at == 0 { part.to_owned() } else { format!("# grep {part}") }).collect();
        let held = parts.iter().find(|part| part.lines().next() == Some(heading.as_str()));
        (found[2].parse::<usize>().ok()?, held.cloned().unwrap_or_default())
    } else if !got.contains("\n\n# grep ") && let Some(found) = SINGLE_CURSOR.captures_iter(got).last() {
        (found[1].parse::<usize>().ok()?, got.to_owned())
    } else {
        return None;
    };
    let named_here = named_results(&part);
    if blocks {
        // The cursor counts the anchors a page delivered. A block also shows context lines, and one that matches the pattern
        // reads as a match, which the block cannot tell from an anchor (its radius narrows with the budget). So the anchors
        // are the first `named - offset` matches shown, and any shown after them must be the context of that last anchor's
        // own block, none in a block after it, none missing.
        let hits = matches_of(&part, &patterns_of(input, &part));
        let anchors = named.saturating_sub(offset + named_here);
        let fits = named >= offset + named_here && anchors <= hits.len() && (anchors == hits.len() || (anchors >= 1 && hits[anchors..].iter().all(|h| h.3 == hits[anchors - 1].3)));
        return (!fits).then(|| format!("names {named} as the first undelivered result where {} match(es) are shown from offset {offset}", hits.len()));
    }
    let expected = offset + grep_units(&part).len() + named_here;
    (named != expected).then(|| format!("names {named} as the first undelivered result where {expected} is the first after what it delivered"))
}

/// What an answer to a call Node capped by bytes must still be: a prefix of whole results that says where it continues, the
/// partial-search warning Node gave when the scan was interrupted, and none of Node's narrowing advice. `input` is the call.
pub(crate) fn capped_invariants(input: &Value, recorded: &str, got: &str, cap: usize) -> Option<String> {
    for stale in ["narrow: run one pattern/path per call", "pass offset to page each section", "[output capped at"] {
        if got.contains(stale) {
            return Some(format!("still carries Node's cap text {stale:?}"));
        }
    }
    if got.len() > cap + 600 {
        return Some(format!("{} bytes pass the {cap}-byte cap", got.len()));
    }
    if recorded.contains("partial results shown") && !got.contains("partial results shown") {
        return Some("lost the partial-search warning of an interrupted scan".to_owned());
    }
    capped_results(input, recorded, got)
}

/// A capped answer is checked for its results and its cursor: it must deliver the start of the recording's results (or name
/// the one too large for the cap), and its cursor must name the first result after what it delivered.
#[test]
fn a_capped_answer_is_held_to_its_results_and_its_cursor() {
    let input = serde_json::json!({ "pattern": "hit", "context": 0, "path": "huge" });
    let recorded = "huge/a.txt (4 hits)\n  1: hit 1\n  2: hit 2\n  3: hit 3\n[output capped at 5 KB; 3 match row(s) shown; offset:3 for more]";
    let page = |rows: &str, cursor: usize| format!("huge/a.txt (4 hits)\n{rows}\n[2 of 400 shown; offset:{cursor} for the rest]");
    let good = page("  1: hit 1\n  2: hit 2", 2);
    assert_eq!(capped_invariants(&input, recorded, &good, 5120), None);
    // An empty successful answer is no capped answer.
    let empty = capped_invariants(&input, recorded, "(no matches in partial results)", 5120);
    assert!(empty.is_some_and(|p| p.contains("delivers no result")), "an empty answer passes");
    // The cursor names the first undelivered result: two rows delivered, so 2, not 5.
    let wrong = capped_invariants(&input, recorded, &page("  1: hit 1\n  2: hit 2", 5), 5120);
    assert!(wrong.is_some_and(|p| p.contains("names 5")), "a wrong cursor passes");
    // What is delivered starts the recording's results.
    let other = capped_invariants(&input, recorded, &page("  1: hit 1\n  2: other", 2), 5120);
    assert!(other.is_some_and(|p| p.contains("where the recording's results begin")), "other rows pass");
    // A result too large for the cap is named, which is an answer.
    let notice = "[result 0 alone is larger than the 5 KB response limit, so none is shown here: huge/a.txt:1:hit…]";
    assert_eq!(capped_invariants(&input, recorded, notice, 5120), None);
}

/// A fan-out's compound cursor is held to the same rule: the section it names holds as many results as it delivered.
#[test]
fn a_capped_fan_out_cursor_names_the_first_undelivered_result_of_its_section() {
    let input = serde_json::json!({ "pattern": "hit", "context": 0, "path": ["a", "b"], "limit": 0 });
    let recorded = "# grep a\na/x.txt (3 hits)\n  1: hit 1\n  2: hit 2\n  3: hit 3\n[output capped at 5 KB; 3 match row(s) shown; narrow: run one pattern/path per call]";
    let footer = |at: usize| {
        format!("\n[response limit 5 KB reached after 2 result(s); the first not delivered is in section 0 (a) at offset {at}; later sections start at their first result. Continue with grep {{}}]")
    };
    let page = |at: usize| format!("# grep a\na/x.txt (3 hits)\n  1: hit 1\n  2: hit 2{}", footer(at));
    assert_eq!(capped_invariants(&input, recorded, &page(2), 5120), None);
    let wrong = capped_invariants(&input, recorded, &page(3), 5120);
    assert!(wrong.is_some_and(|p| p.contains("names 3")), "a wrong compound cursor passes");
}

/// Context blocks are compared by the matches they hold, in order, and the cursor must equal the matches delivered: a merged
/// block and separate radius-0 blocks agree when they hold the same matches; reordered blocks, a replaced match line and a
/// cursor one too high or too low (or far past) do not.
#[test]
fn a_capped_answer_of_blocks_is_held_to_its_matches_in_order_and_to_an_exact_cursor() {
    let input = serde_json::json!({ "pattern": "hit", "path": "x" });
    let recorded = "# x/a.ts:1 [lines 1-1]\nhit one\n# x/a.ts:10 [lines 10-10]\nhit ten\n# x/a.ts:20 [lines 20-20]\nhit twenty\n# x/a.ts:30 [lines 30-30]\nhit thirty\n[output capped at 5 KB; 4 match row(s) shown; offset:4 for more]";
    let page = |blocks: &str, cursor: usize| format!("{blocks}\n[2 of 4 shown; offset:{cursor} for the rest]");
    let separate = "# x/a.ts:1 [lines 1-1]\nhit one\n# x/a.ts:10 [lines 10-10]\nhit ten";
    let merged = format!("# x/a.ts:1 [lines 1-10]\nhit one\n{}hit ten", "fill\n".repeat(8));
    assert_eq!(capped_invariants(&input, recorded, &page(separate, 2), 5120), None);
    assert_eq!(capped_invariants(&input, recorded, &page(&merged, 2), 5120), None, "a merged block holds the same matches");
    let reordered = "# x/a.ts:10 [lines 10-10]\nhit ten\n# x/a.ts:1 [lines 1-1]\nhit one";
    let replaced = "# x/a.ts:1 [lines 1-1]\nhit ONE\n# x/a.ts:10 [lines 10-10]\nhit ten";
    for (what, text) in [("reordered blocks", page(reordered, 2)), ("a replaced match line", page(replaced, 2))] {
        let problem = capped_invariants(&input, recorded, &text, 5120);
        assert!(problem.is_some_and(|p| p.contains("where the recording's begin")), "{what} pass");
    }
    // The recording's last match (line 30) is held to its place too: lines 1, 10, 20, 40 with four anchors skip it.
    let skipped = "# x/a.ts:1 [lines 1-1]\nhit one\n# x/a.ts:10 [lines 10-10]\nhit ten\n# x/a.ts:20 [lines 20-20]\nhit twenty\n# x/a.ts:40 [lines 40-40]\nhit forty";
    let problem = capped_invariants(&input, recorded, &format!("{skipped}\n[4 of 4 shown; offset:4 for the rest]"), 5120);
    assert!(problem.is_some_and(|p| p.contains("where the recording's begin")), "a skipped recorded match passes");
    let whole = "# x/a.ts:1 [lines 1-1]\nhit one\n# x/a.ts:10 [lines 10-10]\nhit ten\n# x/a.ts:20 [lines 20-20]\nhit twenty\n# x/a.ts:30 [lines 30-30]\nhit thirty";
    assert_eq!(capped_invariants(&input, recorded, &format!("{whole}\n[4 of 4 shown; offset:4 for the rest]"), 5120), None);
    for cursor in [1, 3, 99] {
        let problem = capped_invariants(&input, recorded, &page(separate, cursor), 5120);
        assert!(problem.is_some_and(|p| p.contains(&format!("names {cursor}"))), "a cursor of {cursor} for 2 delivered matches passes");
    }
}

/// A result named for being too large is dealt with, so the cursor goes on after it.
#[test]
fn a_named_result_counts_as_dealt_with_when_the_cursor_goes_on_after_it() {
    let input = serde_json::json!({ "pattern": "hit", "context": 0, "path": ["wide", "edge"] });
    let recorded = "# grep wide\nwide/w.ts (2 hits)\n[output capped at 5 KB; 1 match row(s) shown; narrow: one pattern per call]";
    let page = |at: usize| {
        format!("# grep wide\n[result 0 alone is larger than the 4.6 KB response limit, so none is shown here: wide/w.ts…] Read it.\n[response limit 5 KB reached after 0 result(s); the first not delivered is in section 0 (wide) at offset {at}; later sections start at their first result. Continue with grep {{}}]")
    };
    assert_eq!(capped_invariants(&input, recorded, &page(1), 5120), None);
    assert!(capped_invariants(&input, recorded, &page(0), 5120).is_some(), "a cursor at the named result repeats it");
}

/// Every departure with a replacement names text that is in its recording, and a step departure the values it overrides.
#[test]
fn every_departure_names_text_that_is_in_its_recording() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools-fs-search");
    for d in DEPARTURES["departures"].as_array().unwrap() {
        let (scenario, case) = (d["scenario"].as_str().unwrap(), d["case"].as_str().unwrap());
        assert!(d["reason"].as_str().is_some_and(|r| r.len() > 20), "{scenario} {case}: a departure needs its reason");
        if scenario == "tool-definitions" {
            let recorded = mixdog_js::fixture_tools::definition(case).expect("a Node definition");
            definition(case, recorded);
            continue;
        }
        if scenario == "code_graph_routing" {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/tools/code_graph_routing/{case}.json"));
            let recorded: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            let text = recorded["text"].as_str().unwrap().to_owned();
            apply(scenario, case, text);
            continue;
        }
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        if scenario == "edit-patch" {
            let recording: Vec<Value> = serde_json::from_str(mixdog_testkit::fixture!("src/fs/golden/cases.json")).unwrap();
            let call = recording.iter().find(|c| c["name"] == case).unwrap_or_else(|| panic!("{scenario} {case}: no such case"));
            apply(scenario, case, call["text"].as_str().unwrap().to_owned());
            continue;
        }
        let named = [("read-batch", "src/fs/golden/batch_cases.json"), ("read-legacy", "src/fs/golden/legacy_read_cases.json"), ("read-tail", "../../fixtures/read-tail/cases.json")];
        if let Some((_, path)) = named.iter().find(|(s, _)| *s == scenario) {
            let recording: Value = serde_json::from_str(&std::fs::read_to_string(manifest.join(path)).unwrap()).unwrap();
            let text = match case.split_once('#') {
                // `<sequence>#<step>`: a step of a recorded sequence.
                Some((sequence, step)) => {
                    let found = recording["sequences"].as_array().unwrap().iter().find(|s| s["name"] == sequence).unwrap_or_else(|| panic!("{scenario} {case}: no such sequence"));
                    found["steps"][step.parse::<usize>().unwrap()]["result"]["text"].as_str().unwrap().to_owned()
                }
                None => recording["cases"].as_array().unwrap().iter().find(|c| c["name"] == case).unwrap_or_else(|| panic!("{scenario} {case}: no such case"))["result"]["text"].as_str().unwrap().to_owned(),
            };
            apply(scenario, case, text);
            continue;
        }
        if scenario == "code-graph-cases" {
            let recording: Value = serde_json::from_str(&std::fs::read_to_string(manifest.join("../../fixtures/code-graph-cases/golden.json")).unwrap()).unwrap();
            let (case_index, call_index) = case.split_once('#').expect("case#call");
            let call = &recording["cases"][case_index.parse::<usize>().unwrap()]["calls"][call_index.parse::<usize>().unwrap()];
            apply(scenario, case, call["text"].as_str().unwrap_or_else(|| panic!("{scenario} {case}: no such call")).to_owned());
            continue;
        }
        let recording: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{scenario}.json"))).unwrap()).unwrap();
        if let Some(index) = case.strip_prefix("step#") {
            let step = &recording["admission"][index.parse::<usize>().unwrap()];
            assert!(step.is_object(), "{scenario} {case}: no such step");
            step_check(scenario, index.parse().unwrap(), step);
        } else {
            let index: usize = case.trim_start_matches('#').parse().unwrap();
            let call = &recording["calls"][index];
            let text = call["text"].as_str().or_else(|| call["thrown"].as_str()).unwrap_or_else(|| panic!("{scenario} {case}: no such call")).to_owned();
            apply(scenario, case, text);
        }
    }
}

fn step_check(scenario: &str, index: usize, recorded: &Value) {
    let _ = step(scenario, index, recorded);
}
