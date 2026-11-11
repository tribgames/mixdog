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

What matches is unchanged: the stepped loops give the answers of regex-automata's own, which the meta engine runs
where the lazy DFA cannot (a quit byte).
