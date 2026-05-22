#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, sleep, slugify, timestampForPath } from "./utils.mjs";

const RESTART_EVERY = 8; // restart browser session every N keywords to avoid Twitter rate-limiting
const COOLDOWN_NORMAL = 15; // seconds between keywords
const COOLDOWN_RESTART = 90; // seconds at restart boundary (every RESTART_EVERY keywords)

const DEFAULT_KEYWORDS = [
  "fiat onramp",
  "fiat offramp",
  "crypto onramp",
  "onramp api",
  "embedded crypto",
  "crypto-fiat exchange",
  "on and off ramp",
  "white label onramp",
  "fiat on-ramp SDK",
  "on-ramp API",
  "licensed crypto on-ramp",
  "MiCA compliant on-ramp",
  "B2B2C ramp model",
  "Saas model",
];

function parseArgs(argv) {
  const args = {
    keywords: DEFAULT_KEYWORDS,
    maxPosts: 100,
    maxCommentsPerPost: 99999,
    searchScrolls: 160,
    threadScrolls: 100,
    stableRounds: 7,
    searchMode: "top",
    treeMode: "network",
    outputDir: path.join("outputs", "source_crawls", "twitter_keyword_batch"),
    batchId: timestampForPath(),
    cooldownSeconds: COOLDOWN_NORMAL,
    headful: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keywords") args.keywords = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--keywords-file") args.keywords = null, args.keywordsFile = argv[++i];
    else if (arg === "--max-posts") args.maxPosts = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-comments-per-post") args.maxCommentsPerPost = Number.parseInt(argv[++i], 10);
    else if (arg === "--search-scrolls") args.searchScrolls = Number.parseInt(argv[++i], 10);
    else if (arg === "--thread-scrolls") args.threadScrolls = Number.parseInt(argv[++i], 10);
    else if (arg === "--stable-rounds") args.stableRounds = Number.parseInt(argv[++i], 10);
    else if (arg === "--search-mode") args.searchMode = argv[++i];
    else if (arg === "--tree-mode") args.treeMode = argv[++i];
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg === "--batch-id") args.batchId = argv[++i];
    else if (arg === "--restart-every") args.restartEvery = Number.parseInt(argv[++i], 10);
    else if (arg === "--cooldown-seconds") args.cooldownSeconds = Number.parseInt(argv[++i], 10);
    else if (arg === "--headful") args.headful = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run_twitter_keyword_batch.mjs
  node scripts/run_twitter_keyword_batch.mjs --max-posts 100

Options:
  --keywords              Comma-separated keyword list. Defaults to the ramp keyword set.
  --keywords-file         One keyword per line.
  --max-posts             Parent posts per keyword. Default: 100.
  --max-comments-per-post Comments per parent post cap. Default: 500.
  --output-dir            Output directory. Default: outputs/source_crawls/twitter_keyword_batch.
  --cooldown-seconds      Pause between keywords. Default: 15.
  --headful               Show browser while crawling.
`);
}

async function loadKeywords(args) {
  if (!args.keywordsFile) return args.keywords;
  const raw = await fs.readFile(args.keywordsFile, "utf8");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

async function summarizeOutput(file) {
  try {
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    // Count from nested posts[].replies[] tree
    let commentCount = 0;
    const countReplies = (replies) => {
      for (const r of replies || []) {
        commentCount += 1;
        countReplies(r.replies);
      }
    };
    for (const post of payload.posts || []) {
      countReplies(post.replies);
    }
    return {
      file,
      parent_posts: payload.stats?.parent_posts || payload.posts?.length || 0,
      comments: payload.stats?.total_comments || commentCount,
      total_items: payload.stats?.total_items || (payload.posts?.length || 0) + commentCount,
      errors: Object.keys(payload.crawl_errors || {}).length,
    };
  } catch (error) {
    return { file, error: String(error.message || error) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const keywords = await loadKeywords(args);
  await ensureDir(args.outputDir);
  const summary = [];

  const restartEvery = args.restartEvery || RESTART_EVERY;
  const authDir = ".crawler-auth";
  const authFile = path.join(authDir, "twitter.storageState.json");

  for (const [index, keyword] of keywords.entries()) {
    // ── Restart boundary: clear session cookies to avoid Twitter rate-limiting ──
    if (index > 0 && index % restartEvery === 0) {
      console.log(`\n[batch] ⚡ restart boundary (every ${restartEvery} keywords) — clearing session & cooling down ${COOLDOWN_RESTART}s...`);
      try {
        await fs.unlink(authFile);
        console.log(`[batch] cleared ${authFile}`);
      } catch { /* file may not exist */ }
      await sleep(COOLDOWN_RESTART * 1000);
    }

    const output = path.join(args.outputDir, `${slugify(keyword)}.json`);
    console.log(`\n[batch] ${index + 1}/${keywords.length}: "${keyword}" -> ${output}`);

    try {
      const existing = JSON.parse(await fs.readFile(output, "utf8"));
      const n = existing.posts?.length || 0;
      // Only skip if file is COMPLETE (reached max-posts target).
      // Partial files (process killed mid-crawl) get deleted and re-crawled.
      if (n >= args.maxPosts) {
        console.log(`[batch] SKIP — file already complete (${n}/${args.maxPosts} posts)`);
        summary.push({ keyword, output, skipped: true, ...(await summarizeOutput(output)) });
        await fs.writeFile(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
        continue;
      } else if (n > 0) {
        console.log(`[batch] PARTIAL — file has only ${n}/${args.maxPosts} posts, deleting and re-crawling`);
        await fs.unlink(output);
      }
    } catch {}

    const childArgs = [
      "scripts/crawl_twitter_comments.mjs",
      "--keyword",
      keyword,
      "--search-mode",
      args.searchMode,
      "--tree-mode",
      args.treeMode,
      "--max-posts",
      String(args.maxPosts),
      "--max-comments-per-post",
      String(args.maxCommentsPerPost),
      "--search-scrolls",
      String(args.searchScrolls),
      "--thread-scrolls",
      String(args.threadScrolls),
      "--stable-rounds",
      String(args.stableRounds),
      "--output",
      output,
    ];
    if (args.headful) childArgs.push("--headful");
    const result = await runCommand(process.execPath, childArgs);
    const item = {
      keyword,
      output,
      exit_code: result.code,
      signal: result.signal,
      ...(await summarizeOutput(output)),
    };
    summary.push(item);
    await fs.writeFile(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    // ── Cooldown between keywords to avoid Twitter rate-limiting ──
    if (index < keywords.length - 1) {
      const cooldown = args.cooldownSeconds;
      console.log(`[batch] cooling down ${cooldown}s before next keyword...`);
      await sleep(cooldown * 1000);
    }
  }

  console.log(`\n[batch] done. ${summary.length} keywords processed.`);
  console.log(`[batch] saved summary to ${path.join(args.outputDir, "summary.json")}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
