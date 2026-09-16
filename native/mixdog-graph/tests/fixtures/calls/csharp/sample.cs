// hidden()
string quoted = "hidden()";

plain();

void run(Chain a) {
  inner();
  nest(leaf(1));
  a.b().c();
}

string mark = "μ"; seed();
new Widget();

void inner() {}
int leaf(int x) => x;
void nest(int x) {}
void helper() {}
void seed() {}
int plain() => 0;

class Chain {
  public Chain b() => this;
  public Chain c() => this;
}

class Widget {
  public void ping() {}
  public void act() {
    helper();
    this.ping();
  }
}
