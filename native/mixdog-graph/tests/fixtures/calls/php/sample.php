<?php
// hidden()
$quoted = "hidden()";

function inner() {}
function leaf($x) { return $x; }
function nest($x) {}
function helper() {}
function seed() {}
function plain() {}

plain();

function run($a) {
  inner();
  nest(leaf(1));
  $a->b()->c();
}

class Widget {
  function ping() {}
  function act() {
    helper();
    $this->ping();
  }
}

$mark = "μ"; seed();
new Widget();
