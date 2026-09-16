# hidden()
_quoted = "hidden()"

plain()

defmodule Widget do
  def run(a) do
    inner()
    nest(leaf(1))
    a.b().c()
  end

  def act() do
    helper()
    Foo.ping()
  end

  def new() do
    :ok
  end
end

mark = "μ"; seed()
Widget.new()
