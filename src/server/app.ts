import { randomBytes } from "node:crypto";

import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";

import type { BatchRunner } from "../core/batch-runner.ts";
import type { BatchEventBus } from "../core/events.ts";
import type { OpeningTemplate, SearchPlan } from "../core/config.ts";
import type { JobPilotStore } from "../storage/store.ts";

export interface ServerDependencies {
  store: JobPilotStore;
  batchRunner: BatchRunner;
  eventBus?: BatchEventBus;
  calibrateBoss?: (
    plan: SearchPlan,
  ) => Promise<{ candidatesRecognized: number }>;
}

export interface AppSettings {
  accountNote: string;
  adapterMode: "fake" | "boss";
  realSendEnabled: boolean;
  readOnlySmokePassed: boolean;
  cooldownMs: number;
}

interface ConfigurationBundle {
  formatVersion: 1;
  exportedAt?: string;
  plans: SearchPlan[];
  templates: OpeningTemplate[];
}

const DEFAULT_SETTINGS: AppSettings = {
  accountNote: "本地演示模式",
  adapterMode: "fake",
  realSendEnabled: false,
  readOnlySmokePassed: false,
  cooldownMs: 5_000,
};

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const csrfToken = randomBytes(24).toString("base64url");
  let lastSummary: Awaited<ReturnType<BatchRunner["run"]>> | undefined;
  let batchPromise: Promise<void> | undefined;

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
    if (origin !== undefined && !isAllowedOrigin(origin)) {
      return reply.code(403).send({ error: "请求来源不受信任" });
    }
    if (
      request.url.startsWith("/api/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
      request.headers["x-jobpilot-csrf"] !== csrfToken
    ) {
      return reply.code(403).send({ error: "防跨站请求令牌无效" });
    }
  });

  server.get("/api/health", async () => ({
    status: "ok",
    batchState: dependencies.batchRunner.getState(),
  }));

  server.get("/api/session", async () => ({ csrfToken }));

  server.get("/api/status", async () => ({
    batchState: dependencies.batchRunner.getState(),
    ...(lastSummary === undefined ? {} : { lastSummary }),
  }));

  server.get("/api/openapi.json", async () => server.swagger());

  server.get("/api/export/configuration", async () => ({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    plans: dependencies.store.listSearchPlans(),
    templates: dependencies.store.listTemplates(),
  }));

  server.post<{ Body: ConfigurationBundle }>(
    "/api/import/configuration",
    { schema: { body: configurationBundleSchema } },
    async (request, reply) => {
      if (
        !["空闲", "已完成", "已失败"].includes(
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

  server.get("/api/settings", async () =>
    dependencies.store.getSetting<AppSettings>("app", DEFAULT_SETTINGS),
  );

  server.put<{ Body: AppSettings }>(
    "/api/settings",
    { schema: { body: settingsSchema } },
    async (request, reply) => {
      if (
        !["空闲", "已完成", "已失败"].includes(
          dependencies.batchRunner.getState(),
        )
      ) {
        return reply.code(409).send({ error: "投递批次运行期间不能修改设置" });
      }
      const current = dependencies.store.getSetting<AppSettings>(
        "app",
        DEFAULT_SETTINGS,
      );
      if (request.body.readOnlySmokePassed && !current.readOnlySmokePassed) {
        return reply
          .code(409)
          .send({ error: "只读校准状态只能由校准流程写入" });
      }
      if (request.body.realSendEnabled && !request.body.readOnlySmokePassed) {
        return reply
          .code(409)
          .send({ error: "只读校准未通过，不能启用真实发送" });
      }
      if (request.body.adapterMode !== "boss" && request.body.realSendEnabled) {
        return reply
          .code(409)
          .send({ error: "只有 Boss 真实页面模式可以启用真实发送" });
      }
      dependencies.store.setSetting("app", request.body);
      return reply.code(204).send();
    },
  );

  server.post("/api/calibration/boss", async (_request, reply) => {
    if (dependencies.calibrateBoss === undefined) {
      return reply.code(501).send({ error: "当前运行环境未配置 Boss 校准器" });
    }
    if (
      !["空闲", "已完成", "已失败"].includes(
        dependencies.batchRunner.getState(),
      )
    ) {
      return reply.code(409).send({ error: "投递批次运行期间不能开始校准" });
    }
    const plan = dependencies.store
      .listSearchPlans()
      .find((item) => item.enabled);
    if (plan === undefined) {
      return reply.code(422).send({ error: "请先启用至少一个搜索方案" });
    }
    try {
      const result = await dependencies.calibrateBoss(plan);
      const settings = dependencies.store.getSetting<AppSettings>(
        "app",
        DEFAULT_SETTINGS,
      );
      dependencies.store.setSetting("app", {
        ...settings,
        readOnlySmokePassed: true,
        realSendEnabled: false,
      });
      return { calibrated: true, ...result };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Boss 只读校准失败",
      });
    }
  });

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
      const settings = dependencies.store.getSetting<AppSettings>(
        "app",
        DEFAULT_SETTINGS,
      );
      if (settings.adapterMode === "boss" && !settings.realSendEnabled) {
        return reply.code(409).send({ error: "真实发送尚未解锁" });
      }
      const selectedIds = new Set(request.body.planIds);
      const plans = dependencies.store
        .listSearchPlans()
        .filter((plan) => selectedIds.has(plan.id));
      if (plans.length === 0) {
        return reply.code(422).send({ error: "没有可运行的搜索方案" });
      }
      const templates = dependencies.store.listTemplates();
      batchPromise = dependencies.batchRunner
        .run({ plans, templates, maxContacts: 20, maxCandidates: 200 })
        .then((summary) => {
          lastSummary = summary;
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
      return reply.code(202).send({ started: true });
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
    readOnlySmokePassed: Type.Boolean(),
    cooldownMs: Type.Integer({ minimum: 0, maximum: 60_000 }),
  },
  { additionalProperties: false },
);

function isAllowedOrigin(origin: string): boolean {
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
