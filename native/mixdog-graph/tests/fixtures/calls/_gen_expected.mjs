import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function isIdentChar(ch) {
  return ch != null && ch !== "" && /[\p{L}\p{N}_]/u.test(ch);
}

function findIdentCol(line, name) {
  const chars = [...line];
  const needle = [...name];
  const hits = [];
  for (let i = 0; i <= chars.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (chars[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const before = i > 0 ? chars[i - 1] : "";
    const after = i + needle.length < chars.length ? chars[i + needle.length] : "";
    if (isIdentChar(before) || isIdentChar(after)) continue;
    hits.push(i);
  }
  if (hits.length !== 1) {
    throw new Error(
      `expected 1 ident ${JSON.stringify(name)} in ${JSON.stringify(line)}, got ${hits.length}: ${hits}`
    );
  }
  return hits[0];
}

const commonOop = (opts = {}) => {
  const semi = opts.semi ?? true;
  const s = semi ? ";" : "";
  const inner = opts.inner ?? `inner()${s}`;
  const nested = opts.nested ?? `nest(leaf(1))${s}`;
  const chain = opts.chain ?? `a.b().c()${s}`;
  const helper = opts.helper ?? `helper()${s}`;
  const ping = opts.ping ?? `this.ping()${s}`;
  const pingRecv = opts.pingRecv ?? "this";
  const seed = opts.seed;
  const ctor = opts.ctor;
  const extra = opts.extra ?? [];
  return [
    { trim: opts.plain, name: "plain", kind: "call", inSymbol: opts.plainIn ?? "" },
    { trim: inner, name: "inner", kind: "call", inSymbol: "run" },
    { trim: nested, name: "nest", kind: "call", inSymbol: "run" },
    { trim: nested, name: "leaf", kind: "call", inSymbol: "run" },
    { trim: chain, name: "b", kind: "method", recv: opts.chainRecv ?? "a", inSymbol: "run" },
    {
      trim: chain,
      name: "c",
      kind: "method",
      recv: opts.chainRecvC ?? `${opts.chainRecv ?? "a"}.b()`,
      inSymbol: "run",
    },
    { trim: helper, name: "helper", kind: "call", inSymbol: opts.actIn ?? "act" },
    { trim: ping, name: "ping", kind: "method", recv: pingRecv, inSymbol: opts.actIn ?? "act" },
    { trim: seed.trim, name: seed.name, kind: seed.kind ?? "call", inSymbol: seed.inSymbol, recv: seed.recv },
    {
      trim: ctor.trim,
      name: ctor.name,
      kind: ctor.kind,
      inSymbol: ctor.inSymbol,
      recv: ctor.recv,
    },
    ...extra,
  ].filter((c) => c.trim);
};

const langs = [
  {
    dir: "javascript",
    file: "sample.js",
    calls: commonOop({
      plain: "plain();",
      seed: { trim: 'const mark = "μ"; seed();', name: "seed", inSymbol: "" },
      ctor: { trim: "new Widget();", name: "Widget", kind: "new", inSymbol: "" },
    }),
  },
  {
    dir: "typescript",
    file: "sample.ts",
    calls: commonOop({
      plain: "plain();",
      seed: { trim: 'const mark = "μ"; seed();', name: "seed", inSymbol: "" },
      ctor: { trim: "new Widget();", name: "Widget", kind: "new", inSymbol: "" },
    }),
  },
  {
    dir: "tsx",
    file: "sample.tsx",
    calls: commonOop({
      plain: "plain();",
      seed: { trim: 'const view = <span data-x={"μ"}>{seed()}</span>;', name: "seed", inSymbol: "view" },
      ctor: { trim: "new Widget();", name: "Widget", kind: "new", inSymbol: "" },
    }),
  },
  {
    dir: "python",
    file: "sample.py",
    calls: [
      { trim: "@deco()", name: "deco", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "self.ping()", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: "plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: 'mark = "μ"; seed()', name: "seed", kind: "call", inSymbol: "" },
      { trim: "Widget()", name: "Widget", kind: "call", inSymbol: "" },
    ],
  },
  {
    dir: "go",
    file: "sample.go",
    calls: [
      { trim: "var g = plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "w.ping()", name: "ping", kind: "method", recv: "w", inSymbol: "act" },
      { trim: 'mark := "μ"; seed()', name: "seed", kind: "call", inSymbol: "seedLine" },
      { trim: "_ = new(Widget)", name: "new", kind: "call", inSymbol: "seedLine" },
    ],
  },
  {
    dir: "rust",
    file: "sample.rs",
    calls: [
      { trim: "const T: i32 = plain();", name: "plain", kind: "call", inSymbol: "T" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c();", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c();", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "self.ping();", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: 'let mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "main" },
      { trim: 'println!("{}", T);', name: "println", kind: "call", inSymbol: "main" },
      { trim: "let _ = Widget::new();", name: "new", kind: "method", recv: "Widget", inSymbol: "main" },
    ],
  },
  {
    dir: "java",
    file: "sample.java",
    calls: [
      { trim: "static int g = plain();", name: "plain", kind: "call", inSymbol: "Widget" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c();", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c();", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "new Widget();", name: "Widget", kind: "new", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "this.ping();", name: "ping", kind: "method", recv: "this", inSymbol: "act" },
      { trim: 'String mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "seedLine" },
    ],
  },
  {
    dir: "kotlin",
    file: "sample.kt",
    calls: [
      { trim: "val g = plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "this.ping()", name: "ping", kind: "method", recv: "this", inSymbol: "act" },
      { trim: 'val mark = "μ"; seed()', name: "seed", kind: "call", inSymbol: "seedLine" },
      { trim: "val w = Widget()", name: "Widget", kind: "call", inSymbol: "" },
    ],
  },
  {
    dir: "csharp",
    file: "sample.cs",
    calls: [
      { trim: "plain();", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c();", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c();", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: 'string mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "" },
      { trim: "new Widget();", name: "Widget", kind: "new", inSymbol: "" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "this.ping();", name: "ping", kind: "method", recv: "this", inSymbol: "act" },
    ],
  },
  {
    dir: "ruby",
    file: "sample.rb",
    calls: [
      { trim: "plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "self.ping()", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: 'mark = "μ"; seed()', name: "seed", kind: "call", inSymbol: "" },
      { trim: "Widget.new()", name: "new", kind: "method", recv: "Widget", inSymbol: "" },
    ],
  },
  {
    dir: "php",
    file: "sample.php",
    calls: [
      { trim: "plain();", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "$a->b()->c();", name: "b", kind: "method", recv: "$a", inSymbol: "run" },
      { trim: "$a->b()->c();", name: "c", kind: "method", recv: "$a->b()", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "$this->ping();", name: "ping", kind: "method", recv: "$this", inSymbol: "act" },
      { trim: '$mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "" },
      { trim: "new Widget();", name: "Widget", kind: "new", inSymbol: "" },
    ],
  },
  {
    dir: "swift",
    file: "sample.swift",
    calls: [
      { trim: "plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "self.ping()", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: 'let mark = "μ"; seed()', name: "seed", kind: "call", inSymbol: "" },
      { trim: "_ = Widget()", name: "Widget", kind: "call", inSymbol: "" },
    ],
  },
  {
    dir: "c",
    file: "sample.c",
    calls: [
      { trim: "int g = plain();", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: 'const char *mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "seed_line" },
    ],
  },
  {
    dir: "cpp",
    file: "sample.cpp",
    calls: [
      { trim: "int g = plain();", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c();", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c();", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "this->ping();", name: "ping", kind: "method", recv: "this", inSymbol: "act" },
      { trim: 'const char *mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "seed_line" },
      { trim: "auto *w = new Widget();", name: "Widget", kind: "new", inSymbol: "seed_line" },
    ],
  },
  {
    dir: "objc",
    file: "sample.m",
    calls: [
      { trim: "int g = plain();", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "[self ping];", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: "[[a b] c];", name: "b", kind: "method", recv: "a", inSymbol: "act" },
      { trim: "[[a b] c];", name: "c", kind: "method", recv: "[a b]", inSymbol: "act" },
      { trim: 'const char *mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "seed_line" },
      { trim: "[Widget new];", name: "new", kind: "method", recv: "Widget", inSymbol: "seed_line" },
    ],
  },
  {
    dir: "scala",
    file: "sample.scala",
    calls: [
      { trim: "plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "this.ping()", name: "ping", kind: "method", recv: "this", inSymbol: "act" },
      { trim: 'val mark = "μ"; seed()', name: "seed", kind: "call", inSymbol: "" },
      { trim: "new Widget()", name: "Widget", kind: "new", inSymbol: "" },
    ],
  },
  {
    dir: "bash",
    file: "sample.sh",
    calls: [
      { trim: "plain", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner", name: "inner", kind: "call", inSymbol: "run" },
      { trim: 'nest "$(leaf)"', name: "nest", kind: "call", inSymbol: "run" },
      { trim: 'nest "$(leaf)"', name: "leaf", kind: "call", inSymbol: "run" },
      { trim: 'mark="μ"; seed', name: "seed", kind: "call", inSymbol: "" },
    ],
  },
  {
    dir: "lua",
    file: "sample.lua",
    calls: [
      { trim: "plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "self:ping()", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: 'mark = "μ"; seed()', name: "seed", kind: "call", inSymbol: "" },
      { trim: "Widget.new()", name: "new", kind: "method", recv: "Widget", inSymbol: "" },
    ],
  },
  {
    dir: "dart",
    file: "sample.dart",
    calls: [
      { trim: "var g = plain();", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c();", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c();", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "this.ping();", name: "ping", kind: "method", recv: "this", inSymbol: "act" },
      { trim: 'var mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "seedLine" },
      { trim: "var w = new Widget();", name: "Widget", kind: "new", inSymbol: "seedLine" },
    ],
  },
  {
    dir: "elixir",
    file: "sample.ex",
    calls: [
      { trim: "plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c()", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "Foo.ping()", name: "ping", kind: "method", recv: "Foo", inSymbol: "act" },
      { trim: 'mark = "μ"; seed()', name: "seed", kind: "call", inSymbol: "" },
      { trim: "Widget.new()", name: "new", kind: "method", recv: "Widget", inSymbol: "" },
    ],
  },
  {
    dir: "zig",
    file: "sample.zig",
    calls: [
      { trim: "plain();", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "_ = a.b().c();", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "_ = a.b().c();", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "self.ping();", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: 'const mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "main" },
      { trim: "_ = Widget.init();", name: "init", kind: "method", recv: "Widget", inSymbol: "main" },
    ],
  },
  {
    dir: "r",
    file: "sample.r",
    calls: [
      { trim: "inner <- function() { invisible(NULL) }", name: "invisible", kind: "call", inSymbol: "inner" },
      { trim: "helper <- function() { invisible(NULL) }", name: "invisible", kind: "call", inSymbol: "helper" },
      { trim: "seed <- function() { invisible(NULL) }", name: "invisible", kind: "call", inSymbol: "seed" },
      { trim: "plain <- function() { invisible(NULL) }", name: "invisible", kind: "call", inSymbol: "plain" },
      { trim: "plain()", name: "plain", kind: "call", inSymbol: "" },
      { trim: "inner()", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1))", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a$b()$c()", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a$b()$c()", name: "c", kind: "method", recv: "a$b()", inSymbol: "run" },
      { trim: "helper()", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "self$ping()", name: "ping", kind: "method", recv: "self", inSymbol: "act" },
      { trim: 'mark <- "μ"; seed()', name: "seed", kind: "call", inSymbol: "" },
      { trim: "Widget()", name: "Widget", kind: "call", inSymbol: "" },
    ],
  },
  {
    dir: "solidity",
    file: "sample.sol",
    calls: [
      { trim: "uint256 public g = plain();", name: "plain", kind: "call", inSymbol: "Widget" },
      { trim: "inner();", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "nest", kind: "call", inSymbol: "run" },
      { trim: "nest(leaf(1));", name: "leaf", kind: "call", inSymbol: "run" },
      { trim: "a.b().c();", name: "b", kind: "method", recv: "a", inSymbol: "run" },
      { trim: "a.b().c();", name: "c", kind: "method", recv: "a.b()", inSymbol: "run" },
      { trim: "helper();", name: "helper", kind: "call", inSymbol: "act" },
      { trim: "this.ping();", name: "ping", kind: "method", recv: "this", inSymbol: "act" },
      { trim: 'string memory mark = "μ"; seed();', name: "seed", kind: "call", inSymbol: "seedLine" },
      { trim: "new Chain();", name: "Chain", kind: "new", inSymbol: "seedLine" },
    ],
  },
  {
    dir: "haskell",
    file: "sample.hs",
    calls: [
      { trim: "top = plain 1", name: "plain", kind: "call", inSymbol: "top" },
      { trim: "run x = inner x", name: "inner", kind: "call", inSymbol: "run" },
      { trim: "nested x = nest (leaf x)", name: "nest", kind: "call", inSymbol: "nested" },
      { trim: "nested x = nest (leaf x)", name: "leaf", kind: "call", inSymbol: "nested" },
      { trim: "qualifiedCall x = Foo.bar x", name: "bar", kind: "method", recv: "Foo", inSymbol: "qualifiedCall" },
      { trim: "built = Widget 1", name: "Widget", kind: "call", inSymbol: "built" },
      { trim: "act n = helper n", name: "helper", kind: "call", inSymbol: "act" },
      { trim: 'seeded = let _ = "μ" in seed 0', name: "seed", kind: "call", inSymbol: "seeded" },
    ],
  },
  {
    dir: "hcl",
    file: "sample.tf",
    calls: [
      { trim: 'top   = file("a.txt")', name: "file", kind: "call", inSymbol: "locals" },
      { trim: 'default = lookup({ a = "x" }, "a")', name: "lookup", kind: "call", inSymbol: "run" },
      { trim: 'ami = file(lookup({ k = "i-1" }, "k"))', name: "file", kind: "call", inSymbol: "aws_instance.web" },
      { trim: 'ami = file(lookup({ k = "i-1" }, "k"))', name: "lookup", kind: "call", inSymbol: "aws_instance.web" },
      { trim: 'Name = "μ-${format("%s", "web")}"', name: "format", kind: "call", inSymbol: "aws_instance.web" },
    ],
  },
];

const counts = {};
for (const lang of langs) {
  const srcPath = path.join(root, lang.dir, lang.file);
  const text = fs.readFileSync(srcPath, "utf8").replace(/^\uFEFF/, "");
  if (text.includes("\r")) throw new Error(`CRLF in ${srcPath}`);
  const lines = text.split("\n");
  if (lines.length > 60) throw new Error(`${srcPath} has ${lines.length} lines`);
  if (!text.includes("hidden()")) throw new Error(`${srcPath} missing hidden()`);
  const calls = [];
  for (const spec of lang.calls) {
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === spec.trim) matches.push(i);
    }
    if (matches.length !== 1) {
      throw new Error(
        `${lang.dir}: trim ${JSON.stringify(spec.trim)} matched ${matches.length} lines`
      );
    }
    const lineNo = matches[0] + 1;
    const line = lines[matches[0]];
    const col = findIdentCol(line, spec.name);
    const rec = {
      name: spec.name,
      line: lineNo,
      col,
      endCol: col + [...spec.name].length,
      kind: spec.kind,
      inSymbol: spec.inSymbol,
    };
    if (spec.recv != null && spec.recv !== "") rec.recv = spec.recv;
    calls.push(rec);
  }
  calls.sort((a, b) => a.line - b.line || a.col - b.col);
  const muLine = lines.findIndex((l) => l.includes("μ"));
  if (muLine < 0) throw new Error(`${lang.dir} missing μ`);
  if (!calls.some((c) => c.line === muLine + 1)) {
    throw new Error(`${lang.dir}: μ is not on a call line (${muLine + 1})`);
  }
  const hiddenLines = lines
    .map((l, i) => [l, i + 1])
    .filter(([l]) => l.includes("hidden()"));
  if (hiddenLines.length < 2) throw new Error(`${lang.dir} need comment+string hidden()`);
  for (const rec of calls) {
    const line = lines[rec.line - 1];
    if (/^\s*(\/\/|#|--|\/\*)/.test(line) && !line.includes("μ")) {
      throw new Error(`${lang.dir}: call on comment line ${rec.line}`);
    }
  }
  const out = { calls };
  const ordered = calls.map((c) => {
    const o = { name: c.name, line: c.line, col: c.col, endCol: c.endCol, kind: c.kind };
    if (c.recv != null) o.recv = c.recv;
    o.inSymbol = c.inSymbol;
    return o;
  });
  fs.writeFileSync(
    path.join(root, lang.dir, "expected.json"),
    JSON.stringify({ calls: ordered }, null, 2) + "\n"
  );
  counts[lang.dir] = ordered.length;
}

console.log(JSON.stringify(counts, null, 2));
console.log("langs", langs.length);
