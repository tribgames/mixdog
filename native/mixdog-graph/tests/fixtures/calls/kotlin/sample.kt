// hidden()
val quoted = "hidden()"

fun inner() {}
fun leaf(x: Int) = x
fun nest(x: Int) {}
fun helper() {}
fun seed() {}
fun plain() = 0

class Chain {
  fun b(): Chain = this
  fun c(): Chain = this
}

val g = plain()

fun run(a: Chain) {
  inner()
  nest(leaf(1))
  a.b().c()
}

class Widget {
  fun ping() {}
  fun act() {
    helper()
    this.ping()
  }
}

fun seedLine() {
  val mark = "μ"; seed()
}

val w = Widget()
