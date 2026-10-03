import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSigners } from "../../src/chain/signers.js";
import { KEYS, hardhatAccount } from "../helpers/env.js";

const provider = { marker: "provider" };
const build = (overrides = {}) =>
  createSigners({ provider, ownerPrivateKey: KEYS.owner, authorityPrivateKey: KEYS.authority, relayerPrivateKey: KEYS.relayer, ...overrides });

describe("signers (offline)", () => {
  it("exposes exactly {addresses, toJSON}; the wallets are not enumerable", () => {
    const signers = build();
    assert.deepEqual(Object.keys(signers), ["addresses", "toJSON"]);
    assert.deepEqual(Object.entries({ ...signers }).map(([k]) => k), ["addresses", "toJSON"]);
    for (const name of ["owner", "authority", "relayer"]) {
      assert.equal(Object.prototype.propertyIsEnumerable.call(signers, name), false, name);
      assert.ok(signers[name], `${name} is still reachable by name`);
    }
  });

  it("JSON shows the public addresses and nothing else", () => {
    const signers = build();
    assert.equal(JSON.stringify(signers), JSON.stringify({ owner: hardhatAccount(0).address, authority: hardhatAccount(1).address, relayer: hardhatAccount(2).address }));
  });

  it("every wallet is connected to the given provider and has the right address", () => {
    const signers = build();
    assert.equal(signers.owner.provider, provider);
    assert.equal(signers.authority.provider, provider);
    assert.equal(signers.relayer.provider, provider);
    assert.equal(signers.owner.address, hardhatAccount(0).address);
    assert.equal(signers.authority.address, hardhatAccount(1).address);
    assert.equal(signers.relayer.address, hardhatAccount(2).address);
  });

  it("the structure is immutable: addresses cannot be re-pointed, members cannot be replaced or added", () => {
    const signers = build();
    assert.throws(() => { signers.addresses.relayer = hardhatAccount(9).address; }, TypeError);
    assert.throws(() => { signers.addresses = {}; }, TypeError);
    assert.throws(() => { signers.relayer = {}; }, TypeError);
    assert.throws(() => { signers.extra = 1; }, TypeError);
    assert.ok(Object.isFrozen(signers) && Object.isFrozen(signers.addresses));
  });

  it("refuses any two identical identities, whichever pair", () => {
    assert.throws(() => build({ authorityPrivateKey: KEYS.owner }), /three distinct/);
    assert.throws(() => build({ relayerPrivateKey: KEYS.owner }), /three distinct/);
    assert.throws(() => build({ relayerPrivateKey: KEYS.authority }), /three distinct/);
    assert.throws(() => build({ relayerPrivateKey: KEYS.owner, authorityPrivateKey: KEYS.owner }), /three distinct/);
  });
});
