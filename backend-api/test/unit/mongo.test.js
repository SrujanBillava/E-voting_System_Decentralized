import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMongo } from "../../src/db/mongo.js";
import { createMemoryLogger } from "../../src/utils/logger.js";

describe("mongo module (failure paths; the success path needs a real MongoDB, see chain/mongo.live test)", () => {
  it("is not connected and ping fails before connecting", async () => {
    const mongo = createMongo({ uri: "mongodb://127.0.0.1:1/none", logger: createMemoryLogger().logger });
    assert.equal(mongo.isConnected(), false);
    await assert.rejects(mongo.ping(), /not connected/);
  });

  it("connect() rejects quickly when the server is unreachable, and the module stays disconnected", async () => {
    const mongo = createMongo({ uri: "mongodb://127.0.0.1:1/none", logger: createMemoryLogger().logger, serverSelectionTimeoutMS: 400 });
    await assert.rejects(mongo.connect());
    assert.equal(mongo.isConnected(), false);
    await mongo.disconnect();
  });
});
