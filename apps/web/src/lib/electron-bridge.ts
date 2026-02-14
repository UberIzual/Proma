/**
 * Electron API Bridge
 * Provides a compatible layer for web environment
 *
 * 将所有 window.electronAPI 方法映射到 HTTP/EventSource 调用
 *
 * 类型定义在 vite-env.d.ts 中
 */

import type {
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelTestResult,
  FetchModelsInput,
  FetchModelsResult,
  ConversationMeta,
  ChatMessage,
  ChatSendInput,
  GenerateTitleInput,
  StreamChunkEvent,
  StreamReasoningEvent,
  StreamCompleteEvent,
  StreamErrorEvent,
  AttachmentSaveInput,
  AttachmentSaveResult,
  FileDialogResult,
  RecentMessagesResult,
  AgentSessionMeta,
  AgentSendInput,
  AgentStreamEvent,
  AgentWorkspace,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSavedFile,
  AgentCopyFolderInput,
  WorkspaceMcpConfig,
  SkillMeta,
  WorkspaceCapabilities,
  FileEntry,
  EnvironmentCheckResult,
  ProxyConfig,
  SystemProxyDetectResult,
} from '@proma/shared'

// ===== 本地类型定义 =====

interface UserProfile {
  userName: string
  avatar: string
}

interface AppSettings {
  themeMode: 'light' | 'dark' | 'system'
  agentChannelId?: string
  agentModelId?: string
  agentWorkspaceId?: string
  onboardingCompleted?: boolean
  environmentCheckSkipped?: boolean
}

// ===== API 客户端 =====

// 使用 Vite 代理，直接访问 /api
const API_BASE = '/api'

/** 通用 fetch 封装 */
async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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

/** 活跃的 SSE 连接 */
const activeSSEConnections = new Map<string, EventSource>()

// ===== electronAPI 实现 =====

const electronAPI = {
  // ===== 运行时（Web 版本不支持，返回默认值） =====

  getRuntimeStatus: async () => {
    return null
  },

  getGitRepoStatus: async () => {
    return null
  },

  // ===== 通用工具 =====

  openExternal: async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },

  // ===== 模型供应商 =====

  listChannels: () => apiFetch<Channel[]>('/channels'),

  createChannel: (input: ChannelCreateInput) =>
    apiFetch<Channel>('/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateChannel: (id: string, input: ChannelUpdateInput) =>
    apiFetch<Channel>(`/channels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteChannel: async (id: string) => {
    await apiFetch<void>(`/channels/${id}`, { method: 'DELETE' })
  },

  decryptApiKey: async (channelId: string) => {
    const result = await apiFetch<{ apiKey: string }>(`/channels/${channelId}/key`)
    return result.apiKey
  },

  testChannel: (channelId: string) =>
    apiFetch<ChannelTestResult>(`/channels/${channelId}/test`, { method: 'POST' }),

  testChannelDirect: (input: FetchModelsInput) =>
    apiFetch<ChannelTestResult>('/channels/test-direct', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  fetchModels: (input: FetchModelsInput) =>
    apiFetch<FetchModelsResult>('/channels/fetch-models', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ===== 对话管理 =====

  listConversations: () => apiFetch<ConversationMeta[]>('/conversations'),

  createConversation: (title?: string, modelId?: string, channelId?: string) =>
    apiFetch<ConversationMeta>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ title, modelId, channelId }),
    }),

  getConversationMessages: (id: string) =>
    apiFetch<ChatMessage[]>(`/conversations/${id}/messages`),

  getRecentMessages: (id: string, limit: number) =>
    apiFetch<RecentMessagesResult>(`/conversations/${id}/messages/recent?limit=${limit}`),

  updateConversationTitle: (id: string, title: string) =>
    apiFetch<ConversationMeta>(`/conversations/${id}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  updateConversationModel: (id: string, modelId: string, channelId: string) =>
    apiFetch<ConversationMeta>(`/conversations/${id}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ modelId, channelId }),
    }),

  deleteConversation: async (id: string) => {
    await apiFetch<void>(`/conversations/${id}`, { method: 'DELETE' })
  },

  togglePinConversation: (id: string) =>
    apiFetch<ConversationMeta>(`/conversations/${id}/toggle-pin`, { method: 'POST' }),

  // ===== 消息发送（SSE 流式） =====

  sendMessage: async (input: ChatSendInput) => {
    // 使用 fetch 发送 POST 请求，手动处理 SSE 流
    const response = await fetch(`${API_BASE}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      throw new Error('发送消息失败')
    }

    // 手动处理 SSE 流
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    if (reader) {
      ;(async () => {
        let buffer = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              if (buffer.trim()) {
                console.log('[Chat SSE] 流结束，剩余 buffer:', buffer.slice(0, 100))
              }
              break
            }

            buffer += decoder.decode(value, { stream: true })

            // 按双换行符分割完整的 SSE 事件
            const events = buffer.split('\n\n')
            buffer = events.pop() || ''

            for (const eventBlock of events) {
              if (!eventBlock.trim()) continue

              const lines = eventBlock.split('\n')
              let eventData = ''

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  eventData = line.slice(6)
                }
              }

              if (eventData) {
                // 触发自定义事件
                window.dispatchEvent(
                  new CustomEvent('proma:sse-message', { detail: eventData }),
                )
              }
            }
          }
          console.log('[Chat SSE] 流处理完成')
        } catch (err) {
          console.error('[Chat SSE] 流处理错误:', err)
        }
      })()
    }
  },

  stopGeneration: async (conversationId: string) => {
    await apiFetch<void>(`/chat/stop/${conversationId}`, { method: 'POST' })
    activeSSEConnections.delete(conversationId)
  },

  deleteMessage: (conversationId: string, messageId: string) =>
    apiFetch<ChatMessage[]>(`/conversations/${conversationId}/messages/${messageId}`, {
      method: 'DELETE',
    }),

  truncateMessagesFrom: (
    conversationId: string,
    messageId: string,
    preserveFirstMessageAttachments?: boolean,
  ) =>
    apiFetch<ChatMessage[]>(`/conversations/${conversationId}/truncate`, {
      method: 'POST',
      body: JSON.stringify({ messageId, preserveFirstMessageAttachments }),
    }),

  updateContextDividers: (conversationId: string, dividers: string[]) =>
    apiFetch<ConversationMeta>(`/conversations/${conversationId}/context-dividers`, {
      method: 'POST',
      body: JSON.stringify({ dividers }),
    }),

  generateTitle: async (input: GenerateTitleInput) => {
    const result = await apiFetch<{ title: string | null }>('/chat/generate-title', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return result.title
  },

  // ===== 附件管理 =====

  saveAttachment: (input: AttachmentSaveInput) =>
    apiFetch<AttachmentSaveResult>('/attachments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  readAttachment: async (localPath: string) => {
    const result = await apiFetch<{ data: string }>(
      `/attachments?path=${encodeURIComponent(localPath)}`,
    )
    return result.data
  },

  deleteAttachment: async (localPath: string) => {
    await apiFetch<void>(`/attachments?path=${encodeURIComponent(localPath)}`, {
      method: 'DELETE',
    })
  },

  openFileDialog: async () => {
    // Web 版本使用原生 file input
    return new Promise<FileDialogResult>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = '.txt,.md,.json,.js,.ts,.jsx,.tsx,.py,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.rb,.php,.html,.css,.scss,.less,.xml,.yaml,.yml,.csv,.sql,.sh,.bash,.zsh,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp'

      input.onchange = async () => {
        const files = Array.from(input.files || [])
        if (files.length === 0) {
          resolve({ files: [] })
          return
        }

        // 读取文件内容
        const fileData = await Promise.all(
          files.map(
            (file) =>
              new Promise<{ filename: string; mediaType: string; data: string; size: number }>(
                (resolveFile) => {
                  const reader = new FileReader()
                  reader.onload = () => {
                    resolveFile({
                      filename: file.name,
                      mediaType: file.type || 'application/octet-stream',
                      data: (reader.result as string).split(',')[1], // 移除 data:xxx;base64, 前缀
                      size: file.size,
                    })
                  }
                  reader.onerror = () => {
                    resolveFile({
                      filename: file.name,
                      mediaType: file.type || 'application/octet-stream',
                      data: '',
                      size: 0,
                    })
                  }
                  reader.readAsDataURL(file)
                },
              ),
          ),
        )

        resolve({ files: fileData })
      }

      input.click()
    })
  },

  extractAttachmentText: async (localPath: string) => {
    const result = await apiFetch<{ text: string }>('/attachments/extract-text', {
      method: 'POST',
      body: JSON.stringify({ localPath }),
    })
    return result.text
  },

  // ===== 用户档案 =====

  getUserProfile: () => apiFetch<UserProfile>('/settings/profile'),

  updateUserProfile: (updates: Partial<UserProfile>) =>
    apiFetch<UserProfile>('/settings/profile', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  // ===== 应用设置 =====

  getSettings: () => apiFetch<AppSettings>('/settings/app'),

  updateSettings: (updates: Partial<AppSettings>) =>
    apiFetch<AppSettings>('/settings/app', {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  getSystemTheme: async () => {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  },

  onSystemThemeChanged: (callback: (isDark: boolean) => void) => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => callback(e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  },

  // ===== 环境检测（Web 版本模拟） =====

  checkEnvironment: async () => {
    // Web 版本不需要检测 Node.js/Git 环境
    // 使用 linux 作为默认平台（Web 版本）
    return {
      nodejs: {
        installed: true,
        version: '20.0.0',
        meetsMinimum: true,
        meetsRecommended: true,
        downloadUrl: 'https://nodejs.org/',
      },
      git: {
        installed: true,
        version: '2.0.0',
        meetsRequirement: true,
        downloadUrl: 'https://git-scm.com/',
      },
      platform: 'linux' as const,
      hasIssues: false,
      checkedAt: Date.now(),
    } satisfies EnvironmentCheckResult
  },

  // ===== 代理配置 =====

  getProxySettings: () => apiFetch<ProxyConfig>('/settings/proxy'),

  updateProxySettings: async (config: ProxyConfig) => {
    await apiFetch<void>('/settings/proxy', {
      method: 'PUT',
      body: JSON.stringify(config),
    })
  },

  detectSystemProxy: async () => {
    // Web 版本无法检测系统代理
    return {
      success: false,
      proxyUrl: undefined,
      message: 'Web 版本不支持系统代理检测',
    } satisfies SystemProxyDetectResult
  },

  // ===== 流式事件订阅（基于 window 事件） =====

  onStreamChunk: (callback: (event: StreamChunkEvent) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        if (data.type === 'chunk') {
          callback(data as StreamChunkEvent)
        }
      } catch {}
    }
    window.addEventListener('proma:sse-message', handler)
    return () => window.removeEventListener('proma:sse-message', handler)
  },

  onStreamReasoning: (callback: (event: StreamReasoningEvent) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        if (data.type === 'reasoning') {
          callback(data as StreamReasoningEvent)
        }
      } catch {}
    }
    window.addEventListener('proma:sse-message', handler)
    return () => window.removeEventListener('proma:sse-message', handler)
  },

  onStreamComplete: (callback: (event: StreamCompleteEvent) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        if (data.type === 'complete') {
          callback(data as StreamCompleteEvent)
        }
      } catch {}
    }
    window.addEventListener('proma:sse-message', handler)
    return () => window.removeEventListener('proma:sse-message', handler)
  },

  onStreamError: (callback: (event: StreamErrorEvent) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        if (data.type === 'error') {
          callback(data as StreamErrorEvent)
        }
      } catch {}
    }
    window.addEventListener('proma:sse-message', handler)
    return () => window.removeEventListener('proma:sse-message', handler)
  },

  // ===== Agent 会话管理 =====

  listAgentSessions: () => apiFetch<AgentSessionMeta[]>('/agent/sessions'),

  createAgentSession: (title?: string, channelId?: string, workspaceId?: string) =>
    apiFetch<AgentSessionMeta>('/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({ title, channelId, workspaceId }),
    }),

  getAgentSessionMessages: (id: string) =>
    apiFetch<import('@proma/shared').AgentMessage[]>(`/agent/sessions/${id}/messages`),

  updateAgentSessionTitle: (id: string, title: string) =>
    apiFetch<AgentSessionMeta>(`/agent/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteAgentSession: (id: string) =>
    apiFetch<void>(`/agent/sessions/${id}`, { method: 'DELETE' }),

  generateAgentTitle: async (input: AgentGenerateTitleInput) => {
    const result = await apiFetch<{ title: string | null }>('/agent/generate-title', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return result.title
  },

  sendAgentMessage: async (input: AgentSendInput) => {
    const response = await fetch(`${API_BASE}/agent/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      throw new Error('发送消息失败')
    }

    // 处理 SSE 流
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    if (reader) {
      ;(async () => {
        let buffer = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              // 关键修复：流结束时处理剩余 buffer
              if (buffer.trim()) {
                console.log('[Agent SSE] 流结束，处理剩余 buffer:', buffer.slice(0, 100))
                const lines = buffer.split('\n')
                let eventType = 'event'
                let eventData = ''
                for (const line of lines) {
                  if (line.startsWith('event: ')) eventType = line.slice(7).trim()
                  else if (line.startsWith('data: ')) eventData = line.slice(6)
                }
                if (eventData) {
                  console.log(`[Agent SSE] 最终事件: ${eventType}`)
                  window.dispatchEvent(
                    new CustomEvent(`proma:agent-sse:${eventType}`, { detail: eventData }),
                  )
                }
              }
              break
            }

            buffer += decoder.decode(value, { stream: true })

            // 按双换行符分割完整的 SSE 事件
            const events = buffer.split('\n\n')
            buffer = events.pop() || '' // 保留不完整的部分

            for (const eventBlock of events) {
              if (!eventBlock.trim()) continue

              const lines = eventBlock.split('\n')
              // 每个事件块重置 eventType 为默认值
              let eventType = 'event'
              let eventData = ''

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  eventType = line.slice(7).trim()
                } else if (line.startsWith('data: ')) {
                  eventData = line.slice(6)
                }
              }

              if (eventData) {
                console.log(`[Agent SSE] 收到事件: ${eventType}, data 长度: ${eventData.length}`)
                window.dispatchEvent(
                  new CustomEvent(`proma:agent-sse:${eventType}`, { detail: eventData }),
                )
              }
            }
          }
          console.log('[Agent SSE] 流处理完成')
        } catch (err) {
          console.error('[Agent SSE] 流处理错误:', err)
        }
      })()
    }
  },

  stopAgent: (sessionId: string) =>
    apiFetch<void>('/agent/stop', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),

  // ===== Agent 工作区管理 =====

  listAgentWorkspaces: () => apiFetch<AgentWorkspace[]>('/agent/workspaces'),

  createAgentWorkspace: (name: string) =>
    apiFetch<AgentWorkspace>('/agent/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  updateAgentWorkspace: (id: string, updates: { name: string }) =>
    apiFetch<AgentWorkspace>(`/agent/workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),

  deleteAgentWorkspace: (id: string) =>
    apiFetch<void>(`/agent/workspaces/${id}`, { method: 'DELETE' }),

  // ===== 工作区能力 =====

  getWorkspaceCapabilities: (workspaceSlug: string) =>
    apiFetch<WorkspaceCapabilities>(`/agent/workspaces/${workspaceSlug}/capabilities`),

  getWorkspaceMcpConfig: (workspaceSlug: string) =>
    apiFetch<WorkspaceMcpConfig>(`/agent/workspaces/${workspaceSlug}/mcp`),

  saveWorkspaceMcpConfig: (workspaceSlug: string, config: WorkspaceMcpConfig) =>
    apiFetch<void>(`/agent/workspaces/${workspaceSlug}/mcp`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  getWorkspaceSkills: (workspaceSlug: string) =>
    apiFetch<SkillMeta[]>(`/agent/workspaces/${workspaceSlug}/skills`),

  deleteWorkspaceSkill: (workspaceSlug: string, skillSlug: string) =>
    apiFetch<void>(`/agent/workspaces/${workspaceSlug}/skills/${skillSlug}`, { method: 'DELETE' }),

  // ===== Agent 流式事件 =====

  onAgentStreamEvent: (callback: (event: AgentStreamEvent) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        callback(data as AgentStreamEvent)
      } catch {}
    }
    window.addEventListener('proma:agent-sse:event', handler)
    return () => window.removeEventListener('proma:agent-sse:event', handler)
  },

  onAgentStreamComplete: (callback: (data: { sessionId: string }) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        callback(data)
      } catch {}
    }
    window.addEventListener('proma:agent-sse:complete', handler)
    return () => window.removeEventListener('proma:agent-sse:complete', handler)
  },

  onAgentStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        callback(data)
      } catch {}
    }
    window.addEventListener('proma:agent-sse:error', handler)
    return () => window.removeEventListener('proma:agent-sse:error', handler)
  },

  onAgentTitleUpdated: (callback: (data: { sessionId: string; title: string }) => void) => {
    const handler = (e: Event) => {
      try {
        const data = JSON.parse((e as CustomEvent).detail)
        callback(data)
      } catch {}
    }
    window.addEventListener('proma:agent-sse:title-updated', handler)
    return () => window.removeEventListener('proma:agent-sse:title-updated', handler)
  },

  onCapabilitiesChanged: (_callback: () => void) => () => {
    // Web 版本不支持文件监听，返回空 cleanup
  },
  onWorkspaceFilesChanged: (_callback: () => void) => () => {
    // Web 版本不支持文件监听，返回空 cleanup
  },

  // ===== Agent 附件 =====

  saveFilesToAgentSession: (input: AgentSaveFilesInput) =>
    apiFetch<AgentSavedFile[]>(`/agent/sessions/${input.sessionId}/files`, {
      method: 'POST',
      body: JSON.stringify({ workspaceSlug: input.workspaceSlug, files: input.files }),
    }),

  openFolderDialog: async () => {
    // Web 版本使用 webkitdirectory
    return new Promise<{ path: string; name: string } | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      if ('webkitdirectory' in input) {
        ;(input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
      }

      input.onchange = () => {
        const file = input.files?.[0]
        if (file) {
          const pathParts = file.webkitRelativePath.split('/')
          resolve({ path: pathParts[0], name: pathParts[0] })
        } else {
          resolve(null)
        }
      }

      input.click()
    })
  },

  copyFolderToSession: (input: AgentCopyFolderInput) =>
    apiFetch<AgentSavedFile[]>(`/agent/sessions/${input.sessionId}/folders`, {
      method: 'POST',
      body: JSON.stringify({ sourcePath: input.sourcePath, workspaceSlug: input.workspaceSlug }),
    }),

  // ===== Agent 文件系统（Web 版本受限） =====

  getAgentSessionPath: async (_workspaceId: string, _sessionId: string) => null,
  listDirectory: async (_dirPath: string) => [] as FileEntry[],
  deleteFile: async (_filePath: string) => {},
  openFile: async (_filePath: string) => {},
  showInFolder: async (_filePath: string) => {},

  // ===== 自动更新（Web 版本不可用） =====

  updater: undefined,
}

// ===== 全局注入 =====

// 注意：Window 接口的类型声明在 vite-env.d.ts 中
// 这里只负责运行时注入实现
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).electronAPI = electronAPI

console.log('[Electron Bridge] Web API 已初始化')
