// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Registry {
    function lookup(address who) internal pure returns (bool) {
        return who != address(0);
    }
}
