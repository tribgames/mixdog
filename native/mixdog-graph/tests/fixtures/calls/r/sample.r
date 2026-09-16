# hidden()
quoted <- "hidden()"

inner <- function() { invisible(NULL) }
leaf <- function(x) { x }
nest <- function(x) { x }
helper <- function() { invisible(NULL) }
seed <- function() { invisible(NULL) }
plain <- function() { invisible(NULL) }

plain()

run <- function(a) {
  inner()
  nest(leaf(1))
  a$b()$c()
}

act <- function(self) {
  helper()
  self$ping()
}

mark <- "μ"; seed()
Widget()
