import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the built single-page app. The flowcase server mounts this
 * directory statically, so the UI ships as plain files with no runtime build step.
 */
export const uiDistPath = path.join(here, 'dist');
