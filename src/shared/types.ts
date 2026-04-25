export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'copilot'
  | 'opencode'
  | 'openclaw'

export type CharacterSize = 'small' | 'medium' | 'large'

export type CharacterName = 'bruce' | 'jazz'

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

export interface CharacterConfig {
  provider: AgentProvider
  size: CharacterSize
}

export interface AppStore {
  bruce: CharacterConfig
  jazz: CharacterConfig
  theme: ThemeName
  hasCompletedOnboarding: boolean
  soundEnabled: boolean
  disableGpu: boolean
  openclaw: {
    url: string
    authToken: string
  }
}
