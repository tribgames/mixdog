# Raw JavaScript UTF-16 collation extension

This directory is copied from the existing Cargo cache's `icu_collator` 2.4.0.
No registry/cache file was modified. `MIXDOG-PROVENANCE.json` pins the archive and
original source/package/license hashes. The upstream Unicode-3.0 LICENSE is kept.
Only `src/elements.rs` and `src/comparison.rs` differ from cached upstream sources.
The original Cargo manifest, compiled-data dependencies and valid-string APIs are
unchanged. `src/lib.rs` needs no edit: the new method belongs to CollatorBorrowed.

## Why the normal UTF-16 API cannot be used

Upstream `compare_utf16` and `write_sort_key_utf16_to` call utf16_iter's `chars()`.
They document replacement of each unpaired surrogate by U+FFFD. Node/ICU4C instead
assigns implicit weights to the original surrogate code point. A lexical tie
break after lossy comparison cannot fix primary-order differences; a private-use
substitution can collide with a real user character. Neither is used here.

## Changes

`elements.rs` adds explicit `RawCodePoint::Scalar(char)` and `Surrogate(u16)` tags.
Valid pairs decode to scalars; an unpaired unit remains tagged. It also adds a
surrogate constructor sharing the existing ICU4C `unassignedPrimaryFromCodePoint`
integer formula. No invalid Rust char is ever created and no sentinel is inserted
into user text. Scalar implicit weights use the identical original formula.

`comparison.rs` adds `CollatorBorrowed::compare_raw_utf16`. Equality is checked on
the original u16 slices only. The old common-prefix/UTF-16 comparison path is used
only if both complete inputs are well-formed, so it cannot equate distinct lone
surrogates before element comparison.

For ill-formed inputs, each maximal scalar run is processed by the existing
CollationElements normalization/tailoring iterator. At a tagged surrogate, the
run ends and the original surrogate's implicit CE is inserted. Intermediate
NO_CE end markers are discarded; exactly one final NO_CE terminates the combined
stream. A single original sort-key emitter then consumes the WHOLE CE stream.
Primary compression, French/Canadian backwards-secondary ordering, case level,
tertiary and quaternary state therefore persist across every surrogate boundary.
This is not concatenation of independent sort keys.

The original sort-key emitter was factored to accept a next-CE closure. Its weight
emission body/order is unchanged; the original scalar caller supplies its existing
CollationElements iterator. Existing normal compare implementations are untouched.
For Identical strength, scalar runs use the existing NFD iterator, raw surrogate
code points remain explicit, and one original identical-level encoding state spans
the combined sequence. The old char-based identical writer maps chars to u32 and
uses the same factored byte algorithm.

## Boundary argument and data assumptions

In Unicode/CLDR data used here, surrogates are unassigned CCC=0 starters: no
canonical decomposition, numeric value, contraction or prefix mapping names them.
They stop canonical reordering, numeric runs and contiguous/discontiguous
contraction lookahead. A scalar-run end has the same stop effect on those lookaheads;
the following surrogate CE takes the place of the end marker. A following run starts
without scalar prefix context from before the surrogate. No valid CLDR prefix can
match across that unassigned starter. Leading combining marks normalize within
that run, as they do after a non-decomposing CCC=0 surrogate in ICU4C.

The compiled provider remains icu_collator_data 2.4.0, whose header declares CLDR
49.0.0 / Unicode 18.0.0. The independent Node fixture records its own ICU/CLDR/Unicode
versions (ICU 77.1). This patch does not claim those datasets are universally equal;
it preserves the pre-existing valid-string path/data and makes the additional raw
code-unit behavior testable. A mismatch caused by a data revision is not waived.
No tailoring data, normalizer tables or Cargo-cache source is rewritten.

## Evidence and remaining gate

`fixtures/js-utf16-bridges` is recorded directly from Node: boundary code points
D7FF/D800/DBFF/DC00/DFFF/E000/FFFD, real private-use/astral characters, adjacent
unpaired units, replacement characters, accents/case, canonical equivalents,
Czech/Spanish/Hungarian contractions, Lithuanian combining context, and fr-CA
backwards-secondary ordering across multiple surrogate boundaries. There are
explicit c + surrogate + h versus d + surrogate + a pairs. These do not replace
audit of the complete CE stream/state.

The Rust twin also replays the old valid-string locale_compare fixture unchanged.
No numeric/sign tolerance, surrogate replacement or fallback is accepted by that
comparison. Only the Node recorder and parse-only rustfmt have run in this task;
root compilation and full strict replay are mandatory before claiming parity.
