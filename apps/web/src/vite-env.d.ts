/// <reference types="vite/client" />

// CSS 模块类型声明
declare module '*.css' {
  const content: Record<string, string>
  export default content
}

/** 更新进度信息 */
interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}

/** 更新状态（与 updater-types.ts 保持一致） */
interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  progress?: UpdateProgress
  error?: string
}

/** 更新 API（可选，仅在 updater 模块存在时可用） */
interface UpdaterAPI {
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  getStatus: () => Promise<UpdateStatus>
  onStatusChanged: (callback: (status: UpdateStatus) => void) => () => void
}

/**
 * Web 版本 ElectronAPI 类型定义
 *
 * 与 Electron preload 保持相同的接口签名，
 * 但实现为 HTTP API 调用。
 */
interface ElectronAPI {
  // ===== 运行时相关 =====
  getRuntimeStatus: () => Promise<import('@proma/shared').RuntimeStatus | null>
  getGitRepoStatus: (dirPath: string) => Promise<import('@proma/shared').GitRepoStatus | null>

  // ===== 通用工具 =====
  openExternal: (url: string) => Promise<void>

  // ===== 模型供应商相关 =====
  listChannels: () => Promise<import('@proma/shared').Channel[]>
  createChannel: (input: import('@proma/shared').ChannelCreateInput) => Promise<import('@proma/shared').Channel>
  updateChannel: (id: string, input: import('@proma/shared').ChannelUpdateInput) => Promise<import('@proma/shared').Channel>
  deleteChannel: (id: string) => Promise<void>
  decryptApiKey: (channelId: string) => Promise<string>
  testChannel: (channelId: string) => Promise<import('@proma/shared').ChannelTestResult>
  testChannelDirect: (input: import('@proma/shared').FetchModelsInput) => Promise<import('@proma/shared').ChannelTestResult>
  fetchModels: (input: import('@proma/shared').FetchModelsInput) => Promise<import('@proma/shared').FetchModelsResult>

  // ===== 对话管理相关 =====
  listConversations: () => Promise<import('@proma/shared').ConversationMeta[]>
  createConversation: (title?: string, modelId?: string, channelId?: string) => Promise<import('@proma/shared').ConversationMeta>
  getConversationMessages: (id: string) => Promise<import('@proma/shared').ChatMessage[]>
  getRecentMessages: (id: string, limit: number) => Promise<import('@proma/shared').RecentMessagesResult>
  updateConversationTitle: (id: string, title: string) => Promise<import('@proma/shared').ConversationMeta>
  updateConversationModel: (id: string, modelId: string, channelId: string) => Promise<import('@proma/shared').ConversationMeta>
  deleteConversation: (id: string) => Promise<void>
  togglePinConversation: (id: string) => Promise<import('@proma/shared').ConversationMeta>

  // ===== 消息发送 =====
  sendMessage: (input: import('@proma/shared').ChatSendInput) => Promise<void>
  stopGeneration: (conversationId: string) => Promise<void>
  deleteMessage: (conversationId: string, messageId: string) => Promise<import('@proma/shared').ChatMessage[]>
  truncateMessagesFrom: (conversationId: string, messageId: string, preserveFirstMessageAttachments?: boolean) => Promise<import('@proma/shared').ChatMessage[]>
  updateContextDividers: (conversationId: string, dividers: string[]) => Promise<import('@proma/shared').ConversationMeta>
  generateTitle: (input: import('@proma/shared').GenerateTitleInput) => Promise<string | null>

  // ===== 附件管理相关 =====
  saveAttachment: (input: import('@proma/shared').AttachmentSaveInput) => Promise<import('@proma/shared').AttachmentSaveResult>
  readAttachment: (localPath: string) => Promise<string>
  deleteAttachment: (localPath: string) => Promise<void>
  openFileDialog: () => Promise<import('@proma/shared').FileDialogResult>
  extractAttachmentText: (localPath: string) => Promise<string>

  // ===== 用户档案相关 =====
  getUserProfile: () => Promise<import('./types').UserProfile>
  updateUserProfile: (updates: Partial<import('./types').UserProfile>) => Promise<import('./types').UserProfile>

  // ===== 应用设置相关 =====
  getSettings: () => Promise<import('./types').AppSettings>
  updateSettings: (updates: Partial<import('./types').AppSettings>) => Promise<import('./types').AppSettings>
  getSystemTheme: () => Promise<boolean>
  onSystemThemeChanged: (callback: (isDark: boolean) => void) => () => void

  // ===== 环境检测相关 =====
  checkEnvironment: () => Promise<import('@proma/shared').EnvironmentCheckResult>

  // ===== 代理配置相关 =====
  getProxySettings: () => Promise<import('@proma/shared').ProxyConfig>
  updateProxySettings: (config: import('@proma/shared').ProxyConfig) => Promise<void>
  detectSystemProxy: () => Promise<import('@proma/shared').SystemProxyDetectResult>

  // ===== 流式事件订阅 =====
  onStreamChunk: (callback: (event: import('@proma/shared').StreamChunkEvent) => void) => () => void
  onStreamReasoning: (callback: (event: import('@proma/shared').StreamReasoningEvent) => void) => () => void
  onStreamComplete: (callback: (event: import('@proma/shared').StreamCompleteEvent) => void) => () => void
  onStreamError: (callback: (event: import('@proma/shared').StreamErrorEvent) => void) => () => void

  // ===== Agent 会话管理相关 =====
  listAgentSessions: () => Promise<import('@proma/shared').AgentSessionMeta[]>
  createAgentSession: (title?: string, channelId?: string, workspaceId?: string) => Promise<import('@proma/shared').AgentSessionMeta>
  getAgentSessionMessages: (id: string) => Promise<import('@proma/shared').AgentMessage[]>
  updateAgentSessionTitle: (id: string, title: string) => Promise<import('@proma/shared').AgentSessionMeta>
  deleteAgentSession: (id: string) => Promise<void>
  generateAgentTitle: (input: import('@proma/shared').AgentGenerateTitleInput) => Promise<string | null>
  sendAgentMessage: (input: import('@proma/shared').AgentSendInput) => Promise<void>
  stopAgent: (sessionId: string) => Promise<void>

  // ===== Agent 工作区管理相关 =====
  listAgentWorkspaces: () => Promise<import('@proma/shared').AgentWorkspace[]>
  createAgentWorkspace: (name: string) => Promise<import('@proma/shared').AgentWorkspace>
  updateAgentWorkspace: (id: string, updates: { name: string }) => Promise<import('@proma/shared').AgentWorkspace>
  deleteAgentWorkspace: (id: string) => Promise<void>

  // ===== 工作区能力（MCP + Skill） =====
  getWorkspaceCapabilities: (workspaceSlug: string) => Promise<import('@proma/shared').WorkspaceCapabilities>
  getWorkspaceMcpConfig: (workspaceSlug: string) => Promise<import('@proma/shared').WorkspaceMcpConfig>
  saveWorkspaceMcpConfig: (workspaceSlug: string, config: import('@proma/shared').WorkspaceMcpConfig) => Promise<void>
  getWorkspaceSkills: (workspaceSlug: string) => Promise<import('@proma/shared').SkillMeta[]>
  deleteWorkspaceSkill: (workspaceSlug: string, skillSlug: string) => Promise<void>

  // ===== Agent 流式事件 =====
  onAgentStreamEvent: (callback: (event: import('@proma/shared').AgentStreamEvent) => void) => () => void
  onAgentStreamComplete: (callback: (data: { sessionId: string }) => void) => () => void
  onAgentStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void
  onAgentTitleUpdated: (callback: (data: { sessionId: string; title: string }) => void) => () => void
  onCapabilitiesChanged: (callback: () => void) => () => void
  onWorkspaceFilesChanged: (callback: () => void) => () => void

  // ===== Agent 附件 =====
  saveFilesToAgentSession: (input: import('@proma/shared').AgentSaveFilesInput) => Promise<import('@proma/shared').AgentSavedFile[]>
  openFolderDialog: () => Promise<{ path: string; name: string } | null>
  copyFolderToSession: (input: import('@proma/shared').AgentCopyFolderInput) => Promise<import('@proma/shared').AgentSavedFile[]>

  // ===== Agent 文件系统操作 =====
  getAgentSessionPath: (workspaceId: string, sessionId: string) => Promise<string | null>
  listDirectory: (dirPath: string) => Promise<import('@proma/shared').FileEntry[]>
  deleteFile: (filePath: string) => Promise<void>
  openFile: (filePath: string) => Promise<void>
  showInFolder: (filePath: string) => Promise<void>

  // ===== 自动更新相关（可选） =====
  updater?: UpdaterAPI
}

// 扩展 Window 接口
interface Window {
  electronAPI: ElectronAPI
  __pendingAttachmentData?: Map<string, string>
  __pendingAgentFileData?: Map<string, string>
}
