import { Router } from "express";

/**
 * The whole surface of the anonymous relayer. NO route reads a cookie, a token or an identity: the only inputs are the ballot package (body), a nullifier
 * and a constituency (path).
 *
 *   POST /v1/ballots                the anonymous ballot package -> simulate -> persist -> sign -> broadcast -> confirm
 *   GET  /v1/ballots/:nullifier     the status of one anonymous submission (the nullifier is the anonymous idempotency key)
 *   GET  /v1/groups/:constituency   the PUBLIC Semaphore group data of a constituency (all leaves, root, checkpoints)
 */
export function createRelayRouter({ submitService, groupsService }) {
  const router = Router();
  router.post("/ballots", async (req, res) => {
    const out = await submitService.submit(req.body);
    res.status(out.http).json({ data: out.body });
  });
  router.get("/ballots/:nullifier", async (req, res) => {
    const out = await submitService.status(req.params.nullifier);
    res.status(out.http).json({ data: out.body });
  });
  router.get("/groups/:constituency", async (req, res) => {
    res.json({ data: await groupsService.group(req.params.constituency) });
  });
  return router;
}
