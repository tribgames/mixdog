// Parity fixture: declaration and import shapes the graph reports for Zig.
const std = @import("std");
const helper = @import("./helper.zig");

pub const Store = struct {
    name: []const u8,
    size: usize = 0,

    pub fn read(self: Store, key: []const u8) usize {
        return self.name.len + key.len;
    }
};

pub const Mode = enum {
    fast,
    slow,
};

const Payload = union(Mode) {
    fast: u32,
    slow: u64,
};

pub fn build(name: []const u8) Store {
    return Store{ .name = name };
}

fn internal(value: usize) usize {
    return value + helper.offset;
}

pub fn main() !void {
    const store = build("main");
    std.debug.print("{d}\n", .{internal(store.read("k"))});
}
