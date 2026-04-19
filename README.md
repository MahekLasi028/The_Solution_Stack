# DevAudit — Developer Career Intelligence Platform

Audit any GitHub profile and get a scored report on code quality, security, documentation, and UI/UX — with AI-powered career insights and a 90-day learning roadmap.

---

## Quick Start (VS Code)

### Prerequisites
- **Node.js** v18 or later — https://nodejs.org
- **MongoDB** running locally — https://www.mongodb.com/try/download/community  
  *(Or a free Atlas cluster: https://www.mongodb.com/atlas)*
- **Google Chrome** installed (required for Lighthouse UI/UX scoring)

### 1. Set up your environment variables

Open the `.env` file in the project root and fill in your values:

```
MONGODB_URI=mongodb://localhost:27017/devaudit   ← keep as-is for local MongoDB
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx            ← required (see below)
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx           ← optional (app works without it)
PORT=3000
```

**Getting a GitHub Token:**
1. Go to https://github.com/settings/tokens → *Generate new token (classic)*
2. Select scope: `public_repo`
3. Copy the token into `.env`

### 2. Install dependencies

Dependencies are already included in `node_modules`. If you ever need to reinstall:

```bash
npm install
```

### 3. Run the server

```bash
node server.js
```

Or with auto-restart on file changes:

```bash
npx nodemon server.js
```

### 4. Open the app

Visit **http://localhost:3000** in your browser.

---

## Project Structure

```
├── server.js          # Express entry point
├── worker.js          # Audit engine (GitHub, Lighthouse, OpenAI)
├── routes/
│   └── audit.js       # REST API routes
├── models/
│   ├── AuditJob.js    # Mongoose schema for audit jobs
│   └── AuditReport.js # Mongoose schema for reports
├── lib/
│   └── githubUsername.js  # Username normalisation helpers
├── public/
│   ├── index.html     # Submit form
│   ├── loading.html   # Progress screen
│   ├── report.html    # Full audit report
│   ├── roadmap.html   # 90-day roadmap
│   ├── css/styles.css
│   └── js/            # Client-side scripts
└── .env               # Your local secrets (never commit this)
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `MongoDB connection error` | Start MongoDB locally or set a valid Atlas URI in `.env` |
| `GitHub API rate limit` | Add a `GITHUB_TOKEN` to `.env` |
| Lighthouse fails | Make sure Google Chrome is installed |
| Port already in use | Change `PORT=3001` in `.env` |
| `Cannot GET /` | You must use `http://localhost:3000`, not open the HTML file directly |

---

## Notes

- `OPENAI_API_KEY` is **optional**. Without it the app uses a built-in fallback to generate career insights and the roadmap — all features still work.
- The `.env` file is intentionally excluded from version control. Never commit real secrets.
