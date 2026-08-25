import {
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deleteFilesOlderThan } from "../../src/server/retention.ts";

describe("异常证据保留", () => {
  it("只删除期限以前的普通文件", () => {
    const root = mkdtempSync(join(tmpdir(), "jobpilot-retention-"));
    const nested = join(root, "nested");
    mkdirSync(nested);
    const oldFile = join(nested, "old.png");
    const currentFile = join(root, "current.png");
    writeFileSync(oldFile, "old");
    writeFileSync(currentFile, "current");
    const now = Date.UTC(2026, 7, 24);
    utimesSync(
      oldFile,
      new Date(now - 15 * 86_400_000),
      new Date(now - 15 * 86_400_000),
    );
    utimesSync(
      currentFile,
      new Date(now - 2 * 86_400_000),
      new Date(now - 2 * 86_400_000),
    );

    expect(deleteFilesOlderThan(root, 14 * 86_400_000, now)).toBe(1);
    expect(() => statSync(oldFile)).toThrow();
    expect(statSync(currentFile).isFile()).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
