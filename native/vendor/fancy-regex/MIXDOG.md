# fancy-regex 0.19.2, as modified for Mixdog

This is fancy-regex 0.19.2 as published on crates.io (MIT, `LICENSE`), vendored so that a match can be stopped:
the Rust core matches the `pattern` keywords of MCP tools' output schemas with it under a bound of 10^10
backtracking steps, and such a match must end when its call is cancelled or the core stops. Every change is marked
`mixdog` in the sources.

- `src/interrupt.rs` (new): a stop (`Arc<AtomicBool>`) a caller sets on its thread with `checking`. A match counts
  its work in steps and reads the stop (a relaxed load) whenever the steps pass a multiple of `INTERVAL` (65,536)
  and before and after every search it hands to regex-automata; once set, the match ends with
  `RuntimeError::BacktrackLimitExceeded`. The module documents the bound between two reads and its exceptions.
  Feature `probe` (tests only) records the steps at each read.
- `src/vm.rs`: the steps are counted (each instruction and backtrack, weighted by the bytes it compares). A delegated
  search, an absent repeater's search, `is_match` of a wrapped pattern and a variable-length look-behind run their
  lazy DFA here one byte at a time (`Stepped`, `search_fwd_stepped`, `search_rev_stepped`, the same loops as
  regex-automata's `find_fwd` and `find_rev`), counting `CHUNK` steps per `CHUNK` bytes; a delegated match's groups
  are then read by the meta engine over that match only. Long back-references, a look-behind's step back and `\Z`
  are read `CHUNK` bytes per step. The read of the stop every 65,536 backtracks it replaces is gone.
- `src/compile.rs`: each delegate (and a wrapped pattern, `src/lib.rs`) also gets that lazy DFA (`stepped_dfa`), built
  from the same pattern under the same syntax, leftmost-first, never giving up on its cache.
- `src/lib.rs`: no seek pre-filter is compiled (a seek searches the rest of the haystack in one call); `interrupt` is
  always a module.
- `Cargo.toml`: the examples, tests, benches and dev-dependencies are dropped (their files are not copied); feature
  `probe` added.

  A literal (`Lit`, `LitCasei`) and the UTF-8 check of a case-insensitive back-reference are compared `CHUNK` bytes
  (characters) per step too. The bound between two reads of the stop, and the three calls of the meta engine that
  stay outside it with their own bound, are in `interrupt.rs`.

What matches is unchanged: the stepped loops give the answers of regex-automata's own, which the meta engine runs
where the lazy DFA cannot (a quit byte). `../fancy-regex-differential` proves it: 1,137 patterns (988 from the
crate's own tests, 149 the shell analysis builds) over 107,718 texts (each pattern's own, changed, repeated past 3,000
bytes, at the default backtrack limit and at 40) through this copy and crates.io's unmodified 0.19.2, as a package
outside the core's workspace (`upstream = { package = "fancy-regex", version = "=0.19.2" }`), comparing compile
results (the error kind; the crate names a group of a subroutine cycle from a hash map's order, so the group is not
compared), `is_match`, every span of `find_iter` and every group of `captures_iter`, `BacktrackLimitExceeded`
included.

## Cost

`cargo run --release --example cost` (same package): the 149 shell patterns (147 compile here) on their own texts and
one 256 KiB text each, median of 31 rounds, the engines alternating within a round, modified against upstream:

- building a regex: +13% (each delegate builds the second automaton, `stepped_dfa`);
- `is_match`: +9% in total, but a call the meta engine answers without reading the text (a literal prefilter, a
  reverse-suffix or reverse-inner search for a pattern ending in `$`) now reads the text forward through the lazy DFA:
  0.1-0.5 µs becomes about 0.3 ms on 256 KiB (the five worst patterns, 600-3,000 times);
- `find_iter`: +6%; `captures_iter`: +4% (the lazy DFA finds the match, then the meta engine reads the groups over
  that span: a second pass over the match, where upstream's one pass finds both). Worst single pattern +50%.
