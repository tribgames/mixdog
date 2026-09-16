// hidden()
var quoted = "hidden()";

void inner() {}
int leaf(int x) => x;
void nest(int x) {}
void helper() {}
void seed() {}
int plain() => 0;

class Chain {
  Chain b() => this;
  Chain c() => this;
}

var g = plain();

void run(Chain a) {
  inner();
  nest(leaf(1));
  a.b().c();
}

class Widget {
  void ping() {}
  void act() {
    helper();
    this.ping();
  }
}

void seedLine() {
  var mark = "μ"; seed();
  var w = new Widget();
}
