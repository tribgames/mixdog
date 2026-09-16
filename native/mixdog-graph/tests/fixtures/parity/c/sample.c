/* Parity fixture: declaration and import shapes the graph reports for C. */
#include <stdio.h>
#include <string.h>
#include "sample.h"

#define MAX_ITEMS 8

struct Store {
  const char *name;
  int size;
};

enum Mode { MODE_FAST, MODE_SLOW };

typedef struct Pair {
  int left;
  int right;
} Pair;

static int store_size(const struct Store *store) {
  return store ? store->size : 0;
}

char *store_name(struct Store *store) {
  return (char *)store->name;
}

int main(int argc, char **argv) {
  struct Store store = {.name = argv[0], .size = argc};
  printf("%s %d\n", store_name(&store), store_size(&store));
  return (int)strlen(store.name);
}
