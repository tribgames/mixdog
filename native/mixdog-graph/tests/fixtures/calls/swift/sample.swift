// hidden()
let quoted = "hidden()"

func inner() {}
func leaf(_ x: Int) -> Int { x }
func nest(_ x: Int) {}
func helper() {}
func seed() {}
func plain() {}

class Chain {
  func b() -> Chain { self }
  func c() -> Chain { self }
}

plain()

func run(_ a: Chain) {
  inner()
  nest(leaf(1))
  a.b().c()
}

class Widget {
  func ping() {}
  func act() {
    helper()
    self.ping()
  }
}

let mark = "μ"; seed()
_ = Widget()
