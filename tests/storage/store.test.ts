import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openJobPilotStore } from "../../src/storage/store.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("JobPilotStore", () => {
  it("迁移新数据库并往返保存搜索方案", () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-store-"));
    tempDirectories.push(directory);
    const store = openJobPilotStore(join(directory, "jobpilot.db"));

    store.saveSearchPlan({
      id: "go-beijing",
      name: "北京 Go 岗位",
      enabled: true,
      priority: 10,
      templateId: "default",
      rules: {
        titleKeywords: ["Go"],
        cities: ["北京"],
        companyBlacklist: [],
        industryBlacklist: [],
        allowRemote: false,
      },
    });

    expect(store.listSearchPlans()).toEqual([
      {
        id: "go-beijing",
        name: "北京 Go 岗位",
        enabled: true,
        priority: 10,
        templateId: "default",
        rules: {
          titleKeywords: ["Go"],
          cities: ["北京"],
          companyBlacklist: [],
          industryBlacklist: [],
          allowRemote: false,
        },
      },
    ]);

    store.close();
  });

  it("旧快照不参与防重，追加式沟通账本永久阻止重复发送", () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-store-"));
    tempDirectories.push(directory);
    const store = openJobPilotStore(join(directory, "jobpilot.db"));

    store.saveSnapshot({
      identity: "boss:job-42",
      platformJobId: "job-42",
      url: "https://www.zhipin.com/job_detail/job-42.html",
      title: "Go 开发工程师",
      company: "远山科技",
      city: "北京",
      status: "已排除",
      exclusionReasons: [
        { field: "salary", code: "below-minimum" },
        { field: "location", code: "city-mismatch" },
      ],
      processedAt: "2026-08-24T08:00:00.000Z",
    });

    expect(store.hasContacted("boss:job-42")).toBe(false);
    store.reserveContactOperation({
      operationId: "operation-1",
      commandId: "command-1",
      batchId: "batch-1",
      source: "boss",
      identity: "boss:job-42",
      platformJobId: "job-42",
      url: "https://www.zhipin.com/job_detail/job-42.html",
      planId: "plan-1",
      templateId: "template-1",
      messageHash: "a".repeat(64),
      messageLength: 12,
      at: "2026-08-24T08:01:00.000Z",
    });
    store.markContactOperationDispatched(
      "operation-1",
      "2026-08-24T08:01:01.000Z",
    );
    store.completeContactOperation(
      "operation-1",
      "沟通成功",
      "2026-08-24T08:01:02.000Z",
    );
    store.recordContactOperationDiagnostic({
      operationId: "operation-1",
      stage: "send-opening",
      outcome: "沟通成功",
      durationMs: 320,
      at: "2026-08-01T08:01:02.000Z",
    });
    store.recordContactOperationDiagnostic({
      operationId: "operation-1",
      stage: "send-opening",
      outcome: "沟通成功",
      durationMs: 410,
      at: "2026-08-24T08:01:02.000Z",
    });

    expect(store.hasContacted("boss:job-42")).toBe(true);
    expect(store.listSnapshots()).toMatchObject([
      {
        identity: "boss:job-42",
        status: "已排除",
        title: "Go 开发工程师",
        exclusionReasons: [
          { field: "salary", code: "below-minimum" },
          { field: "location", code: "city-mismatch" },
        ],
      },
    ]);
    expect(
      store.deleteContactOperationDiagnosticsBefore("2026-08-15T00:00:00.000Z"),
    ).toBe(1);

    store.close();
  });

  it("启动恢复把已下发但没有终态的命令转为结果未知", () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-store-"));
    tempDirectories.push(directory);
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    store.reserveContactOperation({
      operationId: "operation-interrupted",
      commandId: "command-interrupted",
      batchId: "batch-1",
      source: "boss",
      identity: "boss:job-99",
      platformJobId: "job-99",
      url: "https://www.zhipin.com/job_detail/job-99.html",
      planId: "plan-1",
      templateId: "template-1",
      messageHash: "b".repeat(64),
      messageLength: 8,
      at: "2026-08-24T08:00:00.000Z",
    });
    store.markContactOperationDispatched(
      "operation-interrupted",
      "2026-08-24T08:00:01.000Z",
    );

    expect(
      store.recoverInterruptedContactOperations("2026-08-24T09:00:00.000Z"),
    ).toBe(1);
    expect(store.listPendingContactOperations()).toMatchObject([
      { operationId: "operation-interrupted", state: "结果未知" },
    ]);
    expect(store.getSendReadiness()).toMatchObject({ pendingCount: 1 });
    store.close();
  });

  it("升级旧数据库时保留原快照并增加排除原因", () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-store-legacy-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "jobpilot.db");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE position_snapshots (
        identity TEXT PRIMARY KEY,
        platform_job_id TEXT,
        url TEXT,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        city TEXT,
        region TEXT,
        salary TEXT,
        experience TEXT,
        education TEXT,
        industry TEXT,
        published_at TEXT,
        description TEXT,
        status TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
      INSERT INTO position_snapshots (
        identity, title, company, status, processed_at
      ) VALUES (
        'demo:legacy', '旧职位', '旧公司', '已排除',
        '2026-08-20T08:00:00.000Z'
      );
    `);
    legacyDatabase.close();

    const store = openJobPilotStore(databasePath);
    expect(store.listSnapshots()).toMatchObject([
      { identity: "demo:legacy", title: "旧职位", status: "已排除" },
    ]);

    store.saveSnapshot({
      identity: "demo:legacy",
      title: "旧职位",
      company: "旧公司",
      status: "已排除",
      exclusionReasons: [{ field: "title", code: "keyword-mismatch" }],
      processedAt: "2026-08-26T08:00:00.000Z",
    });
    expect(store.listSnapshots()[0]).toMatchObject({
      identity: "demo:legacy",
      exclusionReasons: [{ field: "title", code: "keyword-mismatch" }],
    });
    store.close();
  });
});
