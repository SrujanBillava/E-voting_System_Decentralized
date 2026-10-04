pragma circom 2.1.6;

// VoteChain Privacy V3 - ballot validity circuit (PROTOTYPE, isolated from the V2 application).
//
// One voter submits an encrypted ONE-HOT ballot: for every candidate slot j < kc a BabyJubJub exponential-ElGamal ciphertext
//     C1_j = r_j * G            C2_j = m_j * G + r_j * H            (G = Base8, H = election public key)
// of a bit m_j, with exactly one m_j = 1. Slots j >= kc are "padding" and are the public canonical identity pair ((0,1),(0,1)).
//
// FROZEN INTERFACE: 68 public signals, in this order (snarkjs lists public inputs in declaration order; there are no public outputs):
//     [ nullifier, kc, H.x, H.y, then for slot j = 0..K-1: C1.x, C1.y, C2.x, C2.y ]
//
// What the Groth16 proof convinces a verifier of, WITHOUT revealing which slot is 1:
//   * 1 <= kc <= K                      (kc is a PUBLIC input: the verifier supplies the real candidate count of the constituency)
//   * every m_j is 0 or 1, m_j = 0 for every padded slot, and the m_j sum to exactly 1
//   * every public ciphertext is exactly Enc_H(m_j; r_j) for secret m_j, r_j (padded slots are exactly the canonical identity pair)
//   * H is a point of the curve with x != 0 (full prime-order-subgroup validation of H is the VERIFIER's job at election setup)
//   * the proof is tied to the public `nullifier` (it is used in a constraint), so a proof cannot be moved to another voter's nullifier
//
// What the circuit deliberately does NOT contain: chain id, contract, election id, constituency id or any ballot hash. Those are bound OUTSIDE the
// circuit: the voter's Semaphore proof signs message = keccak256(abi.encode(tag, chainId, contract, electionId, constituencyId, all 64 ciphertext
// coordinates)), computed independently by the verifier (later: the smart contract). The Semaphore proof fixes that message, the nullifier and the
// group; this proof fixes the same nullifier and the same ciphertext coordinates.

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/escalarmulfix.circom";

// Number of bits needed to write n (K = 16 -> 5): the width of the kc range checks, so the circuit works for any K, not just 16.
function bitsFor(n) {
    var bits = 0;
    var v = n;
    while (v > 0) {
        bits++;
        v = v \ 2;
    }
    return bits;
}

// One candidate slot: C1 = r*G, C2 = m*G + r*H, for a bit m (the caller constrains m to {0,1}).
template ElGamalSlot() {
    signal input m;
    signal input r;
    signal input H[2];
    signal output c1[2];
    signal output c2[2];

    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // r < 2^251 (the BabyJubJub prime-order subgroup order is just under 2^251)
    component rBits = Num2Bits(251);
    rBits.in <== r;

    component rG = EscalarMulFix(251, BASE8);
    component rH = EscalarMulAny(251);
    for (var i = 0; i < 251; i++) {
        rG.e[i] <== rBits.out[i];
        rH.e[i] <== rBits.out[i];
    }
    rH.p[0] <== H[0];
    rH.p[1] <== H[1];

    // m*G for m in {0,1}: the identity (0,1) when m = 0, G when m = 1 (linear in m)
    signal mGx;
    signal mGy;
    mGx <== m * BASE8[0];
    mGy <== 1 + m * (BASE8[1] - 1);

    component add = BabyAdd();
    add.x1 <== mGx;
    add.y1 <== mGy;
    add.x2 <== rH.out[0];
    add.y2 <== rH.out[1];

    c1[0] <== rG.out[0];
    c1[1] <== rG.out[1];
    c2[0] <== add.xout;
    c2[1] <== add.yout;
}

template BallotValidity(K) {
    // ---------------------------------------------------------------- public inputs (declaration order = public signal order)
    signal input nullifier;
    signal input kc;
    signal input H[2];
    signal input C[K][4]; // slot j: [C1.x, C1.y, C2.x, C2.y]
    // ---------------------------------------------------------------- private witness
    signal input m[K];
    signal input r[K];

    // ---- the election public key is on the curve and is not one of the two order-2 points (x = 0)
    component hOnCurve = BabyCheck();
    hOnCurve.x <== H[0];
    hOnCurve.y <== H[1];
    component hxZero = IsZero();
    hxZero.in <== H[0];
    hxZero.out === 0;

    // ---- 1 <= kc <= K
    var KBITS = bitsFor(K);
    component kcBits = Num2Bits(KBITS);
    kcBits.in <== kc;
    component kcMax = LessEqThan(KBITS);
    kcMax.in[0] <== kc;
    kcMax.in[1] <== K;
    kcMax.out === 1;
    component kcZero = IsZero();
    kcZero.in <== kc;
    kcZero.out === 0;

    // ---- the nullifier is constrained (a public input that appears in no constraint would not be bound by the proof)
    signal nullifierSquare;
    nullifierSquare <== nullifier * nullifier;

    // ---- one-hot: bits, nothing in a padded slot, exactly one 1
    component active[K];
    signal inactiveMask[K];
    var total = 0;
    for (var j = 0; j < K; j++) {
        active[j] = LessThan(KBITS);
        active[j].in[0] <== j;
        active[j].in[1] <== kc;

        m[j] * (m[j] - 1) === 0;
        inactiveMask[j] <== m[j] * (1 - active[j].out);
        inactiveMask[j] === 0;
        total += m[j];
    }
    total === 1;

    // ---- ciphertext well-formedness (padded slots must be exactly the canonical identity pair)
    component slot[K];
    signal e1x[K];
    signal e1y[K];
    signal e2x[K];
    signal e2y[K];
    for (var j = 0; j < K; j++) {
        slot[j] = ElGamalSlot();
        slot[j].m <== m[j];
        slot[j].r <== r[j];
        slot[j].H[0] <== H[0];
        slot[j].H[1] <== H[1];

        e1x[j] <== active[j].out * slot[j].c1[0];
        e1y[j] <== 1 + active[j].out * (slot[j].c1[1] - 1);
        e2x[j] <== active[j].out * slot[j].c2[0];
        e2y[j] <== 1 + active[j].out * (slot[j].c2[1] - 1);
        C[j][0] === e1x[j];
        C[j][1] === e1y[j];
        C[j][2] === e2x[j];
        C[j][3] === e2y[j];
    }
}

component main { public [nullifier, kc, H, C] } = BallotValidity(16);
