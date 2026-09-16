-- hidden()
quoted = "hidden()"

function inner() end
function leaf(x) return x end
function nest(x) end
function helper() end
function seed() end
function plain() end

plain()

function run(a)
  inner()
  nest(leaf(1))
  a.b().c()
end

Widget = {}
function Widget:ping() end
function Widget:act()
  helper()
  self:ping()
end
function Widget.new()
  return Widget
end

mark = "μ"; seed()
Widget.new()
