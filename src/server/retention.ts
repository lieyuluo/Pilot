import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function deleteFilesOlderThan(
  directory: string,
  ageMs: number,
  now = Date.now(),
): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    throw new RangeError("保留期限必须是非负数");
  }

  const root = resolve(directory);
  let deleted = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      deleted += deleteFilesOlderThan(path, ageMs, now);
      continue;
    }
    if (entry.isFile() && now - statSync(path).mtimeMs > ageMs) {
      rmSync(path);
      deleted += 1;
    }
  }
  return deleted;
}
