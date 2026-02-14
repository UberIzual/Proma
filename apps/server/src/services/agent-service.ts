/**
 * Agent SDK 服务层 (Web 版本)
 *
 * 负责 Agent SDK 的调用编排：
 * - 获取渠道信息（API Key + Base URL）
 * - 注入环境变量（ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL）
 * - 构建 SDK Options（pathToClaudeCodeExecutable + executable + env）
 * - 调用 query() 获取消息流
 * - 遍历 SDKMessage → convertSDKMessage() → AgentEvent[]
 * - 每个事件 → 通过回调推送 SSE
 * - 同时 appendAgentMessage() 持久化
 *
 * 基于 Electron 版本改造，将 webContents.send() 替换为 SSE 回调。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { writeFileSync, mkdirSync, cpSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AgentSendInput, AgentEvent, AgentMessage, AgentGenerateTitleInput, AgentSaveFilesInput, AgentSavedFile, AgentCopyFolderInput } from '@proma/shared'
import {
  ToolIndex,
  extractToolStarts,
  extractToolResults,
  type ContentBlock,
} from '@proma/shared'
import { decryptApiKey, getChannelById, listChannels } from './channel-manager'
import {
  getAdapter,
  fetchTitle,
} from '@proma/core'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { appendAgentMessage, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionMessages } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentWorkspacePath, getAgentSessionWorkspacePath } from '../lib/config-paths'
import { getWorkspaceMcpConfig, ensurePluginManifest } from './agent-workspace-manager'
import { buildSystemPromptAppend, buildDynamicContext } from './agent-prompt-builder'

/** SSE 事件回调类型 */
export interface AgentStreamCallbacks {
  onEvent: (sessionId: string, event: AgentEvent) => Promise<void>
  onComplete: (sessionId: string) => Promise<void>
  onError: (sessionId: string, error: string) => Promise<void>
  onTitleUpdated: (sessionId: string, title: string) => Promise<void>
}

/** 活跃的 AbortController 映射（sessionId → controller） */
const activeControllers = new Map<string, AbortController>()

/**
 * 解析 SDK cli.js 路径
 *
 * SDK 作为 esbuild external 依赖，require.resolve 可在运行时解析实际路径。
 * 多种策略降级：createRequire → 全局 require → node_modules 手动查找
 */
function resolveSDKCliPath(): string {
  let cliPath: string | null = null

  // 策略 1：createRequire（标准 ESM/CJS 互操作）
  try {
    const cjsRequire = createRequire(__filename)
    const sdkEntryPath = cjsRequire.resolve('@anthropic-ai/claude-agent-sdk')
    cliPath = join(dirname(sdkEntryPath), 'cli.js')
    console.log(`[Agent 服务] SDK CLI 路径 (createRequire): ${cliPath}`)
  } catch (e) {
    console.warn('[Agent 服务] createRequire 解析 SDK 路径失败:', e)
  }

  // 策略 2：全局 require（esbuild CJS bundle 可能保留）
  if (!cliPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdkEntryPath = require.resolve('@anthropic-ai/claude-agent-sdk')
      cliPath = join(dirname(sdkEntryPath), 'cli.js')
      console.log(`[Agent 服务] SDK CLI 路径 (require.resolve): ${cliPath}`)
    } catch (e) {
      console.warn('[Agent 服务] require.resolve 解析 SDK 路径失败:', e)
    }
  }

  // 策略 3：从项目根目录手动查找
  if (!cliPath) {
    cliPath = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
    console.log(`[Agent 服务] SDK CLI 路径 (手动): ${cliPath}`)
  }

  return cliPath
}

/**
 * 获取 Bun 运行时路径
 *
 * 优先使用 'bun'（依赖 PATH）。
 */
function getBunExecutablePath(): string {
  return 'bun'
}

// SDK 消息类型定义（简化版，避免直接依赖 SDK 内部类型）
interface SDKAssistantMessage {
  type: 'assistant'
  message: {
    content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string; thinking?: string }>
    usage?: { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  }
  parent_tool_use_id: string | null
  error?: { message: string; errorType?: string }
  isReplay?: boolean
}

interface SDKUserMessage {
  type: 'user'
  message?: { content?: unknown[] }
  parent_tool_use_id: string | null
  tool_use_result?: unknown
  isReplay?: boolean
}

interface SDKStreamEvent {
  type: 'stream_event'
  event: {
    type: string
    message?: { id?: string }
    delta?: { type: string; text?: string; thinking?: string; stop_reason?: string }
    content_block?: { type: string; id: string; name: string; input?: Record<string, unknown> }
  }
  parent_tool_use_id: string | null
}

interface SDKResultMessage {
  type: 'result'
  subtype: 'success' | 'error'
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  total_cost_usd?: number
  modelUsage?: Record<string, { contextWindow?: number }>
  errors?: string[]
}

interface SDKToolProgressMessage {
  type: 'tool_progress'
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds?: number
}

type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKStreamEvent | SDKResultMessage | SDKToolProgressMessage | { type: string; parent_tool_use_id?: string | null }

/**
 * 将 SDK 消息转换为 AgentEvent 列表
 */
function convertSDKMessage(
  message: SDKMessage,
  toolIndex: ToolIndex,
  emittedToolStarts: Set<string>,
  activeParentTools: Set<string>,
  pendingText: { value: string | null },
  pendingReasoning: { value: string | null },
  turnId: { value: string | null },
): AgentEvent[] {
  const events: AgentEvent[] = []

  switch (message.type) {
    case 'assistant': {
      const msg = message as SDKAssistantMessage

      // SDK 级别错误
      if (msg.error) {
        events.push({ type: 'error', message: msg.error.message || '未知 SDK 错误' })
        break
      }

      // 跳过重放消息
      if (msg.isReplay) break

      const content = msg.message.content

      // 提取文本内容
      let textContent = ''
      for (const block of content) {
        if (block.type === 'text' && 'text' in block) {
          textContent += block.text
        }
      }

      // 提取思考内容
      let thinkingContent = ''
      for (const block of content) {
        if (block.type === 'thinking' && 'thinking' in block) {
          thinkingContent += block.thinking
        }
      }

      // 工具启动事件提取
      const sdkParentId = msg.parent_tool_use_id
      const toolStartEvents = extractToolStarts(
        content as ContentBlock[],
        sdkParentId,
        toolIndex,
        emittedToolStarts,
        turnId.value || undefined,
        activeParentTools,
      )

      // 跟踪活跃的 Task 工具
      for (const event of toolStartEvents) {
        if (event.type === 'tool_start' && event.toolName === 'Task') {
          activeParentTools.add(event.toolUseId)
        }
      }

      events.push(...toolStartEvents)

      if (textContent) {
        pendingText.value = textContent
      }
      if (thinkingContent) {
        pendingReasoning.value = thinkingContent
      }
      break
    }

    case 'stream_event': {
      const msg = message as SDKStreamEvent
      const streamEvent = msg.event

      // 捕获 turn ID
      if (streamEvent.type === 'message_start') {
        const messageId = streamEvent.message?.id
        if (messageId) {
          turnId.value = messageId
        }
      }

      // message_delta 包含实际 stop_reason — 发出 pending 文本
      if (streamEvent.type === 'message_delta') {
        const stopReason = streamEvent.delta?.stop_reason
        if (pendingText.value) {
          const isIntermediate = stopReason === 'tool_use'
          events.push({
            type: 'text_complete',
            text: pendingText.value,
            isIntermediate,
            turnId: turnId.value || undefined,
            parentToolUseId: msg.parent_tool_use_id || undefined,
          })
          pendingText.value = null
        }
        if (pendingReasoning.value) {
          events.push({
            type: 'thinking_complete',
            text: pendingReasoning.value,
            turnId: turnId.value || undefined,
            parentToolUseId: msg.parent_tool_use_id || undefined,
          })
          pendingReasoning.value = null
        }
      }

      // 流式文本增量
      if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        events.push({
          type: 'text_delta',
          text: streamEvent.delta.text || '',
          turnId: turnId.value || undefined,
          parentToolUseId: msg.parent_tool_use_id || undefined,
        })
      }

      // 流式思考增量
      if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'thinking_delta') {
        events.push({
          type: 'thinking_delta',
          text: streamEvent.delta.thinking || '',
          turnId: turnId.value || undefined,
          parentToolUseId: msg.parent_tool_use_id || undefined,
        })
      }

      // 流式工具启动
      if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
        const toolBlock = streamEvent.content_block
        const sdkParentId = msg.parent_tool_use_id
        const streamBlocks: ContentBlock[] = [{
          type: 'tool_use' as const,
          id: toolBlock.id,
          name: toolBlock.name,
          input: (toolBlock.input ?? {}) as Record<string, unknown>,
        }]
        const streamEvents = extractToolStarts(
          streamBlocks,
          sdkParentId,
          toolIndex,
          emittedToolStarts,
          turnId.value || undefined,
          activeParentTools,
        )

        for (const evt of streamEvents) {
          if (evt.type === 'tool_start' && evt.toolName === 'Task') {
            activeParentTools.add(evt.toolUseId)
          }
        }

        events.push(...streamEvents)
      }
      break
    }

    case 'user': {
      const msg = message as SDKUserMessage

      if (msg.isReplay) break

      if (msg.tool_use_result !== undefined || msg.message) {
        const msgContent = msg.message
          ? ((msg.message as { content?: unknown[] }).content ?? [])
          : []
        const contentBlocks = (Array.isArray(msgContent) ? msgContent : []) as ContentBlock[]

        const sdkParentId = msg.parent_tool_use_id
        const toolUseResultValue = msg.tool_use_result

        const resultEvents = extractToolResults(
          contentBlocks,
          sdkParentId,
          toolUseResultValue,
          toolIndex,
          turnId.value || undefined,
        )

        for (const event of resultEvents) {
          if (event.type === 'tool_result' && event.toolName === 'Task') {
            activeParentTools.delete(event.toolUseId)
          }
        }

        events.push(...resultEvents)
      }
      break
    }

    case 'tool_progress': {
      const msg = message as SDKToolProgressMessage

      if (msg.elapsed_time_seconds !== undefined) {
        events.push({
          type: 'task_progress',
          toolUseId: msg.parent_tool_use_id || msg.tool_use_id,
          elapsedSeconds: msg.elapsed_time_seconds,
          turnId: turnId.value || undefined,
        })
      }

      // 如果还没见过这个工具，发出 tool_start
      if (!emittedToolStarts.has(msg.tool_use_id)) {
        const progressBlocks: ContentBlock[] = [{
          type: 'tool_use' as const,
          id: msg.tool_use_id,
          name: msg.tool_name,
          input: {},
        }]
        const progressEvents = extractToolStarts(
          progressBlocks,
          msg.parent_tool_use_id,
          toolIndex,
          emittedToolStarts,
          turnId.value || undefined,
          activeParentTools,
        )

        for (const evt of progressEvents) {
          if (evt.type === 'tool_start' && evt.toolName === 'Task') {
            activeParentTools.add(evt.toolUseId)
          }
        }

        events.push(...progressEvents)
      }
      break
    }

    case 'result': {
      const msg = message as SDKResultMessage

      const modelUsageEntries = Object.values(msg.modelUsage || {})
      const primaryModelUsage = modelUsageEntries[0]

      const usage = {
        inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
        outputTokens: msg.usage.output_tokens,
        costUsd: msg.total_cost_usd,
        contextWindow: primaryModelUsage?.contextWindow,
      }

      if (msg.subtype === 'success') {
        events.push({ type: 'complete', usage })
      } else {
        const errorMsg = msg.errors ? msg.errors.join(', ') : 'Agent 查询失败'
        events.push({ type: 'error', message: errorMsg })
        events.push({ type: 'complete', usage })
      }
      break
    }

    default:
      // 记录未处理的消息类型，帮助调试
      console.log(`[Agent 服务] 忽略消息类型: ${message.type}`)
      break
  }

  return events
}

/** 最大回填消息条数 */
const MAX_CONTEXT_MESSAGES = 20

/**
 * 构建带历史上下文的 prompt
 *
 * 当 resume 不可用时（cwd 迁移等），将最近消息拼接为上下文注入 prompt，
 * 让新 SDK 会话保留对话记忆。仅取 user/assistant 角色的文本内容。
 */
async function buildContextPrompt(sessionId: string, currentUserMessage: string): Promise<string> {
  const allMessages = await getAgentSessionMessages(sessionId)
  if (allMessages.length === 0) return currentUserMessage

  // 排除最后一条（刚刚追加的当前用户消息）
  const history = allMessages.slice(0, -1)
  if (history.length === 0) return currentUserMessage

  const recent = history.slice(-MAX_CONTEXT_MESSAGES)
  const lines = recent
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => `[${m.role}]: ${m.content}`)

  if (lines.length === 0) return currentUserMessage

  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n${currentUserMessage}`
}

/**
 * 运行 Agent 并通过回调推送 SSE 事件
 */
export async function runAgent(
  input: AgentSendInput,
  callbacks: AgentStreamCallbacks,
): Promise<void> {
  const { sessionId, userMessage, channelId, modelId, workspaceId } = input

  // 1. 获取渠道信息并解密 API Key
  const channel = await getChannelById(channelId)
  if (!channel) {
    await callbacks.onError(sessionId, '渠道不存在')
    return
  }

  let apiKey: string
  try {
    apiKey = await decryptApiKey(channelId)
  } catch {
    await callbacks.onError(sessionId, '解密 API Key 失败')
    return
  }

  // 2. 注入环境变量
  const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com'
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
  }
  // 自定义 Base URL 时注入 ANTHROPIC_BASE_URL
  if (channel.baseUrl && channel.baseUrl !== DEFAULT_ANTHROPIC_URL) {
    sdkEnv.ANTHROPIC_BASE_URL = channel.baseUrl
  } else {
    delete sdkEnv.ANTHROPIC_BASE_URL
  }

  // 代理配置
  const proxyUrl = await getEffectiveProxyUrl()
  if (proxyUrl) {
    sdkEnv.HTTPS_PROXY = proxyUrl
    sdkEnv.HTTP_PROXY = proxyUrl
  }

  // 2.5 读取已有的 SDK session ID
  const sessionMeta = await getAgentSessionMeta(sessionId)
  let existingSdkSessionId = sessionMeta?.sdkSessionId

  // 3. 持久化用户消息
  const userMsg: AgentMessage = {
    id: randomUUID(),
    role: 'user',
    content: userMessage,
    createdAt: Date.now(),
  }
  await appendAgentMessage(sessionId, userMsg)

  // 4. 创建 AbortController
  const controller = new AbortController()
  activeControllers.set(sessionId, controller)

  // 5. 状态初始化
  const toolIndex = new ToolIndex()
  const emittedToolStarts = new Set<string>()
  const activeParentTools = new Set<string>()
  const pendingText = { value: null as string | null }
  const pendingReasoning = { value: null as string | null }
  const turnId = { value: null as string | null }
  let cachedContextWindow: number | undefined

  // 累积文本用于持久化
  let accumulatedText = ''
  let accumulatedReasoning = ''
  const accumulatedEvents: AgentEvent[] = []
  let resolvedModel = modelId || 'claude-sonnet-4-5-20250929'
  const stderrChunks: string[] = []

  try {
    // 6. 动态导入 SDK
    let sdk
    try {
      sdk = await import('@anthropic-ai/claude-agent-sdk')
      console.log('[Agent 服务] SDK 导入成功')
    } catch (sdkImportError) {
      const errMsg = 'SDK 导入失败，请确保 @anthropic-ai/claude-agent-sdk 已正确安装'
      console.error(`[Agent 服务] ${errMsg}`, sdkImportError)
      await callbacks.onError(sessionId, `${errMsg}: ${sdkImportError instanceof Error ? sdkImportError.message : '未知错误'}`)
      return
    }

    // 7. 构建 SDK query
    const cliPath = resolveSDKCliPath()
    const bunPath = getBunExecutablePath()

    // 路径验证
    if (!existsSync(cliPath)) {
      const errMsg = `SDK CLI 文件不存在: ${cliPath}`
      console.error(`[Agent 服务] ${errMsg}`)
      await callbacks.onError(sessionId, errMsg)
      return
    }

    console.log(`[Agent 服务] 启动 SDK — CLI: ${cliPath}, Bun: ${bunPath}, 模型: ${modelId || 'claude-sonnet-4-5-20250929'}, resume: ${existingSdkSessionId ?? '无'}`)

    // 安全：--env-file=/dev/null 阻止 Bun 自动加载用户项目中的 .env 文件
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'

    // 确定 Agent 工作目录
    let agentCwd = homedir()
    let workspaceSlug: string | undefined
    let workspace: import('@proma/shared').AgentWorkspace | undefined
    if (workspaceId) {
      const ws = await getAgentWorkspace(workspaceId)
      if (ws) {
        agentCwd = getAgentSessionWorkspacePath(ws.slug, sessionId)
        workspaceSlug = ws.slug
        workspace = ws
        console.log(`[Agent 服务] 使用 session 级别 cwd: ${agentCwd} (${ws.name}/${sessionId})`)

        ensurePluginManifest(ws.slug, ws.name)

        if (existingSdkSessionId) {
          try {
            const contents = readdirSync(agentCwd)
            if (contents.length === 0) {
              await updateAgentSessionMeta(sessionId, { sdkSessionId: undefined })
              existingSdkSessionId = undefined
              console.log(`[Agent 服务] 迁移: session 目录为空，清除 sdkSessionId，回填历史上下文`)
            }
          } catch {
            // 读取失败不影响主流程
          }
        }
      }
    }

    // 8. 构建工作区 MCP 服务器配置
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServers: Record<string, any> = {}
    if (workspaceSlug) {
      const mcpConfig = await getWorkspaceMcpConfig(workspaceSlug)
      for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
        if (!entry.enabled) continue

        if (entry.type === 'stdio' && entry.command) {
          const mergedEnv: Record<string, string> = {
            ...(process.env.PATH && { PATH: process.env.PATH }),
            ...entry.env,
          }
          mcpServers[name] = {
            type: 'stdio',
            command: entry.command,
            ...(entry.args && entry.args.length > 0 && { args: entry.args }),
            ...(Object.keys(mergedEnv).length > 0 && { env: mergedEnv }),
          }
        } else if ((entry.type === 'http' || entry.type === 'sse') && entry.url) {
          mcpServers[name] = {
            type: entry.type,
            url: entry.url,
            ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
          }
        }
      }
      if (Object.keys(mcpServers).length > 0) {
        console.log(`[Agent 服务] 已加载 ${Object.keys(mcpServers).length} 个 MCP 服务器`)
      }
    }

    // 9. 构建动态上下文
    const dynamicCtx = await buildDynamicContext({
      workspaceName: workspace?.name,
      workspaceSlug,
      agentCwd,
    })
    const contextualMessage = `${dynamicCtx}\n\n${userMessage}`

    // 构建最终 prompt
    const isCompactCommand = userMessage.trim() === '/compact'
    const finalPrompt = isCompactCommand
      ? '/compact'
      : existingSdkSessionId
        ? contextualMessage
        : await buildContextPrompt(sessionId, contextualMessage)

    if (finalPrompt !== contextualMessage) {
      console.log(`[Agent 服务] 已回填历史上下文（无 resume）`)
    }

    console.log(`[Agent 服务] 准备调用 SDK query...`)
    console.log(`[Agent 服务] 参数: model=${modelId || 'claude-sonnet-4-5-20250929'}, cwd=${agentCwd}`)

    const queryIterator = sdk.query({
      prompt: finalPrompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        executable: bunPath as 'bun',
        executableArgs: [`--env-file=${nullDevice}`],
        model: modelId || 'claude-sonnet-4-5-20250929',
        maxTurns: 30,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        cwd: agentCwd,
        abortController: controller,
        env: sdkEnv,
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: await buildSystemPromptAppend({
            workspaceName: workspace?.name,
            workspaceSlug,
            sessionId,
          }),
        },
        ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
        ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
        ...(workspaceSlug && { plugins: [{ type: 'local' as const, path: getAgentWorkspacePath(workspaceSlug) }] }),
        stderr: (data: string) => {
          stderrChunks.push(data)
          console.error(`[Agent SDK stderr] ${data}`)
        },
      },
    })

    console.log(`[Agent 服务] SDK query 迭代器已创建，开始处理消息...`)

    // 遍历 SDK 消息流
    for await (const sdkMessage of queryIterator) {
      if (controller.signal.aborted) break

      const msg = sdkMessage as SDKMessage
      console.log(`[Agent 服务] 收到 SDK 消息: type=${msg.type}`)

      // 从 system init 消息中捕获模型信息
      if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
        const initMsg = msg as { model?: string; skills?: string[]; tools?: string[]; plugins?: Array<{ name: string; path: string }> }
        if (typeof initMsg.model === 'string') {
          resolvedModel = initMsg.model
          console.log(`[Agent 服务] SDK 确认模型: ${resolvedModel}`)
        }
        console.log(`[Agent 服务][诊断] SDK init skills: ${JSON.stringify(initMsg.skills)}`)
        console.log(`[Agent 服务][诊断] SDK init plugins: ${JSON.stringify(initMsg.plugins)}`)
      }

      // 捕获 SDK session_id
      if ('session_id' in msg && typeof msg.session_id === 'string' && msg.session_id) {
        const sdkSid = msg.session_id as string
        if (sdkSid !== existingSdkSessionId) {
          try {
            await updateAgentSessionMeta(sessionId, { sdkSessionId: sdkSid })
            console.log(`[Agent 服务] 已保存 SDK session_id: ${sdkSid}`)
          } catch {
            // 索引更新失败不影响主流程
          }
        }
      }

      // 追踪 usage
      if (msg.type === 'assistant') {
        const aMsg = msg as SDKAssistantMessage
        if (!aMsg.parent_tool_use_id && aMsg.message.usage) {
          const u = aMsg.message.usage
          const currentInputTokens = u.input_tokens
            + (u.cache_read_input_tokens ?? 0)
            + (u.cache_creation_input_tokens ?? 0)
          const usageEvt: AgentEvent = {
            type: 'usage_update',
            usage: { inputTokens: currentInputTokens, contextWindow: cachedContextWindow },
          }
          await callbacks.onEvent(sessionId, usageEvt)
          accumulatedEvents.push(usageEvt)
        }
      }

      // 处理 system compaction 事件
      if (msg.type === 'system') {
        const sysMsg = msg as { type: 'system'; subtype?: string; status?: string }
        if (sysMsg.subtype === 'compact_boundary') {
          const evt: AgentEvent = { type: 'compact_complete' }
          await callbacks.onEvent(sessionId, evt)
          accumulatedEvents.push(evt)
          console.log('[Agent 服务] 上下文压缩完成')
        } else if (sysMsg.subtype === 'status' && sysMsg.status === 'compacting') {
          const evt: AgentEvent = { type: 'compacting' }
          await callbacks.onEvent(sessionId, evt)
          accumulatedEvents.push(evt)
          console.log('[Agent 服务] 上下文压缩中...')
        }
      }

      const agentEvents = convertSDKMessage(
        msg,
        toolIndex,
        emittedToolStarts,
        activeParentTools,
        pendingText,
        pendingReasoning,
        turnId,
      )

      // 缓存 contextWindow
      if (msg.type === 'result') {
        const resultMsg = msg as SDKResultMessage
        const modelUsageEntries = Object.values(resultMsg.modelUsage || {})
        const primaryModelUsage = modelUsageEntries[0]
        if (primaryModelUsage?.contextWindow) {
          cachedContextWindow = primaryModelUsage.contextWindow
          console.log(`[Agent 服务] 缓存 contextWindow: ${cachedContextWindow}`)
        }
      }

      for (const event of agentEvents) {
        if (event.type === 'text_delta') {
          accumulatedText += event.text
        }
        if (event.type === 'thinking_delta') {
          accumulatedReasoning += event.text
        }
        accumulatedEvents.push(event)

        // 通过回调推送 SSE
        await callbacks.onEvent(sessionId, event)
      }
    }

    // 持久化 assistant 消息
    if (accumulatedText || accumulatedReasoning || accumulatedEvents.length > 0) {
      const assistantMsg: AgentMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: accumulatedText,
        reasoning: accumulatedReasoning || undefined,
        createdAt: Date.now(),
        model: resolvedModel,
        events: accumulatedEvents,
      }
      await appendAgentMessage(sessionId, assistantMsg)
    }

    // 更新会话索引
    try {
      await updateAgentSessionMeta(sessionId, {})
    } catch {
      // 索引更新失败不影响主流程
    }

    await callbacks.onComplete(sessionId)

    // 异步生成标题
    autoGenerateTitle(sessionId, userMessage, channelId, modelId || 'claude-sonnet-4-5-20250929', callbacks)
  } catch (error) {
    if (controller.signal.aborted) {
      console.log(`[Agent 服务] 会话 ${sessionId} 已被用户中止`)

      if (accumulatedText || accumulatedReasoning || accumulatedEvents.length > 0) {
        const partialMsg: AgentMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: accumulatedText,
          reasoning: accumulatedReasoning || undefined,
          createdAt: Date.now(),
          model: resolvedModel,
          events: accumulatedEvents,
        }
        await appendAgentMessage(sessionId, partialMsg)
      }

      await callbacks.onComplete(sessionId)
      return
    }

    const errorMessage = error instanceof Error ? error.message : '未知错误'
    console.error(`[Agent 服务] 执行失败:`, error)

    const stderrOutput = stderrChunks.join('').trim()
    const detailedError = stderrOutput
      ? `${errorMessage}\n\nstderr: ${stderrOutput.slice(0, 500)}`
      : errorMessage

    if (existingSdkSessionId) {
      try {
        await updateAgentSessionMeta(sessionId, { sdkSessionId: undefined })
        console.log(`[Agent 服务] 已清除失效的 sdkSessionId，下次发送将重新开始`)
      } catch {
        // 清理失败不影响错误流
      }
    }

    await callbacks.onError(sessionId, detailedError)
  } finally {
    activeControllers.delete(sessionId)
  }
}

/** 标题生成 Prompt */
const TITLE_PROMPT = '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：'

/** 标题最大长度 */
const MAX_TITLE_LENGTH = 20

/** 默认会话标题 */
const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  const { userMessage, channelId, modelId } = input

  try {
    const channels = await listChannels()
    const channel = channels.find((c) => c.id === channelId)
    if (!channel) {
      console.warn('[Agent 标题生成] 渠道不存在:', channelId)
      return null
    }

    const apiKey = await decryptApiKey(channelId)
    const adapter = getAdapter(channel.provider)
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
      prompt: TITLE_PROMPT + userMessage,
    })

    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)
    const title = await fetchTitle(request, adapter, fetchFn)
    if (!title) return null

    const cleaned = title.trim().replace(/^["'""''「《]+|["'""''」》]+$/g, '').trim()
    const result = cleaned.slice(0, MAX_TITLE_LENGTH) || null

    console.log(`[Agent 标题生成] 生成标题: "${result}"`)
    return result
  } catch (error) {
    console.warn('[Agent 标题生成] 生成失败:', error)
    return null
  }
}

/**
 * Agent 流完成后自动生成标题
 */
async function autoGenerateTitle(
  sessionId: string,
  userMessage: string,
  channelId: string,
  modelId: string,
  callbacks: AgentStreamCallbacks,
): Promise<void> {
  try {
    const meta = await getAgentSessionMeta(sessionId)
    if (!meta || meta.title !== DEFAULT_SESSION_TITLE) return

    const title = await generateAgentTitle({ userMessage, channelId, modelId })
    if (!title) return

    await updateAgentSessionMeta(sessionId, { title })
    await callbacks.onTitleUpdated(sessionId, title)
    console.log(`[Agent 服务] 自动标题生成完成: "${title}"`)
  } catch (error) {
    console.warn('[Agent 服务] 自动标题生成失败:', error)
  }
}

/**
 * 中止指定会话的 Agent 执行
 */
export function stopAgent(sessionId: string): void {
  const controller = activeControllers.get(sessionId)
  if (controller) {
    controller.abort()
    activeControllers.delete(sessionId)
    console.log(`[Agent 服务] 已中止会话: ${sessionId}`)
  }
}

/** 中止所有活跃的 Agent 会话 */
export function stopAllAgents(): void {
  if (activeControllers.size === 0) return
  console.log(`[Agent 服务] 正在中止所有活跃会话 (${activeControllers.size} 个)...`)
  for (const [sessionId, controller] of activeControllers) {
    controller.abort()
    console.log(`[Agent 服务] 已中止会话: ${sessionId}`)
  }
  activeControllers.clear()
}

/**
 * 保存文件到 Agent session 工作目录
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(sessionDir, file.filename)

    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })
    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * 复制文件夹到 Agent session 工作目录
 */
export function copyFolderToSession(input: AgentCopyFolderInput): AgentSavedFile[] {
  const { sourcePath, workspaceSlug, sessionId } = input
  const sessionDir = getAgentSessionWorkspacePath(workspaceSlug, sessionId)

  const folderName = sourcePath.split('/').filter(Boolean).pop() || 'folder'
  const targetDir = join(sessionDir, folderName)

  cpSync(sourcePath, targetDir, { recursive: true })
  console.log(`[Agent 服务] 文件夹已复制: ${sourcePath} → ${targetDir}`)

  const results: AgentSavedFile[] = []
  const collectFiles = (dir: string, relativeTo: string): void => {
    const items = readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        collectFiles(fullPath, relativeTo)
      } else {
        const relPath = fullPath.slice(relativeTo.length + 1)
        results.push({ filename: relPath, targetPath: fullPath })
      }
    }
  }
  collectFiles(targetDir, sessionDir)

  console.log(`[Agent 服务] 文件夹复制完成，共 ${results.length} 个文件`)
  return results
}
