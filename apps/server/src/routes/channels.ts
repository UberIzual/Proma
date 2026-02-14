/**
 * 渠道管理路由
 */

import { Hono } from 'hono'
import {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  decryptApiKey,
  testChannel,
  testChannelDirect,
  fetchModels,
} from '../services/channel-manager'
import type { ChannelCreateInput, ChannelUpdateInput, FetchModelsInput } from '@proma/shared'

const app = new Hono()

// 获取所有渠道
app.get('/', async (c) => {
  const channels = await listChannels()
  return c.json(channels)
})

// 创建渠道
app.post('/', async (c) => {
  const input = await c.req.json<ChannelCreateInput>()
  const channel = await createChannel(input)
  return c.json(channel, 201)
})

// 获取渠道的明文 API Key
app.get('/:id/key', async (c) => {
  const id = c.req.param('id')
  try {
    const apiKey = await decryptApiKey(id)
    return c.json({ apiKey })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '解密失败' }, 400)
  }
})

// 更新渠道
app.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const input = await c.req.json<ChannelUpdateInput>()
  try {
    const channel = await updateChannel(id, input)
    return c.json(channel)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '更新失败' }, 400)
  }
})

// 删除渠道
app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await deleteChannel(id)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '删除失败' }, 400)
  }
})

// 测试渠道连接
app.post('/:id/test', async (c) => {
  const id = c.req.param('id')
  const result = await testChannel(id)
  return c.json(result)
})

// 直接测试连接（无需已保存渠道）
app.post('/test-direct', async (c) => {
  const input = await c.req.json<FetchModelsInput>()
  const result = await testChannelDirect(input)
  return c.json(result)
})

// 拉取模型列表
app.post('/fetch-models', async (c) => {
  const input = await c.req.json<FetchModelsInput>()
  const result = await fetchModels(input)
  return c.json(result)
})

export default app
