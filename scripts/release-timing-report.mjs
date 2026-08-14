#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function payloadJobs(payload) {
  const pages = Array.isArray(payload) ? payload : [payload];
  return pages.flatMap((page) => Array.isArray(page?.jobs) ? page.jobs : []);
}

function elapsedSeconds(startedAt, completedAt) {
  const start = Date.parse(startedAt || '');
  const end = Date.parse(completedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function timingRows(payload) {
  return payloadJobs(payload).flatMap((job) => (job.steps || []).flatMap((step) => {
    const seconds = elapsedSeconds(step.started_at, step.completed_at);
    if (seconds === null) return [];
    return [{
      key: `${job.name} / ${step.name}`,
      job: job.name,
      step: step.name,
      seconds,
    }];
  }));
}

function workflowSeconds(payload) {
  const jobs = payloadJobs(payload);
  const starts = jobs.map((job) => Date.parse(job.started_at || '')).filter(Number.isFinite);
  const ends = jobs.map((job) => Date.parse(job.completed_at || '')).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return null;
  return Math.round((Math.max(...ends) - Math.min(...starts)) / 1000);
}

function percentChange(current, baseline) {
  if (!(baseline > 0)) return null;
  return Math.round(((current - baseline) / baseline) * 100);
}

export function buildReleaseTimingReport(currentPayload, baselinePayload = []) {
  const currentRows = timingRows(currentPayload);
  const baselineRows = timingRows(baselinePayload);
  const baselineByKey = new Map(baselineRows.map((row) => [row.key, row]));
  const regressions = currentRows.flatMap((row) => {
    const baseline = baselineByKey.get(row.key);
    if (!baseline) return [];
    const percent = percentChange(row.seconds, baseline.seconds);
    if (percent === null || percent <= 10 || row.seconds - baseline.seconds < 15) return [];
    return [{ ...row, baselineSeconds: baseline.seconds, percent }];
  }).sort((a, b) => b.percent - a.percent || b.seconds - a.seconds);

  const currentWorkflowSeconds = workflowSeconds(currentPayload);
  const baselineWorkflowSeconds = workflowSeconds(baselinePayload);
  const workflowPercent = currentWorkflowSeconds !== null && baselineWorkflowSeconds !== null
    ? percentChange(currentWorkflowSeconds, baselineWorkflowSeconds)
    : null;
  const slowest = [...currentRows].sort((a, b) => b.seconds - a.seconds).slice(0, 15);
  const markdown = [
    '## Release timing',
    '',
    `- Current workflow span: ${currentWorkflowSeconds ?? 'n/a'}s`,
    `- Previous successful span: ${baselineWorkflowSeconds ?? 'n/a'}s`,
    `- Material step regressions (>10% and ≥15s): ${regressions.length}`,
    '',
    '| Slowest step | Current | Previous | Change |',
    '| --- | ---: | ---: | ---: |',
    ...slowest.map((row) => {
      const baseline = baselineByKey.get(row.key);
      const change = baseline ? percentChange(row.seconds, baseline.seconds) : null;
      return `| ${row.key.replaceAll('|', '\\|')} | ${row.seconds}s | ${baseline ? `${baseline.seconds}s` : 'n/a'} | ${change === null ? 'n/a' : `${change > 0 ? '+' : ''}${change}%`} |`;
    }),
    '',
  ].join('\n');

  return {
    currentWorkflowSeconds,
    baselineWorkflowSeconds,
    workflowPercent,
    regressions,
    markdown,
  };
}

function commandValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const currentPath = process.argv[2];
  const baselinePath = process.argv[3];
  if (!currentPath) throw new Error('Usage: release-timing-report.mjs <current-jobs.json> [baseline-jobs.json]');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) : [];
  const report = buildReleaseTimingReport(current, baseline);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report.markdown}\n`);
  }
  if (report.workflowPercent > 10
      && report.currentWorkflowSeconds - report.baselineWorkflowSeconds >= 30) {
    console.log(`::warning title=Release duration regression::Workflow span increased ${report.workflowPercent}% to ${report.currentWorkflowSeconds}s`);
  }
  for (const row of report.regressions) {
    console.log(`::warning title=Release step regression::${commandValue(row.key)} increased ${row.percent}% (${row.baselineSeconds}s to ${row.seconds}s)`);
  }
  console.log(`Release timing recorded: ${report.currentWorkflowSeconds ?? 'n/a'}s, ${report.regressions.length} material step regressions.`);
}
