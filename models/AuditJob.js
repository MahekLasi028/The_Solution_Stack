const mongoose = require('mongoose');

const auditJobSchema = new mongoose.Schema({
  githubUsername: { type: String, required: true },
  portfolioUrls: [{ type: String }],
  liveAppUrl: { type: String, default: '' },
  status: {
    type: String,
    enum: ['queued', 'running', 'complete', 'failed'],
    default: 'queued'
  },
  currentStep: { type: Number, min: 1, max: 5, default: 1 },
  stepsCompleted: [{ type: String }],
  reposFound: { type: Number, default: 0 },
  filesScanned: { type: Number, default: 0 },
  shareToken: { type: String, unique: true, sparse: true },
  errorMessage: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AuditJob', auditJobSchema);
