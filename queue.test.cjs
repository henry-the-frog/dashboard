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

function runExpectFail(args) {
  try {
    execSync(`node ${QUEUE} ${args}`, { encoding: 'utf8', cwd: __dirname, stdio: 'pipe' });
    return false;
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

function loadSchedule() {
  return JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
}

// ============================================================
console.log('\n🧪 queue.cjs test suite\n');
cleanup();

// --- init ---
console.log('--- init ---');

test('init creates schedule.json with correct structure', () => {
  const r = run('init --date 2026-03-23');
  assert(r.ok);
  assertEqual(r.date, '2026-03-23');
  const data = loadSchedule();
  assertEqual(data.date, '2026-03-23');
  assertEqual(data.queue.length, 0);
  assert(Array.isArray(data.backlog));
  assert(Array.isArray(data.adjustments));
});

test('init overwrites existing schedule (fresh start)', () => {
  run('add --mode THINK --task "Old task"');
  const before = loadSchedule();
  assertEqual(before.queue.length, 1);
  run('init --date 2026-03-24');
  const after = loadSchedule();
  assertEqual(after.date, '2026-03-24');
  assertEqual(after.queue.length, 0);
});

test('init without --date fails', () => {
  assert(runExpectFail('init'));
});

// --- add ---
console.log('--- add ---');

test('add THINK task with correct fields', () => {
  cleanup();
  run('init --date 2026-03-23');
  const r = run('add --mode THINK --task "Review yesterday"');
  assert(r.ok);
  assertEqual(r.task.id, 'T1');
  assertEqual(r.task.mode, 'THINK');
  assertEqual(r.task.task, 'Review yesterday');
  assertEqual(r.task.status, 'upcoming');
});

test('add PLAN stores goal (not task)', () => {
  const r = run('add --mode PLAN --goal "Optimize compiler"');
  assertEqual(r.task.mode, 'PLAN');
  assertEqual(r.task.goal, 'Optimize compiler');
  assert(r.task.task === undefined, 'PLAN should have goal, not task');
});

test('add BUILD placeholder has null task', () => {
  const r = run('add --mode BUILD --plan-ref T2');
  assertEqual(r.task.task, null);
  assertEqual(r.task.plan_ref, 'T2');
});

test('add MAINTAIN task', () => {
  const r = run('add --mode MAINTAIN --task "Housekeeping"');
  assertEqual(r.task.mode, 'MAINTAIN');
});

test('add EXPLORE task', () => {
  const r = run('add --mode EXPLORE --task "Research JIT"');
  assertEqual(r.task.mode, 'EXPLORE');
});

test('add with --after inserts at correct position', () => {
  const r = run('add --mode THINK --task "Inserted" --after T1');
  const data = loadSchedule();
  const ids = data.queue.map(t => t.id);
  assertEqual(ids.indexOf(r.task.id), ids.indexOf('T1') + 1);
});

test('add with --after nonexistent task fails', () => {
  assert(runExpectFail('add --mode THINK --task "Bad" --after T999'));
});

test('add with invalid mode fails', () => {
  assert(runExpectFail('add --mode INVALID --task "bad"'));
});

test('add without schedule.json fails', () => {
  cleanup();
  assert(runExpectFail('add --mode THINK --task "no schedule"'));
});

test('add without --task creates null task', () => {
  run('init --date 2026-03-23');
  const r = run('add --mode BUILD');
  assertEqual(r.task.task, null);
});

test('IDs increment correctly across adds', () => {
  cleanup();
  run('init --date 2026-03-23');
  const r1 = run('add --mode THINK --task "A"');
  const r2 = run('add --mode THINK --task "B"');
  const r3 = run('add --mode THINK --task "C"');
  assertEqual(r1.task.id, 'T1');
  assertEqual(r2.task.id, 'T2');
  assertEqual(r3.task.id, 'T3');
});

// --- next ---
console.log('--- next ---');

test('next returns first upcoming task', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "First"');
  run('add --mode BUILD --task "Second"');
  const r = run('next');
  assertEqual(r.task.id, 'T1');
});

test('next skips done tasks', () => {
  run('start --task T1');
  run('done --task T1 --summary "done"');
  const r = run('next');
  assertEqual(r.task.id, 'T2');
});

test('next skips blocked tasks', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode BUILD --task "Blocked one"');
  run('add --mode BUILD --task "Good one"');
  // Manually set blocked status via yield
  run('start --task T1');
  run('yield --at T1 --reason "API down"');
  // next should return the THINK inserted by yield (T3), not T1 (blocked)
  const r = run('next');
  assertEqual(r.task.mode, 'THINK');
  assert(r.task.id !== 'T1', 'should skip blocked T1');
});

test('next skips in-progress tasks', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Started"');
  run('add --mode BUILD --task "Waiting"');
  run('start --task T1');
  const r = run('next');
  assertEqual(r.task.id, 'T2');
});

test('next on empty queue returns null with reason', () => {
  cleanup();
  run('init --date 2026-03-23');
  const r = run('next');
  assertEqual(r.task, null);
  assertEqual(r.reason, 'queue empty');
});

test('next with no schedule returns null with reason', () => {
  cleanup();
  const r = run('next');
  assertEqual(r.task, null);
  assertEqual(r.reason, 'no schedule');
});

test('next --peek-all shows full queue with backlog', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "A"');
  run('add --mode BUILD --task "B"');
  run('backlog --add "Future idea"');
  const r = run('next --peek-all');
  assert(r.ok);
  assertEqual(r.queue.length, 2);
  assertEqual(r.backlog.length, 1);
  assertEqual(r.date, '2026-03-23');
  // peek-all should include task text
  assertEqual(r.queue[0].task, 'A');
});

// --- start ---
console.log('--- start ---');

test('start marks task in-progress with timestamp', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Test"');
  const r = run('start --task T1');
  assertEqual(r.task.status, 'in-progress');
  assert(r.task.started, 'should have started timestamp');
  assert(r.task.started.includes('T'), 'should be ISO timestamp');
});

test('start nonexistent task fails', () => {
  assert(runExpectFail('start --task T999'));
});

test('start without --task fails', () => {
  assert(runExpectFail('start'));
});

// --- done ---
console.log('--- done ---');

test('done marks task complete with all fields', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Test"');
  run('start --task T1');
  const r = run('done --task T1 --summary "Reviewed everything" --duration 180000');
  assertEqual(r.task.status, 'done');
  assertEqual(r.task.summary, 'Reviewed everything');
  assertEqual(r.task.duration_ms, 180000);
  assert(r.task.completed, 'should have completed timestamp');
});

test('done works without optional summary and duration', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Quick task"');
  run('start --task T1');
  const r = run('done --task T1');
  assertEqual(r.task.status, 'done');
  assert(r.task.completed);
  assert(!r.task.summary, 'no summary when not provided');
  assert(!r.task.duration_ms, 'no duration when not provided');
});

test('done nonexistent task fails', () => {
  assert(runExpectFail('done --task T999'));
});

test('done without --task fails', () => {
  assert(runExpectFail('done'));
});

// --- fill ---
console.log('--- fill ---');

test('fill replaces BUILD placeholders for correct plan', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Goal A"');
  run('add --mode BUILD --plan-ref T1');
  run('add --mode BUILD --plan-ref T1');
  run('add --mode BUILD --plan-ref T1');
  const r = run('fill --plan T1 --tasks "Implement" "Test" "Benchmark"');
  assertEqual(r.filled, 3);
  const data = loadSchedule();
  const builds = data.queue.filter(t => t.plan_ref === 'T1' && t.mode === 'BUILD');
  assertEqual(builds[0].task, 'Implement');
  assertEqual(builds[1].task, 'Test');
  assertEqual(builds[2].task, 'Benchmark');
  // PLAN should be marked done
  assertEqual(data.queue[0].status, 'done');
});

test('fill only fills null-task slots (skips already-filled)', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Goal"');
  run('add --mode BUILD --plan-ref T1');
  run('add --mode BUILD --plan-ref T1');
  // Manually fill one slot first
  run('fill --plan T1 --tasks "Already filled" "Second"');
  // Now try to fill again — the already-filled slot should be skipped
  // Re-add slots
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Goal"');
  run('add --mode BUILD --task "Pre-filled" --plan-ref T1');
  run('add --mode BUILD --plan-ref T1');
  // fill should only fill the null one
  const r = run('fill --plan T1 --tasks "New task"');
  assertEqual(r.filled, 1);
  const data = loadSchedule();
  const builds = data.queue.filter(t => t.plan_ref === 'T1' && t.mode === 'BUILD');
  assertEqual(builds[0].task, 'Pre-filled');
  assertEqual(builds[1].task, 'New task');
});

test('fill with more tasks than slots adds extras', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Test"');
  run('add --mode BUILD --plan-ref T1');
  run('add --mode MAINTAIN --task "After"');
  const r = run('fill --plan T1 --tasks "A" "B" "C"');
  assertEqual(r.filled, 3);
  const data = loadSchedule();
  const builds = data.queue.filter(t => t.plan_ref === 'T1');
  assertEqual(builds.length, 3);
  // MAINTAIN should still be last
  assertEqual(data.queue[data.queue.length - 1].mode, 'MAINTAIN');
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
  const data = loadSchedule();
  const builds = data.queue.filter(t => t.plan_ref === 'T1');
  assertEqual(builds.length, 1);
  assertEqual(builds[0].task, 'Just one');
});

test('fill with no matching slots inserts after plan', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Test"');
  run('add --mode MAINTAIN --task "After"');
  // No BUILD slots with plan-ref T1 exist
  const r = run('fill --plan T1 --tasks "New A" "New B"');
  assertEqual(r.filled, 2);
  const data = loadSchedule();
  // Tasks should be between PLAN and MAINTAIN
  assertEqual(data.queue[1].task, 'New A');
  assertEqual(data.queue[2].task, 'New B');
  assertEqual(data.queue[3].mode, 'MAINTAIN');
});

test('fill without --plan fails', () => {
  assert(runExpectFail('fill --tasks "A"'));
});

test('fill without --tasks fails', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Test"');
  assert(runExpectFail('fill --plan T1'));
});

// --- yield ---
console.log('--- yield ---');

test('yield marks task blocked and inserts THINK + PLAN', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Start"');
  run('add --mode PLAN --goal "Goal"');
  run('add --mode BUILD --task "Do stuff" --plan-ref T2');
  run('add --mode BUILD --task "More stuff" --plan-ref T2');
  run('add --mode MAINTAIN --task "Cleanup"');
  run('start --task T3');
  const r = run('yield --at T3 --reason "API is down"');
  assert(r.ok);
  assertEqual(r.blocked, 'T3');
  assertEqual(r.inserted.length, 2);

  const data = loadSchedule();
  const t3idx = data.queue.findIndex(t => t.id === 'T3');
  assertEqual(data.queue[t3idx].status, 'blocked');
  assertEqual(data.queue[t3idx].reason, 'API is down');
  assertEqual(data.queue[t3idx + 1].mode, 'THINK');
  assert(data.queue[t3idx + 1].task.includes('API is down'), 'THINK should reference the reason');
  assertEqual(data.queue[t3idx + 2].mode, 'PLAN');
  // T4 and T5 should still exist
  assert(data.queue.find(t => t.id === 'T4'), 'T4 should survive');
  assert(data.queue.find(t => t.id === 'T5'), 'T5 should survive');
});

test('yield then next returns the inserted THINK (not the blocked task)', () => {
  // Self-contained: set up, yield, verify next
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode BUILD --task "Will block"');
  run('add --mode BUILD --task "After"');
  run('start --task T1');
  run('yield --at T1 --reason "Missing dep"');
  // T1 is blocked, T3 (THINK) and T4 (PLAN) were inserted, T2 is still upcoming
  const r = run('next');
  // Should get T3 (THINK "Assess: Missing dep"), not T1 (blocked) or T2
  assertEqual(r.task.mode, 'THINK');
  assert(r.task.task.includes('Missing dep'), `expected reason in task, got: ${r.task.task}`);
});

test('yield on nonexistent task fails', () => {
  assert(runExpectFail('yield --at T999 --reason "bad"'));
});

test('yield without --at fails', () => {
  assert(runExpectFail('yield --reason "bad"'));
});

test('yield logs adjustment', () => {
  const data = loadSchedule();
  const yieldAdj = data.adjustments.find(a => a.message.includes('Yield'));
  assert(yieldAdj, 'should log yield adjustment');
  assert(yieldAdj.message.includes('API is down'));
});

// --- move ---
console.log('--- move ---');

test('move repositions task correctly', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "A"');
  run('add --mode PLAN --goal "B"');
  run('add --mode BUILD --task "C" --plan-ref T2');
  run('add --mode EXPLORE --task "D"');
  run('move --task T4 --after T1');
  const data = loadSchedule();
  const ids = data.queue.map(t => t.id);
  assertEqual(ids.toString(), 'T1,T4,T2,T3', `wrong order: ${ids}`);
});

test('move preserves task data', () => {
  const data = loadSchedule();
  const t4 = data.queue.find(t => t.id === 'T4');
  assertEqual(t4.mode, 'EXPLORE');
  assertEqual(t4.task, 'D');
  assertEqual(t4.status, 'upcoming');
});

test('move nonexistent task fails', () => {
  assert(runExpectFail('move --task T999 --after T1'));
});

test('move to nonexistent anchor fails', () => {
  assert(runExpectFail('move --task T1 --after T999'));
});

test('move without required args fails', () => {
  assert(runExpectFail('move --task T1'));
  assert(runExpectFail('move --after T1'));
});

// --- remove ---
console.log('--- remove ---');

test('remove deletes task and logs reason', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "A"');
  run('add --mode BUILD --task "B"');
  run('add --mode MAINTAIN --task "C"');
  const r = run('remove --task T2 --reason "Not needed"');
  assert(r.ok);
  assertEqual(r.removed, 'T2');
  const data = loadSchedule();
  assertEqual(data.queue.length, 2);
  assert(!data.queue.find(t => t.id === 'T2'));
  const adj = data.adjustments.find(a => a.message.includes('Not needed'));
  assert(adj, 'should log removal reason');
});

test('remove nonexistent task fails', () => {
  assert(runExpectFail('remove --task T999'));
});

test('remove without --task fails', () => {
  assert(runExpectFail('remove'));
});

// --- backlog ---
console.log('--- backlog ---');

test('backlog --add adds item', () => {
  cleanup();
  run('init --date 2026-03-23');
  const r = run('backlog --add "Explore trace scheduling"');
  assert(r.ok);
  assert(r.backlog.includes('Explore trace scheduling'));
});

test('backlog shows current items', () => {
  run('backlog --add "Second item"');
  const r = run('backlog');
  assertEqual(r.backlog.length, 2);
});

test('backlog --pop returns first and removes it', () => {
  const r = run('backlog --pop');
  assertEqual(r.item, 'Explore trace scheduling');
  const after = run('backlog');
  assertEqual(after.backlog.length, 1);
  assertEqual(after.backlog[0], 'Second item');
});

test('backlog --pop on empty returns null', () => {
  run('backlog --pop'); // drain remaining
  const r = run('backlog --pop');
  assertEqual(r.item, null);
  assertEqual(r.reason, 'backlog empty');
});

// --- validate ---
console.log('--- validate ---');

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
  assert(r.ok);
  assertEqual(r.errors.length, 0);
  assertEqual(r.warnings.length, 0);
});

test('validate error: BUILD with no preceding PLAN', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode BUILD --task "No plan"');
  assert(runExpectFail('validate'));
});

test('validate warns: too few EXPLORE tasks', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Reflect"');
  run('add --mode PLAN --goal "Goal"');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode MAINTAIN --task "Housekeeping"');
  const r = run('validate');
  assert(r.warnings.some(w => w.includes('EXPLORE')));
});

test('validate warns: no THINK tasks', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode PLAN --goal "Goal"');
  run('add --mode BUILD --plan-ref T1');
  run('add --mode MAINTAIN --task "Housekeeping"');
  run('add --mode EXPLORE --task "A"');
  run('add --mode EXPLORE --task "B"');
  const r = run('validate');
  assert(r.warnings.some(w => w.includes('THINK')));
});

test('validate warns: >5 BUILDs before MAINTAIN', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Reflect"');
  run('add --mode PLAN --goal "Goal"');
  for (let i = 0; i < 6; i++) run('add --mode BUILD --plan-ref T2');
  run('add --mode MAINTAIN --task "Late housekeeping"');
  run('add --mode EXPLORE --task "A"');
  run('add --mode EXPLORE --task "B"');
  const r = run('validate');
  assert(r.warnings.some(w => w.includes('6 BUILDs') || w.includes('recommend 3-5')));
});

test('validate warns: trailing BUILDs without MAINTAIN', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Reflect"');
  run('add --mode PLAN --goal "Goal"');
  for (let i = 0; i < 6; i++) run('add --mode BUILD --plan-ref T2');
  run('add --mode EXPLORE --task "A"');
  run('add --mode EXPLORE --task "B"');
  const r = run('validate');
  assert(r.warnings.some(w => w.includes('without MAINTAIN')));
});

// --- adjustments ---
console.log('--- adjustments ---');

test('all mutations log timestamped adjustments', () => {
  cleanup();
  run('init --date 2026-03-23');
  run('add --mode THINK --task "A"');
  run('add --mode PLAN --goal "B"');
  run('add --mode BUILD --plan-ref T2');
  run('fill --plan T2 --tasks "C"');
  run('add --mode BUILD --task "D"');
  run('remove --task T4 --reason "Cleanup"');
  const data = loadSchedule();
  // add (3) + fill (1) + add (1) + remove (1) = 6
  assert(data.adjustments.length >= 6, `expected 6+ adjustments, got ${data.adjustments.length}`);
  assert(data.adjustments.every(a => a.time && a.message), 'all adjustments need time + message');
  // Verify timestamps are ISO format
  assert(data.adjustments.every(a => a.time.includes('T')), 'timestamps should be ISO');
});

// --- full workflow ---
console.log('--- full workflow ---');

test('complete work loop: init → add → start → done → next cycle', () => {
  cleanup();
  // Standup builds queue
  run('init --date 2026-03-23');
  run('add --mode THINK --task "Morning review"');
  run('add --mode PLAN --goal "Build feature X"');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode BUILD --plan-ref T2');
  run('add --mode MAINTAIN --task "Housekeeping"');
  run('add --mode EXPLORE --task "Research"');
  run('add --mode EXPLORE --task "More research"');

  // Session starts: pop THINK
  let next = run('next');
  assertEqual(next.task.id, 'T1');
  assertEqual(next.task.mode, 'THINK');
  run('start --task T1');
  run('done --task T1 --summary "Reviewed, looks good" --duration 120000');

  // Pop PLAN
  next = run('next');
  assertEqual(next.task.id, 'T2');
  assertEqual(next.task.mode, 'PLAN');
  run('start --task T2');
  // PLAN fills BUILD slots
  run('fill --plan T2 --tasks "Write parser" "Write tests" "Refactor"');
  run('done --task T2 --summary "Plan complete" --duration 60000');

  // Pop first BUILD (should be filled now)
  next = run('next');
  assertEqual(next.task.mode, 'BUILD');
  assertEqual(next.task.task, 'Write parser');
  run('start --task ' + next.task.id);

  // BUILD hits a blocker — yield
  run('yield --at ' + next.task.id + ' --reason "Missing dependency"');

  // Next should be the inserted THINK
  next = run('next');
  assertEqual(next.task.mode, 'THINK');
  assert(next.task.task.includes('Missing dependency'));
  run('start --task ' + next.task.id);
  run('done --task ' + next.task.id + ' --summary "Assessed blocker"');

  // Next should be the inserted PLAN
  next = run('next');
  assertEqual(next.task.mode, 'PLAN');
  run('start --task ' + next.task.id);
  run('done --task ' + next.task.id + ' --summary "Decided to skip"');

  // Next should continue with remaining BUILDs
  next = run('next');
  assertEqual(next.task.mode, 'BUILD');
  assertEqual(next.task.task, 'Write tests');

  // Verify final state
  const data = loadSchedule();
  const done = data.queue.filter(t => t.status === 'done');
  const blocked = data.queue.filter(t => t.status === 'blocked');
  assert(done.length >= 4, `expected 4+ done tasks, got ${done.length}`);
  assertEqual(blocked.length, 1);
  assert(data.adjustments.length > 0, 'should have logged adjustments');
});

// --- error handling ---
console.log('--- error handling ---');

test('unknown command fails', () => {
  assert(runExpectFail('foobar'));
});

test('no command fails', () => {
  assert(runExpectFail(''));
});

// --- Summary ---
cleanup();
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
