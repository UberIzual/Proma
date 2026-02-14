/**
 * 聊天相关路由（包括 SSE 流式响应）
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import {
  listChannels,
  getChannelById,
  decryptApiKey,
} from '../services/channel-manager'
import {
  getConversationMessages,
  appendMessage,
  updateConversationMeta,
} from '../services/conversation-manager'
import { getFetchFn } from '../services/proxy-fetch'
import { getEffectiveProxyUrl } from '../services/proxy-settings-service'
import { readAttachmentAsBase64, isImageAttachment } from '../services/attachment-service'
import { extractTextFromAttachment, isDocumentAttachment } from '../services/document-parser'
import { getAdapter, streamSSE as coreStreamSSE } from '@proma/core'
import type { ChatSendInput, ChatMessage, GenerateTitleInput, FileAttachment } from '@proma/shared'
import type { ImageAttachmentData } from '@proma/core'

const app = new Hono()

/** 活跃的 AbortController 映射（conversationId → controller） */
const activeControllers = new Map<string, AbortController>()

// ===== 图片附件读取器 =====

/**
 * 读取图片附件的 base64 数据
 *
 * 注意：Web 版本的图片附件读取是异步的，
 * 但 core 层的 ImageAttachmentReader 是同步的。
 * 这里提供一个简化版本，在 buildStreamRequest 前预读取图片。
 */
function getImageAttachmentDataSync(attachments?: FileAttachment[]): ImageAttachmentData[] {
  // 同步版本返回空数组，实际图片数据在调用前预加载
  if (!attachments || attachments.length === 0) return []
  return []
}

/**
 * 异步预加载图片附件数据
 */
async function preloadImageAttachments(attachments?: FileAttachment[]): Promise<Map<string, ImageAttachmentData>> {
  const imageMap = new Map<string, ImageAttachmentData>()
  if (!attachments || attachments.length === 0) return imageMap

  for (const att of attachments) {
    if (isImageAttachment(att.mediaType)) {
      try {
        const data = await readAttachmentAsBase64(att.localPath)
        imageMap.set(att.id, { mediaType: att.mediaType, data })
      } catch (error) {
        console.warn(`[聊天服务] 读取图片附件失败: ${att.filename}`, error)
      }
    }
  }
  return imageMap
}

/**
 * 创建图片附件读取器（使用预加载的数据）
 */
function createImageAttachmentReader(
  attachments: FileAttachment[] | undefined,
  imageDataMap: Map<string, ImageAttachmentData>,
): () => ImageAttachmentData[] {
  return () => {
    if (!attachments || attachments.length === 0) return []
    return attachments
      .filter((att) => isImageAttachment(att.mediaType))
      .map((att) => imageDataMap.get(att.id))
      .filter((data): data is ImageAttachmentData => data !== undefined)
  }
}

// ===== 文档附件文本提取 =====

/**
 * 为单条消息提取文档附件的文本内容
 *
 * 将非图片附件的文本内容提取后，以结构化格式追加到消息文本后面。
 * 图片附件由适配器层单独处理，这里只处理文档类附件。
 */
async function enrichMessageWithDocuments(
  messageText: string,
  attachments?: FileAttachment[],
): Promise<string> {
  if (!attachments || attachments.length === 0) return messageText

  const docAttachments = attachments.filter((att) => isDocumentAttachment(att.mediaType))
  if (docAttachments.length === 0) return messageText

  const parts: string[] = [messageText]

  for (const att of docAttachments) {
    try {
      const text = await extractTextFromAttachment(att.localPath)
      if (text.trim()) {
        parts.push(`\n<file name="${att.filename}">\n${text}\n</file>`)
      } else {
        parts.push(`\n<file name="${att.filename}">\n[文件内容为空]\n</file>`)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      console.warn(`[聊天服务] 文档提取失败: ${att.filename}`, error)
      parts.push(`\n<file name="${att.filename}">\n[文件内容提取失败: ${errorMsg}]\n</file>`)
    }
  }

  return parts.join('')
}

/**
 * 为历史消息列表注入文档附件文本
 *
 * 遍历历史消息，对包含文档附件的用户消息进行文本增强。
 */
async function enrichHistoryWithDocuments(
  history: ChatMessage[],
): Promise<ChatMessage[]> {
  const enriched: ChatMessage[] = []

  for (const msg of history) {
    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      const hasDocuments = msg.attachments.some((att) => isDocumentAttachment(att.mediaType))
      if (hasDocuments) {
        const enrichedContent = await enrichMessageWithDocuments(msg.content, msg.attachments)
        enriched.push({ ...msg, content: enrichedContent })
        continue
      }
    }
    enriched.push(msg)
  }

  return enriched
}

// ===== 上下文过滤 =====

/**
 * 根据分隔线和上下文长度裁剪历史消息
 */
function filterHistory(
  messageHistory: ChatMessage[],
  contextDividers?: string[],
  contextLength?: number | 'infinite',
): ChatMessage[] {
  let filtered = messageHistory.filter(
    (msg) => !(msg.role === 'assistant' && !msg.content.trim()),
  )

  if (contextDividers && contextDividers.length > 0) {
    const lastDividerId = contextDividers[contextDividers.length - 1]
    const dividerIndex = filtered.findIndex((msg) => msg.id === lastDividerId)
    if (dividerIndex >= 0) {
      filtered = filtered.slice(dividerIndex + 1)
    }
  }

  if (typeof contextLength === 'number' && contextLength >= 0) {
    if (contextLength === 0) {
      return []
    }
    const collected: ChatMessage[] = []
    let roundCount = 0
    for (let i = filtered.length - 1; i >= 0; i--) {
      const msg = filtered[i] as ChatMessage
      collected.unshift(msg)
      if (msg.role === 'user') {
        roundCount++
        if (roundCount >= contextLength) break
      }
    }
    return collected
  }

  return filtered
}

// 发送消息（SSE 流式响应）
app.post('/send', async (c) => {
  const input = await c.req.json<ChatSendInput>()
  const {
    conversationId, userMessage, channelId,
    modelId, systemMessage, contextLength, contextDividers, attachments,
    thinkingEnabled,
  } = input

  // 设置 SSE headers
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  return streamSSE(c, async (stream) => {
    // 1. 查找渠道
    const channel = await getChannelById(channelId)
    if (!channel) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', error: '渠道不存在' }) })
      return
    }

    // 2. 解密 API Key
    let apiKey: string
    try {
      apiKey = await decryptApiKey(channelId)
    } catch {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', error: '解密 API Key 失败' }) })
      return
    }

    // 3. 读取历史消息
    const fullHistory = await getConversationMessages(conversationId)

    // 4. 追加用户消息
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: userMessage,
      createdAt: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    }
    await appendMessage(conversationId, userMsg)

    // 5. 过滤历史
    const filteredHistory = filterHistory(fullHistory, contextDividers, contextLength)

    // 5.5 提取文档附件文本 + 预加载图片附件
    const enrichedHistory = await enrichHistoryWithDocuments(filteredHistory)
    const enrichedUserMessage = await enrichMessageWithDocuments(userMessage, attachments)
    const imageDataMap = await preloadImageAttachments(attachments)

    // 6. 创建 AbortController
    const controller = new AbortController()
    activeControllers.set(conversationId, controller)

    let accumulatedContent = ''
    let accumulatedReasoning = ''

    try {
      // 7. 获取适配器并执行流式 SSE
      const adapter = getAdapter(channel.provider)
      const request = adapter.buildStreamRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        history: enrichedHistory,
        userMessage: enrichedUserMessage,
        systemMessage,
        attachments,
        readImageAttachments: createImageAttachmentReader(attachments, imageDataMap),
        thinkingEnabled,
      })

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)

      const { content, reasoning } = await coreStreamSSE({
        request,
        adapter,
        signal: controller.signal,
        fetchFn,
        onEvent: (event) => {
          switch (event.type) {
            case 'chunk':
              accumulatedContent += event.delta
              // SSE 推送
              stream.writeSSE({
                data: JSON.stringify({
                  type: 'chunk',
                  conversationId,
                  delta: event.delta,
                }),
              }).catch(() => {})
              break
            case 'reasoning':
              accumulatedReasoning += event.delta
              stream.writeSSE({
                data: JSON.stringify({
                  type: 'reasoning',
                  conversationId,
                  delta: event.delta,
                }),
              }).catch(() => {})
              break
          }
        },
      })

      // 8. 保存 assistant 消息
      const assistantMsgId = randomUUID()
      if (content.trim()) {
        const assistantMsg: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          content,
          createdAt: Date.now(),
          model: modelId,
          reasoning: reasoning || undefined,
        }
        await appendMessage(conversationId, assistantMsg)

        try {
          await updateConversationMeta(conversationId, {})
        } catch {
          // 索引更新失败不影响主流程
        }
      }

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'complete',
          conversationId,
          model: modelId,
          messageId: content.trim() ? assistantMsgId : undefined,
        }),
      })
    } catch (error) {
      if (controller.signal.aborted) {
        console.log(`[聊天服务] 对话 ${conversationId} 已被用户中止`)

        if (accumulatedContent) {
          const assistantMsgId = randomUUID()
          const partialMsg: ChatMessage = {
            id: assistantMsgId,
            role: 'assistant',
            content: accumulatedContent,
            createdAt: Date.now(),
            model: modelId,
            reasoning: accumulatedReasoning || undefined,
            stopped: true,
          }
          await appendMessage(conversationId, partialMsg)

          await stream.writeSSE({
            data: JSON.stringify({
              type: 'complete',
              conversationId,
              model: modelId,
              messageId: assistantMsgId,
            }),
          })
        } else {
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'complete',
              conversationId,
              model: modelId,
            }),
          })
        }
        return
      }

      const errorMessage = error instanceof Error ? error.message : '未知错误'
      console.error(`[聊天服务] 流式请求失败:`, error)
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'error',
          conversationId,
          error: errorMessage,
        }),
      })
    } finally {
      activeControllers.delete(conversationId)
    }
  })
})

// 中止生成
app.post('/stop/:conversationId', async (c) => {
  const conversationId = c.req.param('conversationId')
  const controller = activeControllers.get(conversationId)
  if (controller) {
    controller.abort()
    activeControllers.delete(conversationId)
    console.log(`[聊天服务] 已中止对话: ${conversationId}`)
  }
  return c.json({ success: true })
})

// 生成标题
app.post('/generate-title', async (c) => {
  const input = await c.req.json<GenerateTitleInput>()
  const { userMessage, channelId, modelId } = input

  const channel = await getChannelById(channelId)
  if (!channel) {
    return c.json({ title: null })
  }

  let apiKey: string
  try {
    apiKey = await decryptApiKey(channelId)
  } catch {
    return c.json({ title: null })
  }

  try {
    const adapter = getAdapter(channel.provider)
    const TITLE_PROMPT = '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：'
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId,
      prompt: TITLE_PROMPT + userMessage,
    })

    const proxyUrl = await getEffectiveProxyUrl()
    const fetchFn = getFetchFn(proxyUrl)
    const { fetchTitle } = await import('@proma/core')
    const title = await fetchTitle(request, adapter, fetchFn)
    if (!title) return c.json({ title: null })

    const cleaned = title.trim().replace(/^["'""'']+|["'""'']+$/g, '').trim()
    return c.json({ title: cleaned.slice(0, 20) || null })
  } catch (error) {
    console.warn('[标题生成] 请求失败:', error)
    return c.json({ title: null })
  }
})

export default app
