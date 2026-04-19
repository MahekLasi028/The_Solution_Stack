/**
 * Normalize user input into a GitHub login (username or org name).
 * Handles pasted profile URLs, @handles, invisible chars, and .git suffix.
 */
function normalizeGithubUsername(raw) {
  if (raw == null || typeof raw !== 'string') {
    return '';
  }
  let s = raw.trim();
  s = s.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
  s = s.replace(/^@+/, '');
  const fromUrl = s.match(/github\.com\/([^/?#]+)/i);
  if (fromUrl) {
    s = fromUrl[1];
  }
  s = s.replace(/\.git$/i, '');
  return s.trim();
}

/**
 * GitHub login rules (public names): alphanumeric + single hyphens, no leading/trailing hyphen,
 * max 39 characters. See https://github.com/join (username field rules).
 */
function isValidGithubLogin(login) {
  if (!login || login.length < 1 || login.length > 39) {
    return false;
  }
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(login);
}

module.exports = { normalizeGithubUsername, isValidGithubLogin };
