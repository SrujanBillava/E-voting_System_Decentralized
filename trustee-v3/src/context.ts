// The election context (chain id, contract address, election id) that a ceremony and every partial decryption are bound to.
import { hex32, exactKeys, parseHex32 } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import type { ElectionContext } from "./params.ts";

export interface WireContext {
  chainId: string; // decimal
  contractAddress: string; // 0x + 64 hex (a uint160, left-padded like abi.encode)
  electionId: string; // 0x + 64 hex (bytes32)
}

export function assertContext(ctx: unknown): ElectionContext {
  const c = ctx as ElectionContext;
  const ok = (v: unknown, limit: bigint): boolean => typeof v === "bigint" && v > 0n && v < limit;
  if (typeof ctx !== "object" || ctx === null || !ok(c.chainId, 1n << 256n) || !ok(c.contractAddress, 1n << 160n) || !ok(c.electionId, 1n << 256n)) {
    throw new InvalidInputError("BAD_CONTEXT", "context needs a non-zero chainId, a non-zero uint160 contractAddress and a non-zero uint256 electionId");
  }
  return { chainId: c.chainId, contractAddress: c.contractAddress, electionId: c.electionId };
}

/** The three words every challenge and hash binds, in this fixed order. */
export const contextWords = (ctx: ElectionContext): [bigint, bigint, bigint] => [ctx.chainId, ctx.contractAddress, ctx.electionId];

export const contextToWire = (ctx: ElectionContext): WireContext => ({ chainId: ctx.chainId.toString(10), contractAddress: hex32(ctx.contractAddress), electionId: hex32(ctx.electionId) });

export function parseContextWire(value: unknown): ElectionContext {
  const o = exactKeys(value, ["chainId", "contractAddress", "electionId"], "context");
  if (typeof o.chainId !== "string" || !/^[1-9][0-9]{0,77}$/.test(o.chainId)) throw new InvalidInputError("BAD_ENCODING", "context.chainId must be a canonical decimal string");
  return assertContext({ chainId: BigInt(o.chainId), contractAddress: parseHex32(o.contractAddress, "context.contractAddress"), electionId: parseHex32(o.electionId, "context.electionId") });
}
