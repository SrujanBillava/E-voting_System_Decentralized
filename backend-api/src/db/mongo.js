import mongoose from "mongoose";

/**
 * MongoDB connection management. There is no default database name: MONGODB_URI is mandatory
 * (the old backend silently fell back to a database called "timetable").
 */
export function createMongo({ uri, logger, serverSelectionTimeoutMS = 5000 }) {
  mongoose.set("strictQuery", true);

  return {
    async connect() {
      await mongoose.connect(uri, { serverSelectionTimeoutMS });
      logger?.info({ host: mongoose.connection.host, database: mongoose.connection.name }, "mongodb connected");
    },

    async disconnect() {
      await mongoose.disconnect();
    },

    isConnected() {
      return mongoose.connection.readyState === 1;
    },

    /** Round-trip to the server; throws if not connected or unreachable. */
    async ping() {
      if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) throw new Error("mongodb is not connected");
      await mongoose.connection.db.admin().ping();
    },
  };
}
