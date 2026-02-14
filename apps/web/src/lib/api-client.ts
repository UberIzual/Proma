/**
 * API 客户端
 *
 * 封装 HTTP API 调用，提供与 Electron preload 相同的接口。
 * 所有 React 组件通过 window.electronAPI 访问，无需修改。
 */

const API_BASE = '/api'

// ===== 工具函数 =====

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: '请求失败' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }
  return response.json()
}

// ===== SSE 订阅管理 =====

interface SSECallbacks {
  onChunk?: (data: { conversationId: string; delta: string }) => void
  onReasoning?: (data: { conversationId: string; delta: string }) => void
  onComplete?: (data: { conversationId: string; model?: string; messageId?: string }) => void
  onError?: (data: { conversationId: string; error: string }) => void
  onAgentEvent?: (data: { sessionId: string; event: unknown }) => void
  onAgentComplete?: (data: { sessionId: string }) => void
  onAgentError?: (data: { sessionId: string; error: string }) => void
}

const sseCallbacks: SSECallbacks = {}

// ===== ElectronAPI 兼容层 =====

export const apiClient = {
  // ===== 模型供应商 =====
  listChannels: () => fetchJson<unknown[]>(`${API_BASE}/channels`),
  createChannel: (input: unknown) => fetchJson<unknown>(`${API_BASE}/channels`, { method: 'POST', body: JSON.stringify(input) }),
  updateChannel: (id: string, input: unknown) => fetchJson<unknown>(`${API_BASE}/channels/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteChannel: (id: string) => fetchJson<void>(`${API_BASE}/channels/${id}`, { method: 'DELETE' }),
  decryptApiKey: (id: string) => fetchJson<{ apiKey: string }>(`${API_BASE}/channels/${id}/key`).then((r) => r.apiKey),
  testChannel: (id: string) => fetchJson<unknown>(`${API_BASE}/channels/${id}/test`, { method: 'POST' }),
  testChannelDirect: (input: unknown) => fetchJson<unknown>(`${API_BASE}/channels/test-direct`, { method: 'POST', body: JSON.stringify(input) }),
  fetchModels: (input: unknown) => fetchJson<unknown>(`${API_BASE}/channels/fetch-models`, { method: 'POST', body: JSON.stringify(input) }),

  // ===== 对话管理 =====
  listConversations: () => fetchJson<unknown[]>(`${API_BASE}/conversations`),
  createConversation: (title?: string, modelId?: string, channelId?: string) =>
    fetchJson<unknown>(`${API_BASE}/conversations`, { method: 'POST', body: JSON.stringify({ title, modelId, channelId }) }),
  getConversationMessages: (id: string) => fetchJson<unknown[]>(`${API_BASE}/conversations/${id}/messages`),
  getRecentMessages: (id: string, limit: number) => fetchJson<unknown>(`${API_BASE}/conversations/${id}/messages/recent?limit=${limit}`),
  updateConversationTitle: (id: string, title: string) =>
    fetchJson<unknown>(`${API_BASE}/conversations/${id}/title`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  updateConversationModel: (id: string, modelId: string, channelId: string) =>
    fetchJson<unknown>(`${API_BASE}/conversations/${id}/model`, { method: 'PATCH', body: JSON.stringify({ modelId, channelId }) }),
  deleteConversation: (id: string) => fetchJson<void>(`${API_BASE}/conversations/${id}`, { method: 'DELETE' }),
  togglePinConversation: (id: string) => fetchJson<unknown>(`${API_BASE}/conversations/${id}/toggle-pin`, { method: 'POST' }),
  deleteMessage: (conversationId: string, messageId: string) =>
    fetchJson<unknown[]>(`${API_BASE}/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' }),
  truncateMessagesFrom: (conversationId: string, messageId: string, preserveFirstMessageAttachments?: boolean) =>
    fetchJson<unknown[]>(`${API_BASE}/conversations/${conversationId}/truncate`, {
      method: 'POST',
      body: JSON.stringify({ messageId, preserveFirstMessageAttachments }),
    }),
  updateContextDividers: (conversationId: string, dividers: string[]) =>
    fetchJson<unknown>(`${API_BASE}/conversations/${conversationId}/context-dividers`, { method: 'POST', body: JSON.stringify({ dividers }) }),

  // ===== 聊天 =====
  sendMessage: async (input: unknown) => {
    const response = await fetch(`${API_BASE}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) {
      throw new Error('发送消息失败')
    }
    const reader = response.body?.getReader()
    if (reader) {
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              switch (data.type) {
                case 'chunk':
                  sseCallbacks.onChunk?.(data)
                  break
                case 'reasoning':
                  sseCallbacks.onReasoning?.(data)
                  break
                case 'complete':
                  sseCallbacks.onComplete?.(data)
                  break
                case 'error':
                  sseCallbacks.onError?.(data)
                  break
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    }
  },
  stopGeneration: (conversationId: string) =>
    fetchJson<void>(`${API_BASE}/chat/stop/${conversationId}`, { method: 'POST' }),
  generateTitle: (input: unknown) =>
    fetchJson<{ title: string | null }>(`${API_BASE}/chat/generate-title`, { method: 'POST', body: JSON.stringify(input) }).then((r) => r.title),

  // ===== 附件 =====
  saveAttachment: (input: unknown) => fetchJson<unknown>(`${API_BASE}/attachments`, { method: 'POST', body: JSON.stringify(input) }),
  readAttachment: (localPath: string) =>
    fetchJson<{ data: string }>(`${API_BASE}/attachments?path=${encodeURIComponent(localPath)}`).then((r) => r.data),
  deleteAttachment: (localPath: string) =>
    fetchJson<void>(`${API_BASE}/attachments?path=${encodeURIComponent(localPath)}`, { method: 'DELETE' }),
  extractAttachmentText: (localPath: string) =>
    fetchJson<{ text: string }>(`${API_BASE}/attachments/extract-text`, { method: 'POST', body: JSON.stringify({ localPath }) }).then((r) => r.text),

  // Web 版本：文件选择使用原生 HTML5
  openFileDialog: async () => {
    return new Promise<{ files: Array<{ filename: string; mediaType: string; data: string; size: number }> }>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.json,.csv,.xml,.html,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.odp,.ods'
      input.onchange = async () => {
        if (!input.files?.length) {
          resolve({ files: [] })
          return
        }
        const files = await Promise.all(
          Array.from(input.files).map((file) => {
            return new Promise<{ filename: string; mediaType: string; data: string; size: number }>((resolveFile) => {
              const reader = new FileReader()
              reader.onload = () => {
                const data = (reader.result as string).split(',')[1]
                resolveFile({
                  filename: file.name,
                  mediaType: file.type,
                  data,
                  size: file.size,
                })
              }
              reader.readAsDataURL(file)
            })
          })
        )
        resolve({ files })
      }
      input.click()
    })
  },

  // ===== 用户档案 =====
  getUserProfile: () => fetchJson<unknown>(`${API_BASE}/settings/profile`),
  updateUserProfile: (updates: unknown) =>
    fetchJson<unknown>(`${API_BASE}/settings/profile`, { method: 'PATCH', body: JSON.stringify(updates) }),

  // ===== 应用设置 =====
  getSettings: () => fetchJson<unknown>(`${API_BASE}/settings/app`),
  updateSettings: (updates: unknown) =>
    fetchJson<unknown>(`${API_BASE}/settings/app`, { method: 'PATCH', body: JSON.stringify(updates) }),

  // Web 版本：系统主题通过 CSS 媒体查询检测
  getSystemTheme: async () => {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  },
  onSystemThemeChanged: (callback: (isDark: boolean) => void) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => callback(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  },

  // ===== 代理设置 =====
  getProxySettings: () => fetchJson<unknown>(`${API_BASE}/settings/proxy`),
  updateProxySettings: (config: unknown) =>
    fetchJson<void>(`${API_BASE}/settings/proxy`, { method: 'PUT', body: JSON.stringify(config) }),
  detectSystemProxy: async () => ({ success: false, message: 'Web 版本暂不支持系统代理检测', proxyUrl: null }),

  // ===== 运行时状态（Web 版本简化） =====
  getRuntimeStatus: async () => ({
    bun: { installed: true, version: 'web', path: 'bun' },
    git: { installed: true, version: 'web' },
  }),
  getGitRepoStatus: async () => null,

  // ===== 环境检测 =====
  checkEnvironment: async () => ({
    bun: { installed: true, version: 'web' },
    git: { installed: true, version: 'web' },
  }),

  // ===== 通用工具 =====
  openExternal: (url: string) => {
    window.open(url, '_blank')
    return Promise.resolve()
  },

  // ===== 流式事件订阅 =====
  onStreamChunk: (callback: (event: { conversationId: string; delta: string }) => void) => {
    sseCallbacks.onChunk = callback
    return () => { sseCallbacks.onChunk = undefined }
  },
  onStreamReasoning: (callback: (event: { conversationId: string; delta: string }) => void) => {
    sseCallbacks.onReasoning = callback
    return () => { sseCallbacks.onReasoning = undefined }
  },
  onStreamComplete: (callback: (event: { conversationId: string; model?: string; messageId?: string }) => void) => {
    sseCallbacks.onComplete = callback
    return () => { sseCallbacks.onComplete = undefined }
  },
  onStreamError: (callback: (event: { conversationId: string; error: string }) => void) => {
    sseCallbacks.onError = callback
    return () => { sseCallbacks.onError = undefined }
  },

  // ===== Agent 相关（Web 版本暂不支持，返回空实现） =====
  listAgentSessions: async () => [],
  createAgentSession: async () => ({ id: 'web-placeholder', title: 'Web 版本暂不支持 Agent', createdAt: Date.now(), updatedAt: Date.now() }),
  getAgentSessionMessages: async () => [],
  updateAgentSessionTitle: async () => ({ id: 'web-placeholder', title: '', createdAt: 0, updatedAt: 0 }),
  deleteAgentSession: async () => {},
  generateAgentTitle: async () => null,
  sendAgentMessage: async () => { throw new Error('Web 版本暂不支持 Agent 功能') },
  stopAgent: async () => {},
  listAgentWorkspaces: async () => [],
  createAgentWorkspace: async () => ({ id: 'web-placeholder', name: '', slug: 'web-placeholder', createdAt: 0 }),
  updateAgentWorkspace: async () => ({ id: 'web-placeholder', name: '', slug: 'web-placeholder', createdAt: 0 }),
  deleteAgentWorkspace: async () => {},
  getWorkspaceCapabilities: async () => ({ mcpServers: [], skills: [] }),
  getWorkspaceMcpConfig: async () => ({ servers: {} }),
  saveWorkspaceMcpConfig: async () => {},
  getWorkspaceSkills: async () => [],
  deleteWorkspaceSkill: async () => {},
  onAgentStreamEvent: () => () => {},
  onAgentStreamComplete: () => () => {},
  onAgentStreamError: () => () => {},
  onAgentTitleUpdated: () => () => {},
  onCapabilitiesChanged: () => () => {},
  onWorkspaceFilesChanged: () => () => {},
  saveFilesToAgentSession: async () => [],
  openFolderDialog: async () => null,
  copyFolderToSession: async () => [],
  getAgentSessionPath: async () => null,
  listDirectory: async () => [],
  deleteFile: async () => {},
  openFile: async () => {},
  showInFolder: async () => {},
}
