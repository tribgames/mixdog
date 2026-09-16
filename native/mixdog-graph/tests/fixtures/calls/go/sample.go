package sample

// hidden()
var quoted = "hidden()"

func inner() {}

func leaf(x int) int { return x }

func nest(x int) {}

func helper() {}

func seed() {}

func plain() int { return 0 }

type Chain struct{}

func (Chain) b() Chain { return Chain{} }

func (Chain) c() Chain { return Chain{} }

var g = plain()

func run(a Chain) {
	inner()
	nest(leaf(1))
	a.b().c()
}

type Widget struct{}

func (Widget) ping() {}

func (w Widget) act() {
	helper()
	w.ping()
}

func seedLine() {
	mark := "μ"; seed()
	_ = new(Widget)
}
