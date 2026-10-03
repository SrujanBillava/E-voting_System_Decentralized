// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title Voting (VoteChain V2)
 * @notice One deployment is one election.
 *
 * Trust and privacy properties, stated plainly:
 *  - The contract enforces: lifecycle, one accepted ballot per nullifier, a single
 *    configured relayer, an authority-signed (EIP-712) authorization that is bound to
 *    election, constituency, nullifier, candidate, relayer, deadline, chain and contract,
 *    and that the candidate belongs to the signed constituency.
 *  - The contract does NOT hide the vote. The candidate id is plaintext in calldata, in the
 *    BallotCast event and in storage, so anyone can derive running totals while the
 *    election is Open. Hiding results before Closed is a policy of the off-chain app, not a
 *    property of this contract.
 *  - The authority key is trusted: it decides which nullifiers and candidates are
 *    authorized. A compromised authority key AND relayer key could stuff ballots.
 *  - No voter identity, biometric data or other PII is stored or emitted.
 */
contract Voting is Ownable2Step, EIP712 {
    // ------------------------------------------------------------------ types

    /// @dev Transitions are strictly monotonic: Setup -> Open -> Closed.
    enum ElectionPhase {
        Setup,
        Open,
        Closed
    }

    struct Constituency {
        string code;
        string name;
        bool exists;
    }

    struct Candidate {
        string name;
        bytes32 constituencyId;
        bool exists;
    }

    // --------------------------------------------------------------- constants

    /// @notice EIP-712 type hash of the signed ballot authorization.
    /// @dev `relayer` is the transaction sender (msg.sender); it is not a castVote parameter.
    bytes32 public constant BALLOT_AUTHORIZATION_TYPEHASH = keccak256(
        "BallotAuthorization(bytes32 electionId,bytes32 constituencyId,bytes32 nullifier,uint256 candidateId,address relayer,uint256 deadline)"
    );

    /// @notice Identifier of this election; part of every signed authorization.
    bytes32 public immutable ELECTION_ID;

    // ------------------------------------------------------------------ state

    ElectionPhase public phase;
    address public authoritySigner;
    address public relayer;

    // Constituencies
    mapping(bytes32 constituencyId => Constituency) private _constituencies;
    bytes32[] private _constituencyIds;
    /// @dev Number of constituencies that currently have no candidate. Makes openElection O(1).
    uint256 private _constituenciesWithoutCandidates;

    // Candidates (global ids, 1-based; id 0 is invalid)
    mapping(uint256 candidateId => Candidate) private _candidates;
    mapping(bytes32 constituencyId => uint256[]) private _candidateIdsOf;
    uint256 public candidateCount;

    // Ballots. _ballotIndexOf[nullifier] == 0 means unused; otherwise the 1-based ballot index.
    mapping(bytes32 nullifier => uint256) private _ballotIndexOf;
    mapping(uint256 candidateId => uint256) private _votes;
    mapping(bytes32 constituencyId => uint256) private _constituencyTotals;
    uint256 public totalBallots;

    // ----------------------------------------------------------------- events

    event ElectionDeployed(
        bytes32 indexed electionId,
        address indexed owner,
        address indexed authoritySigner,
        address relayer
    );
    event ConstituencyAdded(bytes32 indexed constituencyId, string code, string name);
    event CandidateAdded(uint256 indexed candidateId, bytes32 indexed constituencyId, string name);
    event AuthoritySignerChanged(address indexed previousSigner, address indexed newSigner);
    event RelayerChanged(address indexed previousRelayer, address indexed newRelayer);
    event ElectionOpened(uint256 constituencies, uint256 candidates);
    event ElectionClosed(uint256 totalBallots);
    event BallotCast(
        bytes32 indexed nullifier,
        bytes32 indexed constituencyId,
        uint256 indexed candidateId,
        uint256 ballotIndex
    );

    // ----------------------------------------------------------------- errors

    /// @param current The phase the contract is actually in.
    error WrongPhase(ElectionPhase current);
    error ZeroAddress();
    /// @dev Used for a zero election id (constructor) and a zero nullifier (castVote).
    error ZeroId();
    error BadCode();
    error BadName();
    error ConstituencyExists(bytes32 constituencyId);
    error UnknownConstituency(bytes32 constituencyId);
    error NothingToOpen();
    error ConstituencyHasNoCandidate(uint256 count);
    error NotRelayer(address caller);
    error NullifierAlreadyUsed(bytes32 nullifier);
    error AuthorizationExpired(uint256 deadline, uint256 currentTime);
    error InvalidCandidate(uint256 candidateId);
    error CandidateConstituencyMismatch(uint256 candidateId, bytes32 constituencyId);
    error InvalidAuthorizationSignature();
    error RenounceDisabled();

    // -------------------------------------------------------------- modifiers

    modifier onlyPhase(ElectionPhase required) {
        if (phase != required) revert WrongPhase(phase);
        _;
    }

    modifier notClosed() {
        if (phase == ElectionPhase.Closed) revert WrongPhase(phase);
        _;
    }

    // ------------------------------------------------------------ constructor

    constructor(address initialOwner, bytes32 electionId, address authority, address relayer_)
        Ownable(initialOwner)
        EIP712("VoteChain", "2")
    {
        if (electionId == bytes32(0)) revert ZeroId();
        if (authority == address(0) || relayer_ == address(0)) revert ZeroAddress();

        ELECTION_ID = electionId;
        authoritySigner = authority;
        relayer = relayer_;

        emit ElectionDeployed(electionId, initialOwner, authority, relayer_);
    }

    /// @notice Disabled: renouncing would leave the election permanently without an owner,
    ///         so nobody could ever close it.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ----------------------------------------------------- key rotation (owner)

    /// @notice Replace the authority signer. Signatures made by the previous signer stop
    ///         verifying immediately. Allowed in Setup and Open, never after Closed.
    function setAuthoritySigner(address newSigner) external onlyOwner notClosed {
        if (newSigner == address(0)) revert ZeroAddress();
        address previous = authoritySigner;
        authoritySigner = newSigner;
        emit AuthoritySignerChanged(previous, newSigner);
    }

    /// @notice Replace the relayer. The previous relayer can no longer call castVote and
    ///         authorizations signed for it stop verifying. Allowed in Setup and Open.
    function setRelayer(address newRelayer) external onlyOwner notClosed {
        if (newRelayer == address(0)) revert ZeroAddress();
        address previous = relayer;
        relayer = newRelayer;
        emit RelayerChanged(previous, newRelayer);
    }

    // --------------------------------------------------- configuration (Setup)

    /// @notice Create a constituency. Its canonical id is keccak256(bytes(code)).
    function addConstituency(string calldata code, string calldata name)
        external
        onlyOwner
        onlyPhase(ElectionPhase.Setup)
        returns (bytes32 constituencyId)
    {
        if (bytes(code).length == 0) revert BadCode();
        if (bytes(name).length == 0) revert BadName();

        constituencyId = keccak256(bytes(code));
        if (_constituencies[constituencyId].exists) revert ConstituencyExists(constituencyId);

        _constituencies[constituencyId] = Constituency({code: code, name: name, exists: true});
        _constituencyIds.push(constituencyId);
        _constituenciesWithoutCandidates++;

        emit ConstituencyAdded(constituencyId, code, name);
    }

    /// @notice Create a candidate in an existing constituency. Ids start at 1.
    /// @dev Identical names are allowed: identity is the candidate id, not the name.
    function addCandidate(bytes32 constituencyId, string calldata name)
        external
        onlyOwner
        onlyPhase(ElectionPhase.Setup)
        returns (uint256 candidateId)
    {
        if (!_constituencies[constituencyId].exists) revert UnknownConstituency(constituencyId);
        if (bytes(name).length == 0) revert BadName();

        candidateId = ++candidateCount;
        _candidates[candidateId] = Candidate({name: name, constituencyId: constituencyId, exists: true});

        uint256[] storage ids = _candidateIdsOf[constituencyId];
        if (ids.length == 0) _constituenciesWithoutCandidates--;
        ids.push(candidateId);

        emit CandidateAdded(candidateId, constituencyId, name);
    }

    // ------------------------------------------------------------- lifecycle

    /// @notice Freeze configuration and start voting.
    /// @dev authoritySigner and relayer are non-zero by construction (constructor and setters
    ///      reject address(0)), so they need no re-check here.
    function openElection() external onlyOwner onlyPhase(ElectionPhase.Setup) {
        uint256 constituencies = _constituencyIds.length;
        if (constituencies == 0) revert NothingToOpen();
        if (_constituenciesWithoutCandidates != 0) {
            revert ConstituencyHasNoCandidate(_constituenciesWithoutCandidates);
        }

        phase = ElectionPhase.Open;
        emit ElectionOpened(constituencies, candidateCount);
    }

    /// @notice Permanently stop voting. There is no way back.
    function closeElection() external onlyOwner onlyPhase(ElectionPhase.Open) {
        phase = ElectionPhase.Closed;
        emit ElectionClosed(totalBallots);
    }

    // ------------------------------------------------------------------ vote

    /**
     * @notice Record one ballot. Callable only by the configured relayer.
     * @dev The authority signs (ELECTION_ID, constituencyId, nullifier, candidateId, relayer,
     *      deadline) under this contract's EIP-712 domain. `relayer` is msg.sender.
     *
     *      Check order is deliberate: the nullifier-reuse check runs before the deadline
     *      check, so retrying an already-counted ballot after its authorization expired
     *      reports NullifierAlreadyUsed rather than AuthorizationExpired.
     */
    function castVote(
        bytes32 constituencyId,
        bytes32 nullifier,
        uint256 candidateId,
        uint256 deadline,
        bytes calldata signature
    ) external onlyPhase(ElectionPhase.Open) {
        if (msg.sender != relayer) revert NotRelayer(msg.sender);
        if (nullifier == bytes32(0)) revert ZeroId();
        if (_ballotIndexOf[nullifier] != 0) revert NullifierAlreadyUsed(nullifier);
        if (block.timestamp > deadline) revert AuthorizationExpired(deadline, block.timestamp);

        Candidate storage candidate = _candidates[candidateId];
        if (!candidate.exists) revert InvalidCandidate(candidateId);
        if (candidate.constituencyId != constituencyId) {
            revert CandidateConstituencyMismatch(candidateId, constituencyId);
        }

        bytes32 digest = _authorizationDigest(constituencyId, nullifier, candidateId, msg.sender, deadline);
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != authoritySigner) {
            revert InvalidAuthorizationSignature();
        }

        // Effects. There are no external calls in this function.
        uint256 ballotIndex = ++totalBallots;
        _ballotIndexOf[nullifier] = ballotIndex;
        _votes[candidateId]++;
        _constituencyTotals[constituencyId]++;

        emit BallotCast(nullifier, constituencyId, candidateId, ballotIndex);
    }

    // ---------------------------------------------------------- read: ballots

    function nullifierUsed(bytes32 nullifier) external view returns (bool) {
        return _ballotIndexOf[nullifier] != 0;
    }

    /// @notice 1-based ballot index of a consumed nullifier, or 0 if unused.
    function ballotIndexOf(bytes32 nullifier) external view returns (uint256) {
        return _ballotIndexOf[nullifier];
    }

    /// @notice EIP-712 digest the authority must sign for a given relayer. Exposed so
    ///         off-chain code can cross-check its typed-data encoding against this contract.
    function hashAuthorization(
        bytes32 constituencyId,
        bytes32 nullifier,
        uint256 candidateId,
        address relayer_,
        uint256 deadline
    ) external view returns (bytes32) {
        return _authorizationDigest(constituencyId, nullifier, candidateId, relayer_, deadline);
    }

    // ------------------------------------------------ read: configuration

    function constituencyCount() external view returns (uint256) {
        return _constituencyIds.length;
    }

    /// @notice Paginated constituency ids in creation order.
    function getConstituencyIds(uint256 offset, uint256 limit) external view returns (bytes32[] memory ids) {
        uint256 total = _constituencyIds.length;
        if (offset >= total) return ids;
        uint256 end = limit > total - offset ? total : offset + limit;
        ids = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _constituencyIds[i];
        }
    }

    function getConstituency(bytes32 constituencyId) external view returns (string memory code, string memory name) {
        Constituency storage c = _constituencies[constituencyId];
        if (!c.exists) revert UnknownConstituency(constituencyId);
        return (c.code, c.name);
    }

    function candidateCountOf(bytes32 constituencyId) external view returns (uint256) {
        if (!_constituencies[constituencyId].exists) revert UnknownConstituency(constituencyId);
        return _candidateIdsOf[constituencyId].length;
    }

    /// @notice Paginated candidate ids of a constituency in creation order.
    function getCandidateIdsByConstituency(bytes32 constituencyId, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids)
    {
        if (!_constituencies[constituencyId].exists) revert UnknownConstituency(constituencyId);
        uint256[] storage all = _candidateIdsOf[constituencyId];
        uint256 total = all.length;
        if (offset >= total) return ids;
        uint256 end = limit > total - offset ? total : offset + limit;
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = all[i];
        }
    }

    /// @notice Candidate metadata only (no tally).
    function getCandidate(uint256 candidateId) external view returns (string memory name, bytes32 constituencyId) {
        Candidate storage c = _candidates[candidateId];
        if (!c.exists) revert InvalidCandidate(candidateId);
        return (c.name, c.constituencyId);
    }

    // ------------------------------------------------------------ read: tally
    // Tallies are readable at any time. They are NOT confidential; see the contract notice.

    function votesOf(uint256 candidateId) external view returns (uint256) {
        if (!_candidates[candidateId].exists) revert InvalidCandidate(candidateId);
        return _votes[candidateId];
    }

    function constituencyTotal(bytes32 constituencyId) external view returns (uint256) {
        if (!_constituencies[constituencyId].exists) revert UnknownConstituency(constituencyId);
        return _constituencyTotals[constituencyId];
    }

    // --------------------------------------------------------------- internal

    function _authorizationDigest(
        bytes32 constituencyId,
        bytes32 nullifier,
        uint256 candidateId,
        address relayer_,
        uint256 deadline
    ) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    BALLOT_AUTHORIZATION_TYPEHASH,
                    ELECTION_ID,
                    constituencyId,
                    nullifier,
                    candidateId,
                    relayer_,
                    deadline
                )
            )
        );
    }
}
