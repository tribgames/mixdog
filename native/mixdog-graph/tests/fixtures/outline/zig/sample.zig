const std = @import("std");
const util = @import("./util.zig");

pub const Config = struct {
    name: []const u8,
    enabled: bool,

    pub fn init(name: []const u8) Config {
        return .{ .name = name, .enabled = true };
    }
};

const Mode = enum { fast, slow };

const Payload = union(enum) {
    none,
    bytes: []const u8,
};

pub fn greet(name: []const u8) []const u8 {
    _ = name;
    return "hi";
}

fn helper(n: usize) usize {
    return n + 1;
}

pub fn main() void {
    const cfg = Config.init("demo");
    _ = helper(cfg.name.len);
    _ = greet("world");
    _ = Mode.fast;
    _ = Payload.none;
}
