// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BabyJubJub
/// @notice The ONLY curve arithmetic VoteChain V3 needs on-chain: affine point ADDITION on the BabyJubJub twisted Edwards curve
///         a*x^2 + y^2 = 1 + d*x^2*y^2 over the BN254 scalar field. There is deliberately no scalar multiplication.
/// @dev The addition law is complete for points on the curve (d is a non-square), so the denominators never vanish for valid inputs; a zero
///      denominator therefore means the inputs were not curve points and the call reverts (fail closed). The identity is (0, 1), NOT (0, 0).
///      One modular inversion (the MODEXP precompile, Fermat) serves both coordinates.
library BabyJubJub {
    /// @dev BN254 scalar field = the base field of BabyJubJub.
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant A = 168700;
    uint256 internal constant D = 168696;

    error DegenerateAddition();

    function isIdentity(uint256 x, uint256 y) internal pure returns (bool) {
        return x == 0 && y == 1;
    }

    /// @notice True iff (x, y) are canonical field elements satisfying the curve equation.
    function isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        uint256 x2 = mulmod(x, x, P);
        uint256 y2 = mulmod(y, y, P);
        return addmod(mulmod(A, x2, P), y2, P) == addmod(1, mulmod(D, mulmod(x2, y2, P), P), P);
    }

    /// @notice (x1, y1) + (x2, y2). Inputs must be reduced curve points (the caller has verified them); the identity is handled without an inversion.
    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal view returns (uint256 x3, uint256 y3) {
        if (x1 == 0 && y1 == 1) return (x2, y2);
        if (x2 == 0 && y2 == 1) return (x1, y1);

        uint256 x1x2 = mulmod(x1, x2, P);
        uint256 y1y2 = mulmod(y1, y2, P);
        uint256 t = mulmod(D, mulmod(x1x2, y1y2, P), P); // d*x1*x2*y1*y2

        uint256 denX = addmod(1, t, P); // 1 + t
        uint256 denY = addmod(1, P - t, P); // 1 - t
        uint256 numX = addmod(mulmod(x1, y2, P), mulmod(y1, x2, P), P); // x1*y2 + y1*x2
        uint256 numY = addmod(y1y2, P - mulmod(A, x1x2, P), P); // y1*y2 - a*x1*x2

        uint256 inv = _inverse(mulmod(denX, denY, P)); // 1 / (denX * denY)
        x3 = mulmod(mulmod(numX, denY, P), inv, P); // numX / denX
        y3 = mulmod(mulmod(numY, denX, P), inv, P); // numY / denY
    }

    /// @dev a^(P-2) mod P through the MODEXP precompile (address 0x05). Reverts for a == 0.
    function _inverse(uint256 a) private view returns (uint256 result) {
        if (a == 0) revert DegenerateAddition();
        uint256 modulus = P;
        uint256 exponent = P - 2;
        bool ok;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, 0x20) // length of the base
            mstore(add(m, 0x20), 0x20) // length of the exponent
            mstore(add(m, 0x40), 0x20) // length of the modulus
            mstore(add(m, 0x60), a)
            mstore(add(m, 0x80), exponent)
            mstore(add(m, 0xa0), modulus)
            ok := staticcall(gas(), 0x05, m, 0xc0, m, 0x20)
            result := mload(m)
        }
        if (!ok) revert DegenerateAddition();
    }
}
