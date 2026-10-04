// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {IBallotValidityVerifier} from "../interfaces/IBallotValidityVerifier.sol";
import {BabyJubJub} from "../libraries/BabyJubJub.sol";

/// @dev TEST ONLY - never deployed with the election. Measures with gasleft() what the expensive parts of VoteChainV3 cost for REAL inputs
///      (a valid proof takes the full verification path; an invalid one may stop early and look cheaper than it is).
contract GasProbe {
    /// @return gasUsed the gas of one `semaphore.verifyProof` call, including the external-call overhead (cold account access), as submitBallot pays it.
    function semaphoreVerify(ISemaphore semaphore, uint256 groupId, ISemaphore.SemaphoreProof calldata proof) external view returns (uint256 gasUsed, bool ok) {
        uint256 before = gasleft();
        ok = semaphore.verifyProof(groupId, proof);
        gasUsed = before - gasleft();
    }

    /// @return gasUsed the gas of one Groth16 verification of the 68 public signals.
    function validityVerify(
        IBallotValidityVerifier verifier,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[68] calldata signals
    ) external view returns (uint256 gasUsed, bool ok) {
        uint256 before = gasleft();
        ok = verifier.verifyProof(a, b, c, signals);
        gasUsed = before - gasleft();
    }

    /// @notice 2 * kc BabyJubJub additions in memory, no storage: each coordinate pair is added to itself, which takes the general path of the complete
    ///         formula (no identity shortcut) and the same MODEXP inversion as a real aggregation step.
    /// @return gasUsed the gas of the arithmetic alone; `sink` only keeps the compiler from dropping the work.
    function aggregationArithmetic(uint256[] calldata coords, uint256 kc) external view returns (uint256 gasUsed, uint256 sink) {
        uint256 before = gasleft();
        for (uint256 j = 0; j < kc; ++j) {
            uint256 o = j * 4;
            (uint256 x, uint256 y) = BabyJubJub.add(coords[o], coords[o + 1], coords[o], coords[o + 1]);
            (uint256 u, uint256 v) = BabyJubJub.add(coords[o + 2], coords[o + 3], coords[o + 2], coords[o + 3]);
            sink ^= x ^ y ^ u ^ v;
        }
        gasUsed = before - gasleft();
    }

    /// @notice The gas of one Poseidon T3 hash as the LeanIMT inside Semaphore pays it: a call to the linked library contract at `poseidonLibrary`.
    /// @return coldGas the first call (cold account access) and warmGas the third call (warm), which is what every hash after the first one costs.
    function poseidonHash(address poseidonLibrary, uint256 a, uint256 b) external view returns (uint256 coldGas, uint256 warmGas, uint256 digest) {
        bytes memory data = abi.encodeWithSignature("hash(uint256[2])", [a, b]);
        uint256 before = gasleft();
        (bool ok, bytes memory out) = poseidonLibrary.staticcall(data);
        coldGas = before - gasleft();
        require(ok, "poseidon call failed");
        (ok, out) = poseidonLibrary.staticcall(data);
        require(ok, "poseidon call failed");
        before = gasleft();
        (ok, out) = poseidonLibrary.staticcall(data);
        warmGas = before - gasleft();
        require(ok, "poseidon call failed");
        digest = abi.decode(out, (uint256));
    }
}
