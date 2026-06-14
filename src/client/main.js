import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import './style.css';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:3333/pty`;
const OSC_CODE = 8377;

const modes = {
  usable: { depth: 2, tiltX: 0, tiltY: 0, warp: true },
  stupid: { depth: 5, tiltX: 0.8, tiltY: -0.8, warp: true },
  migraine: { depth: 11, tiltX: 1.8, tiltY: -2.2, warp: true },
  gitcrime: { depth: 8, tiltX: -1.1, tiltY: 1.7, warp: true }
};

const el = {
  shell: document.getElementById('terminalShell'),
  red: document.getElementById('term-red'),
  cyan: document.getElementById('term-cyan'),
  mode: document.getElementById('modeSelect'),
  depth: document.getElementById('depthSlider'),
  depthReadout: document.getElementById('depthReadout'),
  eyes: document.getElementById('eyeSelect'),
  eyeReadout: document.getElementById('eyeReadout'),
  warp: document.getElementById('warpToggle'),
  hud: document.getElementById('hudToggle'),
  depthHud: document.getElementById('depthHud'),
  status: document.getElementById('status'),
  backend: document.getElementById('backendReadout'),
  shellName: document.getElementById('shellReadout'),
  rule: document.getElementById('ruleReadout')
};

const baseOptions = {
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: 'JetBrains Mono, Fira Code, Cascadia Mono, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 15,
  lineHeight: 1.12,
  letterSpacing: 0,
  scrollback: 8000,
  convertEol: false,
  allowProposedApi: true,
  windowsMode: false,
  theme: {
    background: '#020305',
    selectionBackground: '#ffffff33',
    cursorAccent: '#020305'
  }
};

const redTerm = new Terminal({
  ...baseOptions,
  theme: {
    ...baseOptions.theme,
    foreground: '#ff2a3c',
    cursor: '#ff2a3c',
    black: '#020305',
    red: '#ff2a3c',
    green: '#ff5662',
    yellow: '#ff7981',
    blue: '#d52739',
    magenta: '#ff4c72',
    cyan: '#ff8790',
    white: '#ffd3d6',
    brightBlack: '#5a1a22',
    brightRed: '#ff5c68',
    brightGreen: '#ff737c',
    brightYellow: '#ff939a',
    brightBlue: '#ff6875',
    brightMagenta: '#ff82a0',
    brightCyan: '#ffb2b8',
    brightWhite: '#fff3f4'
  }
});

const cyanTerm = new Terminal({
  ...baseOptions,
  disableStdin: true,
  cursorBlink: false,
  theme: {
    ...baseOptions.theme,
    foreground: '#23f7ff',
    cursor: '#23f7ff',
    black: '#020305',
    red: '#22dbe2',
    green: '#23f7ff',
    yellow: '#89fbff',
    blue: '#20c8ff',
    magenta: '#4af6ff',
    cyan: '#23f7ff',
    white: '#d9fdff',
    brightBlack: '#12464a',
    brightRed: '#55f9ff',
    brightGreen: '#76fbff',
    brightYellow: '#a6fdff',
    brightBlue: '#55dfff',
    brightMagenta: '#8afcff',
    brightCyan: '#a7fdff',
    brightWhite: '#f4ffff'
  }
});

const fitRed = new FitAddon();
const fitCyan = new FitAddon();
redTerm.loadAddon(fitRed);
cyanTerm.loadAddon(fitCyan);
redTerm.open(el.red);
cyanTerm.open(el.cyan);
redTerm.focus();

let ws;
let rules = [];
let currentDepth = Number(el.depth.value || 5);
// Standard red/cyan paper glasses are usually red on the left eye and cyan/blue on the right.
// Positive depth pushes red right and cyan left so the terminal comes forward instead of collapsing backward.
let eyeOrder = 'standard';
let eyeSign = 1;
let depthTimer = null;
let reconnectTimer = null;
let lastFit = { cols: 100, rows: 30 };

function setStatus(text, cls = '') {
  el.status.textContent = text;
  el.status.className = `status ${cls}`.trim();
}

function stripAnsi(input) {
  return String(input)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function updateLayerOffsets() {
  document.documentElement.style.setProperty('--depth-px', `${currentDepth}px`);
  document.documentElement.style.setProperty('--red-x', `${currentDepth * eyeSign}px`);
  document.documentElement.style.setProperty('--cyan-x', `${currentDepth * -eyeSign}px`);
}

function setDepth(depth, transient = false) {
  currentDepth = Math.max(0, Math.min(24, Number(depth) || 0));
  updateLayerOffsets();
  el.depth.value = String(Math.min(18, currentDepth));
  el.depthReadout.textContent = String(Math.round(currentDepth));
  if (!transient) el.rule.textContent = 'manual';
}

function setEyeOrder(order) {
  eyeOrder = order === 'swapped' ? 'swapped' : 'standard';
  eyeSign = eyeOrder === 'standard' ? 1 : -1;
  el.eyes.value = eyeOrder;
  el.eyeReadout.textContent = eyeOrder === 'standard' ? 'red left' : 'cyan left';
  updateLayerOffsets();
}

function toggleEyeOrder() {
  setEyeOrder(eyeOrder === 'standard' ? 'swapped' : 'standard');
  el.rule.textContent = `eyes:${eyeOrder}`;
}

function setWarp(enabled) {
  document.documentElement.style.setProperty('--warp', enabled ? '1' : '0');
}

function setTilt(x, y) {
  document.documentElement.style.setProperty('--tilt-x', `${x}deg`);
  document.documentElement.style.setProperty('--tilt-y', `${y}deg`);
}

function applyMode(name) {
  const mode = modes[name] || modes.stupid;
  el.mode.value = name in modes ? name : 'stupid';
  el.warp.checked = mode.warp;
  setWarp(mode.warp);
  setTilt(mode.tiltX, mode.tiltY);
  setDepth(mode.depth);
  el.rule.textContent = `mode:${el.mode.value}`;
}

function flashDepth(depth, durationMs = 900, label = 'flash', shake = false) {
  const previous = currentDepth;
  if (depthTimer) clearTimeout(depthTimer);
  setDepth(depth, true);
  el.rule.textContent = label;
  if (shake) {
    el.shell.classList.remove('shake');
    void el.shell.offsetWidth;
    el.shell.classList.add('shake');
  }
  depthTimer = setTimeout(() => {
    setDepth(previous, true);
    el.rule.textContent = 'none';
  }, durationMs);
}

function writeBoth(data) {
  redTerm.write(data);
  cyanTerm.write(data);
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function fitAndResize() {
  try {
    fitRed.fit();
    fitCyan.fit();
    // Use the controlling terminal dimensions as the truth. The duplicate terminal
    // is visual, not authoritative.
    lastFit = { cols: redTerm.cols, rows: redTerm.rows };
    send({ type: 'resize', cols: lastFit.cols, rows: lastFit.rows });
  } catch (_err) {
    // xterm fit can be called before layout settles during first paint.
  }
}

function inspectOutput(data) {
  const plain = stripAnsi(data);
  if (!plain) return;

  let best = null;
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, rule.flags || 'i');
      if (re.test(plain) && (!best || Number(rule.depth) > Number(best.depth))) {
        best = rule;
      }
    } catch (_err) {
      // Ignore invalid user rules.
    }
  }

  if (best) {
    flashDepth(best.depth, best.durationMs || 900, best.name || best.pattern, Boolean(best.shake));
  }
}

function handleOsc(data) {
  const chunks = String(data).split(/[;,]/).map(s => s.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const [key, rawValue] = chunk.split('=').map(s => s.trim());
    if (key === 'depth') setDepth(Number(rawValue));
    if (key === 'flash') flashDepth(Number(rawValue), 900, `osc:flash:${rawValue}`, true);
    if (key === 'mode') applyMode(rawValue);
    if (key === 'warp') {
      const enabled = rawValue !== '0' && rawValue !== 'false' && rawValue !== 'off';
      el.warp.checked = enabled;
      setWarp(enabled);
    }
    if (key === 'eyes') {
      setEyeOrder(['swap', 'swapped', 'cyan-left', 'cyanleft', 'right-red'].includes(String(rawValue).toLowerCase()) ? 'swapped' : 'standard');
      el.rule.textContent = `osc:eyes:${eyeOrder}`;
    }
    if (key === 'banner') {
      writeBoth(`\r\n\x1b[1m[anaglysh]\x1b[0m ${rawValue || ''}\r\n`);
    }
  }
  return true;
}

function installOsc(term) {
  try {
    term.parser.registerOscHandler(OSC_CODE, handleOsc);
  } catch (_err) {
    // Parser hooks are present in current xterm.js. Failing here only disables depthctl.
  }
}

installOsc(redTerm);
installOsc(cyanTerm);

redTerm.onData(data => send({ type: 'input', data }));

function connect() {
  clearTimeout(reconnectTimer);
  setStatus('connecting');
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    setStatus('connected', 'connected');
    send({ type: 'spawn', cols: lastFit.cols, rows: lastFit.rows });
  });

  ws.addEventListener('message', event => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_err) {
      return;
    }

    if (msg.type === 'status') {
      el.backend.textContent = msg.backend || '?';
      el.shellName.textContent = msg.shell || '?';
    }

    if (msg.type === 'spawned') {
      setStatus(`connected / ${msg.backend}`, 'connected');
    }

    if (msg.type === 'output') {
      writeBoth(msg.data);
      inspectOutput(msg.data);
    }

    if (msg.type === 'exit') {
      writeBoth(`\r\n\x1b[31m[anaglysh] shell exited: code=${msg.code ?? ''} signal=${msg.signal ?? ''}\x1b[0m\r\n`);
      setStatus('shell exited', 'bad');
    }

    if (msg.type === 'error') {
      writeBoth(`\r\n\x1b[31m[anaglysh] ${msg.message}\x1b[0m\r\n`);
      setStatus('backend error', 'bad');
    }
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected; retrying', 'bad');
    reconnectTimer = setTimeout(connect, 1000);
  });

  ws.addEventListener('error', () => {
    setStatus('socket error', 'bad');
  });
}

async function loadRules() {
  try {
    const res = await fetch('http://127.0.0.1:3333/api/rules', { cache: 'no-store' });
    const json = await res.json();
    rules = Array.isArray(json.rules) ? json.rules : [];
  } catch (_err) {
    rules = [];
  }
}

el.mode.addEventListener('change', () => applyMode(el.mode.value));
el.depth.addEventListener('input', () => setDepth(Number(el.depth.value)));
el.eyes.addEventListener('change', () => {
  setEyeOrder(el.eyes.value);
  el.rule.textContent = `eyes:${eyeOrder}`;
});
el.warp.addEventListener('change', () => setWarp(el.warp.checked));
el.hud.addEventListener('change', () => {
  el.depthHud.classList.toggle('hidden', !el.hud.checked);
});

window.addEventListener('keydown', event => {
  if (!event.ctrlKey || !event.shiftKey) return;
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    setDepth(currentDepth + 1);
  }
  if (event.key === '_' || event.key === '-') {
    event.preventDefault();
    setDepth(currentDepth - 1);
  }
  if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    const names = Object.keys(modes);
    const next = names[(names.indexOf(el.mode.value) + 1) % names.length];
    applyMode(next);
  }
  if (event.key.toLowerCase() === 'e') {
    event.preventDefault();
    toggleEyeOrder();
  }
});

const observer = new ResizeObserver(() => fitAndResize());
observer.observe(el.shell);

setTimeout(() => {
  fitAndResize();
  redTerm.focus();
}, 50);

await loadRules();
setEyeOrder('standard');
applyMode('stupid');
connect();
