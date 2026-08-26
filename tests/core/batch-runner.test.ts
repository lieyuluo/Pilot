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
      async inspect(candidate) {
        return { candidate, contactState: "可沟通" };
      },
      async sendOpening({ candidate }) {
        contacted.push(candidate.id ?? "");
        return "沟通成功";
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
          identity: "demo:eligible",
          status: "沟通成功",
        }),
        expect.objectContaining({
          identity: "demo:wrong-city",
          status: "已排除",
          exclusionReasons: [{ field: "location", code: "city-mismatch" }],
        }),
      ]),
    );

    store.close();
  });

  it("未知结果消耗额度、阻止同职位重发并继续处理后续候选人", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-unknown-"));
    tempDirectories.push(directory);
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const sent: string[] = [];
    const candidates: CandidatePosition[] = [
      { id: "uncertain", title: "Go 工程师", company: "甲公司", city: "北京" },
      { id: "next", title: "Go 工程师", company: "乙公司", city: "北京" },
    ];
    const adapter: PlatformAdapter = {
      async *scan() {
        yield* candidates;
      },
      async inspect(candidate) {
        return { candidate, contactState: "可沟通" };
      },
      async sendOpening({ candidate }) {
        sent.push(candidate.id!);
        return candidate.id === "uncertain" ? "结果未知" : "沟通成功";
      },
    };
    const runner = createBatchRunner({ store, adapter, cooldownMs: 0 });

    const result = await runner.run({
      source: "boss",
      plans: [eligiblePlan()],
      templates: [openingTemplate()],
      maxContacts: 2,
      maxCandidates: 10,
    });

    expect(result).toMatchObject({
      state: "已完成有异常",
      contactsSucceeded: 1,
      creditsUsed: 2,
      unknownCount: 1,
    });
    expect(sent).toEqual(["uncertain", "next"]);
    expect(store.hasContacted("boss:uncertain", "boss")).toBe(true);
    expect(store.listPendingContactOperations()).toHaveLength(1);
    store.close();
  });

  it("连续三次明确未开始不消耗额度并转人工接管", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-clear-failure-"));
    tempDirectories.push(directory);
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const candidates: CandidatePosition[] = ["one", "two", "three", "four"].map(
      (id) => ({ id, title: "Go 工程师", company: `${id}公司`, city: "北京" }),
    );
    const adapter: PlatformAdapter = {
      async *scan() {
        yield* candidates;
      },
      async inspect(candidate) {
        return { candidate, contactState: "可沟通" };
      },
      async sendOpening() {
        return "明确未开始";
      },
    };
    const runner = createBatchRunner({ store, adapter, cooldownMs: 0 });

    const result = await runner.run({
      source: "boss",
      plans: [eligiblePlan()],
      templates: [openingTemplate()],
      maxContacts: 1,
      maxCandidates: 10,
    });

    expect(result).toMatchObject({
      state: "人工接管",
      creditsUsed: 0,
      contactsSucceeded: 0,
      reason: "连续三次沟通操作明确未开始",
    });
    expect(store.listContactOperationEvents()).toHaveLength(9);
    store.close();
  });

  it("成功后出现风控时保存成功并停止后续职位", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "jobpilot-post-success-takeover-"),
    );
    tempDirectories.push(directory);
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const sent: string[] = [];
    const candidates: CandidatePosition[] = ["success", "next"].map((id) => ({
      id,
      title: "Go 工程师",
      company: `${id}公司`,
      city: "北京",
    }));
    const adapter: PlatformAdapter = {
      async *scan() {
        yield* candidates;
      },
      async inspect(candidate) {
        return { candidate, contactState: "可沟通" };
      },
      async sendOpening({ candidate }) {
        sent.push(candidate.id!);
        return {
          result: "沟通成功",
          takeover: {
            kind: "verification",
            reason: "Boss 页面出现验证或风控提示",
          },
        };
      },
    };
    const runner = createBatchRunner({ store, adapter, cooldownMs: 0 });

    const result = await runner.run({
      source: "boss",
      plans: [eligiblePlan()],
      templates: [openingTemplate()],
      maxContacts: 2,
      maxCandidates: 10,
    });

    expect(result).toMatchObject({
      state: "人工接管",
      contactsSucceeded: 1,
      creditsUsed: 1,
      reason: "Boss 页面出现验证或风控提示",
    });
    expect(sent).toEqual(["success"]);
    expect(store.listSnapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: "boss:success",
          status: "沟通成功",
        }),
      ]),
    );
    store.close();
  });
});

function eligiblePlan(): SearchPlan {
  return {
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
}

function openingTemplate() {
  return {
    id: "default",
    name: "默认",
    enabled: true,
    body: "你好，我对{{职位名称}}感兴趣。",
  };
}
