import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/server/app.ts";
import { openJobPilotStore } from "../../src/storage/store.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("JobPilot API", () => {
  it("通过健康接口公开当前批次状态", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const server = buildServer({
      store,
      batchRunner: {
        getState: () => "空闲",
        requestStop: () => undefined,
        run: async () => ({
          state: "已完成",
          candidatesChecked: 0,
          contactsSucceeded: 0,
          reason: "测试",
        }),
      },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    });

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", batchState: "空闲" });
  });

  it("使用防跨站请求令牌保存并读取搜索方案", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const server = buildServer({
      store,
      batchRunner: {
        getState: () => "空闲",
        requestStop: () => undefined,
        run: async () => ({
          state: "已完成",
          candidatesChecked: 0,
          contactsSucceeded: 0,
          reason: "测试",
        }),
      },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    const headers = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" };
    const session = await server.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const payload = {
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

    const rejected = await server.inject({
      method: "PUT",
      url: "/api/plans/go-beijing",
      headers,
      payload,
    });
    const accepted = await server.inject({
      method: "PUT",
      url: "/api/plans/go-beijing",
      headers: { ...headers, "x-jobpilot-csrf": csrfToken },
      payload,
    });
    const listed = await server.inject({
      method: "GET",
      url: "/api/plans",
      headers,
    });

    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(204);
    expect(listed.json()).toEqual([payload]);
  });

  it("只导出并重新导入方案与模板，不携带账号设置", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    store.saveTemplate({
      id: "hello",
      name: "开场",
      enabled: true,
      body: "您好",
    });
    store.setSetting("app", { accountNote: "不得导出" });
    const server = buildServer({
      store,
      batchRunner: {
        getState: () => "空闲",
        requestStop: () => undefined,
        run: async () => ({
          state: "已完成",
          candidatesChecked: 0,
          contactsSucceeded: 0,
          reason: "测试",
        }),
      },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    const headers = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" };
    const session = await server.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    const { csrfToken } = session.json<{ csrfToken: string }>();

    const exported = await server.inject({
      method: "GET",
      url: "/api/export/configuration",
      headers,
    });
    const bundle = exported.json<Record<string, unknown>>();
    const imported = await server.inject({
      method: "POST",
      url: "/api/import/configuration",
      headers: { ...headers, "x-jobpilot-csrf": csrfToken },
      payload: bundle,
    });
    const openapi = await server.inject({
      method: "GET",
      url: "/api/openapi.json",
      headers,
    });

    expect(exported.statusCode).toBe(200);
    expect(bundle).not.toHaveProperty("settings");
    expect(bundle).not.toHaveProperty("snapshots");
    expect(imported.json()).toEqual({ importedPlans: 0, importedTemplates: 1 });
    expect(openapi.json()).toHaveProperty("openapi");
  });

  it("只读校准通过后仍保持真实发送关闭", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    store.saveSearchPlan({
      id: "calibration",
      name: "校准方案",
      enabled: true,
      priority: 1,
      templateId: "hello",
      rules: {
        titleKeywords: ["Go"],
        cities: ["北京"],
        companyBlacklist: [],
        industryBlacklist: [],
        allowRemote: false,
      },
    });
    const server = buildServer({
      store,
      calibrateBoss: async () => ({ candidatesRecognized: 12 }),
      batchRunner: {
        getState: () => "空闲",
        requestStop: () => undefined,
        run: async () => ({
          state: "已完成",
          candidatesChecked: 0,
          contactsSucceeded: 0,
          reason: "测试",
        }),
      },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    const headers = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" };
    const session = await server.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    const { csrfToken } = session.json<{ csrfToken: string }>();

    const forgedCalibration = await server.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { ...headers, "x-jobpilot-csrf": csrfToken },
      payload: {
        accountNote: "测试账号",
        adapterMode: "boss",
        realSendEnabled: false,
        readOnlySmokePassed: true,
        cooldownMs: 5_000,
      },
    });
    const calibrated = await server.inject({
      method: "POST",
      url: "/api/calibration/boss",
      headers: { ...headers, "x-jobpilot-csrf": csrfToken },
    });
    const settings = await server.inject({
      method: "GET",
      url: "/api/settings",
      headers,
    });

    expect(forgedCalibration.statusCode).toBe(409);
    expect(calibrated.json()).toEqual({
      calibrated: true,
      candidatesRecognized: 12,
    });
    expect(settings.json()).toMatchObject({
      readOnlySmokePassed: true,
      realSendEnabled: false,
    });
  });
});
