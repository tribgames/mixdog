pragma solidity ^0.8.19;

// hidden()

function inner() pure {}
function leaf(uint256 x) pure returns (uint256) { return x; }
function nest(uint256 x) pure {}
function helper() pure {}
function seed() pure {}
function plain() pure returns (uint256) { return 0; }

contract Chain {
    function b() public returns (Chain) { return this; }
    function c() public returns (Chain) { return this; }
}

contract Widget {
    uint256 public g = plain();
    string public decoy = "hidden()";

    function ping() public pure {}

    function run(Chain a) public {
        inner();
        nest(leaf(1));
        a.b().c();
    }

    function act() public {
        helper();
        this.ping();
    }

    function seedLine() public {
        string memory mark = "μ"; seed();
        new Chain();
    }
}
