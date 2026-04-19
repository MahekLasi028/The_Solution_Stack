const mongoose = require('mongoose');

const findingSchema = new mongoose.Schema({
  severity: { type: String, enum: ['Critical', 'Warning', 'Good'] },
  repo: String,
  file: String,
  line: Number,
  issue: String,
  fix: String
});

const jobMatchSchema = new mongoose.Schema({
  title: String,
  salary: String,
  skillGap: String
});

const monthTaskSchema = new mongoose.Schema({
  task: String,
  why: String,
  timeEstimate: String,
  resourceUrl: String
});

const pillarSchema = new mongoose.Schema(
  {
    score:     { type: Number },
    max:       { type: Number },
    label:     { type: String },
    weight:    { type: String },
    breakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const auditReportSchema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'AuditJob', required: true, unique: true },
  githubProfile: {
    name: String,
    avatar: String,
    bio: String,
    publicRepos: Number
  },
  scores: {
    codeQuality: Number,
    security: Number,
    uiUx: { type: Number, default: null },
    documentation: Number,
    overall: Number
  },
  // ── Smart Score (four-pillar system) ──────────────────────────
  smartScore: {
    total:     { type: Number, default: null },
    tier:      { type: String },
    tierColor: { type: String },
    pillars: {
      githubActivity:    { type: pillarSchema },
      projectComplexity: { type: pillarSchema },
      skillsMatch:       { type: pillarSchema },
      consistency:       { type: pillarSchema },
    },
    computedAt: { type: Date },
  },
  // ─────────────────────────────────────────────────────────────
  scoreLabels: {
    codeQuality: String,
    security: String,
    uiUx: String,
    documentation: String,
    overall: String
  },
  developerLevel: { type: String, enum: ['Junior', 'Mid', 'Senior'] },
  percentileRank: Number,
  findings: [findingSchema],
  careerInsights: {
    currentSalaryBracket: String,
    nextLevelFlaws: [String],
    jobMatches: [jobMatchSchema],
    levelExplanation: String
  },
  resumeAdvice: {
    leadProjects: [String],
    hideProjects: [String],
    bulletPoints: [String]
  },
  roadmap: {
    month1: [monthTaskSchema],
    month2: [monthTaskSchema],
    month3: [monthTaskSchema]
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AuditReport', auditReportSchema);
