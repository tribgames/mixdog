// hidden()
const quoted = "hidden()";

fn inner() void {}
fn leaf(x: i32) i32 {
    return x;
}
fn nest(x: i32) void {
    _ = x;
}
fn helper() void {}
fn seed() void {}
fn plain() void {}

const Chain = struct {
    fn b(self: Chain) Chain {
        return self;
    }
    fn c(self: Chain) Chain {
        return self;
    }
};

fn run(a: Chain) void {
    inner();
    nest(leaf(1));
    _ = a.b().c();
}

const Widget = struct {
    fn ping(self: Widget) void {
        _ = self;
    }
    fn act(self: Widget) void {
        helper();
        self.ping();
    }
    fn init() Widget {
        return .{};
    }
};

comptime {
    plain();
}

pub fn main() void {
    const mark = "μ"; seed();
    _ = mark;
    _ = quoted;
    _ = Widget.init();
}
