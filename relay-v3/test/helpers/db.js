// TEST SUPPORT. A disposable MongoDB database for the RELAYER, chosen ONLY by MONGODB_TEST_URI; the name must contain "test" AND "relay".
import mongoose from "mongoose";
import { MODELS, ensureIndexes } from "../../src/compose.js";

export const testUri = process.env.MONGODB_TEST_URI;
export const skipWithoutMongo = testUri ? false : "set MONGODB_TEST_URI (a disposable database whose name contains 'test' and 'relay') to run";

export async function connectTestDb(uri = testUri) {
  const name = decodeURIComponent(/^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^?#]*)/.exec(uri)?.[1] ?? "");
  if (!/test/i.test(name) || !/relay/i.test(name)) throw new Error("refusing: the MongoDB test database name must contain 'test' and 'relay'");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await ensureIndexes(); // once: indexes persist across tests
}
/** Empties every collection; never drops the database or rebuilds indexes between tests (a local mongod 8.2.6 aborted when createIndexes raced a dropDatabase). */
export async function resetDb() {
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) await mongoose.connection.db.collection(name).deleteMany({});
}
export async function closeDb() {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
}
/** every document of every collection as JSON text: what an attacker with read access to the relayer's store would see */
export async function dumpDb() {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) out[name] = await mongoose.connection.db.collection(name).find({}).toArray();
  return JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
/** the RELAYER's own mongoose instance (a different object from the identity service's): the boundary test connects the two to two different databases */
export { MODELS, mongoose as relayMongoose };
