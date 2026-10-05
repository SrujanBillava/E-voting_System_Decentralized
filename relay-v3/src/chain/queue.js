/** Serialises everything the RELAYER signer does (nonce, sign, persist, broadcast) so two ballots can never pick the same nonce. One instance is assumed. */
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
