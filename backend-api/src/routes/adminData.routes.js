import { Router } from "express";
import { z } from "zod";
import { parse } from "../utils/validate.js";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i);
const text = (max) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "control characters");
const email = z.string().trim().max(254).email().toLowerCase();
const password = z.string().min(12).max(72);
const code = z.string().trim().min(1).max(40);

const CreateVoter = z.strictObject({ name: text(100), email, password, constituencyCode: code });
const UpdateVoter = z.strictObject({ name: text(100).optional(), email: email.optional(), constituencyCode: code.optional(), status: z.enum(["ACTIVE", "SUSPENDED"]).optional() }).refine((b) => Object.keys(b).length > 0, "empty update");
const ResetPassword = z.strictObject({ newPassword: password });
const ListVoters = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  constituencyCode: code.optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});
const AddConstituency = z.strictObject({ code, name: text(100) });
const AddCandidate = z.strictObject({ name: text(100), constituencyCode: code });
const ListCandidates = z.strictObject({ constituencyCode: code.optional() });
const Id = z.strictObject({ id: objectId });
const CandidateId = z.strictObject({ id: z.coerce.number().int().min(1).max(1_000_000) });

/** Admin data management. Mounted behind requireAdmin; every handler validates with strict schemas. */
export function createAdminDataRouter({ voterService, configService }) {
  const router = Router();
  const ctxOf = (req) => ({ adminId: req.admin.adminId, ip: req.ip, requestId: req.id });

  router.get("/voters", async (req, res) => res.json({ data: await voterService.list(parse(ListVoters, req.query)) }));
  router.post("/voters", async (req, res) => res.status(201).json({ data: { voter: await voterService.create(parse(CreateVoter, req.body), ctxOf(req)) } }));
  router.get("/voters/:id", async (req, res) => res.json({ data: { voter: await voterService.get(parse(Id, req.params).id) } }));
  router.patch("/voters/:id", async (req, res) => res.json({ data: { voter: await voterService.update(parse(Id, req.params).id, parse(UpdateVoter, req.body), ctxOf(req)) } }));
  router.delete("/voters/:id", async (req, res) => {
    await voterService.remove(parse(Id, req.params).id, ctxOf(req));
    res.status(204).end();
  });
  router.post("/voters/:id/password-reset", async (req, res) => {
    await voterService.resetPassword(parse(Id, req.params).id, parse(ResetPassword, req.body).newPassword, ctxOf(req));
    res.status(204).end();
  });

  router.get("/constituencies", async (_req, res) => res.json({ data: { constituencies: await configService.listConstituencies() } }));
  router.post("/constituencies", async (req, res) => res.status(201).json({ data: await configService.addConstituency(parse(AddConstituency, req.body), ctxOf(req)) }));

  router.get("/candidates", async (req, res) => res.json({ data: { candidates: await configService.listCandidates(parse(ListCandidates, req.query)) } }));
  router.get("/candidates/:id", async (req, res) => res.json({ data: { candidate: await configService.getCandidate(parse(CandidateId, req.params).id) } }));
  router.post("/candidates", async (req, res) => res.status(201).json({ data: await configService.addCandidate(parse(AddCandidate, req.body), ctxOf(req)) }));

  return router;
}
