// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {V3Encodings} from "../libraries/V3Encodings.sol";

/// @notice TEST ONLY. Exposes the frozen encodings with EXPLICIT context so the known-answer vectors of privacy-v3/spec/vectors.json can be checked
///         against the very library code VoteChainV3 uses.
contract EncodingsHarness {
    function scopeOf(uint256 chainId, address contractAddress, bytes32 electionId) external pure returns (uint256) {
        return V3Encodings.scope(chainId, contractAddress, electionId);
    }

    function ballotHashOf(uint256 chainId, address contractAddress, bytes32 electionId, bytes32 constituencyId, uint256[64] calldata coords)
        external
        pure
        returns (uint256)
    {
        return V3Encodings.ballotHash(chainId, contractAddress, electionId, constituencyId, coords);
    }

    function scopeTag() external pure returns (bytes32) {
        return V3Encodings.SCOPE_TAG;
    }

    function ballotTag() external pure returns (bytes32) {
        return V3Encodings.BALLOT_TAG;
    }
}
