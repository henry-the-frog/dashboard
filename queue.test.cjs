#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const QUEUE = path.join(__dirname, 'queue.cjs');
const SCHEDULE = path.join(__dirname, '..', 'schedule.json');

let passed = 0, failed = 0;

function run(args) {
  const result = execSync(`node ${QUEUE} ${args}`, { encoding: 'utf8', cwd: __dirname });
  return JSON.parse(result.trim());
}

function runRaw(args) {
  return execSync(`node ${QUEUE} ${args}`, { encoding: 'utf8', cwd: __dirname }).trim();
}

function runExpectFail(args) {
  try {
    execSync(`node ${QUEUE} ${args}`, { encoding: 'utf8', cwd: __dirname, stdio: 'pipe' });
    return false; // should have thrown
  } catch (e) {
    return true;
  }
}

function cleanup() {
  if (fs.existsSync(SCHEDULE)) fs.unlinkSync(SCHEDULE);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// --- Tests ---

console.log('\n🧪 queue.cjs test suite\n');

// Clean slate
cleanup();

console.log('--- init ---');

test('init creates schedule.json', () => {
  const r = run('init --date 2026-03-23');
  assert(r.ok);
  assertEqual(r.date, '2026-03-23');
  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  assertEqual(data.date, '2026-03-23');
  assertEqual(data.queue.length, 0);
});

console.log('--- add ---');

test('add THINK task', () => {
  const r = run('add --mode THINK --task "Review yesterday"');
  assert(r.ok);
  assertEqual(r.task.id, 'T1');
  assertEqual(r.task.mode, 'THINK');
  assertEqual(r.task.task, 'Review yesterday');
  assertEqual(r.task.status, 'upcoming');
});

test('add PLAN task with goal', () => {
  const r = run('add --mode PLAN --goal "Optimize compiler"');
  assert(r.ok);
  assertEqual(r.task.id, 'T2');
  assertEqual(r.task.mode, 'PLAN');
  assertEqual(r.task.goal, 'Optimize compiler');
});

test('add BUILD placeholders with plan-ref', () => {
  run('add --mode BUILD --plan-ref T2');
  run('add --mode BUILD --plan-ref T2');
  const r = run('add --mode BUILD --plan-ref T2');
  assertEqual(r.task.id, 'T5');
  assertEqual(r.task.plan_ref, 'T2');
  assertEqual(r.task.task, null);
});

test('add MAINTAIN', () => {
  const r = run('add --mode MAINTAIN --task Housekeeping');
  assertEqual(r.task.id, 'T6');
  assertEqual(r.task.mode, 'MAINTAIN');
});

test('add with --after inserts at correct position', () => {
  const r = run('add --mode EXPLORE --task "Research JIT" --after T2');
  // Should be between T2 and T3
  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const ids = data.queue.map(t => t.id);
  const t2idx = ids.indexOf('T2');
  const newIdx = ids.indexOf(r.task.id);
  assertEqual(newIdx, t2idx + 1, 'inserted task should be right after T2');
});

test('add with invalid mode fails', () => {
  assert(runExpectFail('add --mode INVALID --task "bad"'));
});

console.log('--- next ---');

test('next returns first upcoming task', () => {
  const r = run('next');
  assert(r.ok);
  assertEqual(r.task.id, 'T1');
  assertEqual(r.task.mode, 'THINK');
});

test('next --peek-all shows full queue', () => {
  const r = run('next --peek-all');
  assert(r.ok);
  assert(r.queue.length >= 7);
  assertEqual(r.date, '2026-03-23');
});

console.log('--- start ---');

test('start marks task in-progress', () => {
  const r = run('start --task T1');
  assert(r.ok);
  assertEqual(r.task.status, 'in-progress');
  assert(r.task.started);
});

console.log('--- done ---');

test('done marks task complete with summary and duration', () => {
  const r = run('done --task T1 --summary "Reviewed yesterday, looks good" --duration 180000');
  assert(r.ok);
  assertEqual(r.task.status, 'done');
  assertEqual(r.task.summary, 'Reviewed yesterday, looks good');
  assertEqual(r.task.duration_ms, 180000);
  assert(r.task.completed);
});

test('next now returns T2 (first undone after T1)', () => {
  const r = run('next');
  assertEqual(r.task.id, 'T2');
});

console.log('--- fill ---');

test('fill replaces BUILD placeholders', () => {
  // First start and complete the PLAN
  run('start --task T2');
  // Fill the 3 BUILD slots for T2
  const r = run('fill --plan T2 --tasks "Implement constant folding" "Write tests" "Benchmark"');
  assert(r.ok);
  assertEqual(r.filled, 3);

  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const builds = data.queue.filter(t => t.plan_ref === 'T2' && t.mode === 'BUILD');
  assertEqual(builds[0].task, 'Implement constant folding');
  assertEqual(builds[1].task, 'Write tests');
  assertEqual(builds[2].task, 'Benchmark');

  // PLAN should be marked done
  const plan = data.queue.find(t => t.id === 'T2');
  assertEqual(plan.status, 'done');
});

test('fill with more tasks than slots adds extras', () => {
  // Reset for this test
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Test"');
  run('add --mode BUILD --plan-ref T1');
  const r = run('fill --plan T1 --tasks "A" "B" "C"');
  assertEqual(r.filled, 3);
  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const builds = data.queue.filter(t => t.plan_ref === 'T1');
  assertEqual(builds.length, 3);
});

test('fill with fewer tasks than slots removes extras', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Test"');
  run('add --mode BUILD --plan-ref T1');
  run('add --mode BUILD --plan-ref T1');
  run('add --mode BUILD --plan-ref T1');
  const r = run('fill --plan T1 --tasks "Just one"');
  assertEqual(r.filled, 1);
  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const builds = data.queue.filter(t => t.plan_ref === 'T1');
  assertEqual(builds.length, 1);
  assertEqual(builds[0].task, 'Just one');
});

console.log('--- yield ---');

test('yield inserts THINK + PLAN after blocked task', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Start"');
  run('add --mode PLAN --goal "Goal"');
  run('add --mode BUILD --task "Do stuff" --plan-ref T2');
  run('add --mode BUILD --task "More stuff" --plan-ref T2');
  run('add --mode MAINTAIN --task "Cleanup"');

  // Start and then yield at T3
  run('start --task T3');
  const r = run('yield --at T3 --reason "API is down"');
  assert(r.ok);
  assertEqual(r.blocked, 'T3');
  assertEqual(r.inserted.length, 2);

  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const t3idx = data.queue.findIndex(t => t.id === 'T3');
  assertEqual(data.queue[t3idx].status, 'blocked');
  assertEqual(data.queue[t3idx + 1].mode, 'THINK');
  assertEqual(data.queue[t3idx + 2].mode, 'PLAN');
  // Original T4 should still be there after the insertions
  const t4 = data.queue.find(t => t.id === 'T4');
  assert(t4, 'T4 should still exist');
});

console.log('--- move ---');

test('move repositions a task', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "A"');
  run('add --mode PLAN --goal "B"');
  run('add --mode BUILD --task "C" --plan-ref T2');
  run('add --mode EXPLORE --task "D"');

  run('move --task T4 --after T1');
  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const ids = data.queue.map(t => t.id);
  assertEqual(ids.indexOf('T4'), ids.indexOf('T1') + 1);
});

console.log('--- remove ---');

test('remove deletes a task', () => {
  const before = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const lenBefore = before.queue.length;
  const r = run('remove --task T3 --reason "Not needed"');
  assert(r.ok);
  const after = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  assertEqual(after.queue.length, lenBefore - 1);
  assert(!after.queue.find(t => t.id === 'T3'));
});

console.log('--- backlog ---');

test('backlog --add adds item', () => {
  const r = run('backlog --add "Explore trace scheduling"');
  assert(r.ok);
  assert(r.backlog.includes('Explore trace scheduling'));
});

test('backlog shows current items', () => {
  const r = run('backlog');
  assert(r.backlog.length > 0);
});

test('backlog --pop returns and removes first item', () => {
  run('backlog --add "Second item"');
  const r = run('backlog --pop');
  assert(r.ok);
  assertEqual(r.item, 'Explore trace scheduling');
});

console.log('--- validate ---');

test('validate catches missing PLAN before BUILD', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode BUILD --task "No plan"');
  assert(runExpectFail('validate'), 'should fail validation');
});

test('validate passes on well-formed queue', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Reflect"');
  run('add --mode PLAN --goal "Goal 1"');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode MAINTAIN --task "Housekeeping"');
  run('add --mode EXPLORE --task "Research A"');
  run('add --mode EXPLORE --task "Research B"');
  const r = run('validate');
  assert(r.ok, 'should pass validation');
  assertEqual(r.errors.length, 0);
});

test('validate warns on too few EXPLORE tasks', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Reflect"');
  run('add --mode PLAN --goal "Goal"');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode MAINTAIN --task "Housekeeping"');
  const r = run('validate');
  // Should pass but with warnings
  assert(r.warnings.some(w => w.includes('EXPLORE')));
});

console.log('--- adjustments ---');

test('all mutations log adjustments', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "A"');
  run('add --mode PLAN --goal "B"');
  run('add --mode BUILD --plan-ref T2');
  run('fill --plan T2 --tasks "C"');
  const data = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  assert(data.adjustments.length >= 3, `expected 3+ adjustments, got ${data.adjustments.length}`);
  assert(data.adjustments.every(a => a.time && a.message));
});

console.log('--- edge cases ---');

test('next on empty queue returns null', () => {
  cleanup();
  run('init --date 2026-03-23');
  const r = run('next');
  assertEqual(r.task, null);
});

test('next with no schedule returns null', () => {
  cleanup();
  const r = run('next');
  assertEqual(r.task, null);
});

test('backlog --pop on empty returns null', () => {
  cleanup();
  run('init --date 2026-03-23');
  const r = run('backlog --pop');
  assertEqual(r.item, null);
});

// --- Summary ---

cleanup();
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
