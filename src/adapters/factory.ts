/**
 * Picks the right GitHub adapter based on configuration:
 *   - StackOneAdapter when STACKONE_API_KEY is set,
 *   - GitHubDirectAdapter otherwise.
 *
 * Returning a single object keeps every tool in `src/tools/github/` agnostic
 * to where the data actually comes from.
 */

import type { AppConfig } from '../config';
import type { GitHubAuth } from '../auth/github';
import { log } from '../lib/logger';
import { GitHubDirectAdapter } from './githubDirect';
import { StackOneAdapter } from './stackone';
import type { GitHubAdapter } from './types';

export function createGitHubAdapter(config: AppConfig, auth: GitHubAuth): GitHubAdapter {
  const direct = new GitHubDirectAdapter(config.github, auth);

  if (config.stackone.apiKey) {
    log.info('using StackOne adapter (GitHub-direct fallback enabled)');
    return new StackOneAdapter(config.stackone, direct);
  }

  log.info('using GitHub-direct adapter (no STACKONE_API_KEY configured)');
  return direct;
}
