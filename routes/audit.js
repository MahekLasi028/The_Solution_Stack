const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const AuditJob = require('../models/AuditJob');
const AuditReport = require('../models/AuditReport');
const ScoreHistory = require('../models/ScoreHistory');
const { processAuditJob } = require('../worker');
const { normalizeGithubUsername, isValidGithubLogin } = require('../lib/githubUsername');

router.post('/start', async (req, res) => {
  try {
    const { githubUsername, portfolioUrls, liveAppUrl } = req.body || {};

    if (githubUsername == null || githubUsername === '') {
      return res.status(400).json({ error: 'githubUsername is required' });
    }

    const username = normalizeGithubUsername(String(githubUsername));
    if (!username) {
      return res.status(400).json({ error: 'githubUsername is required' });
    }
    if (!isValidGithubLogin(username)) {
      return res.status(400).json({
        error:
          'Invalid GitHub username. Use your login only (letters, numbers, hyphens), or paste your profile URL like https://github.com/yourname'
      });
    }

    let urls = [];
    if (Array.isArray(portfolioUrls)) {
      urls = portfolioUrls.map((u) => String(u).trim()).filter(Boolean);
    } else if (typeof portfolioUrls === 'string' && portfolioUrls.trim()) {
      urls = portfolioUrls
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }

    const live = liveAppUrl && String(liveAppUrl).trim() ? String(liveAppUrl).trim() : '';

    const job = await AuditJob.create({
      githubUsername: username,
      portfolioUrls: urls,
      liveAppUrl: live,
      status: 'queued',
      currentStep: 1,
      stepsCompleted: [],
      reposFound: 0,
      filesScanned: 0
    });

    setImmediate(() => {
      processAuditJob(job._id.toString()).catch((err) => {
        console.error('Background audit failed:', err);
      });
    });

    return res.json({ jobId: job._id.toString() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to start audit' });
  }
});

router.get('/share/:shareToken', async (req, res) => {
  try {
    const job = await AuditJob.findOne({ shareToken: req.params.shareToken }).lean();
    if (!job) {
      return res.status(404).json({ error: 'Shared audit not found' });
    }
    const report = await AuditReport.findOne({ jobId: job._id }).lean();
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    return res.json({
      readOnly: true,
      job: {
        _id: job._id,
        githubUsername: job.githubUsername,
        createdAt: job.createdAt
      },
      report
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load shared report' });
  }
});

router.get('/:jobId/status', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.jobId)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }
    const job = await AuditJob.findById(req.params.jobId).lean();
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json({
      status: job.status,
      currentStep: job.currentStep,
      stepsCompleted: job.stepsCompleted || [],
      reposFound: job.reposFound ?? 0,
      filesScanned: job.filesScanned ?? 0,
      errorMessage: job.errorMessage || undefined
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load status' });
  }
});

router.get('/:jobId/report', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.jobId)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }
    const job = await AuditJob.findById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'complete') {
      return res.status(202).json({ status: job.status, message: 'Report not ready yet' });
    }
    const report = await AuditReport.findOne({ jobId: job._id }).lean();
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    return res.json(report);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load report' });
  }
});

router.get('/:jobId/roadmap', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.jobId)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }
    const job = await AuditJob.findById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'complete') {
      return res.status(202).json({ status: job.status, message: 'Roadmap not ready yet' });
    }
    const report = await AuditReport.findOne({ jobId: job._id }).lean();
    if (!report || !report.roadmap) {
      return res.status(404).json({ error: 'Roadmap not found' });
    }
    return res.json({
      jobId: job._id.toString(),
      shareToken: job.shareToken,
      roadmap: report.roadmap
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load roadmap' });
  }
});

// ── Smart Score: history for a GitHub user ───────────────────────
// GET /api/audit/scores/:username/history
router.get('/scores/:username/history', async (req, res) => {
  try {
    const username = normalizeGithubUsername(req.params.username);
    if (!username || !isValidGithubLogin(username)) {
      return res.status(400).json({ error: 'Invalid GitHub username' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const history = await ScoreHistory.historyFor(username, limit);
    return res.json({ username, history });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load score history' });
  }
});

// ── Smart Score: leaderboard (top 20 by total) ───────────────────
// GET /api/audit/scores/leaderboard
router.get('/scores/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const board = await ScoreHistory.leaderboard(limit);
    return res.json({ leaderboard: board });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ── Smart Score: latest for a user ──────────────────────────────
// GET /api/audit/scores/:username/latest
router.get('/scores/:username/latest', async (req, res) => {
  try {
    const username = normalizeGithubUsername(req.params.username);
    if (!username || !isValidGithubLogin(username)) {
      return res.status(400).json({ error: 'Invalid GitHub username' });
    }
    const score = await ScoreHistory.latestFor(username);
    if (!score) {
      return res.status(404).json({ error: 'No score found for this user. Run an audit first.' });
    }
    return res.json(score);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load score' });
  }
});

module.exports = router;
