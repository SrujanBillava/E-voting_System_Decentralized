import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { TypedDataEncoder, Wallet, id } from "ethers";
import {
  BALLOT_AUTHORIZATION_TYPEHASH,
  BALLOT_AUTHORIZATION_TYPES,
  BALLOT_AUTHORIZATION_TYPE_STRING,
  buildBallotAuthorization,
  buildDomain,
  hashBallotAuthorization,
  recoverBallotAuthorizationSigner,
  signBallotAuthorization,
} from "../../src/chain/eip712.js";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { deriveNullifier } from "../../src/chain/nullifier.js";
import { hardhatAccount } from "../helpers/env.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";

const rand32 = () => "0x" + randomBytes(32).toString("hex");
const hashOnChain = (contract, m) => contract.hashAuthorization(m.constituencyId, m.nullifier, m.candidateId, m.relayer, m.deadline);

describe("EIP-712: backend (ethers) vs deployed contract (Solidity)", () => {
  let s;
  let domain;
  before(async () => {
    s = localServices();
    await assertPristineLocalChain(s);
    domain = s.domain;
  });
  after(() => s?.destroy());

  const message = (patch = {}) =>
    buildBallotAuthorization({
      electionId: s.deployment.electionId,
      constituencyId: constituencyIdOf("KA-BLR"),
      nullifier: deriveNullifier({ secret: Buffer.alloc(32, 7).map((_, i) => i + 1), electionId: s.deployment.electionId, voterUid: "voter-uid-0001" }),
      candidateId: 2n,
      relayer: s.signers.addresses.relayer,
      deadline: 4_000_000_000n,
      ...patch,
    });

  it("type hash: ethers TypedDataEncoder == contract.BALLOT_AUTHORIZATION_TYPEHASH()", async () => {
    const fromEncoder = id(TypedDataEncoder.from(BALLOT_AUTHORIZATION_TYPES).encodeType("BallotAuthorization"));
    const onChain = await s.contract.BALLOT_AUTHORIZATION_TYPEHASH();
    assert.equal(fromEncoder, onChain);
    assert.equal(BALLOT_AUTHORIZATION_TYPEHASH, onChain);
    assert.equal(id(BALLOT_AUTHORIZATION_TYPE_STRING), onChain);
  });

  it("domain: the contract's eip712Domain() equals the backend domain", async () => {
    const d = await s.contract.eip712Domain();
    assert.deepEqual(
      { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract },
      { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    );
  });

  it("digest: ethers TypedDataEncoder.hash == contract.hashAuthorization(...) for the reference message", async () => {
    const m = message();
    assert.equal(TypedDataEncoder.hash(domain, BALLOT_AUTHORIZATION_TYPES, m), await hashOnChain(s.contract, m));
    assert.equal(hashBallotAuthorization(domain, m), await hashOnChain(s.contract, m));
  });

  it("digest: identical for 40 random messages, including boundary candidate ids and deadlines", async () => {
    for (let i = 0; i < 40; i++) {
      const m = buildBallotAuthorization({
        electionId: s.deployment.electionId, // the contract hashes with its own immutable ELECTION_ID
        constituencyId: rand32(),
        nullifier: rand32(),
        candidateId: i === 0 ? 1n : i === 1 ? 2n ** 256n - 1n : BigInt("0x" + randomBytes(1 + (i % 31)).toString("hex")) || 1n,
        relayer: Wallet.createRandom().address,
        deadline: i === 2 ? 2n ** 256n - 1n : BigInt("0x" + randomBytes(1 + (i % 8)).toString("hex")) || 1n,
      });
      assert.equal(hashBallotAuthorization(domain, m), await hashOnChain(s.contract, m), `message #${i}`);
    }
  });

  describe("every signed field changes the digest, in both implementations", () => {
    const patches = {
      constituencyId: () => ({ constituencyId: constituencyIdOf("DL-DEL") }),
      nullifier: () => ({ nullifier: rand32() }),
      candidateId: () => ({ candidateId: 3n }),
      relayer: () => ({ relayer: hardhatAccount(4).address }),
      deadline: () => ({ deadline: 4_000_000_001n }),
    };
    for (const [field, make] of Object.entries(patches)) {
      it(`${field}`, async () => {
        const base = message();
        const changed = message(make());
        const [baseChain, changedChain] = [await hashOnChain(s.contract, base), await hashOnChain(s.contract, changed)];
        assert.notEqual(changedChain, baseChain);
        assert.equal(hashBallotAuthorization(domain, changed), changedChain);
      });
    }

    it("electionId (fixed per contract on-chain, so checked against the backend digest)", () => {
      assert.notEqual(hashBallotAuthorization(domain, message({ electionId: rand32() })), hashBallotAuthorization(domain, message()));
    });

    it("verifyingContract and chainId (a different domain can never match this contract's digests)", async () => {
      const onChain = await hashOnChain(s.contract, message());
      assert.notEqual(hashBallotAuthorization(buildDomain({ chainId: domain.chainId, verifyingContract: hardhatAccount(8).address }), message()), onChain);
      assert.notEqual(hashBallotAuthorization(buildDomain({ chainId: 1, verifyingContract: domain.verifyingContract }), message()), onChain);
      assert.notEqual(hashBallotAuthorization(buildDomain({ chainId: domain.chainId + 1n, verifyingContract: domain.verifyingContract }), message()), onChain);
    });
  });

  it("the authority signature recovers to the address the contract has as authoritySigner", async () => {
    const m = message();
    const signature = await signBallotAuthorization(s.signers.authority, domain, m);
    assert.equal(recoverBallotAuthorizationSigner(domain, m, signature), await s.contract.authoritySigner());
    assert.equal(recoverBallotAuthorizationSigner(domain, m, signature), s.signers.addresses.authority);
  });

  it("a nullifier derived by the backend is a valid non-zero bytes32 for the contract", () => {
    const n = message().nullifier;
    assert.match(n, /^0x[0-9a-f]{64}$/);
    assert.notEqual(BigInt(n), 0n);
  });
});

describe("EIP-712: the CONTRACT accepts and rejects backend-made signatures (read-only static calls)", () => {
  let s;
  before(async () => {
    s = localServices();
    await assertPristineLocalChain(s);
  });
  after(() => s?.destroy());

  const sign = async (patch = {}, { signer = s.signers.authority, dom = s.domain } = {}) => {
    const m = buildBallotAuthorization({
      electionId: s.deployment.electionId,
      constituencyId: constituencyIdOf("KA-BLR"),
      nullifier: deriveNullifier({ secret: Buffer.alloc(32, 9).map((_, i) => 200 - i), electionId: s.deployment.electionId, voterUid: "voter-uid-xyz" }),
      candidateId: 2n,
      relayer: s.signers.addresses.relayer,
      deadline: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
      ...patch,
    });
    return { m, signature: await signBallotAuthorization(signer, dom, m) };
  };
  const call = (m, signature, { from = s.signers.relayer, ...override } = {}) =>
    s.contract.connect(from).castVote.staticCall(override.constituencyId ?? m.constituencyId, override.nullifier ?? m.nullifier, override.candidateId ?? m.candidateId, override.deadline ?? m.deadline, signature);
  const revertName = async (promise) => {
    try {
      await promise;
    } catch (err) {
      return err.revert?.name ?? `UNDECODED:${err.code}`;
    }
    return "ACCEPTED";
  };

  it("in Setup the contract refuses all votes (WrongPhase), even with a perfect signature", async () => {
    const { m, signature } = await sign();
    assert.equal(await revertName(call(m, signature)), "WrongPhase");
  });

  it("once Open (inside a reverted snapshot): valid -> accepted; every tamper -> the exact expected custom error", async () => {
    const snap = await snapshot(s.provider);
    try {
      await (await s.contract.connect(s.signers.owner).openElection()).wait();
      assert.equal(Number(await s.contract.phase()), 1);

      const { m, signature } = await sign();
      assert.equal(await revertName(call(m, signature)), "ACCEPTED", "a backend-made authorization must be accepted by the contract");

      // candidateId is signed: swapping it breaks the signature
      assert.equal(await revertName(call(m, signature, { candidateId: 3n })), "InvalidAuthorizationSignature");
      // nullifier, deadline are signed
      assert.equal(await revertName(call(m, signature, { nullifier: rand32() })), "InvalidAuthorizationSignature");
      assert.equal(await revertName(call(m, signature, { deadline: m.deadline + 1n })), "InvalidAuthorizationSignature");
      // the relayer is signed: another relayer account cannot use it
      assert.equal(await revertName(call(m, signature, { from: s.signers.authority })), "NotRelayer");
      // signed by someone else / for another chain / for another contract
      assert.equal(await revertName(call(...Object.values(await sign({}, { signer: new Wallet(hardhatAccount(5).privateKey) })))), "InvalidAuthorizationSignature");
      assert.equal(await revertName(call(...Object.values(await sign({}, { dom: buildDomain({ chainId: 1, verifyingContract: s.domain.verifyingContract }) })))), "InvalidAuthorizationSignature");
      assert.equal(await revertName(call(...Object.values(await sign({}, { dom: buildDomain({ chainId: s.domain.chainId, verifyingContract: hardhatAccount(3).address }) })))), "InvalidAuthorizationSignature");
      // signed for another election id
      assert.equal(await revertName(call(...Object.values(await sign({ electionId: rand32() })))), "InvalidAuthorizationSignature");
      // candidate 8 belongs to Delhi: signed for Bengaluru it is rejected by the contract itself
      const crossed = await sign({ candidateId: 8n });
      assert.equal(await revertName(call(crossed.m, crossed.signature)), "CandidateConstituencyMismatch");
      // a properly signed authorization for the matching constituency is accepted
      const delhi = await sign({ constituencyId: constituencyIdOf("DL-DEL"), candidateId: 8n });
      assert.equal(await revertName(call(delhi.m, delhi.signature)), "ACCEPTED");
      // expired
      const expired = await sign({ deadline: 1n });
      assert.equal(await revertName(call(expired.m, expired.signature)), "AuthorizationExpired");
    } finally {
      await revertTo(s.provider, snap);
    }

    // static calls never count a ballot, and the snapshot restored the pristine Setup state
    assert.equal(Number(await s.contract.phase()), 0);
    assert.equal(await s.contract.totalBallots(), 0n);
  });
});
