import { DatabaseSync } from "node:sqlite";

import type { OpeningTemplate, SearchPlan } from "../core/config.ts";

export type SnapshotStatus =
  | "待处理"
  | "正在发起"
  | "结果未知"
  | "沟通成功"
  | "明确失败"
  | "已排除"
  | "已跳过";

export interface PositionSnapshot {
  identity: string;
  platformJobId?: string;
  url?: string;
  title: string;
  company: string;
  city?: string;
  region?: string;
  salary?: string;
  experience?: string;
  education?: string;
  industry?: string;
  publishedAt?: string;
  description?: string;
  status: SnapshotStatus;
  processedAt: string;
}

export interface JobPilotStore {
  close(): void;
  listSearchPlans(): SearchPlan[];
  saveSearchPlan(plan: SearchPlan): void;
  listTemplates(): OpeningTemplate[];
  saveTemplate(template: OpeningTemplate): void;
  hasContacted(identity: string): boolean;
  listSnapshots(limit?: number): PositionSnapshot[];
  saveSnapshot(snapshot: PositionSnapshot): void;
  deleteSnapshotsBefore(processedBefore: string): number;
  getSetting<T>(key: string, fallback: T): T;
  setSetting<T>(key: string, value: T): void;
}

interface SearchPlanRow {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  template_id: string;
  rules_json: string;
}

interface TemplateRow {
  id: string;
  name: string;
  enabled: number;
  body: string;
}

interface SnapshotRow {
  identity: string;
  platform_job_id: string | null;
  url: string | null;
  title: string;
  company: string;
  city: string | null;
  region: string | null;
  salary: string | null;
  experience: string | null;
  education: string | null;
  industry: string | null;
  published_at: string | null;
  description: string | null;
  status: SnapshotStatus;
  processed_at: string;
}

export function openJobPilotStore(path: string): JobPilotStore {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    defensive: true,
    timeout: 5_000,
  });

  database.exec("PRAGMA journal_mode = WAL;");
  migrate(database);

  const savePlanStatement = database.prepare(`
    INSERT INTO search_plans (id, name, enabled, priority, template_id, rules_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      priority = excluded.priority,
      template_id = excluded.template_id,
      rules_json = excluded.rules_json,
      updated_at = CURRENT_TIMESTAMP
  `);
  const listPlansStatement = database.prepare(`
    SELECT id, name, enabled, priority, template_id, rules_json
    FROM search_plans
    ORDER BY priority DESC, name ASC
  `);
  const saveTemplateStatement = database.prepare(`
    INSERT INTO opening_templates (id, name, enabled, body)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      body = excluded.body,
      updated_at = CURRENT_TIMESTAMP
  `);
  const listTemplatesStatement = database.prepare(`
    SELECT id, name, enabled, body
    FROM opening_templates
    ORDER BY name ASC
  `);
  const saveSnapshotStatement = database.prepare(`
    INSERT INTO position_snapshots (
      identity, platform_job_id, url, title, company, city, region, salary,
      experience, education, industry, published_at, description, status, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(identity) DO UPDATE SET
      platform_job_id = excluded.platform_job_id,
      url = excluded.url,
      title = excluded.title,
      company = excluded.company,
      city = excluded.city,
      region = excluded.region,
      salary = excluded.salary,
      experience = excluded.experience,
      education = excluded.education,
      industry = excluded.industry,
      published_at = excluded.published_at,
      description = excluded.description,
      status = excluded.status,
      processed_at = excluded.processed_at
  `);
  const hasContactedStatement = database.prepare(`
    SELECT 1 AS found FROM position_snapshots
    WHERE identity = ? AND status = '沟通成功'
    LIMIT 1
  `);
  const deleteSnapshotsBeforeStatement = database.prepare(`
    DELETE FROM position_snapshots WHERE processed_at < ?
  `);
  const getSettingStatement = database.prepare(
    `SELECT value_json FROM app_settings WHERE key = ?`,
  );
  const saveSettingStatement = database.prepare(`
    INSERT INTO app_settings (key, value_json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `);

  return {
    close() {
      database.close();
    },
    listSearchPlans() {
      return (listPlansStatement.all() as unknown as SearchPlanRow[]).map(
        (row) => ({
          id: row.id,
          name: row.name,
          enabled: row.enabled === 1,
          priority: row.priority,
          templateId: row.template_id,
          rules: JSON.parse(row.rules_json) as SearchPlan["rules"],
        }),
      );
    },
    saveSearchPlan(plan) {
      savePlanStatement.run(
        plan.id,
        plan.name,
        plan.enabled ? 1 : 0,
        plan.priority,
        plan.templateId,
        JSON.stringify(plan.rules),
      );
    },
    listTemplates() {
      return (listTemplatesStatement.all() as unknown as TemplateRow[]).map(
        (row) => ({
          id: row.id,
          name: row.name,
          enabled: row.enabled === 1,
          body: row.body,
        }),
      );
    },
    saveTemplate(template) {
      saveTemplateStatement.run(
        template.id,
        template.name,
        template.enabled ? 1 : 0,
        template.body,
      );
    },
    hasContacted(identity) {
      return hasContactedStatement.get(identity) !== undefined;
    },
    listSnapshots(limit = 200) {
      const rows = database
        .prepare(
          `
          SELECT identity, platform_job_id, url, title, company, city, region,
            salary, experience, education, industry, published_at, description,
            status, processed_at
          FROM position_snapshots
          ORDER BY processed_at DESC
          LIMIT ?
        `,
        )
        .all(limit) as unknown as SnapshotRow[];
      return rows.map(rowToSnapshot);
    },
    saveSnapshot(snapshot) {
      saveSnapshotStatement.run(
        snapshot.identity,
        snapshot.platformJobId ?? null,
        snapshot.url ?? null,
        snapshot.title,
        snapshot.company,
        snapshot.city ?? null,
        snapshot.region ?? null,
        snapshot.salary ?? null,
        snapshot.experience ?? null,
        snapshot.education ?? null,
        snapshot.industry ?? null,
        snapshot.publishedAt ?? null,
        snapshot.description ?? null,
        snapshot.status,
        snapshot.processedAt,
      );
    },
    deleteSnapshotsBefore(processedBefore) {
      return Number(
        deleteSnapshotsBeforeStatement.run(processedBefore).changes,
      );
    },
    getSetting<T>(key: string, fallback: T): T {
      const row = getSettingStatement.get(key) as
        { value_json: string } | undefined;
      return row === undefined ? fallback : (JSON.parse(row.value_json) as T);
    },
    setSetting<T>(key: string, value: T) {
      saveSettingStatement.run(key, JSON.stringify(value));
    },
  };
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS search_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      priority INTEGER NOT NULL,
      template_id TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS opening_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS position_snapshots (
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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
    COMMIT;
  `);
}

function rowToSnapshot(row: SnapshotRow): PositionSnapshot {
  return {
    identity: row.identity,
    ...(row.platform_job_id === null
      ? {}
      : { platformJobId: row.platform_job_id }),
    ...(row.url === null ? {} : { url: row.url }),
    title: row.title,
    company: row.company,
    ...(row.city === null ? {} : { city: row.city }),
    ...(row.region === null ? {} : { region: row.region }),
    ...(row.salary === null ? {} : { salary: row.salary }),
    ...(row.experience === null ? {} : { experience: row.experience }),
    ...(row.education === null ? {} : { education: row.education }),
    ...(row.industry === null ? {} : { industry: row.industry }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status,
    processedAt: row.processed_at,
  };
}
