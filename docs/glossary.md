---
title: dsh-scheduled-send — 术语表
type: reference
tags: [glossary]
status: active
version: 2.0.0
date: 2026-10-26
---

# dsh-scheduled-send — 术语表

## 本插件专有术语

| 术语 | 全称 / 英文 | 定义 |
|---|---|---|
| 定时任务 | task / `TaskView` | 一条「提示词 + 频率 + 投递目标（会话/工作区）+ 有效期 + 通知开关」的管理面视图；任务**真身在官方 schedule 服务**，视图 = 官方行 + 插件 meta 合并。见 `src/shared/types.ts` |
| 官方 Schedule 服务 | `ctx.schedule`（`@deepseek-ai/dsh-schedule`） | 宿主的 durable 定时服务：`at/after/every/daily/weekly/cron`、持久化、错过补投、会话投递（`user/message source.kind='schedule'`）。本插件的调度引擎，不自建定时器 |
| ScheduleBridge | 控制面桥 | host 端核心类：包装 `ctx.schedule`，负责创建/对账/有效期/执行观察/路由服务面。见 `src/host/bridge.ts` |
| 任务元数据 | `tasks-meta.json` / `MetaStore` | 插件侧扩展数据（`notify` / `endsAt` / `workspaceId` / `sessionTitle` / `lastExecution`），原子写 + 与官方表 `reconcile` 对账。见 `src/host/meta.ts` |
| stateDir | 状态目录 | 插件唯一配置键；留空 = `$DSH_HOME/profiles/<profile>/scheduled-send`，`tasks-meta.json` 落其下（**不再存任务本体**） |
| schedule framing | 官方投递格式 | `[SCHEDULE REMINDER]` + `schedule_id_json:` / `occurrence_at:` / `reminder_prompt_json:`，批量为 `[SCHEDULE REMINDER BATCH]` + `reminders_json:`；执行观察据此反解任务 id |
| 执行状态 | `ExecutionStatus` | `success/failed/aborted/blocked/max-tokens/interrupted`（`turn/end.reason.kind` 归因；`forked` 不通知）；写回 meta 并驱动列表徽章与 notify-alert 推送 |
| 有效期 | `endsAt` | 截止时间戳；分片定时器（>2^31ms 拆段）到期**删除官方任务**，任务转「已结束」。官方无此能力，纯插件语义 |
| 任务会话 | task session | 建任务未指定会话时 `sessionController.create({workspaceId})` + `rename(任务名)` 建立的专用会话 |
| ui-schedule | 官方日程客户端 UI | `@deepseek-ai/dsh-client-ui-schedule` profile 条目；日常入口收敛到本插件时在 profile patch 里 `disabled: true`（host `schedule` 服务保持启用） |
| 会话作用域注入 | `inject(sessionId)` 位置参数 | 会话作用域插槽（`conversation.input.right` / `conversation.input.dock`）的 `sessionId` 由框架按 scope key 作为第一个实参传入注册时的 `inject` 工厂，**不是** standard prop |
| 客户端请求超时 | `API_TIMEOUT_MS` | 客户端所有请求 15 秒超时（AbortController）+ 明确失败文案；列表轮询 `REFRESH_MS` 5 秒。见 `src/shared/constants.ts` |

## 通用工艺术语

工程活动工艺全流程的通用术语（BRD / SAD / FTR / CTR 等交付物缩写、七阶段定义）
以标准真源为唯一权威，本文不复制：

`dsh-agent-presets/modes/engineering/standards/documentation.md`（§3 交付物前缀表）

## 相关

- [[README|docs 总览]] ｜ [[FILE_INDEX|文件索引]]
