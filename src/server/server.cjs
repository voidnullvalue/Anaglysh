#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const childProcess = require('child_process');

const PORT = Number(process.env.ANAGLYSH_PORT || 3333);
const HOST = process.env.ANAGLYSH_HOST || '127.0.0.1';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STATIC_DIR = process.env.ANAGLYSH_STATIC_DIR
  ? path.resolve(PROJECT_ROOT, process.env.ANAGLYSH_STATIC_DIR)
  : null;
const RULES_FILE = process.env.ANAGLYSH_RULES_FILE
  ? path.resolve(process.env.ANAGLYSH_RULES_FILE)
  : path.resolve(PROJECT_ROOT, 'config', 'depth-rules.json');

let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (err) {
  ptyLoadError = err;
}

function readRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch (err) {
    return {
      version: 1,
      warning: `Could not read ${RULES_FILE}: ${err.message}`,
      rules: []
    };
  }
}

function getShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function spawnPty(ws, requested = {}) {
  const cols = Number(requested.cols || 100);
  const rows = Number(requested.rows || 30);
  const cwd = requested.cwd && typeof requested.cwd === 'string'
    ? requested.cwd
    : os.homedir();
  const shell = getShell();

  if (pty) {
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ANAGLYSH: '1',
      PATH: `${path.resolve(PROJECT_ROOT, 'bin')}${path.delimiter}${process.env.PATH || ''}`
    };

    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    });

    term.onData(data => send(ws, { type: 'output', data }));
    term.onExit(event => send(ws, { type: 'exit', code: event.exitCode, signal: event.signal }));
    return {
      kind: 'node-pty',
      write: data => term.write(data),
      resize: (c, r) => term.resize(Math.max(2, c | 0), Math.max(2, r | 0)),
      kill: () => term.kill()
    };
  }

  // Fallback keeps the app inspectable when node-pty was not built yet. It is
  // intentionally not advertised as real terminal emulation.
  const child = childProcess.spawn(shell, [], {
    cwd,
    env: {
      ...process.env,
      TERM: 'dumb',
      ANAGLYSH: '1',
      PATH: `${path.resolve(PROJECT_ROOT, 'bin')}${path.delimiter}${process.env.PATH || ''}`
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  send(ws, {
    type: 'output',
    data: `\x1b[31mnode-pty failed to load; running degraded pipe mode. Curses apps will be bad.\x1b[0m\r\n${ptyLoadError ? ptyLoadError.message : ''}\r\n\r\n`
  });

  child.stdout.on('data', data => send(ws, { type: 'output', data: data.toString('utf8') }));
  child.stderr.on('data', data => send(ws, { type: 'output', data: data.toString('utf8') }));
  child.on('exit', (code, signal) => send(ws, { type: 'exit', code, signal }));

  return {
    kind: 'pipe-fallback',
    write: data => child.stdin.write(data),
    resize: () => {},
    kill: () => child.kill()
  };
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  // Dev UI runs on Vite :5173 while the PTY/API server runs on :3333.
  // Keep this local and boring; do not expose the server publicly.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, pty: Boolean(pty), ptyError: ptyLoadError ? ptyLoadError.message : null });
});

app.get('/api/rules', (_req, res) => {
  res.json(readRules());
});

if (STATIC_DIR && fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get('*', (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('Anaglysh server is up. Use npm run dev for the Vite UI, or npm start for the Electron build.');
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/pty' });

wss.on('connection', ws => {
  let terminal = null;

  send(ws, {
    type: 'status',
    backend: pty ? 'node-pty' : 'pipe-fallback',
    shell: getShell()
  });

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch (_err) {
      send(ws, { type: 'error', message: 'Invalid JSON message.' });
      return;
    }

    try {
      if (msg.type === 'spawn') {
        if (terminal) terminal.kill();
        terminal = spawnPty(ws, msg);
        send(ws, { type: 'spawned', backend: terminal.kind });
        return;
      }
      if (msg.type === 'input' && terminal) {
        terminal.write(String(msg.data || ''));
        return;
      }
      if (msg.type === 'resize' && terminal) {
        terminal.resize(Number(msg.cols || 100), Number(msg.rows || 30));
        return;
      }
      if (msg.type === 'kill' && terminal) {
        terminal.kill();
        terminal = null;
        return;
      }
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    if (terminal) terminal.kill();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[anaglysh] server listening on http://${HOST}:${PORT}`);
  if (!pty) {
    console.warn('[anaglysh] node-pty unavailable; degraded pipe mode only.');
    if (ptyLoadError) console.warn(`[anaglysh] ${ptyLoadError.message}`);
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
