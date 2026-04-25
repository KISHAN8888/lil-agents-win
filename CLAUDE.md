# lil-agents-win — Claude Code guidance

Windows port of ryanstephen/lil-agents (macOS SwiftUI). Two animated characters walk above the
taskbar; click one to open a terminal popover wrapping an AI CLI.

## Architecture overview

Three Electron processes:
- **Main** (`src/main/`) — all business logic, IPC orchestration, PTY/child_process, koffi FFI
- **Walker renderer** (`src/renderer/walker/`) — transparent click-through window, plays WebM-alpha video
- **Popover renderer** (`src/renderer/popover/`) — xterm.js terminal + title bar + input bar

Preloads expose typed `contextBridge` APIs only — renderers never use `require`.

## Key files

| File | Purpose |
|---|---|
| `src/main/index.ts` | App entry, single-instance lock, window creation |
| `src/main/controller/AppController.ts` | Tray, tick loop, character management |
| `src/main/controller/WalkerCharacter.ts` | Per-character walk state machine |
| `src/main/platform/taskbar.ts` | `SHAppBarMessage` via koffi |
| `src/main/sessions/AgentSession.ts` | Session interface + BaseSession |
| `src/main/ipc/channels.ts` | ALL IPC channel name constants — never use inline strings |
| `src/shared/types.ts` | Shared discriminated union types |

## Coding conventions

- **TypeScript strict** — no `any` without `// @ts-expect-error` and a reason comment
- **IPC channels** — always use constants from `src/main/ipc/channels.ts`
- **Session events** — typed via `SessionEvent` discriminated union in `src/shared/types.ts`
- **No `electron.remote`** — use `ipcRenderer` + `contextBridge`
- **Preloads** — expose typed APIs via `contextBridge.exposeInMainWorld`; renderer never touches `require`
- **File naming** — PascalCase for classes/components, camelCase for utilities
- **Sessions** — every `src/main/sessions/*.ts` extends `BaseSession` abstract class
- **No inline pixel math** — all positioning in CSS pixels; use `scaleFactor` from `screen.getDisplayMatching()`
- **No comments** explaining what code does — only comments for non-obvious WHY (constraints, workarounds)

## Running from inside Claude Code / VSCode

`ELECTRON_RUN_AS_NODE=1` is set by parent Electron processes (Claude Code, VSCode). This makes the
Electron binary behave as plain Node.js — `require('electron')` returns the binary path string instead
of the API, `process.type` is `undefined`, and the window never opens.

`scripts/dev.js` wraps `electron-vite dev` and `delete`s this env var before spawning. Always use
`npm run dev` (not `electron-vite dev` directly) when developing inside an Electron-based IDE.

## Windows gotchas to remember

1. Click-through toggle: `setIgnoreMouseEvents(false)` only when cursor is over sprite; always pass `forward: true`
2. `.cmd` shims can't be spawned with `shell: false` — use `environment.ts` to resolve real binary path
3. `node-pty` must be rebuilt for Electron via `electron-builder install-app-deps` (postinstall)
4. All position math in CSS pixels, never physical pixels
5. Scrub `CLAUDECODE` + `CLAUDE_CODE_ENTRYPOINT` env vars before spawning ClaudeSession
6. `app.requestSingleInstanceLock()` is in main/index.ts — don't remove it

## Running

```bash
npm install       # also runs electron-builder install-app-deps for node-pty
npm run dev       # HMR dev mode
npm run build     # production build
npm run test      # vitest unit tests
npm run dist      # electron-builder → NSIS installer
```

## Asset pipeline

Source `.mov` files live in `assets-src/` (git-lfs). Convert to WebM-alpha once:
```powershell
.\scripts\convert-videos.ps1
```
Requires ffmpeg in PATH.
