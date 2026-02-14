# Proma

Proma is a local-first AI application stack that primarily runs as `Web frontend + Bun/Hono backend`, with chat and agent streaming over SSE.

[中文](./README.md)

## Features

- Model provider management: Anthropic, OpenAI, Google, DeepSeek, MiniMax, Kimi, Zhipu GLM, and OpenAI-compatible endpoints
- Chat mode: multi-turn conversation, streaming responses, thinking visualization, model switching
- Agent mode: general agent workflow powered by Claude Agent SDK
- Rich rendering: Markdown, syntax-highlighted code blocks, Mermaid diagrams
- Attachments and document parsing: image and common document formats (PDF/Office/text)
- Local data storage: settings, conversations, and messages stored under `~/.proma/`
- Theme system: light/dark theme with system preference support

## Architecture

### Primary runtime flow (Web + SSE)

- Frontend: `apps/web` (Vite, default port `5173`)
- Backend: `apps/server` (Bun + Hono, default port `3001`)
- API proxy: Vite proxies `/api` to `http://localhost:3001`
- Streaming endpoints:
  - Chat: `POST /api/chat/send`
  - Agent: `POST /api/agent/send`
- Frontend consumes SSE chunks via `fetch + ReadableStream` and updates UI incrementally

### Monorepo layout

```text
proma/
├── apps/
│   ├── web/        # Web frontend (React + Vite)
│   ├── server/     # Web backend (Bun + Hono + SSE)
│   └── electron/   # Optional desktop-compatible mode
└── packages/
    ├── core/       # Provider adapters, streaming and document capabilities
    ├── shared/     # Shared types, constants, config, and protocol contracts
    └── ui/         # Shared UI components and interaction primitives
```

### Core modules

- Web bridge: `apps/web/src/lib/electron-bridge.ts` (HTTP/SSE-compatible client layer)
- Server routes: `apps/server/src/routes/*` (`channels`/`conversations`/`chat`/`agent`/`attachments`/`settings`)
- Server services: `apps/server/src/services/*` (providers, sessions, attachments, document parsing, agent orchestration)
- Provider abstraction: `packages/core/src/providers/*` (`ProviderAdapter` + shared SSE reader)

## Run and Develop

```bash
# Install dependencies
bun install

# Recommended: start Web + Server together
bun run dev:all

# Start Web only
bun run dev:web

# Start Server only
bun run dev:server

# Optional: Electron-compatible mode
bun run dev

# Type check all packages/apps
bun run typecheck

# Build all packages/apps
bun run build
```

## License

[MIT](./LICENSE)
