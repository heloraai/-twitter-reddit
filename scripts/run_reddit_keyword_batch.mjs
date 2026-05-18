#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, sleep, slugify, timestampForPath } from "./utils.mjs";

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
    maxCommentsPerPost: 999999,
    searchScrolls: 60,
    threadScrolls: 80,
    stableRounds: 6,
    sortMode: "relevance",
    timeRange: "year",
    outputDir: path.join("outputs", "source_crawls", "reddit_keyword_batch"),
    batchId: timestampForPath(),
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
    else if (arg === "--sort-mode") args.sortMode = argv[++i];
    else if (arg === "--time-range") args.timeRange = argv[++i];
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg === "--batch-id") args.batchId = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/source_crawler/run_reddit_keyword_batch.mjs
  node scripts/source_crawler/run_reddit_keyword_batch.mjs --max-posts 100

Options:
  --keywords              Comma-separated keyword list. Defaults to the ramp keyword set.
  --keywords-file         One keyword per line.
  --max-posts             Posts per keyword. Default: 100.
  --max-comments-per-post Comments per post cap. Default: 200.
  --search-scrolls        Search page scrolls. Default: 60.
  --thread-scrolls        Thread page scrolls per post. Default: 80.
  --sort-mode             Reddit sort: relevance, hot, new, top. Default: relevance.
  --time-range            Reddit time filter: hour, day, week, month, year, all. Default: year.
  --output-dir            Output directory. Default: outputs/source_crawls/reddit_keyword_batch.
`);
}

async function loadKeywords(args) {
  if (!args.keywordsFile) return args.keywords;
  const raw = await fs.readFile(args.keywordsFile, "utf8");
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function runCommand(command, cmdArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, cmdArgs, {
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
    return {
      file,
      parent_posts: payload.stats?.parent_posts || payload.items?.filter((i) => i.record_type === "reddit_post").length || 0,
      comments: payload.stats?.total_comments || payload.items?.filter((i) => i.record_type === "reddit_comment").length || 0,
      total_items: payload.stats?.total_items || payload.items?.length || 0,
      threads: payload.threads?.length || 0,
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

  for (const [index, keyword] of keywords.entries()) {
    const output = path.join(args.outputDir, `${slugify(keyword)}.json`);
    console.log(`\n[batch] ${index + 1}/${keywords.length}: "${keyword}" -> ${output}`);
    const result = await runCommand(process.execPath, [
      "scripts/crawl_reddit_comments.mjs",
      "--keyword",
      keyword,
      "--sort-mode",
      args.sortMode,
      "--time-range",
      args.timeRange,
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
    ]);
    const item = {
      keyword,
      output,
      exit_code: result.code,
      signal: result.signal,
      ...(await summarizeOutput(output)),
    };
    summary.push(item);
    await fs.writeFile(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    // Cooldown between keywords to avoid Reddit 429 rate limiting
    if (index < keywords.length - 1) {
      const cooldown = 15;
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
