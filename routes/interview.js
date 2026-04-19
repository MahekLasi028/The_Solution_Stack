'use strict';

const express = require('express');
const router  = express.Router();
const OpenAI  = require('openai');
const mongoose = require('mongoose');
const InterviewSession = require('../models/InterviewSession');

// ── Helpers ───────────────────────────────────────────────────────

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set in your .env file.');
  return new OpenAI({ apiKey: key });
}

const ROLE_QUESTIONS = {
  'Software Engineer': {
    Junior: [
      'Tell me about yourself and why you want to be a software engineer.',
      'What is the difference between a stack and a queue? Give a real-world example of each.',
      'Explain what version control is and how you use Git in your workflow.',
      'Walk me through how you would debug a function that returns the wrong output.',
      'What does REST mean and how does a basic API call work?',
    ],
    Mid: [
      'Describe a project where you had to make a significant architectural decision. What were the trade-offs?',
      'Explain the difference between SQL and NoSQL databases and when you would choose each.',
      'How do you handle race conditions in asynchronous code?',
      'Walk me through how you would design a URL shortening service.',
      'What strategies do you use to write maintainable, testable code?',
    ],
    Senior: [
      'How would you design a distributed task queue that can handle millions of jobs per day?',
      'Describe a time you led a technical migration or refactor. What was your approach to managing risk?',
      'How do you balance technical debt vs. feature velocity on a team?',
      'Explain CAP theorem and how it influenced a system you designed or worked on.',
      'Walk me through how you mentor junior developers and raise the engineering bar on a team.',
    ],
  },
  'Frontend Developer': {
    Junior: [
      'What is the difference between `null` and `undefined` in JavaScript?',
      'Explain what the DOM is and how JavaScript interacts with it.',
      'What is the CSS box model and how does `box-sizing: border-box` change it?',
      'How does `async/await` differ from using `.then()` chains?',
      'What tools or techniques do you use to make a website accessible?',
    ],
    Mid: [
      'Explain how React\'s virtual DOM works and why it improves performance.',
      'What is the difference between `useEffect` and `useLayoutEffect`?',
      'How would you optimize a React app that re-renders too frequently?',
      'Describe your approach to state management in a large frontend app.',
      'What is CORS and how do you handle it in a frontend application?',
    ],
    Senior: [
      'How would you architect a micro-frontend system for a large team?',
      'Describe your strategy for achieving Core Web Vitals targets in a complex app.',
      'How do you approach design system implementation and governance?',
      'Explain how you would set up CI/CD with automated visual regression testing.',
      'How do you balance developer experience vs. bundle size and performance?',
    ],
  },
  'Backend Developer': {
    Junior: [
      'What is the difference between authentication and authorization?',
      'Explain what a REST API is and list the common HTTP methods and their purposes.',
      'What is an ORM and what problem does it solve?',
      'How do you store passwords securely in a database?',
      'What does "stateless" mean in the context of a web server?',
    ],
    Mid: [
      'How would you design a rate-limiting system for a public API?',
      'Explain database indexing — when would you add an index and what are the trade-offs?',
      'How do you handle long-running tasks so they don\'t block your API responses?',
      'Describe the difference between JWT and session-based authentication.',
      'What is N+1 query problem and how do you prevent it?',
    ],
    Senior: [
      'Walk me through designing a multi-tenant SaaS backend with strong data isolation.',
      'How would you approach database sharding for a high-traffic application?',
      'Describe how you would implement an event-driven architecture using message queues.',
      'How do you design APIs that are backward compatible as they evolve?',
      'What is your approach to observability — logging, tracing, and alerting in production?',
    ],
  },
  'Full Stack Developer': {
    Junior: [
      'Describe how data flows from a user clicking a button to a database update and back.',
      'What is the difference between client-side and server-side rendering?',
      'Explain what CRUD means and implement a simple example.',
      'How do environment variables work and why shouldn\'t you commit `.env` files?',
      'What is a foreign key and how does it enforce referential integrity?',
    ],
    Mid: [
      'How would you implement real-time features like notifications in a web app?',
      'Describe your deployment workflow from code commit to production.',
      'How do you handle user sessions and keep them secure across frontend and backend?',
      'Walk me through how you would add full-text search to a web application.',
      'How do you approach API versioning?',
    ],
    Senior: [
      'Design a scalable architecture for a social media platform expecting 10M daily users.',
      'How do you ensure consistency between your frontend state and backend data?',
      'Describe how you would implement multi-region deployment with failover.',
      'How do you manage feature flags across both frontend and backend?',
      'Walk me through how you would lead a team migrating a monolith to microservices.',
    ],
  },
};

function getQuestions(role, difficulty) {
  const byRole = ROLE_QUESTIONS[role] || ROLE_QUESTIONS['Software Engineer'];
  return byRole[difficulty] || byRole['Mid'];
}

// ── POST /api/interview/start ─────────────────────────────────────
// Creates a session and returns the questions
router.post('/start', async (req, res) => {
  try {
    const {
      githubUsername = '',
      jobRole        = 'Software Engineer',
      difficulty     = 'Mid',
    } = req.body || {};

    const validRoles  = Object.keys(ROLE_QUESTIONS);
    const validDiffs  = ['Junior', 'Mid', 'Senior'];
    const role        = validRoles.includes(jobRole) ? jobRole : 'Software Engineer';
    const diff        = validDiffs.includes(difficulty) ? difficulty : 'Mid';
    const questions   = getQuestions(role, diff);

    const session = await InterviewSession.create({
      githubUsername: githubUsername.toLowerCase().trim() || 'anonymous',
      jobRole:    role,
      difficulty: diff,
      questions,
      answers:    [],
      status:     'active',
    });

    return res.json({
      sessionId: session._id.toString(),
      jobRole:   role,
      difficulty: diff,
      questions,
    });
  } catch (err) {
    console.error('Interview start error:', err);
    return res.status(500).json({ error: err.message || 'Failed to start session' });
  }
});

// ── POST /api/interview/:sessionId/answer ────────────────────────
// Receives transcript for one question, calls OpenAI for feedback
router.post('/:sessionId/answer', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.sessionId)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const session = await InterviewSession.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'complete') {
      return res.status(400).json({ error: 'Session already completed' });
    }

    const { questionIndex, transcript } = req.body || {};
    if (typeof questionIndex !== 'number' || !transcript?.trim()) {
      return res.status(400).json({ error: 'questionIndex and transcript are required' });
    }

    const questionText = session.questions[questionIndex];
    if (!questionText) {
      return res.status(400).json({ error: 'Invalid questionIndex' });
    }

    // Build OpenAI feedback prompt
    const systemPrompt = `You are a senior technical interviewer at a top tech company conducting a ${session.difficulty}-level ${session.jobRole} interview.
Evaluate the candidate's spoken answer and return ONLY valid JSON — no markdown, no code fences.`;

    const userPrompt = `Question: "${questionText}"

Candidate's answer (speech-to-text transcript):
"${transcript.trim()}"

Return this exact JSON structure:
{
  "scores": {
    "clarity": <0-10 integer>,
    "depth": <0-10 integer>,
    "relevance": <0-10 integer>,
    "overall": <0-10 integer>
  },
  "feedback": "<2-4 sentences: what was strong, what was missing, one concrete improvement tip>",
  "modelAnswer": "<1-3 sentence ideal answer summary for this level>"
}`;

    let aiResult = null;
    try {
      const client = getClient();
      const completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 500,
      });
      const raw = completion.choices[0]?.message?.content || '{}';
      aiResult = JSON.parse(raw);
    } catch (aiErr) {
      console.error('OpenAI feedback error:', aiErr.message);
      // Graceful fallback — still store the transcript
      aiResult = {
        scores: { clarity: 5, depth: 5, relevance: 5, overall: 5 },
        feedback: 'AI feedback unavailable right now. Check your OPENAI_API_KEY.',
        modelAnswer: '',
      };
    }

    const answerEntry = {
      questionIndex,
      questionText,
      transcript:  transcript.trim(),
      feedback:    aiResult.feedback    || '',
      scores:      aiResult.scores      || { clarity: 5, depth: 5, relevance: 5, overall: 5 },
    };

    // Upsert answer (handles re-submission)
    const existingIdx = session.answers.findIndex((a) => a.questionIndex === questionIndex);
    if (existingIdx >= 0) {
      session.answers[existingIdx] = answerEntry;
    } else {
      session.answers.push(answerEntry);
    }
    session.markModified('answers');
    await session.save();

    return res.json({
      feedback:    aiResult.feedback    || '',
      modelAnswer: aiResult.modelAnswer || '',
      scores:      answerEntry.scores,
    });
  } catch (err) {
    console.error('Interview answer error:', err);
    return res.status(500).json({ error: err.message || 'Failed to process answer' });
  }
});

// ── POST /api/interview/:sessionId/complete ──────────────────────
// Wraps up the session, computes overall score, returns summary
router.post('/:sessionId/complete', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.sessionId)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const session = await InterviewSession.findById(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Calculate overall score from answered questions
    const answered = session.answers.filter((a) => a.scores?.overall != null);
    const avgOverall = answered.length
      ? answered.reduce((s, a) => s + (a.scores.overall || 0), 0) / answered.length
      : 0;
    const overallScore = Math.round(avgOverall * 10); // scale 0-10 → 0-100

    // Generate summary via OpenAI
    let summary = '';
    try {
      const client = getClient();
      const summaryPrompt = `You interviewed a candidate for a ${session.difficulty} ${session.jobRole} role.
They answered ${answered.length} of ${session.questions.length} questions.
Average score: ${avgOverall.toFixed(1)} / 10.

Their answers and feedback:
${answered.map((a, i) => `Q${i + 1}: "${a.questionText}"\nFeedback: ${a.feedback}`).join('\n\n')}

Write a 3-4 sentence honest interview summary covering: overall performance, top strength, biggest gap, and one actionable next step. Be direct.`;

      const completion = await client.chat.completions.create({
        model:       'gpt-4o-mini',
        messages:    [{ role: 'user', content: summaryPrompt }],
        temperature: 0.5,
        max_tokens:  300,
      });
      summary = completion.choices[0]?.message?.content?.trim() || '';
    } catch (e) {
      summary = `Interview complete. You answered ${answered.length} question(s) with an average score of ${avgOverall.toFixed(1)}/10.`;
    }

    session.status      = 'complete';
    session.overallScore = overallScore;
    session.summary     = summary;
    session.completedAt = new Date();
    await session.save();

    return res.json({ overallScore, summary, answeredCount: answered.length });
  } catch (err) {
    console.error('Interview complete error:', err);
    return res.status(500).json({ error: err.message || 'Failed to complete session' });
  }
});

// ── GET /api/interview/:sessionId ────────────────────────────────
router.get('/:sessionId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.sessionId)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    const session = await InterviewSession.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    return res.json(session);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to load session' });
  }
});

module.exports = router;
