// TEST SUPPORT ONLY (never imported from src/): verify a Groth16 proof against an EXPLICIT verification key. The regular verifier (src/validity.js) always uses the current
// artifacts' key; the final-ceremony tests need the OLD key too, to show that a proof from the old setup was genuine there and is refused by the final one.
import * as snarkjs from "snarkjs";

export const verifyWithKey = async (vkey, publicSignals, proof) => {
  try {
    return (await snarkjs.groth16.verify(vkey, publicSignals, proof)) === true;
  } catch {
    return false;
  }
};
