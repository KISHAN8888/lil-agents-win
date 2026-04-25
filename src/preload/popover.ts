import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc/channels'
import type { ThemeName } from '../shared/types'

// Module-level callback slots — ipcRenderer.on is registered ONCE here.
// React's StrictMode double-invokes effects; using setter functions instead of
// re-calling ipcRenderer.on prevents duplicate listeners and doubled output.
let _onText: ((chunk: string) => void) | null = null
let _onToolUse: ((name: string, input: unknown) => void) | null = null
let _onToolResult: ((summary: string, isError: boolean) => void) | null = null
let _onTurnComplete: (() => void) | null = null
let _onReady: (() => void) | null = null
let _onError: ((msg: string) => void) | null = null
let _onExit: (() => void) | null = null
let _onThemeApply: ((theme: string) => void) | null = null

ipcRenderer.on(IPC.SESSION_TEXT, (_e, chunk: string) => _onText?.(chunk))
ipcRenderer.on(IPC.SESSION_TOOL_USE, (_e, name: string, input: unknown) => _onToolUse?.(name, input))
ipcRenderer.on(IPC.SESSION_TOOL_RESULT, (_e, summary: string, isError: boolean) => _onToolResult?.(summary, isError))
ipcRenderer.on(IPC.SESSION_TURN_COMPLETE, () => _onTurnComplete?.())
ipcRenderer.on(IPC.SESSION_READY, () => _onReady?.())
ipcRenderer.on(IPC.SESSION_ERROR, (_e, msg: string) => _onError?.(msg))
ipcRenderer.on(IPC.SESSION_EXIT, () => _onExit?.())
ipcRenderer.on(IPC.THEME_APPLY, (_e, theme: string) => _onThemeApply?.(theme))

contextBridge.exposeInMainWorld('popoverAPI', {
  signalReady: () => ipcRenderer.send(IPC.POPOVER_READY),
  sendMessage: (text: string) => ipcRenderer.send(IPC.SESSION_SEND, text),
  terminate: () => ipcRenderer.send(IPC.SESSION_TERMINATE),
  close: () => ipcRenderer.send(IPC.POPOVER_CLOSE),
  copyLast: () => ipcRenderer.send(IPC.POPOVER_COPY_LAST),
  setTheme: (theme: ThemeName) => ipcRenderer.send(IPC.THEME_SET, theme),

  onText: (cb: (chunk: string) => void) => { _onText = cb },
  onToolUse: (cb: (name: string, input: unknown) => void) => { _onToolUse = cb },
  onToolResult: (cb: (summary: string, isError: boolean) => void) => { _onToolResult = cb },
  onTurnComplete: (cb: () => void) => { _onTurnComplete = cb },
  onReady: (cb: () => void) => { _onReady = cb },
  onError: (cb: (msg: string) => void) => { _onError = cb },
  onExit: (cb: () => void) => { _onExit = cb },
  onThemeApply: (cb: (theme: string) => void) => { _onThemeApply = cb },
})
