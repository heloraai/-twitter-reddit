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
    cooldownSeconds: 15,
    headless: false,
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
    else if (arg === "--cooldown-seconds") args.cooldownSeconds = Number.parseInt(argv[++i], 10);
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run_reddit_keyword_batch.mjs
  node scripts/run_reddit_keyword_batch.mjs --max-posts 100

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
  --cooldown-seconds      Pause between keywords. Default: 15.
  --headless              Run crawler headless.
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

  // ── Retry state tracking (breaks infinite re-crawl loops for data-source-limited keywords) ──
  const retryStateFile = path.join(args.outputDir, "_retry_state.json");
  const CEILING_THRESHOLD = 2;   // require N consecutive attempts at same count
  const CEILING_TOLERANCE = 2;   // ±N posts tolerance when comparing counts
  const MAX_ATTEMPTS = 5;        // hard cap on retries to prevent runaway
  const loadRetryState = async () => {
    try { return JSON.parse(await fs.readFile(retryStateFile, "utf8")); }
    catch { return {}; }
  };
  const saveRetryState = async (state) => {
    await fs.writeFile(retryStateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  };
  const countPosts = (payload) =>
    payload?.stats?.parent_posts ??
    payload?.posts?.length ??
    (payload?.items?.filter((i) => i.record_type === "reddit_post").length || 0);
  const isAtCeiling = (history, currentCount) => {
    if (history.length < CEILING_THRESHOLD) return false;
    const recent = history.slice(-CEILING_THRESHOLD);
    return recent.every((n) => Math.abs(n - currentCount) <= CEILING_TOLERANCE);
  };
  const retryState = await loadRetryState();

  for (const [index, keyword] of keywords.entries()) {
    const output = path.join(args.outputDir, `${slugify(keyword)}.json`);
    console.log(`\n[batch] ${index + 1}/${keywords.length}: "${keyword}" -> ${output}`);

    const meta = retryState[keyword] || { attempts: 0, history: [], status: "pending" };

    // ── If state already marked ceiling, accept silently and skip crawl ──
    if (meta.status === "ceiling") {
      const maxSeen = meta.history.length ? Math.max(...meta.history) : 0;
      console.log(`[batch] CEILING — keyword permanently at data-source ceiling (best: ${maxSeen}/${args.maxPosts} over ${meta.attempts} attempts). Skipping crawl.`);
      summary.push({ keyword, output, ceiling: true, max_posts_seen: maxSeen, attempts: meta.attempts });
      await fs.writeFile(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      continue;
    }

    try {
      const existing = JSON.parse(await fs.readFile(output, "utf8"));
      const n = countPosts(existing);
      if (n >= args.maxPosts) {
        console.log(`[batch] SKIP — file already complete (${n}/${args.maxPosts} posts)`);
        meta.status = "complete";
        retryState[keyword] = meta;
        await saveRetryState(retryState);
        summary.push({ keyword, output, skipped: true, ...(await summarizeOutput(output)) });
        await fs.writeFile(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
        continue;
      } else if (n > 0) {
        if (isAtCeiling(meta.history, n) || meta.attempts >= MAX_ATTEMPTS) {
          const reason = meta.attempts >= MAX_ATTEMPTS ? `${meta.attempts} attempts hit MAX_ATTEMPTS` : `${CEILING_THRESHOLD} attempts stuck at ~${n}`;
          console.log(`[batch] CEILING — file at data-source ceiling (${n}/${args.maxPosts}, ${reason}). Accepting as final.`);
          meta.status = "ceiling";
          retryState[keyword] = meta;
          await saveRetryState(retryState);
          summary.push({ keyword, output, ceiling: true, max_posts_seen: n, attempts: meta.attempts, ...(await summarizeOutput(output)) });
          await fs.writeFile(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
          continue;
        }
        console.log(`[batch] PARTIAL — file has only ${n}/${args.maxPosts} posts (attempt ${meta.attempts + 1}/${MAX_ATTEMPTS}), deleting and re-crawling`);
        await fs.unlink(output);
      }
    } catch {}

    const childArgs = [
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
    ];
    if (args.headless) childArgs.push("--headless");
    const result = await runCommand(process.execPath, childArgs);

    // ── Update retry state with this attempt's outcome ──
    let newCount = 0;
    try {
      const newPayload = JSON.parse(await fs.readFile(output, "utf8"));
      newCount = countPosts(newPayload);
    } catch {}
    meta.attempts += 1;
    meta.history.push(newCount);
    meta.last_attempt_at = new Date().toISOString();
    if (newCount >= args.maxPosts) {
      meta.status = "complete";
    } else if (isAtCeiling(meta.history, newCount) || meta.attempts >= MAX_ATTEMPTS) {
      meta.status = "ceiling";
      console.log(`[batch] now marked CEILING for "${keyword}" — history: [${meta.history.join(", ")}]`);
    }
    retryState[keyword] = meta;
    await saveRetryState(retryState);

    const item = {
      keyword,
      output,
      exit_code: result.code,
      signal: result.signal,
      attempt: meta.attempts,
      posts_this_attempt: newCount,
      status: meta.status,
      ...(await summarizeOutput(output)),
    };
    summary.push(item);
    await fs.writeFile(path.join(args.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    // Cooldown between keywords to avoid Reddit 429 rate limiting
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
