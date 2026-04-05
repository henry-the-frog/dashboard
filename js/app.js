// Henry's Work Dashboard — Main App
(function () {
  'use strict';

  const DATA_URL = 'data/dashboard.json';
  const API_URL = 'https://lawyer-servers-technology-continually.trycloudflare.com'
  const POLL_INTERVAL = 10000; // 10s when API is live
  const POLL_INTERVAL_STATIC = 30000; // 30s for static fallback
  const POLL_INTERVAL_HIDDEN = 120000;
  const MAX_BACKOFF = 300000;

  const MODE_ICONS = {
    BUILD: '🔨',
    THINK: '🧠',
    PLAN: '📋',
    EXPLORE: '🔍',
    MAINTAIN: '🔧',
  };

  const MODE_CLASS = {
    BUILD: 'mode-build',
    THINK: 'mode-think',
    PLAN: 'mode-plan',
    EXPLORE: 'mode-explore',
    MAINTAIN: 'mode-maintain',
  };

  // --- State ---
  let currentData = null;
  let lastDataHash = null;
  let pollTimer = null;
  let errorCount = 0;
  let selectedBlockIndex = -1;
  let tickTimer = null;

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

    // Time remaining in day
    const timeRemEl = $('#timeRemaining');
    if (timeRemEl) {
      updateTimeRemaining(stats, timeRemEl);
    }
  }

  function updateTimeRemaining(stats, el) {
    if (!stats || !currentData?.schedule?.blocks) {
      if (el) el.textContent = '';
      return;
    }
    const blocks = currentData.schedule.blocks;
    const remaining = blocks.filter(b => b.status === 'upcoming' || b.status === 'in-progress').length;
    if (el) {
      el.textContent = `${remaining} left`;
    }
  }

  function getCurrentTimeStr() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function renderTimeline(schedule) {
    if (!schedule || !schedule.blocks) return;
    let nowInserted = false;

    timeline.innerHTML = schedule.blocks
      .map((block, i) => {
        // Insert "now" marker before the first in-progress or upcoming task
        let nowMarker = '';
        if (!nowInserted && (block.status === 'in-progress' || block.status === 'upcoming')) {
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
              <div class="block-title">${statusLabel} ${esc(block.task)}${block.status === 'done' && block.durationFormatted ? ` <span class="block-duration">${esc(block.durationFormatted)}</span>` : ''}</div>
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

  function renderNextUp(schedule) {
    const section = $('#nextUp');
    const list = $('#nextUpList');
    if (!section || !list || !schedule?.blocks) return;

    const upcoming = schedule.blocks.filter(b =>
      (b.status === 'upcoming' || b.status === 'in-progress')
    ).slice(0, 4);

    if (upcoming.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    list.innerHTML = upcoming.map((block, i) => {
      const modeClass = `mode-${block.mode.toLowerCase()}`;
      const label = i === 0 && block.status === 'in-progress' ? 'Now' : (block.id || block.time);
      return `
        <div class="next-up-card">
          <div class="next-up-time">${esc(label)}</div>
          <div class="next-up-mode ${modeClass}">${MODE_ICONS[block.mode] || ''} ${esc(block.mode)}</div>
          <div class="next-up-task">${esc(block.task)}</div>
        </div>`;
    }).join('');
  }

  function renderModeBar(stats) {
    const bar = $('#modeBar');
    const legend = $('#modeBarLegend');
    if (!bar || !legend || !stats) return;
    const dist = stats.modeDistribution || {};
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    if (total === 0) {
      bar.innerHTML = '';
      legend.innerHTML = '';
      return;
    }
    const modes = ['BUILD', 'THINK', 'PLAN', 'EXPLORE', 'MAINTAIN'];
    bar.innerHTML = modes
      .filter(m => dist[m] > 0)
      .map(m => {
        const pct = ((dist[m] / total) * 100).toFixed(1);
        return `<div class="mode-bar-segment mode-${m.toLowerCase()}" style="width:${pct}%" title="${m}: ${dist[m]} blocks (${Math.round(pct)}%)"></div>`;
      }).join('');
    legend.innerHTML = modes
      .filter(m => dist[m] > 0)
      .map(m => {
        const pct = Math.round((dist[m] / total) * 100);
        return `<span class="mode-bar-legend-item"><span class="mode-bar-legend-dot mode-${m.toLowerCase()}"></span>${MODE_ICONS[m]} ${dist[m]} (${pct}%)</span>`;
      }).join('');
  }

  function renderDurationChart(schedule) {
    const section = $('#durationChartSection');
    const chart = $('#durationChart');
    const statsEl = $('#durationStats');
    if (!section || !chart || !schedule?.blocks) return;

    const blocksWithTime = schedule.blocks.filter(b => b.status === 'done' && b.durationMs > 0);
    if (blocksWithTime.length < 3) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    const maxDuration = Math.max(...blocksWithTime.map(b => b.durationMs));
    const maxHeight = 100; // px

    chart.innerHTML = blocksWithTime.map((block, i) => {
      const height = Math.max(4, Math.round((block.durationMs / maxDuration) * maxHeight));
      const mins = (block.durationMs / 60000).toFixed(1);
      const modeClass = `mode-${block.mode.toLowerCase()}`;
      return `<div class="duration-bar ${modeClass}" style="height:${height}px;animation-delay:${i * 20}ms" title="${block.time} ${block.mode}: ${mins}m">
        <div class="duration-bar-tooltip">${block.time} · ${mins}m</div>
      </div>`;
    }).join('');

    // Compute stats
    const durations = blocksWithTime.map(b => b.durationMs);
    const totalMs = durations.reduce((a, b) => a + b, 0);
    const avgMs = totalMs / durations.length;
    const sorted = [...durations].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];

    // Avg by mode
    const modeAvgs = {};
    for (const b of blocksWithTime) {
      if (!modeAvgs[b.mode]) modeAvgs[b.mode] = { total: 0, count: 0 };
      modeAvgs[b.mode].total += b.durationMs;
      modeAvgs[b.mode].count++;
    }

    const fmtMin = (ms) => {
      const m = ms / 60000;
      return m >= 1 ? `${m.toFixed(1)}m` : `${Math.round(ms / 1000)}s`;
    };

    let statsHTML = `
      <div class="duration-stat"><span class="duration-stat-value">${fmtMin(avgMs)}</span><span class="duration-stat-label">avg</span></div>
      <div class="duration-stat"><span class="duration-stat-value">${fmtMin(medianMs)}</span><span class="duration-stat-label">median</span></div>
      <div class="duration-stat"><span class="duration-stat-value">${fmtMin(totalMs)}</span><span class="duration-stat-label">total</span></div>
    `;
    for (const [mode, data] of Object.entries(modeAvgs)) {
      const avg = data.total / data.count;
      statsHTML += `<div class="duration-stat"><span class="duration-stat-value">${fmtMin(avg)}</span><span class="duration-stat-label">${MODE_ICONS[mode] || ''} avg</span></div>`;
    }
    statsEl.innerHTML = statsHTML;
  }

  function renderBlogPosts(posts) {
    const section = $('#blogSection');
    const list = $('#blogList');
    if (!section || !list) return;
    if (!posts || posts.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    const countLabel = posts.length === 1 ? '1 post' : `${posts.length} posts`;
    section.querySelector('h2').innerHTML = `📝 Blog Posts <span class="section-count">${esc(countLabel)}</span>`;

    list.innerHTML = posts.map(post => {
      const date = new Date(post.date + 'T12:00:00');
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const tags = (post.categories || []).slice(0, 3)
        .map(c => `<span class="blog-tag">${esc(c)}</span>`).join('');
      return `
        <a class="blog-card" href="${esc(post.url)}" target="_blank">
          <div class="blog-date">${dateStr}</div>
          <div class="blog-title">${esc(post.title)}</div>
          <div class="blog-meta">
            ${tags}
            <span class="blog-reading-time">${post.readingTime} min read</span>
          </div>
        </a>`;
    }).join('');
  }

  function renderBacklog(schedule) {
    const section = $('#backlogSection');
    const list = $('#backlogList');
    if (!section || !list) return;
    const backlog = schedule?.backlog;
    if (!backlog || backlog.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    const countLabel = backlog.length === 1 ? '1 item' : `${backlog.length} items`;
    section.querySelector('h2').innerHTML = `📋 Backlog <span class="section-count">${esc(countLabel)}</span>`;
    list.innerHTML = backlog.map(item => `<li>${esc(item)}</li>`).join('');
  }

  function renderPRs(prs) {
    const section = $('#prsSection');
    const list = $('#prsList');
    if (!section || !list) return;
    if (!prs || prs.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    const countLabel = prs.length === 1 ? '1 PR' : `${prs.length} PRs`;
    section.querySelector('h2').innerHTML = `🔀 Open PRs <span class="section-count">${esc(countLabel)}</span>`;

    const ciIcons = { pass: '✅', fail: '❌', pending: '⏳', none: '⚪', unknown: '⚪' };
    const reviewIcons = { approved: '👍', changes_requested: '🔄', review_required: '👀', none: '' };

    list.innerHTML = prs.map(pr => {
      const age = pr.ageHours;
      const ageStr = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
      const ageClass = age > 72 ? 'pr-stale' : age > 24 ? 'pr-waiting' : 'pr-fresh';
      const repo = pr.repo.split('/').pop();
      const ci = ciIcons[pr.ciStatus] || '⚪';
      const review = reviewIcons[pr.reviewStatus] || '';
      return `
        <a class="pr-card ${ageClass}" href="${esc(pr.url)}" target="_blank">
          <div class="pr-number">#${pr.number}</div>
          <div class="pr-title">${esc(pr.title)}</div>
          <div class="pr-meta">
            <span class="pr-repo">${esc(repo)}</span>
            <span class="pr-ci" title="CI: ${pr.ciStatus || 'unknown'}">${ci}</span>
            ${review ? `<span class="pr-review" title="Review: ${pr.reviewStatus}">${review}</span>` : ''}
            <span class="pr-age">${ageStr}</span>
          </div>
        </a>`;
    }).join('');
  }

  function renderSessionInfo(data) {
    const stat = $('#sessionStat');
    const val = $('#sessionValue');
    const label = $('#sessionLabel');
    if (!stat || !val) return;

    // Determine active session from current time
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const mins = h * 60 + m;
    const sessions = [
      { name: 'A', start: 8*60+15, end: 14*60+15 },
      { name: 'B', start: 14*60+15, end: 20*60+15 },
      { name: 'C', start: 20*60+15, end: 22*60+15 },
    ];
    const active = sessions.find(s => mins >= s.start && mins < s.end);
    if (!active) {
      stat.style.display = '';
      val.textContent = '💤';
      if (label) label.textContent = 'offline';
      return;
    }

    const remMins = active.end - mins;
    const remH = Math.floor(remMins / 60);
    const remM = remMins % 60;
    const timeStr = remH > 0 ? `${remH}h ${remM}m` : `${remM}m`;

    stat.style.display = '';
    val.textContent = timeStr;
    if (label) label.textContent = `session ${active.name}`;

    // Pace stat
    const paceStat = $('#paceStat');
    const paceVal = $('#paceValue');
    if (paceStat && paceVal && data.stats) {
      const elapsed = mins - active.start;
      if (elapsed > 0 && data.stats.blocksCompleted > 0) {
        const pace = (data.stats.blocksCompleted / (elapsed / 60)).toFixed(1);
        paceStat.style.display = '';
        paceVal.textContent = pace;
      }
    }
  }

  function renderTrendSparkline(recentDays, todayBlocks) {
    const stat = $('#trendStat');
    const svg = $('#trendSparkline');
    if (!stat || !svg) return;

    // Build data: recent days (oldest→newest) + today
    const days = (recentDays || []).slice().reverse();
    const points = days.map(d => ({ label: d.date.slice(5), value: d.blocksCompleted || 0 }));
    // Add today
    points.push({ label: 'today', value: todayBlocks || 0 });

    if (points.length < 2) {
      stat.style.display = 'none';
      return;
    }
    stat.style.display = '';

    const W = 120, H = 40, padY = 6, padX = 4;
    const maxVal = Math.max(...points.map(p => p.value), 1);
    const stepX = (W - padX * 2) / (points.length - 1);

    const coords = points.map((p, i) => ({
      x: padX + i * stepX,
      y: padY + (1 - p.value / maxVal) * (H - padY * 2 - 8),
      ...p,
    }));

    // Build path
    const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
    const areaPath = linePath + ` L ${coords[coords.length - 1].x.toFixed(1)} ${H - padY} L ${coords[0].x.toFixed(1)} ${H - padY} Z`;

    // Dots
    const dots = coords.map((c, i) => {
      const isToday = i === coords.length - 1;
      const cls = isToday ? 'trend-dot-today' : 'trend-dot';
      const r = isToday ? 3 : 2;
      return `<circle class="${cls}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r}"><title>${c.label}: ${c.value} blocks</title></circle>`;
    }).join('');

    // Day labels (show first, last, and today)
    const labels = coords
      .filter((_, i) => i === 0 || i === coords.length - 1)
      .map(c => `<text class="trend-label" x="${c.x.toFixed(1)}" y="${H - 1}">${c.label}</text>`)
      .join('');

    svg.innerHTML = `<path class="trend-area" d="${areaPath}"/><path class="trend-line" d="${linePath}"/>${dots}${labels}`;
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

  function renderHighlights(highlights) {
    const section = $('#highlightsSection');
    const list = $('#highlightsList');
    if (!section || !list) return;
    if (!highlights || highlights.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    list.innerHTML = highlights.map(h => {
      const modeClass = `mode-${h.mode.toLowerCase()}`;
      return `<li class="highlight-item">
        <span class="highlight-dot ${modeClass}"></span>
        <span class="highlight-time">${esc(h.time)}</span>
        <span class="highlight-text">${esc(h.text)}</span>
      </li>`;
    }).join('');
  }

  function renderWeeklySummary(recentDays, todayStats) {
    const section = $('#weeklySummarySection');
    const statsEl = $('#weeklyStats');
    const chartEl = $('#weeklyChart');
    const modeEl = $('#weeklyModeBreakdown');
    if (!section || !recentDays || recentDays.length === 0) return;
    section.style.display = '';

    // Build days array (oldest first), include today
    const days = [...recentDays].reverse();
    const todayDate = new Date().toISOString().slice(0, 10);
    const todayBlocks = todayStats?.blocksCompleted || 0;
    const todayDist = todayStats?.modeDistribution || {};

    // Add today if not already in recentDays
    if (!days.find(d => d.date === todayDate)) {
      days.push({ date: todayDate, blocksCompleted: todayBlocks, modeDistribution: todayDist, highlights: [] });
    } else {
      // Update today's entry with live stats
      const todayEntry = days.find(d => d.date === todayDate);
      if (todayEntry) {
        todayEntry.blocksCompleted = todayBlocks;
        todayEntry.modeDistribution = todayDist;
      }
    }

    // Aggregate stats
    const totalBlocks = days.reduce((s, d) => s + (d.blocksCompleted || 0), 0);
    const activeDays = days.filter(d => d.blocksCompleted > 0).length;
    const avgBlocks = activeDays > 0 ? Math.round(totalBlocks / activeDays) : 0;
    const maxBlocks = Math.max(...days.map(d => d.blocksCompleted || 0));

    // Aggregate mode distribution
    const totalModes = {};
    const modes = ['BUILD', 'THINK', 'PLAN', 'EXPLORE', 'MAINTAIN'];
    for (const day of days) {
      const dist = day.modeDistribution || {};
      for (const m of modes) {
        totalModes[m] = (totalModes[m] || 0) + (dist[m] || 0);
      }
    }
    const modeTotal = Object.values(totalModes).reduce((a, b) => a + b, 0);

    // Stats row
    statsEl.innerHTML = `
      <div class="weekly-stat"><span class="weekly-stat-value">${totalBlocks}</span><span class="weekly-stat-label">tasks</span></div>
      <div class="weekly-stat"><span class="weekly-stat-value">${avgBlocks}</span><span class="weekly-stat-label">avg/day</span></div>
      <div class="weekly-stat"><span class="weekly-stat-value">${activeDays}</span><span class="weekly-stat-label">active days</span></div>
      <div class="weekly-stat"><span class="weekly-stat-value">${maxBlocks}</span><span class="weekly-stat-label">best day</span></div>
    `;

    // Bar chart (stacked by mode)
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const chartMax = Math.max(maxBlocks, 1);

    chartEl.innerHTML = days.map(day => {
      const d = new Date(day.date + 'T12:00:00');
      const dayName = dayNames[d.getDay()];
      const isToday = day.date === todayDate;
      const dist = day.modeDistribution || {};
      const total = day.blocksCompleted || 0;
      const totalHeight = (total / chartMax) * 80; // max 80px

      const segments = modes.filter(m => dist[m] > 0).map(m => {
        const h = totalHeight > 0 ? (dist[m] / total) * totalHeight : 0;
        return `<div class="weekly-bar-segment mode-${m.toLowerCase()}" style="height:${h.toFixed(1)}px" title="${m}: ${dist[m]}"></div>`;
      }).join('');

      return `<div class="weekly-bar-group">
        <span class="weekly-bar-count">${total || ''}</span>
        <div class="weekly-bar-stack" style="height:${totalHeight.toFixed(1)}px">${segments}</div>
        <span class="weekly-bar-label ${isToday ? 'is-today' : ''}">${dayName}</span>
      </div>`;
    }).join('');

    // Mode breakdown
    modeEl.innerHTML = modes.filter(m => totalModes[m] > 0).map(m => {
      const pct = modeTotal > 0 ? Math.round((totalModes[m] / modeTotal) * 100) : 0;
      return `<div class="weekly-mode-item">
        <span class="weekly-mode-dot mode-${m.toLowerCase()}"></span>
        ${MODE_ICONS[m]} <span class="weekly-mode-value">${totalModes[m]}</span> ${m.toLowerCase()} <span class="weekly-mode-pct">(${pct}%)</span>
      </div>`;
    }).join('');
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

        // Mini mode bar
        const dist = day.modeDistribution || {};
        const modeTotal = Object.values(dist).reduce((a, b) => a + b, 0);
        const modes = ['BUILD', 'THINK', 'PLAN', 'EXPLORE', 'MAINTAIN'];
        const miniBar = modeTotal > 0
          ? `<div class="mini-mode-bar">${modes.filter(m => dist[m] > 0).map(m => {
              const pct = ((dist[m] / modeTotal) * 100).toFixed(1);
              return `<div class="mini-mode-segment mode-${m.toLowerCase()}" style="width:${pct}%" title="${m}: ${dist[m]}"></div>`;
            }).join('')}</div>`
          : '';

        return `
          <div class="recent-day-card">
            <div class="recent-day-header">
              <span class="recent-day-name">${dayName}</span>
              <span class="recent-day-date">${monthDay}</span>
              ${day.blocksCompleted > 0 ? `<span class="recent-day-blocks">${day.blocksCompleted} items</span>` : ''}
            </div>
            ${miniBar}
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

    // Duration
    const durationEl = $('#detailDuration');
    if (durationEl) {
      if (block.durationFormatted) {
        durationEl.textContent = `⏱ ${block.durationFormatted}`;
        durationEl.style.display = '';
      } else if (block.status === 'in-progress' && block.startedAt) {
        const elapsed = Math.round((Date.now() - new Date(block.startedAt).getTime()) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        durationEl.textContent = `⏱ ${mins}m ${secs}s (running)`;
        durationEl.style.display = '';
      } else {
        durationEl.textContent = '';
        durationEl.style.display = 'none';
      }
    }

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

  function renderHeatmap(schedule) {
    const section = $('#heatmapSection');
    const grid = $('#heatmapGrid');
    const labels = $('#heatmapTimeLabels');
    if (!section || !grid || !schedule?.blocks || schedule.blocks.length === 0) return;
    section.style.display = '';

    let html = '';
    let lastHour = null;
    schedule.blocks.forEach((block, i) => {
      const hour = block.time.split(':')[0];
      // Insert hour separator + label when hour changes
      if (hour !== lastHour && lastHour !== null) {
        html += `<div class="heatmap-separator" title="${hour}:00"></div>`;
      }
      lastHour = hour;
      const tooltip = `${block.time} ${MODE_ICONS[block.mode] || ''} ${block.mode}: ${block.task.substring(0, 50)}`;
      html += `<div class="heatmap-cell" data-mode="${block.mode}" data-status="${block.status}" data-index="${i}" title="">
        <span class="heatmap-tooltip">${esc(tooltip)}</span>
      </div>`;
    });
    grid.innerHTML = html;

    // Time labels: show each hour
    const hours = [...new Set(schedule.blocks.map(b => b.time.split(':')[0]))];
    labels.innerHTML = hours.map(h => `<span>${h}:00</span>`).join('');

    // Click to open detail
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.heatmap-cell');
      if (!cell) return;
      const idx = parseInt(cell.dataset.index, 10);
      if (!isNaN(idx)) openDetail(idx);
    });
  }

  function renderBenchmarks(benchmarks) {
    const section = $('#benchmarksSection');
    const aggEl = $('#benchmarksAggregate');
    const chart = $('#benchmarksChart');
    const meta = $('#benchmarksMeta');
    if (!section || !benchmarks || !benchmarks.results) return;
    section.style.display = '';

    // Aggregate badge
    aggEl.innerHTML = `<span class="bench-aggregate-value">${benchmarks.aggregate}×</span><span class="bench-aggregate-label">geometric mean speedup (JIT vs VM)</span>`;

    // Sort by speedup descending
    const sorted = [...benchmarks.results].filter(r => r.correct).sort((a, b) => b.jitVsVm - a.jitVsVm);
    const maxSpeedup = Math.max(...sorted.map(r => r.jitVsVm), 1);

    chart.innerHTML = sorted.map(r => {
      const pct = Math.max(2, (r.jitVsVm / maxSpeedup) * 100);
      const color = r.jitVsVm >= 5 ? 'var(--mode-build)' : r.jitVsVm >= 2 ? 'var(--mode-explore)' : 'var(--mode-maintain)';
      return `<div class="bench-row">
        <span class="bench-name">${esc(r.name)}</span>
        <div class="bench-bar-track">
          <div class="bench-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
        </div>
        <span class="bench-value">${r.jitVsVm.toFixed(1)}×</span>
      </div>`;
    }).join('');

    // Meta line
    const ts = benchmarks.timestamp ? new Date(benchmarks.timestamp).toLocaleString() : '';
    meta.innerHTML = `<span>${benchmarks.count} benchmarks</span><span>commit ${esc(benchmarks.gitHash || '?')}</span>${ts ? `<span>${ts}</span>` : ''}`;
  }

  let projectsFilterState = 'all';

  function renderVitalStats(vitalStats) {
    const section = $('#vitalStatsSection');
    const grid = $('#vitalStatsGrid');
    if (!section || !grid || !vitalStats) return;
    if (!vitalStats.totalTests && !vitalStats.totalRepos) return;
    section.style.display = '';

    const cards = [
      { icon: '🧪', value: vitalStats.totalTests, label: 'tests', cls: 'stat-accent' },
      { icon: '📦', value: vitalStats.totalProjectCount || vitalStats.totalRepos, label: 'projects', cls: 'stat-gold' },
      { icon: '📝', value: vitalStats.totalBlogPosts, label: 'blog posts', cls: 'stat-purple' },
      { icon: '🔥', value: vitalStats.streak, label: 'day streak', cls: 'stat-green' },
      { icon: '⚡', value: vitalStats.totalTasksWeek, label: 'tasks this week', cls: '' },
    ];

    // Test count breakdown by project (top 10)
    const testCounts = vitalStats.testCounts || {};
    const breakdownHTML = Object.entries(testCounts)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => `<span class="test-breakdown-item">${esc(name)}: ${count.toLocaleString()}</span>`)
      .join('');

    grid.innerHTML = cards.map(c => `
      <div class="vital-stat-card ${c.cls}">
        <div class="vital-stat-icon">${c.icon}</div>
        <div class="vital-stat-value">${c.value.toLocaleString()}</div>
        <div class="vital-stat-label">${esc(c.label)}</div>
      </div>
    `).join('') + (breakdownHTML ? `
      <div class="vital-stat-card stat-breakdown">
        <div class="vital-stat-icon">📊</div>
        <div class="vital-stat-label">Test Breakdown</div>
        <div class="test-breakdown">${breakdownHTML}</div>
      </div>
    ` : '');
  }

  function renderSessionHealth(data) {
    const section = $('#sessionHealthSection');
    const el = $('#sessionHealth');
    if (!section || !el) return;

    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const mins = h * 60 + m;
    const sessions = [
      { name: 'A', start: 8*60+15, end: 14*60+15, label: '8:15am–2:15pm' },
      { name: 'B', start: 14*60+15, end: 20*60+15, label: '2:15pm–8:15pm' },
      { name: 'C', start: 20*60+15, end: 22*60+15, label: '8:15pm–10:15pm' },
    ];
    const active = sessions.find(s => mins >= s.start && mins < s.end);
    if (!active) {
      section.style.display = '';
      el.innerHTML = `<span class="session-health-label">💤 Between sessions</span>`;
      return;
    }

    section.style.display = '';

    const elapsed = mins - active.start;
    const total = active.end - active.start;
    const remaining = active.end - mins;
    const pct = Math.round((elapsed / total) * 100);

    const stats = data.stats || {};
    const completed = stats.blocksCompleted || 0;
    const tasksTotal = stats.blocksTotal || 0;
    const tasksLeft = tasksTotal - completed;

    // Pace
    const pace = elapsed > 0 ? (completed / (elapsed / 60)).toFixed(1) : '—';

    // Projected completion
    const avgMinsPerTask = completed > 0 ? elapsed / completed : 0;
    const projectedMinsNeeded = tasksLeft * avgMinsPerTask;
    const willFinish = projectedMinsNeeded <= remaining;

    // Status
    let fillClass = 'on-track';
    let statusEmoji = '🟢';
    if (remaining <= 15) {
      fillClass = 'winding-down';
      statusEmoji = '🌅';
    } else if (!willFinish && tasksLeft > 0) {
      fillClass = 'behind';
      statusEmoji = '🟡';
    }

    const remH = Math.floor(remaining / 60);
    const remM = remaining % 60;
    const remStr = remH > 0 ? `${remH}h ${remM}m` : `${remM}m`;

    el.innerHTML = `
      <span class="session-health-label">${statusEmoji} Session ${active.name}</span>
      <span class="session-health-detail">${active.label}</span>
      <div class="session-health-bar"><div class="session-health-fill ${fillClass}" style="width:${pct}%"></div></div>
      <span class="session-health-detail">${remStr} left</span>
      <span class="session-health-pace">${pace} tasks/hr</span>
      ${tasksLeft > 0 ? `<span class="session-health-projected">${tasksLeft} tasks remaining${willFinish ? ' ✓' : ''}</span>` : '<span class="session-health-projected">Queue done ✓</span>'}
    `;
  }

  function renderProjectDepth(projectDepth) {
    const section = $('#projectDepthSection');
    const grid = $('#projectDepthGrid');
    if (!section || !grid || !projectDepth || projectDepth.length === 0) return;
    section.style.display = '';

    // Update heading count
    const countEl = document.getElementById('projectDepthCount');
    if (countEl) countEl.textContent = projectDepth.length;

    // Category counts
    const cats = {};
    for (const p of projectDepth) {
      cats[p.category] = (cats[p.category] || 0) + 1;
    }

    const catLabels = {
      all: `All (${projectDepth.length})`,
      language: '💬 Languages', compiler: '⚙️ Compilers', solver: '🧮 Solvers',
      'data-structure': '🌳 Data Structures', algorithm: '📐 Algorithms',
      parser: '📝 Parsers', systems: '🌐 Systems', visual: '🎨 Visual',
      ml: '🧠 ML', crypto: '🔐 Crypto', physics: '⚛️ Physics', utility: '🔧 Utility',
    };

    let activeCategory = 'all';
    let searchQuery = '';
    const PAGE_SIZE = 24;
    let visibleCount = PAGE_SIZE;

    function getFiltered() {
      return projectDepth.filter(p => {
        if (activeCategory !== 'all' && p.category !== activeCategory) return false;
        if (searchQuery && !p.name.toLowerCase().includes(searchQuery) && !(p.description || '').toLowerCase().includes(searchQuery)) return false;
        return true;
      });
    }

    function renderGrid() {
      const filtered = getFiltered();
      const showing = filtered.slice(0, visibleCount);

      // Stats summary
      const totalTests = filtered.reduce((s, p) => s + (p.tests || 0), 0);
      const totalLines = filtered.reduce((s, p) => s + (p.srcLines || 0), 0);

      let html = `<div class="depth-summary">${filtered.length} projects · ${totalTests.toLocaleString()} tests · ${(totalLines/1000).toFixed(0)}k lines</div>`;

      html += showing.map(p => {
        const freshness = p.lastCommit ? (() => {
          const age = Math.round((Date.now() - new Date(p.lastCommit).getTime()) / 86400000);
          return age === 0 ? 'today' : age === 1 ? '1d ago' : `${age}d ago`;
        })() : '';

        return `
          <div class="depth-card depth-cat-${esc(p.category)}">
            <div class="depth-card-header">
              <span class="depth-card-icon">${p.icon}</span>
              <span class="depth-card-name">${esc(p.name)}</span>
              <span class="depth-card-cat">${esc(p.category)}</span>
            </div>
            <div class="depth-card-desc">${esc(p.description)}</div>
            <div class="depth-card-stats">
              ${p.tests > 0 ? `<div class="depth-stat"><span class="depth-stat-value">${p.tests}</span><span class="depth-stat-label">tests</span></div>` : ''}
              ${p.srcFiles > 0 ? `<div class="depth-stat"><span class="depth-stat-value">${p.srcFiles}</span><span class="depth-stat-label">files</span></div>` : ''}
              ${p.srcLines > 0 ? `<div class="depth-stat"><span class="depth-stat-value">${(p.srcLines / 1000).toFixed(1)}k</span><span class="depth-stat-label">lines</span></div>` : ''}
            </div>
            <div class="depth-card-links">
              <a class="depth-link" href="${esc(p.url)}" target="_blank">📦 Code</a>
            </div>
            ${freshness ? `<div class="depth-card-freshness">${freshness}</div>` : ''}
          </div>`;
      }).join('');

      if (filtered.length > visibleCount) {
        html += `<button class="depth-load-more" id="depthLoadMore">Show more (${filtered.length - visibleCount} remaining)</button>`;
      }

      grid.innerHTML = html;

      const loadMore = document.getElementById('depthLoadMore');
      if (loadMore) {
        loadMore.addEventListener('click', () => {
          visibleCount += PAGE_SIZE;
          renderGrid();
        });
      }
    }

    // Render filter bar + search
    const filterHTML = `
      <div class="depth-controls">
        <div class="depth-filters">
          ${Object.entries(catLabels).filter(([k]) => k === 'all' || cats[k]).map(([k, label]) =>
            `<button class="depth-filter-btn${k === 'all' ? ' active' : ''}" data-cat="${k}">${label}${k !== 'all' && cats[k] ? ` (${cats[k]})` : ''}</button>`
          ).join('')}
        </div>
        <input class="depth-search" type="text" placeholder="Search projects…" id="depthSearch">
      </div>
    `;

    // Insert controls before grid
    const existingControls = section.querySelector('.depth-controls');
    if (existingControls) existingControls.remove();
    grid.insertAdjacentHTML('beforebegin', filterHTML);

    // Wire up filter buttons
    section.querySelectorAll('.depth-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        section.querySelectorAll('.depth-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeCategory = btn.dataset.cat;
        visibleCount = PAGE_SIZE;
        renderGrid();
      });
    });

    // Wire up search
    const searchInput = document.getElementById('depthSearch');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        visibleCount = PAGE_SIZE;
        renderGrid();
      });
    }

    renderGrid();
  }

  function renderProjects(projects) {
    const section = $('#projectsSection');
    const grid = $('#projectsGrid');
    const filterEl = $('#projectsFilter');
    if (!section || !grid) return;
    if (!projects || projects.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    // Count by category
    const cats = {};
    for (const p of projects) {
      cats[p.category] = (cats[p.category] || 0) + 1;
    }

    const catLabels = {
      all: `All (${projects.length})`,
      featured: `⭐ Featured (${cats.featured || 0})`,
      visual: `🎨 Visual (${cats.visual || 0})`,
      language: `💬 Languages (${cats.language || 0})`,
      parser: `📄 Parsers (${cats.parser || 0})`,
      'data-structure': `🏗 Data Structures (${cats['data-structure'] || 0})`,
      utility: `🔧 Utilities (${cats.utility || 0})`,
    };

    // Update section header with count
    section.querySelector('h2').innerHTML = `📦 Projects <span class="section-count">${projects.length} repos</span>`;

    // Render filter buttons
    if (filterEl) {
      filterEl.innerHTML = Object.entries(catLabels)
        .filter(([k]) => k === 'all' || (cats[k] || 0) > 0)
        .map(([k, label]) =>
          `<button class="projects-filter-btn${projectsFilterState === k ? ' active' : ''}" data-cat="${k}">${label}</button>`
        ).join('');

      filterEl.onclick = (e) => {
        const btn = e.target.closest('.projects-filter-btn');
        if (!btn) return;
        projectsFilterState = btn.dataset.cat;
        renderProjects(projects);
      };
    }

    const filtered = projectsFilterState === 'all' ? projects : projects.filter(p => p.category === projectsFilterState);

    grid.innerHTML = filtered.map(p => {
      const age = Math.round((Date.now() - new Date(p.pushedAt).getTime()) / 86400000);
      const ageStr = age === 0 ? 'today' : age === 1 ? '1d ago' : `${age}d ago`;
      const catClass = `proj-cat-${p.category}`;
      return `<a class="project-card ${catClass}" href="${esc(p.url)}" target="_blank">
        <div class="project-name">${esc(p.name)}</div>
        <div class="project-desc">${esc(p.description || '—')}</div>
        <div class="project-meta">
          ${p.language ? `<span class="project-lang">${esc(p.language)}</span>` : ''}
          <span class="project-age">${ageStr}</span>
          ${p.stars > 0 ? `<span class="project-stars">⭐ ${p.stars}</span>` : ''}
        </div>
      </a>`;
    }).join('');
  }

  function renderAll(data) {
    const renders = [
      ['banner', () => renderBanner(data.current)],
      ['stats', () => renderStats(data.stats)],
      ['heatmap', () => renderHeatmap(data.schedule)],
      ['vitalStats', () => renderVitalStats(data.vitalStats)],
      ['sessionHealth', () => renderSessionHealth(data)],
      ['projectDepth', () => renderProjectDepth(data.projectDepth)],
      ['modeBar', () => renderModeBar(data.stats)],
      ['highlights', () => renderHighlights(data.todayHighlights)],
      ['durationChart', () => renderDurationChart(data.schedule)],
      ['nextUp', () => renderNextUp(data.schedule)],
      ['timeline', () => renderTimeline(data.schedule)],
      ['artifacts', () => renderArtifacts(data.artifacts)],
      ['adjustments', () => renderAdjustments(data.adjustments)],
      ['recentDays', () => renderRecentDays(data.recentDays)],
      ['weeklySummary', () => renderWeeklySummary(data.recentDays, data.stats)],
      ['prs', () => renderPRs(data.prs)],
      ['blogPosts', () => renderBlogPosts(data.blogPosts)],
      ['backlog', () => renderBacklog(data.schedule)],
      ['benchmarks', () => renderBenchmarks(data.benchmarks)],
      ['projects', () => renderProjects(data.projects)],
      ['session', () => renderSessionInfo(data)],
      ['sparkline', () => renderTrendSparkline(data.recentDays, data.stats?.blocksCompleted || 0)],
    ];
    for (const [name, fn] of renders) {
      try { fn(); } catch (e) { console.error(`renderAll: ${name} failed:`, e); }
    }
    try { $('#lastUpdated').textContent = new Date(data.generated).toLocaleTimeString(); } catch {}

    // Re-open detail if one was selected
    if (selectedBlockIndex >= 0) {
      openDetail(selectedBlockIndex);
    }

    initCollapsible();
    renderWorkdayProgress();
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

  let apiAvailable = false;

  // Transform API server format to the format the dashboard renderer expects
  function transformApiData(api) {
    const queue = api.queue || [];
    const active = queue.filter(t => t.status !== 'skipped');
    const done = active.filter(t => t.status === 'done');
    const blocked = active.filter(t => t.status === 'blocked');
    const inProgress = active.find(t => t.status === 'in-progress');

    // Build mode distribution (exclude skipped)
    const modeDist = {};
    for (const t of active) {
      modeDist[t.mode] = (modeDist[t.mode] || 0) + 1;
    }

    // Build blocks array from queue (renderer expects this)
    const blocks = queue.filter(t => t.status !== 'skipped').map((t, i) => {
      let timeLabel;
      if (t.started) {
        timeLabel = new Date(t.started).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      } else {
        timeLabel = t.id || `#${i + 1}`;
      }
      return {
        time: timeLabel,
        id: t.id,
        mode: t.mode,
        task: t.task || t.goal || '(placeholder)',
        status: t.status,
        summary: t.summary || '',
        durationMs: t.duration_ms || 0,
        durationFormatted: t.duration_ms ? (t.duration_ms >= 60000 ? Math.round(t.duration_ms / 60000) + 'm' : Math.round(t.duration_ms / 1000) + 's') : '',
        startedAt: t.started || null,
        artifacts: [],
      };
    });

    // Current task
    const current = inProgress ? {
      mode: inProgress.mode,
      task: inProgress.task || inProgress.goal || '(in progress)',
      status: 'in-progress',
      context: '',
      next: (() => {
        const idx = queue.indexOf(inProgress);
        const next = queue.slice(idx + 1).find(t => t.status === 'upcoming');
        return next ? `${next.mode}: ${next.task || next.goal || 'placeholder'}` : '';
      })(),
    } : (done.length > 0 ? {
      mode: done[done.length - 1].mode,
      task: done[done.length - 1].task || done[done.length - 1].goal || '',
      status: 'done',
      context: '',
      next: (() => {
        const next = queue.find(t => t.status === 'upcoming');
        return next ? `${next.mode}: ${next.task || next.goal || 'placeholder'}` : '';
      })(),
    } : { mode: 'THINK', task: 'No tasks yet', status: 'idle', context: '', next: '' });

    return {
      date: api.date,
      current,
      stats: {
        blocksCompleted: done.length,
        blocksTotal: queue.length,
        modeDistribution: modeDist,
        blocksYielded: blocked.length,
      },
      schedule: { blocks, backlog: api.backlog || [] },
      blocks,
      adjustments: api.adjustments || [],
      backlog: api.backlog || [],
      updated_at: api.updated_at,
      generated: api._richGenerated || api.updated_at,
      // Rich data from generate.cjs (passed through from server)
      artifacts: api.artifacts || [],
      benchmarks: api.benchmarks || null,
      blogPosts: api.blogPosts || [],
      prs: api.prs || [],
      recentDays: api.recentDays || [],
      streak: api.streak || 0,
      scheduleAdherence: api.scheduleAdherence || null,
      todayHighlights: api.todayHighlights || [],
      blockers: api.blockers || [],
      projects: api.projects || [],
    };
  }

  async function fetchData() {
    try {
      let text;

      // Try API first if configured
      if (API_URL) {
        try {
          const apiRes = await fetch(API_URL + '/api/dashboard', { signal: AbortSignal.timeout(5000) });
          if (apiRes.ok) {
            text = await apiRes.text();
            apiAvailable = true;
          }
        } catch (apiErr) {
          apiAvailable = false;
        }
      }

      // Fall back to static file
      if (!text) {
        const res = await fetch(DATA_URL + '?t=' + Date.now());
        if (!res.ok) throw new Error(res.status);
        text = await res.text();
      }

      const hash = simpleHash(text);

      // Skip re-render if nothing changed
      if (hash === lastDataHash) {
        $('#pollStatus').className = 'poll-status' + (apiAvailable ? ' live' : '');
        $('#pollStatus').textContent = '●';
        return;
      }

      lastDataHash = hash;
      let data = JSON.parse(text);
      // Transform if from API (has queue array at top level, no blocks array)
      if (data.queue && !data.blocks) {
        data = transformApiData(data);
      }
      currentData = data;
      // Remove legacy debug banner if present
      const dbg = document.getElementById('debugBanner');
      if (dbg) dbg.remove();
      renderAll(data);
      errorCount = 0;
      $('#pollStatus').className = 'poll-status' + (apiAvailable ? ' live' : '');
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
    if (errorCount > 0) return Math.min(POLL_INTERVAL_STATIC * Math.pow(2, errorCount), MAX_BACKOFF);
    return apiAvailable ? POLL_INTERVAL : POLL_INTERVAL_STATIC;
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

  // --- Collapsible Sections ---
  function initCollapsible() {
    const sections = [
      'weeklySummarySection', 'highlightsSection', 'durationChartSection', 'adjustmentsSection',
      'recentDaysSection', 'blogSection', 'prsSection', 'backlogSection', 'artifactsSection',
      'benchmarksSection', 'projectsSection'
    ];
    for (const id of sections) {
      const section = document.getElementById(id);
      if (!section) continue;
      const h2 = section.querySelector('h2');
      if (!h2 || h2.dataset.collapsible) continue;
      h2.dataset.collapsible = 'true';
      h2.style.cursor = 'pointer';
      h2.style.userSelect = 'none';

      // Restore state from localStorage
      const key = `collapse_${id}`;
      const collapsed = localStorage.getItem(key) === '1';
      if (collapsed) {
        section.classList.add('collapsed');
      }

      // Add chevron indicator
      const chevron = document.createElement('span');
      chevron.className = 'collapse-chevron';
      chevron.textContent = collapsed ? '▸' : '▾';
      h2.prepend(chevron);

      h2.addEventListener('click', () => {
        const isCollapsed = section.classList.toggle('collapsed');
        chevron.textContent = isCollapsed ? '▸' : '▾';
        localStorage.setItem(key, isCollapsed ? '1' : '0');
      });
    }
  }

  // --- Workday Time Progress ---
  function renderWorkdayProgress() {
    let bar = document.getElementById('workdayProgress');
    if (!bar) {
      const container = document.createElement('div');
      container.id = 'workdayProgress';
      container.className = 'workday-progress-section';
      container.innerHTML = `
        <div class="workday-progress-track">
          <div class="workday-progress-fill" id="workdayProgressFill"></div>
          <div class="workday-progress-marker" id="workdayProgressMarker"></div>
        </div>
        <div class="workday-progress-labels">
          <span>8:15</span>
          <span id="workdayTimeLabel"></span>
          <span>21:45</span>
        </div>`;
      // Insert after stats bar
      const statsBar = document.getElementById('statsBar');
      if (statsBar && statsBar.nextSibling) {
        statsBar.parentNode.insertBefore(container, statsBar.nextSibling);
      }
      bar = container;
    }

    const now = new Date();
    const startMin = 8 * 60 + 15;  // 8:15
    const endMin = 21 * 60 + 45;   // 21:45
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const pct = Math.max(0, Math.min(100, ((nowMin - startMin) / (endMin - startMin)) * 100));

    const fill = document.getElementById('workdayProgressFill');
    const marker = document.getElementById('workdayProgressMarker');
    const label = document.getElementById('workdayTimeLabel');
    if (fill) fill.style.width = pct + '%';
    if (marker) marker.style.left = pct + '%';
    if (label) {
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      label.textContent = `${h}:${m}`;
    }
  }

  // --- Init ---
  startPolling();
  startTick();

  // --- Live Tick (update elapsed time every second) ---
  function startTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
  }

  function tick() {
    if (!currentData) return;
    // Update elapsed badge on in-progress block
    const blocks = currentData?.schedule?.blocks;
    if (!blocks) return;
    const activeIdx = blocks.findIndex(b => b.status === 'in-progress');
    if (activeIdx < 0) return;
    const block = blocks[activeIdx];
    const blockEl = timeline.querySelector(`.block[data-index="${activeIdx}"]`);
    if (!blockEl) return;

    // Calculate elapsed from startedAt ISO string
    const now = new Date();
    if (!block.startedAt) return;
    const blockStart = new Date(block.startedAt);
    if (isNaN(blockStart.getTime())) return;
    const elapsed = Math.max(0, Math.floor((now - blockStart) / 1000));
    const elMin = Math.floor(elapsed / 60);
    const elSec = elapsed % 60;
    const elStr = `${elMin}:${String(elSec).padStart(2, '0')}`;

    // Find or create elapsed badge
    let badge = blockEl.querySelector('.block-elapsed');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'block-elapsed';
      const content = blockEl.querySelector('.block-content');
      if (content) {
        const titleEl = content.querySelector('.block-title');
        if (titleEl) titleEl.appendChild(badge);
      }
    }
    badge.textContent = elStr;

    // Also update time remaining stat
    const timeRemEl = $('#timeRemaining');
    if (timeRemEl) updateTimeRemaining(currentData.stats, timeRemEl);

    // Update workday progress
    renderWorkdayProgress();

    // Update session health
    try { renderSessionHealth(currentData); } catch {}
  }
})();
