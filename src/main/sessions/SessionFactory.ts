import { AgentProvider } from '../../shared/types'
import { BaseSession } from './AgentSession'
import { ClaudeSession } from './ClaudeSession'
import { GeminiSession } from './GeminiSession'

/** Factory to create the correct session type for a provider. */
export function createSession(provider: AgentProvider): BaseSession {
  switch (provider) {
    case 'gemini':
      return new GeminiSession()
    case 'claude':
    default:
      return new ClaudeSession()
  }
}
