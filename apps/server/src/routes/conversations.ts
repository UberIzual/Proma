/**
 * 对话管理路由
 */

import { Hono } from 'hono'
import {
  listConversations,
  createConversation,
  getConversationMessages,
  getRecentMessages,
  updateConversationMeta,
  deleteConversation,
  deleteMessage,
  truncateMessagesFrom,
  updateContextDividers,
} from '../services/conversation-manager'

const app = new Hono()

// 获取所有对话
app.get('/', async (c) => {
  const conversations = await listConversations()
  return c.json(conversations)
})

// 创建对话
app.post('/', async (c) => {
  const body = await c.req.json<{ title?: string; modelId?: string; channelId?: string }>()
  const conversation = await createConversation(body.title, body.modelId, body.channelId)
  return c.json(conversation, 201)
})

// 获取对话消息
app.get('/:id/messages', async (c) => {
  const id = c.req.param('id')
  const messages = await getConversationMessages(id)
  return c.json(messages)
})

// 获取最近 N 条消息
app.get('/:id/messages/recent', async (c) => {
  const id = c.req.param('id')
  const limit = parseInt(c.req.query('limit') || '50', 10)
  const result = await getRecentMessages(id, limit)
  return c.json(result)
})

// 更新对话标题
app.patch('/:id/title', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ title: string }>()
  try {
    const conversation = await updateConversationMeta(id, { title: body.title })
    return c.json(conversation)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '更新失败' }, 400)
  }
})

// 更新对话模型/渠道
app.patch('/:id/model', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ modelId?: string; channelId?: string }>()
  try {
    const conversation = await updateConversationMeta(id, body)
    return c.json(conversation)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '更新失败' }, 400)
  }
})

// 切换置顶状态
app.post('/:id/toggle-pin', async (c) => {
  const id = c.req.param('id')
  try {
    const conversations = await listConversations()
    const current = conversations.find((c) => c.id === id)
    const conversation = await updateConversationMeta(id, { pinned: !current?.pinned })
    return c.json(conversation)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '操作失败' }, 400)
  }
})

// 删除对话
app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await deleteConversation(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '删除失败' }, 400)
  }
})

// 删除消息
app.delete('/:id/messages/:messageId', async (c) => {
  const id = c.req.param('id')
  const messageId = c.req.param('messageId')
  try {
    const messages = await deleteMessage(id, messageId)
    return c.json(messages)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '删除失败' }, 400)
  }
})

// 截断消息
app.post('/:id/truncate', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ messageId: string; preserveFirstMessageAttachments?: boolean }>()
  try {
    const messages = await truncateMessagesFrom(id, body.messageId, body.preserveFirstMessageAttachments)
    return c.json(messages)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '截断失败' }, 400)
  }
})

// 更新上下文分隔线
app.post('/:id/context-dividers', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ dividers: string[] }>()
  try {
    const conversation = await updateContextDividers(id, body.dividers)
    return c.json(conversation)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '更新失败' }, 400)
  }
})

export default app
