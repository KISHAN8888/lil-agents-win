export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'copilot'
  | 'opencode'
  | 'openclaw'

export type CharacterSize = 'small' | 'medium' | 'large'

export type CharacterName = 'tuco' | 'kim'

export type ThemeName = 'midnight' | 'peach' | 'cloud' | 'moss'

export type TaskbarEdge = 'bottom' | 'top' | 'left' | 'right'

export interface TaskbarGeometry {
  edge: TaskbarEdge
  rect: { x: number; y: number; w: number; h: number }
  autoHide: boolean
  isVisible: boolean
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'error' | 'toolUse' | 'toolResult'
  text: string
}

export type SessionEvent =
  | { type: 'text'; chunk: string }
  | { type: 'error'; message: string }
  | { type: 'toolUse'; name: string; input: unknown }
  | { type: 'toolResult'; summary: string; isError: boolean }
  | { type: 'sessionReady' }
  | { type: 'turnComplete' }
  | { type: 'processExit' }

export interface HistoryEntry {
  role: 'user' | 'assistant'
  text: string
}

export interface CharacterConfig {
  provider: AgentProvider
  size: CharacterSize
  workDir?: string
  sessions: Partial<Record<AgentProvider, {
    sessionId?: string
    history: HistoryEntry[]
  }>>
}

export interface AppStore {
  tuco: CharacterConfig
  kim: CharacterConfig
  theme: ThemeName
  vaultPath?: string
  vaultMode: boolean
  hasCompletedOnboarding: boolean
  soundEnabled: boolean
  disableGpu: boolean
  openclaw: {
    url: string
    authToken: string
  }
}
