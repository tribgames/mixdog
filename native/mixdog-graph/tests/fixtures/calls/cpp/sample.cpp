// hidden()
static const char *quoted = "hidden()";

int inner() { return 0; }
int leaf(int x) { return x; }
int nest(int x) { return x; }
int helper() { return 0; }
int seed() { return 0; }
int plain() { return 0; }

struct Chain {
  Chain b() { return *this; }
  Chain c() { return *this; }
};

int g = plain();

void run(Chain a) {
  inner();
  nest(leaf(1));
  a.b().c();
}

class Widget {
public:
  void ping() {}
  void act() {
    helper();
    this->ping();
  }
};

int seed_line() {
  const char *mark = "μ"; seed();
  auto *w = new Widget();
  (void)w;
  return 0;
}
