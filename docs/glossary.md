---
title: dsh-scheduled-send — 术语表
type: reference
tags: [glossary]
status: active
version: 1.0.0
date: 2026-10-08
---

# dsh-scheduled-send — 术语表

## 本插件专有术语

| 术语 | 全称 / 英文 | 定义 |
|---|---|---|
| 定时发送任务 | job / `ScheduledJob` | 一条「文本 + 目标会话 + 触发时刻」的持久记录；状态机 `pending`（待触发）→ `sent`（已投递）/ `missed`（投递失败）/ `cancelled`（已撤回）。见 `src/shared/types.ts` |
| Scheduler | Host 调度器 | host 端类：任务表 + `jobs.json` 持久化 + 每任务一个进程内 `setTimeout`；`add` / `update` 强校验时间边界与每会话上限。见 `src/host/scheduler.ts` |
| stateDir | 状态目录 | 插件唯一配置键（`cordis.patch.yml` 的 `stateDir`）；留空 = `$DSH_HOME/profiles/<profile>/scheduled-send`，任务表落其下 `jobs.json` |
| queue 投递 | `sessionController.prompt({mode:'queue'})` | 到点投递方式：进 dsh 原生 Inbox `next-turn` 持久队列（与原生 QueueDock 同通道），agent 运行中排队消费、空闲即成下一轮 |
| 每会话待触发上限 | `MAX_PENDING_PER_SESSION` | 每个会话最多 3 个 pending 任务（host `Scheduler.add` 强校验 + client 创建前预检）。见 `src/shared/constants.ts` |
| 最晚触发时刻 | `Scheduler.maxFireAt()` / `MAX_SCHEDULE_DAY_OFFSET` | 业务上最晚 = 明天 23:59:59.999；`add` / `update` 均强校验，不靠 UI 守。今天只可定当前时刻之后 |
| 会话作用域注入 | `inject(sessionId)` 位置参数 | 会话作用域插槽（`conversation.input.right` / `conversation.input.dock`）的 `sessionId` 由框架按 scope key 作为第一个实参传入注册时的 `inject` 工厂，**不是** standard prop |
| 客户端请求超时 | `API_TIMEOUT_MS` | 客户端所有请求 10 秒超时（AbortController）+ 明确失败文案，绝不无限挂起。见 `src/shared/constants.ts` |

## 通用工艺术语

工程活动工艺全流程的通用术语（BRD / SAD / FTR / CTR 等交付物缩写、七阶段定义）
以标准真源为唯一权威，本文不复制：

`dsh-agent-presets/modes/engineering/standards/documentation.md`（§3 交付物前缀表）

## 相关

- [[README|docs 总览]] ｜ [[FILE_INDEX|文件索引]]
