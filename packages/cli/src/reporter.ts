import pc from 'picocolors';
import type { Run, RunEvent, StepResult } from '@flowcase/core';

export interface ReporterOptions {
  /** Print every step as it runs, rather than only failures. */
  verbose: boolean;
}

/**
 * Console reporter for `flowcase run`.
 *
 * Reads like a test runner should: a line per test, indented steps, and failure
 * detail that names the step and the selectors that were tried.
 */
export class ConsoleReporter {
  constructor(private readonly options: ReporterOptions) {}

  handle(event: RunEvent): void {
    switch (event.type) {
      case 'test:start':
        process.stdout.write(`\n${pc.bold(event.testName)} ${pc.dim(`(${event.index + 1}/${event.total})`)}\n`);
        break;

      case 'step:end':
        if (this.options.verbose || event.step.status === 'failed' || event.step.status === 'soft-failed') {
          process.stdout.write(this.formatStep(event.step));
        }
        break;

      case 'test:end': {
        const { result } = event;

        if (result.status === 'skipped') {
          process.stdout.write(`  ${pc.yellow('skipped')} ${pc.dim(result.skipReason ?? '')}\n`);
        }
        break;
      }

      default:
        break;
    }
  }

  private formatStep(step: StepResult): string {
    const indent = '  '.repeat(step.depth + 1);
    const icon = STEP_ICON[step.status] ?? pc.dim('·');
    const duration = step.durationMs > 0 ? pc.dim(` ${step.durationMs}ms`) : '';
    const iteration = step.iteration === undefined ? '' : pc.dim(` #${step.iteration + 1}`);

    let line = `${indent}${icon} ${step.label}${iteration}${duration}\n`;

    if (step.healed) {
      line += `${indent}  ${pc.magenta('healed:')} ${pc.dim(`${step.healed.from} → ${step.healed.to}`)}\n`;
    }

    if (step.error) {
      const detail = step.error.message
        .split('\n')
        .map((part) => `${indent}    ${pc.red(part)}`)
        .join('\n');
      line += `${detail}\n`;
    }

    return line;
  }

  /** Final summary. Returns the process exit code. */
  summary(run: Run): number {
    const passed = run.results.filter((result) => result.status === 'passed').length;
    const failed = run.results.filter((result) => result.status === 'failed').length;
    const skipped = run.results.filter((result) => result.status === 'skipped').length;

    process.stdout.write(`\n${'─'.repeat(52)}\n`);

    const parts = [
      passed > 0 ? pc.green(`${passed} passed`) : '',
      failed > 0 ? pc.red(`${failed} failed`) : '',
      skipped > 0 ? pc.yellow(`${skipped} skipped`) : '',
    ].filter(Boolean);

    process.stdout.write(`${parts.join(pc.dim(' · ')) || pc.dim('nothing ran')}  ${pc.dim(`in ${(run.durationMs / 1000).toFixed(1)}s`)}\n`);

    if (run.error) {
      process.stdout.write(`${pc.red(run.error)}\n`);
    }

    const failures = run.results.filter((result) => result.status === 'failed');

    if (failures.length > 0) {
      process.stdout.write(`\n${pc.bold('Failures')}\n`);

      for (const result of failures) {
        process.stdout.write(`\n  ${pc.red('✗')} ${pc.bold(result.testName)}\n`);

        const failedStep = result.steps.find((step) => step.status === 'failed');

        if (failedStep?.error) {
          process.stdout.write(`    at step ${failedStep.index + 1}: ${failedStep.label}\n`);
          process.stdout.write(
            `${failedStep.error.message
              .split('\n')
              .map((line) => `    ${pc.dim(line)}`)
              .join('\n')}\n`,
          );
        }

        for (const soft of result.softFailures) {
          process.stdout.write(`    ${pc.yellow('!')} ${soft.label} — ${pc.dim(soft.message)}\n`);
        }

        if (result.artifacts.length > 0) {
          process.stdout.write(
            `    ${pc.dim(`artifacts: ${result.artifacts.map((artifact) => artifact.kind).join(', ')}`)}\n`,
          );
        }
      }
    }

    if (Object.keys(run.variables).length > 0 && this.options.verbose) {
      process.stdout.write(`\n${pc.dim('captured:')} ${JSON.stringify(run.variables)}\n`);
    }

    return failed > 0 || run.status === 'aborted' ? 1 : 0;
  }
}

const STEP_ICON: Record<string, string> = {
  passed: pc.green('✓'),
  failed: pc.red('✗'),
  'soft-failed': pc.yellow('!'),
  healed: pc.magenta('⤳'),
  skipped: pc.dim('·'),
  running: pc.blue('◐'),
};
