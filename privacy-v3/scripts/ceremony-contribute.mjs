// ONE phase-2 contribution, in its OWN process:  node scripts/ceremony-contribute.mjs <zkey-in> <zkey-out> <contribution-name>
// The entropy is drawn HERE, from the operating system's CSPRNG, held only in this process's memory and handed to snarkjs (which mixes in its own system randomness too).
// It is never an argument, never printed, never written to a file. When this process exits it is gone: that is the "toxic waste" the contribution must not keep.
import { randomBytes } from "node:crypto";
import * as snarkjs from "snarkjs";

const [, , zkeyIn, zkeyOut, name] = process.argv;
if (!zkeyIn || !zkeyOut || !name) throw new Error("usage: ceremony-contribute.mjs <zkey-in> <zkey-out> <name>");
const quiet = { debug() {}, info() {}, warn() {}, error: console.error };
await snarkjs.zKey.contribute(zkeyIn, zkeyOut, name, randomBytes(64).toString("hex"), quiet);
process.exit(0);
