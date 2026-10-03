import { createOwnerQueue } from "./ownerQueue.js";

/**
 * Serialises everything the RELAYER signer does (nonce choice, signing, persisting, broadcasting) so two voters
 * can never pick the same nonce. Deliberately a separate instance from the owner queue: admin transactions and
 * votes use different accounts and must not block each other. One backend instance is assumed.
 */
export const createRelayerQueue = createOwnerQueue;
