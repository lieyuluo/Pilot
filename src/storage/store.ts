import { DatabaseSync } from "node:sqlite";

import type { OpeningTemplate, SearchPlan } from "../core/config.ts";
import type { RuleExclusion } from "../core/rules.ts";

export type SnapshotStatus =
  | "待处理"
  | "正在发起"
  | "结果未知"
  | "沟通成功"
  | "明确未开始"
  | "内容不符"
  | "平台已沟通"
  | "已排除"
  | "已跳过";

export type ContactOperationState =
  | "预占"
  | "命令已下发"
  | "明确未开始"
  | "沟通成功"
  | "结果未知"
  | "内容不符"
  | "人工确认已发送"
  | "人工确认未发送";

export interface ContactOperation {
  operationId: string;
  commandId: string;
  batchId: string;
  source: "demo" | "boss";
  identity: string;
  platformJobId?: string;
  url?: string;
  planId: string;
  templateId: string;
  messageHash: string;
  messageLength: number;
  state: ContactOperationState;
  createdAt: string;
  updatedAt: string;
}

export interface ContactOperationEvent {
  id: number;
  operationId: string;
  type: ContactOperationState;
  at: string;
  details?: Record<string, unknown>;
}

export interface ReserveContactOperation {
  operationId: string;
  commandId: string;
  batchId: string;
  source: "demo" | "boss";
  identity: string;
  platformJobId?: string;
  url?: string;
  planId: string;
  templateId: string;
  messageHash: string;
  messageLength: number;
  at: string;
}

export interface SendReadiness {
  validationSuccesses: number;
  pendingCount: number;
  qualified: boolean;
}

export interface ContactOperationDiagnostic {
  operationId: string;
  stage: string;
  outcome: string;
  errorCategory?: string;
  durationMs: number;
  at: string;
}

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
  exclusionReasons?: RuleExclusion[];
  processedAt: string;
}

export interface JobPilotStore {
  close(): void;
  listSearchPlans(): SearchPlan[];
  saveSearchPlan(plan: SearchPlan): void;
  listTemplates(): OpeningTemplate[];
  saveTemplate(template: OpeningTemplate): void;
  hasContacted(identity: string, source?: "demo" | "boss"): boolean;
  listSnapshots(limit?: number): PositionSnapshot[];
  saveSnapshot(snapshot: PositionSnapshot): void;
  deleteSnapshotsBefore(processedBefore: string): number;
  reserveContactOperation(input: ReserveContactOperation): ContactOperation;
  markContactOperationDispatched(operationId: string, at: string): void;
  completeContactOperation(
    operationId: string,
    state: Exclude<ContactOperationState, "预占" | "命令已下发">,
    at: string,
    details?: Record<string, unknown>,
  ): void;
  recoverInterruptedContactOperations(at: string): number;
  listPendingContactOperations(): ContactOperation[];
  resolveContactOperation(
    operationId: string,
    resolution: "人工确认已发送" | "人工确认未发送",
    at: string,
  ): void;
  listContactOperationEvents(limit?: number): ContactOperationEvent[];
  recordContactOperationDiagnostic(input: ContactOperationDiagnostic): void;
  deleteContactOperationDiagnosticsBefore(before: string): number;
  recordValidationSuccess(batchId: string, at: string): void;
  getSendReadiness(): SendReadiness;
  resetSendQualification(): void;
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
  exclusion_reasons_json: string | null;
  processed_at: string;
}

interface ContactOperationRow {
  operation_id: string;
  command_id: string;
  batch_id: string;
  source: "demo" | "boss";
  identity: string;
  platform_job_id: string | null;
  url: string | null;
  plan_id: string;
  template_id: string;
  message_hash: string;
  message_length: number;
  current_state: ContactOperationState;
  created_at: string;
  updated_at: string;
}

interface ContactOperationEventRow {
  id: number;
  operation_id: string;
  event_type: ContactOperationState;
  at: string;
  details_json: string | null;
}

export function openJobPilotStore(path: string): JobPilotStore {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    defensive: true,
    timeout: 5_000,
  });

  database.exec("PRAGMA journal_mode = WAL;");
  migrate(database);
  database
    .prepare(`DELETE FROM contact_operation_diagnostics WHERE at < ?`)
    .run(new Date(Date.now() - 14 * 24 * 60 * 60 * 1_000).toISOString());

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
      experience, education, industry, published_at, description, status,
      exclusion_reasons_json, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      exclusion_reasons_json = excluded.exclusion_reasons_json,
      processed_at = excluded.processed_at
  `);
  const hasContactedStatement = database.prepare(`
    SELECT 1 AS found FROM contact_operations
    WHERE source = ? AND identity = ? AND current_state IN (
      '命令已下发', '沟通成功', '结果未知', '内容不符', '人工确认已发送'
    )
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
  const insertOperationStatement = database.prepare(`
    INSERT INTO contact_operations (
      operation_id, command_id, batch_id, source, identity, platform_job_id,
      url, plan_id, template_id, message_hash, message_length, current_state,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '预占', ?, ?)
  `);
  const insertOperationEventStatement = database.prepare(`
    INSERT INTO contact_operation_events (operation_id, event_type, at, details_json)
    VALUES (?, ?, ?, ?)
  `);
  const updateOperationStateStatement = database.prepare(`
    UPDATE contact_operations SET current_state = ?, updated_at = ?
    WHERE operation_id = ?
  `);
  const getOperationStatement = database.prepare(`
    SELECT operation_id, command_id, batch_id, source, identity,
      platform_job_id, url, plan_id, template_id, message_hash,
      message_length, current_state, created_at, updated_at
    FROM contact_operations WHERE operation_id = ?
  `);
  const listPendingOperationsStatement = database.prepare(`
    SELECT operation_id, command_id, batch_id, source, identity,
      platform_job_id, url, plan_id, template_id, message_hash,
      message_length, current_state, created_at, updated_at
    FROM contact_operations WHERE current_state = '结果未知'
    ORDER BY updated_at ASC
  `);
  const insertOperationDiagnosticStatement = database.prepare(`
    INSERT INTO contact_operation_diagnostics (
      operation_id, stage, outcome, error_category, duration_ms, at
    ) VALUES (?, ?, ?, ?, ?, ?)
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
    hasContacted(identity, source = "boss") {
      return hasContactedStatement.get(source, identity) !== undefined;
    },
    listSnapshots(limit = 200) {
      const rows = database
        .prepare(
          `
          SELECT identity, platform_job_id, url, title, company, city, region,
            salary, experience, education, industry, published_at, description,
            status, exclusion_reasons_json, processed_at
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
        snapshot.exclusionReasons === undefined
          ? null
          : JSON.stringify(snapshot.exclusionReasons),
        snapshot.processedAt,
      );
    },
    deleteSnapshotsBefore(processedBefore) {
      return Number(
        deleteSnapshotsBeforeStatement.run(processedBefore).changes,
      );
    },
    reserveContactOperation(input) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        insertOperationStatement.run(
          input.operationId,
          input.commandId,
          input.batchId,
          input.source,
          input.identity,
          input.platformJobId ?? null,
          input.url ?? null,
          input.planId,
          input.templateId,
          input.messageHash,
          input.messageLength,
          input.at,
          input.at,
        );
        insertOperationEventStatement.run(
          input.operationId,
          "预占",
          input.at,
          null,
        );
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      return rowToContactOperation(
        getOperationStatement.get(
          input.operationId,
        ) as unknown as ContactOperationRow,
      );
    },
    markContactOperationDispatched(operationId, at) {
      appendOperationState(operationId, "命令已下发", at);
    },
    completeContactOperation(operationId, state, at, details) {
      appendOperationState(operationId, state, at, details);
    },
    recoverInterruptedContactOperations(at) {
      const rows = database
        .prepare(
          `SELECT operation_id, current_state FROM contact_operations
           WHERE current_state IN ('预占', '命令已下发')`,
        )
        .all() as unknown as Array<{
        operation_id: string;
        current_state: "预占" | "命令已下发";
      }>;
      for (const row of rows) {
        appendOperationState(
          row.operation_id,
          row.current_state === "预占" ? "明确未开始" : "结果未知",
          at,
          { recoveredAfterRestart: true },
        );
      }
      return rows.length;
    },
    listPendingContactOperations() {
      return (
        listPendingOperationsStatement.all() as unknown as ContactOperationRow[]
      ).map(rowToContactOperation);
    },
    resolveContactOperation(operationId, resolution, at) {
      const row = getOperationStatement.get(operationId) as unknown as
        ContactOperationRow | undefined;
      if (row === undefined) throw new Error("沟通操作不存在");
      if (row.current_state !== "结果未知") {
        throw new Error("只有结果未知的沟通操作可以人工核实");
      }
      appendOperationState(operationId, resolution, at, {
        resolvedBy: "求职者",
      });
    },
    listContactOperationEvents(limit = 1_000) {
      const rows = database
        .prepare(
          `SELECT id, operation_id, event_type, at, details_json
           FROM contact_operation_events ORDER BY id DESC LIMIT ?`,
        )
        .all(limit) as unknown as ContactOperationEventRow[];
      return rows.map((row) => ({
        id: row.id,
        operationId: row.operation_id,
        type: row.event_type,
        at: row.at,
        ...(row.details_json === null
          ? {}
          : {
              details: JSON.parse(row.details_json) as Record<string, unknown>,
            }),
      }));
    },
    recordContactOperationDiagnostic(input) {
      insertOperationDiagnosticStatement.run(
        input.operationId,
        input.stage,
        input.outcome,
        input.errorCategory ?? null,
        input.durationMs,
        input.at,
      );
    },
    deleteContactOperationDiagnosticsBefore(before) {
      return Number(
        database
          .prepare(`DELETE FROM contact_operation_diagnostics WHERE at < ?`)
          .run(before).changes,
      );
    },
    recordValidationSuccess(batchId, at) {
      database
        .prepare(
          `INSERT OR IGNORE INTO validation_successes (batch_id, succeeded_at)
           VALUES (?, ?)`,
        )
        .run(batchId, at);
    },
    getSendReadiness() {
      const validation = database
        .prepare(`SELECT COUNT(*) AS count FROM validation_successes`)
        .get() as unknown as { count: number };
      const pending = database
        .prepare(
          `SELECT COUNT(*) AS count FROM contact_operations
           WHERE current_state = '结果未知'`,
        )
        .get() as unknown as { count: number };
      return {
        validationSuccesses: validation.count,
        pendingCount: pending.count,
        qualified: validation.count >= 5 && pending.count === 0,
      };
    },
    resetSendQualification() {
      database.exec("DELETE FROM validation_successes;");
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

  function appendOperationState(
    operationId: string,
    state: ContactOperationState,
    at: string,
    details?: Record<string, unknown>,
  ): void {
    database.exec("BEGIN IMMEDIATE;");
    try {
      const updated = updateOperationStateStatement.run(state, at, operationId);
      if (Number(updated.changes) !== 1) throw new Error("沟通操作不存在");
      insertOperationEventStatement.run(
        operationId,
        state,
        at,
        details === undefined ? null : JSON.stringify(details),
      );
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
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
      exclusion_reasons_json TEXT,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contact_operations (
      operation_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      batch_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('demo', 'boss')),
      identity TEXT NOT NULL,
      platform_job_id TEXT,
      url TEXT,
      plan_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      message_length INTEGER NOT NULL,
      current_state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contact_operations_identity
      ON contact_operations(source, identity, current_state);
    CREATE TABLE IF NOT EXISTS contact_operation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL REFERENCES contact_operations(operation_id),
      event_type TEXT NOT NULL,
      at TEXT NOT NULL,
      details_json TEXT
    );
    CREATE TABLE IF NOT EXISTS validation_successes (
      batch_id TEXT PRIMARY KEY,
      succeeded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contact_operation_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL REFERENCES contact_operations(operation_id),
      stage TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error_category TEXT,
      duration_ms INTEGER NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contact_operation_diagnostics_at
      ON contact_operation_diagnostics(at);
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
    INSERT OR IGNORE INTO schema_migrations (version) VALUES (3);
    COMMIT;
  `);

  const snapshotColumns = database
    .prepare("PRAGMA table_info(position_snapshots)")
    .all() as unknown as Array<{ name: string }>;
  if (
    !snapshotColumns.some((column) => column.name === "exclusion_reasons_json")
  ) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE position_snapshots ADD COLUMN exclusion_reasons_json TEXT;
      INSERT OR IGNORE INTO schema_migrations (version) VALUES (4);
      COMMIT;
    `);
  } else {
    database.exec(
      "INSERT OR IGNORE INTO schema_migrations (version) VALUES (4);",
    );
  }
}

function rowToContactOperation(row: ContactOperationRow): ContactOperation {
  return {
    operationId: row.operation_id,
    commandId: row.command_id,
    batchId: row.batch_id,
    source: row.source,
    identity: row.identity,
    ...(row.platform_job_id === null
      ? {}
      : { platformJobId: row.platform_job_id }),
    ...(row.url === null ? {} : { url: row.url }),
    planId: row.plan_id,
    templateId: row.template_id,
    messageHash: row.message_hash,
    messageLength: row.message_length,
    state: row.current_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    ...(row.exclusion_reasons_json === null
      ? {}
      : {
          exclusionReasons: JSON.parse(
            row.exclusion_reasons_json,
          ) as RuleExclusion[],
        }),
    processedAt: row.processed_at,
  };
}
