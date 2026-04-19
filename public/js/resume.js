// ── PDF.js setup ──────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── DOM refs ───────────────────────────────────────────────────
const uploadZone  = document.getElementById('upload-zone');
const pdfInput    = document.getElementById('pdf-input');
const pdfReady    = document.getElementById('pdf-ready');
const pdfFilename = document.getElementById('pdf-filename');
const pdfPages    = document.getElementById('pdf-pages');
const githubInput = document.getElementById('github-input');
const jdInput     = document.getElementById('jd-input');
const analyzeBtn  = document.getElementById('analyze-btn');
const errBox      = document.getElementById('err-box');
const formSection = document.getElementById('form-section');
const analyzingMsg= document.getElementById('analyzing-msg');
const analyzingStep=document.getElementById('analyzing-step');
const resultsSection=document.getElementById('results-section');
const runAgainBtn = document.getElementById('run-again-btn');

let extractedText = '';

// ── Drag & drop styling ────────────────────────────────────────
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type === 'application/pdf') handleFile(file);
});

pdfInput.addEventListener('change', () => {
  const file = pdfInput.files?.[0];
  if (file) handleFile(file);
});

// ── PDF text extraction ────────────────────────────────────────
async function handleFile(file) {
  uploadZone.style.display = 'none';
  pdfReady.style.display = 'flex';
  pdfFilename.textContent = file.name;
  pdfPages.textContent = 'Reading…';

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    pdfPages.textContent = `${totalPages} page${totalPages > 1 ? 's' : ''}`;

    let fullText = '';
    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map((item) => item.str).join(' ') + '\n';
    }
    extractedText = fullText.trim();
    checkReady();
  } catch (err) {
    pdfReady.style.display = 'none';
    uploadZone.style.display = '';
    showErr('Could not read PDF: ' + err.message);
  }
}

// ── Enable button when ready ───────────────────────────────────
function checkReady() {
  analyzeBtn.disabled = !(extractedText && githubInput.value.trim());
}
githubInput.addEventListener('input', checkReady);

// ── Helpers ────────────────────────────────────────────────────
function showErr(msg) {
  errBox.textContent = msg;
  errBox.style.display = 'block';
}
function hideErr() {
  errBox.style.display = 'none';
}

function scoreColor(n) {
  if (n >= 75) return 'high';
  if (n >= 50) return 'mid';
  return 'low';
}

function scoreLabel(n) {
  if (n >= 75) return 'Strong';
  if (n >= 50) return 'Needs Work';
  return 'Weak';
}

// ── Analyze ────────────────────────────────────────────────────
analyzeBtn.addEventListener('click', async () => {
  hideErr();
  const username = githubInput.value.trim();
  if (!extractedText) { showErr('Please upload your resume PDF first.'); return; }
  if (!username)       { showErr('Please enter your GitHub username.'); return; }

  // Switch to analyzing view
  formSection.style.display = 'none';
  analyzingMsg.style.display = 'block';

  const steps = [
    'Reading your resume…',
    'Fetching GitHub repos…',
    'Extracting claimed skills…',
    'Comparing against code evidence…',
    'Building your gap report…'
  ];
  let stepIdx = 0;
  analyzingStep.textContent = steps[0];
  const stepTimer = setInterval(() => {
    stepIdx = Math.min(stepIdx + 1, steps.length - 1);
    analyzingStep.textContent = steps[stepIdx];
  }, 3000);

  try {
    const res = await fetch('/api/resume/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resumeText: extractedText,
        githubUsername: username,
        jobDescription: jdInput.value.trim() || ''
      })
    });

    clearInterval(stepTimer);
    const data = await res.json();

    if (!res.ok) {
      analyzingMsg.style.display = 'none';
      formSection.style.display = '';
      showErr(data.error || 'Analysis failed.');
      return;
    }

    analyzingMsg.style.display = 'none';
    renderResults(data);
    resultsSection.classList.remove('hidden');

  } catch (err) {
    clearInterval(stepTimer);
    analyzingMsg.style.display = 'none';
    formSection.style.display = '';
    showErr('Could not reach server. Is it running?');
  }
});

// ── Render Results ─────────────────────────────────────────────
function renderResults(data) {
  const { analysis, githubData, resumeData, githubUsername } = data;

  // ── Scores ──
  const scoreBlock = document.getElementById('score-block');
  const hasJD = analysis.jobFitScore > 0;
  scoreBlock.innerHTML = `
    <div class="big-score">
      <h3>Honesty Score</h3>
      <div class="num ${scoreColor(analysis.honestyScore)}">${analysis.honestyScore}</div>
      <div class="sub">${scoreLabel(analysis.honestyScore)} — resume vs code match</div>
    </div>
    ${hasJD ? `
    <div class="big-score">
      <h3>Job Fit Score</h3>
      <div class="num ${scoreColor(analysis.jobFitScore)}">${analysis.jobFitScore}</div>
      <div class="sub">${scoreLabel(analysis.jobFitScore)} — match to job description</div>
    </div>` : ''}
    <div class="big-score">
      <h3>Verified Skills</h3>
      <div class="num high">${(analysis.verified || []).length}</div>
      <div class="sub">of ${(analysis.verified || []).length + (analysis.exaggerated || []).length} claimed</div>
    </div>
    <div class="big-score">
      <h3>Unverified Claims</h3>
      <div class="num ${(analysis.exaggerated || []).length > 0 ? 'low' : 'high'}">${(analysis.exaggerated || []).length}</div>
      <div class="sub">skills with no GitHub proof</div>
    </div>
  `;

  // ── Summary ──
  document.getElementById('summary-box').innerHTML =
    `<strong>Summary:</strong> ${analysis.summary || ''}`;

  // ── Top Recommendation ──
  document.getElementById('rec-box').innerHTML =
    `<strong>Do this first →</strong> ${analysis.topRecommendation || ''}`;

  // ── Verified skills ──
  const verifiedList = document.getElementById('verified-list');
  const verified = analysis.verified || [];
  if (verified.length === 0) {
    verifiedList.innerHTML = '<p style="color:var(--muted);font-size:0.9rem">No skills could be verified — make sure your GitHub repos are public.</p>';
  } else {
    verifiedList.innerHTML = verified.map((v) => `
      <div class="skill-row">
        <span class="icon">✅</span>
        <div class="body">
          <div class="skill-name">${v.skill}</div>
          <div class="skill-detail">${v.evidence}</div>
        </div>
      </div>`).join('');
  }

  // ── Exaggerated / Unverified ──
  const exagList = document.getElementById('exag-list');
  const exaggerated = analysis.exaggerated || [];
  if (exaggerated.length === 0) {
    document.getElementById('exag-section').style.display = 'none';
  } else {
    exagList.innerHTML = exaggerated.map((e) => `
      <div class="skill-row">
        <span class="icon">❌</span>
        <div class="body">
          <div class="skill-name">${e.skill}</div>
          <div class="skill-detail">${e.issue}</div>
          ${e.suggestion ? `<span class="skill-fix">Fix: ${e.suggestion}</span>` : ''}
        </div>
      </div>`).join('');
  }

  // ── Missing skills ──
  const missingList = document.getElementById('missing-list');
  const missing = analysis.missing || [];
  if (missing.length === 0) {
    document.getElementById('missing-section').style.display = 'none';
  } else {
    missingList.innerHTML = missing.map((m) => `
      <div class="skill-row">
        <span class="icon">💡</span>
        <div class="body">
          <div class="skill-name">${m.skill}</div>
          <div class="skill-detail">${m.why}</div>
        </div>
      </div>`).join('');
  }

  // ── Job Gaps ──
  const jobGapsList = document.getElementById('job-gaps-list');
  const jobGaps = analysis.jobGaps || [];
  if (!hasJD || jobGaps.length === 0) {
    jobGapsList.innerHTML = `<p class="no-jd-note">${!hasJD ? 'No job description provided — paste one to see how well you match the role.' : 'No specific gaps identified.'}</p>`;
  } else {
    jobGapsList.innerHTML = jobGaps.map((g) => `
      <div class="job-gap-row">
        <span class="gap-status ${g.status}">${g.status}</span>
        <div style="flex:1">
          <strong>${g.requirement}</strong>
          ${g.notes ? `<div style="font-size:0.82rem;color:var(--muted);margin-top:0.2rem">${g.notes}</div>` : ''}
        </div>
      </div>`).join('');
  }

  // ── GitHub summary box ──
  const langs = Object.entries(githubData.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([l, c]) => `<span class="tag-lead">${l} (${c})</span>`)
    .join('');

  document.getElementById('github-summary').innerHTML = `
    <div class="section-label" style="margin-bottom:0.75rem">GitHub Evidence Used — @${githubUsername}</div>
    <p style="color:var(--muted);font-size:0.88rem;margin:0 0 0.75rem">
      ${githubData.totalRepos} public repos scanned
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:0.5rem">${langs}</div>
    ${githubData.topics.length > 0 ? `
    <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem">
      ${githubData.topics.slice(0, 10).map((t) => `<span class="tag-hide">${t}</span>`).join('')}
    </div>` : ''}
  `;
}

// ── Run again ──────────────────────────────────────────────────
runAgainBtn.addEventListener('click', () => {
  resultsSection.classList.add('hidden');
  formSection.style.display = '';
  extractedText = '';
  pdfInput.value = '';
  pdfReady.style.display = 'none';
  uploadZone.style.display = '';
  githubInput.value = '';
  jdInput.value = '';
  hideErr();
  checkReady();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
