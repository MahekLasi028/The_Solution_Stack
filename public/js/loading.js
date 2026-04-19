const params = new URLSearchParams(window.location.search);
const jobId = params.get('jobId');

const STEPS = [
  { id: 'ingest', label: '[1] Fetching GitHub repositories...' },
  { id: 'codeQuality', label: '[2] Analysing code quality and patterns...' },
  { id: 'security', label: '[3] Running security audit...' },
  { id: 'uiUx', label: '[4] Running UI/UX checks on live app...' },
  { id: 'report', label: '[5] Generating your 360° report...' }
];

const listEl = document.getElementById('steps');
const reposEl = document.getElementById('repos');
const filesEl = document.getElementById('files');
const errEl = document.getElementById('err');

if (!jobId) {
  errEl.textContent = 'Missing job id. Start from the home page.';
  errEl.classList.remove('hidden');
} else {
  STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'step-row';
    li.dataset.step = s.id;
    li.innerHTML = `
      <div class="step-icon" aria-hidden="true">${i + 1}</div>
      <div class="step-body">${s.label}</div>
    `;
    listEl.appendChild(li);
  });

  let timer = null;

  async function poll() {
    try {
      const res = await fetch(`/api/audit/${encodeURIComponent(jobId)}/status`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Status request failed');
      }

      reposEl.textContent = String(data.reposFound ?? 0);
      filesEl.textContent = String(data.filesScanned ?? 0);

      const done = new Set(data.stepsCompleted || []);

      const rows = [...listEl.querySelectorAll('.step-row')];
      rows.forEach((row) => {
        const id = row.dataset.step;
        row.classList.remove('done', 'active');
        if (done.has(id)) {
          row.classList.add('done');
          row.querySelector('.step-icon').textContent = '✓';
        }
      });

      const firstPending = STEPS.find((s) => !done.has(s.id));
      if (firstPending) {
        const row = listEl.querySelector(`[data-step="${firstPending.id}"]`);
        if (row && !row.classList.contains('done')) {
          row.classList.add('active');
        }
      }

      if (data.status === 'complete') {
        clearInterval(timer);
        window.location.replace(`/report.html?jobId=${encodeURIComponent(jobId)}`);
        return;
      }

      if (data.status === 'failed') {
        clearInterval(timer);
        errEl.textContent = data.errorMessage || 'Audit failed. Check server logs and try again.';
        errEl.classList.remove('hidden');
      }
    } catch (e) {
      clearInterval(timer);
      errEl.textContent = e.message || 'Polling failed.';
      errEl.classList.remove('hidden');
    }
  }

  poll();
  timer = setInterval(poll, 2000);
}
