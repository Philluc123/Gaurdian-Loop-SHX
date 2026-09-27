// tsc only emits compiled .ts, so the call page's static files have to be copied
// into dist/ separately. Without this, a built server serves a 404 at /call.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "src", "call-ingestion", "webrtc", "public");
const to = join(here, "..", "dist", "call-ingestion", "webrtc", "public");

if (!existsSync(from)) {
  console.error(`[copy-public] nothing to copy at ${from}`);
  process.exit(1);
}
cpSync(from, to, { recursive: true });
console.log(`[copy-public] ${from} -> ${to}`);
