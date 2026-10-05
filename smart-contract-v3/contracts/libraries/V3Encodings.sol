// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title V3Encodings
/// @notice The FROZEN Privacy V3 scope and ballot-hash encodings (they must match privacy-v3/ENCODINGS.md and privacy-v3/spec/vectors.json bit for bit),
///         and the partial-decryption bundle and results encodings of the trustee tally (trustee-v3/spec/integration-vectors.json).
/// @dev abi.encode ONLY, never abi.encodePacked. The coordinate array is a STATIC uint256[64] (inline, no offset word, no length word).
///      Layout of `coords`: slot-major, for slot 0..15: C1.x, C1.y, C2.x, C2.y; padded slots are the identity ciphertext (0, 1, 0, 1).
library V3Encodings {
    /// @dev keccak256("VOTECHAIN-V3-SCOPE-1")
    bytes32 internal constant SCOPE_TAG = keccak256("VOTECHAIN-V3-SCOPE-1");
    /// @dev keccak256("VOTECHAIN-V3-BALLOT-1")
    bytes32 internal constant BALLOT_TAG = keccak256("VOTECHAIN-V3-BALLOT-1");

    /// @dev keccak256("VOTECHAIN-V3-PDEC-BUNDLE-1")
    bytes32 internal constant PDEC_BUNDLE_TAG = keccak256("VOTECHAIN-V3-PDEC-BUNDLE-1");
    /// @dev keccak256("VOTECHAIN-V3-RESULTS-1")
    bytes32 internal constant RESULTS_TAG = keccak256("VOTECHAIN-V3-RESULTS-1");

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

    /// @dev The fixed header of a partial-decryption bundle (a struct only to keep the stack shallow; the encoding is a flat abi.encode of static words).
    struct BundleHeader {
        uint256 chainId;
        address contractAddress;
        bytes32 electionId;
        bytes32 transcriptHash;
        uint256 trusteeIndex;
        bytes32 constituencyId;
        uint256 ballotCount;
        uint256 candidateCount;
    }

    /// @notice Hash of one trustee's partial-decryption bundle for one constituency:
    ///         keccak256(abi.encode(PDEC_BUNDLE_TAG, chainId, contractAddress, electionId, transcriptHash, trusteeIndex, constituencyId, ballotCount, candidateCount, words)).
    ///         `words` is a STATIC uint256[64]: for slot 0..15, in this order, D.x, D.y, e, z (the partial decryption D = s_i * A and its Chaum-Pedersen proof (e, z));
    ///         every padded slot (index >= candidateCount) is four zero words.
    function partialBundleHash(BundleHeader memory h, uint256[64] memory words) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(PDEC_BUNDLE_TAG, h.chainId, h.contractAddress, h.electionId, h.transcriptHash, h.trusteeIndex, h.constituencyId, h.ballotCount, h.candidateCount, words)
        );
    }

    /// @notice Hash of one constituency's final result:
    ///         keccak256(abi.encode(RESULTS_TAG, chainId, contractAddress, electionId, transcriptHash, constituencyId, ballotCount, candidateCount, totals)).
    ///         `totals` is a STATIC uint256[16]: the vote total of each candidate slot, zero in every padded slot.
    function resultsHash(
        uint256 chainId,
        address contractAddress,
        bytes32 electionId,
        bytes32 transcriptHash,
        bytes32 constituencyId,
        uint256 ballotCount,
        uint256 candidateCount,
        uint256[16] memory totals
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(RESULTS_TAG, chainId, contractAddress, electionId, transcriptHash, constituencyId, ballotCount, candidateCount, totals));
    }
}
