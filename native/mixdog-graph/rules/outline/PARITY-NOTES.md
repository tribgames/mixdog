# Outline pruning losses vs current tree-sitter extraction

`ast-grep outline` (CLI `CombinedExtractors`) stops descending once an
**item** matches and only walks the matched subtree for `member` rules whose
`parentRuleIds` name that item. The current `extract_source_symbols` queries
in `native/mixdog-graph/src/main.rs` match at **any depth**.

**Pruning does not apply to the native walk.** `mixdog-graph --outline`
(`src/outline.rs`) visits every node: inside a matched item it tries that
item's member rules first, then item rules, and it always descends. Nested
`def`s inside `defmodule` and `fn`s inside `const X = struct {…}` stay
sibling **items** with body-covering spans. Do not match a name node just to
dodge CLI pruning — that collapses `endLine` to the declaration head and
breaks JS enclosing-symbol resolution.

This list is what the **CLI** rules will miss. Member rules recover one
level; they are not infinite-depth.

---

## bash

Current query: `(function_definition name: (word) @name)` at any depth.

| Recovered | Lost |
| --- | --- |
| 1-level nested function, via `bash-nested-function` member of `bash-function` | Function nested **2+** levels (member-of-member) |

Fixture: `tests/fixtures/outline/bash/sample.sh`

```
nested_wrapper() {          # item `nested_wrapper` (L40)
  inner() {                 # member `inner` (L41) — recovered
    deeper() { :; }         # MISSED — parent is a member, not an item
  }
}
```

`inner` is in `expected.json`. A function inside `inner` is not.

---

## lua

Current query: `function_declaration` named as identifier / `M.f` / `M:f` at
any depth. Anonymous `function_definition` is skipped in both.

| Recovered | Lost |
| --- | --- |
| 1-level nested `function_declaration`, via `lua-nested-function` | Named function nested **2+** levels |

Fixture: `tests/fixtures/outline/lua/sample.lua` has no nested named function
(`local anon = function` at L30 is anonymous and correctly omitted). Example
of a miss:

```
function greet(name)            -- item
  local function fmt(x)         -- member — recovered by lua-nested-function
    local function inner(y)     -- MISSED
      return y
    end
    return inner(x)
  end
  return fmt(name)
end
```

---

## dart

Current query (any depth): `class_declaration`, `mixin_declaration`,
`enum_declaration`, `extension_declaration`, `function_declaration`,
`method_declaration` (function / getter / setter / `binary_operator`).

Members of a top-level class/mixin/enum/extension are recovered
(`dart-method` / `dart-getter` / `dart-setter` / `dart-operator`).

Lost (current query would still emit them):

- Named `function_declaration` inside a function (local function).
- `class` / `mixin` / `enum` / `extension` declared inside a function.
- Methods of a class that is itself nested inside a function (the class item
  is already gone, so members never run).

Fixture: `tests/fixtures/outline/dart/sample.dart` — `User` methods at L11–L19
are recovered; there is no nested declaration. Example of a miss:

```
int add(int a, int b) {          // item `add` (cf. L34)
  int inner(int x) => x;         // MISSED function_declaration
  class Box {}                   // MISSED class_declaration
  return a + b;
}
```

Unchanged omissions (also absent from the current query, not pruning):
constructor `User(this.name)` (L8); `[]` / `[]=` / `~` operators; `part of`.

BEYOND the old query: an ABSTRACT method (`void start();`) is now a symbol
(`dart-abstract-method`). The grammar files it as
`class_member > declaration > function_signature`, with no `method_declaration`
node, so the old query could not see it at all — and it is the only
declaration of that name in an implicit interface.

---

## scala

Current query (any depth): `function_definition`, `class_definition`,
`object_definition`, `trait_definition`. Kind is always `function` for `def`,
including class members — `scala-member-function` keeps that kind.

Recovered: `def` directly inside class/object/trait
(`tests/fixtures/outline/scala/sample.scala` `UserService.find`/`save` L13–L15,
`UserService.apply` L19, `Id.next` L27).

Lost:

- `def` inside `def` (no `parentRuleIds` on `scala-function`).
- `class` / `object` / `trait` nested inside a class/object/trait/function
  (`scala-class` / `scala-object` / `scala-trait` are items, not members).
- `def` nested two classes deep (member-of-member).

Example of a miss (not in the fixture):

```
def topLevelHelper(n: Int): Int = {   // item (L30)
  def inner(x: Int): Int = x + 1      // MISSED
  inner(n)
}
```

BEYOND the old query: a bodyless `def` in a trait (`Repository.find`, L9) is a
`function_declaration`, not a `function_definition`, and is now reported by
`scala-declaration` with the same `function` kind.

Not a pruning loss: abstract `trait Repository { def find(...) }` at L8–L10
is a `function_declaration` (no body). The current query only matches
`function_definition`, so CLI and the old extractor both skip it.

---

## elixir

Current query: generic `call` filtered in Rust to `defmodule`/`defprotocol`/
`defimpl` → `module`, `def`/`defp` → `function`, `defmacro`/`defmacrop` →
`macro`, at any depth.

`elixir-module` matches the outer `defmodule`/`defprotocol`/`defimpl` **call**
so the span covers the body (`sample.ex` L1–L29 `Demo.Accounts`). Native
walk still emits nested `def`/`import` as sibling items. CLI CombinedExtractors
will drop those nested items (no member rule).

CLI-only losses:

- `def` / `import` / `alias` / nested `defmodule` inside a module item.
- `def` / `defp` / `defmacro` nested inside another `def`/`defmacro`.

```
defmodule Demo.Accounts do       # item, span = whole call
  import Ecto.Query              # native item; CLI pruned
  def start_link(opts) do        # native item; CLI pruned
    def hidden_inner, do: :ok    # MISSED on CLI (and native if nested in def)
    GenServer.start_link(...)
  end
end
```

---

## objc (CLI has no grammar; native `--outline` validated)

Current query (any depth): `class_interface` / `class_implementation` /
`protocol_declaration` / `method_declaration` / `method_definition` /
C `function_definition`.

Recovered: methods of `@interface`/`@protocol`/`@implementation` (members).
Fixture `tests/fixtures/outline/objc/sample.m`: `User` methods L7–L8 and
L13–L21; `Renderable.render` L26; top-level `helper`/`add` L29–L31.

Lost:

- C `function_definition` **inside** `@interface` / `@implementation` (the
  class item prunes the body; `objc-function` is an item, not a member).
- Method nested inside a method body.
- Category / class nested inside a function.

```
@implementation User
static int impl_helper(int n) { return n; }  // MISSED on CLI prune
- (NSString *)greet { return @"hi"; }        // member — recovered
@end
```

`#import <Foundation/Foundation.h>` / `#import "User.h"` names are the
**stripped** specs `Foundation/Foundation.h` and `User.h`, matching
`objc_import` capture groups and `resolve_include`.

---

## zig (CLI has no grammar; native `--outline` validated)

Current query (any depth): `function_declaration`; `variable_declaration`
with `struct`/`enum`/`union` sibling.

`zig-struct` / `zig-enum` / `zig-union` match the outer `variable_declaration`
(`const X = struct/enum/union {…}`) so the span covers the body. Native walk
still emits container `fn`s as sibling items (`sample.zig` L4–L11 `Config` +
L8 `init`).

CLI (if it had a grammar) would prune those nested `fn`s. Native does not.

Lost only where the parent is itself a `function_declaration` item:

- `fn` nested inside another `fn`.
- Container type nested inside a function.

```
pub const Config = struct {     // item, span = whole variable_declaration
    pub fn init(...) Config {   // native sibling item (CLI would prune)
        return .{ ... };
    }
};

pub fn greet(name: []const u8) []const u8 {   // item (L20)
    const Inner = struct {                    // inside fn item — CLI prune
        fn id() void {}                       // inside fn item — CLI prune
    };
    fn local() void {}                        // inside fn item — CLI prune
    return "hi";
}
```

---

## r (CLI has no grammar; native `--outline` validated)

Current query (any depth): `name <- function(...)` and `name = function(...)`.

No member rule. Fixture `tests/fixtures/outline/r/sample.r`: `inner_add` at
L36 is **top-level** (not inside `main`), so both CLI-style rules and native
emit it.

Lost: a `<-`/`=` function assignment nested in another function body.

```
main <- function() {                 # item (L23)
  inner_add <- function(x, y) {      # MISSED on CLI prune
    x + y
  }
  inner_add(1, 2)
}
```

`library` / `require` / `source("path")` specs match `r_require` (quotes
stripped on `source` / quoted library names).

---

## solidity (new)

No current query. Nested `function`/`struct`/`enum` inside a
contract/interface/library are members (recovered). A function nested inside
a function (unusual) would be pruned. Import names `./LibMath.sol` and
`forge-std/Test.sol` are path specs (`sample.sol` L3–L4).

---

## haskell (new)

No current query. Top-level `function` / `signature` / `bind` skip
`local_binds` / `class` / `instance` by design. Class/instance methods are
members (`sample.hs` L20–L26). Binds in a `where` clause under `greet` would
be excluded by `local_binds`, not by item pruning. Import names are module
ids (`Data.Text`, …).

---

## hcl (new)

No current query. `module "vpc"` is an **item**, so the CLI prunes its body —
the native walk does not, and `hcl-module-source` reports
`source = "./modules/vpc"` (`tests/fixtures/outline/hcl/sample.tf` L24–L27) as
an import item. Only a LOCAL path (`./…`, `../…`, `/…`) is an edge: a registry
or git source (`terraform-aws-modules/vpc/aws`) names no file in this
repository. The `attribute` node exposes no key/val fields in this grammar, so
the rule addresses its two children by position.

Kept: `required_providers` `source = "hashicorp/aws"` (L5) because the
`terraform { }` block is not an item. Nested `dynamic` blocks are not
extracted (comment in `hcl.yml`).
