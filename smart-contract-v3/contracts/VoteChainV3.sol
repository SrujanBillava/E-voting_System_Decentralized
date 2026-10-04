// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {ISemaphoreGroups} from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";
import {IBallotValidityVerifier} from "./interfaces/IBallotValidityVerifier.sol";
import {BabyJubJub} from "./libraries/BabyJubJub.sol";
import {V3Encodings} from "./libraries/V3Encodings.sol";

/**
 * @title VoteChainV3
 * @notice Privacy V3 contract layer: anonymous, encrypted, publicly verifiable ballots. ONE deployment is ONE election.
 *
 * What the contract enforces (and what it does not):
 *  - Lifecycle Setup -> Open -> Closed (no reopen). Commitment issuance can be closed first, ballots continue through a grace period.
 *  - One OFFICIAL Semaphore V4 group per constituency, with THIS contract as the only group admin. Commitments enter only through
 *    registerCommitmentBatch (authorised issuer, batched, at most one batch per constituency per 30 s epoch, capped by the registered-voter count).
 *    Nothing here exposes Semaphore's updateGroupAdmin / removeMember / updateMember.
 *  - submitBallot is PERMISSIONLESS (a relayer has no special authority). The contract itself fixes every security-critical input: the scope, the
 *    ballot hash (the Semaphore message), the election key H, the candidate count and the group. The caller supplies only the constituency, the two
 *    proofs, the nullifier (inside the Semaphore proof) and the encrypted slots.
 *  - Ballots are ElGamal ciphertexts over BabyJubJub. The contract keeps the running homomorphic sum per candidate slot (A = sum C1, B = sum C2)
 *    and emits every encrypted ballot so anybody can replay the sum. It never decrypts anything and holds no secret.
 *  - It does NOT verify that H lies in the prime-order subgroup (that needs a scalar multiplication, which is deliberately not implemented
 *    on-chain): the election-key ceremony must do that off-chain (privacy-v3 validatePublicKey) before setElectionKey.
 *  - Decryption, trustees and final results are NOT part of this phase.
 *
 * Frozen encodings (privacy-v3/ENCODINGS.md, vectors in privacy-v3/spec/vectors.json): see V3Encodings.
 */
contract VoteChainV3 is Ownable2Step {
    // ------------------------------------------------------------------ types

    enum Phase {
        Setup,
        Open,
        Closed
    }

    struct Constituency {
        bool exists;
        uint8 candidateCount; // K_c, 1..16
        string code;
        string name;
        uint256 groupId; // Semaphore group of this constituency
        uint256 registeredVoters; // issuance cap, fixed in Setup
        uint256 issued; // commitments registered so far
        uint256 ballots; // ballots recorded so far
        uint256 lastBatchEpochPlusOne; // 0 = never; otherwise (epoch of the last batch) + 1
    }

    /// @dev Encrypted running aggregate of one candidate slot: A = sum of the C1 points, B = sum of the C2 points. The neutral element is (0, 1), NOT (0, 0).
    struct Aggregate {
        uint256 ax;
        uint256 ay;
        uint256 bx;
        uint256 by;
    }

    /// @dev The caller-controlled part of a Semaphore proof. `message` and `scope` are NOT here: the contract computes them.
    struct MembershipProof {
        uint256 merkleTreeDepth; // must equal SEMAPHORE_DEPTH
        uint256 merkleTreeRoot; // current or recent root of the constituency group (Semaphore checks)
        uint256 nullifier; // election-wide, also the nullifier of the validity proof
        uint256[8] points; // packed Groth16 proof exactly as @semaphore-protocol/proof returns it
    }

    /// @dev Groth16 proof of the ballot-validity circuit. `b` is in the pairing-friendly order snarkjs' Solidity export expects
    ///      ([[pi_b[0][1], pi_b[0][0]], [pi_b[1][1], pi_b[1][0]]]).
    struct ValidityProof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    // -------------------------------------------------------------- constants

    uint256 public constant K_MAX = V3Encodings.K_MAX;
    uint256 public constant COORDS_PER_SLOT = V3Encodings.COORDS_PER_SLOT;
    uint256 public constant COORD_COUNT = V3Encodings.COORD_COUNT;
    /// @notice Every Semaphore proof must be generated at this declared depth (frozen architecture).
    uint256 public constant SEMAPHORE_DEPTH = 20;
    /// @notice A depth-20 tree holds at most 2^20 commitments, so no constituency may be registered with more voters than that.
    uint256 public constant MAX_REGISTERED_VOTERS = 1 << SEMAPHORE_DEPTH;
    /// @notice Issuance epoch length: at most one commitment batch per constituency per epoch.
    uint256 public constant EPOCH_SECONDS = 30;
    /// @notice How long Semaphore accepts proofs made against an older group root.
    uint256 public constant ROOT_WINDOW = 1 hours;
    /// @notice Most commitments per registerCommitmentBatch call. Measured (test/gas.test.js, local Osaka network): 128 commitments cost about 10.1M gas,
    ///         60% of the 2^24 per-transaction gas cap of Osaka (EIP-7825) and well inside a 30M block, with room for a deep tree (about 11M at depth 20).
    uint256 public constant MAX_BATCH = 128;

    // -------------------------------------------------------------- immutables

    ISemaphore public immutable semaphore;
    IBallotValidityVerifier public immutable validityVerifier;
    bytes32 public immutable ELECTION_ID;
    /// @notice Minimum time between closeIssuance and closeElection (ballots keep flowing in between).
    uint256 public immutable CLOSE_GRACE;

    // ------------------------------------------------------------------ state

    Phase public phase;
    address public issuer;
    bool public issuanceOpen;
    uint256 public issuanceClosedAt;

    uint256 public electionKeyX;
    uint256 public electionKeyY;
    bool public electionKeySet;

    mapping(bytes32 constituencyId => Constituency) private _constituencies;
    bytes32[] private _constituencyIds;
    mapping(bytes32 constituencyId => string[]) private _candidateNames;
    mapping(bytes32 constituencyId => Aggregate[16]) private _aggregates;
    /// @dev Number of constituencies that still have no candidate. Makes openElection O(1).
    uint256 private _constituenciesWithoutCandidates;

    mapping(uint256 commitment => bool) private _commitmentRegistered;
    mapping(uint256 nullifier => bool) private _nullifierUsed;
    uint256 public totalBallots;

    // ----------------------------------------------------------------- events

    event ConstituencyAdded(bytes32 indexed constituencyId, string code, string name, uint256 groupId, uint256 registeredVoters);
    event CandidateAdded(bytes32 indexed constituencyId, uint256 indexed slot, string name);
    event IssuerSet(address indexed previousIssuer, address indexed newIssuer);
    event ElectionKeySet(uint256 x, uint256 y);
    event ElectionOpened(uint256 constituencies, uint256 electionKeyX, uint256 electionKeyY, address issuer);
    event CommitmentBatchRegistered(
        bytes32 indexed constituencyId,
        uint256 indexed epoch,
        uint256 firstIndex,
        uint256 count,
        uint256 issuedTotal,
        uint256 merkleTreeRoot
    );
    event IssuanceClosed(uint256 closedAt);
    /// @dev The encrypted ballot, enough for an independent audit: the active slots' ciphertext coordinates (slot-major C1.x, C1.y, C2.x, C2.y) and the
    ///      ballot hash they were bound to. No voter identity, no commitment mapping, no plaintext vote, no randomness.
    event BallotRecorded(bytes32 indexed constituencyId, uint256 indexed nullifier, uint256 indexed ballotIndex, uint256 ballotHash, uint256[] coords);
    event ElectionClosed(uint256 totalBallots);

    // ----------------------------------------------------------------- errors

    error WrongPhase(Phase current);
    error ZeroAddress();
    error NotAContract(address account);
    error ZeroId();
    error EmptyString();
    error ConstituencyExists(bytes32 constituencyId);
    error UnknownConstituency(bytes32 constituencyId);
    error TooManyCandidates();
    error BadRegisteredVoters(uint256 value);
    error GroupAdminMismatch();
    error ElectionKeyInvalid();
    error ElectionKeyNotSet();
    error IssuerNotSet();
    error NothingToOpen();
    error ConstituencyHasNoCandidate(uint256 count);
    error NotIssuer(address caller);
    error IssuanceNotOpen();
    error IssuanceStillOpen();
    error GraceNotElapsed(uint256 earliestClose);
    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error BatchAlreadyThisEpoch(uint256 epoch);
    error InvalidCommitment(uint256 index);
    error DuplicateCommitment(uint256 commitment);
    error IssuedCapExceeded(uint256 issuedAfter, uint256 cap);
    error WrongSemaphoreDepth(uint256 given);
    error WrongCoordinateCount(uint256 expected, uint256 given);
    error NullifierOutOfField();
    error NullifierAlreadyUsed(uint256 nullifier);
    error CoordinateOutOfField(uint256 index);
    error IdentityC1(uint256 slot);
    error InvalidMembershipProof();
    error InvalidValidityProof();
    error RenounceDisabled();

    // ------------------------------------------------------------- modifiers

    modifier inPhase(Phase required) {
        if (phase != required) revert WrongPhase(phase);
        _;
    }

    // ------------------------------------------------------------ constructor

    /// @param initialOwner   configures Setup and runs the lifecycle (Ownable2Step).
    /// @param electionId     identifier of this election, part of the frozen scope and ballot hash.
    /// @param semaphore_     an OFFICIAL Semaphore V4 deployment. This contract creates its own groups there and is their only admin.
    /// @param verifier_      the Groth16 verifier generated from the frozen ballot-validity circuit.
    /// @param closeGrace_    seconds that must pass between closeIssuance and closeElection.
    constructor(address initialOwner, bytes32 electionId, ISemaphore semaphore_, IBallotValidityVerifier verifier_, uint256 closeGrace_)
        Ownable(initialOwner)
    {
        if (electionId == bytes32(0)) revert ZeroId();
        if (address(semaphore_) == address(0) || address(verifier_) == address(0)) revert ZeroAddress();
        if (address(semaphore_).code.length == 0) revert NotAContract(address(semaphore_));
        if (address(verifier_).code.length == 0) revert NotAContract(address(verifier_));
        ELECTION_ID = electionId;
        semaphore = semaphore_;
        validityVerifier = verifier_;
        CLOSE_GRACE = closeGrace_;
    }

    /// @notice Disabled: renouncing would leave the election without anybody able to run its lifecycle.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------- Setup (owner)

    /// @notice The only account allowed to register commitment batches during Open.
    function setIssuer(address newIssuer) external onlyOwner inPhase(Phase.Setup) {
        if (newIssuer == address(0)) revert ZeroAddress();
        address previous = issuer;
        issuer = newIssuer;
        emit IssuerSet(previous, newIssuer);
    }

    /// @notice Registers the election public key H. Checks that H is a canonical point ON the curve with x != 0 (so not the identity or the order-2 point).
    ///         Subgroup membership is NOT checkable here (no scalar multiplication on-chain): the key ceremony must verify it off-chain first.
    function setElectionKey(uint256 x, uint256 y) external onlyOwner inPhase(Phase.Setup) {
        if (x == 0 || !BabyJubJub.isOnCurve(x, y)) revert ElectionKeyInvalid();
        electionKeyX = x;
        electionKeyY = y;
        electionKeySet = true;
        emit ElectionKeySet(x, y);
    }

    /// @notice Adds a constituency (id = keccak256(bytes(code)), as in V2), creates its Semaphore group with THIS contract as admin, and fixes its issuance cap.
    function addConstituency(string calldata code, string calldata name, uint256 registeredVoters)
        external
        onlyOwner
        inPhase(Phase.Setup)
        returns (bytes32 constituencyId)
    {
        if (bytes(code).length == 0 || bytes(name).length == 0) revert EmptyString();
        if (registeredVoters == 0 || registeredVoters > MAX_REGISTERED_VOTERS) revert BadRegisteredVoters(registeredVoters);
        constituencyId = keccak256(bytes(code));
        Constituency storage c = _constituencies[constituencyId];
        if (c.exists) revert ConstituencyExists(constituencyId);

        uint256 groupId = semaphore.createGroup(address(this), ROOT_WINDOW);
        if (ISemaphoreGroups(address(semaphore)).getGroupAdmin(groupId) != address(this)) revert GroupAdminMismatch();

        c.exists = true;
        c.code = code;
        c.name = name;
        c.groupId = groupId;
        c.registeredVoters = registeredVoters;
        _constituencyIds.push(constituencyId);
        _constituenciesWithoutCandidates++;

        emit ConstituencyAdded(constituencyId, code, name, groupId, registeredVoters);
    }

    /// @notice Adds the next candidate slot (slot j = the j-th candidate of the constituency = position j of the one-hot vector) and initialises its
    ///         encrypted aggregate to the neutral element (0, 1) for both A and B.
    function addCandidate(bytes32 constituencyId, string calldata name) external onlyOwner inPhase(Phase.Setup) returns (uint256 slot) {
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        if (bytes(name).length == 0) revert EmptyString();
        slot = c.candidateCount;
        if (slot >= K_MAX) revert TooManyCandidates();

        if (slot == 0) _constituenciesWithoutCandidates--;
        c.candidateCount = uint8(slot + 1);
        _candidateNames[constituencyId].push(name);

        Aggregate storage a = _aggregates[constituencyId][slot];
        a.ay = 1; // A = (0, 1); ax is already 0
        a.by = 1; // B = (0, 1); bx is already 0

        emit CandidateAdded(constituencyId, slot, name);
    }

    /// @notice Setup -> Open. Needs an issuer, the election key, at least one constituency and at least one candidate in every constituency.
    function openElection() external onlyOwner inPhase(Phase.Setup) {
        if (issuer == address(0)) revert IssuerNotSet();
        if (!electionKeySet) revert ElectionKeyNotSet();
        uint256 n = _constituencyIds.length;
        if (n == 0) revert NothingToOpen();
        if (_constituenciesWithoutCandidates != 0) revert ConstituencyHasNoCandidate(_constituenciesWithoutCandidates);

        phase = Phase.Open;
        issuanceOpen = true;
        emit ElectionOpened(n, electionKeyX, electionKeyY, issuer);
    }

    // ------------------------------------------- commitment issuance (issuer)

    /// @notice Adds a batch of identity commitments to a constituency's Semaphore group. Only the issuer, only while issuance is open, at most one batch per
    ///         constituency per epoch, never more commitments than the constituency's registered-voter cap, every commitment unique election-wide.
    function registerCommitmentBatch(bytes32 constituencyId, uint256[] calldata commitments) external {
        if (msg.sender != issuer) revert NotIssuer(msg.sender);
        if (phase != Phase.Open) revert WrongPhase(phase);
        if (!issuanceOpen) revert IssuanceNotOpen();
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        uint256 count = commitments.length;
        if (count == 0) revert EmptyBatch();
        if (count > MAX_BATCH) revert BatchTooLarge(count);

        uint256 epoch = block.timestamp / EPOCH_SECONDS;
        if (c.lastBatchEpochPlusOne == epoch + 1) revert BatchAlreadyThisEpoch(epoch);

        uint256 firstIndex = c.issued;
        uint256 issuedAfter = firstIndex + count;
        if (issuedAfter > c.registeredVoters) revert IssuedCapExceeded(issuedAfter, c.registeredVoters);

        for (uint256 i = 0; i < count; ++i) {
            uint256 commitment = commitments[i];
            if (commitment == 0 || commitment >= BabyJubJub.P) revert InvalidCommitment(i);
            if (_commitmentRegistered[commitment]) revert DuplicateCommitment(commitment);
            _commitmentRegistered[commitment] = true;
        }
        c.issued = issuedAfter;
        c.lastBatchEpochPlusOne = epoch + 1;

        semaphore.addMembers(c.groupId, commitments);

        emit CommitmentBatchRegistered(
            constituencyId, epoch, firstIndex, count, issuedAfter, ISemaphoreGroups(address(semaphore)).getMerkleTreeRoot(c.groupId)
        );
    }

    /// @notice Stops commitment issuance. Ballots continue until closeElection (after CLOSE_GRACE), so voters who already hold a credential can still vote.
    function closeIssuance() external onlyOwner inPhase(Phase.Open) {
        if (!issuanceOpen) revert IssuanceNotOpen();
        issuanceOpen = false;
        issuanceClosedAt = block.timestamp;
        emit IssuanceClosed(block.timestamp);
    }

    /// @notice Open -> Closed, permanently: no reopen, no more issuance, no more ballots.
    function closeElection() external onlyOwner inPhase(Phase.Open) {
        if (issuanceOpen) revert IssuanceStillOpen();
        uint256 earliest = issuanceClosedAt + CLOSE_GRACE;
        if (block.timestamp < earliest) revert GraceNotElapsed(earliest);
        phase = Phase.Closed;
        emit ElectionClosed(totalBallots);
    }

    // ----------------------------------------------------- ballot submission

    /**
     * @notice Records one anonymous encrypted ballot. PERMISSIONLESS: anybody (a relayer, the voter) may submit it.
     * @param constituencyId  which constituency's ballot and group this is for.
     * @param membership      Semaphore proof (depth, root, nullifier, packed points). The message and the scope are computed HERE.
     * @param coords          the ciphertext coordinates of the ACTIVE slots only, slot-major (C1.x, C1.y, C2.x, C2.y), 4 * K_c values.
     * @param validity        Groth16 proof that the ciphertexts encrypt a valid one-hot vote.
     *
     * Checks, in this order, with NO state change before all of them pass:
     *  1 phase Open; 2 constituency exists; 3 shape (coordinate count, declared depth); 4 nullifier is a field element and unused election-wide;
     *  5 every coordinate is a field element; 6 no active C1 is the identity; 7 canonical padded uint256[64]; 8 ballot hash (frozen encoding);
     *  9 Semaphore verifyProof (this constituency's group, the contract's scope, the contract's ballot hash; never validateProof);
     *  10 Groth16 over [nullifier, K_c, H.x, H.y, 64 coordinates] built from storage and the padded coordinates;
     *  11 the SAME nullifier in both proofs (one value feeds both statements); then 12 nullifier used, 13 aggregate, 14 counters, 15 event.
     */
    function submitBallot(bytes32 constituencyId, MembershipProof calldata membership, uint256[] calldata coords, ValidityProof calldata validity)
        external
        returns (uint256 ballotIndex)
    {
        // 1-2
        if (phase != Phase.Open) revert WrongPhase(phase);
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        uint256 kc = c.candidateCount;
        // 3
        if (coords.length != kc * COORDS_PER_SLOT) revert WrongCoordinateCount(kc * COORDS_PER_SLOT, coords.length);
        if (membership.merkleTreeDepth != SEMAPHORE_DEPTH) revert WrongSemaphoreDepth(membership.merkleTreeDepth);
        // 4
        if (membership.nullifier >= BabyJubJub.P) revert NullifierOutOfField();
        if (_nullifierUsed[membership.nullifier]) revert NullifierAlreadyUsed(membership.nullifier);
        // 5-6
        _checkCoordinates(coords, kc);
        // 7-8
        uint256[64] memory padded = _paddedCoordinates(coords, kc);
        uint256 hash = V3Encodings.ballotHash(block.chainid, address(this), ELECTION_ID, constituencyId, padded);
        // 9
        _verifyMembership(c.groupId, membership, hash);
        // 10-11
        _verifyValidity(membership.nullifier, kc, padded, validity);
        // 12-15: only now does state change
        ballotIndex = _record(constituencyId, c, membership.nullifier, hash, coords, kc);
    }

    // ------------------------------------------------------------------ views

    /// @notice The election-wide Semaphore scope, computed from the chain id and this contract's address: the frozen keccak rule.
    function scope() public view returns (uint256) {
        return V3Encodings.scope(block.chainid, address(this), ELECTION_ID);
    }

    /// @notice The ballot hash this contract would compute for `constituencyId` and the given ACTIVE-slot coordinates (padded with identity ciphertexts).
    ///         A convenience for clients and audits; submitBallot computes the same value itself and never trusts a caller-supplied hash.
    function ballotHashOf(bytes32 constituencyId, uint256[] calldata activeCoords) external view returns (uint256) {
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        uint256 kc = c.candidateCount;
        if (activeCoords.length != kc * COORDS_PER_SLOT) revert WrongCoordinateCount(kc * COORDS_PER_SLOT, activeCoords.length);
        return V3Encodings.ballotHash(block.chainid, address(this), ELECTION_ID, constituencyId, _paddedCoordinates(activeCoords, kc));
    }

    function constituencyCount() external view returns (uint256) {
        return _constituencyIds.length;
    }

    function constituencyIdAt(uint256 index) external view returns (bytes32) {
        return _constituencyIds[index];
    }

    function getConstituency(bytes32 constituencyId)
        external
        view
        returns (string memory code, string memory name, uint256 groupId, uint256 registeredVoters, uint256 issued, uint256 ballots, uint256 candidateCount)
    {
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        return (c.code, c.name, c.groupId, c.registeredVoters, c.issued, c.ballots, c.candidateCount);
    }

    function candidateName(bytes32 constituencyId, uint256 slot) external view returns (string memory) {
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        return _candidateNames[constituencyId][slot];
    }

    /// @notice The encrypted running aggregate of one candidate slot: A = sum of the C1 points, B = sum of the C2 points. Starts at (0,1) / (0,1).
    function aggregateOf(bytes32 constituencyId, uint256 slot) external view returns (uint256 ax, uint256 ay, uint256 bx, uint256 by) {
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        if (slot >= c.candidateCount) revert TooManyCandidates();
        Aggregate storage a = _aggregates[constituencyId][slot];
        return (a.ax, a.ay, a.bx, a.by);
    }

    function nullifierUsed(uint256 nullifier) external view returns (bool) {
        return _nullifierUsed[nullifier];
    }

    function commitmentRegistered(uint256 commitment) external view returns (bool) {
        return _commitmentRegistered[commitment];
    }

    // --------------------------------------------------------------- internals

    /// @dev Steps 5 and 6: every coordinate is a canonical field element, and no ACTIVE C1 is the identity (C1 = r*G = identity would mean r = 0 and put the
    ///      plaintext in the clear).
    function _checkCoordinates(uint256[] calldata coords, uint256 kc) private pure {
        uint256 n = coords.length;
        for (uint256 i = 0; i < n; ++i) {
            if (coords[i] >= BabyJubJub.P) revert CoordinateOutOfField(i);
        }
        for (uint256 j = 0; j < kc; ++j) {
            if (BabyJubJub.isIdentity(coords[j * COORDS_PER_SLOT], coords[j * COORDS_PER_SLOT + 1])) revert IdentityC1(j);
        }
    }

    /// @dev Step 7: the canonical uint256[64]: the active slots as submitted, every padded slot the identity ciphertext (C1 = (0,1), C2 = (0,1)).
    function _paddedCoordinates(uint256[] calldata coords, uint256 kc) private pure returns (uint256[64] memory padded) {
        uint256 active = kc * COORDS_PER_SLOT;
        for (uint256 i = 0; i < active; ++i) padded[i] = coords[i];
        for (uint256 j = kc; j < K_MAX; ++j) {
            padded[j * COORDS_PER_SLOT + 1] = 1;
            padded[j * COORDS_PER_SLOT + 3] = 1;
        }
    }

    /// @dev Step 9. Semaphore's verifyProof (NOT validateProof): this constituency's group, the contract's scope, the contract's ballot hash as message.
    ///      It reverts for an unknown/expired root and returns false for a bad proof.
    function _verifyMembership(uint256 groupId, MembershipProof calldata m, uint256 hash) private view {
        ISemaphore.SemaphoreProof memory proof = ISemaphore.SemaphoreProof({
            merkleTreeDepth: m.merkleTreeDepth,
            merkleTreeRoot: m.merkleTreeRoot,
            nullifier: m.nullifier,
            message: hash,
            scope: scope(),
            points: m.points
        });
        if (!semaphore.verifyProof(groupId, proof)) revert InvalidMembershipProof();
    }

    /// @dev Steps 10-11. The 68 public signals are built here from the same nullifier as the Semaphore proof, K_c and H from storage and the padded
    ///      coordinates: nothing in the statement comes from the caller except the ciphertexts themselves.
    function _verifyValidity(uint256 nullifier, uint256 kc, uint256[64] memory padded, ValidityProof calldata v) private view {
        uint256[68] memory signals;
        signals[0] = nullifier;
        signals[1] = kc;
        signals[2] = electionKeyX;
        signals[3] = electionKeyY;
        for (uint256 i = 0; i < COORD_COUNT; ++i) signals[4 + i] = padded[i];
        if (!validityVerifier.verifyProof(v.a, v.b, v.c, signals)) revert InvalidValidityProof();
    }

    /// @dev Steps 12-15.
    function _record(bytes32 constituencyId, Constituency storage c, uint256 nullifier, uint256 hash, uint256[] calldata coords, uint256 kc)
        private
        returns (uint256 ballotIndex)
    {
        _nullifierUsed[nullifier] = true; // 12

        Aggregate[16] storage aggregates = _aggregates[constituencyId]; // 13: only point additions, never a scalar multiplication
        for (uint256 j = 0; j < kc; ++j) {
            Aggregate storage a = aggregates[j];
            uint256 o = j * COORDS_PER_SLOT;
            (a.ax, a.ay) = BabyJubJub.add(a.ax, a.ay, coords[o], coords[o + 1]);
            (a.bx, a.by) = BabyJubJub.add(a.bx, a.by, coords[o + 2], coords[o + 3]);
        }

        c.ballots += 1; // 14
        ballotIndex = ++totalBallots;

        emit BallotRecorded(constituencyId, nullifier, ballotIndex, hash, coords); // 15
    }
}
