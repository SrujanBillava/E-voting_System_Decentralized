// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BabyJubJub} from "../libraries/BabyJubJub.sol";

/// @notice TEST ONLY. Exposes the on-chain point addition so the tests can compare it with the JavaScript reference implementation.
contract BabyJubJubHarness {
    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) external view returns (uint256, uint256) {
        return BabyJubJub.add(x1, y1, x2, y2);
    }

    /// @notice Sequential sum p0 + p1 + ... starting from the identity (0, 1), exactly how the aggregate is built.
    function sum(uint256[] calldata xs, uint256[] calldata ys) external view returns (uint256 x, uint256 y) {
        require(xs.length == ys.length, "length");
        (x, y) = (0, 1);
        for (uint256 i = 0; i < xs.length; ++i) (x, y) = BabyJubJub.add(x, y, xs[i], ys[i]);
    }

    function isOnCurve(uint256 x, uint256 y) external pure returns (bool) {
        return BabyJubJub.isOnCurve(x, y);
    }
}
