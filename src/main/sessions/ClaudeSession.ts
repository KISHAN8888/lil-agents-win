import { spawn, ChildProcess } from 'child_process'
import { homedir } from 'os'
import { BaseSession } from './AgentSession'
import { findBinary, needsShell } from '../platform/environment'
import log from '../logger'

const CLAUDE_ARGS = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
]

export class ClaudeSession extends BaseSession {
  private proc: ChildProcess | null = null
  private buf = ''

  async start(cwd?: string, resumeId?: string): Promise<void> {
    const bin = await findBinary('claude')
    if (!bin) {
      this.emit('error', 'Claude CLI not found. Install via: https://claude.ai/download')
      return
    }

    // Scrub vars that confuse nested Claude/Electron invocations
    const env = { ...process.env }
    delete env['CLAUDECODE']
    delete env['CLAUDE_CODE_ENTRYPOINT']
    delete env['ELECTRON_RUN_AS_NODE']

    const resolvedCwd = cwd ?? homedir()
    const args = resumeId ? [...CLAUDE_ARGS, '--resume', resumeId] : CLAUDE_ARGS
    log.info(`ClaudeSession spawning: ${bin} cwd=${resolvedCwd}${resumeId ? ` resume=${resumeId}` : ''}`)

    this.proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: needsShell(bin),
      windowsHide: true,
      cwd: resolvedCwd,
    })

    this.isRunning = true

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8')
      this.flush()
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      log.debug(`[claude stderr] ${chunk.toString('utf8').trimEnd()}`)
    })

    this.proc.on('exit', code => {
      log.info(`ClaudeSession exit code=${code}`)
      this.isRunning = false
      this.isBusy = false
      this.emit('exit')
    })

    this.proc.on('error', err => {
      log.error(`ClaudeSession spawn error: ${err.message}`)
      this.isRunning = false
      this.emit('error', err.message)
    })
  }

  send(message: string): void {
    if (!this.proc?.stdin?.writable) {
      log.warn('ClaudeSession.send: stdin not writable')
      return
    }
    this.isBusy = true
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
    this.proc.stdin.write(line + '\n')
  }

  terminate(): void {
    this.proc?.kill()
    this.proc = null
    this.isRunning = false
    this.isBusy = false
  }

  // ---- NDJSON parsing ----

  private flush(): void {
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        this.handleMsg(JSON.parse(t) as Record<string, unknown>)
      } catch {
        log.debug(`[claude] non-JSON line: ${t}`)
      }
    }
  }

  private handleMsg(m: Record<string, unknown>): void {
    switch (m['type']) {
      case 'system': {
        if (m['subtype'] === 'init') {
          log.info('ClaudeSession ready')
          if (typeof m['session_id'] === 'string') this.emit('sessionId', m['session_id'])
          this.emit('ready')
        }
        break
      }

      case 'assistant': {
        const msg = m['message'] as { content?: unknown[] } | undefined
        for (const block of msg?.content ?? []) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (b['type'] === 'text') {
            this.emit('text', String(b['text'] ?? ''))
          } else if (b['type'] === 'tool_use') {
            this.emit('toolUse', String(b['name'] ?? 'tool'), b['input'])
          }
        }
        break
      }

      case 'user': {
        // Tool results echoed back
        const msg = m['message'] as { content?: unknown[] } | undefined
        for (const block of msg?.content ?? []) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (b['type'] === 'tool_result') {
            const isError = b['is_error'] === true
            this.emit('toolResult', isError ? 'Error' : 'Done', isError)
          }
        }
        break
      }

      case 'result': {
        this.isBusy = false
        this.emit('turnComplete')
        break
      }
    }
  }
}
