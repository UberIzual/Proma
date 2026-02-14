/**
 * 附件管理路由
 */

import { Hono } from 'hono'
import {
  saveAttachment,
  readAttachmentAsBase64,
  deleteAttachment,
} from '../services/attachment-service'
import { extractTextFromAttachment } from '../services/document-parser'
import type { AttachmentSaveInput } from '@proma/shared'

const app = new Hono()

// 保存附件
app.post('/', async (c) => {
  const input = await c.req.json<AttachmentSaveInput>()
  try {
    const result = await saveAttachment(input)
    return c.json(result, 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '保存失败' }, 400)
  }
})

// 读取附件（返回 base64）
app.get('/', async (c) => {
  const localPath = c.req.query('path')
  if (!localPath) {
    return c.json({ error: '缺少 path 参数' }, 400)
  }
  try {
    const data = await readAttachmentAsBase64(localPath)
    return c.json({ data })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '读取失败' }, 400)
  }
})

// 删除附件
app.delete('/', async (c) => {
  const localPath = c.req.query('path')
  if (!localPath) {
    return c.json({ error: '缺少 path 参数' }, 400)
  }
  try {
    deleteAttachment(localPath)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '删除失败' }, 400)
  }
})

// 提取文档文本
app.post('/extract-text', async (c) => {
  const { localPath } = await c.req.json<{ localPath: string }>()
  if (!localPath) {
    return c.json({ error: '缺少 localPath 参数' }, 400)
  }
  try {
    const text = await extractTextFromAttachment(localPath)
    return c.json({ text })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '提取失败' }, 400)
  }
})

export default app
