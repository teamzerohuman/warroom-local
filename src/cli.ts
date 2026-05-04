#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runDoctor } from './commands/doctor.js';
import { runMapsStudy } from './commands/maps-study.js';

type Output = (text: string) => void;

function printJson(output: Output, value: unknown) {
  output(JSON.stringify(value, null, 2));
}

function printNotImplemented(output: Output, command: string, issue: string) {
  output(`${command} is not implemented in phase 1. Track it in ${issue}.`);
}

export function buildProgram(options: { cwd?: string; output?: Output } = {}) {
  const workspaceRoot = options.cwd ?? process.cwd();
  const output = options.output ?? console.log;
  const program = new Command();

  program
    .name('warroom')
    .description('TeamFloPay local command center and cross-repo orchestration workspace.')
    .version('0.1.0');

  program
    .command('doctor')
    .description('Validate the phase-1 War Room skeleton.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const result = runDoctor(workspaceRoot);
      if (opts.json) {
        printJson(output, result);
        return;
      }

      output(`War Room doctor: ${result.ok ? 'ok' : 'needs attention'}`);
      output(`Repos mapped: ${result.repoCount} (${result.activeRepoCount} active, ${result.plannedRepoCount} planned)`);
      for (const file of result.files) {
        output(`${file.exists ? 'ok' : 'missing'} ${file.file}`);
      }
    });

  const maps = program.command('maps').description('Inspect and maintain the repo map.');

  maps
    .command('study')
    .description('Show local repo map health and specialist assignments.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const repos = runMapsStudy(workspaceRoot);
      if (opts.json) {
        printJson(output, repos);
        return;
      }

      for (const repo of repos) {
        const checkoutState = repo.checkedOut ? 'checked out' : repo.status === 'planned' ? 'planned' : 'missing';
        output(`${repo.github} [${repo.status}, ${checkoutState}] -> ${repo.local_path} (${repo.specialist.name})`);
      }
    });

  maps
    .command('assign')
    .description('Stub for interactive repo specialist/resource assignment.')
    .action(() => printNotImplemented(output, 'warroom maps assign', 'TeamFloPay/infra#4'));

  program
    .command('bootstrap')
    .description('Stub for cloning missing child repos and checking required tools.')
    .action(() => printNotImplemented(output, 'warroom bootstrap', 'TeamFloPay/infra#4'));

  program
    .command('sync')
    .description('Stub for fetching/pulling clean child repos.')
    .action(() => printNotImplemented(output, 'warroom sync', 'TeamFloPay/infra#4'));

  const issue = program.command('issue').description('Issue workflow commands.');
  issue.command('triage').description('Stub for issue triage handoffs.').action(() => printNotImplemented(output, 'warroom issue triage', 'TeamFloPay/infra#4'));
  issue.command('next').description('Stub for listing ready implementation issues.').action(() => printNotImplemented(output, 'warroom issue next', 'TeamFloPay/infra#4'));

  const pr = program.command('pr').description('Pull request workflow commands.');
  pr.command('engage').description('Stub for PR engagement preflight.').action(() => printNotImplemented(output, 'warroom pr engage', 'TeamFloPay/infra#4'));
  pr.command('review').description('Stub for PR review loops.').action(() => printNotImplemented(output, 'warroom pr review', 'TeamFloPay/infra#4'));
  pr.command('merge').description('Stub for PR merge cleanup.').action(() => printNotImplemented(output, 'warroom pr merge', 'TeamFloPay/infra#4'));

  const commit = program.command('commit').description('Commit workflow commands.');
  commit.command('create').description('Stub for shared commit creation.').action(() => printNotImplemented(output, 'warroom commit create', 'TeamFloPay/infra#4'));

  program
    .command('abort')
    .description('Stub for preservation-first abort/recovery workflow.')
    .action(() => printNotImplemented(output, 'warroom abort', 'TeamFloPay/infra#4'));

  const dev = program.command('dev').description('Local development orchestration commands.');
  dev
    .command('status')
    .description('Show phase-1 local dev-link readiness.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const repos = runMapsStudy(workspaceRoot);
      const sdk = repos.find((repo) => repo.id === 'sdk');
      const demo = repos.find((repo) => repo.id === 'demo');
      const result = {
        sdkCheckedOut: sdk?.checkedOut ?? false,
        demoCheckedOut: demo?.checkedOut ?? false,
        demoRepoStatus: demo?.status ?? 'unknown',
        devLinkImplemented: false,
        implementationIssue: 'TeamFloPay/infra#10',
      };

      if (opts.json) {
        printJson(output, result);
        return;
      }

      output(`SDK checkout: ${result.sdkCheckedOut ? 'present' : 'missing'}`);
      output(`Demo checkout: ${result.demoCheckedOut ? 'present' : result.demoRepoStatus}`);
      output(`SDK-to-demo dev link: not implemented yet (${result.implementationIssue})`);
    });

  dev.command('link').description('Stub for SDK-to-demo local linking.').action(() => printNotImplemented(output, 'warroom dev link', 'TeamFloPay/infra#10'));
  dev.command('unlink').description('Stub for restoring standalone demo dependency behavior.').action(() => printNotImplemented(output, 'warroom dev unlink', 'TeamFloPay/infra#10'));

  return program;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (path.resolve(currentFile) === invokedFile) {
  buildProgram().parse();
}
