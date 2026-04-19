const params = new URLSearchParams(window.location.search);
const jobId = params.get('jobId');
const share = params.get('share');

const waiting = document.getElementById('waiting');
const root = document.getElementById('report-root');
const fatal = document.getElementById('fatal');
const readonlyBanner = document.getElementById('readonly-banner');
const roadmapBtn = document.getElementById('roadmap-btn');
const bcRoadmap = document.getElementById('bc-roadmap');

function sevClass(sev) {
  if (sev === 'Critical') {
    return 'sev-critical';
  }
  if (sev === 'Good') {
    return 'sev-good';
  }
  return 'sev-warning';
}

function renderReport(report, jobMeta) {
  const gp = report.githubProfile || {};
  document.getElementById('avatar').src = gp.avatar || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png';
  document.getElementById('dev-name').textContent = gp.name || jobMeta?.githubUsername || 'Developer';
  document.getElementById('dev-bio').textContent = gp.bio || '';

  const level = report.developerLevel || 'Mid';
  const badge = document.getElementById('level-badge');
  badge.textContent = level;
  badge.className = `level-badge level-${level}`;

  const pct = report.percentileRank ?? 50;
  document.getElementById('percentile-strip').textContent = `You are in the top ${pct}% of developers with similar experience (heuristic from this audit).`;

  const scores = report.scores || {};
  const labels = report.scoreLabels || {};
  const cards = [
    { key: 'codeQuality', title: 'Code Quality Score', score: scores.codeQuality, label: labels.codeQuality },
    { key: 'security', title: 'Security Score', score: scores.security, label: labels.security },
    { key: 'uiUx', title: 'UI/UX Score', score: scores.uiUx, label: labels.uiUx },
    { key: 'documentation', title: 'Documentation Score', score: scores.documentation, label: labels.documentation }
  ];

  const grid = document.getElementById('score-cards');
  grid.innerHTML = '';
  cards.forEach((c) => {
    const el = document.createElement('article');
    el.className = 'card score-card';
    const num =
      c.score === null || c.score === undefined
        ? '—'
        : `${c.score}`;
    const explain =
      c.label ||
      (c.score == null
        ? 'Not submitted — add a live URL to get this score.'
        : `${c.score} / 100`);
    el.innerHTML = `
      <h3>${c.title} (0–100)</h3>
      <div class="score-num">${num}</div>
      <p class="explain">${explain}</p>
    `;
    grid.appendChild(el);
  });

  const overallFoot = document.createElement('p');
  overallFoot.style.marginTop = '1rem';
  overallFoot.style.color = 'var(--muted)';
  overallFoot.style.fontSize = '0.95rem';
  overallFoot.textContent =
    labels.overall ||
    (scores.overall != null
      ? `Overall composite: ${scores.overall} / 100 (average of available category scores).`
      : '');
  grid.parentNode.insertBefore(overallFoot, grid.nextSibling);

  const fl = document.getElementById('findings-list');
  fl.innerHTML = '';
  (report.findings || []).forEach((f) => {
    const card = document.createElement('article');
    card.className = 'card finding-card';
    card.innerHTML = `
      <div class="finding-head">
        <span class="sev ${sevClass(f.severity)}">${f.severity}</span>
        <span class="meta">${f.repo} · ${f.file}${f.line > 0 ? ` · line ${f.line}` : ''}</span>
      </div>
      <p><strong>What &amp; why:</strong> ${f.issue}</p>
      <p><strong>Fix:</strong> ${f.fix}</p>
    `;
    fl.appendChild(card);
  });

  const ci = report.careerInsights || {};
  const career = document.getElementById('career-card');
  career.innerHTML = `
    <p><strong>Current level:</strong> ${level} — ${ci.levelExplanation || 'Your level reflects aggregate signals from this audit.'}</p>
    <p><strong>Salary bracket you qualify for right now:</strong> ${ci.currentSalaryBracket || 'Varies by region and company.'}</p>
    <p><strong>Three flaws that would move you up fastest:</strong></p>
    <ul>
      ${(ci.nextLevelFlaws || [])
        .slice(0, 5)
        .map((x) => `<li>${x}</li>`)
        .join('')}
    </ul>
  `;

  const jobs = document.getElementById('jobs-list');
  jobs.innerHTML = '';
  (ci.jobMatches || []).forEach((j) => {
    const row = document.createElement('div');
    row.className = 'job-row';
    row.innerHTML = `
      <h4>${j.title}</h4>
      <div class="meta">Estimated salary: ${j.salary}</div>
      <p style="margin:0; font-size:0.95rem; color: var(--muted)">Skill gap notes: ${j.skillGap}</p>
    `;
    jobs.appendChild(row);
  });

  const ra = report.resumeAdvice || {};
  const resume = document.getElementById('resume-card');
  resume.innerHTML = `
    <p><strong>Projects to lead with</strong></p>
    <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem">
      ${(ra.leadProjects || []).map((p) => `<span class="tag-lead">${p}</span>`).join('') || '<span class="empty-hint">No projects highlighted yet.</span>'}
    </div>
    <p><strong>Projects to hide or improve</strong></p>
    <div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem">
      ${(ra.hideProjects || []).map((p) => `<span class="tag-hide">${p}</span>`).join('') || '<span class="empty-hint">None flagged — still polish READMEs and tests.</span>'}
    </div>
    <p><strong>Rewritten resume bullets (from your code signals)</strong></p>
    <ul>
      ${(ra.bulletPoints || []).map((b) => `<li>${b}</li>`).join('')}
    </ul>
  `;

  waiting.classList.add('hidden');
  root.classList.remove('hidden');
}

async function load() {
  if (share) {
    readonlyBanner.classList.remove('hidden');
    const res = await fetch(`/api/audit/share/${encodeURIComponent(share)}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not load shared report');
    }
    renderReport(data.report, data.job);
    const href = `/roadmap.html?share=${encodeURIComponent(share)}`;
    roadmapBtn.href = href;
    bcRoadmap.href = href;
    const bcLoading = document.getElementById('bc-loading');
    if (bcLoading) {
      bcLoading.removeAttribute('href');
      bcLoading.style.pointerEvents = 'none';
      bcLoading.style.opacity = '0.6';
    }
    return;
  }

  if (!jobId) {
    throw new Error('Missing job id or share token.');
  }

  roadmapBtn.href = `/roadmap.html?jobId=${encodeURIComponent(jobId)}`;
  bcRoadmap.href = roadmapBtn.href;
  const bcLoading = document.getElementById('bc-loading');
  if (bcLoading) {
    bcLoading.href = `/loading.html?jobId=${encodeURIComponent(jobId)}`;
  }

  const tryFetch = async () => {
    const res = await fetch(`/api/audit/${encodeURIComponent(jobId)}/report`);
    const data = await res.json();
    if (res.status === 202) {
      return null;
    }
    if (!res.ok) {
      throw new Error(data.error || 'Could not load report');
    }
    return data;
  };

  let data = await tryFetch();
  if (!data) {
    await new Promise((r) => setTimeout(r, 2000));
    data = await tryFetch();
  }
  let attempts = 0;
  while (!data && attempts < 60) {
    await new Promise((r) => setTimeout(r, 2000));
    data = await tryFetch();
    attempts += 1;
  }
  if (!data) {
    throw new Error('Report is still generating. Return to the loading page.');
  }
  renderReport(data, { githubUsername: data.githubProfile?.name });
}

load().catch((e) => {
  waiting.classList.add('hidden');
  fatal.textContent = e.message || 'Error';
  fatal.classList.remove('hidden');
});
