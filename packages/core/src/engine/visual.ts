import fs from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ensureDir, pathExists } from '../storage/fs-utils.js';

export interface VisualCompareOptions {
  screenshot: Buffer;
  /** Approved image this screenshot is judged against. */
  baselinePath: string;
  /** Where `actual` and `diff` images are written when the check fails. */
  outputDir: string;
  name: string;
  /** Allowed fraction of differing pixels before the check fails. */
  threshold: number;
  /** Per-pixel colour sensitivity handed to pixelmatch. */
  pixelThreshold: number;
  updateBaseline: boolean;
}

export interface VisualCompareResult {
  status: 'passed' | 'failed' | 'baseline-created';
  diffPixels: number;
  diffRatio: number;
  baselinePath: string;
  actualPath?: string;
  diffPath?: string;
  message?: string;
}

/**
 * Compares a screenshot with its approved baseline.
 *
 * The first run for a given name writes the baseline and passes — there is
 * nothing to compare against yet. Later runs fail when too many pixels differ,
 * and write both the actual image and a highlighted diff into the run folder so
 * the report can show them side by side.
 */
export async function compareScreenshot(options: VisualCompareOptions): Promise<VisualCompareResult> {
  const { screenshot, baselinePath, outputDir, name, threshold, pixelThreshold, updateBaseline } = options;

  const baselineExists = await pathExists(baselinePath);

  if (!baselineExists || updateBaseline) {
    await ensureDir(path.dirname(baselinePath));
    await fs.writeFile(baselinePath, screenshot);

    return {
      status: 'baseline-created',
      diffPixels: 0,
      diffRatio: 0,
      baselinePath,
      message: baselineExists
        ? `Baseline "${name}" was updated.`
        : `Baseline "${name}" did not exist yet and has been created from this run.`,
    };
  }

  const baseline = PNG.sync.read(await fs.readFile(baselinePath));
  const actual = PNG.sync.read(screenshot);

  await ensureDir(outputDir);
  const actualPath = path.join(outputDir, `${name}.actual.png`);
  await fs.writeFile(actualPath, screenshot);

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      status: 'failed',
      diffPixels: baseline.width * baseline.height,
      diffRatio: 1,
      baselinePath,
      actualPath,
      message: `Screenshot size changed: baseline is ${baseline.width}×${baseline.height}, this run produced ${actual.width}×${actual.height}.`,
    };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold: pixelThreshold },
  );

  const totalPixels = baseline.width * baseline.height;
  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;

  if (diffRatio <= threshold) {
    // Clean run — no need to keep the actual image around.
    await fs.rm(actualPath, { force: true });

    return { status: 'passed', diffPixels, diffRatio, baselinePath };
  }

  const diffPath = path.join(outputDir, `${name}.diff.png`);
  await fs.writeFile(diffPath, PNG.sync.write(diff));

  return {
    status: 'failed',
    diffPixels,
    diffRatio,
    baselinePath,
    actualPath,
    diffPath,
    message: `${diffPixels} pixels differ (${(diffRatio * 100).toFixed(2)}%), above the allowed ${(threshold * 100).toFixed(2)}%.`,
  };
}
