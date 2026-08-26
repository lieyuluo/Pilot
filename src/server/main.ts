import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";

import { createExtensionBossAdapter } from "../adapters/boss/extension-boss-adapter.ts";
import { createFakeAdapter } from "../adapters/fake/fake-adapter.ts";
import { createSwitchingAdapter } from "../adapters/switching-adapter.ts";
import { createBatchRunner } from "../core/batch-runner.ts";
import { createBatchEventBus } from "../core/events.ts";
import { createExtensionBridge } from "../extension/bridge.ts";
import { buildServer, readAppSettings } from "./app.ts";
import { resolveAppPaths } from "./paths.ts";
import { openJobPilotStore } from "../storage/store.ts";

const paths = resolveAppPaths();
for (const directory of [paths.root, paths.backups]) {
  mkdirSync(directory, { recursive: true });
}
if (existsSync(paths.database)) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  copyFileSync(paths.database, join(paths.backups, `jobpilot-${timestamp}.db`));
}

const store = openJobPilotStore(paths.database);
store.recoverInterruptedContactOperations(new Date().toISOString());
seedExamples();
if (!store.getSetting("extensionArchitectureMigrated", false)) {
  store.setSetting("app", {
    ...readAppSettings(store),
    realSendEnabled: false,
  });
  store.setSetting("extensionArchitectureMigrated", true);
}
const eventBus = createBatchEventBus();
const fakeAdapter = createFakeAdapter();
const extensionBridge = createExtensionBridge({
  settings: store,
});
const bossAdapter = createExtensionBossAdapter(extensionBridge);
const adapter = createSwitchingAdapter({
  store,
  fake: fakeAdapter,
  boss: bossAdapter,
});
const runner = createBatchRunner({
  store,
  adapter,
  cooldownMs: () => {
    const settings = readAppSettings(store);
    return settings.adapterMode === "boss"
      ? Math.max(settings.cooldownMs, 5_000)
      : settings.cooldownMs;
  },
  onEvent: eventBus.publish,
});
extensionBridge.setPreparationHandler?.(async () => {
  if (
    !["空闲", "已完成", "已完成有异常", "人工接管", "已失败"].includes(
      runner.getState(),
    )
  ) {
    throw new Error("投递批次运行中，请先在 JobPilot 中停止批次");
  }
  const plan = store
    .listSearchPlans()
    .filter((candidate) => candidate.enabled)
    .sort((left, right) => right.priority - left.priority)[0];
  if (plan === undefined) {
    throw new Error("没有已启用的搜索方案，请先在 JobPilot 中启用一个方案");
  }
  store.setSetting("app", {
    ...readAppSettings(store),
    adapterMode: "boss",
    realSendEnabled: false,
  });
  return plan;
});
const server = buildServer({
  store,
  batchRunner: runner,
  eventBus,
  extensionBridge,
});

if (existsSync(join(process.cwd(), "dist", "web"))) {
  void server.register(fastifyStatic, {
    root: join(process.cwd(), "dist", "web"),
    wildcard: false,
  });
  server.setNotFoundHandler((request, reply) => {
    if (!request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "接口不存在" });
  });
}

await server.listen({ host: "127.0.0.1", port: 4317 });
console.log("JobPilot 已启动：http://127.0.0.1:4317");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}

function seedExamples(): void {
  if (store.listTemplates().length === 0) {
    store.saveTemplate({
      id: "default",
      name: "示例开场模板",
      enabled: false,
      body: "您好，我对贵公司的{{职位名称}}很感兴趣，希望进一步沟通。",
    });
  }
  if (store.listSearchPlans().length === 0) {
    store.saveSearchPlan({
      id: "go-beijing",
      name: "示例 · 北京 Go",
      enabled: false,
      priority: 10,
      templateId: "default",
      rules: {
        titleKeywords: ["Go"],
        cities: ["北京"],
        minSalaryK: 20,
        maxExperienceYears: 3,
        candidateEducation: "本科",
        companyBlacklist: [],
        industryBlacklist: [],
        publishedWithinDays: 7,
        allowRemote: false,
      },
    });
  }
}
