import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import log from '../logger'

const cache = new Map<string, string | null>()

/**
 * Resolves the full path of a named binary on Windows.
 * Priority: known install dirs → PATH via `where`.
 * Results are cached for the process lifetime.
 */
export async function findBinary(name: string): Promise<string | null> {
  if (cache.has(name)) return cache.get(name) ?? null

  const up = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const appData = process.env['APPDATA'] ?? ''
  const localAppData = process.env['LOCALAPPDATA'] ?? ''

  const candidates: string[] = [
    // Claude Code native installer puts the binary here
    join(up, '.claude', 'local', `${name}.exe`),
    join(up, '.claude', 'local', name),
    // Misc local installs
    join(up, '.local', 'bin', `${name}.exe`),
    join(up, '.local', 'bin', name),
    // npm global (.cmd shim)
    join(appData, 'npm', `${name}.cmd`),
    join(appData, 'npm', `${name}.exe`),
    // Per-user Program Files
    join(localAppData, 'Programs', name, `${name}.exe`),
    // System Program Files
    join('C:\\Program Files', name, `${name}.exe`),
  ]

  for (const c of candidates) {
    if (await exists(c)) {
      log.info(`findBinary(${name}) → ${c}`)
      cache.set(name, c)
      return c
    }
  }

  // VS Code extension ships native-binary/claude.exe — search all installed versions
  const vscodeExtDir = join(up, '.vscode', 'extensions')
  const fromVSCode = await findInVSCodeExtension(vscodeExtDir, name)
  if (fromVSCode) {
    log.info(`findBinary(${name}) via VS Code extension → ${fromVSCode}`)
    cache.set(name, fromVSCode)
    return fromVSCode
  }

  // Fall back to PATH lookup via `where`
  const fromPath = await whereCommand(name)
  log.info(`findBinary(${name}) via PATH → ${fromPath ?? 'not found'}`)
  cache.set(name, fromPath)
  return fromPath
}

/**
 * Scans ~/.vscode/extensions for anthropic.claude-code-* and checks
 * resources/native-binary/<name>.exe inside the latest version found.
 */
async function findInVSCodeExtension(extDir: string, name: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(extDir)
    const matching = entries
      .filter(e => e.startsWith(`anthropic.${name}-code-`))
      .sort()
      .reverse() // latest version first
    for (const dir of matching) {
      const candidate = join(extDir, dir, 'resources', 'native-binary', `${name}.exe`)
      if (await exists(candidate)) return candidate
    }
  } catch {
    // extDir doesn't exist or is unreadable — skip silently
  }
  return null
}

/** Returns true if the file exists and is accessible. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Runs `where <name>` and returns the first matching path. */
function whereCommand(name: string): Promise<string | null> {
  return new Promise(resolve => {
    exec(`where ${name}`, { windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return }
      const first = stdout.trim().split(/\r?\n/)[0]?.trim()
      resolve(first || null)
    })
  })
}

/** True if the path requires `shell: true` to spawn (e.g. .cmd, .bat). */
export function needsShell(binPath: string): boolean {
  const ext = binPath.toLowerCase().slice(binPath.lastIndexOf('.'))
  return ext === '.cmd' || ext === '.bat'
}
