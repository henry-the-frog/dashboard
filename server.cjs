#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DASHBOARD_PORT || 3000;
const TOKEN = process.env.DASHBOARD_TOKEN;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// Ensure dirs exist
fs.mkdirSync(HISTORY_DIR, { recursive: true });

// --- In-memory state ---
let dashboard = loadFromDisk() || {
  date: new Date().toISOString().slice(0, 10),
  queue: [],
  current: null,
  stats: { completed: 0, yielded: 0, skipped: 0, total_duration_ms: 0 },
  updated_at: new Date().toISOString()
};

function loadFromDisk() {
  const f = path.join(DATA_DIR, 'dashboard.json');
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  }
  return null;
}

function saveToDisk() {
  fs.writeFileSync(path.join(DATA_DIR, 'dashboard.json'), JSON.stringify(dashboard, null, 2) + '\n');
}

function archiveDay(date) {
  const src = path.join(DATA_DIR, 'dashboard.json');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(HISTORY_DIR, `${date}.json`));
  }
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
    // GET /api/dashboard — serve current state
    if (req.method === 'GET' && pathname === '/api/dashboard') {
      return json(res, 200, dashboard);
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

    // POST /api/task-update — task start/complete/session-ended
    if (req.method === 'POST' && pathname === '/api/task-update') {
      if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);

      if (!body.action) return json(res, 400, { error: 'missing action' });

      if (body.action === 'start') {
        dashboard.current = body.task || null;
        // Update queue task status
        if (body.task?.id) {
          const t = dashboard.queue.find(t => t.id === body.task.id);
          if (t) { t.status = 'in-progress'; t.started = new Date().toISOString(); }
        }
      } else if (body.action === 'complete') {
        if (body.task?.id) {
          const t = dashboard.queue.find(t => t.id === body.task.id);
          if (t) {
            t.status = 'done';
            t.completed = new Date().toISOString();
            if (body.task.summary) t.summary = body.task.summary;
            if (body.task.duration_ms) t.duration_ms = body.task.duration_ms;
          }
          dashboard.stats.completed++;
          if (body.task.duration_ms) dashboard.stats.total_duration_ms += body.task.duration_ms;
        }
        dashboard.current = null;
      } else if (body.action === 'session-ended') {
        dashboard.current = null;
      } else {
        return json(res, 400, { error: `unknown action: ${body.action}` });
      }

      dashboard.updated_at = new Date().toISOString();
      saveToDisk();
      return json(res, 200, { ok: true });
    }

    // POST /api/queue-update — full queue replacement
    if (req.method === 'POST' && pathname === '/api/queue-update') {
      if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);

      if (body.queue) {
        dashboard.queue = body.queue;
      } else if (Array.isArray(body)) {
        dashboard.queue = body;
      } else {
        return json(res, 400, { error: 'expected queue array' });
      }

      if (body.date) dashboard.date = body.date;

      // Recalculate stats from queue
      dashboard.stats.completed = dashboard.queue.filter(t => t.status === 'done').length;
      dashboard.stats.yielded = dashboard.queue.filter(t => t.status === 'blocked').length;
      dashboard.stats.skipped = dashboard.queue.filter(t => t.status === 'skipped').length;
      dashboard.stats.total_duration_ms = dashboard.queue.reduce((s, t) => s + (t.duration_ms || 0), 0);

      dashboard.updated_at = new Date().toISOString();
      saveToDisk();
      return json(res, 200, { ok: true });
    }

    // POST /api/archive-day — archive current day and reset
    if (req.method === 'POST' && pathname === '/api/archive-day') {
      if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
      archiveDay(dashboard.date);
      dashboard = {
        date: new Date().toISOString().slice(0, 10),
        queue: [],
        current: null,
        stats: { completed: 0, yielded: 0, skipped: 0, total_duration_ms: 0 },
        updated_at: new Date().toISOString()
      };
      saveToDisk();
      return json(res, 200, { ok: true });
    }

    // Health check
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: process.uptime() });
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
