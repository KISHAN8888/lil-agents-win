import { useEffect, useRef } from 'react'
import type { HistoryEntry } from '@shared/types'
import { TitleBar } from './TitleBar'
import { TerminalView, type TerminalHandle } from './TerminalView'
import { InputBar } from './InputBar'

function getParams() {
  const p = new URLSearchParams(location.search)
  return {
    char: p.get('char') ?? 'tuco',
    provider: p.get('provider') ?? 'claude',
    theme: p.get('theme') ?? 'midnight',
  }
}

type PopoverAPI = {
  signalReady: () => void
  sendMessage: (text: string) => void
  close: () => void
  copyLast: () => void
  onText: (cb: (chunk: string) => void) => void
  onToolUse: (cb: (name: string, input: unknown) => void) => void
  onToolResult: (cb: (summary: string, isError: boolean) => void) => void
  onTurnComplete: (cb: () => void) => void
  onReady: (cb: () => void) => void
  onError: (cb: (msg: string) => void) => void
  onExit: (cb: () => void) => void
  onThemeApply: (cb: (theme: string) => void) => void
  onCwd: (cb: (cwd: string) => void) => void
  onHistory: (cb: (entries: unknown[]) => void) => void
}

function getAPI(): PopoverAPI | undefined {
  return (window as Window & { popoverAPI?: PopoverAPI }).popoverAPI
}

function applyTheme(name: string) {
  document.documentElement.dataset.theme = name
}


export default function PopoverApp() {
  const { char, provider, theme: initialTheme } = getParams()
  const termRef = useRef<TerminalHandle>(null)
  const sessionConnected = useRef(false)
  const lastResponseRef = useRef('')
  const currentChunkRef = useRef('')

  const closePopover = () => getAPI()?.close()

  const handleCopy = () => {
    const text = lastResponseRef.current
    if (!text) {
      termRef.current?.write('\r\n\x1b[2mNothing to copy yet\x1b[0m\r\n')
      return
    }
    navigator.clipboard.writeText(text).then(() => {
      termRef.current?.write('\r\n\x1b[32mCopied!\x1b[0m\r\n')
    }).catch(() => {
      termRef.current?.write('\r\n\x1b[31mCopy failed\x1b[0m\r\n')
    })
  }

  const handleSubmit = (text: string) => {
    if (text === '/help') {
      termRef.current?.write(
        '\r\n\x1b[33mSlash commands:\x1b[0m\r\n' +
        '  /clear  — clear terminal\r\n' +
        '  /copy   — copy last response\r\n' +
        '  /help   — show this help\r\n'
      )
      return
    }
    currentChunkRef.current = ''
    termRef.current?.write(`\r\n\x1b[36m>\x1b[0m ${text}\r\n`)
    getAPI()?.sendMessage(text)
  }

  // Apply initial theme from URL param
  useEffect(() => {
    applyTheme(initialTheme)
  }, [])

  // Global Escape handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePopover() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Wire session stream events then signal main process that we're ready
  useEffect(() => {
    const api = getAPI()
    if (!api) return
    api.onHistory(entries => {
      const history = entries as HistoryEntry[]
      if (!history.length) return
      termRef.current?.write('\x1b[2m── previous conversation ──\x1b[0m\r\n')
      for (const e of history) {
        if (e.role === 'user') {
          termRef.current?.write(`\r\n\x1b[36m>\x1b[0m ${e.text}\r\n`)
        } else {
          termRef.current?.write(e.text + '\r\n')
        }
      }
      termRef.current?.write('\x1b[2m───────────────────────────\x1b[0m\r\n\r\n')
    })
    api.onReady(() => {
      if (!sessionConnected.current) {
        sessionConnected.current = true
      }
    })
    api.onCwd(cwd => {
      termRef.current?.write(`\x1b[2mWorking in: ${cwd}\x1b[0m\r\n\r\n`)
    })
    api.onText(chunk => {
      currentChunkRef.current += chunk
      termRef.current?.write(chunk)
    })
    api.onToolUse(name => termRef.current?.write(`\r\n\x1b[2m[${name}…]\x1b[0m`))
    api.onToolResult((_, isError) =>
      termRef.current?.write(isError ? ' \x1b[31m✗\x1b[0m\r\n' : ' \x1b[32m✓\x1b[0m\r\n')
    )
    api.onTurnComplete(() => {
      if (currentChunkRef.current) lastResponseRef.current = currentChunkRef.current
      currentChunkRef.current = ''
      termRef.current?.write('\r\n')
    })
    api.onError(msg => termRef.current?.write(`\r\n\x1b[31mError: ${msg}\x1b[0m\r\n`))
    api.onExit(() => termRef.current?.write('\r\n\x1b[2mSession ended\x1b[0m\r\n'))
    api.onThemeApply(name => {
      applyTheme(name)
      termRef.current?.setTheme(name)
    })
    // All listeners registered — tell main process it's safe to start the session
    api.signalReady()
  }, [])

  return (
    <div className="popover-root">
      <TitleBar char={char} provider={provider} onClose={closePopover} />
      <TerminalView ref={termRef} initialTheme={initialTheme} />
      <InputBar
        onSubmit={handleSubmit}
        onCopy={handleCopy}
        onClear={() => termRef.current?.clear()}
        onClose={closePopover}
      />
    </div>
  )
}
