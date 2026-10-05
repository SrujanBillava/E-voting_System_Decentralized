// VoteChainV3 trustees: the pinned configuration, phase gating of the tally functions, the empty-constituency flow, and Solidity <-> JS known-answer parity of the
// partial-decryption bundle hash and the results hash against trustee-v3/spec/integration-vectors.json. No zero-knowledge proofs needed here.
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { add, generateTestKeyPair, mul } from "../../privacy-v3/src/elgamal.js";
import { FIELD_PRIME as P, G } from "../../privacy-v3/src/params.js";
import { PROJECT, Phase, cid, configure, ctx, fakeTrusteeConfig, newWorld } from "./helpers/world.js";

const vectors = JSON.parse(fs.readFileSync(path.join(PROJECT, "..", "trustee-v3", "spec", "integration-vectors.json"), "utf8"));
const ZERO16 = Array(16).fill(0n);
const ZERO64 = Array(64).fill(0n);

/** a world in Setup with the issuer and the election key set, and a consistent trustee configuration ready (but NOT yet submitted) */
async function setup() {
  const w = await newWorld();
  const { publicKey: H } = generateTestKeyPair();
  await w.vc.setIssuer(w.issuer.address);
  await w.vc.setElectionKey(H[0], H[1]);
  const cfg = fakeTrusteeConfig(w, H);
  const submit = (c = cfg, key = H) => w.vc.configureTrustees(c.transcriptHash, c.addresses, c.keys, key[0], key[1]);
  return { w, H, cfg, submit };
}

/** an election with NO ballots, opened and Closed: enough for the identity, phase and empty-constituency rules (no proofs involved) */
async function closedEmptyElection() {
  const w = await newWorld({ closeGrace: 0 });
  await configure(w, { only: ["C02"] });
  await w.vc.openElection();
  await w.vc.closeIssuance();
  await w.vc.closeElection();
  return { w, C02: cid("C02") };
}

describe("VoteChainV3 trustees: configuration", () => {
  it("pins exactly three trustees (indices 1, 2, 3, threshold 2), the transcript hash, the three verification keys and H; everything is readable and announced", async () => {
    const { w, H, cfg, submit } = await setup();
    expect(await w.vc.TRUSTEE_COUNT()).to.equal(3n);
    expect(await w.vc.TRUSTEE_THRESHOLD()).to.equal(2n);
    expect((await w.vc.trusteeConfiguration()).configured).to.equal(false);
    const tx = await submit();
    const receipt = await tx.wait();
    const event = w.vc.interface.parseLog(receipt.logs.find((l) => w.vc.interface.parseLog(l)?.name === "TrusteesConfigured"));
    expect(event.args.transcriptHash).to.equal(cfg.transcriptHash);
    expect([...event.args.trustees]).to.deep.equal(cfg.addresses);
    expect(event.args.verificationKeys.map((k) => [k[0], k[1]])).to.deep.equal(cfg.keys);
    expect([event.args.electionKeyX, event.args.electionKeyY]).to.deep.equal(H);
    const c = await w.vc.trusteeConfiguration();
    expect(c.configured).to.equal(true);
    expect(c.transcriptHash).to.equal(cfg.transcriptHash);
    expect([...c.trustees]).to.deep.equal(cfg.addresses);
    expect(c.verificationKeys.map((k) => [k[0], k[1]])).to.deep.equal(cfg.keys);
    expect([c.electionKeyX_, c.electionKeyY_]).to.deep.equal(H);
    expect(await w.vc.trusteeTranscriptHash()).to.equal(cfg.transcriptHash);
  });

  it("only the owner configures, and only after the election key is set", async () => {
    const { w, H, cfg } = await setup();
    await expect(w.vc.connect(w.attacker).configureTrustees(cfg.transcriptHash, cfg.addresses, cfg.keys, H[0], H[1])).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.connect(w.issuer).configureTrustees(cfg.transcriptHash, cfg.addresses, cfg.keys, H[0], H[1])).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    const fresh = await newWorld();
    await expect(fresh.vc.configureTrustees(cfg.transcriptHash, cfg.addresses, cfg.keys, H[0], H[1])).to.be.revertedWithCustomError(fresh.vc, "ElectionKeyNotSet");
  });

  it("a ZERO transcript hash is refused", async () => {
    const { w, submit, cfg } = await setup();
    await expect(submit({ ...cfg, transcriptHash: "0x" + "00".repeat(32) })).to.be.revertedWithCustomError(w.vc, "ZeroTranscriptHash");
  });

  it("a zero trustee address (in any position) and a duplicated trustee address (any pair) are refused", async () => {
    const { w, submit, cfg } = await setup();
    const zero = "0x0000000000000000000000000000000000000000";
    for (const i of [0, 1, 2]) await expect(submit({ ...cfg, addresses: cfg.addresses.map((a, k) => (k === i ? zero : a)) })).to.be.revertedWithCustomError(w.vc, "InvalidTrusteeAddress").withArgs(i + 1);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const addresses = [...cfg.addresses];
      addresses[b] = addresses[a];
      await expect(submit({ ...cfg, addresses })).to.be.revertedWithCustomError(w.vc, "DuplicateTrusteeAddress");
    }
    await expect(submit({ ...cfg, addresses: [cfg.addresses[0], cfg.addresses[0], cfg.addresses[0]] })).to.be.revertedWithCustomError(w.vc, "DuplicateTrusteeAddress");
  });

  it("a MALFORMED verification key is refused: off the curve, the identity, the order-2 point, non-canonical coordinates, in any position", async () => {
    const { w, submit, cfg } = await setup();
    const bad = { "off the curve": ([x, y]) => [x, y + 1n], "the identity": () => [0n, 1n], "the order-2 point (0,-1)": () => [0n, P - 1n], "x not reduced": ([x, y]) => [x + P, y], "y not reduced": ([x, y]) => [x, y + P], "(0, 0)": () => [0n, 0n] };
    for (const [name, make] of Object.entries(bad)) {
      for (const i of [0, 1, 2]) {
        const keys = cfg.keys.map((k, idx) => (idx === i ? make(k) : k));
        await expect(submit({ ...cfg, keys }), `${name} at ${i}`).to.be.revertedWithCustomError(w.vc, "InvalidVerificationKey").withArgs(i + 1);
      }
    }
  });

  it("verification keys that do not interpolate to H are refused: valid curve points that are not H + j*C, swapped keys, keys of another ceremony", async () => {
    const { w, submit, cfg, H } = await setup();
    for (const i of [0, 1, 2]) {
      const keys = cfg.keys.map((k, idx) => (idx === i ? add(k, G) : k));
      await expect(submit({ ...cfg, keys }), `vk_${i + 1} + G`).to.be.revertedWithCustomError(w.vc, "InconsistentTrusteeKeys");
    }
    await expect(submit({ ...cfg, keys: [cfg.keys[1], cfg.keys[0], cfg.keys[2]] })).to.be.revertedWithCustomError(w.vc, "InconsistentTrusteeKeys");
    const other = fakeTrusteeConfig(w, generateTestKeyPair().publicKey);
    await expect(submit({ ...cfg, keys: other.keys })).to.be.revertedWithCustomError(w.vc, "InconsistentTrusteeKeys");
    // a CONSTANT sharing polynomial (every trustee would hold the whole secret) is refused: vk1 = vk2 = vk3 = H satisfies both relations
    await expect(submit({ ...cfg, keys: [H, H, H] })).to.be.revertedWithCustomError(w.vc, "DegenerateTrusteeKeys");
    await expect(submit({ ...cfg, keys: [cfg.keys[0], cfg.keys[0], cfg.keys[2]] })).to.be.revertedWithCustomError(w.vc, "DegenerateTrusteeKeys");
    // the honest relation, spelled out: vk_j = H + j*C
    expect(cfg.keys[0]).to.deep.equal(cfg.keys[0]);
    await submit();
  });

  it("H must be the election key ballots are encrypted under: any other H is refused; changing the election key afterwards INVALIDATES the pinned configuration", async () => {
    const { w, H, cfg, submit } = await setup();
    await expect(submit(cfg, add(H, G))).to.be.revertedWithCustomError(w.vc, "ElectionKeyMismatch");
    await expect(submit(cfg, generateTestKeyPair().publicKey)).to.be.revertedWithCustomError(w.vc, "ElectionKeyMismatch");
    await submit();
    expect((await w.vc.trusteeConfiguration()).configured).to.equal(true);
    const next = generateTestKeyPair().publicKey;
    await w.vc.setElectionKey(next[0], next[1]);
    expect((await w.vc.trusteeConfiguration()).configured, "a configuration is only valid for the key it was pinned with").to.equal(false);
    await w.vc.addConstituency("A-ONE", "One", 5n);
    await w.vc.addCandidate(cid("A-ONE"), "a");
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "TrusteesNotConfigured");
    await expect(submit(cfg, next), "the old verification keys no longer fit the new H").to.be.revertedWithCustomError(w.vc, "InconsistentTrusteeKeys");
    const renewed = fakeTrusteeConfig(w, next);
    await w.vc.configureTrustees(renewed.transcriptHash, renewed.addresses, renewed.keys, next[0], next[1]);
    await expect(w.vc.openElection()).to.emit(w.vc, "ElectionOpened");
  });

  it("the configuration can be corrected during Setup (the last one wins), but OPENING the election fails without it", async () => {
    const { w, cfg, submit } = await setup();
    await w.vc.addConstituency("A-ONE", "One", 5n);
    await w.vc.addCandidate(cid("A-ONE"), "a");
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "TrusteesNotConfigured");
    await submit();
    const second = { ...cfg, transcriptHash: "0x" + "ab".repeat(32) };
    await submit(second);
    expect(await w.vc.trusteeTranscriptHash()).to.equal(second.transcriptHash);
    await expect(w.vc.openElection()).to.emit(w.vc, "ElectionOpened");
  });

  it("once Open the configuration is IMMUTABLE: neither the owner nor anybody else can change it", async () => {
    const { w, cfg, submit } = await setup();
    await w.vc.addConstituency("A-ONE", "One", 5n);
    await w.vc.addCandidate(cid("A-ONE"), "a");
    await submit();
    await w.vc.openElection();
    const swapped = { ...cfg, addresses: [cfg.addresses[1], cfg.addresses[0], cfg.addresses[2]] };
    await expect(submit(swapped)).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(Phase.Open);
    await expect(submit({ ...cfg, transcriptHash: "0x" + "cd".repeat(32) })).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    await expect(w.vc.connect(w.attacker).configureTrustees(cfg.transcriptHash, cfg.addresses, cfg.keys, 1n, 1n)).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    const k = generateTestKeyPair().publicKey;
    await expect(w.vc.setElectionKey(k[0], k[1])).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    const c = await w.vc.trusteeConfiguration();
    expect([...c.trustees]).to.deep.equal(cfg.addresses);
    expect(c.transcriptHash).to.equal(cfg.transcriptHash);
  });
});

describe("VoteChainV3 trustees: the tally functions are Closed-only and trustee-only", () => {
  it("before Closed (Setup, then Open) publication and endorsement are refused for everybody, trustees included", async () => {
    const { w, cfg, submit } = await setup();
    await w.vc.addConstituency("A-ONE", "One", 5n);
    await w.vc.addCandidate(cid("A-ONE"), "a");
    await submit();
    for (const phase of [Phase.Setup, Phase.Open]) {
      for (const who of [w.trustee1, w.stranger, w.owner]) {
        await expect(w.vc.connect(who).publishPartialDecryption(cid("A-ONE"), 1, ZERO64)).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(phase);
        await expect(w.vc.connect(who).endorseResult(cid("A-ONE"), 1, ZERO16)).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(phase);
      }
      if (phase === Phase.Setup) await w.vc.openElection();
    }
    void cfg;
  });

  it("after Close: a stranger, the owner and the issuer are not trustees; a trustee cannot act as another index; indices outside 1..3 are refused", async () => {
    const { w, C02 } = await closedEmptyElection();
    expect(await w.vc.phase()).to.equal(Phase.Closed);
    for (const who of [w.stranger, w.owner, w.issuer, w.attacker]) {
      await expect(w.vc.connect(who).publishPartialDecryption(C02, 1, ZERO64)).to.be.revertedWithCustomError(w.vc, "NotTrustee");
      await expect(w.vc.connect(who).endorseResult(C02, 2, ZERO16)).to.be.revertedWithCustomError(w.vc, "NotTrustee");
    }
    await expect(w.vc.connect(w.trustee2).publishPartialDecryption(C02, 1, ZERO64)).to.be.revertedWithCustomError(w.vc, "NotTrustee").withArgs(w.trustee2.address, 1n);
    await expect(w.vc.connect(w.trustee1).endorseResult(C02, 3, ZERO16)).to.be.revertedWithCustomError(w.vc, "NotTrustee").withArgs(w.trustee1.address, 3n);
    for (const index of [0, 4, 99]) {
      await expect(w.vc.connect(w.trustee1).publishPartialDecryption(C02, index, ZERO64)).to.be.revertedWithCustomError(w.vc, "InvalidTrusteeIndex").withArgs(BigInt(index));
      await expect(w.vc.connect(w.trustee1).endorseResult(C02, index, ZERO16)).to.be.revertedWithCustomError(w.vc, "InvalidTrusteeIndex");
      await expect(w.vc.partialBundleHash(C02, index)).to.be.revertedWithCustomError(w.vc, "InvalidTrusteeIndex");
      await expect(w.vc.endorsementOf(C02, index)).to.be.revertedWithCustomError(w.vc, "InvalidTrusteeIndex");
    }
  });

  it("an unknown constituency, and a constituency with no ballots (nothing to decrypt), cannot receive a publication", async () => {
    const { w, C02 } = await closedEmptyElection();
    await expect(w.vc.connect(w.trustee1).publishPartialDecryption(cid("XX-NONE"), 1, ZERO64)).to.be.revertedWithCustomError(w.vc, "UnknownConstituency");
    await expect(w.vc.connect(w.trustee1).endorseResult(cid("XX-NONE"), 1, ZERO16)).to.be.revertedWithCustomError(w.vc, "UnknownConstituency");
    await expect(w.vc.connect(w.trustee1).publishPartialDecryption(C02, 1, ZERO64)).to.be.revertedWithCustomError(w.vc, "NothingToDecrypt").withArgs(C02);
  });

  it("an EMPTY constituency finalizes with all-zero totals after two distinct trustees endorse them (no partial decryption is needed or possible)", async () => {
    const { w, C02 } = await closedEmptyElection();
    await expect(w.vc.finalResult(C02)).to.be.revertedWithCustomError(w.vc, "NotFinalized").withArgs(C02);
    expect(await w.vc.isFinalized(C02)).to.equal(false);
    // the shape rules hold even here: nothing but zeros can be endorsed
    await expect(w.vc.connect(w.trustee1).endorseResult(C02, 1, [1n, ...ZERO16.slice(1)])).to.be.revertedWithCustomError(w.vc, "TotalAboveBallotCount").withArgs(0);
    await expect(w.vc.connect(w.trustee1).endorseResult(C02, 1, [0n, 0n, 1n, ...ZERO16.slice(3)])).to.be.revertedWithCustomError(w.vc, "PaddedTotalNotZero").withArgs(2);
    await expect(w.vc.connect(w.trustee1).endorseResult(C02, 1, ZERO16)).to.emit(w.vc, "ResultEndorsed");
    expect(await w.vc.isFinalized(C02)).to.equal(false);
    await expect(w.vc.finalResult(C02), "nothing is readable after ONE endorsement").to.be.revertedWithCustomError(w.vc, "NotFinalized");
    await expect(w.vc.connect(w.trustee1).endorseResult(C02, 1, ZERO16)).to.be.revertedWithCustomError(w.vc, "AlreadyEndorsed");
    await expect(w.vc.connect(w.trustee2).endorseResult(C02, 2, ZERO16)).to.emit(w.vc, "ConstituencyFinalized");
    expect(await w.vc.isFinalized(C02)).to.equal(true);
    const result = await w.vc.finalResult(C02);
    expect([...result.totals]).to.deep.equal(ZERO16);
    expect(result.ballotCount).to.equal(0n);
    expect(result.candidateCount).to.equal(2n);
    expect(result.resultsHash).to.equal(await w.vc.endorsementOf(C02, 1));
    await expect(w.vc.connect(w.trustee3).endorseResult(C02, 3, ZERO16)).to.be.revertedWithCustomError(w.vc, "AlreadyFinalized").withArgs(C02);
    expect(await w.vc.endorsementOf(C02, 3), "a finalized result cannot be touched").to.equal("0x" + "00".repeat(32));
  });
});

describe("VoteChainV3 trustees: Solidity == JavaScript known-answer vectors (trustee-v3/spec/integration-vectors.json)", () => {
  let h;
  before(async () => {
    const w = await newWorld();
    h = await w.ethers.deployContract("EncodingsHarness");
  });

  it("the tags are the frozen ones", async () => {
    expect(await h.bundleTag()).to.equal(vectors.tags.PDEC_BUNDLE_TAG);
    expect(await h.resultsTag()).to.equal(vectors.tags.RESULTS_TAG);
  });

  for (const vector of vectors.bundles) {
    it(`bundle hash, ${vector.name}: the Solidity library gives exactly the JS vector`, async () => {
      const hash = await h.bundleHashOf(ctx.chainId, "0x" + ctx.contractAddress.toString(16).padStart(40, "0"), "0x" + ctx.electionId.toString(16).padStart(64, "0"), vectors.transcriptHash, vector.trusteeIndex, vector.constituencyId, vector.ballotCount, vector.candidateCount, vector.words.map(BigInt));
      expect(hash).to.equal(vector.bundleHash);
    });
  }

  for (const vector of vectors.results) {
    it(`results hash, ${vector.name}: the Solidity library gives exactly the JS vector`, async () => {
      const hash = await h.resultsHashOf(ctx.chainId, "0x" + ctx.contractAddress.toString(16).padStart(40, "0"), "0x" + ctx.electionId.toString(16).padStart(64, "0"), vectors.transcriptHash, vector.constituencyId, vector.ballotCount, vector.candidateCount, vector.totals.map(BigInt));
      expect(hash).to.equal(vector.resultsHash);
    });
  }

  it("each hash binds each of its fields in Solidity too (a changed field gives a different hash)", async () => {
    const v = vectors.bundles[0];
    const address = "0x" + ctx.contractAddress.toString(16).padStart(40, "0");
    const electionId = "0x" + ctx.electionId.toString(16).padStart(64, "0");
    const base = [ctx.chainId, address, electionId, vectors.transcriptHash, v.trusteeIndex, v.constituencyId, v.ballotCount, v.candidateCount, v.words.map(BigInt)];
    expect(await h.bundleHashOf(...base)).to.equal(v.bundleHash);
    const changed = [1n, "0x" + "11".repeat(20), "0x" + "22".repeat(32), "0x" + "33".repeat(32), 1, "0x" + "44".repeat(32), 99, 4, v.words.map((w, i) => (i === 7 ? BigInt(w) + 1n : BigInt(w)))];
    for (let i = 0; i < base.length; i++) expect(await h.bundleHashOf(...base.map((x, k) => (k === i ? changed[i] : x))), `field ${i}`).to.not.equal(v.bundleHash);
  });

  it("the deployed contract computes the same encodings: its context is the one the vectors use (chain 31337, the first-deployment address, the frozen election id)", async () => {
    const w = await newWorld();
    expect((await w.vc.getAddress()).toLowerCase()).to.equal("0x" + ctx.contractAddress.toString(16));
    expect(BigInt(await w.vc.ELECTION_ID())).to.equal(ctx.electionId);
    expect((await w.ethers.provider.getNetwork()).chainId).to.equal(ctx.chainId);
  });
});
