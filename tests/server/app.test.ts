import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/server/app.ts";
import type {
  BridgeSocket,
  ExtensionBridge,
} from "../../src/extension/bridge.ts";
import {
  JOBPILOT_EXTENSION_ORIGIN,
  type ExtensionStatus,
} from "../../src/extension/protocol.ts";
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

  it("不再公开独立的只读校准入口", async () => {
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
      extensionBridge: extensionBridgeStub({
        status: {
          pairingState: "已授权",
          connectionState: "页面已连接",
          capabilities: ["read", "batch-send"],
          readOnlyCalibrated: true,
          page: {
            tabId: 4,
            url: "https://www.zhipin.com/web/geek/job",
            active: true,
            visible: true,
          },
        },
        calibrate: async () => ({
          candidatesRecognized: 12,
          currentUrl: "https://www.zhipin.com/job_detail/abc.html",
          contactState: "可沟通",
        }),
      }),
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

    const forgedSendUnlock = await server.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { ...headers, "x-jobpilot-csrf": csrfToken },
      payload: {
        accountNote: "测试账号",
        adapterMode: "boss",
        realSendEnabled: true,
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

    expect(forgedSendUnlock.statusCode).toBe(409);
    expect(calibrated.statusCode).toBe(404);
    expect(settings.json()).toMatchObject({ realSendEnabled: false });
    expect(settings.json()).not.toHaveProperty("readOnlySmokePassed");
  });

  it("只有校准后的进程发送会话能启动单额度验证批次", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-send-session-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    store.setSetting("app", {
      accountNote: "测试账号",
      adapterMode: "boss",
      realSendEnabled: false,
      cooldownMs: 5_000,
    });
    store.saveTemplate({
      id: "hello",
      name: "开场",
      enabled: true,
      body: "您好",
    });
    store.saveSearchPlan({
      id: "go",
      name: "Go",
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
    const extensionStatus: ExtensionStatus = {
      pairingState: "已授权",
      connectionState: "页面已连接",
      capabilities: ["read", "batch-send"],
      readOnlyCalibrated: false,
      page: {
        tabId: 4,
        url: "https://www.zhipin.com/web/geek/job",
        active: true,
        visible: true,
        accountDisplayName: "测试求职者",
      },
    };
    let runRequest: Record<string, unknown> | undefined;
    const server = buildServer({
      store,
      extensionBridge: extensionBridgeStub({ status: extensionStatus }),
      batchRunner: {
        getState: () => "空闲",
        requestStop: () => undefined,
        run: async (request) => {
          runRequest = request as unknown as Record<string, unknown>;
          return {
            state: "已完成",
            candidatesChecked: 1,
            contactsSucceeded: 1,
            creditsUsed: 1,
            unknownCount: 0,
            mismatchCount: 0,
            reason: "测试",
          };
        },
      },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    const headers = {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
    };
    const session = await server.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    const { csrfToken } = session.json<{ csrfToken: string }>();
    const writeHeaders = { ...headers, "x-jobpilot-csrf": csrfToken };

    const batchWithoutSession = await server.inject({
      method: "POST",
      url: "/api/batches",
      headers: writeHeaders,
      payload: { planIds: ["go"], accountConfirmed: true },
    });
    const sessionWithoutCalibration = await server.inject({
      method: "POST",
      url: "/api/send/session",
      headers: writeHeaders,
      payload: { confirmed: true },
    });
    extensionStatus.readOnlyCalibrated = true;
    const armed = await server.inject({
      method: "POST",
      url: "/api/send/session",
      headers: writeHeaders,
      payload: { confirmed: true },
    });
    const started = await server.inject({
      method: "POST",
      url: "/api/batches",
      headers: writeHeaders,
      payload: { planIds: ["go"], accountConfirmed: true },
    });

    expect(batchWithoutSession.statusCode).toBe(409);
    expect(sessionWithoutCalibration.statusCode).toBe(409);
    expect(armed.json()).toMatchObject({
      armed: true,
      accountDisplayName: "测试求职者",
      qualified: false,
    });
    expect(started.json()).toMatchObject({
      mode: "verification",
      maxContacts: 1,
    });
    expect(runRequest).toMatchObject({
      source: "boss",
      mode: "verification",
      maxContacts: 1,
    });
  });

  it("公开扩展授权状态但不提供手工批准入口", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const server = buildServer({
      store,
      extensionBridge: extensionBridgeStub({
        status: {
          pairingState: "等待授权",
          connectionState: "未连接",
          capabilities: ["read"],
          readOnlyCalibrated: false,
        },
      }),
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

    const status = await server.inject({
      method: "GET",
      url: "/api/extension/status",
      headers,
    });
    const approved = await server.inject({
      method: "POST",
      url: "/api/extension/pairings/pair-1/approve",
      headers: { ...headers, "x-jobpilot-csrf": csrfToken },
    });

    expect(status.json()).toMatchObject({
      pairingState: "等待授权",
    });
    expect(approved.statusCode).toBe(404);
  });

  it("WebSocket 桥拒绝普通网页来源", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    const server = buildServer({
      store,
      extensionBridge: extensionBridgeStub({
        status: {
          pairingState: "未授权",
          connectionState: "未连接",
          capabilities: [],
          readOnlyCalibrated: false,
        },
      }),
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
    const rejected = await server.inject({
      method: "GET",
      url: "/extension",
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
      },
    });
    expect(rejected.statusCode).toBe(403);
  });

  it("将扩展路由升级为 WebSocket 后再交给桥接层", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
    const store = openJobPilotStore(join(directory, "jobpilot.db"));
    let attachedSocket: BridgeSocket | undefined;
    const server = buildServer({
      store,
      extensionBridge: extensionBridgeStub({
        status: {
          pairingState: "未授权",
          connectionState: "未连接",
          capabilities: [],
          readOnlyCalibrated: false,
        },
        attach(socket) {
          attachedSocket = socket;
          socket.send("connected");
        },
      }),
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

    await server.ready();
    const client = await server.injectWS("/extension", {
      headers: {
        host: "127.0.0.1:4317",
        origin: JOBPILOT_EXTENSION_ORIGIN,
      },
    });
    cleanups.push(() => client.close());

    expect(attachedSocket).toBeDefined();
    expect(typeof attachedSocket?.send).toBe("function");
    expect(typeof attachedSocket?.close).toBe("function");
    expect(typeof attachedSocket?.on).toBe("function");
  });
});

function extensionBridgeStub(options: {
  status: ExtensionStatus;
  attach?: (socket: BridgeSocket) => void;
  calibrate?: ExtensionBridge["calibrate"];
}): ExtensionBridge {
  return {
    attach: options.attach ?? (() => undefined),
    getStatus: () => options.status,
    resetPairing: () => undefined,
    calibrate:
      options.calibrate ??
      (async () => {
        throw new Error("测试未配置校准结果");
      }),
    scan: async () => {
      throw new Error("测试未配置扫描结果");
    },
    inspect: async () => {
      throw new Error("测试未配置职位检查结果");
    },
    sendOpening: async () => {
      throw new Error("测试未配置发送结果");
    },
    waitUntilPageReady: async () => undefined,
    emergencyStop: () => undefined,
    close: () => undefined,
  };
}
