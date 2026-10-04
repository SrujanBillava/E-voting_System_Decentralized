# Privacy V3: frozen cryptographic encodings

Two values are computed independently by the voter, the off-chain verifier and (later) the smart contract, and must match **bit for bit**: the election **scope** and the **ballot hash**.
Both use `abi.encode` followed by `keccak256`. **Never `abi.encodePacked`.** The reference implementation is `src/params.js` (`electionScope`) and `src/ballot.js` (`ballotHash`);
machine-readable known-answer vectors are in [`spec/vectors.json`](spec/vectors.json), and `test/fast.params.test.mjs` fails if the code, the vectors or this document drift apart.

## Tags

```
SCOPE_TAG  = keccak256("VOTECHAIN-V3-SCOPE-1")  = 0xff4afa8c4c192f40f1831486db01d8cd6d134e6ca72e245faa60db14d151a62a
BALLOT_TAG = keccak256("VOTECHAIN-V3-BALLOT-1") = 0x3a818da177a59cde0a535ece9706c5568c4a22c7453bee679f96ebafd549a26f
```

(`keccak256` of the UTF-8 bytes of the label, no terminator.)

## Election scope (Semaphore scope)

```
SCOPE = uint256( keccak256( abi.encode( bytes32 SCOPE_TAG, uint256 chainId, address contractAddress, bytes32 electionId ) ) )
```

* 4 words of 32 bytes (128 bytes): the tag, `chainId`, the address left-padded to 32 bytes, `electionId`.
* **No truncation of `electionId`, no Poseidon.** The full 256-bit result is passed to Semaphore V4 unchanged (as the `scope` argument of `generateProof`, and as `proof.scope` to `verifyProof`).
  Semaphore itself then applies its own `keccak256(scope) >> 8` before its circuit; that is the library's job, not ours, and the nullifier is `Poseidon(semaphoreHash(scope), secret)`.
* One scope per election, not per constituency.

## Ballot hash (Semaphore message)

```
ballotHash = uint256( keccak256( abi.encode(
    bytes32   BALLOT_TAG,
    uint256   chainId,
    address   contractAddress,
    bytes32   electionId,
    bytes32   constituencyId,        // keccak256(bytes(constituencyCode)), as in V2
    uint256[64] coords               // STATIC array
) ) )
```

Frozen choices:

* **`uint256[64]`, not a dynamic `uint256[]`.** A static array is encoded inline: no offset word and no length word. The preimage is exactly **69 words = 2,208 bytes**: tag, chainId, address, electionId, constituencyId, then 64 coordinates.
* **16 slots** (`K_MAX`), 4 coordinates each, **all 64 coordinates are hashed**, including padded slots.
* **Slot-major order**: for slot 0, 1, ..., 15: `C1.x, C1.y, C2.x, C2.y` (so `coords[4*j + 0..3]` belong to slot `j`). This is also the order of the validity circuit's public inputs after `[nullifier, kc, H.x, H.y]`.
* **Padded slots use the canonical identity ciphertext**: `C1 = (0, 1)`, `C2 = (0, 1)`, i.e. `coords[4*j .. 4*j+3] = 0, 1, 0, 1` for every slot `j >= kc`. The contract supplies them; the voter submits only the `kc` real slots.
* The result is a full 256-bit value (most digests exceed the BN254 field modulus). It is used **directly** as the Semaphore `message`; it must be handled as a `uint256`, never reduced into a field element.

## Reference Solidity (illustrative, not compiled; the contract must reproduce the vectors below)

```solidity
bytes32 constant SCOPE_TAG  = keccak256("VOTECHAIN-V3-SCOPE-1");
bytes32 constant BALLOT_TAG = keccak256("VOTECHAIN-V3-BALLOT-1");

function electionScope() internal view returns (uint256) {
    return uint256(keccak256(abi.encode(SCOPE_TAG, block.chainid, address(this), ELECTION_ID)));
}

function ballotHash(bytes32 constituencyId, uint256[64] memory coords) internal view returns (uint256) {
    return uint256(keccak256(abi.encode(BALLOT_TAG, block.chainid, address(this), ELECTION_ID, constituencyId, coords)));
}
```

## Known-answer vectors (copy these exactly)

Context used by all vectors unless stated: `chainId = 31337`, `contractAddress = 0x5fbdb2315678afecb367f032d93f642f64180aa3`,
`electionId = 0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40`,
`constituencyId(KA-BLR) = keccak256("KA-BLR") = 0x75f991e87d3f7b7d5dc6818f5d1573a6d671f3a242e91e03133d7ef3a5e97eeb` (see `spec/vectors.json` for the exact value and for `MH-MUM`).

### Scope

| Case | `scope` |
|---|---|
| `TEST_CONTEXT` | `0x1887f99239e42e29219c719fb42287a8880a654be45f20163ab1ce7f1a241742` |
| `chainId = 1` | `0x236fb1bb2b99f173fe129f024ffdf13d53910545917e3f9733b7bc507dffbd09` |
| `contractAddress + 1` | `0xee16f7daad7467735f8c7b792c7e05030daac241441a8a5ebdb3d40bd7b3615c` |
| `electionId` with the lowest bit flipped | `0x080bd725db820f530bfb32207e5607a8125c0b64cbcf1547e8bff5f1f3f7160b` |
| `electionId` with the lowest 8 bits flipped | `0xc4df961f6288cb97a894cfb65d703a3443823c74690645b99af1a3d5903cbfb5` |
| `electionId` with the highest bit flipped | `0x2fbf38e34632cbd156d8d8238246daf7776f94eb19e78d689e2a988502d9e927` |

The 128-byte `abi.encode` preimage of each is in `spec/vectors.json` (`abiEncoded`).

### Ballot hash

| Case | `ballotHash` |
|---|---|
| 16 padded slots (`coords = [0,1,0,1] x 16`), `KA-BLR` | `0xe6a73d4fa68edd0acc01594aaceb4eafa4d4a0ccdb12d16557659794621c539d` |
| sequential coordinates `coords[i] = i + 1` (1..64), `KA-BLR` | `0xc6d24f076cb2698a493b46ffd17902444aff965138495c13ac2af76c55c1683c` |
| real ElGamal ciphertexts (`kc = 3`, vote for candidate 1, `H = 12345*G`, `r = 1001, 1002, 1003`, slots 3..15 padded), `KA-BLR` | `0xa43410c65c50a7fc9bf5dc1b02c814b0d157932c24923243185c44d59cc41404` |
| 16 padded slots, constituency `MH-MUM` | `0xd954a93f9f8c2d410a491f7459a1d587e9236fe89431e82e77ae6aec21f2fb1c` |
| 16 padded slots, `chainId = 1` | `0x0b9a3c458151a2c96932740695ba0feb058afda6c7e45f656b50877fe841977f` |
| 16 padded slots, `electionId` lowest bit flipped | `0x9e25873b7e05519b2ec54ea43709dbf5c133db7058901ecd08088af70ac705fa` |

The 64 coordinates of every ballot vector (decimal) are listed in `spec/vectors.json`.
