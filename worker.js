const axios = require('axios');
const crypto = require('crypto');
const lighthouse = require('lighthouse').default;
const chromeLauncher = require('chrome-launcher');
const OpenAI = require('openai');
const AuditJob = require('./models/AuditJob');
const AuditReport = require('./models/AuditReport');
const ScoreHistory = require('./models/ScoreHistory');
const { computeSmartScore } = require('./lib/smartScoring');

const CODE_EXT = new Set(['.js', '.ts', '.py', '.java']);
const MAX_REPOS = 12;
const MAX_FILES_TOTAL = 120;
const MAX_FILE_BYTES = 400 * 1024;
const GITHUB_API = 'https://api.github.com';

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

async function fetchUser(username) {
  const res = await axios.get(`${GITHUB_API}/users/${encodeURIComponent(username)}`, {
    headers: ghHeaders(),
    timeout: 60000,
    validateStatus: () => true
  });
  if (res.status === 404) {
    throw new Error('GitHub user not found');
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      'GitHub API rate limit or access issue. Set GITHUB_TOKEN in your .env with a personal access token.'
    );
  }
  if (res.status !== 200) {
    throw new Error(`GitHub user request failed (${res.status})`);
  }
  return res.data;
}

async function fetchRepos(username) {
  const res = await axios.get(
    `${GITHUB_API}/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`,
    { headers: ghHeaders(), timeout: 60000, validateStatus: () => true }
  );
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      'GitHub API rate limit or access issue. Set GITHUB_TOKEN in your .env with a personal access token.'
    );
  }
  if (res.status !== 200) {
    throw new Error(`GitHub repos request failed (${res.status})`);
  }
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchContents(owner, repo, path) {
  const p = path
    ? `/${path
        .split('/')
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join('/')}`
    : '';
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents${p}`;
  const res = await axios.get(url, { headers: ghHeaders(), timeout: 60000, validateStatus: () => true });
  if (res.status === 404 || res.status === 403) {
    return null;
  }
  if (res.status !== 200) {
    return null;
  }
  return res.data;
}

async function fetchRawText(downloadUrl) {
  const res = await axios.get(downloadUrl, {
    headers: ghHeaders(),
    timeout: 60000,
    responseType: 'text',
    maxContentLength: MAX_FILE_BYTES,
    validateStatus: () => true
  });
  if (res.status !== 200) {
    return '';
  }
  return typeof res.data === 'string' ? res.data : String(res.data);
}

function extname(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

async function walkRepo(owner, repo, path, state, onFile) {
  const items = await fetchContents(owner, repo, path);
  if (!items) {
    return;
  }
  const list = Array.isArray(items) ? items : [items];
  for (const item of list) {
    if (state.filesScanned >= MAX_FILES_TOTAL) {
      return;
    }
    if (item.type === 'dir') {
      if (item.name === 'node_modules' || item.name === 'dist' || item.name === 'build') {
        continue;
      }
      await walkRepo(owner, repo, item.path, state, onFile);
      continue;
    }
    if (item.type !== 'file' || !item.download_url) {
      continue;
    }
    const ex = extname(item.name);
    if (item.name === '.env' || item.name.endsWith('.env')) {
      onFile({
        repo,
        path: item.path,
        name: item.name,
        content: '',
        isEnv: true
      });
      state.filesScanned += 1;
      continue;
    }
    if (!CODE_EXT.has(ex)) {
      if (item.name.toLowerCase() === 'readme.md') {
        const text = await fetchRawText(item.download_url);
        onFile({
          repo,
          path: item.path,
          name: item.name,
          content: text,
          isReadme: true
        });
        state.filesScanned += 1;
      }
      continue;
    }
    const text = await fetchRawText(item.download_url);
    if (text.length > MAX_FILE_BYTES) {
      continue;
    }
    onFile({
      repo,
      path: item.path,
      name: item.name,
      content: text,
      ext: ex
    });
    state.filesScanned += 1;
  }
}

function flagLongFunctions(content, repo, filePath, findings) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/(?:^|\s)(?:async\s+)?function\s+[\w$]+\s*\(|(?:=>\s*\{)/.test(line) && !/\bfunction\s*\(/.test(line)) {
      continue;
    }
    let depth = 0;
    let started = false;
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j];
      for (let k = 0; k < l.length; k++) {
        const ch = l[k];
        if (ch === '{') {
          depth += 1;
          started = true;
        } else if (ch === '}') {
          depth -= 1;
        }
      }
      if (started && depth <= 0) {
        break;
      }
    }
    const len = j - i + 1;
    if (len > 50) {
      findings.push({
        severity: 'Warning',
        repo,
        file: filePath,
        line: i + 1,
        issue: `A function block spans ${len} lines (over 50), which suggests poor modularity and harder maintenance.`,
        fix: 'Split this function into smaller single-purpose helpers and extract repeated logic.'
      });
    }
    i = j;
  }
}

function analyzeCodeQuality(files, findings) {
  let testFiles = 0;
  let readmeChars = 0;
  let readmeCount = 0;
  let camelLines = 0;
  let mixedLines = 0;
  let consoleHits = 0;

  for (const f of files) {
    if (f.isReadme) {
      readmeCount += 1;
      readmeChars += f.content.length;
      continue;
    }
    if (f.isEnv) {
      continue;
    }
    const base = f.path.split('/').pop() || '';
    if (/\.(test|spec)\.(js|ts)$/i.test(base)) {
      testFiles += 1;
    }
    const lines = f.content.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (/console\.log\s*\(/.test(line)) {
        consoleHits += 1;
        findings.push({
          severity: 'Warning',
          repo: f.repo,
          file: f.path,
          line: li + 1,
          issue:
            'console.log is present in source. In production code this leaks behaviour and can hurt performance.',
          fix: 'Remove or replace with a proper logger gated by environment (e.g. debug level only in development).'
        });
        break;
      }
    }
    for (const line of lines) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith('//') || stripped.startsWith('*')) {
        continue;
      }
      if (/[a-z][a-zA-Z0-9]*[A-Z]/.test(stripped)) {
        camelLines += 1;
      }
      if (/[a-z][a-z0-9]*_[a-z]/.test(stripped)) {
        mixedLines += 1;
      }
    }
    flagLongFunctions(f.content, f.repo, f.path, findings);
  }

  const namingPenalty = camelLines + mixedLines > 0 ? Math.min(15, Math.round((mixedLines / (camelLines + mixedLines + 1)) * 20)) : 0;
  const testRatio = files.filter((x) => !x.isReadme && !x.isEnv).length
    ? testFiles / files.filter((x) => !x.isReadme && !x.isEnv).length
    : 0;
  const testScore = Math.min(40, Math.round(testRatio * 120));

  let docScore = 50;
  if (readmeCount > 0) {
    const avg = readmeChars / readmeCount;
    docScore = Math.min(100, Math.round(40 + Math.min(60, (avg / 400) * 60)));
  } else {
    findings.push({
      severity: 'Warning',
      repo: files[0]?.repo || 'unknown',
      file: 'README.md',
      line: 1,
      issue: 'No README.md (or too little content) was found in scanned repositories.',
      fix: 'Add a README per project with setup, architecture, and contribution notes (200+ characters).'
    });
  }

  const cq = Math.max(
    0,
    Math.min(
      100,
      72 - Math.min(25, consoleHits * 3) - namingPenalty + Math.round(testScore * 0.35)
    )
  );

  return {
    codeQualityScore: Math.round(cq),
    documentationScore: docScore,
    meta: { testFiles, readmeChars, consoleHits, namingPenalty }
  };
}

function analyzeSecurity(files, findings) {
  let score = 100;
  for (const f of files) {
    if (f.isEnv) {
      findings.push({
        severity: 'Critical',
        repo: f.repo,
        file: f.path,
        line: 1,
        issue: 'A .env or environment file appears in the repository. Secrets may be exposed publicly.',
        fix: 'Remove the file from git history, rotate secrets, and use environment variables or a secrets manager.'
      });
      score -= 35;
      continue;
    }
    if (f.isReadme) {
      continue;
    }
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\beval\s*\(/.test(line)) {
        findings.push({
          severity: 'Critical',
          repo: f.repo,
          file: f.path,
          line: i + 1,
          issue: 'eval() executes arbitrary strings and is a critical security risk.',
          fix: 'Replace eval with JSON.parse for data, or a safe parser / sandboxed approach.'
        });
        score -= 25;
      }
      if (/(password|secret|api_key)\s*=\s*['"][^'"]+['"]/i.test(line) && !/process\.env/.test(line)) {
        findings.push({
          severity: 'Critical',
          repo: f.repo,
          file: f.path,
          line: i + 1,
          issue: 'Possible hardcoded credential or secret in source code.',
          fix: 'Move secrets to environment variables and use a secret manager in production.'
        });
        score -= 20;
      }
      if (/['"]\s*\+\s*.*(?:SELECT|INSERT|UPDATE|DELETE)/i.test(line) || /query\s*\(\s*[`'"][^`'"]*\+/i.test(line)) {
        findings.push({
          severity: 'Warning',
          repo: f.repo,
          file: f.path,
          line: i + 1,
          issue: 'Possible SQL built via string concatenation, which invites injection bugs.',
          fix: 'Use parameterized queries or an ORM with bound parameters.'
        });
        score -= 8;
      }
      if (/\breq\.body\b/.test(line) && !/zod|joi|express-validator|yup|celebrate|check\(/.test(f.content)) {
        findings.push({
          severity: 'Warning',
          repo: f.repo,
          file: f.path,
          line: i + 1,
          issue: 'req.body is used without obvious validation/sanitization in this file.',
          fix: 'Validate all inputs with a schema library (Zod, Joi) before use.'
        });
        score -= 4;
        break;
      }
    }
  }

  let authHint = false;
  for (const f of files) {
    if (f.isReadme || f.isEnv) {
      continue;
    }
    if (/\/auth|login|session|passport|jwt/i.test(f.path) && /jwt|express-session|cookie-session|passport/i.test(f.content)) {
      authHint = true;
    }
  }
  if (!authHint) {
    findings.push({
      severity: 'Warning',
      repo: files.find((x) => !x.isReadme)?.repo || 'unknown',
      file: 'auth routes (heuristic)',
      line: 1,
      issue: 'No clear JWT/session-based auth patterns were detected in scanned files.',
      fix: 'If you expose auth routes, prefer established session/JWT patterns and secure cookie flags.'
    });
    score -= 5;
  }

  return { securityScore: Math.max(0, Math.min(100, score)) };
}

async function runLighthouseScore(url) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  try {
    const runnerResult = await lighthouse(url, {
      logLevel: 'silent',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      port: chrome.port
    });
    const lhr = runnerResult.lhr;
    const cats = ['performance', 'accessibility', 'best-practices', 'seo'];
    const vals = cats.map((c) => Math.round(((lhr.categories[c] && lhr.categories[c].score) || 0) * 100));
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    return avg;
  } finally {
    await chrome.kill().catch(() => {});
  }
}

function buildScoreLabels(scores, developerLevel) {
  const band = (n) => {
    if (n >= 80) {
      return 'Strong — aligns with solid professional practice.';
    }
    if (n >= 60) {
      return 'Mid-level range — credible with a few gaps to close.';
    }
    return 'Needs work — focus on fundamentals and consistency.';
  };
  const overall = scores.overall;
  let overallText = `${overall} / 100 — ${band(overall)}`;
  if (developerLevel === 'Senior') {
    overallText = `${overall} / 100 — Senior-level range. ${band(overall)}`;
  } else if (developerLevel === 'Junior') {
    overallText = `${overall} / 100 — Junior-level range. ${band(overall)}`;
  } else if (developerLevel === 'Mid') {
    overallText = `${overall} / 100 — Mid-level range. You are close to Senior if you close key gaps.`;
  }
  return {
    codeQuality: `${scores.codeQuality} / 100 — ${band(scores.codeQuality)}`,
    security: `${scores.security} / 100 — ${band(scores.security)}`,
    uiUx:
      scores.uiUx == null
        ? 'Not submitted — add a live URL to get this score.'
        : `${scores.uiUx} / 100 — ${band(scores.uiUx)}`,
    documentation: `${scores.documentation} / 100 — ${band(scores.documentation)}`,
    overall: overallText
  };
}

function heuristicLevel(overall) {
  if (overall >= 78) {
    return 'Senior';
  }
  if (overall >= 55) {
    return 'Mid';
  }
  return 'Junior';
}

function percentileFromOverall(overall) {
  return Math.max(1, Math.min(99, Math.round(100 - overall * 0.65)));
}

async function callOpenAI(payload) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return null;
  }
  const client = new OpenAI({ apiKey: key });
  const system =
    'You are a senior engineering hiring manager. Based on the code audit data below, determine the developer\'s level (Junior/Mid/Senior), identify the 3 most critical flaws with exact file references, write 3 improved resume bullet points, and generate a 90-day learning roadmap. Respond in structured JSON only.';
  const schemaHint = `Return JSON with these keys:
{
  "developerLevel": "Junior" | "Mid" | "Senior",
  "percentileRank": number,
  "careerInsights": {
    "currentSalaryBracket": string,
    "nextLevelFlaws": string[],
    "jobMatches": [{ "title": string, "salary": string, "skillGap": string }],
    "levelExplanation": string
  },
  "resumeAdvice": {
    "leadProjects": string[],
    "hideProjects": string[],
    "bulletPoints": string[]
  },
  "roadmap": {
    "month1": [{ "task": string, "why": string, "timeEstimate": string, "resourceUrl": string }],
    "month2": [...],
    "month3": [...]
  }
}
Each roadmap "why" must reference a specific finding or score from the audit payload.`;
  const user = `${schemaHint}\n\nAudit payload:\n${JSON.stringify(payload).slice(0, 115000)}`;

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.4
  });
  const raw = completion.choices[0]?.message?.content || '{}';
  return JSON.parse(raw);
}

function fallbackAi(githubProfile, scores, findings, repos) {
  const level = heuristicLevel(scores.overall);
  const top = findings
    .filter((f) => f.severity === 'Critical' || f.severity === 'Warning')
    .slice(0, 3)
    .map((f) => `${f.issue} (${f.repo}/${f.file}:${f.line})`);

  const titles = [
    { title: 'Software Engineer', salary: '$70k–$110k', skillGap: 'Solidify testing and security hygiene.' },
    { title: 'Full Stack Developer', salary: '$75k–$115k', skillGap: 'Demonstrate production auth and validation patterns.' },
    { title: 'Backend Engineer', salary: '$80k–$125k', skillGap: 'Add observability and harden API boundaries.' },
    { title: 'Frontend Engineer', salary: '$70k–$105k', skillGap: 'Improve accessibility and performance budgets.' },
    { title: 'Open Source Contributor', salary: 'Varies', skillGap: 'Polish documentation and reduce code smells.' }
  ];

  const month = (tasks) => tasks.map((t) => ({ ...t }));

  return {
    developerLevel: level,
    percentileRank: percentileFromOverall(scores.overall),
    careerInsights: {
      currentSalaryBracket:
        level === 'Senior' ? '$120k–$180k+ (varies by region)' : level === 'Mid' ? '$90k–$140k' : '$60k–$95k',
      nextLevelFlaws: top.length ? top : ['Increase automated test coverage', 'Remove debug logging from production paths', 'Document architecture decisions in READMEs'],
      jobMatches: titles,
      levelExplanation:
        level === 'Senior'
          ? 'Your aggregate signals suggest you can own features end-to-end with guidance on org-specific scale.'
          : 'Your demonstrated work shows promise; tightening security, testing, and documentation will unlock the next band.'
    },
    resumeAdvice: {
      leadProjects: repos.slice(0, 3).map((r) => r.name),
      hideProjects: repos.length > 5 ? repos.slice(-2).map((r) => r.name) : [],
      bulletPoints: [
        `Shipped features across ${repos.length} public repositories with emphasis on maintainability.`,
        `Improved engineering hygiene by addressing ${findings.length} concrete audit findings from static analysis.`,
        `Validated runtime quality${scores.uiUx != null ? ` with a Lighthouse-based UI/UX score of ${scores.uiUx}/100` : ''}.`
      ]
    },
    roadmap: {
      month1: month([
        {
          task: 'Eliminate critical security findings',
          why: top[0] ? `Linked to: ${top[0]}` : 'Linked to: harden secrets and eval usage',
          timeEstimate: '10–15 hours',
          resourceUrl: 'https://owasp.org/www-project-top-ten/'
        },
        {
          task: 'Add tests to highest-churn repo',
          why: 'Raises maintainability and supports confident refactoring.',
          timeEstimate: '8–12 hours',
          resourceUrl: 'https://jestjs.io/docs/getting-started'
        },
        {
          task: 'Write README architecture section',
          why: 'Documentation score ties directly to hire signal.',
          timeEstimate: '4–6 hours',
          resourceUrl: 'https://www.makeareadme.com/'
        },
        {
          task: 'Triage and fix top 5 static-analysis warnings',
          why: 'Directly tied to findings in this report (modularity, logging, naming).',
          timeEstimate: '8–12 hours',
          resourceUrl: 'https://github.com/features/actions'
        }
      ]),
      month2: month([
        {
          task: 'Refactor longest functions flagged in audit',
          why: 'Directly addresses modularity warnings from the report.',
          timeEstimate: '12–18 hours',
          resourceUrl: 'https://refactoring.guru/'
        },
        {
          task: 'Introduce input validation on public routes',
          why: 'Closes req.body validation gaps surfaced by the audit.',
          timeEstimate: '8–10 hours',
          resourceUrl: 'https://zod.dev/'
        },
        {
          task: 'Remove leftover debug logging',
          why: 'Linked to console.log findings — improves production readiness.',
          timeEstimate: '4–6 hours',
          resourceUrl: 'https://12factor.net/logs'
        },
        {
          task: 'Add API error handling middleware',
          why: 'Reduces user-facing failures and improves security posture.',
          timeEstimate: '6–9 hours',
          resourceUrl: 'https://expressjs.com/en/guide/error-handling.html'
        }
      ]),
      month3: month([
        {
          task: 'Performance pass on live app',
          why: scores.uiUx != null
            ? `Moves UI/UX score from ${scores.uiUx} toward 90+`
            : 'Prepare a deployable demo and run Lighthouse.',
          timeEstimate: '10–14 hours',
          resourceUrl: 'https://developer.chrome.com/docs/lighthouse/'
        },
        {
          task: 'Ship one measurable reliability improvement',
          why: 'Shows senior-level ownership (metrics, alerts, or tests).',
          timeEstimate: '12–20 hours',
          resourceUrl: 'https://sre.google/sre-book/table-of-contents/'
        },
        {
          task: 'Publish a technical write-up of one repo',
          why: 'Boosts documentation and communication signals for hiring.',
          timeEstimate: '6–10 hours',
          resourceUrl: 'https://developers.google.com/tech-writing'
        }
      ])
    },
    extraFindings: []
  };
}

async function processAuditJob(jobId) {
  const job = await AuditJob.findById(jobId);
  if (!job) {
    return;
  }

  await AuditJob.findByIdAndUpdate(jobId, {
    status: 'running',
    currentStep: 1,
    stepsCompleted: []
  });

  const username = job.githubUsername;
  const files = [];
  const findings = [];

  try {
    const user = await fetchUser(username);
    const reposAll = await fetchRepos(username);
    const repos = reposAll.slice(0, MAX_REPOS);

    await AuditJob.findByIdAndUpdate(jobId, { reposFound: repos.length });

    const state = { filesScanned: 0 };
    const onFile = (f) => {
      files.push(f);
    };

    for (const r of repos) {
      if (state.filesScanned >= MAX_FILES_TOTAL) {
        break;
      }
      await walkRepo(username, r.name, '', state, onFile);
      await AuditJob.findByIdAndUpdate(jobId, { filesScanned: state.filesScanned });
    }

    await AuditJob.findByIdAndUpdate(jobId, {
      stepsCompleted: ['ingest'],
      currentStep: 2,
      filesScanned: state.filesScanned
    });

    const cq = analyzeCodeQuality(files, findings);
    await AuditJob.findByIdAndUpdate(jobId, {
      stepsCompleted: ['ingest', 'codeQuality'],
      currentStep: 3
    });

    const sec = analyzeSecurity(files, findings);
    await AuditJob.findByIdAndUpdate(jobId, {
      stepsCompleted: ['ingest', 'codeQuality', 'security'],
      currentStep: 4
    });

    let uiScore = null;
    if (job.liveAppUrl && /^https?:\/\//i.test(job.liveAppUrl)) {
      try {
        uiScore = await runLighthouseScore(job.liveAppUrl);
        findings.push({
          severity: 'Good',
          repo: 'live',
          file: job.liveAppUrl,
          line: 1,
          issue: `Lighthouse aggregate UI/engineering signals scored ${uiScore}/100 across performance, accessibility, best practices, and SEO.`,
          fix: 'Iterate on the lowest Lighthouse category first; re-run audits after each change.'
        });
      } catch (e) {
        findings.push({
          severity: 'Warning',
          repo: 'live',
          file: job.liveAppUrl,
          line: 1,
          issue: `Lighthouse could not complete for this URL (${e.message}).`,
          fix: 'Verify the URL is public, uses HTTPS, and allows automated auditing.'
        });
        uiScore = null;
      }
    } else {
      findings.push({
        severity: 'Warning',
        repo: 'n/a',
        file: 'live app',
        line: 0,
        issue: 'No live app URL was submitted; UI/UX scoring was skipped.',
        fix: 'Add a deployed HTTPS URL on your next audit to unlock Lighthouse-based UI/UX scoring.'
      });
    }

    await AuditJob.findByIdAndUpdate(jobId, {
      stepsCompleted: ['ingest', 'codeQuality', 'security', 'uiUx'],
      currentStep: 5
    });

    const scores = {
      codeQuality: cq.codeQualityScore,
      security: sec.securityScore,
      uiUx: uiScore,
      documentation: cq.documentationScore,
      overall: 0
    };
    const parts = [scores.codeQuality, scores.security, scores.documentation];
    if (scores.uiUx != null) {
      parts.push(scores.uiUx);
    }
    scores.overall = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);

    // ── Smart Scoring System ───────────────────────────────────────
    // Compute the four-pillar smart score and persist to ScoreHistory.
    const smartScore = computeSmartScore({
      user,
      repos,          // full repo metadata array (up to MAX_REPOS)
      files,          // all scanned files with content
      liveAppUrl: job.liveAppUrl || null,
    });

    // Persist to MongoDB — creates a new history entry every audit run
    await ScoreHistory.create({
      jobId:          job._id,
      githubUsername: username.toLowerCase(),
      total:          smartScore.total,
      tier:           smartScore.tier,
      tierColor:      smartScore.tierColor,
      pillars:        smartScore.pillars,
      computedAt:     smartScore.computedAt,
      legacyOverall:  scores.overall,  // keep old score for comparison
    });

    await AuditJob.findByIdAndUpdate(jobId, {
      stepsCompleted: ['ingest', 'codeQuality', 'security', 'uiUx', 'smartScore'],
      currentStep: 5,
    });
    // ── End Smart Scoring ─────────────────────────────────────────

    const payload = {
      githubProfile: {
        name: user.name || username,
        avatar: user.avatar_url,
        bio: user.bio || '',
        publicRepos: user.public_repos
      },
      repos: repos.map((r) => ({
        name: r.name,
        description: r.description,
        language: r.language,
        updated_at: r.updated_at
      })),
      portfolioUrls: job.portfolioUrls,
      liveAppUrl: job.liveAppUrl || null,
      scores,
      smartScore,      // ← include smart score in AI payload for richer insights
      findings: findings.slice(0, 80)
    };

    let ai = null;
    try {
      ai = await callOpenAI(payload);
    } catch (e) {
      console.error('OpenAI error:', e.message);
    }
    const fb = fallbackAi(payload.githubProfile, scores, findings, repos);

    const normalizeJobMatches = (arr) =>
      (arr || []).map((j) => ({
        title: j.title || 'Software Engineer',
        salary: j.salary || 'Varies by region',
        skillGap: j.skillGap || j.skill_gap || j.notes || ''
      }));

    const merged = {
      developerLevel: ai?.developerLevel || fb.developerLevel,
      percentileRank: ai?.percentileRank ?? fb.percentileRank,
      careerInsights: {
        currentSalaryBracket: ai?.careerInsights?.currentSalaryBracket || fb.careerInsights.currentSalaryBracket,
        nextLevelFlaws: ai?.careerInsights?.nextLevelFlaws || fb.careerInsights.nextLevelFlaws,
        jobMatches: normalizeJobMatches(ai?.careerInsights?.jobMatches || fb.careerInsights.jobMatches).slice(0, 10),
        levelExplanation: ai?.careerInsights?.levelExplanation || fb.careerInsights.levelExplanation
      },
      resumeAdvice: {
        leadProjects: ai?.resumeAdvice?.leadProjects || fb.resumeAdvice.leadProjects,
        hideProjects: ai?.resumeAdvice?.hideProjects || fb.resumeAdvice.hideProjects,
        bulletPoints: ai?.resumeAdvice?.bulletPoints || fb.resumeAdvice.bulletPoints
      },
      roadmap: {
        month1: ai?.roadmap?.month1?.length ? ai.roadmap.month1 : fb.roadmap.month1,
        month2: ai?.roadmap?.month2?.length ? ai.roadmap.month2 : fb.roadmap.month2,
        month3: ai?.roadmap?.month3?.length ? ai.roadmap.month3 : fb.roadmap.month3
      }
    };

    merged.developerLevel = ['Junior', 'Mid', 'Senior'].includes(merged.developerLevel)
      ? merged.developerLevel
      : heuristicLevel(scores.overall);

    const scoreLabels = buildScoreLabels(scores, merged.developerLevel);

    const shareToken = crypto.randomBytes(18).toString('hex');

    await AuditReport.findOneAndUpdate(
      { jobId: job._id },
      {
        jobId: job._id,
        githubProfile: payload.githubProfile,
        scores,
        scoreLabels,
        smartScore,                     // ← persist smart score
        developerLevel: merged.developerLevel,
        percentileRank: merged.percentileRank,
        findings,
        careerInsights: merged.careerInsights,
        resumeAdvice: merged.resumeAdvice,
        roadmap: merged.roadmap
      },
      { upsert: true, new: true }
    );

    await AuditJob.findByIdAndUpdate(jobId, {
      status: 'complete',
      currentStep: 5,
      stepsCompleted: ['ingest', 'codeQuality', 'security', 'uiUx', 'report'],
      shareToken
    });
  } catch (err) {
    console.error(err);
    await AuditJob.findByIdAndUpdate(jobId, {
      status: 'failed',
      errorMessage: err.message || 'Audit failed'
    });
  }
}

module.exports = { processAuditJob };
