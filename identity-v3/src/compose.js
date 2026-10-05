import mongoose from "mongoose";
import { createApp } from "./app.js";
import { createChain } from "./chain/chain.js";
import { createProvider } from "./chain/provider.js";
import { createQueue } from "./chain/queue.js";
import { CommitmentBatch } from "./models/CommitmentBatch.js";
import { CredentialIssuance } from "./models/CredentialIssuance.js";
import { FaceChallenge } from "./models/FaceChallenge.js";
import { FaceTemplate } from "./models/FaceTemplate.js";
import { Voter } from "./models/Voter.js";
import { VoterSession } from "./models/VoterSession.js";
import { createAuditService } from "./services/audit.service.js";
import { createBatchManager } from "./services/batcher.service.js";
import { createCredentialService } from "./services/credential.service.js";
import { createFaceService } from "./services/face.service.js";
import { createVoterAuthService } from "./services/voterAuth.service.js";

export const MODELS = Object.freeze({ Voter, VoterSession, FaceTemplate, FaceChallenge, CredentialIssuance, CommitmentBatch });

/**
 * Wires the identity service from a validated config. server.js calls it with the real provider; tests pass their own provider, clock and time source.
 * Opens nothing by itself (no port, no timer): `server.js` connects, runs the preflight and starts the batch timer.
 */
export function composeIdentity({ config, logger, provider, clock, now = Date.now, bcryptCost = 12, testHooks = null, batch = {}, rateLimits = {}, chainOverrides = {} }) {
  const chain = createChain({ config, provider: provider ?? createProvider({ rpcUrl: config.secrets.chainRpcUrl, chainId: config.chain.chainId }), clock, ...chainOverrides });
  const audit = createAuditService({ logger });
  const authService = createVoterAuthService({ Voter, VoterSession, CredentialIssuance, chain, audit, now, bcryptCost });
  const faceService = createFaceService({ VoterSession, FaceTemplate, FaceChallenge, authService, audit, templateKey: config.secrets.faceTemplateKey, now });
  const credentialService = createCredentialService({ Voter, CredentialIssuance, authService, chain, audit, now });
  const issuerQueue = createQueue();
  const batcher = createBatchManager({ CredentialIssuance, CommitmentBatch, VoterSession, FaceChallenge, chain, queue: issuerQueue, audit, logger, now, maxBatch: config.batch.maxSize, testHooks, ...batch });

  const healthService = {
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

  const limits = { ...config.rateLimits, ...rateLimits };
  const app = createApp({ config, logger, healthService, voter: { authService, faceService, credentialService }, voterLoginRateLimit: limits.login, faceRateLimit: limits.face });
  return { app, chain, batcher, authService, faceService, credentialService, audit, issuerQueue, models: MODELS };
}

/** The collections THIS service owns. The voter registry and the face templates belong to V2's data and never get an index from here. */
const OWNED = [VoterSession, FaceChallenge, CredentialIssuance, CommitmentBatch];

/**
 * Builds every index the correctness rules rely on (unique voter record, unique commitment, ...). Called once at startup, one collection after the other
 * (auto-indexing is off in every schema, so nothing else builds indexes behind this call's back).
 */
export async function ensureIndexes() {
  for (const model of OWNED) await model.createIndexes();
}
