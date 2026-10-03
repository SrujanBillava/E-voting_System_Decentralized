export function createHealthController({ healthService }) {
  return {
    async getHealth(_req, res) {
      const { status } = await healthService.getPublicHealth();
      res.status(status === "ok" ? 200 : 503).json({ status });
    },
  };
}
