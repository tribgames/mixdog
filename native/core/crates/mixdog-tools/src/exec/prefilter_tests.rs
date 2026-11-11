//! The literal pre-check of long texts (`mixdog_js` `Needles`) never changes what the shell's command analysis decides.
//! The patterns checked are enumerated from the product: every pattern a `JsRegex` is built from while the analysis
//! (the exec policy, its scan targets, the guards, the PowerShell hygiene, bash-ism and `wmic` rewrites, the hoist and
//! direct-spawn plans, the tee plan and the warnings) runs over the corpus, so a pattern added to it is checked too.
//! The corpus is every string of Node's recorded vectors for that analysis (`src/exec/testdata`,
//! `src/policy/testdata`); each pattern is checked on it, on its own matches in it, and on variants of those: case
//! changes, inserted white space, quotes and escapes, Unicode look-alikes, and each required string split by a line
//! continuation.

use std::collections::BTreeSet;

use mixdog_core_api::domain::ext::ExtError;
use mixdog_js::JsRegex;
use mixdog_js::prefilter_probe;
use mixdog_js::prefilter_probe::Mode;
use mixdog_protocol::ThreadId;
use tokio_util::sync::CancellationToken;

use crate::policy::exec::CommandPolicy;
use crate::policy::exec::NodeCommandPolicy;

/// A checker that takes every Node body as CommonJS, so the hoist plans are made.
struct CommonJs;

#[async_trait::async_trait]
impl super::hoist::ScriptSyntax for CommonJs {
    async fn compiles_as_commonjs(&self, _: &ThreadId, _: &str) -> Result<bool, ExtError> {
        Ok(true)
    }
}

/// Every string of the recorded vectors, at most 4 KiB long.
fn corpus() -> Vec<String> {
    fn strings(value: &serde_json::Value, out: &mut BTreeSet<String>) {
        match value {
            serde_json::Value::String(text) if !text.is_empty() && text.len() <= 4096 => {
                out.insert(text.clone());
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
            serde_json::Value::Object(map) => map.values().for_each(|item| strings(item, out)),
            _ => {}
        }
    }
    let files = [
        mixdog_testkit::fixture!("src/exec/testdata/bashism_node_vectors.json"),
        mixdog_testkit::fixture!("src/exec/testdata/direct_node_vectors.json"),
        mixdog_testkit::fixture!("src/exec/testdata/guard_node_vectors.json"),
        mixdog_testkit::fixture!("src/exec/testdata/hoist_node_vectors.json"),
        mixdog_testkit::fixture!("src/exec/testdata/hygiene_node_vectors.json"),
        mixdog_testkit::fixture!("src/exec/testdata/invocation_node_vectors.json"),
        mixdog_testkit::fixture!("src/exec/testdata/psfix_node_vectors.json"),
        mixdog_testkit::fixture!("src/policy/testdata/exec_node_vectors.json"),
        mixdog_testkit::fixture!("src/policy/testdata/exec_unicode_ws.json"),
    ];
    let mut out = BTreeSet::new();
    for file in files {
        strings(&serde_json::from_str(file).unwrap(), &mut out);
    }
    out.into_iter().collect()
}

/// What the analysis decides about `command`, every part of it.
fn analysis(runtime: &tokio::runtime::Runtime, command: &str) -> Vec<String> {
    let mut out = vec![
        format!("{:?}", NodeCommandPolicy.evaluate(command)),
        format!("{:?}", crate::policy::exec::scan_targets(command)),
        format!("{:?}", super::guard::guard_shell_call(command, None, false, false)),
        format!("{:?}", super::guard::guard_shell_call(command, None, true, true)),
        format!("{:?}", super::psfix::rewrite_wmic_process(command)),
        super::psfix::powershell_bashism_hint(command, command),
        format!("{:?}", super::hygiene::preflight_powershell_hygiene(command, true, "powershell.exe")),
        format!("{:?}", super::hygiene::preflight_powershell_hygiene(command, true, "pwsh")),
        format!("{:?}", super::bashism::rewrite_powershell_bashisms(command)),
        format!("{:?}", super::invocation::build_powershell_filter_tee_plan(command, "0123abcd", "C:\\tmp", '\\')),
        super::warning::prepend_warning(command, String::new()),
    ];
    runtime.block_on(async {
        for (windows, powershell) in [(true, true), (false, false)] {
            let plan = super::hoist::plan_hoist(command, windows, powershell, &CommonJs, &ThreadId::from("t")).await;
            out.push(format!("{:?}", plan.map(|plan| plan.map(|plan| (plan.extension, plan.body.clone(), plan.replace("F"))))));
        }
        let tokens = mixdog_rt::testing::tokens();
        let cwd = std::env::temp_dir();
        let direct =
            super::direct::plan_direct_exe(tokens.spawn_io, &CancellationToken::new(), command, true, true, &cwd, "").await;
        out.push(format!("{direct:?}"));
    });
    out
}

const CYRILLIC: [(char, char); 9] =
    [('a', 'а'), ('e', 'е'), ('o', 'о'), ('p', 'р'), ('c', 'с'), ('x', 'х'), ('y', 'у'), ('i', 'і'), ('s', 'ѕ')];
/// Characters regress folds with ASCII ones under `i` (simple uppercase or case folding).
const FOLDING: [(char, char); 3] = [('i', 'ı'), ('s', 'ſ'), ('k', '\u{212a}')];

fn look_alike(text: &str, map: &[(char, char)]) -> String {
    text.chars()
        .map(|c| map.iter().find(|(ascii, _)| *ascii == c.to_ascii_lowercase()).map_or(c, |(_, like)| *like))
        .collect()
}

fn full_width(text: &str) -> String {
    text.chars().map(|c| if c.is_ascii_graphic() { char::from_u32(c as u32 - 0x21 + 0xFF01).unwrap() } else { c }).collect()
}

/// `text` changed in the ways a command can be respelled, and with each occurrence of each string split.
fn variants(text: &str, needles: &[String], fold: bool) -> Vec<String> {
    let mut out = vec![
        text.to_uppercase(),
        text.to_lowercase(),
        text.chars().map(|c| if c.is_ascii_lowercase() { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() }).collect(),
        text.replace(' ', "  "),
        text.replace(' ', "\t"),
        text.replace(' ', "\u{a0}"),
        text.split(' ').map(|word| format!("\"{word}\"")).collect::<Vec<_>>().join(" "),
        look_alike(text, &CYRILLIC),
        look_alike(text, &FOLDING),
        full_width(text),
    ];
    // ASCII lowercasing keeps every byte offset.
    let read = if fold { text.to_ascii_lowercase() } else { text.to_owned() };
    for needle in needles {
        for (at, _) in read.match_indices(needle.as_str()) {
            let mut mid = at + needle.len() / 2;
            while !text.is_char_boundary(mid) {
                mid -= 1;
            }
            for insert in ["\\\n", "`\n", "^\r\n", "''", "\"\"", "\\", " ", "\t"] {
                out.push(format!("{}{insert}{}", &text[..mid], &text[mid..]));
            }
        }
    }
    out
}

/// Every decision of the analysis is the same with the pre-check applied to every text and with it never applied; and,
/// for every pattern the analysis builds, a text whose required strings the pre-check finds absent is one the engine
/// finds no match in.
#[test]
fn the_literal_precheck_never_changes_a_decision_of_the_shell_analysis() {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let corpus = corpus();
    prefilter_probe::record();

    let mut texts = corpus.clone();
    texts.extend(corpus.iter().map(|text| text.to_uppercase()));
    texts.extend(corpus.iter().map(|text| look_alike(text, &FOLDING)));
    prefilter_probe::set_mode(Mode::Never);
    let without: Vec<Vec<String>> = texts.iter().map(|text| analysis(&runtime, text)).collect();
    prefilter_probe::set_mode(Mode::Always);
    let with: Vec<Vec<String>> = texts.iter().map(|text| analysis(&runtime, text)).collect();
    prefilter_probe::set_mode(Mode::Long);
    let differ: Vec<String> = texts
        .iter()
        .zip(without.iter().zip(&with))
        .filter(|(_, (without, with))| without != with)
        .map(|(text, (without, with))| format!("{text:?}: without {without:?}, with {with:?}"))
        .collect();
    assert!(differ.is_empty(), "{differ:#?}");

    let built = prefilter_probe::built();
    assert!(built.iter().any(|(pattern, _)| pattern == r"\bInvoke-Expression\b"), "the exec policy's patterns are built");
    let (mut with_strings, mut checked, mut wrong) = (0, 0, Vec::new());
    for (pattern, flags) in &built {
        let regex = JsRegex::new(pattern, flags).unwrap();
        let Some((needles, fold)) = regex.needles() else { continue };
        with_strings += 1;
        let needles = needles.to_vec();
        let positives: BTreeSet<String> =
            corpus.iter().filter_map(|text| regex.engine_find(text).map(|at| text[at].to_owned())).take(64).collect();
        let mut texts: Vec<String> = corpus.clone();
        for positive in &positives {
            texts.push(positive.clone());
            texts.extend(variants(positive, &needles, fold));
        }
        for text in &texts {
            checked += 1;
            if regex.needles_rule_out(text) {
                if let Some(at) = regex.engine_find(text) {
                    wrong.push(format!("/{pattern}/{flags} {needles:?}: the engine matches {:?} in {text:?}", &text[at]));
                }
            }
        }
    }
    eprintln!(
        "{} patterns built, {with_strings} with required strings; corpus {} strings, {} analysed texts, {checked} pattern checks",
        built.len(),
        corpus.len(),
        texts.len()
    );
    assert!(wrong.is_empty(), "{wrong:#?}");
}
