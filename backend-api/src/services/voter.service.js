import { randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { canonicalConstituencyCode, constituencyIdOf } from "../chain/ids.js";
import { AppError } from "../utils/errors.js";
import { readConstituencyById, requireSetup } from "./chainConfig.js";

// No 0/O/1/I/L: readable when read aloud or typed from a printout.
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const VOTER_ID_PATTERN = /^VC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const generateVoterId = () => "VC-" + Array.from({ length: 10 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");
/** 128-bit secret input of the nullifier derivation. Unrelated to voterId. */
export const generateUid = () => randomBytes(16).toString("hex");

export const toVoterDto = (v) => ({
  id: String(v._id),
  voterId: v.voterId,
  name: v.name,
  email: v.email,
  constituencyCode: v.constituencyCode,
  status: v.status,
  faceEnrolled: v.faceEnrolled,
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
});

const isDuplicate = (err) => err?.code === 11000;

export function createVoterService({ Voter, chain, audit, bcryptCost = 12 }) {
  /** Canonicalise the code, derive the id, and prove the constituency exists on-chain. */
  async function requireConstituency(rawCode) {
    const code = canonicalConstituencyCode(rawCode);
    if (!code) throw new AppError(400, "VALIDATION_FAILED", "Invalid request: constituencyCode");
    if (!(await readConstituencyById(chain, constituencyIdOf(code)))) throw new AppError(422, "UNKNOWN_CONSTITUENCY", "That constituency does not exist on-chain");
    return code;
  }
  const find = async (id) => {
    const voter = await Voter.findById(id);
    if (!voter) throw new AppError(404, "NOT_FOUND", "Voter not found");
    return voter;
  };
  const rec = (action, ctx, voter, meta = {}) =>
    audit.record({ action, result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, meta: { voterDbId: String(voter._id), voterId: voter.voterId, ...meta } });

  return {
    async create({ name, email, password, constituencyCode }, ctx) {
      await requireSetup(chain);
      const code = await requireConstituency(constituencyCode);
      const passwordHash = await bcrypt.hash(password, bcryptCost);
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const voter = await Voter.create({ uid: generateUid(), voterId: generateVoterId(), name, email, passwordHash, constituencyCode: code });
          await rec("VOTER_CREATED", ctx, voter, { constituencyCode: code });
          return toVoterDto(voter);
        } catch (err) {
          if (!isDuplicate(err)) throw err;
          if (err.keyPattern?.email) throw new AppError(409, "EMAIL_TAKEN", "A voter with that email already exists");
          // otherwise a (1 in 2^49) voterId/uid collision: draw again
        }
      }
      throw new AppError(500, "INTERNAL_ERROR", "Internal server error");
    },

    async list({ page, limit, search, constituencyCode, status }) {
      const filter = {};
      if (constituencyCode) filter.constituencyCode = canonicalConstituencyCode(constituencyCode) ?? "\u0000invalid";
      if (status) filter.status = status;
      if (search) {
        const rx = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ name: rx }, { email: rx }, { voterId: rx }];
      }
      const [rows, total] = await Promise.all([
        Voter.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
        Voter.countDocuments(filter),
      ]);
      return { voters: rows.map(toVoterDto), page, limit, total, totalPages: Math.ceil(total / limit) };
    },

    async get(id) {
      return toVoterDto(await find(id));
    },

    async update(id, changes, ctx) {
      await requireSetup(chain);
      const voter = await find(id);
      if (changes.constituencyCode !== undefined) changes = { ...changes, constituencyCode: await requireConstituency(changes.constituencyCode) };
      const changedFields = [];
      for (const field of ["name", "email", "constituencyCode", "status"]) {
        if (changes[field] !== undefined && changes[field] !== voter[field]) {
          voter[field] = changes[field];
          changedFields.push(field);
        }
      }
      try {
        await voter.save();
      } catch (err) {
        if (isDuplicate(err)) throw new AppError(409, "EMAIL_TAKEN", "A voter with that email already exists");
        throw err;
      }
      await rec("VOTER_UPDATED", ctx, voter, { changedFields });
      return toVoterDto(voter);
    },

    async remove(id, ctx) {
      await requireSetup(chain);
      const voter = await find(id);
      await voter.deleteOne();
      await rec("VOTER_DELETED", ctx, voter);
    },

    async resetPassword(id, newPassword, ctx) {
      await requireSetup(chain);
      const voter = await find(id);
      voter.passwordHash = await bcrypt.hash(newPassword, bcryptCost);
      await voter.save();
      await rec("VOTER_PASSWORD_RESET", ctx, voter);
    },

    async stats() {
      const [registered, faceEnrolled] = await Promise.all([Voter.countDocuments({}), Voter.countDocuments({ faceEnrolled: true })]);
      return { registered, faceEnrolled };
    },
  };
}
