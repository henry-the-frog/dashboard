#!/usr/bin/env node
// generate.js — Parse workspace files into dashboard.json
// Usage: node generate.js [--workspace /path] [--output /path/to/dashboard.json]

'use strict';

const fs = require('fs');
const path = require('path');

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const WORKSPACE = getArg('workspace', path.resolve(__dirname, '..'));
const OUTPUT = getArg('output', path.join(__dirname, 'data', 'dashboard.json'));

// --- File readers ---
function readFile(relPath) {
  const full = path.resolve(WORKSPACE, relPath);
  try { return fs.readFileSync(full, 'utf8'); } catch { return null; }
}

// --- Parsers ---

function parseCurrent(text) {
  if (!text) return { status: 'idle', mode: 'THINK', task: 'No data', context: '' };
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    status: get('status') || 'idle',
    mode: get('mode') || 'THINK',
    task: get('task') || '',
    context: get('context') || '',
    startedAt: get('updated') || new Date().toISOString(),
    estimatedBlocks: parseInt(get('est'), 10) || 0,
  };
}

function parseSchedule(text) {
  if (!text) return { date: today(), blocks: [], backlog: [] };

  // Date from header
  const dateMatch = text.match(/^#\s*Schedule\s*[-—]\s*(\d{4}-\d{2}-\d{2})/m);
  const date = dateMatch ? dateMatch[1] : today();

  // Backlog section
  const backlog = [];
  const backlogMatch = text.match(/## Backlog\n([\s\S]*?)(?=\n## |\n$)/);
  if (backlogMatch) {
    for (const line of backlogMatch[1].split('\n')) {
      const m = line.match(/^-\s+(.+)/);
      if (m) backlog.push(m[1].trim());
    }
  }

  // Timeline section
  const blocks = [];
  const timelineMatch = text.match(/## Timeline\n([\s\S]*?)(?=\n## |\n$)/);
  if (timelineMatch) {
    for (const line of timelineMatch[1].split('\n')) {
      const m = line.match(/^-\s+(\d{2}:\d{2})\s+(🧠|🔨|🔍|🔧)\s+(\w+)\s+[-—]\s+(.+)/);
      if (!m) continue;

      const modeMap = { '🧠': 'THINK', '🔨': 'BUILD', '🔍': 'EXPLORE', '🔧': 'MAINTAIN' };
      const rawTask = m[4];

      // Determine status from markers
      let status = 'upcoming';
      let task = rawTask;
      if (rawTask.includes('✅')) {
        status = 'done';
        task = task.replace('✅', '').trim();
      }
      // Strikethrough indicates replaced
      const strikeMatch = task.match(/~~(.+?)~~/);
      if (strikeMatch) {
        // Use the replacement text after → if present
        const arrow = task.match(/→\s*\*\*(.+?)\*\*/);
        if (arrow) task = arrow[1];
        else {
          // Use the struck-through text as the task (it was done, just marked)
          const inner = strikeMatch[1].trim();
          task = task.replace(/~~.+?~~\s*/, '').trim() || inner;
        }
      }
      // Clean up bold markers
      task = task.replace(/\*\*/g, '').trim();

      blocks.push({
        time: m[1],
        mode: modeMap[m[2]] || m[3],
        task,
        status,
        summary: '',
        artifacts: [],
        details: '',
      });
    }
  }

  return { date, blocks, backlog };
}

function parseDailyLog(text, blocks) {
  if (!text) return blocks;

  // Extract work log entries: "- HH:MM MODE: description"
  const logEntries = [];
  const logMatch = text.match(/## Work Log\n([\s\S]*?)(?=\n## |\n$)/);
  if (logMatch) {
    for (const line of logMatch[1].split('\n')) {
      const m = line.match(/^-\s+(\d{2}:\d{2})\s+(\w+):\s+(.+)/);
      if (m) logEntries.push({ time: m[1], mode: m[2], text: m[3] });
    }
  }

  // Match log entries to blocks by time
  for (const entry of logEntries) {
    const block = blocks.find(b => b.time === entry.time);
    if (block) {
      block.status = 'done';
      block.details = entry.text;
      // Generate summary (first sentence, or truncate at word boundary ~80 chars)
      // Sentence end: period/exclamation followed by space or EOL (avoids URLs, abbreviations)
      const firstSentence = entry.text.match(/^.{20,120}?[.!](?=\s|$)/);
      if (firstSentence) {
        block.summary = firstSentence[0];
      } else {
        // Truncate at word boundary
        const truncated = entry.text.substring(0, 90);
        const lastSpace = truncated.lastIndexOf(' ');
        block.summary = (lastSpace > 40 ? truncated.substring(0, lastSpace) : truncated) + '…';
      }

      // Extract artifacts: URLs in the text
      const urls = entry.text.match(/https?:\/\/[^\s),]+/g);
      if (urls) {
        for (const url of urls) {
          const type = url.includes('/pull/') ? 'pr'
            : url.includes('github.com') ? 'repo'
            : 'link';
          const title = url.split('/').pop().replace(/-/g, ' ');
          block.artifacts.push({ type, title, url });
        }
      }
    }
  }

  // Done blocks without log entries get a placeholder summary
  for (const block of blocks) {
    if (block.status === 'done' && !block.summary) {
      block.summary = 'Completed';
    }
  }

  return blocks;
}

function extractArtifacts(blocks) {
  const seen = new Set();
  const artifacts = [];
  for (const block of blocks) {
    for (const a of block.artifacts) {
      if (!seen.has(a.url)) {
        seen.add(a.url);
        artifacts.push({ ...a, description: '' });
      }
    }
  }
  return artifacts;
}

function computeStats(blocks) {
  const completed = blocks.filter(b => b.status === 'done').length;
  const dist = {};
  for (const b of blocks.filter(b => b.status === 'done')) {
    dist[b.mode] = (dist[b.mode] || 0) + 1;
  }
  return {
    blocksCompleted: completed,
    blocksTotal: blocks.length,
    modeDistribution: dist,
    totalMinutes: completed * 15,
  };
}

function parseRecentDays() {
  const days = [];
  const memDir = path.resolve(WORKSPACE, 'memory');
  const todayStr = today();
  try {
    const files = fs.readdirSync(memDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/) && f.replace('.md', '') !== todayStr)
      .sort()
      .reverse()
      .slice(0, 6);

    for (const file of files) {
      const text = fs.readFileSync(path.join(memDir, file), 'utf8');
      const date = file.replace('.md', '');

      // Count work log entries (structured format)
      const logEntries = (text.match(/^-\s+\d{2}:\d{2}\s+\w+:/gm) || []).length;

      // Extract summary line
      const summaryMatch = text.match(/^## Summary\n(.+)/m);
      const summary = summaryMatch ? summaryMatch[1].trim() : '';

      // Extract highlights from multiple sources
      const highlights = [];

      // Source 1: Work Log entries (structured)
      const lines = text.split('\n');
      for (const line of lines) {
        const m = line.match(/^-\s+\d{2}:\d{2}\s+\w+:\s+(.{10,80})/);
        if (m && highlights.length < 5) {
          // Truncate at first period-space or 60 chars
          let h = m[1];
          const dotIdx = h.indexOf('. ');
          if (dotIdx > 15 && dotIdx < 70) h = h.substring(0, dotIdx);
          else if (h.length > 60) {
            const sp = h.lastIndexOf(' ', 60);
            h = h.substring(0, sp > 30 ? sp : 60);
          }
          h = h.replace(/[.!]+$/, '').trim();
          if (h.length > 15) highlights.push(h);
        }
      }

      // Source 2: Key Accomplishments bullets (narrative format)
      if (highlights.length < 3) {
        const accomMatch = text.match(/## Key Accomplishments\n([\s\S]*?)(?=\n## |\n$)/);
        if (accomMatch) {
          for (const line of accomMatch[1].split('\n')) {
            if (highlights.length >= 5) break;
            const m = line.match(/^-\s+\*\*(.+?)\*\*/);
            if (m) {
              highlights.push(m[1].replace(/:$/, '').trim());
            }
          }
        }
      }

      // Count accomplishments as proxy for blocks if no work log
      let blocksCompleted = logEntries;
      if (blocksCompleted === 0) {
        const accomplishments = (text.match(/^-\s+\*\*/gm) || []).length;
        blocksCompleted = accomplishments;
      }

      days.push({ date, blocksCompleted, summary, highlights });
    }
  } catch { /* no memory dir */ }
  return days;
}

// --- Helpers ---
function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- Mark current block as in-progress ---
function markCurrentBlock(blocks, current) {
  if (current.status !== 'in-progress') return;
  // Find the block matching current task time or the first upcoming
  const updated = current.startedAt || '';
  const timeMatch = updated.match(/T(\d{2}:\d{2})/);
  if (timeMatch) {
    const block = blocks.find(b => b.time === timeMatch[1]);
    if (block && block.status !== 'done') {
      block.status = 'in-progress';
      block.summary = current.context || block.summary;
      return;
    }
  }
  // Fallback: first non-done block
  const next = blocks.find(b => b.status === 'upcoming');
  if (next) {
    next.status = 'in-progress';
    next.summary = current.context || next.summary;
  }
}

// --- Main ---
function generate() {
  const currentText = readFile('CURRENT.md');
  const scheduleText = readFile('SCHEDULE.md');
  const dailyLogText = readFile(`memory/${today()}.md`);

  const current = parseCurrent(currentText);
  const schedule = parseSchedule(scheduleText);

  // Enrich blocks from daily log
  parseDailyLog(dailyLogText, schedule.blocks);

  // Mark current block
  markCurrentBlock(schedule.blocks, current);

  const stats = computeStats(schedule.blocks);
  const artifacts = extractArtifacts(schedule.blocks);
  const recentDays = parseRecentDays();

  const dashboard = {
    generated: new Date().toISOString(),
    current,
    schedule,
    stats,
    artifacts,
    blockers: [],
    recentDays,
  };

  // Ensure output directory exists
  const outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUTPUT, JSON.stringify(dashboard, null, 2));
  console.log(`✅ Generated ${OUTPUT} (${schedule.blocks.length} blocks, ${stats.blocksCompleted} done)`);
}

generate();
