// hidden()
const quoted = "hidden()";

function inner(): void {}
function leaf(x: number): number { return x; }
function nest(x: number): number { return x; }
function helper(): void {}
function seed(): void {}
function plain(): void {}

class Chain {
  b(): Chain { return this; }
  c(): Chain { return this; }
}

plain();

function run(a: Chain): void {
  inner();
  nest(leaf(1));
  a.b().c();
}

class Widget {
  ping(): void {}
  act(): void {
    helper();
    this.ping();
  }
}

const view = <span data-x={"μ"}>{seed()}</span>;
new Widget();
