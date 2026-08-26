---
status: superseded by ADR-0010
---

# 采用 Node 24 的 Schema 驱动单包工程

JobPilot 以 Node.js 24 LTS 和 npm 为运行基线，采用 ESM 单包模块化结构，并通过 TypeBox 与 Fastify JSON Schema 共同定义和校验 HTTP 契约。SQLite 使用 Node 内置 `node:sqlite` 与事务化前向 migration，REST 承载命令、SSE 推送批次状态；这一选择减少 Windows 原生依赖和多包维护成本，但明确放弃旧版 Node 兼容、ORM 抽象与 WebSocket 双向协议。
