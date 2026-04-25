'use strict'
// ELECTRON_RUN_AS_NODE=1 leaks from parent Electron processes (e.g. Claude Code, VSCode).
// This wrapper clears it so the child electron binary runs as a proper Electron main process.
delete process.env.ELECTRON_RUN_AS_NODE

const { spawn } = require('child_process')
const path = require('path')
const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron-vite')

const child = spawn(bin, ['dev'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
})
child.on('exit', code => process.exit(code ?? 0))
