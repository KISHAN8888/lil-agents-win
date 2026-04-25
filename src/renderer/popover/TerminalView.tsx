import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const XTERM_THEMES: Record<string, ITheme> = {
  midnight: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#7f7fd5', selectionBackground: '#ffffff33' },
  peach:    { background: '#1e1208', foreground: '#f0d0b0', cursor: '#e8956d', selectionBackground: '#e8956d33' },
  cloud:    { background: '#f5f7fa', foreground: '#2d3748', cursor: '#4a90d9', selectionBackground: '#4a90d933' },
  moss:     { background: '#0d1f17', foreground: '#d4e8d4', cursor: '#4caf82', selectionBackground: '#4caf8233' },
}

export interface TerminalHandle {
  write: (data: string) => void
  clear: () => void
  setTheme: (name: string) => void
}

interface Props {
  initialTheme?: string
}

export const TerminalView = forwardRef<TerminalHandle, Props>(({ initialTheme = 'midnight' }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useImperativeHandle(ref, () => ({
    write: (data: string) => termRef.current?.write(data),
    clear: () => termRef.current?.clear(),
    setTheme: (name: string) => {
      if (termRef.current) {
        termRef.current.options.theme = XTERM_THEMES[name] ?? XTERM_THEMES.midnight
      }
    },
  }))

  useEffect(() => {
    const xtermTheme = XTERM_THEMES[initialTheme] ?? XTERM_THEMES.midnight

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", monospace',
      theme: xtermTheme,
      scrollback: 1000,
      convertEol: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current!)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    const observer = new ResizeObserver(() => fitRef.current?.fit())
    observer.observe(containerRef.current!)

    return () => {
      observer.disconnect()
      term.dispose()
    }
  }, [])

  return <div ref={containerRef} className="terminal-container" />
})

TerminalView.displayName = 'TerminalView'
