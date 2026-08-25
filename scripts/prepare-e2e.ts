import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

const workspace = resolve(process.cwd());
const target = resolve(join(workspace, ".jobpilot", "e2e"));
if (!target.startsWith(resolve(join(workspace, ".jobpilot")))) {
  throw new Error("E2E 数据目录越出工作区");
}
rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
