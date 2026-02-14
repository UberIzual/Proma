/**
 * 应用设置服务
 *
 * 管理应用的全局设置（主题等）。
 * 数据持久化到 ~/.proma/settings.json。
 */

import { existsSync } from 'node:fs'
import { getSettingsPath } from '../lib/config-paths'

/**
 * 应用设置数据结构
 */
export interface AppSettings {
  /** 主题模式: light / dark / system */
  themeMode: 'light' | 'dark' | 'system'
  /** Agent 默认渠道 ID（仅限 Anthropic 渠道） */
  agentChannelId?: string
  /** Agent 默认模型 ID */
  agentModelId?: string
  /** Agent 当前工作区 ID */
  agentWorkspaceId?: string
  /** 是否已完成 Onboarding 流程 */
  onboardingCompleted?: boolean
  /** 是否跳过了环境检测 */
  environmentCheckSkipped?: boolean
}

/**
 * 默认设置
 */
const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'system',
}

/**
 * 获取应用设置
 */
export async function getSettings(): Promise<AppSettings> {
  const settingsPath = getSettingsPath()

  if (!existsSync(settingsPath)) {
    return DEFAULT_SETTINGS
  }

  try {
    const file = Bun.file(settingsPath)
    const settings = (await file.json()) as AppSettings
    return { ...DEFAULT_SETTINGS, ...settings }
  } catch (error) {
    console.error('[应用设置] 读取失败:', error)
    return DEFAULT_SETTINGS
  }
}

/**
 * 更新应用设置
 */
export async function updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings()
  const updated = { ...current, ...updates }

  const settingsPath = getSettingsPath()

  try {
    await Bun.write(settingsPath, JSON.stringify(updated, null, 2))
    console.log('[应用设置] 已更新:', updated)
    return updated
  } catch (error) {
    console.error('[应用设置] 保存失败:', error)
    throw new Error('保存应用设置失败')
  }
}
