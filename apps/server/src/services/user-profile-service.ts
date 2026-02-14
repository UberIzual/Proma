/**
 * 用户档案服务
 *
 * 管理用户的个人信息（姓名、头像等）。
 * 数据持久化到 ~/.proma/user-profile.json。
 */

import { existsSync } from 'node:fs'
import { getUserProfilePath } from '../lib/config-paths'

/**
 * 用户档案数据结构
 */
export interface UserProfile {
  /** 用户名称 */
  userName: string
  /** 头像（base64 或 URL） */
  avatar?: string
}

/**
 * 默认用户档案
 */
const DEFAULT_PROFILE: UserProfile = {
  userName: '用户',
}

/**
 * 获取用户档案
 */
export async function getUserProfile(): Promise<UserProfile> {
  const profilePath = getUserProfilePath()

  if (!existsSync(profilePath)) {
    return DEFAULT_PROFILE
  }

  try {
    const file = Bun.file(profilePath)
    const profile = (await file.json()) as UserProfile
    return { ...DEFAULT_PROFILE, ...profile }
  } catch (error) {
    console.error('[用户档案] 读取失败:', error)
    return DEFAULT_PROFILE
  }
}

/**
 * 更新用户档案
 */
export async function updateUserProfile(updates: Partial<UserProfile>): Promise<UserProfile> {
  const current = await getUserProfile()
  const updated = { ...current, ...updates }

  const profilePath = getUserProfilePath()

  try {
    await Bun.write(profilePath, JSON.stringify(updated, null, 2))
    console.log('[用户档案] 已更新:', updated)
    return updated
  } catch (error) {
    console.error('[用户档案] 保存失败:', error)
    throw new Error('保存用户档案失败')
  }
}
