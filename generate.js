#!/usr/bin/env node
// generate.js — Parse workspace files into dashboard.json
// Usage: node generate.js [--workspace /path] [--output /path/to/dashboard.json] [--validate]

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
    next: get('next') || '',
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
      const m = line.match(/^-\s+(\d{1,2}:\d{2})(?:[–-](\d{1,2}:\d{2}))?\s+(🧠|🔨|🔍|🔧)\s+(\w+)\s+[-—]\s+(.+)/);
      if (!m) continue;

      const modeMap = { '🧠': 'THINK', '🔨': 'BUILD', '🔍': 'EXPLORE', '🔧': 'MAINTAIN' };
      const rawTask = m[5];
      const startTime = normalizeTime(m[1]);
      const endTime = m[2] ? normalizeTime(m[2]) : null;

      // Determine status from markers
      let status = 'upcoming';
      let task = rawTask;
      if (rawTask.includes('✅')) {
        status = 'done';
        task = task.replace('✅', '').trim();
      }

      // Expand time ranges into individual 15-min blocks
      const times = [startTime];
      if (endTime) {
        let [h, min] = startTime.split(':').map(Number);
        const [eh, emin] = endTime.split(':').map(Number);
        while (true) {
          min += 15;
          if (min >= 60) { h++; min -= 60; }
          const t = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
          if (h > eh || (h === eh && min > emin)) break;
          times.push(t);
        }
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

      for (const time of times) {
        blocks.push({
          time,
          mode: modeMap[m[3]] || m[4],
          task,
          status,
          summary: '',
          artifacts: [],
          details: '',
        });
      }
    }
  }

  // Adjustments section
  const adjustments = [];
  const adjMatch = text.match(/## Adjustments\n([\s\S]*?)(?=\n## |\n$)/);
  if (adjMatch) {
    for (const line of adjMatch[1].split('\n')) {
      const m = line.match(/^-\s+(.+)/);
      if (m) adjustments.push(m[1].trim());
    }
  }

  return { date, blocks, backlog, adjustments };
}

function parseDailyLog(text, blocks) {
  if (!text) return blocks;

  // Extract work log entries: "- HH:MM MODE: description"
  const logEntries = [];
  // Match various log section headers — grab everything after ## Log until end of file
  // (other ## headers within the log are block-style entries, not section breaks)
  const logMatch = text.match(/## (?:Work )?Log\n([\s\S]*?)$/);
  if (logMatch) {
    for (const line of logMatch[1].split('\n')) {
      // Match "HH:MM MODE:" or "HH:MM — MODE:" or "HH:MM —" formats
      const m = line.match(/^-\s+(\d{1,2}:\d{2})\s+(?:[-—]\s+)?(\w+)?[:\s]+[-—]?\s*(.+)/);
      if (m) {
        const time = normalizeTime(m[1]);
        logEntries.push({ time, mode: m[2] || '', text: m[3] });
      }
    }
  }

  // Also scan full text for block-style entries: "## HH:MM MODE — description"
  const blockHeaders = text.matchAll(/^## (\d{1,2}:\d{2})\s+(\w+)\s+[-—]\s+(.+)/gm);
  for (const bm of blockHeaders) {
    const time = normalizeTime(bm[1]);
    // Grab text until next ## header
    const startIdx = bm.index + bm[0].length;
    const nextHeader = text.indexOf('\n## ', startIdx);
    const body = text.substring(startIdx, nextHeader > 0 ? nextHeader : text.length).trim();
    const summary = bm[3];
    logEntries.push({ time, mode: bm[2], text: summary + (body ? ' ' + body.split('\n')[0] : '') });
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

// Extract project artifacts from TASKS.md (repos, blog, PRs)
function parseProjectArtifacts(tasksText) {
  if (!tasksText) return [];
  const artifacts = [];
  const seen = new Set();

  // Match URLs in tasks (including bare domain references like **github.com/foo/bar**)
  const urlPattern = /https?:\/\/[^\s)>\]]+/g;
  const bareDomainPattern = /\*\*([a-z0-9-]+\.github\.io(?:\/[^\s*]+)?|github\.com\/[^\s*]+)\*\*/g;
  const lines = tasksText.split('\n');
  for (const line of lines) {
    // Full URLs
    const urls = line.match(urlPattern) || [];
    // Bare domain refs in bold
    let m;
    while ((m = bareDomainPattern.exec(line)) !== null) {
      urls.push('https://' + m[1]);
    }
    bareDomainPattern.lastIndex = 0;

    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);

      let type = 'link';
      let title = '';
      if (url.includes('/pull/')) {
        type = 'pr';
        title = 'PR #' + (url.match(/\/pull\/(\d+)/)?.[1] || '');
      } else if (url.includes('github.io')) {
        type = 'site';
        const parts = url.replace(/https?:\/\//, '').split('/');
        title = parts[0].replace('.github.io', '') + (parts[1] ? '/' + parts[1] : '');
      } else if (url.includes('github.com')) {
        type = 'repo';
        const m = url.match(/github\.com\/([^/]+\/[^/\s]+)/);
        title = m ? m[1] : url.split('/').pop();
      }
      if (!title) title = url.split('/').slice(-2).join('/').replace(/-/g, ' ');

      const desc = line.replace(/^[\s\-\[\]x*]+/, '').replace(urlPattern, '').replace(bareDomainPattern, '').replace(/[→*]+/g, '').replace(/\s+/g, ' ').trim();

      artifacts.push({ type, title, url, description: desc.substring(0, 100) });
    }
  }

  // Match PR references like PR #50001 without URLs
  for (const line of lines) {
    const prRefs = line.match(/PR\s+#(\d+)/g);
    if (!prRefs) continue;
    for (const ref of prRefs) {
      const num = ref.match(/#(\d+)/)[1];
      const url = `https://github.com/danny-avila/LibreChat/pull/${num}`;
      if (seen.has(url)) continue;
      seen.add(url);
      const desc = line.replace(/^[\s\-\[\]x*]+/, '').replace(/[*]/g, '').trim();
      artifacts.push({ type: 'pr', title: `PR #${num}`, url, description: desc.substring(0, 100) });
    }
  }

  return artifacts;
}

function parseBlockTimes(workspace) {
  const timesFile = path.resolve(workspace, 'block-times.jsonl');
  const times = {};
  try {
    const lines = fs.readFileSync(timesFile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.slot && entry.date === today()) {
          times[entry.slot] = {
            startedAt: entry.startedAt,
            completedAt: entry.completedAt,
            durationMs: entry.durationMs,
          };
        }
      } catch { /* skip bad lines */ }
    }
  } catch { /* file doesn't exist yet */ }
  return times;
}

function applyBlockTimes(blocks, workspace) {
  const times = parseBlockTimes(workspace);
  for (const block of blocks) {
    const timing = times[block.time];
    if (timing) {
      block.startedAt = timing.startedAt;
      block.completedAt = timing.completedAt;
      block.durationMs = timing.durationMs;
      block.durationFormatted = formatDuration(timing.durationMs);
    }
  }
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
}

function computeStats(blocks) {
  const completed = blocks.filter(b => b.status === 'done').length;
  const dist = {};
  let totalMs = 0;
  for (const b of blocks.filter(b => b.status === 'done')) {
    dist[b.mode] = (dist[b.mode] || 0) + 1;
    if (b.durationMs) totalMs += b.durationMs;
  }
  return {
    blocksCompleted: completed,
    blocksTotal: blocks.length,
    modeDistribution: dist,
    totalMinutes: totalMs > 0 ? Math.round(totalMs / 60000) : completed * 5, // estimate 5min if no timing data
    totalMs,
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

// Normalize time to 24h format (work blocks run 8:00-22:00, so times 1:00-7:59 are PM)
function normalizeTime(timeStr) {
  let [h, m] = timeStr.split(':').map(Number);
  if (h < 8) h += 12; // 1:15 → 13:15, 2:30 → 14:30, etc.
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

  // Apply real timing data
  applyBlockTimes(schedule.blocks, WORKSPACE);

  // Mark current block
  markCurrentBlock(schedule.blocks, current);

  const stats = computeStats(schedule.blocks);
  const blockArtifacts = extractArtifacts(schedule.blocks);
  const tasksText = readFile('TASKS.md');
  const projectArtifacts = parseProjectArtifacts(tasksText);
  // Merge: project artifacts first, then block artifacts (dedup by URL)
  const seenUrls = new Set();
  const artifacts = [];
  for (const a of [...projectArtifacts, ...blockArtifacts]) {
    if (!seenUrls.has(a.url)) {
      seenUrls.add(a.url);
      artifacts.push(a);
    }
  }
  const recentDays = parseRecentDays();

  const dashboard = {
    generated: new Date().toISOString(),
    current,
    schedule,
    adjustments: schedule.adjustments || [],
    stats,
    artifacts,
    blockers: [],
    recentDays,
  };

  // Ensure output directory exists
  const outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUTPUT, JSON.stringify(dashboard, null, 2));
  
  // Auto-validate: warn about format issues during normal generation
  const warnings = [];
  if (schedule.blocks.length < 10) {
    warnings.push(`Only ${schedule.blocks.length} blocks parsed from SCHEDULE.md (expected 50+). Check time format (use 24h).`);
  }
  const logEntryCount = schedule.blocks.filter(b => b.status === 'done').length;
  const logLines = dailyLogText ? (dailyLogText.match(/^-\s+\d{1,2}:\d{2}/gm) || []).length : 0;
  if (logLines > 0 && logEntryCount < logLines * 0.5) {
    warnings.push(`Only ${logEntryCount}/${logLines} log entries matched to schedule blocks. Check time format consistency.`);
  }
  if (warnings.length) {
    console.log(`⚠️  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`  - ${w}`));
  }
  
  console.log(`✅ Generated ${OUTPUT} (${schedule.blocks.length} blocks, ${stats.blocksCompleted} done)`);
}

function validate() {
  const scheduleText = readFile('SCHEDULE.md');
  const dailyLogText = readFile(`memory/${today()}.md`);
  const errors = [];
  const warnings = [];

  // Validate SCHEDULE.md
  if (!scheduleText) {
    errors.push('SCHEDULE.md not found');
  } else {
    const timelineMatch = scheduleText.match(/## Timeline\n([\s\S]*?)(?=\n## |\n$)/);
    if (!timelineMatch) {
      errors.push('SCHEDULE.md: missing ## Timeline section');
    } else {
      const lines = timelineMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
      const timeRe = /^-\s+(\d{1,2}:\d{2})(?:[–-](\d{1,2}:\d{2}))?\s+(🧠|🔨|🔍|🔧)\s+(\w+)\s+[-—]\s+(.+)/;
      let parsed = 0;
      for (const line of lines) {
        if (timeRe.test(line)) {
          parsed++;
        } else {
          errors.push(`SCHEDULE.md: unparseable line: ${line.substring(0, 80)}`);
        }
      }
      if (parsed < 10) {
        warnings.push(`SCHEDULE.md: only ${parsed} blocks parsed (expected 50+)`);
      }
      console.log(`📋 SCHEDULE.md: ${parsed}/${lines.length} lines parsed`);
    }
  }

  // Validate daily log
  if (!dailyLogText) {
    warnings.push(`memory/${today()}.md not found (okay if day just started)`);
  } else {
    const logMatch = dailyLogText.match(/## (?:Work )?Log\n([\s\S]*?)$/);
    const entryRe = /^-\s+(\d{1,2}:\d{2})\s+(?:[-—]\s+)?(\w+)?[:\s]+[-—]?\s*(.+)/;
    if (logMatch) {
      const lines = logMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
      let parsed = 0;
      for (const line of lines) {
        if (entryRe.test(line)) {
          parsed++;
        } else if (line.trim().length > 3) {
          warnings.push(`Daily log: unparseable entry: ${line.substring(0, 80)}`);
        }
      }
      console.log(`📝 Daily log: ${parsed}/${lines.length} entries parsed`);
    }
  }

  // Validate CURRENT.md
  const currentText = readFile('CURRENT.md');
  if (!currentText) {
    warnings.push('CURRENT.md not found');
  } else {
    const required = ['status', 'mode', 'task'];
    for (const field of required) {
      if (!new RegExp(`^${field}:`, 'm').test(currentText)) {
        errors.push(`CURRENT.md: missing required field '${field}'`);
      }
    }
    console.log('📄 CURRENT.md: OK');
  }

  // Report
  if (errors.length) {
    console.log(`\n❌ ${errors.length} error(s):`);
    errors.forEach(e => console.log(`  - ${e}`));
  }
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`  - ${w}`));
  }
  if (!errors.length && !warnings.length) {
    console.log('\n✅ All files valid!');
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

if (args.includes('--validate')) {
  validate();
} else {
  generate();
}
