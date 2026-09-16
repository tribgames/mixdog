# Parity fixture: declaration and import shapes the graph reports for R.
library(dplyr)
require("stringr")
source("./helper.R")

LIMIT <- 10

build_store <- function(name) {
  list(name = name, size = 0)
}

read_store = function(store, key) {
  paste0(store$name, ":", key)
}

summarise_all <- function(stores) {
  vapply(stores, function(store) nchar(store$name), integer(1))
}
