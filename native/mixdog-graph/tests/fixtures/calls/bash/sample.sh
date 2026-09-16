#!/usr/bin/env bash
# hidden()
quoted="hidden()"

plain() { :; }
inner() { :; }
leaf() { :; }
nest() { :; }
seed() { :; }

plain

run() {
  inner
  nest "$(leaf)"
}

mark="μ"; seed
