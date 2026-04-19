const params = new URLSearchParams(window.location.search);
const jobId = params.get('jobId');
const share = params.get('share');

const waiting = document.getElementById('waiting');
const root = document.getElementById('roadmap-root');
const fatal = document.getElementById('fatal');
const monthsEl = document.getElementById('months');
const shareBtn = document.getElementById('share-btn');
const shareStatus = document.getElementById('share-status');
const bcReport = document.getElementById('bc-report');
const navReport = document.getElementById('nav-report');
const readonlyBanner = document.getElementById('readonly-banner');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(u) {
  try {
    return new URL(u).href;
  } catch {
    return '#';
  }
}

function storageKey(token) {
  return `devaudit-roadmap-${token}`;
}

function loadChecks(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveChecks(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}

function renderMonth(title, tasks, monthKey, storageId) {
  const section = document.createElement('section');
  section.className = 'rm-month anchor-offset';
  const h = document.createElement('h3');
  h.textContent = title;
  section.appendChild(h);

  const checks = loadChecks(storageId);

  tasks.forEach((t, idx) => {
    const id = `${monthKey}-${idx}`;
    const card = document.createElement('article');
    card.className = 'card rm-task';
    const checked = checks[id] ? 'checked' : '';
    card.innerHTML = `
      <div class="task-check">
        <input type="checkbox" id="${id}" data-task-id="${id}" ${checked} aria-label="Completed: ${escapeHtml(t.task)}" />
        <div>
          <h4>${escapeHtml(t.task)}</h4>
          <p class="why"><strong>Why it matters:</strong> ${escapeHtml(t.why)}</p>
          <div class="rm-meta">
            <span>Time: ${escapeHtml(t.timeEstimate)}</span>
            <span><a href="${safeHref(t.resourceUrl)}" target="_blank" rel="noopener noreferrer">Free resource</a></span>
          </div>
        </div>
      </div>
    `;
    section.appendChild(card);
  });

  section.addEventListener('change', (e) => {
    const el = e.target;
    if (el.type !== 'checkbox') {
      return;
    }
    const cur = loadChecks(storageId);
    cur[el.dataset.taskId] = el.checked;
    saveChecks(storageId, cur);
  });

  return section;
}

async function loadRoadmapData() {
  if (share) {
    readonlyBanner.classList.remove('hidden');
    const res = await fetch(`/api/audit/share/${encodeURIComponent(share)}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not load shared roadmap');
    }
    return {
      roadmap: data.report.roadmap,
      shareToken: share,
      jobId: data.job._id
    };
  }

  if (!jobId) {
    throw new Error('Missing job id or share token.');
  }

  const res = await fetch(`/api/audit/${encodeURIComponent(jobId)}/roadmap`);
  const data = await res.json();
  if (res.status === 202) {
    throw new Error('Roadmap is not ready yet. Wait for the audit to finish.');
  }
  if (!res.ok) {
    throw new Error(data.error || 'Could not load roadmap');
  }
  return {
    roadmap: data.roadmap,
    shareToken: data.shareToken,
    jobId: data.jobId
  };
}

async function init() {
  const { roadmap, shareToken, jobId: resolvedJob } = await loadRoadmapData();

  const reportHref = share
    ? `/report.html?share=${encodeURIComponent(share)}`
    : `/report.html?jobId=${encodeURIComponent(resolvedJob)}`;
  bcReport.href = reportHref;
  navReport.href = reportHref;

  const bcLoading = document.getElementById('bc-loading');
  if (bcLoading) {
    if (share) {
      bcLoading.removeAttribute('href');
      bcLoading.style.pointerEvents = 'none';
      bcLoading.style.opacity = '0.6';
    } else {
      bcLoading.href = `/loading.html?jobId=${encodeURIComponent(resolvedJob)}`;
    }
  }

  const storageId = storageKey(shareToken || resolvedJob);

  monthsEl.innerHTML = '';
  const m1 = roadmap.month1 || [];
  const m2 = roadmap.month2 || [];
  const m3 = roadmap.month3 || [];

  monthsEl.appendChild(renderMonth('Month 1 — Foundations', m1, 'm1', storageId));
  monthsEl.appendChild(renderMonth('Month 2 — Depth', m2, 'm2', storageId));
  monthsEl.appendChild(renderMonth('Month 3 — Polish & visibility', m3, 'm3', storageId));

  shareBtn.addEventListener('click', async () => {
    let token = shareToken;
    if (!token && jobId) {
      const res = await fetch(`/api/audit/${encodeURIComponent(jobId)}/roadmap`);
      const data = await res.json();
      token = data.shareToken;
    }
    if (!token) {
      shareStatus.textContent = 'Share token unavailable yet.';
      return;
    }
    const url = `${window.location.origin}/roadmap.html?share=${encodeURIComponent(token)}`;
    try {
      await navigator.clipboard.writeText(url);
      shareStatus.textContent = 'Link copied to clipboard.';
    } catch {
      shareStatus.textContent = url;
    }
  });

  waiting.classList.add('hidden');
  root.classList.remove('hidden');
}

init().catch((e) => {
  waiting.classList.add('hidden');
  fatal.textContent = e.message || 'Error';
  fatal.classList.remove('hidden');
});
