import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSigners } from "../../src/chain/signers.js";
import { KEYS, hardhatAccount } from "../helpers/env.js";
import { localServices } from "../helpers/chain.js";

describe("chain: signers", () => {
  it("builds three signers whose public addresses are the Hardhat accounts #0, #1, #2", () => {
    const s = localServices();
    try {
      assert.deepEqual({ ...s.signers.addresses }, { owner: hardhatAccount(0).address, authority: hardhatAccount(1).address, relayer: hardhatAccount(2).address });
      assert.equal(s.signers.owner.address, hardhatAccount(0).address);
      assert.equal(s.signers.authority.address, hardhatAccount(1).address);
      assert.equal(s.signers.relayer.address, hardhatAccount(2).address);
    } finally {
      s.destroy();
    }
  });

  it("serialising the signers shows addresses only, never keys", () => {
    const s = localServices();
    try {
      const text = JSON.stringify(s.signers) + JSON.stringify({ ...s.signers }) + JSON.stringify(Object.entries(s.signers));
      for (const key of Object.values(KEYS)) assert.ok(!text.includes(key.slice(2)));
      assert.match(text, new RegExp(hardhatAccount(1).address));
    } finally {
      s.destroy();
    }
  });

  it("refuses duplicate identities", () => {
    assert.throws(() => createSigners({ provider: null, ownerPrivateKey: KEYS.owner, authorityPrivateKey: KEYS.authority, relayerPrivateKey: KEYS.authority }), /three distinct/);
  });
});
