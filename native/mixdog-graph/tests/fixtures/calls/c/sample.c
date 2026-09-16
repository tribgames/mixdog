/* hidden() */
static const char *quoted = "hidden()";

static int inner(void) { return 0; }
static int leaf(int x) { return x; }
static int nest(int x) { return x; }
static int helper(void) { return 0; }
static int seed(void) { return 0; }
static int plain(void) { return 0; }

int g = plain();

int run(void) {
  inner();
  nest(leaf(1));
  return 0;
}

int seed_line(void) {
  const char *mark = "μ"; seed();
  return 0;
}
