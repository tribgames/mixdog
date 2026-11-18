# regress 0.10.5, as modified for Mixdog

regress 0.10.5 as published on crates.io (MIT OR Apache-2.0), vendored for one change in
`src/classicalbacktrack.rs`: with the `utf16` feature (which the workspace turns on for `mixdog-js` and
`mixdog-highlight`, and so for every crate that links regress) a start-anchored regex was tried at every position of the
text, so a failed `^...` match cost the length of the text and the markdown lexer, which tries the rules of marked's
grammar against the rest of the document at every token, took quadratic time. The anchored match is now tried at the one
position it can match at, as without the feature. A start-anchored alternation (`^a|^b`, as marked's tag, url and emphasis-delimiter rules) is recognised as anchored too. The changes are marked `mixdog` in the source. The tests of the crate
are not vendored; the markdown twin tests (`mixdog-markdown-ansi`) cover it.

A second change, in `src/unicode.rs` and `src/parse.rs`: a case-insensitive pattern outside Unicode mode (neither `u` nor `v`) follows
ECMAScript's `Canonicalize` (22.2.2.7.3) as V8 does. A character at or above 128 whose uppercase is ASCII (`ſ`, `ı`)
stays as it is, so it neither matches nor is matched by its ASCII counterpart: `fold_code_point` and
`unfold_uppercase_char` (literal characters) apply the rule, and a bracket class is closed under `toUpperCase` by
`add_icase_code_points_canonicalized` instead of under simple case folding (the Kelvin sign is not `k` in `[a-z]`). The
Unicode modes (`u`, `v`) keep simple case folding. The node-recorded rows are in `mixdog-js`
(`a_case_insensitive_match_without_u_does_not_fold_non_ascii_to_ascii`).
