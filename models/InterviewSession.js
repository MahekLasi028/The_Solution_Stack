'use strict';

const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema(
  {
    questionIndex: { type: Number, required: true },
    questionText:  { type: String, required: true },
    transcript:    { type: String, default: '' },
    feedback:      { type: String, default: '' },
    scores: {
      clarity:     { type: Number, min: 0, max: 10, default: null },
      depth:       { type: Number, min: 0, max: 10, default: null },
      relevance:   { type: Number, min: 0, max: 10, default: null },
      overall:     { type: Number, min: 0, max: 10, default: null },
    },
    answeredAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const interviewSessionSchema = new mongoose.Schema({
  githubUsername: { type: String, lowercase: true, trim: true, index: true },
  jobRole:        { type: String, default: 'Software Engineer' },
  difficulty:     { type: String, enum: ['Junior', 'Mid', 'Senior'], default: 'Mid' },
  questions:      [{ type: String }],
  answers:        [answerSchema],
  overallScore:   { type: Number, min: 0, max: 100, default: null },
  summary:        { type: String, default: '' },
  status:         { type: String, enum: ['active', 'complete'], default: 'active' },
  createdAt:      { type: Date, default: Date.now },
  completedAt:    { type: Date, default: null },
});

module.exports = mongoose.model('InterviewSession', interviewSessionSchema);
