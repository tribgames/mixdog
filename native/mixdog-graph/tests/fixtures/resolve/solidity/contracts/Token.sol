// SPDX-License-Identifier: MIT
// Resolution fixture: one import per leg of the solidity resolver.
pragma solidity ^0.8.20;

// 1. relative to this file's directory
import "./Base.sol";
import {Sqrt} from "../lib/Math.sol";
// 2. vendored under node_modules/
import {IERC20} from "@acme/erc20/IERC20.sol";
// 3. project-root relative (foundry/remappings-flat layout)
import "contracts/Registry.sol";
// Not vendored in this project: an external dependency, not an edge.
import "@openzeppelin/contracts/token/ERC20.sol";

contract Token is Base {
    function mint(address to, uint256 amount) public {}
}
