# ast-grep-core 0.45.3, as modified for Mixdog

ast-grep-core 0.45.3 as published on crates.io (MIT, `LICENSES/ast-grep-MIT.txt`), vendored for one change in
`src/ops.rs`. The composite matchers (`And`, `All`, `Any`, `Op`) try their arms on a borrowed copy-on-write view of the
capture environment and, when the arms match, put the result back with `Cow::Owned(new_env.into_owned())`. For a view
the arms never wrote to, `into_owned` copies the whole environment (three hash maps and their keys) only to store what
was already there. The code graph runs these matchers on every candidate node of every file it indexes, and those
copies were about a quarter of what a first index of a large tree allocated. The environment is now put back only when
an arm made it its own; an untouched view leaves the original in place, which is the same value. The four sites are
marked `mixdog` in the source. The crate's tests are not vendored; the outline, call and symbol tests of `mixdog-graph`
and the code-graph tests of `mixdog-tools` cover it.
