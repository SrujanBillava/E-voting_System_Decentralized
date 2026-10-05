import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_KEYS, KEYS, createSessionStore, memoryStorage } from "../../src/core/index.ts";

describe("the session store: the kiosk's ONLY persistence", () => {
  it("knows exactly four keys, all in the vc3. namespace", () => {
    assert.deepEqual(Object.values(KEYS).sort(), ["vc3.ballot", "vc3.flow", "vc3.identity", "vc3.receipt"]);
    assert.deepEqual([...ALL_KEYS].sort(), Object.values(KEYS).sort());
  });

  it("writes nothing but those keys, whatever is stored", () => {
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    store.setIdentity("private-identity-export");
    store.setFlow({ v: 1, stage: "CREDENTIAL_REQUESTED", constituency: { code: "KA-BLR", id: "0x" + "1".repeat(64) }, commitment: "123" });
    assert.deepEqual(store.keys().sort(), ["vc3.flow", "vc3.identity"]);
    assert.equal(store.getIdentity(), "private-identity-export");
  });

  it("treats a damaged or foreign record as ABSENT and removes it (it is never trusted, never repaired)", () => {
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    storage.setItem(KEYS.identity, "not json");
    storage.setItem(KEYS.flow, JSON.stringify({ v: 2, stage: "CREDENTIAL_ISSUED" }));
    storage.setItem(KEYS.ballot, JSON.stringify({ v: 1, nullifier: 5 }));
    storage.setItem(KEYS.receipt, JSON.stringify([1]));
    assert.equal(store.getIdentity(), null);
    assert.equal(store.getFlow(), null);
    assert.equal(store.getBallot(), null);
    assert.equal(store.getReceipt(), null);
    assert.deepEqual(store.keys(), [], "every damaged record was removed");
  });

  it("wipeVotingSecrets removes the private identity, the package and the flow, and keeps the public receipt; wipeAll removes everything", () => {
    const storage = memoryStorage();
    const store = createSessionStore(storage);
    store.setIdentity("x");
    store.setFlow({ v: 1, stage: "CREDENTIAL_ISSUED", constituency: { code: "A", id: "0x1" }, commitment: "1" });
    storage.setItem(KEYS.ballot, JSON.stringify({ v: 1, nullifier: "1", digest: "d", ciphertexts: [] }));
    storage.setItem(KEYS.receipt, JSON.stringify({ v: 1, txHash: "0xabc" }));
    store.wipeVotingSecrets();
    assert.deepEqual(store.keys(), [KEYS.receipt]);
    store.wipeAll();
    assert.deepEqual(store.keys(), []);
  });
});
