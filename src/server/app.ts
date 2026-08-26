import { randomBytes, randomUUID } from "node:crypto";

import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import fastifyWebsocket from "@fastify/websocket";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";

import { positionIdentity, type BatchRunner } from "../core/batch-runner.ts";
import type { BatchEventBus } from "../core/events.ts";
import type { OpeningTemplate, SearchPlan } from "../core/config.ts";
import type { ExtensionBridge } from "../extension/bridge.ts";
import {
  EXTENSION_MESSAGE_LIMIT_BYTES,
  JOBPILOT_EXTENSION_ORIGIN,
  type ExtensionStatus,
} from "../extension/protocol.ts";
import type { JobPilotStore } from "../storage/store.ts";

export interface ServerDependencies {
  store: JobPilotStore;
  batchRunner: BatchRunner;
  eventBus?: BatchEventBus;
  extensionBridge?: ExtensionBridge;
}

export interface AppSettings {
  accountNote: string;
  adapterMode: "fake" | "boss";
  realSendEnabled: boolean;
  cooldownMs: number;
}

interface ConfigurationBundle {
  formatVersion: 1;
  exportedAt?: string;
  plans: SearchPlan[];
  templates: OpeningTemplate[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  accountNote: "本地演示模式",
  adapterMode: "fake",
  realSendEnabled: false,
  cooldownMs: 5_000,
};

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const csrfToken = randomBytes(24).toString("base64url");
  let lastSummary: Awaited<ReturnType<BatchRunner["run"]>> | undefined;
  let batchPromise: Promise<void> | undefined;
  let sendSessionArmed = false;
  const sendSessionMetrics = {
    creditsUsed: 0,
    contactsSucceeded: 0,
    unknownCount: 0,
    mismatchCount: 0,
  };

  void server.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  void server.register(swagger, {
    openapi: {
      info: { title: "JobPilot local API", version: "0.1.0" },
      servers: [{ url: "http://127.0.0.1:4317" }],
    },
  });
  server.addHook("onRequest", async (request, reply) => {
    const hostname = request.hostname.toLocaleLowerCase();
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      return reply.code(403).send({ error: "仅允许本机访问" });
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const allowed =
        request.url === "/extension"
          ? origin === JOBPILOT_EXTENSION_ORIGIN
          : isAllowedWebOrigin(origin);
      if (!allowed) {
        return reply.code(403).send({ error: "请求来源不受信任" });
      }
    }
    if (
      request.url.startsWith("/api/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
      request.headers["x-jobpilot-csrf"] !== csrfToken
    ) {
      return reply.code(403).send({ error: "防跨站请求令牌无效" });
    }
  });

  void server
    .register(fastifyWebsocket, {
      options: { maxPayload: EXTENSION_MESSAGE_LIMIT_BYTES },
    })
    .after(() => {
      server.get("/extension", { websocket: true }, (socket) => {
        if (dependencies.extensionBridge === undefined) {
          socket.close(1013, "扩展桥尚未配置");
          return;
        }
        dependencies.extensionBridge.attach(socket);
      });
    });
  server.addHook("onClose", async () => {
    dependencies.extensionBridge?.close();
  });

  server.get("/api/health", async () => ({
    status: "ok",
    batchState: dependencies.batchRunner.getState(),
  }));

  server.get("/api/session", async () => ({ csrfToken }));

  server.get("/api/status", async () => ({
    batchState: dependencies.batchRunner.getState(),
    sendSession: {
      armed: sendSessionArmed,
      ...sendSessionMetrics,
      ...dependencies.store.getSendReadiness(),
      pending: pendingOperations(),
    },
    ...(lastSummary === undefined ? {} : { lastSummary }),
  }));

  server.get("/api/openapi.json", async () => server.swagger());

  server.get("/api/export/configuration", async () => ({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    plans: dependencies.store.listSearchPlans(),
    templates: dependencies.store.listTemplates(),
  }));

  server.get("/api/export/operations", async () => ({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    events: dependencies.store.listContactOperationEvents(10_000),
  }));

  server.post<{ Body: ConfigurationBundle }>(
    "/api/import/configuration",
    { schema: { body: configurationBundleSchema } },
    async (request, reply) => {
      if (
        !["空闲", "已完成", "已完成有异常", "人工接管", "已失败"].includes(
          dependencies.batchRunner.getState(),
        )
      ) {
        return reply.code(409).send({ error: "投递批次运行期间不能导入配置" });
      }
      for (const template of request.body.templates)
        dependencies.store.saveTemplate(template);
      for (const plan of request.body.plans)
        dependencies.store.saveSearchPlan(plan);
      return reply.code(200).send({
        importedPlans: request.body.plans.length,
        importedTemplates: request.body.templates.length,
      });
    },
  );

  server.get("/api/plans", async () => dependencies.store.listSearchPlans());

  server.put<{ Params: { id: string }; Body: SearchPlan }>(
    "/api/plans/:id",
    {
      schema: {
        params: Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100 }),
        }),
        body: searchPlanSchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.id) {
        return reply.code(409).send({ error: "路径 ID 与搜索方案 ID 不一致" });
      }
      dependencies.store.saveSearchPlan(request.body);
      return reply.code(204).send();
    },
  );

  server.get("/api/templates", async () => dependencies.store.listTemplates());

  server.put<{ Params: { id: string }; Body: OpeningTemplate }>(
    "/api/templates/:id",
    {
      schema: {
        params: Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100 }),
        }),
        body: openingTemplateSchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.id) {
        return reply.code(409).send({ error: "路径 ID 与模板 ID 不一致" });
      }
      dependencies.store.saveTemplate(request.body);
      return reply.code(204).send();
    },
  );

  server.get("/api/snapshots", async (request) => {
    const query = request.query as { limit?: string };
    const requestedLimit = Number(query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 100;
    return dependencies.store.listSnapshots(limit);
  });

  server.delete<{ Body: { processedBefore: string } }>(
    "/api/snapshots",
    {
      schema: {
        body: Type.Object({
          processedBefore: Type.String({ format: "date-time" }),
        }),
      },
    },
    async (request) => ({
      deleted: dependencies.store.deleteSnapshotsBefore(
        request.body.processedBefore,
      ),
    }),
  );

  server.get("/api/settings", async () => readAppSettings(dependencies.store));

  server.get("/api/extension/status", async () => extensionStatus());

  server.get("/api/send/readiness", async () => ({
    armed: sendSessionArmed,
    ...sendSessionMetrics,
    ...dependencies.store.getSendReadiness(),
    pending: pendingOperations(),
  }));

  server.post<{ Body: { confirmed: true } }>(
    "/api/send/session",
    {
      schema: {
        body: Type.Object({ confirmed: Type.Literal(true) }),
      },
    },
    async (_request, reply) => {
      if (batchPromise !== undefined) {
        return reply
          .code(409)
          .send({ error: "投递批次运行期间不能建立发送会话" });
      }
      const settings = readAppSettings(dependencies.store);
      if (settings.adapterMode !== "boss") {
        return reply.code(409).send({ error: "请先切换到 Boss 真实页面模式" });
      }
      const status = extensionStatus();
      if (
        status.connectionState !== "页面已连接" ||
        !status.readOnlyCalibrated ||
        !status.capabilities.includes("batch-send")
      ) {
        return reply
          .code(409)
          .send({ error: "请先完成当前 Boss 页面的读取校准" });
      }
      sendSessionArmed = true;
      return {
        armed: true,
        accountDisplayName: status.page?.accountDisplayName ?? "账号无法识别",
        ...dependencies.store.getSendReadiness(),
      };
    },
  );

  server.delete("/api/send/session", async (_request, reply) => {
    sendSessionArmed = false;
    if (batchPromise !== undefined)
      dependencies.batchRunner.requestStop("普通");
    return reply
      .code(202)
      .send({ armed: false, stopping: batchPromise !== undefined });
  });

  server.post("/api/send/qualification/reset", async (_request, reply) => {
    if (batchPromise !== undefined) {
      return reply.code(409).send({ error: "投递批次运行期间不能重置资格" });
    }
    dependencies.store.resetSendQualification();
    return { reset: true, ...dependencies.store.getSendReadiness() };
  });

  server.post<{
    Params: { operationId: string };
  }>(
    "/api/contact-operations/:operationId/inspect",
    {
      schema: {
        params: Type.Object({
          operationId: Type.String({ minLength: 1, maxLength: 100 }),
        }),
      },
    },
    async (request, reply) => {
      if (batchPromise !== undefined) {
        return reply.code(409).send({ error: "请在投递批次结束后人工核实" });
      }
      const operation = dependencies.store
        .listPendingContactOperations()
        .find((item) => item.operationId === request.params.operationId);
      if (operation === undefined) {
        return reply.code(404).send({ error: "待核实沟通操作不存在" });
      }
      try {
        const inspected = await inspectPendingOperation(operation);
        return {
          verified: true,
          contactState: inspected.contactState,
          candidate: inspected.candidate,
        };
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "无法核实对应职位",
        });
      }
    },
  );

  server.post<{
    Params: { operationId: string };
    Body: { resolution: "人工确认已发送" | "人工确认未发送" };
  }>(
    "/api/contact-operations/:operationId/resolve",
    {
      schema: {
        params: Type.Object({
          operationId: Type.String({ minLength: 1, maxLength: 100 }),
        }),
        body: Type.Object({
          resolution: Type.Union([
            Type.Literal("人工确认已发送"),
            Type.Literal("人工确认未发送"),
          ]),
        }),
      },
    },
    async (request, reply) => {
      if (batchPromise !== undefined) {
        return reply.code(409).send({ error: "请在投递批次结束后人工核实" });
      }
      const operation = dependencies.store
        .listPendingContactOperations()
        .find((item) => item.operationId === request.params.operationId);
      if (operation === undefined) {
        return reply.code(404).send({ error: "待核实沟通操作不存在" });
      }
      try {
        await inspectPendingOperation(operation);
        dependencies.store.resolveContactOperation(
          operation.operationId,
          request.body.resolution,
          new Date().toISOString(),
        );
        return { resolved: true, ...dependencies.store.getSendReadiness() };
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "无法核实对应职位",
        });
      }
    },
  );

  server.post("/api/extension/pairing/reset", async (_request, reply) => {
    if (dependencies.extensionBridge === undefined) {
      return reply.code(501).send({ error: "当前运行环境未配置扩展桥" });
    }
    if (
      !["空闲", "已完成", "已完成有异常", "人工接管", "已失败"].includes(
        dependencies.batchRunner.getState(),
      )
    ) {
      return reply
        .code(409)
        .send({ error: "投递批次运行期间不能重置扩展授权" });
    }
    dependencies.extensionBridge.resetPairing();
    return { reset: true };
  });

  server.post("/api/extension/disconnect", async (_request, reply) => {
    if (dependencies.extensionBridge === undefined) {
      return reply.code(501).send({ error: "当前运行环境未配置扩展桥" });
    }
    dependencies.extensionBridge.emergencyStop("求职者已解除页面连接");
    return { disconnected: true };
  });

  server.put<{ Body: AppSettings }>(
    "/api/settings",
    { schema: { body: settingsSchema } },
    async (request, reply) => {
      if (
        !["空闲", "已完成", "已完成有异常", "人工接管", "已失败"].includes(
          dependencies.batchRunner.getState(),
        )
      ) {
        return reply.code(409).send({ error: "投递批次运行期间不能修改设置" });
      }
      if (request.body.realSendEnabled) {
        return reply.code(409).send({
          error: "第一阶段仅开放只读校准，真实发送固定关闭",
        });
      }
      dependencies.store.setSetting("app", request.body);
      return reply.code(204).send();
    },
  );

  server.post<{ Body: { planIds: string[]; accountConfirmed: boolean } }>(
    "/api/batches",
    {
      schema: {
        body: Type.Object({
          planIds: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            maxItems: 50,
          }),
          accountConfirmed: Type.Literal(true),
        }),
      },
    },
    async (request, reply) => {
      if (batchPromise !== undefined) {
        return reply.code(409).send({ error: "已有投递批次正在运行" });
      }
      const settings = readAppSettings(dependencies.store);
      const isBoss = settings.adapterMode === "boss";
      if (isBoss && !sendSessionArmed) {
        return reply.code(409).send({ error: "请先建立本进程的发送会话授权" });
      }
      if (isBoss) {
        const status = extensionStatus();
        if (
          status.connectionState !== "页面已连接" ||
          !status.readOnlyCalibrated ||
          !status.capabilities.includes("batch-send")
        ) {
          return reply
            .code(409)
            .send({ error: "当前 Boss 页面尚未完成读取校准" });
        }
      }
      const selectedIds = new Set(request.body.planIds);
      const plans = dependencies.store
        .listSearchPlans()
        .filter((plan) => selectedIds.has(plan.id));
      if (plans.length === 0) {
        return reply.code(422).send({ error: "没有可运行的搜索方案" });
      }
      const templates = dependencies.store.listTemplates();
      const batchId = randomUUID();
      const readiness = dependencies.store.getSendReadiness();
      const mode = isBoss
        ? readiness.qualified
          ? "full"
          : "verification"
        : "demo";
      const maxContacts = mode === "verification" ? 1 : 20;
      batchPromise = dependencies.batchRunner
        .run({
          batchId,
          source: isBoss ? "boss" : "demo",
          mode,
          plans,
          templates,
          maxContacts,
          maxCandidates: 200,
        })
        .then((summary) => {
          lastSummary = summary;
          if (isBoss) {
            sendSessionMetrics.creditsUsed += summary.creditsUsed ?? 0;
            sendSessionMetrics.contactsSucceeded += summary.contactsSucceeded;
            sendSessionMetrics.unknownCount += summary.unknownCount ?? 0;
            sendSessionMetrics.mismatchCount += summary.mismatchCount ?? 0;
          }
          if (
            mode === "verification" &&
            summary.contactsSucceeded === 1 &&
            (summary.unknownCount ?? 0) === 0 &&
            (summary.mismatchCount ?? 0) === 0
          ) {
            dependencies.store.recordValidationSuccess(
              batchId,
              new Date().toISOString(),
            );
          }
        })
        .catch((error: unknown) => {
          lastSummary = {
            state: "已失败",
            candidatesChecked: 0,
            contactsSucceeded: 0,
            reason: error instanceof Error ? error.message : "未知错误",
          };
        })
        .finally(() => {
          batchPromise = undefined;
        });
      return reply
        .code(202)
        .send({ started: true, batchId, mode, maxContacts });
    },
  );

  server.post<{ Body: { mode: "普通" | "紧急" } }>(
    "/api/batches/stop",
    {
      schema: {
        body: Type.Object({
          mode: Type.Union([Type.Literal("普通"), Type.Literal("紧急")]),
        }),
      },
    },
    async (request, reply) => {
      dependencies.batchRunner.requestStop(request.body.mode);
      return reply.code(202).send({ stopping: true, mode: request.body.mode });
    },
  );

  server.get("/api/events", async (request, reply) => {
    if (dependencies.eventBus === undefined) {
      return reply.code(204).send();
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(
      `event: ready\ndata: ${JSON.stringify({ ready: true })}\n\n`,
    );
    const unsubscribe = dependencies.eventBus.subscribe((event) => {
      reply.raw.write(`event: batch\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(
      () => reply.raw.write(": keepalive\n\n"),
      20_000,
    );
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return server;

  function extensionStatus(): ExtensionStatus {
    return (
      dependencies.extensionBridge?.getStatus() ?? {
        pairingState: "未授权",
        connectionState: "未连接",
        capabilities: [],
        readOnlyCalibrated: false,
        preparation: {
          state: "idle",
          stage: "connecting",
          message: "等待连接当前页面",
        },
      }
    );
  }

  function pendingOperations() {
    const snapshots = new Map(
      dependencies.store
        .listSnapshots(500)
        .map((snapshot) => [snapshot.identity, snapshot]),
    );
    return dependencies.store
      .listPendingContactOperations()
      .map((operation) => {
        const snapshot = snapshots.get(operation.identity);
        return {
          operationId: operation.operationId,
          identity: operation.identity,
          title: snapshot?.title ?? operation.identity,
          company: snapshot?.company ?? "未知公司",
          messageHash: operation.messageHash,
          messageLength: operation.messageLength,
          updatedAt: operation.updatedAt,
        };
      });
  }

  async function inspectPendingOperation(
    operation: ReturnType<
      JobPilotStore["listPendingContactOperations"]
    >[number],
  ) {
    const snapshot = dependencies.store
      .listSnapshots(500)
      .find((item) => item.identity === operation.identity);
    if (
      dependencies.extensionBridge === undefined ||
      snapshot === undefined ||
      operation.url === undefined
    ) {
      throw new Error("无法打开并核对对应职位页面");
    }
    const inspected = await dependencies.extensionBridge.inspect({
      ...(operation.platformJobId === undefined
        ? {}
        : { id: operation.platformJobId }),
      url: operation.url,
      title: snapshot.title,
      company: snapshot.company,
    });
    if (
      positionIdentity(inspected.candidate, operation.source) !==
      operation.identity
    ) {
      throw new Error("当前职位与待核实操作不一致");
    }
    return inspected;
  }
}

const educationSchema = Type.Union([
  Type.Literal("不限"),
  Type.Literal("中专/高中"),
  Type.Literal("大专"),
  Type.Literal("本科"),
  Type.Literal("硕士"),
  Type.Literal("博士"),
]);

const hardRuleSchema = Type.Object(
  {
    titleKeywords: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 30,
    }),
    cities: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 30,
    }),
    regions: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
    ),
    minSalaryK: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
    maxExperienceYears: Type.Optional(
      Type.Number({ minimum: 0, maximum: 100 }),
    ),
    candidateEducation: Type.Optional(educationSchema),
    companyBlacklist: Type.Array(Type.String({ minLength: 1 }), {
      maxItems: 1_000,
    }),
    companyAliases: Type.Optional(
      Type.Record(Type.String(), Type.Array(Type.String())),
    ),
    industryBlacklist: Type.Array(Type.String({ minLength: 1 }), {
      maxItems: 500,
    }),
    publishedWithinDays: Type.Optional(
      Type.Number({ minimum: 0, maximum: 3_650 }),
    ),
    allowRemote: Type.Boolean(),
  },
  { additionalProperties: false },
);

const searchPlanSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-zA-Z0-9_-]+$",
    }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    enabled: Type.Boolean(),
    priority: Type.Integer({ minimum: -1_000, maximum: 1_000 }),
    templateId: Type.String({ minLength: 1, maxLength: 100 }),
    rules: hardRuleSchema,
  },
  { additionalProperties: false },
);

const openingTemplateSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-zA-Z0-9_-]+$",
    }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    enabled: Type.Boolean(),
    body: Type.String({ minLength: 1, maxLength: 1_000 }),
  },
  { additionalProperties: false },
);

const configurationBundleSchema = Type.Object(
  {
    formatVersion: Type.Literal(1),
    exportedAt: Type.Optional(Type.String({ format: "date-time" })),
    plans: Type.Array(searchPlanSchema, { maxItems: 500 }),
    templates: Type.Array(openingTemplateSchema, { maxItems: 500 }),
  },
  { additionalProperties: false },
);

const settingsSchema = Type.Object(
  {
    accountNote: Type.String({ minLength: 1, maxLength: 100 }),
    adapterMode: Type.Union([Type.Literal("fake"), Type.Literal("boss")]),
    realSendEnabled: Type.Boolean(),
    cooldownMs: Type.Integer({ minimum: 0, maximum: 60_000 }),
  },
  { additionalProperties: false },
);

function isAllowedWebOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      (url.port === "4317" || url.port === "5173")
    );
  } catch {
    return false;
  }
}

export function readAppSettings(store: JobPilotStore): AppSettings {
  const stored = store.getSetting<Partial<AppSettings>>("app", {});
  return {
    accountNote:
      typeof stored.accountNote === "string" && stored.accountNote.trim() !== ""
        ? stored.accountNote
        : DEFAULT_SETTINGS.accountNote,
    adapterMode:
      stored.adapterMode === "boss" || stored.adapterMode === "fake"
        ? stored.adapterMode
        : DEFAULT_SETTINGS.adapterMode,
    realSendEnabled: false,
    cooldownMs:
      typeof stored.cooldownMs === "number"
        ? stored.cooldownMs
        : DEFAULT_SETTINGS.cooldownMs,
  };
}
