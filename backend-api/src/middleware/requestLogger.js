/** One access-log line per response. Logs the path only: never query strings, headers, cookies or bodies. */
export function requestLogger(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    // Captured NOW: once a router has handled the request, req.path is relative to its mount point ("/health").
    const path = req.path;
    res.on("finish", () => {
      logger.info(
        {
          requestId: req.id,
          method: req.method,
          path,
          status: res.statusCode,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        },
        "request",
      );
    });
    next();
  };
}
