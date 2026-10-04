// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Interface of the Groth16 verifier snarkjs generates for the frozen 68-public-signal ballot-validity circuit
///         (contracts/verifiers/BallotValidityVerifier.sol, contract Groth16Verifier).
/// @dev Public signals, in order: [nullifier, kc, H.x, H.y, then for slot 0..15: C1.x, C1.y, C2.x, C2.y].
interface IBallotValidityVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[68] calldata _pubSignals
    ) external view returns (bool);
}
