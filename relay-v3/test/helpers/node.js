// TEST SUPPORT. Starts a standalone Hardhat JSON-RPC node (from ../smart-contract-v3) on a FREE port and stops exactly the process it started.
// It never touches a port or a process it did not start: a busy port is simply not chosen.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = path.resolve(here, "..", "..", "..", "smart-contract-v3");
export const artifactPath = (...parts) => path.join(CONTRACTS, "artifacts", ...parts);
export const contractsCompiled = fs.existsSync(artifactPath("contracts", "VoteChainV3.sol", "VoteChainV3.json"));

export const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

export async function startNode() {
  const port = await freePort();
  const cli = fs.realpathSync(path.join(CONTRACTS, "node_modules", ".bin", "hardhat"));
  const child = spawn(process.execPath, [cli, "node", "--port", String(port)], { cwd: CONTRACTS, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the Hardhat node did not start in time:\n" + output)), 60_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes("Started HTTP")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the Hardhat node exited early (${code}):\n${output}`));
    });
  });
  await ready;
  const stop = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  process.once("exit", stop);
  return { url: `http://127.0.0.1:${port}`, port, stop };
}

/** Starts the service's REAL entry point (src/server.js) as its own OS process with exactly the environment given: nothing is inherited. */
export function spawnService(cwd, env) {
  const child = spawn(process.execPath, ["src/server.js"], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, output: () => out, exited, stop: () => (child.exitCode === null ? child.kill("SIGTERM") : undefined) };
}

export async function waitFor(check, { timeoutMs = 30_000, everyMs = 200 } = {}) {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() >= stop) throw new Error("timed out waiting for the service");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
