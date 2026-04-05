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

  // Deduplicate blocks at same time slot (keep the one with more info, or first)
  const deduped = [];
  const seen = new Map();
  for (const block of blocks) {
    const existing = seen.get(block.time);
    if (existing) {
      // Keep whichever has more detail (longer task name, or done status)
      if (block.status === 'done' && existing.status !== 'done') {
        deduped[deduped.indexOf(existing)] = block;
        seen.set(block.time, block);
      }
      // Otherwise keep existing
    } else {
      seen.set(block.time, block);
      deduped.push(block);
    }
  }

  return { date, blocks: deduped, backlog, adjustments };
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

function fetchOpenPRs() {
  if (process.env.SKIP_GH === '1') return [];
  const { execSync } = require('child_process');
  try {
    const raw = execSync(
      'gh search prs --author henry-the-frog --state open --json number,title,url,repository,createdAt,updatedAt --limit 20',
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const prs = JSON.parse(raw);
    return prs.map(pr => {
      const repo = pr.repository?.nameWithOwner || '';
      // Fetch CI status and review state per PR
      let ciStatus = 'unknown';
      let reviewStatus = 'none';
      try {
        const checksRaw = execSync(
          `gh pr view ${pr.number} --repo ${repo} --json statusCheckRollup,reviewDecision`,
          { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const checksData = JSON.parse(checksRaw);
        const checks = checksData.statusCheckRollup || [];
        if (checks.length === 0) {
          ciStatus = 'none';
        } else if (checks.every(c => c.conclusion === 'SUCCESS')) {
          ciStatus = 'pass';
        } else if (checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR')) {
          ciStatus = 'fail';
        } else {
          ciStatus = 'pending';
        }
        reviewStatus = (checksData.reviewDecision || 'none').toLowerCase();
      } catch { /* skip enrichment on failure */ }

      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        repo,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        ageHours: Math.round((Date.now() - new Date(pr.createdAt).getTime()) / 3600000),
        ciStatus,
        reviewStatus,
      };
    });
  } catch (err) {
    console.warn('⚠️  Could not fetch PRs via gh CLI:', err.message);
    return [];
  }
}

function computeStreak(recentDays) {
  let streak = 0;
  const todayStr = today();
  const todayLog = readFile(`memory/${todayStr}.md`);
  if (todayLog && /^-\s+\d{1,2}:\d{2}/m.test(todayLog)) {
    streak = 1;
  } else {
    return 0;
  }
  for (const day of recentDays) {
    if (day.blocksCompleted > 0) streak++;
    else break;
  }
  return streak;
}

function fetchProjects() {
  if (process.env.SKIP_GH === '1') return [];
  const { execSync } = require('child_process');
  try {
    const raw = execSync(
      'gh repo list henry-the-frog --limit 200 --json name,description,url,pushedAt,primaryLanguage,stargazerCount,isPrivate',
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const repos = JSON.parse(raw).filter(r => !r.isPrivate);

    // Categorize projects
    const featured = new Set(['monkey-lang', 'ray-tracer', 'neural-net', 'chip8', 'dashboard', 'henry-the-frog.github.io', 'openclaw', 'webread']);
    const vizNames = new Set(['sorting-viz', 'game-of-life', 'fractals', 'pathfinding', 'physics']);
    const langNames = new Set(['lisp', 'brainfuck', 'tiny-vm', 'forth', 'prolog', 'lambda', 'pratt', 'type-infer', 'type-checker', 'proof-assistant', 'lisp-v2', 'datalog', 'sat', 'nfa-regex']);
    const dsNames = new Set(['linked-list', 'bst', 'trie', 'graph', 'bloom-filter', 'heap', 'hash-map', 'skip-list', 'ring-buffer', 'deque', 'union-find', 'bitset', 'fenwick', 'interval-tree', 'kd-tree', 'rope', 'btree', 'rbtree', 'arena']);

    return repos.map(r => {
      let category = 'utility';
      if (featured.has(r.name)) category = 'featured';
      else if (vizNames.has(r.name)) category = 'visual';
      else if (langNames.has(r.name)) category = 'language';
      else if (dsNames.has(r.name)) category = 'data-structure';
      else if (/parser|regex|json|csv|toml|yaml|ini|css-parser|markdown|sexpr|elf|xml|xpath/.test(r.name)) category = 'parser';

      return {
        name: r.name,
        description: r.description || '',
        url: r.url,
        language: r.primaryLanguage?.name || null,
        stars: r.stargazerCount || 0,
        pushedAt: r.pushedAt,
        category,
      };
    }).sort((a, b) => {
      // Featured first, then by push date
      const catOrder = { featured: 0, visual: 1, language: 2, parser: 3, 'data-structure': 4, utility: 5 };
      const ca = catOrder[a.category] ?? 5;
      const cb = catOrder[b.category] ?? 5;
      if (ca !== cb) return ca - cb;
      return new Date(b.pushedAt) - new Date(a.pushedAt);
    });
  } catch (e) {
    console.warn('⚠️  Failed to fetch projects:', e.message);
    return [];
  }
}

function parseBlogPosts() {
  const blogDir = process.env.BLOG_DIR || path.resolve(WORKSPACE, '..', '..', 'Projects', 'henry-the-frog.github.io', '_posts');
  const posts = [];
  try {
    const files = fs.readdirSync(blogDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
    for (const file of files) {
      const text = fs.readFileSync(path.join(blogDir, file), 'utf8');
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatter) continue;
      const fm = frontmatter[1];
      const title = (fm.match(/^title:\s*"?(.+?)"?\s*$/m) || [])[1] || file;
      const date = (fm.match(/^date:\s*(\S+)/m) || [])[1] || file.substring(0, 10);
      const cats = (fm.match(/^categories:\s*\[(.+)\]/m) || [])[1] || '';
      const categories = cats.split(',').map(c => c.trim().replace(/['"]/g, '')).filter(Boolean);
      // Generate URL slug from filename
      const slug = file.replace(/\.md$/, '').replace(/^(\d{4})-(\d{2})-(\d{2})-/, '$1/$2/$3/');
      const url = `https://henry-the-frog.github.io/${slug}`;
      // Word count for reading time
      const body = text.replace(/^---[\s\S]*?---/, '');
      const words = body.split(/\s+/).length;
      const readingTime = Math.max(1, Math.round(words / 200));
      posts.push({ title, date, url, categories, readingTime });
    }
  } catch { /* no blog dir */ }
  return posts;
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
    totalMinutes: totalMs > 0 ? Math.round(totalMs / 60000) : completed * 5,
    totalMs,
    avgDurationMs: completed > 0 && totalMs > 0 ? Math.round(totalMs / completed) : 0,
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

      // Source 2: Key Accomplishments / Major Deliverables bullets (narrative format)
      if (highlights.length < 3) {
        const sectionPat = /## (?:Key Accomplishments|Major Deliverables|Highlights)\n([\s\S]*?)(?=\n## |\n$)/;
        const accomMatch = text.match(sectionPat);
        if (accomMatch) {
          for (const line of accomMatch[1].split('\n')) {
            if (highlights.length >= 5) break;
            const m = line.match(/^-?\s*\*\*(.+?)\*\*/);
            if (m) {
              highlights.push(m[1].replace(/[:(]$/, '').trim());
            }
          }
        }
      }

      // Source 3: First-level bullets with substantive content
      if (highlights.length < 3) {
        for (const line of lines) {
          if (highlights.length >= 5) break;
          const m = line.match(/^-\s+(.{20,80})/);
          if (m && !m[1].startsWith('**') && !m[1].match(/^\d{1,2}:\d{2}/)) {
            let h = m[1];
            const dotIdx = h.indexOf('. ');
            if (dotIdx > 15 && dotIdx < 70) h = h.substring(0, dotIdx);
            else if (h.length > 60) h = h.substring(0, h.lastIndexOf(' ', 60) || 60);
            h = h.replace(/[.!]+$/, '').trim();
            if (h.length > 15) highlights.push(h);
          }
        }
      }

      // Count accomplishments as proxy for blocks if no work log
      let blocksCompleted = logEntries;
      if (blocksCompleted === 0) {
        const accomplishments = (text.match(/^-\s+\*\*/gm) || []).length;
        blocksCompleted = accomplishments;
      }

      // Try to extract block count from header text (e.g., "56/56 blocks" or "34 blocks")
      if (blocksCompleted <= 1) {
        const headerBlockMatch = text.match(/(\d+)\/(\d+)\s+blocks/);
        if (headerBlockMatch) {
          blocksCompleted = parseInt(headerBlockMatch[1], 10);
        } else {
          const simpleBlockMatch = text.match(/(\d{2,})\s+blocks/);
          if (simpleBlockMatch) blocksCompleted = parseInt(simpleBlockMatch[1], 10);
        }
      }

      // Also check block-times.jsonl for accurate historical counts
      try {
        const btPath = path.resolve(WORKSPACE, 'block-times.jsonl');
        if (fs.existsSync(btPath)) {
          const btLines = fs.readFileSync(btPath, 'utf8').split('\n').filter(Boolean);
          const dayCount = btLines.filter(l => {
            try { return JSON.parse(l).date === date; } catch { return false; }
          }).length;
          if (dayCount > blocksCompleted) blocksCompleted = dayCount;
        }
      } catch { /* ignore */ }

      // Extract mode distribution from log entries
      const modeDist = {};
      for (const line of lines) {
        const modeMatch = line.match(/^-\s+\d{1,2}:\d{2}\s+(\w+):/);
        if (modeMatch) {
          const mode = modeMatch[1].toUpperCase();
          if (['BUILD', 'THINK', 'EXPLORE', 'MAINTAIN'].includes(mode)) {
            modeDist[mode] = (modeDist[mode] || 0) + 1;
          }
        }
      }

      // Fallback mode distribution from narrative sections
      if (Object.keys(modeDist).length === 0) {
        // Count section headers as mode indicators
        if (text.match(/build|implement|added|fixed|publish/i)) modeDist.BUILD = Math.max(1, Math.round(blocksCompleted * 0.5));
        if (text.match(/explore|research|deep dive|consciousness/i)) modeDist.EXPLORE = Math.max(1, Math.round(blocksCompleted * 0.15));
        if (text.match(/think|reflect|review|assess/i)) modeDist.THINK = Math.max(1, Math.round(blocksCompleted * 0.2));
        if (text.match(/maintain|commit|cleanup|pr triage/i)) modeDist.MAINTAIN = Math.max(1, Math.round(blocksCompleted * 0.15));
      }

      days.push({ date, blocksCompleted, summary, highlights, modeDistribution: modeDist });
    }
  } catch { /* no memory dir */ }
  return days;
}

// --- Helpers ---
function today() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

function extractTodayHighlights(blocks) {
  const highlights = [];
  const keywords = ['published', 'opened pr', 'completed', 'fixed', 'built', 'wrote', 'launched', 'shipped'];
  for (const block of blocks) {
    if (block.status !== 'done' || !block.details) continue;
    const text = block.details.toLowerCase();
    if (keywords.some(kw => text.includes(kw))) {
      // Extract a short highlight from the details
      const detail = block.details;
      const firstSentence = detail.match(/^.{15,100}?[.!](?=\s|$)/);
      const highlight = firstSentence ? firstSentence[0] : detail.substring(0, 80).replace(/\s+\S*$/, '') + '…';
      highlights.push({
        mode: block.mode,
        time: block.time,
        text: highlight,
      });
    }
  }
  return highlights.slice(0, 8); // Cap at 8
}

function computeAdherence(blocks) {
  const now = new Date();
  const nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  
  // Only count blocks that should have happened by now
  const pastBlocks = blocks.filter(b => b.time <= nowStr);
  const doneBlocks = pastBlocks.filter(b => b.status === 'done');
  
  // Completion rate: how many past blocks got done
  const completionRate = pastBlocks.length > 0 ? Math.round((doneBlocks.length / pastBlocks.length) * 100) : 0;
  
  // Planned vs actual mode distribution
  const plannedDist = {};
  const actualDist = {};
  for (const b of blocks) {
    plannedDist[b.mode] = (plannedDist[b.mode] || 0) + 1;
  }
  for (const b of doneBlocks) {
    actualDist[b.mode] = (actualDist[b.mode] || 0) + 1;
  }

  // Pace: blocks completed per hour of elapsed work time
  const firstBlock = blocks[0];
  const lastDone = [...doneBlocks].reverse()[0];
  let pace = 0;
  if (firstBlock && lastDone) {
    const [fh, fm] = firstBlock.time.split(':').map(Number);
    const [nh, nm] = nowStr.split(':').map(Number);
    const elapsedHours = ((nh * 60 + nm) - (fh * 60 + fm)) / 60;
    if (elapsedHours > 0) pace = +(doneBlocks.length / elapsedHours).toFixed(1);
  }

  return {
    completionRate,
    completedBlocks: doneBlocks.length,
    pastBlocks: pastBlocks.length,
    totalBlocks: blocks.length,
    plannedDist,
    actualDist,
    pace,
  };
}

function parseBenchmarks() {
  const benchDir = path.resolve(WORKSPACE, 'projects', 'monkey-lang', 'benchmarks');
  try {
    const latestPath = path.join(benchDir, 'latest.json');
    if (!fs.existsSync(latestPath)) return null;
    const data = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    
    // Summarize: pick key benchmarks and compute aggregate
    const results = (data.benchmarks || []).map(b => ({
      name: b.name,
      category: b.category,
      jitVsVm: b.speedup?.jitVsVm || 0,
      jitVsEval: b.speedup?.jitVsEval || 0,
      traces: b.traces || 0,
      correct: b.correct,
    }));
    
    // Aggregate speedup (geometric mean of jitVsVm for correct benchmarks)
    const valid = results.filter(r => r.correct && r.jitVsVm > 0);
    const geoMean = valid.length > 0
      ? Math.exp(valid.reduce((sum, r) => sum + Math.log(r.jitVsVm), 0) / valid.length)
      : 0;
    
    return {
      timestamp: data.timestamp,
      gitHash: data.gitHash,
      count: results.length,
      aggregate: +geoMean.toFixed(2),
      results,
    };
  } catch { return null; }
}

function computeVitalStats(projects, blogPosts, recentDays, streak) {
  // Auto-discover all projects under projects/
  const projectsDir = path.resolve(WORKSPACE, 'projects');
  const testCounts = {};
  let totalTests = 0;
  let totalProjectCount = 0;
  try {
    const entries = fs.readdirSync(projectsDir);
    for (const name of entries) {
      const fullPath = path.join(projectsDir, name);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      const count = countTestsInProject(fullPath);
      if (count > 0) {
        testCounts[name] = count;
        totalTests += count;
      }
      totalProjectCount++;
    }
  } catch { /* no projects dir */ }

  // Count all repos
  const totalRepos = projects.length;

  // Total blog posts
  const totalBlogPosts = blogPosts.length;

  // Total tasks completed this week
  const totalTasksWeek = recentDays.reduce((s, d) => s + (d.blocksCompleted || 0), 0);

  // Days active
  const daysActive = recentDays.filter(d => d.blocksCompleted > 0).length;

  return {
    totalTests,
    testCounts,
    totalRepos,
    totalProjectCount,
    totalBlogPosts,
    streak,
    totalTasksWeek,
    daysActive,
  };
}

function countTestsInProject(projectDir) {
  // Count test assertions by scanning test files (fast, no subprocess)
  try {
    let count = 0;
    const scanDir = (d) => {
      try {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f);
          const st = fs.statSync(fp);
          if (st.isDirectory() && !f.startsWith('.') && f !== 'node_modules') {
            scanDir(fp);
          } else if (f.endsWith('.test.js') || f.endsWith('.test.mjs') || f.endsWith('_test.js')) {
            try {
              const text = fs.readFileSync(fp, 'utf8');
              // Count it() / test() calls and assert lines
              const itCalls = (text.match(/\b(?:it|test)\s*\(/g) || []).length;
              const asserts = (text.match(/\b(?:assert|strictEqual|deepEqual|throws|ok)\s*[.(]/g) || []).length;
              count += itCalls || Math.ceil(asserts / 2) || 1;
            } catch {}
          }
        }
      } catch {}
    };
    scanDir(projectDir);
    return count;
  } catch {
    return 0;
  }
}

function computeProjectDepth() {
  // Auto-discover all projects under projects/
  const projectsDir = path.resolve(WORKSPACE, 'projects');
  const allProjects = [];

  // Category keywords for auto-classification
  const categoryRules = [
    { category: 'language', keywords: ['lisp', 'prolog', 'forth', 'brainfuck', 'lambda', 'minikanren', 'datalog', 'interpreter', 'monkey-lang', 'tiny-vm', 'pratt', 'peg'] },
    { category: 'compiler', keywords: ['compiler', 'type-infer', 'type-inference', 'type-checker', 'typechecker', 'bytecode-vm', 'wasm-interpreter', 'elf-gen', 'elf-parser', 'proof-assistant'] },
    { category: 'solver', keywords: ['sat', 'smt', 'csp', 'constraint'] },
    { category: 'data-structure', keywords: ['btree', 'bst', 'rbtree', 'red-black', 'trie', 'heap', 'skip-list', 'skiplist', 'ring-buffer', 'deque', 'linked-list', 'rope', 'arena', 'interval-tree', 'kd-tree', 'kdtree', 'fenwick', 'union-find', 'bloom-filter', 'bloom-clock', 'bimap', 'multimap', 'ordered-map', 'lru', 'data-structures', 'merkle', 'crdt', 'immutable', 'bitset', 'bits', 'hash-map'] },
    { category: 'algorithm', keywords: ['sorting', 'graph-algorithms', 'astar', 'pathfinding', 'binary-search', 'toposort', 'diff', 'minimax', 'fft', 'markov', 'dp', 'dep-resolver'] },
    { category: 'parser', keywords: ['parser', 'json-parser', 'csv', 'toml', 'yaml', 'ini', 'xml', 'xpath', 'sexpr', 'markdown', 'css-parser', 'regex', 'nfa-regex', 'automata', 'automaton', 'peg', 'parsec', 'tokenizer', 'protobuf', 'cbor', 'msgpack', 'asn1'] },
    { category: 'systems', keywords: ['tcp-ip', 'tiny-os', 'dns', 'http', 'websocket', 'bittorrent', 'raft', 'henrydb', 'kv-store', 'sql-engine', 'henry-redis', 'tiny-git', 'ecs', 'event-loop'] },
    { category: 'visual', keywords: ['ray-tracer', 'sdf-renderer', 'ray-marcher', 'boids', 'particle-life', 'game-of-life', 'cellular', 'fractal', 'lsystem', 'sorting-viz', 'fractals', 'genetic-art'] },
    { category: 'ml', keywords: ['neural-net', 'genetic', 'tensor'] },
    { category: 'crypto', keywords: ['crypto', 'cipher', 'sha256', 'jwt', 'blockchain', 'crc32'] },
    { category: 'physics', keywords: ['physics', 'gc-simulator', 'gc'] },
  ];

  // Icon map for known projects
  const iconMap = {
    'monkey-lang': '🐒', 'ray-tracer': '🌈', 'neural-net': '🧠', 'physics': '⚛️',
    'genetic-art': '🧬', 'prolog': '🔮', 'minikanren': '🧩', 'boids': '🐦',
    'sat': '🧮', 'chess-engine': '♟️', 'henrydb': '🗄️', 'lambda-calculus': 'λ',
    'forth': '📚', 'type-inference': '🔤', 'smt-solver': '⚡', 'compiler-backend': '⚙️',
    'lisp': '🔮', 'tiny-os': '💻', 'tcp-ip': '🌐', 'wasm-interpreter': '🔧',
  };

  try {
    const entries = fs.readdirSync(projectsDir);
    for (const name of entries) {
      const fullPath = path.join(projectsDir, name);
      if (!fs.statSync(fullPath).isDirectory()) continue;

      const info = getProjectInfo(fullPath);
      if (info.tests === 0 && info.srcFiles === 0) continue; // skip empty dirs

      // Auto-categorize
      let category = 'utility';
      for (const rule of categoryRules) {
        if (rule.keywords.some(kw => name.includes(kw))) {
          category = rule.category;
          break;
        }
      }

      // Read first line of README for description
      let description = '';
      try {
        const readme = fs.readFileSync(path.join(fullPath, 'README.md'), 'utf8');
        const descMatch = readme.match(/^#[^\n]*\n+([^\n]+)/);
        if (descMatch) description = descMatch[1].replace(/[*_]/g, '').trim().substring(0, 100);
      } catch {}

      allProjects.push({
        name,
        dir: `projects/${name}`,
        icon: iconMap[name] || '📦',
        description,
        category,
        ...info,
        url: `https://github.com/henry-the-frog/${name}`,
        demoUrl: `https://henry-the-frog.github.io/${name}/`,
      });
    }
  } catch { /* no projects dir */ }

  // Sort: by test count descending (deepest projects first)
  allProjects.sort((a, b) => b.tests - a.tests);

  return allProjects;
}

function getProjectInfo(dir) {
  const fs = require('fs');
  try {
    // Count test files
    const testCount = countTestsInProject(dir);

    // Count source files
    let srcFiles = 0;
    let srcLines = 0;
    const countDir = (d) => {
      try {
        for (const f of fs.readdirSync(d)) {
          const fp = path.join(d, f);
          const st = fs.statSync(fp);
          if (st.isDirectory() && !f.startsWith('.') && f !== 'node_modules') {
            countDir(fp);
          } else if (f.endsWith('.js') || f.endsWith('.mjs')) {
            srcFiles++;
            try { srcLines += fs.readFileSync(fp, 'utf8').split('\n').length; } catch {}
          }
        }
      } catch {}
    };
    countDir(dir);

    // Read README for feature count
    let features = [];
    try {
      const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
      // Count feature bullet points
      const featureSection = readme.match(/## Features?\n([\s\S]*?)(?=\n## |\n$)/);
      if (featureSection) {
        features = (featureSection[1].match(/^[-*]\s+/gm) || []);
      }
    } catch {}

    // Get last commit date
    let lastCommit = null;
    try {
      const { execSync } = require('child_process');
      lastCommit = execSync('git log -1 --format=%ci 2>/dev/null', { cwd: dir, encoding: 'utf8', timeout: 5000 }).trim();
    } catch {}

    return {
      tests: testCount,
      srcFiles,
      srcLines,
      featureCount: features.length,
      lastCommit,
    };
  } catch {
    return { tests: 0, srcFiles: 0, srcLines: 0, featureCount: 0, lastCommit: null };
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

  // Extract today's highlights (notable completions from the log)
  const todayHighlights = extractTodayHighlights(schedule.blocks);

  // Fetch open PRs
  const prs = fetchOpenPRs();

  // Parse blog posts
  const blogPosts = parseBlogPosts();

  // Schedule adherence: compare planned mode distribution vs actual
  const scheduleAdherence = computeAdherence(schedule.blocks);

  // Streak: consecutive active days
  const streak = computeStreak(recentDays);

  // Parse JIT benchmarks
  const benchmarks = parseBenchmarks();

  // Fetch projects from GitHub
  const projects = fetchProjects();

  // Compute vital stats (aggregate numbers across all projects)
  const vitalStats = computeVitalStats(projects, blogPosts, recentDays, streak);

  // Compute project depth cards for featured projects
  const projectDepth = computeProjectDepth();

  const dashboard = {
    generated: new Date().toISOString(),
    current,
    schedule,
    adjustments: schedule.adjustments || [],
    stats,
    artifacts,
    blockers: [],
    recentDays,
    todayHighlights,
    prs,
    blogPosts,
    scheduleAdherence,
    streak,
    benchmarks,
    projects,
    vitalStats,
    projectDepth,
  };

  // Ensure output directory exists
  const outDir = path.dirname(OUTPUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUTPUT, JSON.stringify(dashboard, null, 2));

  // Also write rich.json so the server API serves vitalStats, projectDepth, etc.
  const RICH_KEYS = ['artifacts', 'benchmarks', 'blogPosts', 'prs', 'recentDays',
    'streak', 'scheduleAdherence', 'todayHighlights', 'adjustments', 'blockers', 'projects',
    'vitalStats', 'projectDepth'];
  const rich = {};
  for (const key of RICH_KEYS) {
    if (dashboard[key] !== undefined) rich[key] = dashboard[key];
  }
  rich.generated = dashboard.generated;
  fs.writeFileSync(path.join(path.dirname(OUTPUT), 'rich.json'), JSON.stringify(rich, null, 2));
  
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
