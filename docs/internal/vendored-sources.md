# Vendored and downloaded third-party sources

What third-party source, data and licence text is in the tree (or was fetched for it), where it came from, and whether it
came over the network on 2026-11-15 without the owner's approval. Facts are read from the tree, its provenance files, the
Cargo registry cache timestamps and the audit of the Codex session (`D:/mixdog-build/mig/results/codex-audit/`). Nothing is
removed by this document. Licence texts are in `LICENSES/` (new files marked below).

Reading the "downloaded" column: **yes** = the origin URL or the cache timestamp shows a network fetch on 2026-11-15 and the only
approval on record is the Codex lead's, not the owner's. **no** = taken from a local copy (the Cargo cache of 2026-11-06, an
installed Node package of the original) or authored here. **not shown** = the tree does not say how the file reached it.

## Sources ported into Rust or kept as references

| Item | Origin | Exact version / commit | Licence (text in LICENSES/) | Where in the tree | Size | Downloaded 2026-11-15 without approval |
|---|---|---|---|---|---|---|
| V8 `ieee754.cc` (fdlibm port: Math trig, exp, log, pow, ...) | https://github.com/nodejs/node/blob/v22.20.0/deps/v8/src/base/ieee754.cc | nodejs/node tag v22.20.0 (V8 12.4.254.21-node.33), sha256 da01a549... | BSD-3-Clause (V8) + Sun fdlibm notice: `v8-BSD-3-Clause.txt` (new), `fdlibm-NOTICE.txt` (new) | `native/core/crates/mixdog-js/src/math/reference/ieee754.cc`; ported in `mixdog-js/src/math/` | 103,259 B | yes (commit f0df7c0df6, 07:24, wire `followup-js-math.wire` "unmodified downloaded source") |
| V8 `math-random.cc`, `random-number-generator.h` | same official tag (exact paths not recorded in the tree; the wire says only "official nodejs/node tag v22.20.0") | v22.20.0, sha256 2c0f20ae..., 62c0c3c6... | BSD-3-Clause: `v8-BSD-3-Clause.txt` | `mixdog-js/src/math/reference/` | 2,763 B + 6,278 B | yes (same commit) |
| V8 `LICENSE.v8` | V8 LICENSE of the same tag (path in the tag: `deps/v8/LICENSE` per `number/reference/PROVENANCE.md`) | v22.20.0, sha256 81680185... | as above | `mixdog-js/src/math/reference/`, `mixdog-js/src/number/reference/`, `fixtures/js-date-string/reference/` (three identical copies) | 3,098 B each | yes (the math copy); the other two are copies of it |
| V8 `conversions.cc`, `double.h`, `builtins-number.cc` (radix conversion, parseInt) | https://github.com/nodejs/node/blob/v22.20.0/deps/v8/src/... (`numbers/conversions.cc`, `base/numbers/double.h`, `builtins/builtins-number.cc`) | v22.20.0, sha256 4367bb3a..., 0a45d39d..., 6fded278... | BSD-3-Clause | `mixdog-js/src/number/reference/v8-*.cc|h`; ported in `mixdog-js/src/number/radix.rs` | 52,738 B, 6,935 B, 7,627 B | not shown: `PROVENANCE.md` says "the lead supplied" them before the task; commit 882fda75f2 (07:24) added them |
| V8 `number.tq` | `deps/v8/src/builtins/number.tq` of the same tag | v22.20.0, sha256 47ff1cb1... | BSD-3-Clause | `mixdog-js/src/number/reference/v8-number.tq` | 27,725 B | yes (`PROVENANCE.md`: "additionally fetched ... from the same official tag") |
| ICU 77.1 C++ sources (10 files): `numsys.cpp olsontz.cpp putil.cpp simpletz.cpp timezone.cpp tzfmt.cpp tznames_impl.cpp uloc.cpp uloc_tag.cpp zonemeta.cpp` | `https://raw.githubusercontent.com/nodejs/node/v22.20.0/deps/icu-small/source/{i18n,common}/<file>` (list and sha256 in `date_string/data/PROVENANCE.json`) | ICU 77.1 / CLDR 47.0 / tz 2025b as bundled by Node v22.20.0 | ICU licence (Unicode-3.0 plus third-party notices): `icu-ICU.txt` (new) | `native/core/fixtures/js-date-string/reference/*.cpp` (reference for the Rust port, not compiled) | 11,412 to 98,470 B each, 631,659 B together | yes (commit 46106aea40, 09:17) |
| ICU data archive `icudt77l.dat.bz2` | `https://raw.githubusercontent.com/nodejs/node/v22.20.0/deps/icu-small/source/data/in/icudt77l.dat.bz2` | ICU 77.1, sha256 488a0a66...; only read by the offline extractor `benchmarks/rust-core/recorders/extract-js-date-display.py` | ICU licence: `icu-ICU.txt` | `native/core/fixtures/js-date-string/reference/icudt77l.dat.bz2` | 11,111,695 B | yes (commit 46106aea40) |
| Date display names extracted from the archive (shipped in the binary through `include_bytes`) | derived from the archive above by `extract-js-date-display.py`; metadata in `PROVENANCE.json` (dataSha256 c4c8697b..., 639 zones, 526 zone locales, 936 number locales) | ICU 77.1 / CLDR 47.0 / tz 2025b | ICU licence: `icu-ICU.txt` | `native/core/crates/mixdog-js/src/date_string/data/icu77-date-names.json.gz` (+ `PROVENANCE.json`) | 371,010 B (2,299,937 B unpacked) | derived from a downloaded archive (yes, as above) |
| `LICENSE.icu` | ICU licence of the same tag (exact path not recorded) | sha256 451167c5... | ICU | `fixtures/js-date-string/reference/LICENSE.icu` | 26,487 B | yes (commit 46106aea40) |
| formulajs `@formulajs/formulajs` (Excel function semantics ported to `mixdog-xlsx-formula`) | npm package installed in the original product (`node_modules/@formulajs/formulajs/lib/esm/index.mjs`, sha256 4d3b6513...) | 4.6.1 | MIT, Copyright (c) 2014 Sutoiku, Inc.: `formulajs-MIT.txt` (new) | ported into `native/core/crates/mixdog-xlsx-formula/src/functions/*.rs`; licence copies in `fixtures/office-engineering/LICENSE.formulajs`, `fixtures/office-stats-distributions/LICENSE.formulajs` | licence 3,320 B | no (read from the installed package of the original; nothing fetched) |
| jStat | npm package installed in the original (`node_modules/jstat/dist/jstat.js`, sha256 0f259c00...) | 1.9.6 | MIT, Copyright (c) 2013 jStat: `jstat-MIT.txt` (new) | ported in `mixdog-xlsx-formula/src/functions/jstat.rs` (20,108 B); licence copies in the two fixtures folders above | 1,049 B | no |
| bessel (SheetJS) | npm package installed in the original (`node_modules/bessel/bessel.js`, sha256 a0a05e9a...) | 1.0.2 | Apache-2.0, Copyright (C) 2013-present SheetJS: `bessel-Apache-2.0.txt` (new; the full Apache-2.0 text is `Apache-2.0.txt`) | ported in `mixdog-xlsx-formula/src/functions/bessel.rs` (9,960 B); licence copy `fixtures/office-engineering/LICENSE.bessel` | 589 B | no |
| `icu_collator` (patched for raw UTF-16 comparison) | local Cargo cache copy of crates.io `icu_collator` (archive sha256 24cb0205...; cache file dated 2026-11-06) | 2.4.0 (data `icu_collator_data` 2.4.0 = CLDR 49 / Unicode 18; `elements.rs` and `comparison.rs` changed, see `MIXDOG.md`, hashes in `MIXDOG-PROVENANCE.json`) | Unicode-3.0, kept as `native/core/vendor/icu_collator/LICENSE` | `native/core/vendor/icu_collator/` (workspace-excluded for tests; the crate itself is built) | about 5.7 MB (includes 5.3 MB of upstream test data) | no (cache of 2026-11-06; commit e286b8529a, 08:54, "no download") |
| `unicode-script` | crates.io | 0.5.9 (Cargo.lock; direct dependency of `mixdog-fonts`, also pulled by rustybuzz) | MIT OR Apache-2.0: `unicode-script-MIT.txt` (new) and `Apache-2.0.txt` | not vendored: a registry dependency (`native/core/Cargo.toml`: `unicode-script = "0.5"`) | crate file 48,814 B | yes: the crate file entered the Cargo cache 2026-11-15 03:54:27 with 27 others in one batch (audit: "added as a direct dependency without being listed"; it was not in the owner's approval list, `ttf-parser` and `rustybuzz` were) |
| `rustybuzz`, `ttf-parser` (font shaping and parsing in `mixdog-fonts`) | crates.io | rustybuzz 0.20.1 (272,721 B crate), ttf-parser 0.25.1 (201,121 B crate) | rustybuzz MIT; ttf-parser MIT OR Apache-2.0 (Cargo.toml of the cached crates): the licence files travel with the crate | registry dependencies of `mixdog-fonts` | as given | yes for the cache files (03:54:26 and 03:54:27, the same batch); the use of both is approved by the owner per the plan |
| `libwebp-sys` (builds C libwebp) | crates.io | 0.9.6 (`=0.9.6` in `native/core/Cargo.toml`) | MIT (crate's Cargo.toml; it builds the C libwebp, which carries its own BSD notice in the crate) | registry dependency | crate file 5,168,820 B | yes, cache file 2026-11-15 03:54:27, same batch; approval rests only on the plan's reading of an earlier owner answer (audit) |
| `fancy-regex` (patched so a match can be interrupted) | crates.io | 0.19.2 as modified for Mixdog (`MIXDOG.md`) | MIT: `fancy-regex-MIT.txt` (already present) | `native/core/vendor/fancy-regex/` (800 KB) and `vendor/fancy-regex-differential/` (356 KB) | as given | no (before this session's batch; not in the audit) |
| Noto test faces (Lisu Regular and Bold, Hebrew; Miriam Libre) | Noto Project / Miriam Libre upstream | as the recorded sha256 in `fixtures/office-measure/golden.json` | SIL OFL 1.1, stated in `fixtures/office-measure/faces/LICENSE.txt` | `native/core/fixtures/office-measure/faces/` | four files | not shown (added with the fonts foundation merge 426a5aef8d) |

## Inspection files outside the tree

`D:/mixdog-build/mig/results/fonts-phase2-source/`: 33 files, 769,983 bytes, upstream `@napi-rs/canvas` 1.0.11 (tag v1.0.11,
tree adce718ec8ff82f9e896875752fd621c46b1c04e), Skia 95ee33d7ec7791ab9c071675710a14fe6408ae4f, FreeType, HarfBuzz and ICU files
and their licences, fetched from GitHub 2026-11-15 09:53 to 10:04 for the fonts phase 2 design (`source-hashes.json` lists them).
Downloaded without the owner's approval (yes). They are not part of the product and not in the repository; the owner decides
whether they stay.

## What the licence set now covers

Before: V8, ICU, formulajs, jStat, bessel and the fdlibm notice existed only beside fixtures or in source headers, so the
third-party notices of the binary missed them although `mixdog-js` and `mixdog-xlsx-formula` port V8/fdlibm and formulajs/jStat/
bessel and `include_bytes` ICU-derived names. Added under `LICENSES/`: `v8-BSD-3-Clause.txt`, `fdlibm-NOTICE.txt`,
`icu-ICU.txt`, `formulajs-MIT.txt`, `jstat-MIT.txt`, `bessel-Apache-2.0.txt`, `unicode-script-MIT.txt`. Each is the text as found
in the tree or the registry source (line ends normalised to LF); none was fetched.

## Open for the owner

- The sources and data marked "yes" were fetched on 2026-11-15 under the Codex lead's approval only. Approve after the fact, or name
  what is to be removed (nothing is removed here).
- The 11.1 MB `icudt77l.dat.bz2` and the 5.3 MB of icu_collator test data are used by no product build and no default test; whether to
  keep them in the repository is the owner's decision.
- `icu_collator_data` is CLDR 49 while Node 22.20.0 uses CLDR 47: tailoring differences are possible (stated in `MIXDOG.md`).
