/**
 * ScoreHistory model
 * Persists every smart-score computation for a GitHub username.
 * Enables trend tracking, leaderboard queries, and progress diffs.
 */

'use strict';

const mongoose = require('mongoose');

// ── Sub-schemas ──────────────────────────────────────────────────
const pillarSchema = new mongoose.Schema(
  {
    score:     { type: Number, required: true },
    max:       { type: Number, required: true },
    label:     { type: String },
    weight:    { type: String },
    breakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const scoreHistorySchema = new mongoose.Schema({
  // Link back to the audit job that triggered this score
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AuditJob',
    required: true,
    index: true,
  },

  // The GitHub user this score belongs to
  githubUsername: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true,
  },

  // ── Aggregate result ──────────────────────────────────────────
  total:     { type: Number, required: true, min: 0, max: 100 },
  tier:      { type: String, enum: ['Elite', 'Senior', 'Mid', 'Junior', 'Beginner'] },
  tierColor: { type: String },

  // ── Four pillars ─────────────────────────────────────────────
  pillars: {
    githubActivity:    { type: pillarSchema },
    projectComplexity: { type: pillarSchema },
    skillsMatch:       { type: pillarSchema },
    consistency:       { type: pillarSchema },
  },

  // When the scoring engine ran
  computedAt: { type: Date, default: Date.now },

  // Snapshot of the old score system for migration / A-B comparison
  legacyOverall: { type: Number, default: null },
});

// ── Indexes ──────────────────────────────────────────────────────
// Fast look-up: latest score for a user
scoreHistorySchema.index({ githubUsername: 1, computedAt: -1 });

// Leaderboard query: highest total scores across all users
scoreHistorySchema.index({ total: -1, computedAt: -1 });

// ── Static helpers ───────────────────────────────────────────────
/**
 * Fetch the most recent score for a username.
 */
scoreHistorySchema.statics.latestFor = function (username) {
  return this.findOne({ githubUsername: username.toLowerCase() })
    .sort({ computedAt: -1 })
    .lean();
};

/**
 * Fetch score history (for trend charts) — newest first.
 */
scoreHistorySchema.statics.historyFor = function (username, limit = 10) {
  return this.find({ githubUsername: username.toLowerCase() })
    .sort({ computedAt: -1 })
    .limit(limit)
    .lean();
};

/**
 * Global leaderboard — top N by latest total score.
 * Uses an aggregation so only the latest entry per user is considered.
 */
scoreHistorySchema.statics.leaderboard = function (limit = 20) {
  return this.aggregate([
    { $sort: { computedAt: -1 } },
    {
      $group: {
        _id:           '$githubUsername',
        total:         { $first: '$total' },
        tier:          { $first: '$tier' },
        tierColor:     { $first: '$tierColor' },
        computedAt:    { $first: '$computedAt' },
        pillarsSkills: { $first: '$pillars.skillsMatch.score' },
      },
    },
    { $sort: { total: -1 } },
    { $limit: limit },
  ]);
};

module.exports = mongoose.model('ScoreHistory', scoreHistorySchema);
