/**
 * Proma Web Backend Server
 * Hono + Bun runtime
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import channelsRoute from './routes/channels'
import conversationsRoute from './routes/conversations'
import settingsRoute from './routes/settings'
import chatRoute from './routes/chat'
import attachmentsRoute from './routes/attachments'
import agentRoute from './routes/agent'

const app = new Hono()

// Middleware
app.use(logger())
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowHeaders: ['Content-Type'],
  credentials: true,
}))

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'proma-server' }))
app.get('/health', (c) => c.json({ status: 'ok', service: 'proma-server' }))

// 注册 API 路由
app.route('/api/channels', channelsRoute)
app.route('/api/conversations', conversationsRoute)
app.route('/api/settings', settingsRoute)
app.route('/api/chat', chatRoute)
app.route('/api/attachments', attachmentsRoute)
app.route('/api/agent', agentRoute)

const port = parseInt(process.env.PORT || '3001')

console.log(`[Proma Server] Starting on port ${port}`)

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255, // Bun 最大允许值（秒），防止 SSE 长连接被过早断开
}
