import mongoose from "mongoose";
import { createApp } from "./app.js";
import { createChain } from "./chain/chain.js";
import { createProvider } from "./chain/provider.js";
import { createQueue } from "./chain/queue.js";
import { AnonymousSubmission } from "./models/AnonymousSubmission.js";
import { createGroupsService } from "./services/groups.service.js";
import { createSubmitService } from "./services/submit.service.js";

export const MODELS = Object.freeze({ AnonymousSubmission });

/**
 * Wires the relayer from a validated config. server.js calls it with the real provider; tests pass their own provider. Opens nothing by itself (no port, no timer).
 */
export function composeRelay({ config, logger, provider, now = Date.now, testHooks = null, submit = {}, globalLimitPerMinute }) {
  const chain = createChain({ config, provider: provider ?? createProvider({ rpcUrl: config.secrets.chainRpcUrl, chainId: config.chain.chainId }) });
  const queue = createQueue();
  const submitService = createSubmitService({ AnonymousSubmission, chain, queue, logger, now, testHooks, ...submit });
  const groupsService = createGroupsService({ chain });
  const health = {
    async getPublicHealth() {
      const mongo = mongoose.connection.readyState === 1;
      let chainOk = true;
      try {
        await chain.provider.getBlockNumber();
      } catch {
        chainOk = false;
      }
      return { status: mongo && chainOk ? "ok" : "degraded", mongo, chain: chainOk };
    },
  };
  const app = createApp({ config, logger, health, relay: { submitService, groupsService }, globalLimitPerMinute, now });
  return { app, chain, submitService, groupsService, queue, models: MODELS };
}

/** Builds the indexes the correctness rules rely on (the unique nullifier). Called once at startup; auto-indexing is off in the schema. */
export async function ensureIndexes() {
  for (const model of Object.values(MODELS)) await model.createIndexes();
}
