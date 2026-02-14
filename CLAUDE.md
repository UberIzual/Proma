# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**重要提示：**
- 当功能发生变化时，请保持此文件和 `README.md` 同步更新。请更新文档以反映当前状态，但是需要经过我的允许后再修改。
- 所有的注释和日志优先采用中文，保留必要的专业术语部分。
- 所有的依赖包的安装都要先进行搜索，综合判断依赖采用的版本，而不是默认采用某个版本。
- 状态管理上我们全部采用 Jotai 来实现。
- 这是个开源项目，本地存储优先，善用配置文件优于大部分默认采用 localstorage，不采用本地数据库方案。
- 保证充分的组件化以及人类的可读性，每次完成改动后都要思考这一点，运行@code-simplifier 来简化优化代码，保持简单直接不过渡设计的风格。
- 在 UI 设计上采用更现代的方案，UI 组件推荐采用 ShadcnUI，在合适的情况下，用卡片和阴影取代边框，用符合主题的饱满色彩，设置界面要设置背景，为未来做不同主题留下空间。
- 采用 BDD 行为驱动开发的方案。

## 项目概述

Proma 是一个本地优先的 AI 应用工程，当前以 `Web 前端 + Bun/Hono 后端 + SSE 流式` 为主运行模式，Electron 为可选兼容形态。

## Monorepo 结构

Bun workspace monorepo：

```
proma/
├── apps/
│   ├── web/        # Web 前端（React + Vite）
│   ├── server/     # Web 后端（Bun + Hono + SSE）
│   └── electron/   # 可选桌面兼容形态
└── packages/
    ├── core/       # AI Provider 适配器、流式读取、文档处理
    ├── shared/     # 共享类型、常量、配置、Agent 工具匹配
    └── ui/         # 共享 UI 组件 (CodeBlock, MermaidBlock, useSmoothStream)
```

**包命名规范**：`@proma/*` 作用域（`@proma/core`、`@proma/shared`、`@proma/ui`、`@proma/web`、`@proma/server`、`@proma/electron`）

**依赖管理**：package.json 中使用 `workspace:*` 引用内部包

## 常用命令

```bash
# 安装依赖
bun install

# 推荐：同时启动 Web + Server
bun run dev:all

# 仅启动 Web（http://localhost:5173）
bun run dev:web

# 仅启动 Server（http://localhost:3001）
bun run dev:server

# 可选：Electron 兼容模式
bun run dev

# 类型检查（全仓）
bun run typecheck

# 构建（全仓）
bun run build

# 测试
bun test
```

### Electron（可选兼容模式）命令（`apps/electron/`）

```bash
# 构建并启动 Electron
bun run electron:start

# 仅构建 Electron
bun run electron:build

# Electron 构建细分脚本
bun run build:main        # esbuild → dist/main.cjs
bun run build:preload     # esbuild → dist/preload.cjs
bun run build:renderer    # Vite → dist/renderer/
bun run build:resources   # 复制 resources/ 到 dist/
bun run generate:icons    # 生成应用图标

# 打包分发
bun run dist:mac
bun run dist:win
bun run dist:linux
bun run dist:fast
```

## 运行时环境

使用 Bun 代替 Node.js/npm/pnpm：

- `bun install` 安装依赖，`bun run <script>` 运行脚本
- `bun test` 运行测试（内置测试运行器，`import { test, expect } from "bun:test"`）
- Bun 自动加载 .env 文件（无需 dotenv）
- 优先使用 Bun 原生 API：`Bun.file` > `node:fs`，`Bun.$\`command\`` > `execa`

## 核心架构

### Web 远程调用链路（最重要的架构模式）

Web 模式通过 HTTP/SSE 远程调用后端：

1. **类型 & 常量**：`@proma/shared` 定义请求/响应与事件类型
2. **前端桥接**：`apps/web/src/lib/electron-bridge.ts` 将 `window.electronAPI.*` 映射为 `fetch('/api/...')`
3. **代理转发**：`apps/web/vite.config.ts` 将 `/api` 代理到 `http://localhost:3001`
4. **后端处理**：`apps/server/src/routes/*` 路由调用 `apps/server/src/services/*`
5. **SSE 流式返回**：`/api/chat/send` 与 `/api/agent/send` 通过 `streamSSE` 推送增量事件
6. **前端消费**：Web 侧用 `ReadableStream` 解析 SSE 并写入 Jotai 状态

### Electron IPC 兼容链路（仅 Electron 模式）

类型定义 → 主进程处理 → Preload 桥接 → 渲染进程调用：

1. **类型 & 常量**：`@proma/shared`
2. **主进程处理**：`apps/electron/src/main/ipc.ts`
3. **Preload 桥接**：`apps/electron/src/preload/index.ts`
4. **渲染进程调用**：`window.electronAPI.*`

### Web 后端服务层（`apps/server/src/services/`）

| 服务 | 职责 |
|------|------|
| `channel-manager.ts` | 模型供应商 CRUD、API Key AES-256-GCM 加密、连接测试、模型获取 |
| `conversation-manager.ts` | 对话 CRUD、JSONL 消息存储、置顶、上下文分割 |
| `agent-service.ts` | Agent SDK 调用编排、流式事件转换与推送、AbortController |
| `agent-session-manager.ts` | Agent 会话 CRUD、JSONL 消息存储 |
| `agent-prompt-builder.ts` | Agent 系统提示词构建（注入工作区上下文） |
| `agent-workspace-manager.ts` | 工作区管理、MCP Server 配置、Skills 配置 |
| `attachment-service.ts` | 附件存储/读取/删除、上传文件处理 |
| `document-parser.ts` | 文档文本提取（PDF/Office/文本文件） |
| `user-profile-service.ts` | 用户档案持久化 |
| `settings-service.ts` | 应用设置持久化（主题、默认配置等） |
| `proxy-fetch.ts` | 统一代理请求出口 |
| `proxy-settings-service.ts` | 系统/手动代理配置读取与生效策略 |

补充：`apps/server/src/lib/config-paths.ts` 负责 `~/.proma/` 路径管理。

### AI Provider 适配器（`packages/core/src/providers/`）

基于适配器模式的多 Provider 支持：

- `ProviderAdapter` 接口定义统一的 `sendMessage()` 流式方法
- **Anthropic**：`anthropic-adapter.ts` — Messages API，支持 extended_thinking
- **OpenAI / DeepSeek / Custom**：`openai-adapter.ts` — Chat Completions API
- **Google**：`google-adapter.ts` — Generative Language API
- `sse-reader.ts`：通用 SSE 流读取器（fetch + ReadableStream）
- 多模态支持：图片（各 Provider 格式不同）、文档（提取文本注入 `<file>` XML 标签）

### Jotai 状态管理（`apps/web/src/atoms/`）

| Atom 文件 | 管理的状态 |
|-----------|-----------|
| `chat-atoms.ts` | 对话列表、当前消息、流式状态（Map 结构支持多对话并行）、模型选择、上下文设置、并排模式、思考模式、待上传附件 |
| `agent-atoms.ts` | Agent 会话列表、当前会话、流式状态（`AgentStreamState`）、工作区选择、默认供应商选择 |
| `active-view.ts` | 主面板视图切换（'conversations' / 'settings'） |
| `app-mode.ts` | 应用模式（Chat / Agent） |
| `settings-tab.ts` | 设置面板当前标签页 |
| `theme.ts` | 主题模式（light / dark / system） |
| `user-profile.ts` | 用户档案（姓名 + 头像） |
| `updater.ts` | 自动更新状态（检查/下载/安装），优雅降级（updater 不可用时保持 idle） |

### Web 组件架构（`apps/web/src/components/`）

- **`app-shell/`**：三面板布局（LeftSidebar | NavigatorPanel | MainContentPanel），侧边栏含模式切换、置顶对话、日期分组列表、流式指示器
- **`chat/`**：聊天核心 — ChatView（消息加载/流式订阅）、ChatHeader（模型选择/上下文设置）、ChatInput（Tiptap 富文本编辑器）、ChatMessages（消息列表/自动滚动）、ParallelChatMessages（并排模式）
- **`agent/`**：Agent 模式 — AgentView（会话主视图）、AgentHeader（模型供应商/模型选择）、AgentMessages（消息列表 + 工具活动）、ToolActivityItem（工具调用展示）、WorkspaceSelector（工作区切换）
- **`settings/`**：设置面板 — GeneralSettings（用户档案）、AppearanceSettings（主题）、ChannelSettings（模型供应商）、ChannelForm（Provider 配置）、AgentSettings（Agent 默认供应商/工作区/MCP）、McpServerForm（MCP 服务器配置）、AboutSettings（版本/更新）；含 `primitives/` 可复用表单组件
- **`file-browser/`**：文件浏览器 — FileBrowser（工作区文件树浏览）
- **`ai-elements/`**：AI 展示组件 — Markdown 渲染、代码块、Mermaid 图、推理折叠、上下文分割线、富文本输入
- **`ui/`**：ShadcnUI 组件（new-york 风格，CSS 变量主题）

### 本地文件存储（`~/.proma/`）

```
~/.proma/
├── channels.json           # 模型供应商配置（API Key 经 AES-256-GCM 加密）
├── conversations.json      # 对话索引（元数据，轻量）
├── conversations/          # 消息存储
│   └── {uuid}.jsonl        # 每对话一个 JSONL 文件，追加写入
├── agent-sessions.json     # Agent 会话索引
├── agent-sessions/         # Agent 会话消息存储
│   └── {uuid}.jsonl        # 每会话一个 JSONL 文件
├── workspaces/             # 工作区配置
│   └── {slug}/
│       └── config.json     # MCP Server、Skills 等配置
├── attachments/            # 附件文件
│   └── {conversationId}/
│       └── {uuid}.ext
├── user-profile.json       # 用户档案 { userName, avatar }
└── settings.json           # 应用设置 { themeMode }
```

关键设计：JSON 配置 + JSONL 追加日志，无本地数据库，文件可移植。

## 构建工具

- **Web 前端**：Vite + React + Tailwind CSS（HMR）
- **Web 后端**：Bun Runtime + Hono 路由，SSE 长连接（`idleTimeout: 255`）
- **Provider 层**：`@proma/core` 统一适配器 + SSE 读取器
- **Electron（可选）**：主进程/Preload 使用 esbuild，桌面打包使用 electron-builder

## 代码风格

- 永远不要使用 `any` 类型 — 创建合适的 interface
- 对象类型优先使用 interface 而不是 type
- 尽可能使用 `import type` 进行仅类型导入
- 注释和日志采用中文，保留专业术语
- **路径别名**：`@/` → 当前应用 `src/`（例如 `apps/web/src/`）

## TypeScript 配置

- Module: 各应用采用 ES Module（`"module": "ESNext"` / `"Preserve"`）+ `"moduleResolution": "bundler"`
- JSX: `"react-jsx"`，严格模式启用，Target: ESNext
- 所有包 `"type": "module"`，导入时使用 `.ts` 扩展名

## 版本管理

提交代码时始终递增受影响包的 patch 版本（如 `0.1.18` → `0.1.19`），影响多个包则都要递增。

## Agent SDK 集成架构

基于 `@anthropic-ai/claude-agent-sdk` 实现 Agent 模式，与 Chat 模式并行：

### 核心流程

```
用户输入 → apps/web (POST /api/agent/send)
→ apps/server/src/services/agent-service.ts (SDK query) → SDKMessage 流
→ convertSDKMessage() → AgentEvent[] → SSE(event/complete/error/title-updated)
→ apps/web/src/atoms/agent-atoms.ts (applyAgentEvent) → React UI
```

### 关键设计

- **SDK 调用**：`sdk.query({ prompt, options: { apiKey, model, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, cwd, abortController } })`
- **事件转换**：`convertSDKMessage()`（`@proma/shared`）将 SDK 原始消息转为统一的 `AgentEvent` 类型
- **工具匹配**：`packages/shared/src/agent/tool-matching.ts` — 无状态 `ToolIndex` + `extractToolStarts` / `extractToolResults` 解析工具调用
- **状态管理**：`applyAgentEvent()` 纯函数更新 `AgentStreamState`，支持流式增量更新
- **工作区隔离**：每个工作区独立的 MCP Server 配置和 cwd，Agent 会话按工作区过滤

### 共享类型（`@proma/shared`）

- `AgentEvent`：Agent 事件（text / tool_start / tool_result / done / error）
- `AgentSessionMeta`：会话元数据（id / title / channelId / workspaceId）
- `AgentMessage`：持久化消息（role + content blocks）
- `AgentSendInput`：发送请求输入
- Agent SSE 事件：`event` / `complete` / `error` / `title-updated`
- `WorkspaceCapabilities`：工作区能力（MCP Server 列表 + Skills 列表）

## 创作参考

遵循 [craft-agents-oss](https://github.com/craftship/craft-agents-oss) 的模式：

- **会话管理**：收件箱/归档工作流
- **权限模式**：safe / ask / allow-all
- **Agent SDK**：@anthropic-ai/claude-agent-sdk（[v1 文档](https://platform.claude.com/docs/en/agent-sdk/typescript)、[v2 文档](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)）
- **MCP 集成**：Model Context Protocol 用于外部数据源
- **凭证存储**：AES-256-GCM 加密
- **配置位置**：`~/.proma/`（类似 `~/.craft-agent/`）
