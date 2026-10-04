// The verifier side ("election server / contract" in the later integration). In-memory here.
// A submission is accepted only if ALL of the following hold, and the nullifier is consumed atomically at the very end:
//   1. well-formed, for a known constituency, with exactly kc ciphertexts that are curve points
//   2. the Semaphore proof is for THIS election's scope, THIS constituency's group root and message == ballotHash(exact ciphertexts + context)
//   3. the Semaphore proof verifies (anonymous membership)
//   4. the Groth16 validity proof verifies for the public statement rebuilt HERE (election key H, kc, context, ciphertexts and the SAME nullifier)
//   5. the nullifier was not used before
import { inCurve } from "@zk-kit/baby-jubjub";
import { ballotHash, padCiphertexts, validityPublicSignals } from "./ballot.js";
import { addCiphertexts, assertValidPublicKey, decryptToPoint, identityCiphertext, makeDiscreteLog } from "./elgamal.js";
import { BASE_FIELD, FIELD_PRIME, K_MAX, constituencyField, electionScope } from "./params.js";
import { verifyMembership } from "./semaphore.js";
import { verifyValidity } from "./validity.js";

export class Rejected extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (obj, keys, what) => {
  const have = Object.keys(obj).sort();
  if (have.length !== keys.length || [...keys].sort().some((k, i) => k !== have[i])) throw new Rejected("MALFORMED", `${what}: unexpected or missing fields`);
};

/** Canonical decimal string below `limit` (no hex, no leading zeros, no signs): one encoding per value, so a proof has exactly one accepted form. */
function decimal(value, what, limit = FIELD_PRIME) {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Rejected("MALFORMED", what);
  const v = BigInt(value);
  if (v >= limit) throw new Rejected("MALFORMED", `${what} is out of range`);
  return v;
}
const field = (value, what) => decimal(value, what, FIELD_PRIME);
function point(value, what) {
  if (!Array.isArray(value) || value.length !== 2) throw new Rejected("MALFORMED", what);
  const p = [field(value[0], `${what}.x`), field(value[1], `${what}.y`)];
  if (!inCurve([...p])) throw new Rejected("MALFORMED", `${what} is not on the curve`);
  return p;
}

/** Exactly what snarkjs emits for Groth16 over BN254, with affine points (z = 1). Returns a rebuilt canonical object. */
function groth16Proof(proof, what) {
  if (!isPlainObject(proof)) throw new Rejected("MALFORMED", what);
  exactKeys(proof, ["pi_a", "pi_b", "pi_c", "protocol", "curve"], what);
  if (proof.protocol !== "groth16" || proof.curve !== "bn128") throw new Rejected("MALFORMED", `${what}: protocol/curve`);
  const g1 = (p, name) => {
    if (!Array.isArray(p) || p.length !== 3 || p[2] !== "1") throw new Rejected("MALFORMED", `${what}.${name}`);
    return [decimal(p[0], `${what}.${name}`, BASE_FIELD).toString(), decimal(p[1], `${what}.${name}`, BASE_FIELD).toString(), "1"];
  };
  const b = proof.pi_b;
  if (!Array.isArray(b) || b.length !== 3 || !Array.isArray(b[2]) || b[2].length !== 2 || b[2][0] !== "1" || b[2][1] !== "0") throw new Rejected("MALFORMED", `${what}.pi_b`);
  const g2 = (pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Rejected("MALFORMED", `${what}.pi_b`);
    return pair.map((c) => decimal(c, `${what}.pi_b`, BASE_FIELD).toString());
  };
  return { pi_a: g1(proof.pi_a, "pi_a"), pi_b: [g2(b[0]), g2(b[1]), ["1", "0"]], pi_c: g1(proof.pi_c, "pi_c"), protocol: "groth16", curve: "bn128" };
}

/** Semaphore v4 proof: {merkleTreeDepth, merkleTreeRoot, nullifier, message, scope, points[8]}. Returns a rebuilt canonical object. */
function semaphoreProof(sem) {
  exactKeys(sem, ["merkleTreeDepth", "merkleTreeRoot", "nullifier", "message", "scope", "points"], "semaphore");
  if (!Number.isInteger(sem.merkleTreeDepth) || sem.merkleTreeDepth < 1 || sem.merkleTreeDepth > 32) throw new Rejected("MALFORMED", "semaphore.merkleTreeDepth");
  if (!Array.isArray(sem.points) || sem.points.length !== 8) throw new Rejected("MALFORMED", "semaphore.points");
  return {
    merkleTreeDepth: sem.merkleTreeDepth,
    merkleTreeRoot: field(sem.merkleTreeRoot, "semaphore.merkleTreeRoot").toString(),
    nullifier: field(sem.nullifier, "semaphore.nullifier").toString(),
    message: field(sem.message, "semaphore.message").toString(),
    scope: field(sem.scope, "semaphore.scope").toString(),
    points: sem.points.map((v) => decimal(v, "semaphore.points", BASE_FIELD).toString()),
  };
}

export class BallotBox {
  /**
   * @param {{chainId:bigint, contractAddress:bigint, electionId:bigint}} ctx
   * @param {bigint[]} publicKey  election key H (validated once, here)
   * @param {Record<string,{kc:number, group:import("@semaphore-protocol/group").Group}>} constituencies  membership is frozen: the root is read now
   */
  constructor({ ctx, publicKey, constituencies }) {
    assertValidPublicKey(publicKey); // the election key is validated here, once, before anything is accepted under it
    this.ctx = ctx;
    this.H = publicKey;
    this.scope = electionScope(ctx);
    this.cfg = new Map();
    this.sums = new Map();
    for (const [code, { kc, group }] of Object.entries(constituencies)) {
      if (!Number.isInteger(kc) || kc < 1 || kc > K_MAX) throw new RangeError(`kc of ${code} must be in 1..${K_MAX}`);
      this.cfg.set(code, { kc, depth: group.depth, root: BigInt(group.root), id: constituencyField(code) });
      this.sums.set(code, Array.from({ length: kc }, identityCiphertext));
    }
    this.used = new Set(); // nullifiers, election-wide
    this.ledger = []; // accepted ballots, append-only
  }

  async submit(submission) {
    try {
      return await this.#verifyAndRecord(submission);
    } catch (err) {
      if (err instanceof Rejected) return { accepted: false, reason: err.code, detail: err.message };
      return { accepted: false, reason: "MALFORMED", detail: "unexpected input" }; // never leak internals or crash on hostile input
    }
  }

  async #verifyAndRecord(sub) {
    // ---- 1. structure (strict: exact field sets, canonical numbers; the proofs are rebuilt in canonical form before use)
    if (!isPlainObject(sub)) throw new Rejected("MALFORMED", "submission");
    exactKeys(sub, ["constituency", "ciphertexts", "semaphore", "validity"], "submission");
    if (typeof sub.constituency !== "string" || !isPlainObject(sub.semaphore) || !isPlainObject(sub.validity)) throw new Rejected("MALFORMED", "submission");
    exactKeys(sub.validity, ["proof"], "validity");
    const cfg = this.cfg.get(sub.constituency);
    if (!cfg) throw new Rejected("UNKNOWN_CONSTITUENCY");
    if (!Array.isArray(sub.ciphertexts) || sub.ciphertexts.length !== cfg.kc) throw new Rejected("WRONG_CANDIDATE_COUNT", `expected ${cfg.kc} ciphertexts`);
    const real = sub.ciphertexts.map((c, j) => {
      if (!isPlainObject(c)) throw new Rejected("MALFORMED", `ciphertext ${j}`);
      exactKeys(c, ["c1", "c2"], `ciphertext ${j}`);
      return { c1: point(c.c1, `ciphertext ${j}.c1`), c2: point(c.c2, `ciphertext ${j}.c2`) };
    });
    const padded = padCiphertexts(real);
    const sem = semaphoreProof(sub.semaphore);
    const validityProof = groth16Proof(sub.validity.proof, "validity.proof");
    const root = BigInt(sem.merkleTreeRoot);
    const nullifier = BigInt(sem.nullifier);
    const message = BigInt(sem.message);
    const scope = BigInt(sem.scope);

    // ---- 2. the Semaphore proof is about THIS election, THIS group and EXACTLY this ballot
    if (scope !== this.scope) throw new Rejected("WRONG_SCOPE");
    if (root !== cfg.root || sem.merkleTreeDepth !== cfg.depth) throw new Rejected("NOT_A_MEMBER", "the proof is not for this constituency's group");
    const hash = ballotHash(this.ctx, cfg.id, padded);
    if (message !== hash) throw new Rejected("BALLOT_NOT_BOUND", "the Semaphore message is not the hash of these ciphertexts in this election context");

    // ---- cheap duplicate check before any pairing work (re-checked atomically at the end)
    if (this.used.has(nullifier)) throw new Rejected("NULLIFIER_USED");

    // ---- 3. anonymous membership
    if (!(await verifyMembership(sem))) throw new Rejected("BAD_MEMBERSHIP_PROOF");

    // ---- 4. ballot validity for the statement the VERIFIER rebuilds (own H, own kc, own context, this nullifier)
    const statement = validityPublicSignals({ ctx: this.ctx, constituencyId: cfg.id, kc: cfg.kc, H: this.H, nullifier, ciphertexts: padded, hash });
    if (!(await verifyValidity(validityProof, statement))) throw new Rejected("BAD_VALIDITY_PROOF");

    // ---- 5. commit atomically (no await between the check and the insert: of N concurrent copies exactly one gets here first)
    if (this.used.has(nullifier)) throw new Rejected("NULLIFIER_USED");
    this.used.add(nullifier);
    const sums = this.sums.get(sub.constituency);
    real.forEach((ct, j) => (sums[j] = addCiphertexts(sums[j], ct)));
    this.ledger.push({ index: this.ledger.length + 1, constituency: sub.constituency, nullifier, ciphertexts: real });
    return { accepted: true, nullifier: nullifier.toString(), ballotIndex: this.ledger.length };
  }

  /** The homomorphic sum, one ciphertext per candidate. Nothing individual is needed to produce it. */
  aggregate(constituency) {
    return this.sums.get(constituency).map((ct) => ({ c1: [...ct.c1], c2: [...ct.c2] }));
  }

  /** Decrypts ONLY the aggregate (TEST key). Throws if a total is outside the discrete-log bound. */
  decryptTotals(constituency, secret, bound = 1n << 20n) {
    const dlog = makeDiscreteLog(bound);
    return this.aggregate(constituency).map((ct) => {
      const t = dlog(decryptToPoint(secret, ct));
      if (t === null) throw new Error("tally outside the search bound, or wrong key");
      return t;
    });
  }
}

