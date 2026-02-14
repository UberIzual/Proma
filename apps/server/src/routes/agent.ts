/**
 * Agent API 路由
 *
 * 实现 Agent 模式相关的 REST API 和 SSE 流式响应。
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  listAgentSessions,
  createAgentSession,
  getAgentSessionMessages,
  updateAgentSessionMeta,
  deleteAgentSession,
} from '../services/agent-session-manager'
import {
  listAgentWorkspaces,
  createAgentWorkspace,
  updateAgentWorkspace,
  deleteAgentWorkspace,
  getWorkspaceCapabilities,
  getWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
  getWorkspaceSkills,
  deleteWorkspaceSkill,
} from '../services/agent-workspace-manager'
import {
  runAgent,
  stopAgent,
  generateAgentTitle,
  saveFilesToAgentSession,
  copyFolderToSession,
} from '../services/agent-service'
import type {
  AgentSendInput,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentCopyFolderInput,
  AgentEvent,
} from '@proma/shared'

const app = new Hono()

// ===== 会话管理 =====

/** 获取会话列表 */
app.get('/sessions', async (c) => {
  const sessions = await listAgentSessions()
  return c.json(sessions)
})

/** 创建会话 */
app.post('/sessions', async (c) => {
  const body = await c.req.json<{ title?: string; channelId?: string; workspaceId?: string }>()
  const session = await createAgentSession(body.title, body.channelId, body.workspaceId)
  return c.json(session, 201)
})

/** 获取会话消息 */
app.get('/sessions/:id/messages', async (c) => {
  const id = c.req.param('id')
  const messages = await getAgentSessionMessages(id)
  return c.json(messages)
})

/** 更新会话标题 */
app.patch('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ title?: string }>()
  try {
    const session = await updateAgentSessionMeta(id, body)
    return c.json(session)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '更新失败' }, 400)
  }
})

/** 删除会话 */
app.delete('/sessions/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await deleteAgentSession(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '删除失败' }, 400)
  }
})

/** 生成标题 */
app.post('/sessions/:id/generate-title', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ userMessage: string; channelId: string; modelId: string }>()

  const title = await generateAgentTitle({
    userMessage: body.userMessage,
    channelId: body.channelId,
    modelId: body.modelId,
  })

  if (title) {
    await updateAgentSessionMeta(id, { title })
    return c.json({ title })
  }

  return c.json({ title: null })
})

// ===== 工作区管理 =====

/** 获取工作区列表 */
app.get('/workspaces', async (c) => {
  const workspaces = await listAgentWorkspaces()
  return c.json(workspaces)
})

/** 创建工作区 */
app.post('/workspaces', async (c) => {
  const body = await c.req.json<{ name: string }>()
  try {
    const workspace = await createAgentWorkspace(body.name)
    return c.json(workspace, 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '创建失败' }, 400)
  }
})

/** 更新工作区 */
app.patch('/workspaces/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name: string }>()
  try {
    const workspace = await updateAgentWorkspace(id, body)
    return c.json(workspace)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '更新失败' }, 400)
  }
})

/** 删除工作区 */
app.delete('/workspaces/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await deleteAgentWorkspace(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '删除失败' }, 400)
  }
})

// ===== 工作区能力 =====

/** 获取工作区能力摘要 */
app.get('/workspaces/:slug/capabilities', async (c) => {
  const slug = c.req.param('slug')
  const capabilities = await getWorkspaceCapabilities(slug)
  return c.json(capabilities)
})

/** 获取 MCP 配置 */
app.get('/workspaces/:slug/mcp', async (c) => {
  const slug = c.req.param('slug')
  const config = await getWorkspaceMcpConfig(slug)
  return c.json(config)
})

/** 保存 MCP 配置 */
app.put('/workspaces/:slug/mcp', async (c) => {
  const slug = c.req.param('slug')
  const config = await c.req.json()
  try {
    await saveWorkspaceMcpConfig(slug, config)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '保存失败' }, 400)
  }
})

/** 获取 Skills 列表 */
app.get('/workspaces/:slug/skills', async (c) => {
  const slug = c.req.param('slug')
  const skills = getWorkspaceSkills(slug)
  return c.json(skills)
})

/** 删除 Skill */
app.delete('/workspaces/:slug/skills/:skillSlug', async (c) => {
  const slug = c.req.param('slug')
  const skillSlug = c.req.param('skillSlug')
  try {
    deleteWorkspaceSkill(slug, skillSlug)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '删除失败' }, 400)
  }
})

// ===== 消息发送（SSE 流式） =====

app.post('/send', async (c) => {
  const input = await c.req.json<AgentSendInput>()

  return streamSSE(c, async (stream) => {
    try {
      // 定义 SSE 回调
      const callbacks = {
        onEvent: async (sessionId: string, event: AgentEvent) => {
          await stream.writeSSE({
            event: 'event',
            data: JSON.stringify({ sessionId, event }),
          })
        },
        onComplete: async (sessionId: string) => {
          await stream.writeSSE({
            event: 'complete',
            data: JSON.stringify({ sessionId }),
          })
        },
        onError: async (sessionId: string, error: string) => {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({ sessionId, error }),
          })
        },
        onTitleUpdated: async (sessionId: string, title: string) => {
          await stream.writeSSE({
            event: 'title-updated',
            data: JSON.stringify({ sessionId, title }),
          })
        },
      }

      await runAgent(input, callbacks)
    } catch (error) {
      console.error('[Agent 路由] streamSSE 内部错误:', error)
      // 尝试通过 SSE 发送错误信息
      try {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            sessionId: input.sessionId,
            error: error instanceof Error ? error.message : '服务器内部错误'
          }),
        })
      } catch {
        // 如果 SSE 写入也失败，只能记录日志
        console.error('[Agent 路由] 无法发送错误事件')
      }
    }
  })
})

/** 中止 Agent 执行 */
app.post('/stop', async (c) => {
  const body = await c.req.json<{ sessionId: string }>()
  stopAgent(body.sessionId)
  return c.json({ success: true })
})

// ===== 附件管理 =====

/** 保存文件到 session */
app.post('/sessions/:sessionId/files', async (c) => {
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json<Omit<AgentSaveFilesInput, 'sessionId'>>()
  const input: AgentSaveFilesInput = { ...body, sessionId }
  const files = saveFilesToAgentSession(input)
  return c.json(files)
})

/** 复制文件夹到 session */
app.post('/sessions/:sessionId/folders', async (c) => {
  const sessionId = c.req.param('sessionId')
  const body = await c.req.json<Omit<AgentCopyFolderInput, 'sessionId'>>()
  const input: AgentCopyFolderInput = { ...body, sessionId }
  const files = copyFolderToSession(input)
  return c.json(files)
})

/** 生成标题（独立 API） */
app.post('/generate-title', async (c) => {
  const input = await c.req.json<AgentGenerateTitleInput>()
  const title = await generateAgentTitle(input)
  return c.json({ title })
})

export default app
