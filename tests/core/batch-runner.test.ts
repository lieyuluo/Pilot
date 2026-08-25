import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBatchRunner,
  type PlatformAdapter,
} from "../../src/core/batch-runner.ts";
import type { SearchPlan } from "../../src/core/config.ts";
import type { CandidatePosition } from "../../src/core/rules.ts";
import { openJobPilotStore } from "../../src/storage/store.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  }
});

describe("BatchRunner", () => {
  it("只向达标职位发送开场消息并保存结果", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-batch-"));
    tempDirectories.push(directory);
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const contacted: string[] = [];
    const candidates: CandidatePosition[] = [
      {
        id: "wrong-city",
        title: "Go 开发工程师",
        company: "甲公司",
        city: "上海",
      },
      {
        id: "eligible",
        title: "Go 后端工程师",
        company: "乙公司",
        city: "北京",
      },
    ];
    const adapter: PlatformAdapter = {
      async *scan() {
        yield* candidates;
      },
      async currentContactState() {
        return "可沟通";
      },
      async sendOpening(candidate) {
        contacted.push(candidate.id ?? "");
        return "已确认";
      },
    };
    const plan: SearchPlan = {
      id: "go-beijing",
      name: "北京 Go",
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
    };
    const runner = createBatchRunner({ store, adapter, cooldownMs: 0 });

    const result = await runner.run({
      plans: [plan],
      templates: [
        {
          id: "default",
          name: "默认",
          enabled: true,
          body: "你好，我对{{职位名称}}感兴趣。",
        },
      ],
      maxContacts: 20,
      maxCandidates: 200,
    });

    expect(result).toMatchObject({
      state: "已完成",
      candidatesChecked: 2,
      contactsSucceeded: 1,
    });
    expect(contacted).toEqual(["eligible"]);
    expect(store.listSnapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: "boss:eligible",
          status: "沟通成功",
        }),
        expect.objectContaining({
          identity: "boss:wrong-city",
          status: "已排除",
        }),
      ]),
    );

    store.close();
  });
});
