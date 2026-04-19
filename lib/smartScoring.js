/**
 * Smart Scoring System
 * ─────────────────────────────────────────────────────────────────
 * Replaces the old averaged score with four weighted pillars:
 *
 *   GitHub Activity    20 pts  — commits, push cadence, repo age spread
 *   Project Complexity 30 pts  — language variety, repo depth, file counts
 *   Skills Match       30 pts  — detected tech stack vs. modern demand
 *   Consistency        20 pts  — regular commits, naming, docs across repos
 *
 * Total: 100 pts, stored in MongoDB via ScoreHistory model.
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

// ── Tier labels ──────────────────────────────────────────────────
const TIER_LABELS = [
  { min: 90, label: 'Elite',    color: 'platinum' },
  { min: 75, label: 'Senior',   color: 'gold'     },
  { min: 55, label: 'Mid',      color: 'silver'   },
  { min: 35, label: 'Junior',   color: 'bronze'   },
  { min: 0,  label: 'Beginner', color: 'gray'     },
];

function getTier(total) {
  return TIER_LABELS.find((t) => total >= t.min) || TIER_LABELS[TIER_LABELS.length - 1];
}

// ── Helpers ──────────────────────────────────────────────────────
function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function daysBetween(dateA, dateB) {
  return Math.abs(new Date(dateA) - new Date(dateB)) / 86_400_000;
}

// ── 1. GitHub Activity  (max 20 pts) ────────────────────────────
/**
 * Signals used:
 *   - Total public repos          (breadth of activity)
 *   - Stars received              (community validation)
 *   - Fork count                  (others building on your work)
 *   - Account age spread          (long-term commitment)
 *   - Recent push activity        (repos pushed in last 90 days)
 */
function scoreGitHubActivity(user, repos) {
  let pts = 0;

  // Public repos: up to 6 pts (log-scaled so 5 repos ≠ 5 pts)
  const repoCount = user.public_repos || 0;
  pts += clamp(Math.log2(repoCount + 1) * 2.2, 0, 6);

  // Stars across top repos: up to 5 pts
  const totalStars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  pts += clamp(Math.log2(totalStars + 1) * 1.5, 0, 5);

  // Forks: up to 3 pts
  const totalForks = repos.reduce((s, r) => s + (r.forks_count || 0), 0);
  pts += clamp(Math.log2(totalForks + 1) * 1.2, 0, 3);

  // Account age spread: up to 3 pts (older = more history)
  if (user.created_at) {
    const ageDays = daysBetween(user.created_at, new Date());
    pts += clamp((ageDays / 365) * 0.9, 0, 3);
  }

  // Recent push activity (last 90 days): up to 3 pts
  const cutoff = Date.now() - 90 * 86_400_000;
  const recentPushes = repos.filter(
    (r) => r.pushed_at && new Date(r.pushed_at).getTime() > cutoff
  ).length;
  pts += clamp(recentPushes * 0.6, 0, 3);

  return {
    raw: clamp(pts, 0, 20),
    max: 20,
    breakdown: {
      repoCount,
      totalStars,
      totalForks,
      recentPushes,
      accountAgeDays: user.created_at
        ? Math.round(daysBetween(user.created_at, new Date()))
        : null,
    },
  };
}

// ── 2. Project Complexity  (max 30 pts) ─────────────────────────
/**
 * Signals used:
 *   - Distinct languages used     (polyglot signal)
 *   - Has non-trivial repos       (repos with > 5 files scanned)
 *   - Has a live/deployed app     (production readiness)
 *   - Scanned file depth          (breadth of codebase explored)
 *   - Config / infra files        (Docker, CI, package.json …)
 *   - README presence + length    (project packaging quality)
 */
function scoreProjectComplexity(repos, files, liveAppUrl) {
  let pts = 0;

  // Language diversity: up to 8 pts
  const langs = new Set(repos.map((r) => r.language).filter(Boolean));
  pts += clamp(langs.size * 1.6, 0, 8);

  // Non-trivial repos (those with code files): up to 6 pts
  const reposWithCode = new Set(
    files.filter((f) => !f.isReadme && !f.isEnv && f.ext).map((f) => f.repo)
  ).size;
  pts += clamp(reposWithCode * 1.2, 0, 6);

  // Live/deployed app submitted: 4 pts flat
  if (liveAppUrl && /^https?:\/\//i.test(liveAppUrl)) {
    pts += 4;
  }

  // Total scanned files (depth signal): up to 5 pts
  const codeFiles = files.filter((f) => !f.isReadme && !f.isEnv).length;
  pts += clamp(Math.log2(codeFiles + 1) * 1.5, 0, 5);

  // Config / infra files detected: up to 4 pts
  const infraPatterns = /dockerfile|\.yml|\.yaml|\.github|package\.json|requirements\.txt|pom\.xml|build\.gradle/i;
  const infraFiles = files.filter((f) => infraPatterns.test(f.name)).length;
  pts += clamp(infraFiles * 1.0, 0, 4);

  // README depth across repos: up to 3 pts
  const readmes = files.filter((f) => f.isReadme);
  const avgReadmeLen = readmes.length
    ? readmes.reduce((s, f) => s + f.content.length, 0) / readmes.length
    : 0;
  pts += clamp((avgReadmeLen / 500) * 3, 0, 3);

  return {
    raw: clamp(pts, 0, 30),
    max: 30,
    breakdown: {
      languageCount: langs.size,
      languages: [...langs],
      reposWithCode,
      codeFiles,
      infraFiles,
      hasLiveApp: !!(liveAppUrl && /^https?:\/\//i.test(liveAppUrl)),
      avgReadmeLen: Math.round(avgReadmeLen),
    },
  };
}

// ── 3. Skills Match  (max 30 pts) ───────────────────────────────
/**
 * Checks the scanned files and repo metadata for in-demand tech signals.
 * Grouped into three tiers so any single skill can't inflate the score.
 *
 *   Tier A – Core modern skills (frameworks, DBs, cloud):  up to 14 pts
 *   Tier B – DevOps / testing / security signals:          up to 10 pts
 *   Tier C – Soft signals (patterns, naming, docs):        up to 6 pts
 */

const TIER_A_SKILLS = [
  { name: 'React / Vue / Angular', pattern: /react|vue|angular/i,                pts: 3 },
  { name: 'Node.js / Express',     pattern: /express|fastify|koa|hapi/i,          pts: 2 },
  { name: 'TypeScript',            pattern: /\.ts$|typescript/i,                  pts: 3 },
  { name: 'Python / Django / FastAPI', pattern: /django|fastapi|flask/i,          pts: 3 },
  { name: 'Database (SQL/NoSQL)',   pattern: /mongoose|sequelize|prisma|knex|typeorm|pg\b|mysql/i, pts: 3 },
];

const TIER_B_SKILLS = [
  { name: 'Testing (Jest / Pytest)', pattern: /\.test\.|\.spec\.|jest|pytest|mocha|vitest/i, pts: 3 },
  { name: 'CI / CD config',          pattern: /github\/workflows|\.gitlab-ci|\.circleci|jenkinsfile/i, pts: 3 },
  { name: 'Docker / containers',     pattern: /dockerfile|docker-compose/i,       pts: 2 },
  { name: 'Auth / JWT / OAuth',      pattern: /jwt|passport|oauth|session|cookie/i, pts: 2 },
];

const TIER_C_SKILLS = [
  { name: 'Env / secret management', pattern: /dotenv|process\.env|secret/i, pts: 2 },
  { name: 'Error handling',          pattern: /try\s*{|catch\s*\(|\.catch\(|next\(err/i, pts: 2 },
  { name: 'Async / Promise patterns', pattern: /async\s+|await\s+|Promise\./i,   pts: 2 },
];

function skillSearch(pattern, files, repos) {
  // Search file content + repo names / languages
  const inFiles = files.some(
    (f) => pattern.test(f.content) || pattern.test(f.name) || pattern.test(f.path)
  );
  const inRepos = repos.some(
    (r) => pattern.test(r.name) || pattern.test(r.description || '') || pattern.test(r.language || '')
  );
  return inFiles || inRepos;
}

function scoreSkillsMatch(repos, files) {
  const detected = [];
  let pts = 0;

  let tierATotal = 0;
  for (const skill of TIER_A_SKILLS) {
    if (skillSearch(skill.pattern, files, repos)) {
      tierATotal += skill.pts;
      detected.push(skill.name);
    }
  }
  pts += clamp(tierATotal, 0, 14);

  let tierBTotal = 0;
  for (const skill of TIER_B_SKILLS) {
    if (skillSearch(skill.pattern, files, repos)) {
      tierBTotal += skill.pts;
      detected.push(skill.name);
    }
  }
  pts += clamp(tierBTotal, 0, 10);

  let tierCTotal = 0;
  for (const skill of TIER_C_SKILLS) {
    if (skillSearch(skill.pattern, files, repos)) {
      tierCTotal += skill.pts;
      detected.push(skill.name);
    }
  }
  pts += clamp(tierCTotal, 0, 6);

  const missing = [
    ...TIER_A_SKILLS,
    ...TIER_B_SKILLS,
    ...TIER_C_SKILLS,
  ]
    .filter((s) => !skillSearch(s.pattern, files, repos))
    .map((s) => s.name);

  return {
    raw: clamp(pts, 0, 30),
    max: 30,
    breakdown: {
      detectedSkills: detected,
      missingSkills: missing,
      tierAScore: clamp(tierATotal, 0, 14),
      tierBScore: clamp(tierBTotal, 0, 10),
      tierCScore: clamp(tierCTotal, 0, 6),
    },
  };
}

// ── 4. Consistency  (max 20 pts) ────────────────────────────────
/**
 * Signals used:
 *   - Uniform naming style        (camelCase dominance)
 *   - README in multiple repos    (documentation habit)
 *   - Push cadence regularity     (spread of pushed_at dates)
 *   - No .env files committed     (security habit)
 *   - Proportion of code with tests
 */
function scoreConsistency(repos, files) {
  let pts = 0;

  // Naming uniformity: up to 5 pts
  let camelLines = 0;
  let snakeLines = 0;
  for (const f of files) {
    if (f.isReadme || f.isEnv || !f.content) continue;
    for (const line of f.content.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('//') || s.startsWith('*')) continue;
      if (/[a-z][a-zA-Z0-9]*[A-Z]/.test(s)) camelLines++;
      if (/[a-z][a-z0-9]*_[a-z]/.test(s)) snakeLines++;
    }
  }
  const totalNaming = camelLines + snakeLines;
  const dominance = totalNaming > 0
    ? Math.max(camelLines, snakeLines) / totalNaming
    : 0.5; // neutral if no code
  pts += clamp(dominance * 5, 0, 5);

  // README habit: up to 4 pts (proportion of repos with readme)
  const reposWithReadme = new Set(
    files.filter((f) => f.isReadme).map((f) => f.repo)
  ).size;
  const readmePct = repos.length ? reposWithReadme / repos.length : 0;
  pts += clamp(readmePct * 4, 0, 4);

  // Push cadence spread: up to 5 pts
  // More evenly spread push dates = higher score (not one burst then nothing)
  const pushDates = repos
    .filter((r) => r.pushed_at)
    .map((r) => new Date(r.pushed_at).getTime())
    .sort((a, b) => a - b);

  if (pushDates.length >= 2) {
    const gaps = [];
    for (let i = 1; i < pushDates.length; i++) {
      gaps.push((pushDates[i] - pushDates[i - 1]) / 86_400_000);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + Math.pow(g - avgGap, 2), 0) / gaps.length;
    const cv = avgGap > 0 ? Math.sqrt(variance) / avgGap : 1; // coefficient of variation
    // Lower CV = more regular = better score
    pts += clamp((1 - Math.min(cv, 1)) * 5, 0, 5);
  }

  // No .env committed: up to 3 pts
  const envFiles = files.filter((f) => f.isEnv).length;
  pts += envFiles === 0 ? 3 : Math.max(0, 3 - envFiles);

  // Test file habit: up to 3 pts
  const testFiles = files.filter((f) => /\.(test|spec)\.(js|ts|py)$/i.test(f.name)).length;
  const codeFiles = files.filter((f) => !f.isReadme && !f.isEnv).length;
  const testRatio = codeFiles > 0 ? testFiles / codeFiles : 0;
  pts += clamp(testRatio * 10, 0, 3);

  return {
    raw: clamp(pts, 0, 20),
    max: 20,
    breakdown: {
      camelLines,
      snakeLines,
      reposWithReadme,
      envFilesCommitted: envFiles,
      testFiles,
      codeFiles,
    },
  };
}

// ── Public API ───────────────────────────────────────────────────
/**
 * computeSmartScore({ user, repos, files, liveAppUrl })
 *
 * Returns a SmartScore object ready to persist to MongoDB.
 */
function computeSmartScore({ user, repos, files, liveAppUrl }) {
  const activity    = scoreGitHubActivity(user, repos);
  const complexity  = scoreProjectComplexity(repos, files, liveAppUrl);
  const skills      = scoreSkillsMatch(repos, files);
  const consistency = scoreConsistency(repos, files);

  const total = activity.raw + complexity.raw + skills.raw + consistency.raw;
  const tier  = getTier(total);

  return {
    total: clamp(total, 0, 100),
    tier:  tier.label,
    tierColor: tier.color,
    pillars: {
      githubActivity: {
        score: activity.raw,
        max:   activity.max,
        label: 'GitHub Activity',
        weight: '20%',
        breakdown: activity.breakdown,
      },
      projectComplexity: {
        score: complexity.raw,
        max:   complexity.max,
        label: 'Project Complexity',
        weight: '30%',
        breakdown: complexity.breakdown,
      },
      skillsMatch: {
        score: skills.raw,
        max:   skills.max,
        label: 'Skills Match',
        weight: '30%',
        breakdown: skills.breakdown,
      },
      consistency: {
        score: consistency.raw,
        max:   consistency.max,
        label: 'Consistency',
        weight: '20%',
        breakdown: consistency.breakdown,
      },
    },
    computedAt: new Date(),
  };
}

module.exports = { computeSmartScore, getTier };
