import { EventEmitter } from 'events'

export abstract class BaseSession extends EventEmitter {
  isRunning = false
  isBusy = false

  abstract start(cwd?: string, resumeId?: string): Promise<void>
  abstract send(message: string): void
  abstract terminate(): void
}

// Typed overloads so callers get proper argument types
export interface BaseSession {
  on(event: 'text', listener: (chunk: string) => void): this
  on(event: 'toolUse', listener: (name: string, input: unknown) => void): this
  on(event: 'toolResult', listener: (summary: string, isError: boolean) => void): this
  on(event: 'turnComplete', listener: () => void): this
  on(event: 'ready', listener: () => void): this
  on(event: 'sessionId', listener: (id: string) => void): this
  on(event: 'error', listener: (msg: string) => void): this
  on(event: 'exit', listener: () => void): this
  emit(event: 'text', chunk: string): boolean
  emit(event: 'toolUse', name: string, input: unknown): boolean
  emit(event: 'toolResult', summary: string, isError: boolean): boolean
  emit(event: 'turnComplete'): boolean
  emit(event: 'ready'): boolean
  emit(event: 'sessionId', id: string): boolean
  emit(event: 'error', msg: string): boolean
  emit(event: 'exit'): boolean
}
