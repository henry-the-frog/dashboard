#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEDULE_FILE = path.join(__dirname, '..', 'schedule.json');

// --- Helpers ---

function load() {
  if (!fs.existsSync(SCHEDULE_FILE)) return null;
  return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
}

function save(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2) + '\n');
}

function nextId(queue) {
  let max = 0;
  for (const t of queue) {
    const n = parseInt(t.id.slice(1), 10);
    if (n > max) max = n;
  }
  return `T${max + 1}`;
}

function now() {
  return new Date().toISOString();
}

function findTask(data, id) {
  const t = data.queue.find(t => t.id === id);
  if (!t) { console.error(`Error: task ${id} not found`); process.exit(1); }
  return t;
}

function logAdjustment(data, msg) {
  data.adjustments.push({ time: now(), message: msg });
}

// --- Commands ---

const commands = {};

commands.init = (args) => {
  const date = args['--date'];
  if (!date) { console.error('Usage: queue.js init --date YYYY-MM-DD'); process.exit(1); }
  const data = { date, queue: [], backlog: [], adjustments: [] };
  save(data);
  console.log(JSON.stringify({ ok: true, date }));
};

commands.add = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json. Run init first.'); process.exit(1); }
  const mode = (args['--mode'] || '').toUpperCase();
  const validModes = ['THINK', 'PLAN', 'BUILD', 'MAINTAIN', 'EXPLORE'];
  if (!validModes.includes(mode)) { console.error(`Error: invalid mode "${mode}". Use: ${validModes.join(', ')}`); process.exit(1); }
  const id = nextId(data.queue);
  const task = {
    id,
    mode,
    status: 'upcoming',
  };
  if (mode === 'PLAN') {
    task.goal = args['--goal'] || null;
  } else {
    task.task = args['--task'] || null;
  }
  if (args['--plan-ref']) task.plan_ref = args['--plan-ref'];

  // Insert position
  const after = args['--after'];
  if (after) {
    const idx = data.queue.findIndex(t => t.id === after);
    if (idx === -1) { console.error(`Error: task ${after} not found for --after`); process.exit(1); }
    data.queue.splice(idx + 1, 0, task);
  } else {
    data.queue.push(task);
  }

  logAdjustment(data, `Added ${id} (${mode}): ${task.task || task.goal || 'placeholder'}`);
  save(data);
  console.log(JSON.stringify({ ok: true, task }));
};

commands.fill = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }
  const planId = args['--plan'];
  if (!planId) { console.error('Usage: queue.js fill --plan T2 --tasks "task1" "task2"'); process.exit(1); }
  const tasks = args['--tasks'];
  if (!tasks || tasks.length === 0) { console.error('Error: --tasks requires at least one task'); process.exit(1); }

  // Find unfilled BUILD slots with this plan_ref
  const slots = data.queue.filter(t => t.plan_ref === planId && t.task === null && t.status === 'upcoming');

  // Fill existing slots, add extras if needed, remove extras if fewer tasks
  let filled = 0;
  for (let i = 0; i < Math.min(slots.length, tasks.length); i++) {
    slots[i].task = tasks[i];
    filled++;
  }

  // If more tasks than slots, insert new BUILD tasks after the last slot
  if (tasks.length > slots.length) {
    const lastSlotIdx = slots.length > 0
      ? data.queue.indexOf(slots[slots.length - 1])
      : data.queue.findIndex(t => t.id === planId);
    for (let i = slots.length; i < tasks.length; i++) {
      const id = nextId(data.queue);
      data.queue.splice(lastSlotIdx + 1 + (i - slots.length), 0, {
        id, mode: 'BUILD', task: tasks[i], status: 'upcoming', plan_ref: planId
      });
      filled++;
    }
  }

  // If fewer tasks than slots, remove unfilled extras
  if (tasks.length < slots.length) {
    for (let i = tasks.length; i < slots.length; i++) {
      const idx = data.queue.indexOf(slots[i]);
      data.queue.splice(idx, 1);
    }
  }

  // Mark the PLAN task as done
  const planTask = data.queue.find(t => t.id === planId);
  if (planTask) planTask.status = 'done';

  logAdjustment(data, `Filled ${filled} BUILD slots for ${planId}: ${tasks.join(', ')}`);
  save(data);
  console.log(JSON.stringify({ ok: true, filled, tasks }));
};

commands.start = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }
  const id = args['--task'];
  if (!id) { console.error('Usage: queue.js start --task T3'); process.exit(1); }
  const task = findTask(data, id);
  const taskIdx = data.queue.indexOf(task);

  // Guard: check if there's an earlier upcoming task that should run first
  const firstUpcoming = data.queue.findIndex(t => t.status === 'upcoming');
  if (firstUpcoming !== -1 && firstUpcoming < taskIdx) {
    const earlier = data.queue[firstUpcoming];
    console.error(`WARNING: Skipping ahead! ${earlier.id} (${earlier.mode}) is earlier in the queue and still upcoming. Use 'node queue.cjs next' to get the correct next task.`);
    // Still allow it but warn loudly — the session should re-check
    console.log(JSON.stringify({ ok: true, task, warning: `${earlier.id} is earlier and upcoming — did you mean to start that instead?` }));
  } else {
    console.log(JSON.stringify({ ok: true, task }));
  }

  task.status = 'in-progress';
  task.started = now();
  save(data);
};

commands.done = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }
  const id = args['--task'];
  if (!id) { console.error('Usage: queue.js done --task T3 --summary "..." --duration 240000'); process.exit(1); }
  const task = findTask(data, id);
  task.status = 'done';
  task.completed = now();
  if (args['--summary']) task.summary = args['--summary'];
  if (args['--duration']) task.duration_ms = parseInt(args['--duration'], 10);
  save(data);
  console.log(JSON.stringify({ ok: true, task }));
};

commands.next = (args) => {
  const data = load();
  if (!data) { console.log(JSON.stringify({ ok: true, task: null, reason: 'no schedule' })); return; }

  if (args['--peek-all']) {
    // Show full queue summary
    const summary = data.queue.map(t => ({
      id: t.id, mode: t.mode, status: t.status,
      task: t.task || t.goal || null
    }));
    console.log(JSON.stringify({ ok: true, date: data.date, queue: summary, backlog: data.backlog }));
    return;
  }

  const next = data.queue.find(t => t.status === 'upcoming');
  if (!next) {
    console.log(JSON.stringify({ ok: true, task: null, reason: 'queue empty' }));
  } else {
    console.log(JSON.stringify({ ok: true, task: next }));
  }
};

commands.yield = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }
  const atId = args['--at'];
  const reason = args['--reason'] || 'unspecified';
  if (!atId) { console.error('Usage: queue.js yield --at T5 --reason "..."'); process.exit(1); }

  const idx = data.queue.findIndex(t => t.id === atId);
  if (idx === -1) { console.error(`Error: task ${atId} not found`); process.exit(1); }

  // Mark current task as blocked
  data.queue[idx].status = 'blocked';
  data.queue[idx].reason = reason;

  // Insert THINK + PLAN after the blocked task
  const thinkId = nextId(data.queue);
  data.queue.splice(idx + 1, 0, {
    id: thinkId, mode: 'THINK', task: `Assess: ${reason}`, status: 'upcoming'
  });
  const planId = nextId(data.queue);
  data.queue.splice(idx + 2, 0, {
    id: planId, mode: 'PLAN', goal: `Decide: retry, skip, or pivot after ${atId}`, status: 'upcoming'
  });

  logAdjustment(data, `Yield at ${atId}: ${reason}. Inserted ${thinkId} (THINK) + ${planId} (PLAN)`);
  save(data);
  console.log(JSON.stringify({ ok: true, blocked: atId, inserted: [thinkId, planId] }));
};

commands.move = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }
  const taskId = args['--task'];
  const afterId = args['--after'];
  if (!taskId || !afterId) { console.error('Usage: queue.js move --task T14 --after T8'); process.exit(1); }

  const fromIdx = data.queue.findIndex(t => t.id === taskId);
  const afterIdx = data.queue.findIndex(t => t.id === afterId);
  if (fromIdx === -1) { console.error(`Error: task ${taskId} not found`); process.exit(1); }
  if (afterIdx === -1) { console.error(`Error: task ${afterId} not found`); process.exit(1); }

  const [task] = data.queue.splice(fromIdx, 1);
  const insertIdx = data.queue.findIndex(t => t.id === afterId) + 1;
  data.queue.splice(insertIdx, 0, task);

  logAdjustment(data, `Moved ${taskId} after ${afterId}`);
  save(data);
  console.log(JSON.stringify({ ok: true, moved: taskId, after: afterId }));
};

commands.remove = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }
  const taskId = args['--task'];
  const reason = args['--reason'] || 'unspecified';
  if (!taskId) { console.error('Usage: queue.js remove --task T12 --reason "..."'); process.exit(1); }

  const idx = data.queue.findIndex(t => t.id === taskId);
  if (idx === -1) { console.error(`Error: task ${taskId} not found`); process.exit(1); }
  data.queue.splice(idx, 1);

  logAdjustment(data, `Removed ${taskId}: ${reason}`);
  save(data);
  console.log(JSON.stringify({ ok: true, removed: taskId }));
};

commands.backlog = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }

  if (args['--add']) {
    data.backlog.push(args['--add']);
    save(data);
    console.log(JSON.stringify({ ok: true, action: 'added', backlog: data.backlog }));
  } else if (args['--pop']) {
    if (data.backlog.length === 0) {
      console.log(JSON.stringify({ ok: true, item: null, reason: 'backlog empty' }));
    } else {
      const item = data.backlog.shift();
      save(data);
      console.log(JSON.stringify({ ok: true, item }));
    }
  } else {
    console.log(JSON.stringify({ ok: true, backlog: data.backlog }));
  }
};

commands.validate = (args) => {
  const data = load();
  if (!data) { console.error('Error: no schedule.json'); process.exit(1); }

  const warnings = [];
  const errors = [];
  const queue = data.queue;

  // Check: every BUILD has a PLAN before it
  let lastPlan = null;
  for (const t of queue) {
    if (t.mode === 'PLAN') lastPlan = t.id;
    if (t.mode === 'BUILD' && !t.plan_ref && !lastPlan) {
      errors.push(`${t.id}: BUILD with no preceding PLAN`);
    }
  }

  // Check: unfilled BUILD slots still null
  for (const t of queue) {
    if (t.mode === 'BUILD' && t.task !== null && t.status === 'upcoming' && !t.plan_ref) {
      warnings.push(`${t.id}: BUILD pre-filled without plan_ref (standup should leave task null)`);
    }
  }

  // Check: MAINTAIN frequency
  let buildCount = 0;
  for (const t of queue) {
    if (t.mode === 'BUILD') buildCount++;
    if (t.mode === 'MAINTAIN') {
      if (buildCount > 5) warnings.push(`MAINTAIN after ${buildCount} BUILDs (recommend 3-5)`);
      buildCount = 0;
    }
  }
  if (buildCount > 5) warnings.push(`${buildCount} BUILDs at end without MAINTAIN`);

  // Check: THINK exists
  if (!queue.some(t => t.mode === 'THINK')) warnings.push('No THINK tasks in queue');

  // Check: EXPLORE count
  const explores = queue.filter(t => t.mode === 'EXPLORE');
  if (explores.length < 2) warnings.push(`Only ${explores.length} EXPLORE tasks (recommend 2+)`);

  // Check: unique IDs
  const ids = queue.map(t => t.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) errors.push(`Duplicate IDs: ${dupes.join(', ')}`);

  const valid = errors.length === 0;
  console.log(JSON.stringify({ ok: valid, errors, warnings }));
  if (!valid) process.exit(1);
};

// --- Argument Parser ---

function parseArgs(argv) {
  const args = { _command: argv[0] };
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg;
      // Special case: --tasks consumes all remaining non-flag args
      if (key === '--tasks') {
        const tasks = [];
        i++;
        while (i < argv.length && !argv[i].startsWith('--')) {
          tasks.push(argv[i]);
          i++;
        }
        args[key] = tasks;
        continue;
      }
      // Boolean flag or value
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 2;
      } else {
        args[key] = true;
        i++;
      }
    } else {
      i++;
    }
  }
  return args;
}

// --- Main ---

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('Usage: queue.js <command> [options]');
  console.error('Commands: init, add, fill, start, done, next, yield, move, remove, backlog, validate');
  process.exit(1);
}

const cmd = argv[0];
if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

const args = parseArgs(argv);
commands[cmd](args);
