const express = require('express');
const router = express.Router();
const axios = require('axios');
const OpenAI = require('openai');

const GITHUB_API = 'https://api.github.com';

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function getGithubData(username) {
  const res = await axios.get(
    `${GITHUB_API}/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`,
    { headers: ghHeaders(), timeout: 30000, validateStatus: () => true }
  );
  if (res.status === 404) throw new Error('GitHub user not found');
  if (res.status === 403 || res.status === 429)
    throw new Error('GitHub rate limit hit. Add GITHUB_TOKEN to your .env');
  if (res.status !== 200) throw new Error(`GitHub error (${res.status})`);

  const repos = Array.isArray(res.data) ? res.data.slice(0, 20) : [];
  const langCount = {};
  const topics = new Set();

  for (const r of repos) {
    if (r.language) langCount[r.language] = (langCount[r.language] || 0) + 1;
    (r.topics || []).forEach((t) => topics.add(t));
  }

  return {
    languages: langCount,
    topics: [...topics],
    repoNames: repos.map((r) => r.name),
    repoDescriptions: repos.map((r) => r.description).filter(Boolean),
    totalRepos: repos.length
  };
}

async function extractSkillsFromText(resumeText, openaiKey) {
  const client = new OpenAI({ apiKey: openaiKey });

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content:
          'You are a resume parser. Extract technical information from the resume text and return ONLY valid JSON, no markdown.'
      },
      {
        role: 'user',
        content: `Extract all technical skills from this resume text. Return this exact JSON structure:
{
  "claimedSkills": ["skill1", "skill2"],
  "claimedLanguages": ["JavaScript", "Python"],
  "claimedFrameworks": ["React", "Node.js"],
  "claimedTools": ["Docker", "AWS"],
  "experienceYears": 3,
  "jobTitles": ["Frontend Developer"],
  "educationLevel": "Bachelor's"
}

Resume text:
${resumeText.slice(0, 8000)}`
      }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return {
      claimedSkills: [],
      claimedLanguages: [],
      claimedFrameworks: [],
      claimedTools: [],
      experienceYears: null,
      jobTitles: [],
      educationLevel: null
    };
  }
}

async function analyzeGap(resumeData, githubData, jobDescription, openaiKey) {
  const client = new OpenAI({ apiKey: openaiKey });

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 2000,
    messages: [
      {
        role: 'system',
        content:
          'You are a senior technical recruiter. Analyze the gap between resume claims and GitHub evidence. Return ONLY valid JSON, no markdown.'
      },
      {
        role: 'user',
        content: `Compare resume claims vs GitHub evidence and return this exact JSON:
{
  "honestyScore": 78,
  "jobFitScore": 65,
  "verified": [{"skill": "JavaScript", "evidence": "Used in 8 repos"}],
  "exaggerated": [{"skill": "React", "issue": "No React repos found", "suggestion": "Build a React project"}],
  "missing": [{"skill": "TypeScript", "why": "Popular in modern JS roles"}],
  "jobGaps": [{"requirement": "5 years React", "status": "missing", "notes": "No React evidence"}],
  "summary": "2-3 sentence assessment",
  "topRecommendation": "Most important fix"
}

RESUME CLAIMS:
${JSON.stringify(resumeData, null, 2)}

GITHUB EVIDENCE:
Languages: ${JSON.stringify(githubData.languages)}
Topics: ${JSON.stringify(githubData.topics)}
Repos: ${JSON.stringify(githubData.repoNames)}
Descriptions: ${JSON.stringify(githubData.repoDescriptions.slice(0, 10))}
Total repos: ${githubData.totalRepos}

JOB DESCRIPTION:
${jobDescription ? jobDescription.slice(0, 3000) : 'Not provided — skip jobGaps and set jobFitScore to 0'}`
      }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fallbackAnalysis(resumeData, githubData, jobDescription) {
  const ghLangs = Object.keys(githubData.languages).map((l) => l.toLowerCase());
  const ghTopics = githubData.topics.map((t) => t.toLowerCase());
  const ghRepos = githubData.repoNames.map((r) => r.toLowerCase());

  const allClaimed = [
    ...(resumeData.claimedSkills || []),
    ...(resumeData.claimedLanguages || []),
    ...(resumeData.claimedFrameworks || []),
    ...(resumeData.claimedTools || [])
  ];

  const verified = [];
  const exaggerated = [];

  for (const skill of allClaimed) {
    const s = skill.toLowerCase().replace(/[^a-z0-9]/g, '');
    const found =
      ghLangs.some((l) => l.replace(/[^a-z0-9]/g, '').includes(s) || s.includes(l.replace(/[^a-z0-9]/g, ''))) ||
      ghTopics.some((t) => t.includes(s) || s.includes(t)) ||
      ghRepos.some((r) => r.includes(s));

    if (found) {
      const lang = Object.keys(githubData.languages).find(
        (l) => l.toLowerCase().replace(/[^a-z0-9]/g, '').includes(s)
      );
      const count = lang ? githubData.languages[lang] : '';
      verified.push({
        skill,
        evidence: lang ? `Found as primary language in ${count} repo${count > 1 ? 's' : ''}` : 'Found in repo names or topics'
      });
    } else {
      exaggerated.push({
        skill,
        issue: `No public GitHub evidence found for ${skill}`,
        suggestion: `Create a public project using ${skill} to back this claim`
      });
    }
  }

  const honestyScore =
    allClaimed.length > 0 ? Math.min(100, Math.round((verified.length / allClaimed.length) * 100)) : 50;

  return {
    honestyScore,
    jobFitScore: 0,
    verified,
    exaggerated,
    missing: [],
    jobGaps: [],
    summary: `${verified.length} of ${allClaimed.length} claimed skills have visible GitHub evidence. ${exaggerated.length} claim${exaggerated.length !== 1 ? 's' : ''} could not be verified from public repos.`,
    topRecommendation:
      exaggerated.length > 0
        ? `Build and publish a project using ${exaggerated[0].skill} to back up that resume claim`
        : 'Your resume claims are well-supported by your GitHub activity — focus on documentation and tests.'
  };
}

router.post('/analyze', async (req, res) => {
  try {
    const { resumeText, githubUsername, jobDescription } = req.body || {};

    if (!resumeText || !resumeText.trim()) {
      return res.status(400).json({ error: 'Resume text is required' });
    }
    if (!githubUsername || !githubUsername.trim()) {
      return res.status(400).json({ error: 'GitHub username is required' });
    }

    const openaiKey = process.env.OPENAI_API_KEY;

    let githubData;
    try {
      githubData = await getGithubData(githubUsername.trim());
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    let resumeData;
    if (openaiKey) {
      try {
        resumeData = await extractSkillsFromText(resumeText, openaiKey);
      } catch (e) {
        console.error('Skill extraction error:', e.message);
        resumeData = {
          claimedSkills: [],
          claimedLanguages: [],
          claimedFrameworks: [],
          claimedTools: [],
          experienceYears: null,
          jobTitles: [],
          educationLevel: null
        };
      }
    } else {
      // Basic keyword extraction without OpenAI
      const knownSkills = [
        'javascript','typescript','python','java','c++','c#','php','ruby','go','rust','swift','kotlin',
        'react','vue','angular','svelte','next.js','nuxt','express','fastapi','django','flask','spring',
        'node.js','nodejs','mongodb','postgresql','mysql','redis','docker','kubernetes','aws','azure','gcp',
        'git','graphql','rest','sql','html','css','tailwind','sass','webpack','vite','jest','cypress'
      ];
      const text = resumeText.toLowerCase();
      const found = knownSkills.filter((s) => text.includes(s));
      resumeData = {
        claimedSkills: found,
        claimedLanguages: [],
        claimedFrameworks: [],
        claimedTools: [],
        experienceYears: null,
        jobTitles: [],
        educationLevel: null
      };
    }

    let analysis;
    if (openaiKey) {
      try {
        analysis = await analyzeGap(resumeData, githubData, jobDescription, openaiKey);
        if (!analysis) throw new Error('No analysis returned');
      } catch (e) {
        console.error('Gap analysis error:', e.message);
        analysis = fallbackAnalysis(resumeData, githubData, jobDescription);
      }
    } else {
      analysis = fallbackAnalysis(resumeData, githubData, jobDescription);
    }

    return res.json({
      githubUsername: githubUsername.trim(),
      githubData,
      resumeData,
      analysis,
      hasOpenAI: !!openaiKey
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
});

module.exports = router;
