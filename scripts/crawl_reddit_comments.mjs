#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CHROME_USER_DATA_DIR,
  closeBrowserSession,
  newContextForSource,
  saveContextState,
} from "./browser.mjs";
import {
  absoluteFromCwd,
  buildSearchUrl,
  classifyDiscourse,
  dedupeRawItems,
  detectLanguage,
  ensureDir,
  extractMentionedEntities,
  inferRegion,
  normalizeSpace,
  parseCompactNumber,
  safeAttr,
  safeText,
  slugify,
  timestampForPath,
  todayIso,
} from "./utils.mjs";

// ── Args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    authDir: ".crawler-auth",
    headful: true,
    useChromeProfile: false,
    chromeUserDataDir: DEFAULT_CHROME_USER_DATA_DIR,
    profileDirectory: "Default",
    cdpUrl: null,
    maxPosts: 100,
    maxCommentsPerPost: 999999,
    searchScrolls: 60,
    threadScrolls: 80,
    stableRounds: 6,
    maxDepth: 2,
    sortMode: "relevance",
    timeRange: "year",
    useJsonApi: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keyword" || arg === "-k") args.keyword = argv[++i];
    else if (arg === "--output" || arg === "-o") args.output = argv[++i];
    else if (arg === "--auth-dir") args.authDir = argv[++i];
    else if (arg === "--headful") args.headful = true;
    else if (arg === "--headless") args.headful = false;
    else if (arg === "--use-chrome-profile") args.useChromeProfile = true;
    else if (arg === "--chrome-user-data-dir") args.chromeUserDataDir = argv[++i];
    else if (arg === "--profile-directory") args.profileDirectory = argv[++i];
    else if (arg === "--cdp-url") args.cdpUrl = argv[++i];
    else if (arg === "--max-posts") args.maxPosts = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-comments-per-post") args.maxCommentsPerPost = Number.parseInt(argv[++i], 10);
    else if (arg === "--search-scrolls") args.searchScrolls = Number.parseInt(argv[++i], 10);
    else if (arg === "--thread-scrolls") args.threadScrolls = Number.parseInt(argv[++i], 10);
    else if (arg === "--stable-rounds") args.stableRounds = Number.parseInt(argv[++i], 10);
    else if (arg === "--max-depth") args.maxDepth = Number.parseInt(argv[++i], 10);
    else if (arg === "--sort-mode") args.sortMode = argv[++i];
    else if (arg === "--time-range") args.timeRange = argv[++i];
    else if (arg === "--no-json-api") args.useJsonApi = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/crawl_reddit_comments.mjs --keyword "fiat onramp"

Options:
  --keyword, -k             Search keyword.
  --output, -o              Output JSON path.
  --max-posts               Max posts per keyword. Default: 100.
  --max-comments-per-post   Max comments per post. Default: 200.
  --search-scrolls          Max search page scrolls. Default: 60.
  --thread-scrolls          Max thread page scrolls. Default: 80.
  --stable-rounds           Stop after N scrolls with no new items. Default: 6.
  --max-depth               Reply tree depth. Default: 2.
  --sort-mode               Reddit sort: relevance, hot, new, top. Default: relevance.
  --time-range              Reddit time filter: hour, day, week, month, year, all. Default: year.
  --no-json-api             Skip JSON API; use only Playwright DOM scraping.
  --headless                Run headless (default is headful to avoid rate limits).
  --use-chrome-profile      Reuse local Chrome profile.
  --cdp-url                 Connect to a running Chrome CDP session.
`);
}

function validateArgs(args) {
  if (!args.keyword) throw new Error("Missing --keyword");
  for (const key of ["maxPosts", "maxCommentsPerPost", "searchScrolls", "threadScrolls", "stableRounds", "maxDepth"]) {
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error(`--${key} must be a non-negative integer`);
  }
}

// ── Utilities ───────────────────────────────────────────────────────
function cleanHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function postIdFromUrl(url) {
  const match = String(url || "").match(/\/comments\/([a-z0-9]+)/i);
  return match?.[1] || null;
}

function normalizeRedditUrl(href) {
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.reddit.com");
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function enrichItem(raw, index) {
  const text = normalizeSpace([raw.title, raw.content].filter(Boolean).join(" "));
  return {
    id: `rd_${String(index + 1).padStart(3, "0")}`,
    source: "reddit",
    url: raw.url || null,
    author: raw.author || null,
    author_handle: raw.author ? `u/${raw.author}` : null,
    subreddit: raw.subreddit || null,
    title: raw.title || null,
    content: raw.content || raw.title || "",
    posted_at: raw.posted_at || null,
    engagement: raw.engagement || {},
    region: inferRegion(text),
    language: detectLanguage(text),
    discourse_type: classifyDiscourse(text, "reddit"),
    mentioned_entities: extractMentionedEntities(text),
    record_type: raw.record_type,
    post_id: raw.post_id || raw.comment_id || null,
    reply_depth: raw.reply_depth ?? 0,
  };
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || `${item.author}|${item.title || item.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── JSON API via in-page fetch ──────────────────────────────────────
async function fetchRedditJson(page, url, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await page.evaluate(async (fetchUrl) => {
        const res = await fetch(fetchUrl, {
          headers: { "Accept": "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }, url);
    } catch (error) {
      if (/429/.test(error.message) && attempt < maxRetries) {
        const delay = (attempt + 1) * 8000;
        console.log(`[reddit] 429 rate-limited, waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
        await page.waitForTimeout(delay);
        continue;
      }
      throw error;
    }
  }
}

// ── JSON API: search posts ──────────────────────────────────────────
async function searchPostsViaJsonApi(page, keyword, args) {
  await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);

  const posts = [];
  let after = null;
  const perPage = 25;
  const maxPages = Math.ceil((args.maxPosts * 2) / perPage);

  for (let pageNum = 0; pageNum < maxPages; pageNum += 1) {
    const params = { q: keyword, sort: args.sortMode, t: args.timeRange, limit: String(perPage), type: "link" };
    if (after) params.after = after;
    const url = buildSearchUrl("https://www.reddit.com/search.json", params);

    try {
      const data = await fetchRedditJson(page, url);
      const children = data?.data?.children || [];
      if (children.length === 0) break;

      for (const child of children) {
        const d = child.data || {};
        const permalink = d.permalink ? new URL(d.permalink, "https://www.reddit.com").toString() : null;
        posts.push({
          url: permalink,
          post_id: d.id || postIdFromUrl(permalink),
          author: d.author || null,
          subreddit: d.subreddit_name_prefixed || (d.subreddit ? `r/${d.subreddit}` : null),
          title: cleanHtml(d.title || ""),
          content: cleanHtml(d.selftext || "").replace(/\s+/g, " ").trim(),
          posted_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
          engagement: { likes: d.score ?? null, comments: d.num_comments ?? null },
          record_type: "reddit_post",
        });
      }

      after = data?.data?.after;
      if (!after || posts.length >= args.maxPosts) break;
      await page.waitForTimeout(1200);
    } catch (error) {
      console.log(`[reddit] JSON search API error on page ${pageNum}: ${error.message}`);
      break;
    }
  }

  return dedupeByUrl(posts).slice(0, args.maxPosts);
}

// ── JSON API: fetch comments → nested replies tree ──────────────────
async function fetchCommentsViaJsonApi(page, postUrl, parent, args) {
  const jsonUrl = postUrl.replace(/\/?$/, ".json") + "?sort=confidence&limit=500&depth=10";
  try {
    const data = await fetchRedditJson(page, jsonUrl);
    const listing = Array.isArray(data) && data.length > 1 ? data[1] : null;
    if (!listing?.data?.children) return [];
    return buildReplyTree(listing.data.children, args.maxDepth, args.maxCommentsPerPost);
  } catch (error) {
    console.log(`[reddit] JSON comment fetch error for ${postUrl}: ${error.message}`);
    return [];
  }
}

function buildReplyTree(children, maxDepth, maxItems, depth = 1, counter = { n: 0 }) {
  if (maxDepth > 0 && depth > maxDepth) return [];
  const nodes = [];
  for (const child of children) {
    if (counter.n >= maxItems) break;
    if (child.kind !== "t1") continue;
    const d = child.data || {};
    if (!d.body || d.body === "[deleted]" || d.body === "[removed]") continue;

    counter.n += 1;
    const permalink = d.permalink ? new URL(d.permalink, "https://www.reddit.com").toString() : null;
    const nestedReplies = d.replies?.data?.children
      ? buildReplyTree(d.replies.data.children, maxDepth, maxItems, depth + 1, counter)
      : [];

    nodes.push({
      comment_id: d.id || null,
      author: d.author || null,
      url: permalink,
      content: normalizeSpace(cleanHtml(d.body || "")).slice(0, 2000),
      posted_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      engagement: { likes: d.score ?? null },
      record_type: "reddit_comment",
      reply_depth: depth,
      replies: nestedReplies,
    });
  }
  return nodes;
}

// ── DOM fallback: search posts ──────────────────────────────────────
async function extractPostsFromDom(page) {
  return page.evaluate(() => {
    const titleLinks = document.querySelectorAll('a[data-testid="post-title"]');
    const seen = new Set();
    const posts = [];
    for (const link of titleLinks) {
      const href = link.href;
      if (!href || !href.includes("/comments/") || seen.has(href)) continue;
      seen.add(href);
      // Walk up until we find a container that has subreddit + votes text
      let container = link.parentElement;
      for (let i = 0; i < 8 && container; i += 1) {
        const t = container.textContent || "";
        if (/r\/[A-Za-z0-9_]+/.test(t) && /votes?|comments?/i.test(t)) break;
        container = container.parentElement;
      }
      const text = (container || link.parentElement).textContent.replace(/\s+/g, " ").trim();
      const subMatch = text.match(/r\/[A-Za-z0-9_]+/);
      const voteMatch = text.match(/([\d,.]+[kKmM]?)\s*votes?/i);
      const commentMatch = text.match(/([\d,.]+[kKmM]?)\s*comments?/i);
      posts.push({
        title: link.textContent.trim(),
        href,
        subreddit: subMatch?.[0] || null,
        votes: voteMatch?.[1] || null,
        comments: commentMatch?.[1] || null,
      });
    }
    // Also try shreddit-post elements (old-style pages, post detail pages)
    for (const el of document.querySelectorAll("shreddit-post")) {
      const href = el.getAttribute("content-href") || el.getAttribute("permalink") || "";
      if (!href.includes("/comments/") || seen.has(href)) continue;
      const fullHref = new URL(href, "https://www.reddit.com").toString();
      seen.add(fullHref);
      posts.push({
        title: el.getAttribute("post-title") || "",
        href: fullHref,
        subreddit: el.getAttribute("subreddit-prefixed-name") || null,
        votes: el.getAttribute("score") || null,
        comments: el.getAttribute("comment-count") || null,
        author: el.getAttribute("author") || null,
        created: el.getAttribute("created-timestamp") || null,
      });
    }
    return posts;
  });
}

async function searchPostsViaDom(page, keyword, args) {
  const url = buildSearchUrl("https://www.reddit.com/search/", {
    q: keyword, sort: args.sortMode, type: "link", t: args.timeRange,
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  const posts = [];
  let stable = 0;
  let lastCount = 0;

  for (let i = 0; i <= args.searchScrolls; i += 1) {
    const extracted = await extractPostsFromDom(page);
    for (const raw of extracted) {
      const postUrl = normalizeRedditUrl(raw.href);
      if (!postUrl || !raw.title) continue;
      posts.push({
        url: postUrl,
        post_id: postIdFromUrl(postUrl),
        author: raw.author || null,
        subreddit: raw.subreddit || null,
        title: raw.title,
        content: "",
        posted_at: raw.created || null,
        engagement: { likes: parseCompactNumber(raw.votes), comments: parseCompactNumber(raw.comments) },
        record_type: "reddit_post",
      });
    }
    const deduped = dedupeByUrl(posts);
    posts.length = 0;
    posts.push(...deduped);

    if (posts.length >= lastCount + 5 || i % 10 === 0) {
      console.log(`[reddit] search scroll ${i}/${args.searchScrolls}: ${posts.length}/${args.maxPosts} posts`);
    }
    if (posts.length >= args.maxPosts) break;
    stable = posts.length === lastCount ? stable + 1 : 0;
    if (stable >= args.stableRounds) break;
    lastCount = posts.length;
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1500);
  }
  return posts.slice(0, args.maxPosts);
}

// ── DOM fallback: scrape comments ───────────────────────────────────
async function scrapeCommentsViaDom(page, postUrl, parent, args) {
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const btns = await page.locator('button:has-text("more repl"), button:has-text("more comment"), [id*="moreComments"]').all();
    if (btns.length === 0) break;
    for (const btn of btns.slice(0, 8)) { await btn.click().catch(() => {}); await page.waitForTimeout(600); }
  }

  let stable = 0;
  let lastCount = 0;
  for (let i = 0; i < args.threadScrolls; i += 1) {
    const count = await page.locator("shreddit-comment, [data-testid='comment']").count().catch(() => 0);
    if (count >= args.maxCommentsPerPost) break;
    stable = count === lastCount ? stable + 1 : 0;
    if (stable >= args.stableRounds) break;
    lastCount = count;
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(800);
  }

  const els = await page.locator("shreddit-comment, [data-testid='comment']").all();
  const flat = [];
  for (const el of els.slice(0, args.maxCommentsPerPost)) {
    const data = await el.evaluate((n) => ({
      author: n.getAttribute("author") || "",
      depth: n.getAttribute("depth") || "0",
      thingId: n.getAttribute("thingid") || n.getAttribute("fullname") || "",
      parentId: n.getAttribute("parentid") || "",
      score: n.getAttribute("score") || "",
      created: n.getAttribute("created-timestamp") || "",
    })).catch(() => ({}));

    const content = normalizeSpace(await safeText(el.locator('[slot="comment"], [data-testid="comment"] > div, .md').first(), 3000));
    if (!content || content === "[deleted]" || content === "[removed]") continue;
    const depth = Number.parseInt(data.depth, 10) || 1;
    if (args.maxDepth > 0 && depth > args.maxDepth) continue;

    flat.push({
      comment_id: (data.thingId || "").replace(/^t1_/, ""),
      author: data.author || null,
      url: postUrl,
      content: content.slice(0, 2000),
      posted_at: data.created || null,
      engagement: { likes: parseCompactNumber(data.score) },
      record_type: "reddit_comment",
      reply_depth: depth,
      parent_ref: (data.parentId || "").replace(/^t[13]_/, "") || parent.post_id,
    });
  }

  // Build tree from flat list
  return flatToReplyTree(flat);
}

function flatToReplyTree(flat) {
  const byId = new Map(flat.map((c) => [c.comment_id, { ...c, replies: [] }]));
  const roots = [];
  for (const c of flat) {
    const node = byId.get(c.comment_id);
    const parentNode = byId.get(c.parent_ref);
    if (parentNode) parentNode.replies.push(node);
    else roots.push(node);
  }
  // Strip internal parent_ref from output
  const clean = (node) => { const { parent_ref, ...rest } = node; return { ...rest, replies: (rest.replies || []).map(clean) }; };
  return roots.map(clean);
}

// ── Tree stats ──────────────────────────────────────────────────────
function countReplies(replies) {
  return replies.reduce((sum, r) => sum + 1 + countReplies(r.replies || []), 0);
}

function countNestedReplies(posts) {
  return posts.reduce((sum, p) => sum + countReplies(p.replies || []), 0);
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  args.authDir = absoluteFromCwd(args.authDir);
  args.chromeUserDataDir = absoluteFromCwd(args.chromeUserDataDir);
  validateArgs(args);

  const outputPath = absoluteFromCwd(
    args.output || path.join("outputs", "source_crawls", `${timestampForPath()}_${slugify(args.keyword)}_reddit_comments.json`),
  );

  const session = await newContextForSource({
    source: "reddit",
    authDir: args.authDir,
    headful: args.headful,
    useChromeProfile: args.useChromeProfile,
    chromeUserDataDir: args.chromeUserDataDir,
    profileDirectory: args.profileDirectory,
    cdpUrl: args.cdpUrl,
  });

  const crawlErrors = {};
  let searchMethod = "unknown";
  let globalIdx = 0;

  // This will be the final output posts array — each post has nested replies
  const outputPosts = [];

  try {
    // Step 1: Collect posts — always try DOM first (less rate-limited), then JSON API supplement
    let posts = [];
    console.log(`[reddit] searching via DOM scraping: "${args.keyword}"`);
    posts = await searchPostsViaDom(session.page, args.keyword, args);
    searchMethod = "playwright_dom";
    console.log(`[reddit] DOM scraping found ${posts.length} posts`);

    if (posts.length < args.maxPosts && args.useJsonApi) {
      console.log(`[reddit] supplementing with JSON API (have ${posts.length}, want ${args.maxPosts})`);
      const apiPosts = await searchPostsViaJsonApi(session.page, args.keyword, args);
      const existing = new Set(posts.map((p) => p.url));
      for (const p of apiPosts) { if (!existing.has(p.url)) posts.push(p); }
      posts = posts.slice(0, args.maxPosts);
      if (apiPosts.length > 0) searchMethod = "playwright_dom_plus_reddit_json_api";
    }
    console.log(`[reddit] collected ${posts.length} posts from search`);

    // Step 2: For each post, fetch comments and build nested tree
    let consecutive429 = 0;
    for (const [index, post] of posts.entries()) {
      console.log(`[reddit] opening ${index + 1}/${posts.length}: ${post.url}`);

      let replies = [];
      try {
        if (args.useJsonApi && consecutive429 < 5) {
          replies = await fetchCommentsViaJsonApi(session.page, post.url, post, args);
          if (replies.length > 0) consecutive429 = 0;
        }
        if (replies.length === 0) {
          replies = await scrapeCommentsViaDom(session.page, post.url, post, args);
        }
        const replyCount = countReplies(replies);
        console.log(`[reddit] ${replyCount} comments from ${post.post_id || post.url}`);
      } catch (error) {
        if (/429/.test(error.message)) consecutive429 += 1;
        crawlErrors[post.url] = `${error.name || "Error"}: ${error.message || error}`;
        console.log(`[reddit] error on ${post.url}: ${error.message}`);
      }

      // Enrich post
      const enrichedPost = enrichItem(post, globalIdx);
      globalIdx += 1;
      enrichedPost.reply_depth = 0;

      // Enrich replies recursively
      const enrichReplies = (nodes) =>
        nodes.map((node) => {
          const enriched = enrichItem(node, globalIdx);
          globalIdx += 1;
          enriched.replies = enrichReplies(node.replies || []);
          return enriched;
        });

      enrichedPost.replies = enrichReplies(replies);
      outputPosts.push(enrichedPost);

      await session.page.waitForTimeout(1500);
    }

    if (!session.usesPersistentProfile) {
      await saveContextState(session.context, args.authDir, "reddit");
    }
  } finally {
    await closeBrowserSession(session);
  }

  const totalComments = countNestedReplies(outputPosts);

  const payload = {
    seed_query: args.keyword,
    run_date: todayIso(),
    collection_method: `crawler_only_no_llm_reddit_thread_comments_${searchMethod}`,
    stats: {
      parent_posts: outputPosts.length,
      total_comments: totalComments,
      total_items: outputPosts.length + totalComments,
      nested_replies: countNestedReplies(outputPosts),
    },
    crawl_config: {
      max_posts: args.maxPosts,
      max_comments_per_post: args.maxCommentsPerPost,
      search_scrolls: args.searchScrolls,
      thread_scrolls: args.threadScrolls,
      stable_rounds: args.stableRounds,
      max_depth: args.maxDepth,
      sort_mode: args.sortMode,
      time_range: args.timeRange,
      use_json_api: args.useJsonApi,
    },
    crawl_errors: crawlErrors,
    posts: outputPosts,
  };

  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Saved ${outputPosts.length + totalComments} items (${outputPosts.length} posts, ${totalComments} comments) to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
