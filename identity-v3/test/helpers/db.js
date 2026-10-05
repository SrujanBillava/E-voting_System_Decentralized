// TEST SUPPORT. A disposable MongoDB database, chosen ONLY by MONGODB_TEST_URI (like V2): there is no default, and the database name must contain "test".
import mongoose from "mongoose";
import { MODELS, ensureIndexes } from "../../src/compose.js";

export const testUri = process.env.MONGODB_TEST_URI;
export const skipWithoutMongo = testUri ? false : "set MONGODB_TEST_URI (a disposable database whose name contains 'test') to run";

export async function connectTestDb() {
  const name = decodeURIComponent(/^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^?#]*)/.exec(testUri)?.[1] ?? "");
  if (!/test/i.test(name)) throw new Error("refusing: the MongoDB test database name must contain 'test'");
  await mongoose.connect(testUri, { serverSelectionTimeoutMS: 5000 });
  await ensureIndexes(); // once: indexes persist across tests
}
/**
 * Empties every collection. It does NOT drop the database or rebuild indexes between tests: a local mongod 8.2.6 was seen to abort (fassert in WiredTiger)
 * when createIndexes raced a dropDatabase, so the harness never does that.
 */
export async function resetDb() {
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) await mongoose.connection.db.collection(name).deleteMany({});
}
export async function closeDb() {
  await mongoose.connection.dropDatabase().catch(() => {}); // once, at the very end, when nothing else is running
  await mongoose.disconnect();
}

/** every document of every collection of the connected database, as plain JSON text (what an attacker with read access to the store would see) */
export async function dumpDb() {
  const out = {};
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of collections) out[name] = await mongoose.connection.db.collection(name).find({}).toArray();
  return JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
export { MODELS };
