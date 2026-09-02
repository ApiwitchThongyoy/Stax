// Preload helper: loads the repo .env so that importing modules that construct
// a db client (lazily, without connecting) do not throw. Used only by DB-free
// pure-mapping suites.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
dotenv.config({ path: path.join(projectRoot, ".env") });