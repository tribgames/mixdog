//! The vendored fancy-regex (`modified`) answers exactly as crates.io's 0.19.2 (`upstream`): for every pattern of the
//! corpus and every text made of it, both engines compile it alike (or fail with the same error), and answer `is_match`,
//! every match of `find_iter` and every group of every match of `captures_iter` alike, errors included, at the default
//! backtrack limit and at a small one that ends many matches in `BacktrackLimitExceeded`.
//!
//! The corpus (`corpus/`): `upstream.json`, the patterns of the crate's own tests with the texts they are run on
//! (`gen_corpus.py`), and `shell.json`, the patterns the Rust core's shell analysis builds (the JavaScript-syntax
//! patterns of `mixdog-tools` that `prefilter_tests.rs` enumerates, with `i`/`m`/`s` flags written inline) with texts
//! of the recorded shell vectors. Each text is also run changed: its last character dropped, an `x` appended, upper
//! cased, a non-ASCII character put in front, and repeated past 3,000 bytes, so searches cross the 1,024-byte steps of
//! the modified engine and a near miss is run beside every match.

use std::collections::BTreeMap;
use std::path::Path;

/// What one engine answers for one pattern and text.
#[derive(Debug, PartialEq, Eq)]
struct Observation {
    compiled: Result<(usize, Vec<Option<String>>), String>,
    is_match: Option<Result<bool, String>>,
    finds: Vec<Result<(usize, usize), String>>,
    captures: Vec<Result<Vec<Option<(usize, usize)>>, String>>,
}

/// Matches taken from an iterator: enough to see iteration, few enough that a pattern matching everywhere stays cheap.
const MATCHES: usize = 40;

macro_rules! observe {
    ($krate:ident, $pattern:expr, $text:expr, $limit:expr) => {{
        match $krate::RegexBuilder::new($pattern).backtrack_limit($limit).build() {
            Err(error) => Observation { compiled: Err(without_payload(format!("{error:?}"))), is_match: None, finds: vec![], captures: vec![] },
            Ok(regex) => Observation {
                compiled: Ok((
                    regex.captures_len(),
                    regex.capture_names().map(|name| name.map(str::to_owned)).collect(),
                )),
                is_match: Some(regex.is_match($text).map_err(|error| format!("{error:?}"))),
                finds: regex
                    .find_iter($text)
                    .take(MATCHES)
                    .map(|found| found.map(|m| (m.start(), m.end())).map_err(|error| format!("{error:?}")))
                    .collect(),
                captures: regex
                    .captures_iter($text)
                    .take(MATCHES)
                    .map(|found| {
                        found
                            .map(|captures| {
                                (0..captures.len()).map(|group| captures.get(group).map(|m| (m.start(), m.end()))).collect()
                            })
                            .map_err(|error| format!("{error:?}"))
                    })
                    .collect(),
            },
        }
    }};
}

/// A compile error without its quoted text: where a pattern holds a cycle of subroutine calls, the crate names one of
/// the groups of the cycle from a hash map, and the same engine names group 1 in one run and group 2 in the next. The
/// error's kind is compared, not that name.
fn without_payload(error: String) -> String {
    let mut out = String::new();
    let mut quoted = false;
    let mut chars = error.chars();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (false, '"') => {
                quoted = true;
                out.push_str("\"…\"");
            }
            (true, '\\') => {
                chars.next();
            }
            (true, '"') => quoted = false,
            (false, c) => out.push(c),
            (true, _) => {}
        }
    }
    out
}

/// `run`'s observation; a panic of the engine (the crate has a few, in patterns its tests never run) is an answer too,
/// a compile error named "panicked", so both engines must panic alike.
fn panics_as_answers(run: impl FnOnce() -> Observation) -> Observation {
    // Its message is not compared: it names an index into a hash map's order, which differs from run to run (the same
    // engine answered 1 and 2 for one pattern).
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
        .unwrap_or_else(|_| Observation { compiled: Err("panicked".to_owned()), is_match: None, finds: vec![], captures: vec![] })
}

/// `(pattern, texts)` of a corpus file, the flags `i`, `m`, `s` of an entry written inline.
fn load(name: &str) -> Vec<(String, Vec<String>)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus").join(name);
    let entries: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    entries
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let flags: String = entry["flags"].as_str().unwrap_or("").chars().filter(|f| "ims".contains(*f)).collect();
            let pattern = entry["pattern"].as_str().unwrap();
            let pattern = if flags.is_empty() { pattern.to_owned() } else { format!("(?{flags}){pattern}") };
            let texts = entry["texts"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
            (pattern, texts)
        })
        .collect()
}

/// Texts every pattern is run on besides its own.
const GENERIC: [&str; 6] = ["", "a", "foo bar", "ab12 cd34", "Ünïcode wörd", "line one\r\nline two\n"];

/// `text` and its changes.
fn variants(text: &str) -> Vec<String> {
    let mut out = vec![text.to_owned()];
    if let Some((cut, _)) = text.char_indices().last() {
        out.push(text[..cut].to_owned());
    }
    out.push(format!("{text}x"));
    out.push(text.to_uppercase());
    out.push(format!("é{text}"));
    if !text.is_empty() && text.len() < 3000 {
        out.push(text.repeat(3000 / text.len() + 1));
        // The repetition with a break in it: a near miss late in a long text.
        out.push(format!("{}\u{2}{text}", text.repeat(3000 / text.len() + 1)));
    }
    out
}

#[derive(Default)]
struct Totals {
    patterns: usize,
    compile_errors: usize,
    cases: usize,
    matched: usize,
    limit_errors: usize,
    with_groups: usize,
}

fn differ(corpus: &str, totals: &mut Totals) -> Vec<String> {
    let mut wrong = Vec::new();
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    for (pattern, texts) in load(corpus) {
        if seen.insert(pattern.clone(), ()).is_some() {
            continue;
        }
        totals.patterns += 1;
        let mut every: Vec<String> = texts.iter().flat_map(|text| variants(text)).collect();
        every.extend(GENERIC.iter().flat_map(|text| variants(text)));
        for limit in [1_000_000usize, 40] {
            let mut compile_error = false;
            for text in &every {
                let upstream = panics_as_answers(|| observe!(upstream, &pattern, text.as_str(), limit));
                let modified = panics_as_answers(|| observe!(modified, &pattern, text.as_str(), limit));
                totals.cases += 1;
                compile_error = upstream.compiled.is_err();
                totals.matched += upstream.finds.iter().any(|found| matches!(found, Ok(_))) as usize;
                totals.limit_errors += (upstream.is_match.as_ref().is_some_and(|m| m.is_err())
                    || upstream.finds.iter().any(Result::is_err)) as usize;
                totals.with_groups += matches!(&upstream.compiled, Ok((groups, _)) if *groups > 1) as usize;
                if upstream != modified {
                    let shown: String = text.chars().take(60).collect();
                    wrong.push(format!(
                        "{corpus}: /{pattern}/ limit {limit} on {shown:?} ({} bytes):\n  upstream {upstream:?}\n  modified {modified:?}",
                        text.len()
                    ));
                }
            }
            if compile_error {
                totals.compile_errors += 1;
                break;
            }
        }
    }
    wrong
}

#[test]
fn the_modified_engine_answers_as_the_crate_it_was_made_from() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut totals = Totals::default();
    let mut wrong = differ("upstream.json", &mut totals);
    let upstream_patterns = totals.patterns;
    wrong.extend(differ("shell.json", &mut totals));
    let _ = std::panic::take_hook();
    eprintln!(
        "{} patterns ({upstream_patterns} of the crate's tests, {} of the shell analysis), {} compile errors, {} runs, \
         {} with a match, {} ended by the backtrack limit, {} with capture groups",
        totals.patterns,
        totals.patterns - upstream_patterns,
        totals.compile_errors,
        totals.cases,
        totals.matched,
        totals.limit_errors,
        totals.with_groups
    );
    assert!(totals.patterns > 1000 && totals.cases > 50_000, "the corpus is read");
    assert!(totals.matched > 10_000 && totals.limit_errors > 100 && totals.with_groups > 10_000, "the corpus exercises matches, limits and groups");
    assert!(wrong.is_empty(), "{} differ, the first:\n{}", wrong.len(), wrong.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
}
