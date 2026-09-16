library(ggplot2)
library("dplyr")
require(stats)
source("helpers.R")
source('util/extra.R')

greet <- function(name) {
  paste("hello", name)
}

add = function(a, b) {
  a + b
}

plot_counts <- function(df) {
  ggplot(df, aes(x = name, y = n)) + geom_col()
}

helper <- function(x) {
  x + 1
}

main <- function() {
  greet("world")
  helper(add(1, 2))
}

not_a_function <- 42

# Ordinary value assignments are not function symbols.
scale_factor <- 1.5
title <- "demo plot"

# Top-level helper. A `<- function` assignment nested inside `main` would be
# a CLI item-pruning loss (see rules/outline/PARITY-NOTES.md).
inner_add <- function(x, y) {
  x + y
}

