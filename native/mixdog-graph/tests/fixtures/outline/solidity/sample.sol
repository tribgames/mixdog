pragma solidity ^0.8.19;

import "./LibMath.sol";
import "forge-std/Test.sol";

struct Point {
    uint256 x;
    uint256 y;
}

enum Kind { A, B }

function freeAdd(uint256 a, uint256 b) pure returns (uint256) {
    return a + b;
}

interface IVault {
    event Deposited(address indexed user, uint256 amount);
    function deposit(uint256 amount) external;
}

library LibMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

contract Vault is IVault {
    enum Status { Open, Closed }
    struct Position {
        uint256 amount;
    }

    event Deposited(address indexed user, uint256 amount);

    function deposit(uint256 amount) external {
        emit Deposited(msg.sender, amount);
    }

    function _hidden() private pure returns (uint256) {
        return 1;
    }
}
