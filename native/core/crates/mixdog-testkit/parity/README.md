# Parity case files

One JSON file per behaviour, read by both the Rust tests and the Node tests so the TypeScript and Rust
implementations are pinned to the same table. File `parity/<name>.json`:

```json
{ "name": "<name>", "cases": [ { "id": "<unique id>", "input": <any JSON>, "expect": <any JSON> } ] }
```

- `name` equals the file name without `.json`; ids are non-empty and unique within the file.
- `input` is whatever the implementation under test takes; `expect` is the JSON value it must produce
  (compared structurally; object key order does not matter, array order does).
- Rust: `mixdog_testkit::parity::cases(name)` returns `Vec<Case { id, input, expect }>`;
  `assert_case(&case, &actual)` panics naming the case id when `actual != case.expect`.
- Node: `import { loadCases, assertCase } from '<repo>/scripts/parity/cases.mjs'`; `loadCases(name)` returns
  `[{ id, input, expect }]`; `assertCase(case, actual, name?)` throws an `AssertionError` naming the case id (and the file when `name`
  is given).

A test loops over the cases and calls the assert for each, so a mismatch reports the id of the failing case.
Put NaN, infinities and values JSON cannot hold in the input as strings and decode them in the test.
`sample.json` exists for the harness's own self-tests.
