/** API responses can carry authentication state and election data: nothing may cache them. */
export function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  next();
}
