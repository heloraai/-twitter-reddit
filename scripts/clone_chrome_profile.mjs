#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PROFILE = "Profile 1";
const DEFAULT_OUT_DIR = ".crawler-chrome-profile";

const SKIP_NAMES = new Set([
  "BrowserMetrics-spare.pma",
  "Crashpad",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "Safe Browsing",
  "component_crx_cache",
  "extensions_crx_cache",
  "optimization_guide_model_store",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "RunningChromeVersion",
]);

const SKIP_PROFILE_NAMES = new Set([
  "Cache",
  "Code Cache",
  "DawnCache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "optimization_guide_hint_cache_store",
  "optimization_guide_model_metadata_store",
  "Platform Notifications",
  "Sessions",
  "Service Worker",
  "CacheStorage",
]);

function parseArgs(argv) {
  const args = {
    profileDirectory: DEFAULT_PROFILE,
    outputDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile-directory") args.profileDirectory = argv[++i];
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function chromeRoot() {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyPath(src, dest, { profileScoped = false } = {}) {
  const stat = await fs.lstat(src);
  const name = path.basename(src);
  if (!profileScoped && SKIP_NAMES.has(name)) return;
  if (profileScoped && SKIP_PROFILE_NAMES.has(name)) return;
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);
    for (const entry of entries) {
      await copyPath(path.join(src, entry), path.join(dest, entry), { profileScoped });
    }
    return;
  }
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  npm run profile:clone
  npm run profile:clone -- --profile-directory "Profile 1"
  npm run profile:clone -- --profile-directory "Profile 1" --output-dir .crawler-chrome-profile
`);
    return;
  }

  const root = chromeRoot();
  const sourceProfile = path.join(root, args.profileDirectory);
  if (!await exists(sourceProfile)) {
    throw new Error(`Chrome profile not found: ${sourceProfile}`);
  }

  await fs.rm(args.outputDir, { recursive: true, force: true });
  await fs.mkdir(args.outputDir, { recursive: true });

  for (const name of ["Local State", "First Run"]) {
    const src = path.join(root, name);
    if (await exists(src)) await copyPath(src, path.join(args.outputDir, name));
  }
  await copyPath(sourceProfile, path.join(args.outputDir, args.profileDirectory), { profileScoped: true });

  console.log(`Cloned Chrome ${args.profileDirectory} to ${path.resolve(args.outputDir)}`);
  console.log("Use it with:");
  console.log(`npm run crawl:sources -- --keyword "fiat offramp" --limit 10 --use-chrome-profile --chrome-user-data-dir "${path.resolve(args.outputDir)}" --profile-directory "${args.profileDirectory}"`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
