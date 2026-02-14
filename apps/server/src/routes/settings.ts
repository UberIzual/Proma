/**
 * 设置相关路由
 */

import { Hono } from 'hono'
import { getSettings, updateSettings } from '../services/settings-service'
import { getUserProfile, updateUserProfile } from '../services/user-profile-service'
import { getProxySettings, saveProxySettings } from '../services/proxy-settings-service'
import type { ProxyConfig } from '@proma/shared'
import type { AppSettings } from '../services/settings-service'
import type { UserProfile } from '../services/user-profile-service'

const app = new Hono()

// ===== 用户档案 =====

app.get('/profile', async (c) => {
  const profile = await getUserProfile()
  return c.json(profile)
})

app.patch('/profile', async (c) => {
  const updates = await c.req.json<Partial<UserProfile>>()
  const profile = await updateUserProfile(updates)
  return c.json(profile)
})

// ===== 应用设置 =====

app.get('/app', async (c) => {
  const settings = await getSettings()
  return c.json(settings)
})

app.patch('/app', async (c) => {
  const updates = await c.req.json<Partial<AppSettings>>()
  const settings = await updateSettings(updates)
  return c.json(settings)
})

// ===== 代理设置 =====

app.get('/proxy', async (c) => {
  const settings = await getProxySettings()
  return c.json(settings)
})

app.put('/proxy', async (c) => {
  const config = await c.req.json<ProxyConfig>()
  await saveProxySettings(config)
  return c.json({ success: true })
})

export default app
