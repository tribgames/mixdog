# regress 0.10.5, as modified for Mixdog

regress 0.10.5 as published on crates.io (MIT OR Apache-2.0), vendored for one change in
`src/classicalbacktrack.rs`: with the `utf16` feature (which the workspace turns on for `mixdog-js` and
`mixdog-highlight`, and so for every crate that links regress) a start-anchored regex was tried at every position of the
text, so a failed `^...` match cost the length of the text and the markdown lexer, which tries the rules of marked's
grammar against the rest of the document at every token, took quadratic time. The anchored match is now tried at the one
position it can match at, as without the feature. A start-anchored alternation (`^a|^b`, as marked's tag, url and emphasis-delimiter rules) is recognised as anchored too. The changes are marked `mixdog` in the source. The tests of the crate
are not vendored; the markdown twin tests (`mixdog-markdown-ansi`) cover it.
