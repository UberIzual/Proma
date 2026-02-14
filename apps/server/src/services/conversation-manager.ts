/**
 * 对话管理器
 *
 * 负责对话的 CRUD 操作和消息持久化。
 * - 对话索引：~/.proma/conversations.json（轻量元数据）
 * - 消息存储：~/.proma/conversations/{id}.jsonl（JSONL 格式，逐行追加）
 */

import { existsSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  getConversationsIndexPath,
  getConversationsDir,
  getConversationMessagesPath,
} from '../lib/config-paths'
import type { ConversationMeta, ChatMessage, RecentMessagesResult } from '@proma/shared'

/**
 * 对话索引文件格式
 */
interface ConversationsIndex {
  /** 配置版本号 */
  version: number
  /** 对话元数据列表 */
  conversations: ConversationMeta[]
}

/** 当前索引版本 */
const INDEX_VERSION = 1

/**
 * 读取对话索引文件
 */
async function readIndex(): Promise<ConversationsIndex> {
  const indexPath = getConversationsIndexPath()

  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, conversations: [] }
  }

  try {
    const file = Bun.file(indexPath)
    return (await file.json()) as ConversationsIndex
  } catch (error) {
    console.error('[对话管理] 读取索引文件失败:', error)
    return { version: INDEX_VERSION, conversations: [] }
  }
}

/**
 * 写入对话索引文件
 */
async function writeIndex(index: ConversationsIndex): Promise<void> {
  const indexPath = getConversationsIndexPath()

  try {
    await Bun.write(indexPath, JSON.stringify(index, null, 2))
  } catch (error) {
    console.error('[对话管理] 写入索引文件失败:', error)
    throw new Error('写入对话索引失败')
  }
}

/**
 * 获取所有对话（按 updatedAt 降序）
 */
export async function listConversations(): Promise<ConversationMeta[]> {
  const index = await readIndex()
  return index.conversations.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 创建新对话
 */
export async function createConversation(
  title?: string,
  modelId?: string,
  channelId?: string,
): Promise<ConversationMeta> {
  const index = await readIndex()
  const now = Date.now()

  const meta: ConversationMeta = {
    id: randomUUID(),
    title: title || '新对话',
    modelId,
    channelId,
    createdAt: now,
    updatedAt: now,
  }

  index.conversations.push(meta)
  await writeIndex(index)

  // 确保消息目录存在
  getConversationsDir()

  console.log(`[对话管理] 已创建对话: ${meta.title} (${meta.id})`)
  return meta
}

/**
 * 读取对话的所有消息
 */
export async function getConversationMessages(id: string): Promise<ChatMessage[]> {
  const filePath = getConversationMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const file = Bun.file(filePath)
    const raw = await file.text()
    const lines = raw.split('\n').filter((line) => line.trim())

    return lines.map((line) => JSON.parse(line) as ChatMessage)
  } catch (error) {
    console.error(`[对话管理] 读取消息失败 (${id}):`, error)
    return []
  }
}

/**
 * 读取对话的最近 N 条消息（从尾部读取）
 */
export async function getRecentMessages(id: string, limit: number): Promise<RecentMessagesResult> {
  const filePath = getConversationMessagesPath(id)

  if (!existsSync(filePath)) {
    return { messages: [], total: 0, hasMore: false }
  }

  try {
    const file = Bun.file(filePath)
    const raw = await file.text()
    const lines = raw.split('\n').filter((line) => line.trim())
    const total = lines.length

    if (total <= limit) {
      const messages = lines.map((line) => JSON.parse(line) as ChatMessage)
      return { messages, total, hasMore: false }
    }

    const recentLines = lines.slice(-limit)
    const messages = recentLines.map((line) => JSON.parse(line) as ChatMessage)
    return { messages, total, hasMore: true }
  } catch (error) {
    console.error(`[对话管理] 读取最近消息失败 (${id}):`, error)
    return { messages: [], total: 0, hasMore: false }
  }
}

/**
 * 追加一条消息到对话的 JSONL 文件
 */
export async function appendMessage(id: string, message: ChatMessage): Promise<void> {
  const filePath = getConversationMessagesPath(id)

  try {
    // 读取现有内容
    let existingContent = ''
    if (existsSync(filePath)) {
      const file = Bun.file(filePath)
      existingContent = await file.text()
    }

    const line = JSON.stringify(message) + '\n'
    await Bun.write(filePath, existingContent + line)
  } catch (error) {
    console.error(`[对话管理] 追加消息失败 (${id}):`, error)
    throw new Error('追加消息失败')
  }
}

/**
 * 全量覆写对话消息
 */
export async function saveConversationMessages(id: string, messages: ChatMessage[]): Promise<void> {
  const filePath = getConversationMessagesPath(id)

  try {
    const content = messages.map((msg) => JSON.stringify(msg)).join('\n') + (messages.length > 0 ? '\n' : '')
    await Bun.write(filePath, content)
  } catch (error) {
    console.error(`[对话管理] 保存消息失败 (${id}):`, error)
    throw new Error('保存消息失败')
  }
}

/**
 * 更新对话元数据
 */
export async function updateConversationMeta(
  id: string,
  updates: Partial<Pick<ConversationMeta, 'title' | 'modelId' | 'channelId' | 'contextDividers' | 'contextLength' | 'pinned'>>,
): Promise<ConversationMeta> {
  const index = await readIndex()
  const idx = index.conversations.findIndex((c) => c.id === id)

  if (idx === -1) {
    throw new Error(`对话不存在: ${id}`)
  }

  const existing = index.conversations[idx]
  const updated: ConversationMeta = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  }

  index.conversations[idx] = updated
  await writeIndex(index)

  console.log(`[对话管理] 已更新对话: ${updated.title} (${updated.id})`)
  return updated
}

/**
 * 删除对话
 */
export async function deleteConversation(id: string): Promise<void> {
  const index = await readIndex()
  const idx = index.conversations.findIndex((c) => c.id === id)

  if (idx === -1) {
    throw new Error(`对话不存在: ${id}`)
  }

  const removed = index.conversations.splice(idx, 1)[0]
  await writeIndex(index)

  // 删除消息文件
  const filePath = getConversationMessagesPath(id)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.warn(`[对话管理] 删除消息文件失败 (${id}):`, error)
    }
  }

  console.log(`[对话管理] 已删除对话: ${removed.title} (${removed.id})`)
}

/**
 * 删除指定消息
 */
export async function deleteMessage(conversationId: string, messageId: string): Promise<ChatMessage[]> {
  const messages = await getConversationMessages(conversationId)
  const filtered = messages.filter((msg) => msg.id !== messageId)

  if (filtered.length === messages.length) {
    console.warn(`[对话管理] 消息不存在: ${messageId}`)
    return messages
  }

  await saveConversationMessages(conversationId, filtered)
  console.log(`[对话管理] 已删除消息: ${messageId} (对话 ${conversationId})`)
  return filtered
}

/**
 * 从指定消息开始截断对话（包含该消息）
 */
export async function truncateMessagesFrom(
  conversationId: string,
  messageId: string,
  preserveFirstMessageAttachments = false,
): Promise<ChatMessage[]> {
  const messages = await getConversationMessages(conversationId)
  const startIndex = messages.findIndex((msg) => msg.id === messageId)

  if (startIndex === -1) {
    console.warn(`[对话管理] 截断起点消息不存在: ${messageId}`)
    return messages
  }

  const kept = messages.slice(0, startIndex)

  await saveConversationMessages(conversationId, kept)
  console.log(`[对话管理] 已从消息截断: ${messageId} (对话 ${conversationId})`)
  return kept
}

/**
 * 更新对话的上下文分隔线
 */
export async function updateContextDividers(conversationId: string, dividers: string[]): Promise<ConversationMeta> {
  return updateConversationMeta(conversationId, { contextDividers: dividers })
}
