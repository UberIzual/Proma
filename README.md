# Proma

本项目是一个本地优先的 AI 应用工程，默认以 `Web 前端 + Bun/Hono 后端` 运行，聊天与 Agent 通过 SSE 流式返回。

[English](./README.en.md)

## 功能

- 多模型供应商管理：支持 Anthropic、OpenAI、Google、DeepSeek、MiniMax、Kimi、智谱 GLM 及 OpenAI 兼容接口
- Chat 模式：支持多轮对话、流式输出、思考过程展示、模型切换
- Agent 模式：基于 Claude Agent SDK 的通用 Agent 能力
- 富文本与渲染：支持 Markdown、代码高亮、Mermaid 图表
- 附件与文档解析：支持图片与常见文档（PDF/Office/文本）内容注入对话
- 本地数据存储：配置、会话、消息等数据保存在 `~/.proma/`
- 主题能力：支持亮色/暗色主题并可跟随系统设置

## 架构

### 主运行链路（Web + SSE）

- 前端：`apps/web`（Vite，默认端口 `5173`）
- 后端：`apps/server`（Bun + Hono，默认端口 `3001`）
- API 代理：`/api` 由 Vite 代理到 `http://localhost:3001`
- 流式响应：
  - Chat：`POST /api/chat/send`
  - Agent：`POST /api/agent/send`
- 前端通过 `fetch + ReadableStream` 解析 SSE 数据块并更新 UI

### Monorepo 结构

```text
proma/
├── apps/
│   ├── web/        # Web 前端（React + Vite）
│   ├── server/     # Web 后端（Bun + Hono + SSE）
│   └── electron/   # 可选桌面兼容形态
└── packages/
    ├── core/       # 模型供应商适配器、流式读取、文档处理能力
    ├── shared/     # 共享类型、常量、配置与协议定义
    └── ui/         # 共享 UI 组件与交互能力
```

### 核心模块

- Web 桥接层：`apps/web/src/lib/electron-bridge.ts`（HTTP/SSE 客户端兼容层）
- 后端路由层：`apps/server/src/routes/*`（`channels`/`conversations`/`chat`/`agent`/`attachments`/`settings`）
- 后端服务层：`apps/server/src/services/*`（模型供应商、会话、附件、文档解析、Agent 运行编排）
- Provider 适配层：`packages/core/src/providers/*`（统一 `ProviderAdapter` + 通用 SSE 读取器）

## 运行与开发

```bash
# 安装依赖
bun install

# 推荐：同时启动 Web + Server
bun run dev:all

# 单独启动 Web
bun run dev:web

# 单独启动 Server
bun run dev:server

# 可选：Electron 兼容模式
bun run dev

# 全量类型检查
bun run typecheck

# 构建全部应用
bun run build
```

## 许可证

[MIT](./LICENSE)
