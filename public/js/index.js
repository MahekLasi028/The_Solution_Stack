function normalizeGithubUsername(raw) {
  if (raw == null || typeof raw !== 'string') {
    return '';
  }
  let s = raw.trim();
  s = s.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
  s = s.replace(/^@+/, '');
  const fromUrl = s.match(/github\.com\/([^/?#]+)/i);
  if (fromUrl) {
    s = fromUrl[1];
  }
  s = s.replace(/\.git$/i, '');
  return s.trim();
}

const form = document.getElementById('audit-form');
const errBox = document.getElementById('form-error');
const btn = document.getElementById('start-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.classList.add('hidden');
  errBox.textContent = '';

  if (window.location.protocol === 'file:') {
    errBox.textContent =
      'Open this app through the server: run "node server.js" in the project folder, then visit http://localhost:3000 (do not open the HTML file directly).';
    errBox.classList.remove('hidden');
    return;
  }

  const githubUsername = normalizeGithubUsername(document.getElementById('github').value);
  const portfolioUrls = document.getElementById('portfolio').value;
  const liveAppUrl = document.getElementById('live').value.trim();

  if (!githubUsername) {
    errBox.textContent = 'Please enter your GitHub username or profile URL.';
    errBox.classList.remove('hidden');
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    const res = await fetch('/api/audit/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubUsername,
        portfolioUrls,
        liveAppUrl: liveAppUrl || undefined
      })
    });

    const ct = res.headers.get('content-type') || '';
    let data = {};
    if (ct.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(
        text.replace(/<[^>]+>/g, ' ').trim().slice(0, 180) || `Server returned ${res.status}`
      );
    }

    if (!res.ok) {
      throw new Error(data.error || `Could not start audit (${res.status})`);
    }
    if (!data.jobId) {
      throw new Error('Invalid response from server (missing job id). Is the API running?');
    }

    window.location.href = `/loading.html?jobId=${encodeURIComponent(data.jobId)}`;
  } catch (error) {
    const msg =
      error instanceof TypeError && error.message === 'Failed to fetch'
        ? 'Cannot reach the server. Start it with: node server.js — then use http://localhost:3000'
        : error.message || 'Something went wrong.';
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
});
