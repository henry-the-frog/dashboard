#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DASHBOARD_PORT || 3000;
const TOKEN = process.env.DASHBOARD_TOKEN;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const SCHEDULE_FILE = path.join(__dirname, '..', 'schedule.json');

// Ensure dirs exist
fs.mkdirSync(HISTORY_DIR, { recursive: true });

// --- Read live schedule.json as source of truth ---
function readSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      const queue = raw.queue || [];
      const done = queue.filter(t => t.status === 'done');
      const inProgress = queue.find(t => t.status === 'in-progress');
      return {
        date: raw.date || new Date().toISOString().slice(0, 10),
        queue,
        current: inProgress || null,
        stats: {
          completed: done.length,
          yielded: queue.filter(t => t.status === 'blocked').length,
          skipped: queue.filter(t => t.status === 'skipped').length,
          total_duration_ms: queue.reduce((s, t) => s + (t.duration_ms || 0), 0)
        },
        updated_at: raw.updated_at || fs.statSync(SCHEDULE_FILE).mtime.toISOString()
      };
    }
  } catch (e) {
    console.error('Error reading schedule.json:', e.message);
  }
  return {
    date: new Date().toISOString().slice(0, 10),
    queue: [],
    current: null,
    stats: { completed: 0, yielded: 0, skipped: 0, total_duration_ms: 0 },
    updated_at: new Date().toISOString()
  };
}

// --- Read rich data from generate.cjs output (dashboard.json) ---
// These sections are refreshed periodically by MAINTAIN tasks running generate.cjs
const RICH_KEYS = ['artifacts', 'benchmarks', 'blogPosts', 'prs', 'recentDays',
  'streak', 'scheduleAdherence', 'todayHighlights', 'adjustments', 'blockers', 'projects'];

function readRichData() {
  const f = path.join(DATA_DIR, 'rich.json');
  if (fs.existsSync(f)) {
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      const rich = {};
      for (const key of RICH_KEYS) {
        if (data[key] !== undefined) rich[key] = data[key];
      }
      rich._richGenerated = data.generated || null;
      return rich;
    } catch { return {}; }
  }
  // Fall back to dashboard.json if rich.json doesn't exist yet
  const f2 = path.join(DATA_DIR, 'dashboard.json');
  if (fs.existsSync(f2)) {
    try {
      const data = JSON.parse(fs.readFileSync(f2, 'utf8'));
      const rich = {};
      for (const key of RICH_KEYS) {
        if (data[key] !== undefined) rich[key] = data[key];
      }
      rich._richGenerated = data.generated || null;
      return rich;
    } catch { return {}; }
  }
  return {};
}

// --- Merge live queue + rich data ---
function readDashboard() {
  const live = readSchedule();
  const rich = readRichData();
  return { ...live, ...rich };
}

// Legacy: keep dashboard.json in sync for static fallback
function saveToDisk(dashboard) {
  fs.writeFileSync(path.join(DATA_DIR, 'dashboard.json'), JSON.stringify(dashboard, null, 2) + '\n');
}

function archiveDay(date) {
  const dashboard = readSchedule();
  fs.writeFileSync(path.join(HISTORY_DIR, `${date}.json`), JSON.stringify(dashboard, null, 2) + '\n');
}

// --- Auth ---
function checkAuth(req) {
  if (!TOKEN) return true; // no token configured = no auth required
  const auth = req.headers['authorization'];
  return auth === `Bearer ${TOKEN}`;
}

// --- Request helpers ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

// --- Routes ---
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // GET /api/dashboard — serve live queue + rich data merged
    if (req.method === 'GET' && pathname === '/api/dashboard') {
      return json(res, 200, readDashboard());
    }

    // POST /api/regenerate — trigger generate.cjs to refresh rich data
    if (req.method === 'POST' && pathname === '/api/regenerate') {
      if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const { execSync } = require('child_process');
      try {
        execSync('/usr/local/bin/node generate.cjs', { cwd: __dirname, timeout: 30000, stdio: 'pipe' });
        // Copy rich keys from dashboard.json to rich.json
        const dashFile = path.join(DATA_DIR, 'dashboard.json');
        if (fs.existsSync(dashFile)) {
          const full = JSON.parse(fs.readFileSync(dashFile, 'utf8'));
          const rich = {};
          for (const key of RICH_KEYS) {
            if (full[key] !== undefined) rich[key] = full[key];
          }
          rich.generated = full.generated || new Date().toISOString();
          fs.writeFileSync(path.join(DATA_DIR, 'rich.json'), JSON.stringify(rich, null, 2) + '\n');
        }
        return json(res, 200, { ok: true, generated: new Date().toISOString() });
      } catch (e) {
        return json(res, 500, { error: 'generate.cjs failed: ' + (e.stderr?.toString() || e.message) });
      }
    }

    // GET /api/history/:date
    if (req.method === 'GET' && pathname.startsWith('/api/history/')) {
      const date = pathname.split('/').pop();
      const file = path.join(HISTORY_DIR, `${date}.json`);
      if (fs.existsSync(file)) {
        return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
      }
      return json(res, 404, { error: 'not found' });
    }

    // POST /api/task-update — update task in schedule.json directly
    if (req.method === 'POST' && pathname === '/api/task-update') {
      if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      if (!body.action) return json(res, 400, { error: 'missing action' });

      try {
        const raw = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        const queue = raw.queue || [];

        if (body.action === 'start') {
          if (body.task?.id) {
            const t = queue.find(t => t.id === body.task.id);
            if (t) { t.status = 'in-progress'; t.started = new Date().toISOString(); }
          }
        } else if (body.action === 'complete') {
          if (body.task?.id) {
            const t = queue.find(t => t.id === body.task.id);
            if (t) {
              t.status = 'done';
              t.completed = new Date().toISOString();
              if (body.task.summary) t.summary = body.task.summary;
              if (body.task.duration_ms) t.duration_ms = body.task.duration_ms;
            }
          }
        } else if (body.action === 'session-ended') {
          // No-op for schedule.json — state is already in the file
        } else {
          return json(res, 400, { error: `unknown action: ${body.action}` });
        }

        raw.updated_at = new Date().toISOString();
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(raw, null, 2) + '\n');
        // Also sync dashboard.json for static fallback
        saveToDisk(readSchedule());
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { error: 'Failed to update schedule.json: ' + e.message });
      }
    }

    // POST /api/queue-update — write full queue to schedule.json
    if (req.method === 'POST' && pathname === '/api/queue-update') {
      if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);

      const newQueue = body.queue || (Array.isArray(body) ? body : null);
      if (!newQueue) return json(res, 400, { error: 'expected queue array' });

      const raw = { date: body.date || new Date().toISOString().slice(0, 10), queue: newQueue, updated_at: new Date().toISOString() };
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(raw, null, 2) + '\n');
      saveToDisk(readSchedule());
      return json(res, 200, { ok: true });
    }

    // POST /api/archive-day — archive current day and reset
    if (req.method === 'POST' && pathname === '/api/archive-day') {
      if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const current = readSchedule();
      archiveDay(current.date);
      const fresh = { date: new Date().toISOString().slice(0, 10), queue: [], updated_at: new Date().toISOString() };
      fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(fresh, null, 2) + '\n');
      saveToDisk(readSchedule());
      return json(res, 200, { ok: true });
    }

    // Health check
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: process.uptime() });
    }

    // --- Static file serving (fallback) ---
    const STATIC_ROOT = __dirname;
    const MIME_TYPES = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
    };

    let filePath = path.join(STATIC_ROOT, pathname === '/' ? 'index.html' : pathname);
    // Prevent directory traversal
    if (!filePath.startsWith(STATIC_ROOT)) return json(res, 403, { error: 'forbidden' });

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('Error:', e.message);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard server running on http://localhost:${PORT}`);
});
