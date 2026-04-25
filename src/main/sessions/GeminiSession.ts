import { spawn, ChildProcess } from 'child_process'
import { homedir } from 'os'
import { BaseSession } from './AgentSession'
import { findBinary, needsShell } from '../platform/environment'
import log from '../logger'

const GEMINI_ARGS = [
  '--output-format', 'stream-json',
  '--skip-trust',
  '--yolo',
]

export class GeminiSession extends BaseSession {
  private proc: ChildProcess | null = null
  private buf = ''
  private cwd: string = homedir()
  private resumeId?: string

  async start(cwd?: string, resumeId?: string): Promise<void> {
    this.cwd = cwd ?? homedir()
    this.resumeId = resumeId
    this.isRunning = true
    // Gemini CLI one-shot is "ready" immediately
    this.emit('ready')
  }

  send(message: string): void {
    if (this.isBusy) {
      log.warn('GeminiSession: busy, ignoring message')
      return
    }
    this.isBusy = true
    void this.runOneShot(message)
  }

  terminate(): void {
    this.proc?.kill()
    this.proc = null
    this.isRunning = false
    this.isBusy = false
  }

  private async runOneShot(message: string): Promise<void> {
    const geminiCmd = await findBinary('gemini')
    if (!geminiCmd) {
      this.emit('error', 'Gemini CLI not found. Install via: npm install -g @google/gemini-cli')
      this.isBusy = false
      return
    }

    let bin = 'node'
    let args: string[] = []

    // On Windows, if we found gemini.cmd, try to spawn the JS file directly to avoid shell quoting issues
    if (geminiCmd.toLowerCase().endsWith('.cmd')) {
      const entryPoint = geminiCmd.replace(/gemini\.cmd$/i, 'node_modules/@google/gemini-cli/bundle/gemini.js')
      bin = 'node'
      args = [entryPoint, ...GEMINI_ARGS]
    } else {
      bin = geminiCmd
      args = [...GEMINI_ARGS]
    }

    if (this.resumeId) {
      args.push('--resume', this.resumeId)
    }
    args.push('--prompt', message)

    log.info(`GeminiSession spawning: ${bin} args=${args.join(' ')}`)

    this.proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: false, // Avoid shell on Windows for better arg parsing
      windowsHide: true,
      cwd: this.cwd,
    })

    this.buf = ''

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8')
      this.flush()
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      log.debug(`[gemini stderr] ${chunk.toString('utf8').trimEnd()}`)
    })

    this.proc.on('exit', code => {
      log.info(`GeminiSession process exit code=${code}`)
      this.proc = null
      this.isBusy = false
      this.emit('turnComplete')
    })

    this.proc.on('error', err => {
      log.error(`GeminiSession spawn error: ${err.message}`)
      this.isBusy = false
      this.emit('error', err.message)
    })
  }

  private flush(): void {
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        this.handleMsg(JSON.parse(t) as Record<string, unknown>)
      } catch {
        log.debug(`[gemini] non-JSON line: ${t}`)
      }
    }
  }

  private handleMsg(m: Record<string, unknown>): void {
    switch (m['type']) {
      case 'init': {
        if (typeof m['session_id'] === 'string') {
          this.resumeId = m['session_id']
          this.emit('sessionId', m['session_id'])
        }
        break
      }

      case 'message': {
        if (m['role'] === 'assistant' && typeof m['content'] === 'string') {
          this.emit('text', m['content'])
        }
        break
      }

      case 'tool_use': {
        const name = String(m['tool_name'] ?? 'tool')
        const input = m['parameters']
        this.emit('toolUse', name, input)
        break
      }

      case 'tool_result': {
        const isError = m['status'] === 'error'
        this.emit('toolResult', isError ? 'Error' : 'Done', isError)
        break
      }

      case 'result': {
        // Result is handled by process exit for Gemini CLI one-shot
        break
      }
    }
  }
}
