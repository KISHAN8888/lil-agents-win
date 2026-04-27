import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { EventEmitter } from 'events'
import log from '../logger'

export interface WorkerEvent {
  event: string
  [key: string]: any
}

export class WorkerProcess extends EventEmitter {
  private proc: ChildProcess | null = null
  private readonly workerPath: string
  private readonly pythonBin: string = 'python'
  private isShuttingDown = false
  private commandQueue: any[] = []

  constructor() {
    super()
    this.workerPath = join(app.getAppPath(), 'worker', 'worker.py')
    if (app.isPackaged) {
        // In production, we'll use the bundled exe
        this.pythonBin = join(process.resourcesPath, 'worker', 'worker.exe')
    }
  }

  start(): void {
    if (this.proc) return

    log.info(`Starting worker: ${this.pythonBin} ${this.workerPath}`)
    
    const spawnArgs = app.isPackaged ? [] : [this.workerPath]
    const spawnBin = app.isPackaged ? this.pythonBin : 'python'

    this.proc = spawn(spawnBin, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    })

    this.proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as WorkerEvent
          this.emit('event', event)
          if (event.event === 'log') {
            log.info(`[Worker] ${event.message}`)
          }
        } catch (e) {
          log.error(`Failed to parse worker event: ${line}`)
        }
      }
    })

    this.proc.stderr?.on('data', (data: Buffer) => {
      log.debug(`[Worker Stderr] ${data.toString().trim()}`)
    })

    this.proc.on('exit', (code) => {
      log.info(`Worker exited with code: ${code}`)
      this.proc = null
      if (!this.isShuttingDown) {
        log.warn('Worker crashed, restarting in 5s...')
        setTimeout(() => this.start(), 5000)
      }
    })

    this.proc.on('error', (err) => {
      log.error(`Worker process error: ${err.message}`)
    })

    // Process queued commands
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()
      this.send(cmd)
    }
  }

  send(cmd: any): void {
    if (!this.proc || !this.proc.stdin?.writable) {
      this.commandQueue.push(cmd)
      return
    }
    this.proc.stdin.write(JSON.stringify(cmd) + '\n')
  }

  stop(): void {
    this.isShuttingDown = true
    this.send({ cmd: 'shutdown' })
    
    // Force kill after 5s if it doesn't exit
    const timeout = setTimeout(() => {
      if (this.proc) {
        this.proc.kill()
        this.proc = null
      }
    }, 5000)

    this.proc?.once('exit', () => {
      clearTimeout(timeout)
    })
  }
}
