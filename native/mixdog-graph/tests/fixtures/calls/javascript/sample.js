// hidden()
const quoted = "hidden()";

function inner() {}
function leaf(x) { return x; }
function nest(x) { return x; }
function helper() {}
function seed() {}
function plain() {}

class Chain {
  b() { return this; }
  c() { return this; }
}

plain();

function run(a) {
  inner();
  nest(leaf(1));
  a.b().c();
}

class Widget {
  ping() {}
  act() {
    helper();
    this.ping();
  }
}

const mark = "μ"; seed();
new Widget();
