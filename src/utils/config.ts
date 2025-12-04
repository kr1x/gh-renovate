/**
 * User configuration and history storage
 * Stores data in ~/.config/gh-renovate/
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'gh-renovate');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const MAX_RECENT_REPOS = 10;

interface Config {
  recentRepos: string[];
}

const DEFAULT_CONFIG: Config = {
  recentRepos: [],
};

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
  } catch {
    // Directory might already exist
  }
}

/**
 * Load config from disk
 */
async function loadConfig(): Promise<Config> {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Save config to disk
 */
async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get list of recently used repositories (most recent first)
 */
export async function getRecentRepos(): Promise<string[]> {
  const config = await loadConfig();
  return config.recentRepos;
}

/**
 * Add a repository to the recent list
 * Moves it to the top if already exists, trims to MAX_RECENT_REPOS
 */
export async function addRecentRepo(repoPath: string): Promise<void> {
  const config = await loadConfig();

  // Remove if already exists (will be re-added at top)
  config.recentRepos = config.recentRepos.filter((r) => r !== repoPath);

  // Add to top
  config.recentRepos.unshift(repoPath);

  // Trim to max
  config.recentRepos = config.recentRepos.slice(0, MAX_RECENT_REPOS);

  await saveConfig(config);
}
