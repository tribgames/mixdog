// Parity fixture: declaration and import shapes the graph reports for C++.
#include <string>
#include <vector>
#include "sample.hpp"

namespace acme {

struct Point {
  int x;
  int y;

  int sum() const { return x + y; }
};

class Store {
 public:
  explicit Store(std::string name) : name_(std::move(name)) {}

  std::string read(const std::string &key) const { return name_ + ":" + key; }

  static Store build(const std::string &name);

 private:
  std::string name_;
};

Store Store::build(const std::string &name) { return Store(name); }

std::vector<std::string> *collect(const Store &store) {
  auto *items = new std::vector<std::string>();
  items->push_back(store.read("k"));
  return items;
}

int main() {
  Point point{1, 2};
  return point.sum();
}

}  // namespace acme
