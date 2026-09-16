# hidden()
quoted = "hidden()"

def inner; end
def leaf(x); x; end
def nest(x); x; end
def helper; end
def seed; end
def plain; end

plain()

def run(a)
  inner()
  nest(leaf(1))
  a.b().c()
end

class Widget
  def ping; end
  def act
    helper()
    self.ping()
  end
end

mark = "μ"; seed()
Widget.new()
