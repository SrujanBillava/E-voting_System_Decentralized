/**
 * Serialises everything the ISSUER signer does (nonce choice, signing, persisting, broadcasting) so two batches can never pick the same nonce. One backend
 * instance is assumed: this is an in-process queue, not a distributed lock (the V2 owner/relayer queue).
 */
export function createQueue() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn, fn);
      tail = result.catch(() => {});
      return result;
    },
  };
}
