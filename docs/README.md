---
title: dsh-scheduled-send — 文档总览
type: index
tags: [lifecycle, index]
status: active
version: 1.0.0
date: 2026-10-08
---

# dsh-scheduled-send — 文档总览

> 本目录按**工程活动工艺全流程**组织（八段闭环 + 管理类文档正交）。
> 规则真源：`dsh-agent-presets/modes/engineering/standards/documentation.md`。

## 阶段总览

| 阶段 | 本目录文件数 | 入口 |
|---|---|---|
| 需求 | 3 | [[需求/index\|需求阶段索引]] |
| 测试 | 1 | [[测试/index\|测试阶段索引]] |
| 管理 | 5 | [[管理/index\|管理阶段索引]] |

**本插件暂未涉及的阶段**：分析 / 设计 / 开发 / 部署 / 切换（按需填充，不建空目录）。

**历史归档**：`history/` 存放已从现状类文档删除的过期叙述原文（非现行手册）
→ [[history/归档-20261013|归档-20261013]]。

## 阅读路径

- 想知道**要做什么、验收标准是什么** → `需求/`（[[需求/BRD-业务需求说明书|BRD-业务需求说明书]] 为现行需求与边界，`BRD-001` / `BRD-20260925` 为已冻结规格）
- 想知道**为什么这么设计、出过什么事** → [[管理/RMP-风险管理|RMP-风险管理]]（事故根因与排障速查）与 `管理/PP-*-计划.md`（一次性方案）
- 想知道**怎么构建、安装、排障** → 插件 [`../README.md`](../README.md) 与 [`../AGENTS.md`](../AGENTS.md)（当前态）
- 想知道**当前进度与待办** → `管理/PP-*-任务.md`（含未闭环项，如实标注）
- 想看**全插件文档清单 / 术语** → [`FILE_INDEX.md`](FILE_INDEX.md) ｜ [`glossary.md`](glossary.md)
