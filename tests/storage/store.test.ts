import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("保存职位快照并永久识别已经沟通的职位", () => {
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
      status: "沟通成功",
      processedAt: "2026-08-24T08:00:00.000Z",
    });

    expect(store.hasContacted("boss:job-42")).toBe(true);
    expect(store.listSnapshots()).toMatchObject([
      { identity: "boss:job-42", status: "沟通成功", title: "Go 开发工程师" },
    ]);

    store.close();
  });
});
