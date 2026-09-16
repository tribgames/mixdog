# Stage 3-A call-site goldens

Fixtures encode **language semantics** for an additive `FileRecord.calls`
array. They are not dumps of an extractor. Each language lives in
`<lang>/sample.<ext>` + `<lang>/expected.json`.

`tsx/` is a TypeScript graph-language file parsed with the TSX grammar
(`.tsx`). That is the 25th fixture for 24 extraction languages.

## Shared scenario

Where the language can express the construct, the sample contains:

| Role | Typical shape | Expected |
| --- | --- | --- |
| Top-level plain call | `plain()` | `kind: call`, `inSymbol: ""` when the call is not inside an outline symbol |
| Call in a function | `inner()` in `run` | `inSymbol: "run"` |
| Nested argument | `nest(leaf(1))` | both `nest` and `leaf` |
| Chain | `a.b().c()` | `b` recv `a`; `c` recv `a.b()` (exact source text) |
| Class method | `helper()` in `act` | `inSymbol: "act"` (method name, not the class) |
| Method with receiver | `this.ping()` / `self.ping()` / … | `kind: method`, `recv` = receiver source text |
| Instantiation | `new Widget()` or the language's form | see constructor table |
| Negatives | `hidden()` in a comment **and** a string | absent from `expected.json` |
| Column pin | `"μ"` (U+03BC) earlier on a call line | character columns, not bytes |

Callee `name` is the last identifier segment only. Calls are ordered by
`(line, col)`. `line` is 1-based; `col`/`endCol` are 0-based Unicode scalar
values of the callee **name** token (half-open). `recv` is omitted when there
is no receiver/qualifier.

`inSymbol` is the **simple name** of the innermost enclosing FileRecord
outline symbol by **span containment**, with no exceptions (decorator call
syntax included as calls; their `inSymbol` is whichever outline span actually
covers them). It is not a qualified path (`act`, never `Widget.act`). Graph
extraction drops fields, imports, and similar non-symbols; a call in a Java
field initializer is therefore inside the class, not `""`. A call inside a
JS/TS `const`/`let`/`var` initializer is inside that binding (`const view =`
→ `inSymbol: "view"`).

## Constructor / instantiation

| Syntax | `name` | `kind` | `recv` |
| --- | --- | --- | --- |
| `new Widget()` (JS/TS/TSX/Java/C#/PHP/C++/Dart/Scala/Solidity) | `Widget` | `new` | omitted |
| `Widget()` Python / Kotlin / Swift / R | `Widget` | `call` | omitted |
| `Widget::new()` Rust | `new` | `method` | `Widget` |
| `Widget.new()` Ruby / Lua / Elixir | `new` | `method` | `Widget` |
| `Widget.init()` Zig | `init` | `method` | `Widget` |
| `new(Widget)` Go builtin | `new` | `call` | omitted |
| `[Widget new]` ObjC | `new` | `method` | `Widget` |
| `Widget 1` Haskell data constructor | `Widget` | `call` | omitted |

Kotlin/Swift/Python bare type call is `call` per contract, not `new`.

## Columns

Columns were computed from the source as Unicode scalar values (JS
`[...line]` / Python `len` on BMP). `μ` is 1 character and 2 UTF-8 bytes, so
the `seed`/`format` column on that line is **not** a byte offset.

Regenerate `expected.json` after editing a sample:

```
node native/mixdog-graph/tests/fixtures/calls/_gen_expected.mjs
```

## Syntax checks run here

- `node --check` on `javascript/sample.js`
- `ast.parse` on `python/sample.py`
- `rustc --edition 2021 --emit=metadata` on `rust/sample.rs`

Other languages were reviewed by hand for parse-level validity (not full
typecheck / unused-symbol compile).

---

## Per-language decisions

### javascript / typescript / tsx

Full matrix. `new Widget()` is `kind: new`. Object/class method **definitions**
(`b() { return this; }`) are not calls. TSX `{seed()}` inside JSX is a call;
`<span>` / JSX tags are **not** calls (not `call_expression` / `new`).
No `@foo()` decorator: `node --check` would reject it on `.js`.

JS/TS outline **does** emit `const`/`let`/`var` bindings. Expression-statement
calls (`plain();`, `new Widget();`) stay `inSymbol: ""`. A call in a binding
initializer is inside that binding: TSX `{seed()}` in
`const view = <span …>{seed()}</span>` has `inSymbol: "view"`. JSX tags
(`<span>`, `<Widget />`) are not calls.

### python

`Widget()` is `kind: call`. `@deco()` is a decorator **call** (call syntax is
included; `inSymbol` follows span containment — here `""`, outside `run`'s
outline span). Bare `@deco` is not present. `self.ping()` recv `self`.

### go

No `new T` constructor syntax. Instantiation is the builtin `new(Widget)`:
`name: new`, `kind: call`. Composite literals `Chain{}` are not calls.
Package-level `var g = plain()` has `inSymbol: ""` (var specs are not graph
symbols). Method recv on `act` is `w` (`w.ping()`).

### rust

No file-level expression statements. File-scope call is
`const T: i32 = plain()` with `inSymbol: "T"` (const items **are** symbols).
`println!` is `name: println`, `kind: call` (no `!`). `Widget::new()` is
`name: new`, `kind: method`, recv `Widget`. `#![allow(...)]` is not a call.

### java

No package-level statements. `plain()` lives in a static field initializer
(`inSymbol: "Widget"`; fields are not symbols). `new Widget()` is `kind: new`
inside `run`. Filename is `sample.java` with non-public classes.

### kotlin

Top-level `val g = plain()` is `inSymbol: ""` (properties are not graph
symbols). `Widget()` is `kind: call`.

### csharp

Top-level statements + local function `run` + class `Widget`.
`new Widget()` is `kind: new`.

### ruby

`Widget.new()` is `name: new`, `kind: method`, recv `Widget` — not `kind: new`
(`new X` is invalid Ruby). Calls use parentheses so they are unambiguous.

### php

Chain is `$a->b()->c()` with recv `$a` and `$a->b()`. Method recv is `$this`.
`new Widget()` is `kind: new`.

### swift

Top-level `plain()`. `Widget()` is `kind: call`. recv `self`.

### c

**Cannot express** method-with-receiver, `new T`, `a.b().c()`, or a class
method. C has no those forms in ISO C (a function-pointer member is not
`obj.method()`). Nested `nest(leaf(1))`, file-scope `int g = plain()`, and a
call inside `seed_line` are present. `μ` is in a string, not an identifier
(C identifiers are ASCII).

### cpp

`new Widget()` is `kind: new`. `this->ping()` recv `this` (source text `this`,
not `this->`). Chain `a.b().c()`. File-scope `int g = plain()` is `inSymbol: ""`.

### objc

C calls plus message sends. `[self ping]` recv `self`. Chain `[[a b] c]`:
`b` recv `a`, `c` recv `[a b]`. `[Widget new]` is `kind: method` (not `new X`).
Selector is a single segment (`ping`, `new`, `b`, `c`).

### scala

Scala 3 top-level. `new Widget()` is `kind: new`.

### bash

Only user-defined function invocations and `$(...)`, per contract. Nested
form is `nest "$(leaf)"`. **No** methods, constructors, JS-style chains, or
classes. The contract has **no** general builtin exclusion; the one listed
exception is bash's null command `:` inside `{ :; }`, which is **not** in
expected. `echo`/`printf`/`[` are not in the sample.

### lua

Dot-chain `a.b().c()` matches the contract recv `a.b()`. Colon method
`self:ping()` recv `self`. `Widget.new()` is `kind: method`. `require` is
omitted so import-calls are not mixed in.

### dart

Library-level `var g = plain()` (`inSymbol: ""`). Instantiation uses the
`new` keyword (`new Widget()`, `kind: new`) so it is distinct from a bare
function call.

### elixir

**Declaration macros are not calls in this golden:** `defmodule` / `def` /
`defp` / `defstruct` / `import` / `alias` / `require` / `use` are Elixir
call-nodes but they are the outline declarations, not call-sites. Expected
holds expression-level calls only (`plain()`, `inner()`, `a.b().c()`,
`Foo.ping()`, `Widget.new()`, `seed()`). `%Widget{}` is a struct literal, not
a call; construction is `Widget.new()` (`kind: method`).

### zig

No runtime statements at container scope. File-scope call is
`comptime { plain(); }` with `inSymbol: ""` (comptime blocks are not
symbols). Instantiation is `Widget.init()` (`kind: method`). `Widget{}` is a
struct literal, not a call. `@import` / other `@` builtins are omitted.

### r

`.` is part of identifiers, so chain/method use `$`: `a$b()$c()` recv `a` and
`a$b()`; `self$ping()` recv `self`. Outline only extracts `name <- function`,
so the “class method” is a top-level `act <- function`. `Widget()` is
`kind: call`. `invisible(NULL)` in stub bodies is a genuine `call` named
`invisible` (no builtin exclusion outside bash `:`).

### solidity

No file-level statements. `plain()` is a contract state initializer
(`inSymbol: "Widget"`). `new Chain()` is `kind: new`. `this.ping()` recv
`this`. `μ` is in a string (Solidity identifiers are ASCII).

### haskell

Per contract: named function application, **head identifier only**.
`nest (leaf x)` emits `nest` and `leaf`. Qualified `Foo.bar x` is `name: bar`,
`kind: method`, recv `Foo`. Data constructor `Widget 1` is `kind: call`.
**No** JS-style `a.b().c()` (`.` is module qualification / composition).
**No** file-level expression: a module is a list of declarations, so the
nearest “top-level” call is `top = plain 1` with `inSymbol: "top"`.
Class-method body is the instance `act n = helper n` (`inSymbol: "act"`).

### hcl

Per contract: expression functions (`file`, `lookup`, `format`). Nested
`file(lookup(...))` emits both. **No** methods, `new`, JS-style chains, or
class methods. Everything lives in a block:

- `file(...)` in `locals` → `inSymbol: "locals"`
- `lookup(...)` in `variable "run"` → `inSymbol: "run"`
- nested + `format` in `resource "aws_instance" "web"` → `inSymbol: "aws_instance.web"`

`μ` is in the interpolation string on the `format` line.

---

## Settled contract (adjudicated against the emitter)

- **`inSymbol`** = innermost enclosing outline symbol by span containment, no
  exceptions. Decorators that are call syntax (`@deco()`) are calls; their
  `inSymbol` is whatever outline span covers them.
- **Elixir** `def` / `defmodule` (and the other declaration macros listed
  above) are declarations, not call-sites.
- **Go** `new(T)` is `kind: call`, `name: new`.
- **JSX tags** are not calls; `{expr()}` inside JSX is.
- **Builtins:** no general exclusion. Bash's null command `:` is the listed
  exception. R `invisible(...)` is a call.

## Remaining language limits (not invented)

**c**, **bash**, **hcl** — no method/receiver, no `new X`, no `a.b().c()`, no
class method. **haskell** — no JS-style chain and no `kind: new`.

Chained `recv` is exact source (`a.b()`, `$a->b()`, `a$b()`, `[a b]`). C++ /
PHP / Lua recv is `this` not `this->`; `$this` includes `$`; colon methods
recv `self`. R6/S3 classes are not outline symbols (`act <- function` stands
in). Haskell data constructors and qualified names use the head / last
segment; operators are not named-function heads here. Zig / C / Solidity /
Haskell put `μ` in a string because those identifiers are ASCII. Bash
`$(leaf)` is a call to `leaf`.
