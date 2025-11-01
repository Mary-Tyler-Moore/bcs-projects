// lib/github-writer.js
import { Octokit } from '@octokit/rest';

function base64(s) {
  return Buffer.from(typeof s === 'string' ? s : JSON.stringify(s, null, 2), 'utf8').toString('base64');
}
function clean(p) {
  return p.replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function createGithubWriter() {
  const owner  = process.env.GITHUB_OWNER;
  const repo   = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const basedir = (process.env.CMS_GITHUB_BASEDIR || 'public/').replace(/^\//, '');

  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    throw new Error('[github-writer] Missing GITHUB_* envs');
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  async function put(path, content, message) {
    const repoPath = clean(basedir + path.replace(/^public\//, ''));
    let sha;
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path: repoPath, ref: branch });
      if (!Array.isArray(data) && data?.sha) sha = data.sha;
    } catch (e) {
      if (e?.status !== 404) throw e;
    }
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, branch,
      path: repoPath,
      message: message || `Update ${repoPath}`,
      content: base64(content),
      sha,
    });
  }

  return {
    async writeJson(path, obj, msg) { await put(path, JSON.stringify(obj, null, 2), msg); },
    async writeText(path, str, msg)  { await put(path, str, msg); },
  };
}
