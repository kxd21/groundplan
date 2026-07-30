/**
 * Release-aware npm audit gate.
 *
 * Electron is declared as a development dependency but its runtime is shipped
 * inside every desktop package. A plain `npm audit --omit=dev` therefore misses
 * Electron advisories, while failing on every high finding in the full tree
 * currently blocks on electron-builder-only transitive debt. This gate treats
 * the dependency roles accurately:
 *
 *   - fail on high/critical production dependency findings;
 *   - fail on high/critical Electron runtime findings;
 *   - fail on critical findings anywhere in the build tree.
 */

import { spawnSync } from 'node:child_process';

type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

interface AuditReport {
  auditReportVersion?: number;
  error?: { code?: string; summary?: string; detail?: string };
  metadata?: {
    vulnerabilities?: Partial<Record<Severity | 'total', number>>;
  };
  vulnerabilities?: Record<
    string,
    {
      name?: string;
      severity?: Severity;
    }
  >;
}

function audit(omitDev: boolean): AuditReport {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [...(npmCli ? [npmCli] : []), 'audit', ...(omitDev ? ['--omit=dev'] : []), '--json'];
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

  if (result.error) throw result.error;
  let report: AuditReport;
  try {
    report = JSON.parse(result.stdout) as AuditReport;
  } catch {
    throw new Error(`npm audit did not return JSON${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  if (report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities) {
    throw new Error(
      report.error?.summary ??
        report.error?.detail ??
        `npm audit returned an unsupported report (exit ${String(result.status)})`,
    );
  }
  return report;
}

function count(report: AuditReport, severity: Severity): number {
  return report.metadata?.vulnerabilities?.[severity] ?? 0;
}

function atLeastHigh(severity: Severity | undefined): boolean {
  return severity === 'high' || severity === 'critical';
}

function main(): void {
  const production = audit(true);
  const full = audit(false);
  const violations: string[] = [];
  const productionHigh = count(production, 'high');
  const productionCritical = count(production, 'critical');
  const fullHigh = count(full, 'high');
  const fullCritical = count(full, 'critical');
  const electron = full.vulnerabilities?.electron;

  if (productionHigh || productionCritical) {
    violations.push(
      `production dependencies contain ${productionHigh} high and ${productionCritical} critical findings`,
    );
  }
  if (atLeastHigh(electron?.severity)) {
    violations.push(`packaged Electron runtime has a ${electron?.severity} finding`);
  }
  if (fullCritical) {
    violations.push(`complete dependency tree contains ${fullCritical} critical findings`);
  }

  console.log(`production dependencies: ${productionHigh} high, ${productionCritical} critical`);
  console.log(`packaged Electron runtime: ${electron ? electron.severity : 'clear'}`);
  console.log(`complete dependency tree: ${fullHigh} high, ${fullCritical} critical`);

  if (violations.length) {
    for (const violation of violations) console.error(`  FAIL  ${violation}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
