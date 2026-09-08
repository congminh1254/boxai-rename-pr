#!/usr/bin/env node

/**
 * Generate or update a PR title using Box AI.
 *
 * Usage:
 *   node rename-pr.js <owner/repo> <pr-number> [--apply] [--dry-run]
 *   node rename-pr.js <owner/repo> <pr-number> --apply --remove-label boxai-rename
 *
 * Environment:
 *   BOX_JWT_CONFIG_JSON  — Box JWT config as a JSON string (for CI)
 *   BOX_JWT_CONFIG_PATH  — path to Box JWT config JSON file (for local use)
 *   BOX_FOLDER_ID        — Box folder for temp files (default: 0 = root)
 *   GH_TOKEN             — GitHub token (set automatically in Actions)
 */

const { BoxClient } = require('box-node-sdk/lib/client');
const { BoxJwtAuth, JwtConfig } = require('box-node-sdk/lib/box/jwtAuth');
const { stringToByteStream } = require('box-node-sdk/lib/internal/utils');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const UPLOAD_FOLDER_ID = process.env.BOX_FOLDER_ID || '0';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));

  if (positional.length < 2 || flags.has('--help') || flags.has('-h')) {
    console.log(`
Usage: rename-pr <owner/repo> <pr-number> [options]

Options:
  --apply                Update the PR title on GitHub
  --dry-run              Show context that would be sent to Box AI (no API calls)
  --remove-label <name>  Remove a label from the PR after applying
  --help                 Show this help

Examples:
  rename-pr box/box-node-sdk 1609
  rename-pr box/box-node-sdk 1609 --apply
  rename-pr box/box-node-sdk 1609 --apply --remove-label boxai-rename
`);
    process.exit(0);
  }

  const removeLabelIdx = args.indexOf('--remove-label');
  const removeLabel = removeLabelIdx !== -1 ? args[removeLabelIdx + 1] : null;

  return {
    repo: positional[0],
    prNumber: parseInt(positional[1], 10),
    apply: flags.has('--apply'),
    dryRun: flags.has('--dry-run'),
    removeLabel,
  };
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------
function gh(args) {
  return execSync(`gh ${args}`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function fetchPrData(repo, prNumber) {
  const json = gh(
    `pr view ${prNumber} --repo ${repo} --json title,number,baseRefName,headRefName,body,commits,files`
  );
  return JSON.parse(json);
}

function fetchPrDiff(repo, prNumber) {
  try {
    return gh(`pr diff ${prNumber} --repo ${repo}`);
  } catch {
    return null;
  }
}

function updatePrTitle(repo, prNumber, newTitle) {
  gh(
    `pr edit ${prNumber} --repo ${repo} --title "${newTitle.replace(/"/g, '\\"')}"`
  );
}

function removeLabel(repo, prNumber, label) {
  try {
    gh(
      `api repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)} -X DELETE`
    );
  } catch {
    // Label may already have been removed
  }
}

// ---------------------------------------------------------------------------
// Build context document
// ---------------------------------------------------------------------------
function buildPrContext(prData, diff) {
  const commits = prData.commits
    .map((c) => `  - ${c.messageHeadline}`)
    .join('\n');

  const files = prData.files
    .map((f) => `  ${f.path} (+${f.additions} -${f.deletions})`)
    .join('\n');

  const sections = [
    '=== PULL REQUEST CONTEXT ===',
    '',
    `PR #${prData.number} — ${prData.baseRefName} <- ${prData.headRefName}`,
    '',
    '--- Commits ---',
    commits,
    '',
    '--- Files Changed ---',
    files,
  ];

  if (prData.body) {
    const bodyTruncated =
      prData.body.length > 2000
        ? prData.body.substring(0, 2000) + '\n... [truncated]'
        : prData.body;
    sections.push('', '--- PR Description ---', bodyTruncated);
  }

  if (diff) {
    const diffTruncated =
      diff.length > 6000
        ? diff.substring(0, 6000) + '\n... [truncated]'
        : diff;
    sections.push('', '--- Code Diff ---', diffTruncated);
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Scope detection
// ---------------------------------------------------------------------------
function detectScope(prData) {
  const existingScope = prData.title.match(/^\w+\(([^)]+)\):/);
  if (existingScope) {
    return existingScope[1];
  }

  const branchScopeMap = {
    'combined-sdk': 'boxsdkgen',
  };

  return branchScopeMap[prData.baseRefName] || null;
}

function applyScope(title, scope) {
  if (!scope) return title;

  const withScope = title.replace(/^(\w+)\(([^)]*)\):/, `$1(${scope}):`);
  if (withScope !== title) return withScope;

  return title.replace(/^(\w+):/, `$1(${scope}):`);
}

// ---------------------------------------------------------------------------
// Box AI title generation
// ---------------------------------------------------------------------------
async function generateTitle(client, contextDoc, folderId) {
  const fileName = `pr-title-gen-${Date.now()}.txt`;

  const uploadResult = await client.uploads.uploadFile({
    attributes: {
      name: fileName,
      parent: { id: folderId },
    },
    file: stringToByteStream(contextDoc),
    fileFileName: fileName,
    fileContentType: 'text/plain',
  });

  const fileId = uploadResult.entries[0].id;

  try {
    const prompt = [
      'You are a senior software engineer writing a pull request title.',
      'Based on the PR context in the attached file (commits, files changed, diff), generate a concise PR title.',
      'Rules:',
      '- Under 72 characters',
      '- Use format: type: description (e.g. feat:, fix:, chore:, docs:, test:, refactor:, ci:)',
      '- Do NOT include a scope in parentheses — the scope will be added separately',
      '- Clearly describe WHAT changed',
      '- Be specific — name the component, API, or behavior that changed',
      '- Do NOT include issue/PR references like (box/box-codegen#123)',
      '',
      'Return ONLY the PR title, nothing else.',
    ].join('\n');

    const aiResponse = await client.ai.createAiTextGen({
      prompt,
      items: [{ id: fileId, type: 'file', content: contextDoc }],
    });

    return aiResponse.answer.trim();
  } finally {
    await client.files.deleteFileById(fileId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Box client initialization
// ---------------------------------------------------------------------------
function decodeConfigJson(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  return Buffer.from(trimmed, 'base64').toString('utf-8');
}

function createBoxClient() {
  let jwtConfig;
  if (process.env.BOX_JWT_CONFIG_JSON) {
    const configJson = decodeConfigJson(process.env.BOX_JWT_CONFIG_JSON);
    jwtConfig = JwtConfig.fromConfigJsonString(configJson);
  } else if (process.env.BOX_JWT_CONFIG_PATH) {
    jwtConfig = JwtConfig.fromConfigFile(process.env.BOX_JWT_CONFIG_PATH);
  } else {
    console.error(
      'Error: Set BOX_JWT_CONFIG_JSON (JSON string) or BOX_JWT_CONFIG_PATH (file path)'
    );
    process.exit(1);
  }

  const auth = new BoxJwtAuth({ config: jwtConfig });
  return new BoxClient({ auth });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const {
    repo,
    prNumber,
    apply,
    dryRun,
    removeLabel: labelToRemove,
  } = parseArgs();

  console.log(`Fetching PR #${prNumber} from ${repo}...`);
  const prData = fetchPrData(repo, prNumber);
  console.log(`  Title:   ${prData.title}`);
  console.log(`  Commits: ${prData.commits.length}`);
  console.log(`  Files:   ${prData.files.length}`);

  console.log('Fetching diff...');
  const diff = fetchPrDiff(repo, prNumber);
  if (!diff) {
    console.log(
      '  Diff too large or unavailable — using file list + commits only'
    );
  } else {
    console.log(`  Diff size: ${diff.length} chars`);
  }

  const contextDoc = buildPrContext(prData, diff);
  console.log(`Context document: ${contextDoc.length} chars`);

  if (dryRun) {
    console.log('\n--- DRY RUN: Context that would be sent to Box AI ---');
    console.log(contextDoc);
    console.log('--- END DRY RUN ---\n');
    return;
  }

  const scope = detectScope(prData);
  if (scope) {
    console.log(`Detected scope: (${scope}) [from ${prData.baseRefName} branch]`);
  }

  console.log('\nInitializing Box AI...');
  const client = createBoxClient();

  const user = await client.users.getUserMe();
  console.log(`  Authenticated as: ${user.name}`);

  console.log('Generating title with Box AI...');
  const rawTitle = await generateTitle(client, contextDoc, UPLOAD_FOLDER_ID);
  const generatedTitle = applyScope(rawTitle, scope);

  console.log();
  console.log('='.repeat(70));
  console.log(`  Current title:   ${prData.title}`);
  if (scope) {
    console.log(`  AI raw title:    ${rawTitle}`);
  }
  console.log(`  Suggested title: ${generatedTitle}`);
  console.log('='.repeat(70));

  if (apply) {
    console.log('\nUpdating PR title...');
    updatePrTitle(repo, prNumber, generatedTitle);
    console.log(`PR #${prNumber} title updated.`);

    if (labelToRemove) {
      console.log(`Removing label "${labelToRemove}"...`);
      removeLabel(repo, prNumber, labelToRemove);
      console.log('Label removed.');
    }
  } else {
    console.log(
      `\nTo apply: node rename-pr.js ${repo} ${prNumber} --apply`
    );
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
