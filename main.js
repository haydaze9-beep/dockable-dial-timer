const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
process.on('uncaughtException', (err) => console.log('Unexpected error:', err.message));

// ---- SETTINGS you can tune ----
const SIZE = 260;          // free-floating window is 260 x 260
const HALF = SIZE / 2;     // docked windows are cut down to 130 on the docked sides
const R = 120;             // radius of the dial
const SNAP_DISTANCE = 80;  // how close the dial's edge must be to a screen edge to snap
const ANIM_MS = 240;       // length of the snap animation
const OVERSHOOT = 0.6;     // little bounce (0 = none). It can never cross a screen edge.

// The tray icon, built into the code so you don't need an image file
const TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABAklEQVR42tWXzQ3DIAyFc2AFpB567rVrMEN76bESM2QpZmCGjFCxRYslH+gP2AkQ00jvkgDvIxiwp+nfHn046igTZaNmlMV3upepQhN/ud2fqc6P65ugDbZVrcxhsPBpnANIQAL0rf3VLmdMASQgbvXSxA6nqIUy5wAgxAJjrpl51jx+K4qA0BwAt8WYAwJjkwHXwpyAsKWtFlqZ5yBwdyjW7GvNCxD2F4DfEcB/RX4v8wKETgGMAIDZZf1ZcQA3mgDAPBSA+BKIB6HsNhQ/iEY5imUvI/HreIiEZIiUjEpKOUloVVJKpeUbzF1VxZQWJiuN6wqTXGnGMG5bmg1RnPZ8XuGIfwfXE0gyAAAAAElFTkSuQmCC';

// ---- ONLY ONE COPY OF THE APP ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let tray = null;
let dragTimer = null;
let animTimer = null;
let dockState = 'free';    // 'free', 'left', 'top-left', ...

// ---- SAVED SETTINGS ----
let settings = { minutes: 10, sound: true, cx: null, cy: null };
let saveTimer = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (Number.isFinite(s.minutes)) settings.minutes = Math.min(60, Math.max(1, Math.round(s.minutes)));
    if (typeof s.sound === 'boolean') settings.sound = s.sound;
    if (Number.isFinite(s.cx) && Number.isFinite(s.cy)) { settings.cx = s.cx; settings.cy = s.cy; }
  } catch (e) { /* first run or unreadable file: keep the defaults */ }
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));
  } catch (e) {
    console.log('Could not save settings:', e.message);
  }
}

function saveSoon() {                 // waits a moment so fast changes become one write
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

// ---- THE WINDOW ----
function createWindow() {
  win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,                       // shown after it is placed, so it never flashes in the wrong spot
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,               // the timer keeps exact time even when hidden
      autoplayPolicy: 'no-user-gesture-required' // lets the alarm play without a click
    }
  });
  win.loadFile('index.html');
    win.setAlwaysOnTop(true, 'screen-saver');   // stays above fullscreen apps and videos

  // If the page ever re-loads or crashes, rebuild it in the same shape
  win.webContents.on('did-finish-load', () => sendDockState(dockState));
  win.webContents.on('render-process-gone', () => {
    if (win && !win.isDestroyed()) win.reload();
  });
  win.once('ready-to-show', () => {
    restorePosition();
    win.show();
  });
  win.on('closed', () => { stopDrag(); stopAnim(); win = null; });
}

function sendDockState(state) {
  if (win && !win.isDestroyed()) win.webContents.send('dock-state', state);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// ---- WINDOW SHAPES ----
// (index.html has a matching table. Keep them in sync.)
function layoutFor(state) {
  const hasH = state.includes('left') || state.includes('right');
  const hasV = state.includes('top') || state.includes('bottom');
  return {
    w: hasH ? HALF : SIZE,
    h: hasV ? HALF : SIZE,
    cx: state.includes('left') ? 0 : HALF,
    cy: state.includes('top') ? 0 : HALF
  };
}

function placeWindow(state, ccx, ccy) {
  if (!win || win.isDestroyed()) return;
  const L = layoutFor(state);
  win.setBounds({
    x: Math.round(ccx - L.cx),
    y: Math.round(ccy - L.cy),
    width: L.w,
    height: L.h
  });
}

function currentCenter() {
  const b = win.getBounds();
  const L = layoutFor(dockState);
  return { x: b.x + L.cx, y: b.y + L.cy };
}

// ---- DRAGGING (by the center) ----
function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
}

function stopAnim() {
  if (animTimer) clearInterval(animTimer);
  animTimer = null;
}

ipcMain.on('drag-start', () => {
  if (!win) return;
  stopDrag();
  stopAnim();

  const center = currentCenter();
  dockState = 'free';
  sendDockState('free');
  placeWindow('free', center.x, center.y);

  const startCursor = screen.getCursorScreenPoint();
  const [startX, startY] = win.getPosition();

  dragTimer = setInterval(() => {
    if (!win) return stopDrag();
    const c = screen.getCursorScreenPoint();
    win.setBounds({
      x: Math.round(startX + c.x - startCursor.x),
      y: Math.round(startY + c.y - startCursor.y),
      width: SIZE,
      height: SIZE
    });
  }, 8);
});

ipcMain.on('drag-end', () => {
  const wasDragging = dragTimer !== null;
  stopDrag();
  if (wasDragging) dockWindow();
});

// ---- DOCKING ----
function computeTarget() {
  const c = currentCenter();
  const wa = screen.getDisplayNearestPoint({
    x: Math.round(c.x),
    y: Math.round(c.y)
  }).workArea;

  let x = c.x;
  let y = c.y;
  let h = null;
  let v = null;

  if ((x - R) - wa.x <= SNAP_DISTANCE)                    { h = 'left';   x = wa.x; }
  else if ((wa.x + wa.width) - (x + R) <= SNAP_DISTANCE)  { h = 'right';  x = wa.x + wa.width; }
  if ((y - R) - wa.y <= SNAP_DISTANCE)                    { v = 'top';    y = wa.y; }
  else if ((wa.y + wa.height) - (y + R) <= SNAP_DISTANCE) { v = 'bottom'; y = wa.y + wa.height; }

  if (!h) x = clamp(x, wa.x + R, wa.x + wa.width - R);
  if (!v) y = clamp(y, wa.y + R, wa.y + wa.height - R);

  let state = 'free';
  if (h && v) state = v + '-' + h;
  else if (h) state = h;
  else if (v) state = v;

  return { x, y, state, wa, h, v };
}

function easeOutBack(t) {
  const s = OVERSHOOT;
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

function dockWindow() {
  if (!win) return;
  stopAnim();
  const target = computeTarget();
  const from = currentCenter();
  const wa = target.wa;

  const loX = Math.min(from.x, target.h === 'left'   ? wa.x : wa.x + R);
  const hiX = Math.max(from.x, target.h === 'right'  ? wa.x + wa.width : wa.x + wa.width - R);
  const loY = Math.min(from.y, target.v === 'top'    ? wa.y : wa.y + R);
  const hiY = Math.max(from.y, target.v === 'bottom' ? wa.y + wa.height : wa.y + wa.height - R);

  const startTime = Date.now();

  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopAnim();
    const t = Math.min(1, (Date.now() - startTime) / ANIM_MS);
    const e = easeOutBack(t);
    placeWindow('free',
      clamp(from.x + (target.x - from.x) * e, loX, hiX),
      clamp(from.y + (target.y - from.y) * e, loY, hiY));
    if (t >= 1) {
      stopAnim();
      finishDock(target);
    }
  }, 8);
}

function finishDock(target) {
  dockState = target.state;
  sendDockState(target.state);
  placeWindow(target.state, target.x, target.y);
  settings.cx = target.x;            // remember where the dial ended up
  settings.cy = target.y;
  saveSoon();
}

// ---- REMEMBER / RESET POSITION ----
function restorePosition() {
  let cx;
  let cy;
  if (settings.cx !== null && settings.cy !== null) {
    cx = settings.cx;
    cy = settings.cy;
  } else {
    const wa0 = screen.getPrimaryDisplay().workArea;
    cx = wa0.x + wa0.width / 2;
    cy = wa0.y + wa0.height / 2;
  }
  // If the saved spot is on a screen that no longer exists, use the nearest screen
  const wa = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;
  cx = clamp(cx, wa.x, wa.x + wa.width);
  cy = clamp(cy, wa.y, wa.y + wa.height);

  dockState = 'free';
  placeWindow('free', cx, cy);
  finishDock(computeTarget());       // snaps to the right shape instantly
}

function resetPosition() {
  if (!win) return;
  stopDrag();
  stopAnim();
  const wa = screen.getPrimaryDisplay().workArea;
  dockState = 'free';
  placeWindow('free', wa.x + wa.width / 2, wa.y + wa.height / 2);
  finishDock(computeTarget());
  win.show();
}

// ---- MENU AND TRAY ----
function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else win.show();
}

function setSound(on) {
  settings.sound = on;
  saveSoon();
  if (win && !win.isDestroyed()) win.webContents.send('sound-state', on);
}

function canAutoStart() {
  // Only works in the installed version, not in `npm start` or the portable file
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;
}

function buildMenu() {
  const items = [
    { label: win && win.isVisible() ? 'Hide dial' : 'Show dial', click: toggleVisible },
    { label: 'Reset position', click: resetPosition },
    { label: 'Alarm sound', type: 'checkbox', checked: settings.sound, click: (item) => setSound(item.checked) }
  ];
  if (canAutoStart()) {
    items.push({
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    });
  }
  items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
  tray.setToolTip('Dial Timer');
  tray.on('click', toggleVisible);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

ipcMain.on('show-menu', () => {
  if (win) buildMenu().popup({ window: win });
});

// ---- MESSAGES FROM THE PAGE ----
ipcMain.handle('get-settings', () => ({ minutes: settings.minutes, sound: settings.sound }));

ipcMain.on('save-minutes', (_event, m) => {
  if (!Number.isFinite(m)) return;
  settings.minutes = Math.min(60, Math.max(1, Math.round(m)));
  saveSoon();
});

ipcMain.on('alarm-fired', () => {
  if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
});
// ---- SCREEN CHANGES (monitor plugged in/out, resolution, taskbar moved, wake from sleep) ----
let reDockTimer = null;

function reDockSoon() {
  clearTimeout(reDockTimer);
  reDockTimer = setTimeout(reDock, 400);     // waits for Windows to finish rearranging
}

function reDock() {
  if (!win || win.isDestroyed()) return;
  if (dragTimer || animTimer) { reDockSoon(); return; }   // busy, try again shortly
  win.setAlwaysOnTop(true, 'screen-saver');
  finishDock(computeTarget());               // puts the dial back on a valid screen edge
}
// ---- START AND QUIT ----
app.on('second-instance', () => {
  if (win) win.show();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  loadSettings();
  createWindow();
  createTray();
  screen.on('display-added', reDockSoon);
  screen.on('display-removed', reDockSoon);
  screen.on('display-metrics-changed', reDockSoon);
  powerMonitor.on('resume', reDockSoon);
});

app.on('before-quit', saveNow);
app.on('window-all-closed', () => app.quit());