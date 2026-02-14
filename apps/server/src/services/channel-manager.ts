/**
 * 渠道管理器
 *
 * 负责渠道的 CRUD 操作、API Key 加密/解密、连接测试。
 * 使用 Node.js crypto 模块进行 API Key 加密（替代 Electron safeStorage）。
 * 数据持久化到 ~/.proma/channels.json。
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getChannelsPath } from '../lib/config-paths'
import { encrypt, decrypt } from '../lib/encryption'
import type {
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelsConfig,
  ChannelTestResult,
  ChannelModel,
  FetchModelsInput,
  FetchModelsResult,
} from '@proma/shared'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'

/** 当前配置版本 */
const CONFIG_VERSION = 1

/** 默认渠道配置 */
const DEFAULT_CHANNEL = {
  name: '默认渠道',
  provider: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-7c0a244c5ec76d6341d47bcf4b86aee42bca1e0eae3dd8370eddf341209ae9a0',
  models: [
    { id: 'kimi-k.25', name: 'Kimi K.25', enabled: true },
    { id: 'glm-4.7', name: 'GLM-4.7', enabled: true },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', enabled: true },
    { id: 'glm-5', name: 'GLM-5', enabled: true },
    { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', enabled: true },
  ],
  enabled: true,
}

// ===== URL 规范化工具 =====

/**
 * 规范化 Anthropic Base URL
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '')
  if (!url.match(/\/v\d+$/)) {
    url = `${url}/v1`
  }
  return url
}

/**
 * 规范化通用 Base URL（去除尾部斜杠）
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 读取渠道配置文件
 */
async function readConfig(): Promise<ChannelsConfig> {
  const configPath = getChannelsPath()

  if (!existsSync(configPath)) {
    // 配置文件不存在时，创建默认渠道
    const now = Date.now()
    const defaultChannel = {
      id: randomUUID(),
      name: DEFAULT_CHANNEL.name,
      provider: DEFAULT_CHANNEL.provider,
      baseUrl: DEFAULT_CHANNEL.baseUrl,
      apiKey: encryptApiKey(DEFAULT_CHANNEL.apiKey),
      models: DEFAULT_CHANNEL.models,
      enabled: DEFAULT_CHANNEL.enabled,
      createdAt: now,
      updatedAt: now,
    }
    const initialConfig: ChannelsConfig = {
      version: CONFIG_VERSION,
      channels: [defaultChannel],
    }
    await writeConfig(initialConfig)
    console.log('[渠道管理] 已创建默认渠道')
    return initialConfig
  }

  try {
    const file = Bun.file(configPath)
    return (await file.json()) as ChannelsConfig
  } catch (error) {
    console.error('[渠道管理] 读取配置文件失败:', error)
    return { version: CONFIG_VERSION, channels: [] }
  }
}

/**
 * 写入渠道配置文件
 */
async function writeConfig(config: ChannelsConfig): Promise<void> {
  const configPath = getChannelsPath()

  try {
    await Bun.write(configPath, JSON.stringify(config, null, 2))
  } catch (error) {
    console.error('[渠道管理] 写入配置文件失败:', error)
    throw new Error('写入渠道配置失败')
  }
}

/**
 * 加密 API Key
 */
function encryptApiKey(plainKey: string): string {
  return encrypt(plainKey)
}

/**
 * 解密 API Key
 */
function decryptKey(encryptedKey: string): string {
  try {
    return decrypt(encryptedKey)
  } catch (error) {
    console.error('[渠道管理] 解密 API Key 失败:', error)
    throw new Error('解密 API Key 失败')
  }
}

/**
 * 获取所有渠道
 */
export async function listChannels(): Promise<Channel[]> {
  const config = await readConfig()
  return config.channels
}

/**
 * 按 ID 获取渠道
 */
export async function getChannelById(id: string): Promise<Channel | undefined> {
  const config = await readConfig()
  return config.channels.find((c) => c.id === id)
}

/**
 * 创建新渠道
 */
export async function createChannel(input: ChannelCreateInput): Promise<Channel> {
  const config = await readConfig()
  const now = Date.now()

  const channel: Channel = {
    id: randomUUID(),
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKey: encryptApiKey(input.apiKey),
    models: input.models,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  }

  config.channels.push(channel)
  await writeConfig(config)

  console.log(`[渠道管理] 已创建渠道: ${channel.name} (${channel.id})`)
  return channel
}

/**
 * 更新渠道
 */
export async function updateChannel(id: string, input: ChannelUpdateInput): Promise<Channel> {
  const config = await readConfig()
  const index = config.channels.findIndex((c) => c.id === id)

  if (index === -1) {
    throw new Error(`渠道不存在: ${id}`)
  }

  const existing = config.channels[index]

  const updated: Channel = {
    ...existing,
    name: input.name ?? existing.name,
    provider: input.provider ?? existing.provider,
    baseUrl: input.baseUrl ?? existing.baseUrl,
    apiKey: input.apiKey ? encryptApiKey(input.apiKey) : existing.apiKey,
    models: input.models ?? existing.models,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: Date.now(),
  }

  config.channels[index] = updated
  await writeConfig(config)

  console.log(`[渠道管理] 已更新渠道: ${updated.name} (${updated.id})`)
  return updated
}

/**
 * 删除渠道
 */
export async function deleteChannel(id: string): Promise<void> {
  const config = await readConfig()
  const index = config.channels.findIndex((c) => c.id === id)

  if (index === -1) {
    throw new Error(`渠道不存在: ${id}`)
  }

  const removed = config.channels.splice(index, 1)[0]
  await writeConfig(config)

  console.log(`[渠道管理] 已删除渠道: ${removed.name} (${removed.id})`)
}

/**
 * 解密渠道的 API Key
 */
export async function decryptApiKey(channelId: string): Promise<string> {
  const config = await readConfig()
  const channel = config.channels.find((c) => c.id === channelId)

  if (!channel) {
    throw new Error(`渠道不存在: ${channelId}`)
  }

  return decryptKey(channel.apiKey)
}

/**
 * 测试渠道连接
 */
export async function testChannel(channelId: string): Promise<ChannelTestResult> {
  const config = await readConfig()
  const channel = config.channels.find((c) => c.id === channelId)

  if (!channel) {
    return { success: false, message: '渠道不存在' }
  }

  const apiKey = decryptKey(channel.apiKey)
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (channel.provider) {
      case 'anthropic':
        return await testAnthropic(channel.baseUrl, apiKey, proxyUrl)
      case 'openai':
      case 'deepseek':
      case 'moonshot':
      case 'zhipu':
      case 'minimax':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await testOpenAICompatible(channel.baseUrl, apiKey, proxyUrl)
      case 'google':
        return await testGoogle(channel.baseUrl, apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的供应商: ${channel.provider}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return { success: false, message: `连接测试失败: ${message}` }
  }
}

/**
 * 测试 Anthropic API 连接
 */
async function testAnthropic(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<ChannelTestResult> {
  const url = normalizeAnthropicBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 401) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `API Key 无效${text ? `: ${text.slice(0, 150)}` : ''}` }
  }

  return { success: true, message: '连接成功' }
}

/**
 * 测试 OpenAI 兼容 API 连接
 */
async function testOpenAICompatible(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 401) {
    return { success: false, message: 'API Key 无效' }
  }

  const text = await response.text().catch(() => '')
  return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}` }
}

/**
 * 测试 Google Generative AI API 连接
 */
async function testGoogle(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<ChannelTestResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/v1beta/models?key=${apiKey}`, {
    method: 'GET',
  })

  if (response.ok) {
    return { success: true, message: '连接成功' }
  }

  if (response.status === 400 || response.status === 403) {
    return { success: false, message: 'API Key 无效' }
  }

  const text = await response.text().catch(() => '')
  return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}` }
}

/**
 * 直接测试连接（无需已保存渠道）
 */
export async function testChannelDirect(input: FetchModelsInput): Promise<ChannelTestResult> {
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (input.provider) {
      case 'anthropic':
        return await testAnthropic(input.baseUrl, input.apiKey, proxyUrl)
      case 'openai':
      case 'deepseek':
      case 'moonshot':
      case 'zhipu':
      case 'minimax':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await testOpenAICompatible(input.baseUrl, input.apiKey, proxyUrl)
      case 'google':
        return await testGoogle(input.baseUrl, input.apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的提供商: ${input.provider}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    return { success: false, message: `连接测试失败: ${message}` }
  }
}

/**
 * 从供应商 API 拉取可用模型列表
 */
export async function fetchModels(input: FetchModelsInput): Promise<FetchModelsResult> {
  const proxyUrl = await getEffectiveProxyUrl()

  try {
    switch (input.provider) {
      case 'anthropic':
        return await fetchAnthropicModels(input.baseUrl, input.apiKey, proxyUrl)
      case 'openai':
      case 'deepseek':
      case 'moonshot':
      case 'zhipu':
      case 'minimax':
      case 'doubao':
      case 'qwen':
      case 'custom':
        return await fetchOpenAICompatibleModels(input.baseUrl, input.apiKey, proxyUrl)
      case 'google':
        return await fetchGoogleModels(input.baseUrl, input.apiKey, proxyUrl)
      default:
        return { success: false, message: `不支持的供应商: ${input.provider}`, models: [] }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误'
    console.error('[渠道管理] 拉取模型列表失败:', error)
    return { success: false, message: `拉取模型失败: ${message}`, models: [] }
  }
}

interface AnthropicModelItem {
  id: string
  display_name?: string
  type?: string
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<FetchModelsResult> {
  const url = normalizeAnthropicBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
  })

  if (response.status === 401) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `API Key 无效${text ? `: ${text.slice(0, 150)}` : ''}`, models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = (await response.json()) as { data?: AnthropicModelItem[] }
  const items = data.data ?? []

  const models: ChannelModel[] = items.map((item) => ({
    id: item.id,
    name: item.display_name || item.id,
    enabled: true,
  }))

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}

interface OpenAIModelItem {
  id: string
  owned_by?: string
}

async function fetchOpenAICompatibleModels(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (response.status === 401) {
    return { success: false, message: 'API Key 无效', models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = (await response.json()) as { data?: OpenAIModelItem[] }
  const items = data.data ?? []

  const models: ChannelModel[] = items.map((item) => ({
    id: item.id,
    name: item.id,
    enabled: true,
  }))

  models.sort((a, b) => a.id.localeCompare(b.id))

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}

interface GoogleModelItem {
  name: string
  displayName?: string
  description?: string
  supportedGenerationMethods?: string[]
}

async function fetchGoogleModels(baseUrl: string, apiKey: string, proxyUrl?: string): Promise<FetchModelsResult> {
  const url = normalizeBaseUrl(baseUrl)
  const fetchFn = getFetchFn(proxyUrl)

  const response = await fetchFn(`${url}/v1beta/models?key=${apiKey}`, {
    method: 'GET',
  })

  if (response.status === 400 || response.status === 403) {
    return { success: false, message: 'API Key 无效', models: [] }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { success: false, message: `请求失败 (${response.status}): ${text.slice(0, 200)}`, models: [] }
  }

  const data = (await response.json()) as { models?: GoogleModelItem[] }
  const items = data.models ?? []

  const chatModels = items.filter((item) =>
    item.supportedGenerationMethods?.includes('generateContent')
  )

  const models: ChannelModel[] = chatModels.map((item) => {
    const id = item.name.replace(/^models\//, '')
    return {
      id,
      name: item.displayName || id,
      enabled: true,
    }
  })

  return {
    success: true,
    message: `成功获取 ${models.length} 个模型`,
    models,
  }
}
