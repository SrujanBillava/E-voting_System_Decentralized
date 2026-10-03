import { Wallet } from "ethers";

/**
 * The three server-side identities. They must be three different keys; the preflight additionally
 * proves they are the owner / authority / relayer the contract actually has.
 *
 * Wallet objects are held on NON-enumerable properties, so JSON.stringify(signers) and
 * console.log(signers) show public addresses only.
 */
export function createSigners({ provider, ownerPrivateKey, authorityPrivateKey, relayerPrivateKey }) {
  const owner = new Wallet(ownerPrivateKey, provider);
  const authority = new Wallet(authorityPrivateKey, provider);
  const relayer = new Wallet(relayerPrivateKey, provider);

  const addresses = { owner: owner.address, authority: authority.address, relayer: relayer.address };
  if (new Set(Object.values(addresses)).size !== 3) {
    throw new Error("owner, authority and relayer signers must be three distinct accounts");
  }

  const signers = { addresses: Object.freeze(addresses), toJSON: () => addresses };
  Object.defineProperty(signers, "owner", { value: owner, enumerable: false });
  Object.defineProperty(signers, "authority", { value: authority, enumerable: false });
  Object.defineProperty(signers, "relayer", { value: relayer, enumerable: false });
  return Object.freeze(signers);
}
