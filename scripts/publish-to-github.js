const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../src/db');

const ghExe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'gh', 'bin', 'gh.exe');
const gitDir = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'MinGit', 'cmd');
const env = {
  ...process.env,
  PATH: `${gitDir};${path.dirname(ghExe)};${process.env.PATH || ''}`,
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
    ...opts,
  }).trim();
}

function main() {
  const repoName = process.argv[2] || 'crema-espresso';

  // 1. Get authenticated GitHub username
  const owner = run(ghExe, ['api', 'user', '--jq', '.login']);
  console.log(`Angemeldet als GitHub-Nutzer: ${owner}`);

  // 2. Check or create repository
  let repoExists = false;
  try {
    run(ghExe, ['repo', 'view', `${owner}/${repoName}`]);
    repoExists = true;
  } catch {
    repoExists = false;
  }

  if (!repoExists) {
    console.log(`Erstelle öffentliches Repository ${owner}/${repoName}...`);
    run(ghExe, [
      'repo',
      'create',
      repoName,
      '--public',
      '--description',
      'Crema – Mobile Espresso-Tracking & Gemini 3.8 Flash KI-Barista Web-App',
    ]);
  }

  // 3. Configure git credential helper via gh & push main
  run(ghExe, ['auth', 'setup-git']);
  const remoteUrl = `https://github.com/${owner}/${repoName}.git`;
  try {
    run('git', ['remote', 'remove', 'origin']);
  } catch {
    // ignore if no origin yet
  }
  run('git', ['remote', 'add', 'origin', remoteUrl]);
  run('git', ['branch', '-M', 'main']);
  console.log('Pushe Code nach GitHub (main)...');
  run('git', ['push', '-u', 'origin', 'main', '--force']);

  // 4. Enable GitHub Pages (GitHub Actions workflow mode)
  try {
    run(ghExe, [
      'api',
      `repos/${owner}/${repoName}/pages`,
      '-X',
      'POST',
      '-f',
      'build_type=workflow',
    ]);
    console.log('GitHub Pages (Workflow) aktiviert.');
  } catch {
    try {
      run(ghExe, [
        'api',
        `repos/${owner}/${repoName}/pages`,
        '-X',
        'PUT',
        '-f',
        'build_type=workflow',
      ]);
      console.log('GitHub Pages Konfiguration aktualisiert.');
    } catch (e) {
      console.log('Hinweis zu Pages:', e.message);
    }
  }

  // Trigger Pages workflow explicitly in case repository creation raced initial push
  try {
    run(ghExe, ['workflow', 'run', 'deploy-pages.yml', '--repo', `${owner}/${repoName}`]);
  } catch {
    // already triggered by push
  }

  const pagesUrl = `https://${owner.toLowerCase()}.github.io/${repoName}`;
  const repo = createDatabase();
  repo.setSetting('github_pages_url', pagesUrl);

  console.log(`FERTIG! Repository: https://github.com/${owner}/${repoName}`);
  console.log(`24/7 Live Web-App URL: ${pagesUrl}`);
}

main();
