#!/usr/bin/env node
// Propose MissionGo comments for a verified HitGO release. Never writes to MissionGo.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function fail(message) { throw new Error(message); }
function command(bin, args) { return execFileSync(bin, args, { encoding: 'utf8' }).trim(); }
function ancestor(older, newer) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer]);
  if (result.status === null || result.status > 1) fail('git merge-base failed');
  return result.status === 0;
}
function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) fail(`missing ${name}`);
  return process.argv[index + 1];
}
function artifactPath(path) {
  return /^(frontend\/|backend\/|samples\/|Dockerfile(?:\.separator)?$|docker-compose\.yml$)/.test(path);
}

try {
  const receipt = JSON.parse(readFileSync(option('--receipt'), 'utf8'));
  const response = JSON.parse(readFileSync(option('--candidates'), 'utf8'));
  if (!Array.isArray(response) && response.nextBeforeSequence != null) {
    fail('candidate pages are incomplete; follow nextBeforeSequence before matching');
  }
  const candidates = Array.isArray(response) ? response : response.items ?? response.candidates;
  if (!Array.isArray(candidates)) fail('candidates must be an array or contain items/candidates');
  if (receipt.schemaVersion !== 1 || receipt.product !== 'HitGO' || receipt.artifact !== 'webServer'
      || receipt.verified !== true || receipt.eligibleForMatching !== true) {
    fail('receipt is not a verified, matchable HitGO Web/Server release');
  }
  const oldCommit = receipt.previousSourceCommit;
  const newCommit = receipt.sourceCommit;
  if (![oldCommit, newCommit].every(value => /^[0-9a-f]{40}$/.test(value)) || !ancestor(oldCommit, newCommit)) {
    fail('receipt source range is invalid');
  }
  const repo = command('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const proposals = [];
  const skipped = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const key = candidate.key ?? candidate.itemKey;
    const pullRequestUrl = candidate.pullRequestUrl ?? candidate.prUrl;
    if (typeof key !== 'string' || !/^HIG-\d+$/.test(key) || typeof pullRequestUrl !== 'string') {
      fail('candidate lacks a valid HitGO key or pullRequestUrl');
    }
    if (seen.has(key)) fail(`duplicate candidate ${key}`);
    seen.add(key);
    const url = new URL(pullRequestUrl);
    const prPrefix = `/${repo}/pull/`;
    if (url.protocol !== 'https:' || url.hostname !== 'github.com'
        || !url.pathname.startsWith(prPrefix) || !/^\d+$/.test(url.pathname.slice(prPrefix.length))) {
      skipped.push({ key, reason: 'PR is outside the current repository' });
      continue;
    }
    const pr = JSON.parse(command('gh', ['pr', 'view', pullRequestUrl, '--json', 'state,mergedAt,mergeCommit,files,changedFiles,baseRefName,url']));
    const merge = pr.mergeCommit?.oid;
    if (pr.state !== 'MERGED' || !pr.mergedAt || pr.baseRefName !== 'main' || pr.url !== pullRequestUrl
        || !/^[0-9a-f]{40}$/.test(merge ?? '') || !ancestor(oldCommit, merge) || !ancestor(merge, newCommit)
        || oldCommit === merge) {
      skipped.push({ key, reason: 'merged PR is outside the published source range' });
      continue;
    }
    if (!Array.isArray(pr.files) || pr.files.length !== pr.changedFiles) {
      skipped.push({ key, reason: 'PR file list is incomplete' });
      continue;
    }
    if (!pr.files.some(file => artifactPath(file.path))) {
      skipped.push({ key, reason: 'PR did not change the Web/Server artifact' });
      continue;
    }
    const idempotencyKey = createHash('sha256').update(`HitGO:webServer:${newCommit}:${key}`).digest('hex');
    proposals.push({
      key,
      pullRequestUrl,
      artifact: 'webServer',
      version: receipt.version,
      sourceCommit: newCommit,
      summary: `${key} 已随 HitGO ${receipt.version} 的 Web/Server 发布，请在该版本验证`,
      text: `HitGO Web/Server 已正式发布 ${receipt.version}（线上来源提交 ${newCommit}），关联 PR：${pullRequestUrl}。请在该版本验证此条目；本通知不代表验收通过。`,
      idempotencyKey,
    });
  }
  console.log(JSON.stringify({ proposals, skipped }, null, 2));
} catch (error) {
  console.error(`release notice matching failed: ${error.message}`);
  process.exitCode = 1;
}
