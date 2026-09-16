#![allow(dead_code, unused_variables, unused_must_use)]

// hidden()
const QUOTED: &str = "hidden()";

const fn plain() -> i32 {
    0
}

const T: i32 = plain();

fn inner() {}
fn leaf(x: i32) -> i32 { x }
fn nest(x: i32) { let _ = x; }
fn helper() {}
fn seed() {}

struct Chain;
impl Chain {
    fn b(self) -> Self { self }
    fn c(self) -> Self { self }
}

fn run(a: Chain) {
    inner();
    nest(leaf(1));
    a.b().c();
}

struct Widget;
impl Widget {
    fn new() -> Self { Widget }
    fn ping(&self) {}
    fn act(&self) {
        helper();
        self.ping();
    }
}

fn main() {
    let mark = "μ"; seed();
    println!("{}", T);
    let _ = Widget::new();
}
