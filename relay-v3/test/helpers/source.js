// TEST SUPPORT. Static scanning of a package's own source: files, code without comments, and Express route lists.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "generated") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
/** source text without comments, so prose can neither trigger nor hide a finding */
export const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
export const sources = (root = ROOT) => walk(path.join(root, "src")).filter((f) => f.endsWith(".js")).map((file) => ({ file: path.relative(root, file), text: fs.readFileSync(file, "utf8"), code: code(fs.readFileSync(file, "utf8")) }));
/** every "METHOD path" registered directly on an Express Router (paths are relative to where the router is mounted) */
export function routesOf(router) {
  const out = [];
  for (const layer of router.stack ?? []) if (layer.route) for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${layer.route.path}`);
  return out;
}
