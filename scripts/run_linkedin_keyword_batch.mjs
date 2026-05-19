#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, sleep, slugify, timestampForPath } from "./utils.mjs";

const COOLDOWN_NORMAL = 25; // LinkedIn is stricter — longer cooldown
const COOLDOWN_RESTART = 120;
const RESTART_EVERY = 6;

const DEFAULT_KEYWORDS = [
  "EOR Singapore",
  "global employment Asia",
  "Asia payroll outsourcing",
];

function parseArgs(argv) {
  const args = {
    keywords: DEFAULT_KEYWORDS,
    maxPosts: 50,
    maxCommentsPerPost: 200,
    searchScrolls: 80,
    threadScrolls: 60,
    stableRounds: 8,
    sortBy: "relevance",
    datePosted: "past-year",
    outputDir: path.join("outputs", "source_crawls", "linkedin_keyword_batch"),
    batchId: timestampForPath(),
    restartEvery: RESTART_EVERY,
    skipComments: false,
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
    else if (arg === "--sort-by") args.sortBy = argv[++i];
    else if (arg === "--date-posted") args.datePosted = argv[++i];
    else if (arg === "--output-dir") args.outputDir = argv[++i];
    else if (arg === "--batch-id") args.batchId = argv[++i];
    else if (arg === "--restart-every") args.restartEvery = Number.parseInt(argv[++i], 10);
    else if (arg === "--skip-comments") args.skipComments = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run_linkedin_keyword_batch.mjs --keywords "EOR Singapore,Asia payroll" --output-dir outputs/source_crawls/hr_eor/linkedin

Options:
  --keywords              Comma-separated keyword list.
  --keywords-file         One keyword per line.
  --max-posts             Posts per keyword. Default: 50.
  --max-comments-per-post Comments cap per post. Default: 200.
  --search-scrolls        Search scroll count. Default: 80.
  --thread-scrolls        Post detail scroll count. Default: 60.
  --sort-by               relevance or date_posted. Default: relevance.
  --date-posted           past-24h, past-week, past-month, past-year. Default: past-year.
  --restart-every         Pause boundary (no cookie clear since LinkedIn needs login). Default: 6.
  --output-dir            Output directory.
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

  for (const [index, keyword] of keywords.entries()) {
    // ── Restart boundary: longer cooldown (do NOT clear storageState — LinkedIn requires login) ──
    if (index > 0 && index % args.restartEvery === 0) {
      console.log(`\n[batch] ⚡ restart boundary (every ${args.restartEvery} keywords) — cooling down ${COOLDOWN_RESTART}s...`);
      await sleep(COOLDOWN_RESTART * 1000);
    }

    const output = path.join(args.outputDir, `${slugify(keyword)}.json`);
    console.log(`\n[batch] ${index + 1}/${keywords.length}: "${keyword}" -> ${output}`);
    const childArgs = [
      "scripts/crawl_linkedin_comments.mjs",
      "--keyword",
      keyword,
      "--sort-by",
      args.sortBy,
      "--date-posted",
      args.datePosted,
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
    if (args.skipComments) childArgs.push("--skip-comments");
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

    if (index < keywords.length - 1) {
      console.log(`[batch] cooling down ${COOLDOWN_NORMAL}s before next keyword...`);
      await sleep(COOLDOWN_NORMAL * 1000);
    }
  }

  console.log(`\n[batch] done. ${summary.length} keywords processed.`);
  console.log(`[batch] saved summary to ${path.join(args.outputDir, "summary.json")}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
