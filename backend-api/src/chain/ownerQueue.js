/**
 * Serialises every transaction sent by the OWNER signer (open, close, add constituency/candidate) so
 * two admin requests can never race for the same nonce. One backend instance is assumed: this is an
 * in-process queue, not a distributed lock.
 */
export function createOwnerQueue() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn, fn);
      tail = result.catch(() => {});
      return result;
    },
  };
}
