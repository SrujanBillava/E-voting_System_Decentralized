// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title V3Encodings
/// @notice The FROZEN Privacy V3 scope and ballot-hash encodings. They must match privacy-v3/ENCODINGS.md and privacy-v3/spec/vectors.json bit for bit.
/// @dev abi.encode ONLY, never abi.encodePacked. The coordinate array is a STATIC uint256[64] (inline, no offset word, no length word).
///      Layout of `coords`: slot-major, for slot 0..15: C1.x, C1.y, C2.x, C2.y; padded slots are the identity ciphertext (0, 1, 0, 1).
library V3Encodings {
    /// @dev keccak256("VOTECHAIN-V3-SCOPE-1")
    bytes32 internal constant SCOPE_TAG = keccak256("VOTECHAIN-V3-SCOPE-1");
    /// @dev keccak256("VOTECHAIN-V3-BALLOT-1")
    bytes32 internal constant BALLOT_TAG = keccak256("VOTECHAIN-V3-BALLOT-1");

    uint256 internal constant K_MAX = 16;
    uint256 internal constant COORDS_PER_SLOT = 4;
    uint256 internal constant COORD_COUNT = 64;

    /// @notice Election-wide Semaphore scope: uint256(keccak256(abi.encode(SCOPE_TAG, chainId, contractAddress, electionId))). Full 256 bits, no truncation.
    function scope(uint256 chainId, address contractAddress, bytes32 electionId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(SCOPE_TAG, chainId, contractAddress, electionId)));
    }

    /// @notice Ballot hash, used as the Semaphore message:
    ///         uint256(keccak256(abi.encode(BALLOT_TAG, chainId, contractAddress, electionId, constituencyId, coords))).
    function ballotHash(
        uint256 chainId,
        address contractAddress,
        bytes32 electionId,
        bytes32 constituencyId,
        uint256[64] memory coords
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(BALLOT_TAG, chainId, contractAddress, electionId, constituencyId, coords)));
    }
}
