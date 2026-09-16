// hidden()

class Chain {
  Chain b() { return this; }
  Chain c() { return this; }
}

class Widget {
  static String quoted = "hidden()";
  static int g = plain();

  static int plain() { return 0; }
  static void inner() {}
  static int leaf(int x) { return x; }
  static void nest(int x) {}
  static void helper() {}
  static void seed() {}

  void ping() {}

  static void run(Chain a) {
    inner();
    nest(leaf(1));
    a.b().c();
    new Widget();
  }

  void act() {
    helper();
    this.ping();
  }

  static void seedLine() {
    String mark = "μ"; seed();
  }
}
