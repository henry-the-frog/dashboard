// Henry's Work Dashboard — Main App
(function () {
  'use strict';

  const DATA_URL = 'data/dashboard.json';
  const POLL_INTERVAL = 30000;
  const POLL_INTERVAL_HIDDEN = 120000;
  const MAX_BACKOFF = 300000;

  const MODE_ICONS = {
    BUILD: '🔨',
    THINK: '🧠',
    EXPLORE: '🔍',
    MAINTAIN: '🔧',
  };

  const MODE_CLASS = {
    BUILD: 'mode-build',
    THINK: 'mode-think',
    EXPLORE: 'mode-explore',
    MAINTAIN: 'mode-maintain',
  };

  // --- State ---
  let currentData = null;
  let lastDataHash = null;
  let pollTimer = null;
  let errorCount = 0;
  let selectedBlockIndex = -1;

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const timeline = $('#timeline');
  const taskDetail = $('#taskDetail');

  // --- Hashing (simple change detection) ---
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  // --- Animations ---

  function animateNumber(el, to) {
    const from = parseInt(el.textContent, 10) || 0;
    if (from === to) return;
    const duration = 400;
    const start = performance.now();
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
      el.textContent = Math.round(from + (to - from) * ease);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // --- Rendering ---

  function renderBanner(current) {
    if (!current) return;
    const modeEl = $('#currentMode');
    const newMode = `${MODE_ICONS[current.mode] || ''} ${current.mode}`;
    if (modeEl.textContent !== newMode) {
      modeEl.textContent = newMode;
      // Color the banner border based on mode
      const banner = $('#statusBanner');
      banner.style.borderBottomColor = `var(--mode-${current.mode.toLowerCase()}, var(--border))`;
    }
    $('#currentTask').textContent = current.task;

    // Context line
    const ctxEl = $('#currentContext');
    if (ctxEl) ctxEl.textContent = current.context || '';

    // Next task
    const nextEl = $('#currentNext');
    if (nextEl) {
      nextEl.textContent = current.next ? `Next → ${current.next}` : '';
    }

    const ind = $('#statusIndicator');
    ind.textContent = current.status;
    ind.className = 'status-indicator';
    if (current.status === 'in-progress') ind.classList.add('pulse');
    else if (current.status === 'done') ind.classList.add('done');
    else ind.classList.add('idle');
  }

  function renderStats(stats) {
    if (!stats) return;
    animateNumber($('#blocksCompleted'), stats.blocksCompleted);
    animateNumber($('#blocksTotal'), stats.blocksTotal);
    const dist = stats.modeDistribution || {};
    const modesHTML = Object.entries(dist)
      .map(([m, n]) => `<span class="mode-dot ${MODE_CLASS[m] || ''}" title="${m}: ${n} blocks">${n}</span>`)
      .join('');
    $('#modeDistribution').innerHTML = modesHTML;

    // Progress bar
    const pct = stats.blocksTotal > 0
      ? Math.round((stats.blocksCompleted / stats.blocksTotal) * 100)
      : 0;
    const progressEl = $('#dayProgress');
    if (progressEl) {
      progressEl.style.width = pct + '%';
      progressEl.setAttribute('aria-valuenow', pct);
      const label = $('#dayProgressLabel');
      if (label) label.textContent = pct + '%';
    }
  }

  function getCurrentTimeStr() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function renderTimeline(schedule) {
    if (!schedule || !schedule.blocks) return;
    const nowStr = getCurrentTimeStr();
    let nowInserted = false;

    timeline.innerHTML = schedule.blocks
      .map((block, i) => {
        // Insert "now" marker before the first block that's after current time and not done
        let nowMarker = '';
        if (!nowInserted && block.time >= nowStr && (block.status === 'upcoming' || block.status === 'in-progress')) {
          nowInserted = true;
          nowMarker = `<div class="now-marker"><span class="now-label">now</span><div class="now-line"></div></div>`;
        }
        const modeClass = MODE_CLASS[block.mode] || '';
        const statusClass = block.status || 'upcoming';
        const statusLabel =
          block.status === 'done' ? '✅' :
          block.status === 'in-progress' ? '🔄' :
          block.status === 'skipped' ? '⏭' : '';

        const artifactsHTML = (block.artifacts || [])
          .map((a) => `<a class="artifact-badge" href="${esc(a.url)}" target="_blank">${esc(a.type)}: ${esc(a.title)}</a>`)
          .join('');

        return `${nowMarker}
          <div class="block ${statusClass}" data-index="${i}" role="button" tabindex="0" aria-label="${block.time} ${block.mode}: ${block.task}">
            <div class="block-time">${esc(block.time)}</div>
            <div class="block-dot ${modeClass}"></div>
            <div class="block-content">
              <div class="block-title">${statusLabel} ${esc(block.task)}</div>
              ${block.summary ? `<div class="block-status">${esc(block.summary)}</div>` : ''}
              ${artifactsHTML ? `<div class="block-artifacts">${artifactsHTML}</div>` : ''}
            </div>
          </div>`;
      })
      .join('');

    // Scroll current block into view
    const active = timeline.querySelector('.block.in-progress');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderArtifacts(artifacts) {
    const section = $('#artifactsSection');
    const grid = $('#artifactsGrid');
    if (!artifacts || artifacts.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    const typeIcons = { pr: '🔀', repo: '📦', site: '🌐', link: '🔗' };
    grid.innerHTML = artifacts
      .map((a) => `
        <a class="artifact-card" href="${esc(a.url)}" target="_blank">
          <div class="artifact-type">${typeIcons[a.type] || '📎'} ${esc(a.type)}</div>
          <div class="artifact-title">${esc(a.title)}</div>
          ${a.description ? `<div class="artifact-desc">${esc(a.description)}</div>` : ''}
        </a>`)
      .join('');
  }

  function renderAdjustments(adjustments) {
    const section = $('#adjustmentsSection');
    const list = $('#adjustmentsList');
    if (!section || !list) return;
    if (!adjustments || adjustments.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    list.innerHTML = adjustments
      .map(a => `<li>${esc(a)}</li>`)
      .join('');
  }

  function renderRecentDays(recentDays) {
    const section = $('#recentDaysSection');
    const list = $('#recentDaysList');
    if (!section || !list) return;
    if (!recentDays || recentDays.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    list.innerHTML = recentDays
      .map((day) => {
        const d = new Date(day.date + 'T12:00:00');
        const dayName = dayNames[d.getDay()];
        const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const highlights = (day.highlights || [])
          .slice(0, 3)
          .map(h => `<li>${esc(h)}</li>`)
          .join('');
        const summaryHTML = day.summary
          ? `<div class="recent-day-summary">${esc(day.summary)}</div>`
          : '';

        return `
          <div class="recent-day-card">
            <div class="recent-day-header">
              <span class="recent-day-name">${dayName}</span>
              <span class="recent-day-date">${monthDay}</span>
              ${day.blocksCompleted > 0 ? `<span class="recent-day-blocks">${day.blocksCompleted} items</span>` : ''}
            </div>
            ${summaryHTML}
            ${highlights ? `<ul class="recent-day-highlights">${highlights}</ul>` : '<div class="recent-day-empty">No data</div>'}
          </div>`;
      })
      .join('');
  }

  function openDetail(index) {
    const blocks = currentData?.schedule?.blocks;
    if (!blocks || index < 0 || index >= blocks.length) return;
    selectedBlockIndex = index;
    const block = blocks[index];
    const backdrop = $('#detailBackdrop');

    taskDetail.hidden = false;
    void taskDetail.offsetHeight;
    taskDetail.classList.add('open');
    backdrop.classList.add('visible');

    $('#detailTime').textContent = block.time;
    $('#detailMode').textContent = `${MODE_ICONS[block.mode] || ''} ${block.mode}`;
    $('#detailMode').className = `detail-mode mode-${block.mode.toLowerCase()}`;
    $('#detailTitle').textContent = block.task;
    $('#detailSummary').textContent = block.details || block.summary || 'No details yet.';

    // Navigation hint
    const nav = $('#detailNav');
    if (nav) {
      const hasPrev = index > 0;
      const hasNext = index < blocks.length - 1;
      nav.innerHTML =
        `<button class="detail-nav-btn" id="detailPrev" ${hasPrev ? '' : 'disabled'} aria-label="Previous block">← prev</button>` +
        `<span class="detail-nav-pos">${index + 1} / ${blocks.length}</span>` +
        `<button class="detail-nav-btn" id="detailNext" ${hasNext ? '' : 'disabled'} aria-label="Next block">next →</button>`;
    }

    const artifactsEl = $('#detailArtifacts');
    artifactsEl.innerHTML = (block.artifacts || [])
      .map((a) => `<a class="artifact-badge" href="${esc(a.url)}" target="_blank">${esc(a.type)}: ${esc(a.title)}</a>`)
      .join('');

    // Highlight selected in timeline
    timeline.querySelectorAll('.block').forEach((el, i) => {
      el.classList.toggle('selected', i === index);
    });
  }

  function closeDetail() {
    selectedBlockIndex = -1;
    taskDetail.classList.remove('open');
    $('#detailBackdrop').classList.remove('visible');
    setTimeout(() => { taskDetail.hidden = true; }, 260);
    timeline.querySelectorAll('.block.selected').forEach(el => el.classList.remove('selected'));
  }

  function navigateDetail(delta) {
    const blocks = currentData?.schedule?.blocks;
    if (!blocks) return;
    const newIdx = selectedBlockIndex + delta;
    if (newIdx >= 0 && newIdx < blocks.length) {
      openDetail(newIdx);
    }
  }

  function renderAll(data) {
    renderBanner(data.current);
    renderStats(data.stats);
    renderTimeline(data.schedule);
    renderArtifacts(data.artifacts);
    renderAdjustments(data.adjustments);
    renderRecentDays(data.recentDays);
    $('#lastUpdated').textContent = new Date(data.generated).toLocaleTimeString();

    // Re-open detail if one was selected
    if (selectedBlockIndex >= 0) {
      openDetail(selectedBlockIndex);
    }
  }

  // --- Events ---

  timeline.addEventListener('click', (e) => {
    const blockEl = e.target.closest('.block');
    if (!blockEl || !currentData) return;
    // Don't intercept artifact link clicks
    if (e.target.closest('.artifact-badge')) return;
    const idx = parseInt(blockEl.dataset.index, 10);
    openDetail(idx);
  });

  // Keyboard: Enter/Space to open block
  timeline.addEventListener('keydown', (e) => {
    const blockEl = e.target.closest('.block');
    if (!blockEl) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const idx = parseInt(blockEl.dataset.index, 10);
      openDetail(idx);
    }
  });

  $('#detailClose').addEventListener('click', closeDetail);
  $('#detailBackdrop').addEventListener('click', closeDetail);

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDetail();
      return;
    }
    // Arrow nav when detail is open
    if (selectedBlockIndex >= 0) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigateDetail(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        navigateDetail(1);
      }
    }
  });

  // Delegated click for detail nav buttons
  taskDetail.addEventListener('click', (e) => {
    if (e.target.id === 'detailPrev') navigateDetail(-1);
    if (e.target.id === 'detailNext') navigateDetail(1);
  });

  // --- Polling with Visibility API + Backoff ---

  async function fetchData() {
    try {
      const res = await fetch(DATA_URL + '?t=' + Date.now());
      if (!res.ok) throw new Error(res.status);
      const text = await res.text();
      const hash = simpleHash(text);

      // Skip re-render if nothing changed
      if (hash === lastDataHash) {
        $('#pollStatus').className = 'poll-status';
        $('#pollStatus').textContent = '●';
        return;
      }

      lastDataHash = hash;
      const data = JSON.parse(text);
      currentData = data;
      renderAll(data);
      errorCount = 0;
      $('#pollStatus').className = 'poll-status';
      $('#pollStatus').textContent = '●';
    } catch (err) {
      console.warn('Poll failed:', err);
      errorCount++;
      $('#pollStatus').className = 'poll-status error';
      $('#pollStatus').textContent = '●';
    }
  }

  function getInterval() {
    if (document.hidden) return POLL_INTERVAL_HIDDEN;
    if (errorCount > 0) return Math.min(POLL_INTERVAL * Math.pow(2, errorCount), MAX_BACKOFF);
    return POLL_INTERVAL;
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await fetchData();
      schedulePoll();
    }, getInterval());
  }

  function startPolling() {
    fetchData().then(schedulePoll);
  }

  // Adjust polling when tab visibility changes
  document.addEventListener('visibilitychange', () => {
    // Reschedule with appropriate interval
    schedulePoll();
    // Fetch immediately when becoming visible
    if (!document.hidden) fetchData();
  });

  // --- Util ---

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // --- Touch: swipe-to-dismiss detail panel ---
  (function () {
    let startY = 0;
    let currentY = 0;
    let dragging = false;

    taskDetail.addEventListener('touchstart', (e) => {
      if (taskDetail.scrollTop > 0) return; // only when scrolled to top
      startY = e.touches[0].clientY;
      dragging = true;
    }, { passive: true });

    taskDetail.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      currentY = e.touches[0].clientY;
      const dy = currentY - startY;
      if (dy > 0) {
        taskDetail.style.transform = `translateY(${dy}px)`;
      }
    }, { passive: true });

    taskDetail.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      const dy = currentY - startY;
      if (dy > 80) {
        closeDetail();
      }
      taskDetail.style.transform = '';
    }, { passive: true });
  })();

  // --- Init ---
  startPolling();
})();
