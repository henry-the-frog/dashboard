#!/usr/bin/env node
// test/generate.test.js — Unit + integration tests for generate.js
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`❌ ${name}: ${e.message}`); process.exit(1); }
}

// --- Load parsers by extracting them (they're module-scoped, so we re-require via generate) ---
// For unit tests, we'll inline the parser logic or test via full generation with fixtures.
// Strategy: create temp fixture files, run generate against them, validate output.

// Use local date (not UTC) to match generate.cjs today() function
function localToday(offset = 0) {
  const d = new Date(Date.now() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const FIXTURES = path.join(__dirname, 'fixtures');
const TEMP_WS = path.join(__dirname, 'temp-workspace');

function setup() {
  // Clean any leftover state from previous runs
  fs.rmSync(TEMP_WS, { recursive: true, force: true });
  for (const dir of [FIXTURES, TEMP_WS, path.join(TEMP_WS, 'memory')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function teardown() {
  fs.rmSync(TEMP_WS, { recursive: true, force: true });
  fs.rmSync(path.join(__dirname, 'temp-output.json'), { force: true });
}

function runGenerate(workspace) {
  const out = path.join(__dirname, 'temp-output.json');
  require('child_process').execSync(
    `node generate.cjs --workspace "${workspace}" --output "${out}"`,
    { cwd: path.join(__dirname, '..'), env: { ...process.env, SKIP_GH: '1' } }
  );
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

// ==================== UNIT-LEVEL TESTS (via fixtures) ====================

test('empty workspace produces valid structure', () => {
  setup();
  // No files at all
  const data = runGenerate(TEMP_WS);
  assert(data.current, 'has current');
  assert(data.schedule, 'has schedule');
  assert.strictEqual(data.current.status, 'idle');
  assert.deepStrictEqual(data.schedule.blocks, []);
  assert.deepStrictEqual(data.schedule.backlog, []);
  assert.strictEqual(data.stats.blocksCompleted, 0);
  assert.strictEqual(data.stats.blocksTotal, 0);
  teardown();
});

test('parses CURRENT.md correctly', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'CURRENT.md'), `status: in-progress
mode: BUILD
task: Write tests
context: Testing the parser
est: 2
next: Ship it
updated: 2026-03-19T12:00-06:00
`);
  const data = runGenerate(TEMP_WS);
  assert.strictEqual(data.current.status, 'in-progress');
  assert.strictEqual(data.current.mode, 'BUILD');
  assert.strictEqual(data.current.task, 'Write tests');
  assert.strictEqual(data.current.context, 'Testing the parser');
  assert.strictEqual(data.current.estimatedBlocks, 2);
  teardown();
});

test('parses schedule with strikethrough pivots', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — 2026-03-19

## Backlog
- Task A
- Task B

## Timeline
- 09:00 🧠 THINK — Morning standup ✅
- 09:15 🔨 BUILD — ~~Original task~~ → **Pivoted task**
- 09:30 🔍 EXPLORE — Research topic
- 09:45 🔧 MAINTAIN — Cleanup

## Adjustments
- Pivoted at 09:15
`);
  const data = runGenerate(TEMP_WS);
  assert.strictEqual(data.schedule.date, '2026-03-19');
  assert.strictEqual(data.schedule.blocks.length, 4);
  assert.strictEqual(data.schedule.blocks[0].status, 'done'); // has ✅
  assert.strictEqual(data.schedule.blocks[1].task, 'Pivoted task'); // strikethrough → replacement
  assert.strictEqual(data.schedule.blocks[2].mode, 'EXPLORE');
  assert.strictEqual(data.schedule.backlog.length, 2);
  teardown();
});

test('daily log enriches blocks with summaries and artifacts', () => {
  setup();
  const today = localToday();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — ${today}

## Backlog

## Timeline
- 09:00 🔨 BUILD — Write code
- 09:15 🔨 BUILD — More code
`);
  fs.writeFileSync(path.join(TEMP_WS, `memory/${today}.md`), `# ${today}

## Work Log
- 09:00 BUILD: Implemented the feature. Pushed to https://github.com/user/repo/pull/42 for review.
- 09:15 BUILD: Continued with edge cases and error handling for the new parser module.
`);
  const data = runGenerate(TEMP_WS);
  assert.strictEqual(data.schedule.blocks[0].status, 'done');
  assert(data.schedule.blocks[0].details.includes('Implemented'), 'has details');
  assert(data.schedule.blocks[0].summary.length > 0, 'has summary');
  assert.strictEqual(data.schedule.blocks[0].artifacts.length, 1);
  assert.strictEqual(data.schedule.blocks[0].artifacts[0].type, 'pr');
  // Second block should have word-boundary truncation or first sentence
  assert.strictEqual(data.schedule.blocks[1].status, 'done');
  assert(!data.schedule.blocks[1].summary.endsWith('…') || !data.schedule.blocks[1].summary.match(/\w…$/), 'summary truncates at word boundary');
  teardown();
});

test('summary truncation respects word boundaries', () => {
  setup();
  const today = localToday();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — ${today}

## Backlog

## Timeline
- 10:00 🔨 BUILD — Long task
`);
  fs.writeFileSync(path.join(TEMP_WS, `memory/${today}.md`), `# ${today}

## Work Log
- 10:00 BUILD: This is a very long description that keeps going and going without any sentence-ending punctuation so it should get truncated at a word boundary instead of mid-word
`);
  const data = runGenerate(TEMP_WS);
  const summary = data.schedule.blocks[0].summary;
  assert(summary.endsWith('…'), 'truncated summary ends with …');
  // Should not cut mid-word (no letter immediately before …)
  const beforeEllipsis = summary.slice(-2, -1);
  assert(beforeEllipsis === ' ' || /\w/.test(beforeEllipsis), 'ends at word boundary');
  assert(summary.length <= 95, `summary not too long: ${summary.length}`);
  teardown();
});

test('in-progress current marks correct block', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'CURRENT.md'), `status: in-progress
mode: BUILD
task: Active work
context: Doing stuff
updated: 2026-03-19T10:15-06:00
`);
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — 2026-03-19

## Backlog

## Timeline
- 10:00 🧠 THINK — Planning ✅
- 10:15 🔨 BUILD — Active work
- 10:30 🔨 BUILD — Future work
`);
  const data = runGenerate(TEMP_WS);
  assert.strictEqual(data.schedule.blocks[1].status, 'in-progress');
  assert.strictEqual(data.schedule.blocks[2].status, 'upcoming');
  teardown();
});

test('stats computation is accurate', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — 2026-03-19

## Backlog

## Timeline
- 09:00 🧠 THINK — Done ✅
- 09:15 🔨 BUILD — Done ✅
- 09:30 🔨 BUILD — Done ✅
- 09:45 🔧 MAINTAIN — Not done
- 10:00 🔍 EXPLORE — Not done
`);
  const data = runGenerate(TEMP_WS);
  assert.strictEqual(data.stats.blocksCompleted, 3);
  assert.strictEqual(data.stats.blocksTotal, 5);
  assert.strictEqual(data.stats.totalMinutes, 15); // 3 blocks × 5 min estimated average
  assert.deepStrictEqual(data.stats.modeDistribution, { THINK: 1, BUILD: 2 });
  teardown();
});

// ==================== ADDITIONAL UNIT TESTS ====================

test('parseRecentDays populates from memory files', () => {
  setup();
  const today = localToday();
  // Create a "yesterday" memory file
  const yesterday = localToday(-86400000);
  fs.writeFileSync(path.join(TEMP_WS, `memory/${yesterday}.md`), `# ${yesterday}

## Work Log
- 09:00 BUILD: Built a cool feature with many interesting details included
- 09:15 THINK: Reflected on the architecture and decided to refactor
- 09:30 BUILD: Pushed the refactor to production successfully
`);
  // Need a SCHEDULE.md so blocks exist
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — ${today}

## Backlog

## Timeline
- 09:00 🔨 BUILD — Something
`);
  const data = runGenerate(TEMP_WS);
  assert(data.recentDays.length >= 1, 'has recent days');
  const yday = data.recentDays.find(d => d.date === yesterday);
  assert(yday, 'yesterday found');
  assert.strictEqual(yday.blocksCompleted, 3);
  assert(yday.highlights.length > 0, 'has highlights');
  teardown();
});

test('parseCurrent with minimal fields', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'CURRENT.md'), `status: done
mode: EXPLORE
task: Reading papers
`);
  const data = runGenerate(TEMP_WS);
  assert.strictEqual(data.current.status, 'done');
  assert.strictEqual(data.current.mode, 'EXPLORE');
  assert.strictEqual(data.current.task, 'Reading papers');
  assert.strictEqual(data.current.context, '');
  assert.strictEqual(data.current.estimatedBlocks, 0);
  teardown();
});

test('markCurrentBlock falls back to first upcoming when time does not match', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'CURRENT.md'), `status: in-progress
mode: BUILD
task: Surprise task
context: Unscheduled work
updated: 2026-03-19T22:00-06:00
`);
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — 2026-03-19

## Backlog

## Timeline
- 09:00 🧠 THINK — Done ✅
- 09:15 🔨 BUILD — Upcoming work
- 09:30 🔨 BUILD — Later work
`);
  const data = runGenerate(TEMP_WS);
  // 22:00 doesn't match any block, so first upcoming (09:15) should be in-progress
  assert.strictEqual(data.schedule.blocks[1].status, 'in-progress');
  assert.strictEqual(data.schedule.blocks[2].status, 'upcoming');
  teardown();
});

test('multiple artifact types in single log entry', () => {
  setup();
  const today = localToday();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — ${today}

## Backlog

## Timeline
- 09:00 🔨 BUILD — Multi-link task
`);
  fs.writeFileSync(path.join(TEMP_WS, `memory/${today}.md`), `# ${today}

## Work Log
- 09:00 BUILD: Opened https://github.com/user/repo/pull/99 and referenced https://github.com/user/repo and linked to https://example.com/docs for context.
`);
  const data = runGenerate(TEMP_WS);
  const arts = data.schedule.blocks[0].artifacts;
  assert.strictEqual(arts.length, 3);
  assert.strictEqual(arts[0].type, 'pr');
  assert.strictEqual(arts[1].type, 'repo');
  assert.strictEqual(arts[2].type, 'link');
  // Also check top-level artifacts deduplication
  assert.strictEqual(data.artifacts.length, 3);
  teardown();
});

test('summary uses first sentence when available', () => {
  setup();
  const today = localToday();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — ${today}

## Backlog

## Timeline
- 09:00 🔨 BUILD — Sentence task
`);
  fs.writeFileSync(path.join(TEMP_WS, `memory/${today}.md`), `# ${today}

## Work Log
- 09:00 BUILD: Implemented the full authentication flow. Then moved on to writing comprehensive tests for edge cases.
`);
  const data = runGenerate(TEMP_WS);
  const summary = data.schedule.blocks[0].summary;
  assert.strictEqual(summary, 'Implemented the full authentication flow.');
  teardown();
});

test('schedule with no backlog section', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — 2026-03-19

## Timeline
- 09:00 🔨 BUILD — Solo task
`);
  const data = runGenerate(TEMP_WS);
  assert.deepStrictEqual(data.schedule.backlog, []);
  assert.strictEqual(data.schedule.blocks.length, 1);
  teardown();
});

// ==================== INTEGRATION TEST (real workspace) ====================

test('full generation against real workspace', () => {
  const out = path.join(__dirname, '..', 'data', 'dashboard.json');
  require('child_process').execSync('node generate.cjs', { cwd: path.join(__dirname, '..') });
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));

  assert(data.generated);
  assert(data.schedule.blocks.length > 10);
  assert(['done', 'in-progress', 'idle'].includes(data.current.status));
  assert(data.stats.blocksTotal === data.schedule.blocks.length);

  for (const block of data.schedule.blocks) {
    assert(block.time.match(/^\d{2}:\d{2}$/));
    assert(['BUILD', 'THINK', 'EXPLORE', 'MAINTAIN'].includes(block.mode));
    assert(['done', 'in-progress', 'upcoming', 'skipped'].includes(block.status));
  }
});

test('parses schedule adjustments', () => {
  setup();
  fs.writeFileSync(path.join(TEMP_WS, 'SCHEDULE.md'), `# Schedule — 2026-03-19

## Backlog

## Timeline
- 09:00 🧠 THINK — Morning standup

## Adjustments
- 10:00: Pivoted to dashboard work
- 12:00: Reprioritized afternoon for data pipeline
`);
  const data = runGenerate(TEMP_WS);
  assert.strictEqual(data.adjustments.length, 2);
  assert(data.adjustments[0].includes('Pivoted to dashboard'));
  assert(data.adjustments[1].includes('data pipeline'));
  teardown();
});

// Cleanup any leftover temp dirs
try { fs.rmSync(TEMP_WS, { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(__dirname, 'temp-output.json'), { force: true }); } catch {}

console.log(`\n✅ All ${passed} tests passed!`);
