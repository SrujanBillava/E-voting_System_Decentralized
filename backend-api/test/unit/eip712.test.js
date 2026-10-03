import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TypedDataEncoder, Wallet, ZeroAddress, id } from "ethers";
import { exportedEip712 } from "../../src/chain/abi.js";
import {
  BALLOT_AUTHORIZATION_TYPEHASH,
  BALLOT_AUTHORIZATION_TYPES,
  BALLOT_AUTHORIZATION_TYPE_STRING,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  buildBallotAuthorization,
  buildDomain,
  encodedTypeString,
  hashBallotAuthorization,
  recoverBallotAuthorizationSigner,
  signBallotAuthorization,
} from "../../src/chain/eip712.js";
import { constituencyIdOf, electionIdOf } from "../../src/chain/ids.js";
import { hardhatAccount } from "../helpers/env.js";

const EXACT_TYPE_STRING =
  "BallotAuthorization(bytes32 electionId,bytes32 constituencyId,bytes32 nullifier,uint256 candidateId,address relayer,uint256 deadline)";

const authority = new Wallet(hardhatAccount(1).privateKey);
const relayer = hardhatAccount(2).address;
const domain = buildDomain({ chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
const base = () =>
  buildBallotAuthorization({
    electionId: "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40",
    constituencyId: constituencyIdOf("KA-BLR"),
    nullifier: "0x" + "ab".repeat(32),
    candidateId: 3,
    relayer,
    deadline: 1_900_000_000,
  });

describe("eip712: one canonical definition", () => {
  it("the type string is exactly the protocol type string", () => {
    assert.equal(BALLOT_AUTHORIZATION_TYPE_STRING, EXACT_TYPE_STRING);
  });

  it("the typed-data field list encodes to that exact string, and hashes to the type hash", () => {
    assert.equal(encodedTypeString(), EXACT_TYPE_STRING);
    assert.equal(BALLOT_AUTHORIZATION_TYPEHASH, id(EXACT_TYPE_STRING));
    assert.equal(id(TypedDataEncoder.from(BALLOT_AUTHORIZATION_TYPES).encodeType("BallotAuthorization")), BALLOT_AUTHORIZATION_TYPEHASH);
  });

  it("agrees with the generated contract export (domain name, version, type string, fields)", () => {
    assert.equal(exportedEip712.domainName, EIP712_DOMAIN_NAME);
    assert.equal(exportedEip712.domainVersion, EIP712_DOMAIN_VERSION);
    assert.equal(exportedEip712.typeString, BALLOT_AUTHORIZATION_TYPE_STRING);
    assert.deepEqual(JSON.parse(JSON.stringify(BALLOT_AUTHORIZATION_TYPES)), exportedEip712.types);
  });

  it("the definition is immutable at runtime", () => {
    assert.ok(Object.isFrozen(BALLOT_AUTHORIZATION_TYPES.BallotAuthorization));
    assert.throws(() => BALLOT_AUTHORIZATION_TYPES.BallotAuthorization.push({ name: "x", type: "uint256" }), TypeError);
  });

  it("the domain is VoteChain / 2 / chainId / verifyingContract", () => {
    assert.deepEqual(domain, { name: "VoteChain", version: "2", chainId: 31337n, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
  });

  it("the signed message contains candidateId and exactly the six protocol fields", () => {
    assert.deepEqual(Object.keys(base()), ["electionId", "constituencyId", "nullifier", "candidateId", "relayer", "deadline"]);
  });
});

describe("eip712: input validation", () => {
  const good = { electionId: "0x" + "11".repeat(32), constituencyId: "0x" + "22".repeat(32), nullifier: "0x" + "33".repeat(32), candidateId: 1n, relayer, deadline: 100n };

  it("normalises numbers, strings and bigints for the uint256 fields", () => {
    const m = buildBallotAuthorization({ ...good, candidateId: "7", deadline: 1234 });
    assert.equal(m.candidateId, 7n);
    assert.equal(m.deadline, 1234n);
  });

  it("rejects malformed fields", () => {
    for (const patch of [
      { electionId: "0x12" },
      { constituencyId: "KA-BLR" },
      { nullifier: "0x" + "33".repeat(31) },
      { nullifier: "0x" + "00".repeat(32) }, // the contract rejects a zero nullifier
      { candidateId: 0n }, // candidate 0 is never valid
      { candidateId: -1 },
      { candidateId: 1.5 },
      { candidateId: "abc" },
      { candidateId: 2n ** 256n },
      { deadline: 0 },
      { deadline: -5 },
      { relayer: "0x123" },
      { relayer: ZeroAddress + "00" },
    ]) {
      assert.throws(() => buildBallotAuthorization({ ...good, ...patch }), (e) => e instanceof TypeError || e instanceof RangeError || /address|invalid/i.test(e.message), String(Object.keys(patch)));
    }
  });

  it("buildDomain validates its inputs", () => {
    assert.throws(() => buildDomain({ chainId: 0, verifyingContract: relayer }));
    assert.throws(() => buildDomain({ chainId: 1, verifyingContract: "0x12" }));
  });
});

describe("eip712: digest sensitivity (every field is bound)", () => {
  const baseDigest = hashBallotAuthorization(domain, base());

  it("the digest is deterministic and 32 bytes", () => {
    assert.equal(hashBallotAuthorization(domain, base()), baseDigest);
    assert.match(baseDigest, /^0x[0-9a-f]{64}$/);
  });

  const variants = {
    electionId: { electionId: "0x" + "99".repeat(32) },
    constituencyId: { constituencyId: constituencyIdOf("DL-DEL") },
    nullifier: { nullifier: "0x" + "cd".repeat(32) },
    candidateId: { candidateId: 4n },
    relayer: { relayer: hardhatAccount(3).address },
    deadline: { deadline: 1_900_000_001n },
  };
  for (const [field, patch] of Object.entries(variants)) {
    it(`changing ${field} changes the digest`, () => {
      assert.notEqual(hashBallotAuthorization(domain, { ...base(), ...patch }), baseDigest);
    });
  }

  it("a different verifyingContract or chainId changes the digest", () => {
    assert.notEqual(hashBallotAuthorization(buildDomain({ chainId: 31337, verifyingContract: hardhatAccount(5).address }), base()), baseDigest);
    assert.notEqual(hashBallotAuthorization(buildDomain({ chainId: 1, verifyingContract: domain.verifyingContract }), base()), baseDigest);
    assert.notEqual(hashBallotAuthorization(buildDomain({ chainId: 31338, verifyingContract: domain.verifyingContract }), base()), baseDigest);
  });

  it("a different domain name or version changes the digest", () => {
    assert.notEqual(hashBallotAuthorization({ ...domain, name: "VoteChain-V1" }, base()), baseDigest);
    assert.notEqual(hashBallotAuthorization({ ...domain, version: "1" }, base()), baseDigest);
  });
});

describe("eip712: signing", () => {
  it("the authority's signature is 65 bytes and recovers to the authority", async () => {
    const signature = await signBallotAuthorization(authority, domain, base());
    assert.match(signature, /^0x[0-9a-f]{130}$/);
    assert.equal(recoverBallotAuthorizationSigner(domain, base(), signature), authority.address);
  });

  it("a tampered message or domain does not recover to the authority", async () => {
    const signature = await signBallotAuthorization(authority, domain, base());
    assert.notEqual(recoverBallotAuthorizationSigner(domain, { ...base(), candidateId: 4n }, signature), authority.address);
    assert.notEqual(recoverBallotAuthorizationSigner(buildDomain({ chainId: 1, verifyingContract: domain.verifyingContract }), base(), signature), authority.address);
  });

  it("signing is deterministic (RFC 6979)", async () => {
    assert.equal(await signBallotAuthorization(authority, domain, base()), await signBallotAuthorization(authority, domain, base()));
  });
});

describe("eip712: known-answer vector", () => {
  // The digest below was produced by the DEPLOYED Solidity contract (Voting.hashAuthorization) for exactly
  // these inputs; the signature is the authority's deterministic (RFC 6979) signature over it. If either
  // changes, the backend and the contract no longer speak the same protocol.
  const vectorDomain = buildDomain({ chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
  const vectorMessage = buildBallotAuthorization({
    electionId: "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40",
    constituencyId: "0x75f991e87d3f7b7d5dc6818f5d1573a6d671f3a242e91e03133d7ef3a5e97eeb", // KA-BLR
    nullifier: "0x2031d99c0347c6a6d9d7482ef0786bf940b8aad23d2a8b51d53d45ce98099e54", // nullifier vector A
    candidateId: 2n,
    relayer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    deadline: 4_000_000_000n,
  });

  it("digest", () => {
    assert.equal(hashBallotAuthorization(vectorDomain, vectorMessage), "0xf21230d90641a02fca5e9614b002bfa46fb6a9c37c7d9e286c18cb27624d8e00");
  });

  it("authority signature", async () => {
    assert.equal(
      await signBallotAuthorization(authority, vectorDomain, vectorMessage),
      "0xe16d43b3c9ceeda2a3227ca07567852740869bc3970b978644757a1a2ff1906f327c7e1ac19708fc00bd5a4c00af9365721a85e5c66f9631b8c21688e48685f21c",
    );
  });
});

describe("ids", () => {
  it("constituencyIdOf is keccak256 of the UTF-8 code, case-sensitive", () => {
    assert.equal(constituencyIdOf("KA-BLR"), "0x75f991e87d3f7b7d5dc6818f5d1573a6d671f3a242e91e03133d7ef3a5e97eeb");
    assert.notEqual(constituencyIdOf("KA-BLR"), constituencyIdOf("ka-blr"));
    assert.notEqual(constituencyIdOf("KA-BLR"), constituencyIdOf("KA-BLR "));
    assert.throws(() => constituencyIdOf(""), TypeError);
    assert.throws(() => constituencyIdOf(undefined), TypeError);
  });

  it("electionIdOf reproduces the development election id", () => {
    assert.equal(electionIdOf("VOTECHAIN-DEMO-ELECTION-2026"), "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40");
  });
});

describe("eip712: strict input (nothing is coerced into a valid-looking authorization)", () => {
  const good = { electionId: "0x" + "11".repeat(32), constituencyId: "0x" + "22".repeat(32), nullifier: "0x" + "33".repeat(32), candidateId: 1n, relayer, deadline: 100n };

  it("hex is case-insensitive on input and always lowercase on output; the digest is the same", () => {
    const upper = buildBallotAuthorization({ ...good, electionId: "0x" + "AB".repeat(32), constituencyId: "0x" + "CD".repeat(32), nullifier: "0x" + "EF".repeat(32) });
    const lower = buildBallotAuthorization({ ...good, electionId: "0x" + "ab".repeat(32), constituencyId: "0x" + "cd".repeat(32), nullifier: "0x" + "ef".repeat(32) });
    assert.deepEqual(upper, lower);
    assert.equal(upper.electionId, "0x" + "ab".repeat(32));
    assert.equal(hashBallotAuthorization(domain, upper), hashBallotAuthorization(domain, lower));
  });

  it("the relayer is checksummed on output and a lowercase input is accepted", () => {
    assert.equal(buildBallotAuthorization({ ...good, relayer: relayer.toLowerCase() }).relayer, relayer);
    const wrongChecksum = relayer.replace(/[a-fA-F]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    assert.notEqual(wrongChecksum, relayer);
    assert.throws(() => buildBallotAuthorization({ ...good, relayer: wrongChecksum }), /checksum/);
  });

  it("rejects values that BigInt() would happily coerce", () => {
    for (const bad of [true, false, null, undefined, [7], ["7"], {}, " 12", "12 ", "0x10", "0b11", "1e3", "1_000", "+5", "-5", "07", "", "1.0", 1e21, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -0.5]) {
      assert.throws(() => buildBallotAuthorization({ ...good, candidateId: bad }), TypeError, `candidateId ${String(bad)}`);
      assert.throws(() => buildBallotAuthorization({ ...good, deadline: bad }), TypeError, `deadline ${String(bad)}`);
    }
    assert.throws(() => buildDomain({ chainId: true, verifyingContract: relayer }), TypeError);
    assert.throws(() => buildDomain({ chainId: "0x1", verifyingContract: relayer }), TypeError);
  });

  it("accepts bigint, safe integers and plain decimal strings, including the uint256 maximum", () => {
    const max = 2n ** 256n - 1n;
    for (const value of [5n, 5, "5"]) assert.equal(buildBallotAuthorization({ ...good, candidateId: value }).candidateId, 5n);
    assert.equal(buildBallotAuthorization({ ...good, candidateId: max }).candidateId, max);
    assert.equal(buildBallotAuthorization({ ...good, candidateId: max.toString() }).candidateId, max);
    assert.throws(() => buildBallotAuthorization({ ...good, candidateId: (max + 1n).toString() }), RangeError);
    assert.equal(buildDomain({ chainId: "31337", verifyingContract: relayer }).chainId, 31337n);
    assert.equal(buildDomain({ chainId: 2n ** 256n - 1n, verifyingContract: relayer }).chainId, 2n ** 256n - 1n);
    assert.throws(() => buildDomain({ chainId: 2n ** 256n, verifyingContract: relayer }), RangeError);
  });

  it("minimum values: candidateId and deadline start at 1, chainId at 1", () => {
    assert.equal(buildBallotAuthorization({ ...good, candidateId: 1n, deadline: 1n }).deadline, 1n);
    assert.throws(() => buildBallotAuthorization({ ...good, candidateId: 0n }), RangeError);
    assert.throws(() => buildBallotAuthorization({ ...good, deadline: 0n }), RangeError);
    assert.throws(() => buildBallotAuthorization({ ...good, nullifier: "0x" + "00".repeat(32) }), RangeError);
    assert.throws(() => buildDomain({ chainId: 0n, verifyingContract: relayer }), RangeError);
    assert.equal(buildDomain({ chainId: 1n, verifyingContract: relayer }).chainId, 1n);
  });
});

describe("eip712: hashing, signing and recovering validate their inputs themselves", () => {
  const goodMessage = () => base();
  const badMessages = {
    "candidateId 0": { candidateId: 0n },
    "zero nullifier": { nullifier: "0x" + "00".repeat(32) },
    "candidateId as boolean": { candidateId: true },
    "bad relayer": { relayer: "0x123" },
    "short election id": { electionId: "0x12" },
    "deadline 0": { deadline: 0n },
  };

  for (const [name, patch] of Object.entries(badMessages)) {
    it(`hash, sign and recover all refuse a message with ${name}`, async () => {
      const message = { ...goodMessage(), ...patch };
      const validSignature = await signBallotAuthorization(authority, domain, goodMessage()); // a REAL signature, so only the message can be at fault
      assert.throws(() => hashBallotAuthorization(domain, message));
      await assert.rejects(signBallotAuthorization(authority, domain, message));
      assert.throws(() => recoverBallotAuthorizationSigner(domain, message, validSignature));
    });
  }

  it("a message that is not normalised yet (strings, upper case) hashes and signs exactly like its normal form", async () => {
    const loose = { electionId: base().electionId.toUpperCase().replace("0X", "0x"), constituencyId: base().constituencyId, nullifier: base().nullifier, candidateId: "3", relayer: relayer.toLowerCase(), deadline: "1900000000" };
    assert.equal(hashBallotAuthorization(domain, loose), hashBallotAuthorization(domain, base()));
    assert.equal(await signBallotAuthorization(authority, domain, loose), await signBallotAuthorization(authority, domain, base()));
  });

  it("recover accepts a loose but valid message (decimal string) and gives the same signer as the normal form", async () => {
    const signature = await signBallotAuthorization(authority, domain, base());
    assert.equal(recoverBallotAuthorizationSigner(domain, { ...base(), candidateId: "3" }, signature), authority.address);
  });

  const brokenDomains = {
    "missing chainId": (d) => { const { chainId, ...rest } = d; return rest; },
    "missing verifyingContract": (d) => { const { verifyingContract, ...rest } = d; return rest; },
    "missing name": (d) => { const { name, ...rest } = d; return rest; },
    "missing version": (d) => { const { version, ...rest } = d; return rest; },
    "extra field (salt)": (d) => ({ ...d, salt: "0x" + "00".repeat(32) }),
    "chainId 0": (d) => ({ ...d, chainId: 0n }),
    "chainId not a number": (d) => ({ ...d, chainId: "mainnet" }),
    "verifyingContract not an address": (d) => ({ ...d, verifyingContract: "0x1234" }),
    "name not a string": (d) => ({ ...d, name: 5 }),
    "version not a string": (d) => ({ ...d, version: 2 }),
    "null domain": () => null,
    "no domain": () => undefined,
  };
  for (const [name, break_] of Object.entries(brokenDomains)) {
    it(`a domain with ${name} is refused by hash, sign and recover (a partial domain would sign for every chain or contract)`, async () => {
      const bad = break_(domain);
      const validSignature = await signBallotAuthorization(authority, domain, base()); // a REAL signature, so only the domain can be at fault
      assert.throws(() => hashBallotAuthorization(bad, base()));
      await assert.rejects(signBallotAuthorization(authority, bad, base()));
      assert.throws(() => recoverBallotAuthorizationSigner(bad, base(), validSignature));
    });
  }

  it("only the protocol domain (VoteChain / 2) can be signed, while hashing stays a pure function of any complete domain", async () => {
    await assert.rejects(signBallotAuthorization(authority, { ...domain, name: "OtherApp" }, base()), /not the VoteChain protocol domain/);
    await assert.rejects(signBallotAuthorization(authority, { ...domain, version: "1" }, base()), /not the VoteChain protocol domain/);
    assert.match(hashBallotAuthorization({ ...domain, name: "OtherApp" }, base()), /^0x[0-9a-f]{64}$/);
    assert.match(await signBallotAuthorization(authority, domain, base()), /^0x[0-9a-f]{130}$/);
  });
});


describe("eip712: recovery with a genuinely valid signature (Step 3 carryover)", () => {
  const message = () => buildBallotAuthorization({
    electionId: "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40",
    constituencyId: constituencyIdOf("KA-BLR"),
    nullifier: "0x2031d99c0347c6a6d9d7482ef0786bf940b8aad23d2a8b51d53d45ce98099e54",
    candidateId: 2n,
    relayer,
    deadline: 4_000_000_000n,
  });

  it("a valid signature over the complete valid domain and message recovers to exactly the authority", async () => {
    const m = message();
    const signature = await signBallotAuthorization(authority, domain, m);
    assert.equal(recoverBallotAuthorizationSigner(domain, m, signature), authority.address);
  });

  it("the SAME valid signature recovers to a different address under any tampered message or domain (so it is the inputs, not a broken signature, that change the result)", async () => {
    const m = message();
    const signature = await signBallotAuthorization(authority, domain, m);
    const others = [
      recoverBallotAuthorizationSigner(domain, { ...m, candidateId: 3n }, signature),
      recoverBallotAuthorizationSigner(domain, { ...m, nullifier: "0x" + "cd".repeat(32) }, signature),
      recoverBallotAuthorizationSigner(domain, { ...m, relayer: hardhatAccount(5).address }, signature),
      recoverBallotAuthorizationSigner(buildDomain({ chainId: 1, verifyingContract: domain.verifyingContract }), m, signature),
      recoverBallotAuthorizationSigner(buildDomain({ chainId: 31337, verifyingContract: hardhatAccount(5).address }), m, signature),
    ];
    for (const recovered of others) {
      assert.match(recovered, /^0x[0-9a-fA-F]{40}$/); // recovery itself succeeded...
      assert.notEqual(recovered, authority.address); // ...but not to the authority
    }
    assert.equal(new Set(others).size, others.length);
  });

  it("an incomplete domain is refused rather than silently verified", async () => {
    const m = message();
    const signature = await signBallotAuthorization(authority, domain, m);
    const { chainId, ...noChain } = domain;
    assert.throws(() => recoverBallotAuthorizationSigner(noChain, m, signature), TypeError);
    assert.throws(() => hashBallotAuthorization({ name: domain.name, version: domain.version }, m), TypeError);
    assert.ok(chainId);
  });
});
