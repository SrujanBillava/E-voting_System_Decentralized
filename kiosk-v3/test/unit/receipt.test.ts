import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECEIPT_STATEMENT, assertReceiptSafe, buildReceipt } from "../../src/core/index.ts";

const params = { electionId: "0x" + "ab".repeat(32), constituency: { code: "KA-BLR", id: "0x" + "cd".repeat(32) }, ctx: { chainId: 31337n, contractAddress: 0x5fbdb2315678afecb367f032d93f642f64180aa3n, electionId: BigInt("0x" + "ab".repeat(32)) } };
const evidence = { constituencyId: params.constituency.id, ballotIndex: 7, ballotHash: "123456789012345678901234567890", txHash: "0x" + "11".repeat(32), blockNumber: 42, blockHash: "0x" + "22".repeat(32), blockTimestamp: 1_800_000_000 };

describe("the receipt", () => {
  const receipt = buildReceipt({ params, evidence });
  it("has EXACTLY the public recording fields, and the honest statement", () => {
    assert.deepEqual(Object.keys(receipt).sort(), ["ballotHash", "ballotIndex", "blockHash", "blockNumber", "blockTimestamp", "chainId", "constituency", "contract", "electionId", "statement", "txHash", "v"]);
    assert.equal(receipt.statement, "This receipt proves that an encrypted ballot was recorded. It does not prove which candidate was selected.");
    assert.equal(receipt.statement, RECEIPT_STATEMENT);
    assert.equal(receipt.contract, "0x5fbdb2315678afecb367f032d93f642f64180aa3");
    assert.match(receipt.ballotHash, /^0x[0-9a-f]{64}$/);
  });

  it("assertReceiptSafe accepts it and rejects ANY extra field or a secret in any spelling", () => {
    const nullifier = "98765432109876543210987654321098765432109876543210";
    assert.doesNotThrow(() => assertReceiptSafe(receipt, { nullifier, root: "5555555555555555555555" }));
    for (const extra of ["voterId", "uid", "commitment", "nullifier", "merkleRoot", "candidate", "choice", "oneHot", "randomness", "identity", "biometric"]) {
      assert.throws(() => assertReceiptSafe({ ...receipt, [extra]: "x" } as never, {}), /unexpected fields/, extra);
    }
    // a secret smuggled into an allowed field: as decimal, as hex with and without 0x
    const hex = BigInt(nullifier).toString(16);
    for (const planted of [nullifier, hex, "0x" + hex]) assert.throws(() => assertReceiptSafe({ ...receipt, txHash: `0x00${planted}` }, { nullifier }), /contains the nullifier/);
  });
});
