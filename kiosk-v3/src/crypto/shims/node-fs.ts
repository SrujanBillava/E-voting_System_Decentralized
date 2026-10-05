// BUILD-TIME SHIM for the browser: `node:fs`. The frozen validity module imports it only to read the verification key in `verifyValidity`, which the kiosk never calls
// (the contract verifies proofs, not the kiosk). Nothing here can touch a file, and there is no file system to touch.
const unavailable = (): never => {
  throw new Error("there is no file system in the browser");
};
export default { readFileSync: unavailable, existsSync: () => true };
