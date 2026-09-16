// hidden()
val quoted = "hidden()"

def inner(): Unit = ()
def leaf(x: Int): Int = x
def nest(x: Int): Unit = ()
def helper(): Unit = ()
def seed(): Unit = ()
def plain(): Int = 0

class Chain {
  def b(): Chain = this
  def c(): Chain = this
}

plain()

def run(a: Chain): Unit = {
  inner()
  nest(leaf(1))
  a.b().c()
}

class Widget {
  def ping(): Unit = ()
  def act(): Unit = {
    helper()
    this.ping()
  }
}

val mark = "μ"; seed()
new Widget()
