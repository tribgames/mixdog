#import <Foundation/Foundation.h>

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

@interface Widget : NSObject
- (void)ping;
- (void)act;
@end

@implementation Widget
- (void)ping {}
- (void)act {
  id a = nil;
  helper();
  [self ping];
  [[a b] c];
}
@end

int seed_line(void) {
  const char *mark = "μ"; seed();
  [Widget new];
  return 0;
}
