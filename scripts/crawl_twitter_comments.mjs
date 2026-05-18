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
  dedupeRawItems,
  ensureDir,
  makeItem,
  mergeEngagement,
  normalizeSpace,
  parseEngagementLabel,
  safeAttr,
  safeText,
  slugify,
  timestampForPath,
  todayIso,
} from "./utils.mjs";

const TWEET_SELECTOR = 'article[data-testid="tweet"]';

function parseArgs(argv) {
  const args = {
    authDir: ".crawler-auth",
    headful: false,
    useChromeProfile: false,
    chromeUserDataDir: DEFAULT_CHROME_USER_DATA_DIR,
    profileDirectory: "Default",
    cdpUrl: null,
    maxPosts: 50,
    maxCommentsPerPost: 99999,
    searchScrolls: 80,
    threadScrolls: 220,
    stableRounds: 8,
    includePosts: true,
    searchMode: "live",
    maxDepth: 2,
    maxChildRepliesPerComment: 80,
    treeMode: "network",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keyword" || arg === "-k") args.keyword = argv[++i];
    else if (arg === "--output" || arg === "-o") args.output = argv[++i];
    else if (arg === "--auth-dir") args.authDir = argv[++i];
    else if (arg === "--headful") args.headful = true;
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
    else if (arg === "--max-child-replies-per-comment") args.maxChildRepliesPerComment = Number.parseInt(argv[++i], 10);
    else if (arg === "--tree-mode") args.treeMode = argv[++i];
    else if (arg === "--search-mode") args.searchMode = argv[++i];
    else if (arg === "--comments-only") args.includePosts = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run crawl:twitter:comments -- --keyword "fiat offramp"
  npm run crawl:twitter:comments -- --keyword "fiat offramp" --max-posts 200 --max-comments-per-post 1000

Options:
  --keyword, -k             Search keyword.
  --output, -o              Output JSON path.
  --max-posts               Max search-result posts to open. Default: 50.
                            Use 0 for no explicit post cap; crawler stops on repeated no-new-result rounds.
  --max-comments-per-post   Max comments/replies per opened post. Default: 500.
                            Use 0 for no explicit per-post cap; crawler stops on repeated no-new-comment rounds.
  --search-scrolls          Max search page scrolls. Default: 80.
  --thread-scrolls          Max detail page scrolls per post. Default: 220.
  --stable-rounds           Stop after this many scrolls with no new items. Default: 8.
  --max-depth               Reply tree depth below the parent post. Default: 2.
                            Use 1 for direct replies only, 0 for no explicit depth cap.
  --max-child-replies-per-comment
                            Max replies to fetch when opening each comment. Default: 80.
                            Use 0 for no explicit per-comment child cap.
  --search-mode             X search mode: live, top, latest. Default: live.
  --tree-mode               network or dom-recursive. Default: network.
                            network reads X TweetDetail responses and uses in_reply_to_status_id_str.
                            dom-recursive opens each comment URL when network data is unavailable.
  --comments-only           Do not include parent posts in output items.
  --headful                 Show browser while crawling.
  --use-chrome-profile      Reuse local Google Chrome profile.
  --profile-directory       Chrome profile directory. Default: Default.
  --cdp-url                 Connect to a running Chrome CDP session.
`);
}

function validateArgs(args) {
  if (!args.keyword) throw new Error("Missing --keyword");
  for (const key of [
    "maxPosts",
    "maxCommentsPerPost",
    "searchScrolls",
    "threadScrolls",
    "stableRounds",
    "maxDepth",
    "maxChildRepliesPerComment",
  ]) {
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error(`--${key} must be a non-negative integer`);
  }
  if (!["network", "dom-recursive"].includes(args.treeMode)) {
    throw new Error("--tree-mode must be network or dom-recursive");
  }
}

function tweetIdFromUrl(url) {
  const match = String(url || "").match(/\/status\/(\d+)/);
  return match?.[1] || null;
}

function normalizeTweetUrl(href) {
  if (!href) return null;
  const url = new URL(href, "https://x.com");
  const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
  if (!match) return null;
  return `https://x.com/${match[1]}/status/${match[2]}`;
}

function authorHandleFromUrl(url) {
  const match = String(url || "").match(/x\.com\/([^/]+)\/status\//);
  return match ? `@${match[1]}` : null;
}

async function engagementFromCard(card) {
  const labels = await card
    .locator('[role="group"][aria-label], [aria-label*="repl"], [aria-label*="like"], [aria-label*="view"], [aria-label*="repost"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") || ""))
    .catch(() => []);
  return mergeEngagement(...labels.map(parseEngagementLabel));
}

async function tweetHrefFromCard(card) {
  const hrefs = await card
    .locator('a[href*="/status/"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") || ""))
    .catch(() => []);
  for (const href of hrefs) {
    const normalized = normalizeTweetUrl(href);
    if (normalized) return normalized;
  }
  return null;
}

async function rawInnerText(locator, timeout = 2500) {
  try {
    return await locator.innerText({ timeout });
  } catch {
    return "";
  }
}

function parseReplyingToHandles(rawText) {
  const lines = String(rawText || "").split("\n").map(normalizeSpace).filter(Boolean);
  const handles = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^replying to$/i.test(line) && !/^replying to\s+/i.test(line)) continue;
    for (const candidate of [line, lines[index + 1] || "", lines[index + 2] || ""]) {
      for (const match of candidate.matchAll(/@[\w_]{2,30}/g)) {
        handles.add(match[0].toLowerCase());
      }
    }
  }
  return [...handles];
}

function normalizeTwitterDate(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function unwrapTweetResult(value) {
  if (!value || typeof value !== "object") return null;
  if (value.tweet && typeof value.tweet === "object") return unwrapTweetResult(value.tweet);
  if (value.result && typeof value.result === "object") return unwrapTweetResult(value.result);
  if (value.__typename === "TweetWithVisibilityResults" && value.tweet) return unwrapTweetResult(value.tweet);
  if (value.rest_id && value.legacy?.full_text) return value;
  return null;
}

function collectTweetObjects(value, out = new Map(), seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  const tweet = unwrapTweetResult(value);
  if (tweet?.rest_id) out.set(tweet.rest_id, tweet);
  if (Array.isArray(value)) {
    for (const item of value) collectTweetObjects(item, out, seen);
  } else {
    for (const child of Object.values(value)) collectTweetObjects(child, out, seen);
  }
  return out;
}

function tweetObjectToRawItem(tweet, root) {
  const legacy = tweet.legacy || {};
  const user = tweet.core?.user_results?.result || {};
  const userLegacy = user.legacy || {};
  const authorHandle = userLegacy.screen_name ? `@${userLegacy.screen_name}` : null;
  const url = authorHandle
    ? `https://x.com/${authorHandle.slice(1)}/status/${tweet.rest_id}`
    : `https://x.com/i/web/status/${tweet.rest_id}`;
  const noteText = tweet.note_tweet?.note_tweet_results?.result?.text;
  const replyToHandle = legacy.in_reply_to_screen_name ? `@${legacy.in_reply_to_screen_name}` : null;
  return {
    url,
    tweet_id: tweet.rest_id,
    author: userLegacy.name || null,
    author_handle: authorHandle,
    content: normalizeSpace(noteText || legacy.full_text || ""),
    posted_at: normalizeTwitterDate(legacy.created_at),
    engagement: mergeEngagement({
      likes: legacy.favorite_count,
      comments: legacy.reply_count,
      retweets: legacy.retweet_count,
      views: tweet.views?.count ? Number.parseInt(tweet.views.count, 10) : null,
    }),
    record_type: tweet.rest_id === root.tweet_id ? "twitter_post" : "twitter_comment",
    parent_tweet_id: root.tweet_id,
    parent_tweet_url: root.url,
    parent_author: root.author,
    parent_author_handle: root.author_handle,
    parent_content: root.content,
    parent_posted_at: root.posted_at,
    reply_to_tweet_id: legacy.in_reply_to_status_id_str || root.tweet_id,
    reply_to_tweet_url: legacy.in_reply_to_status_id_str
      ? `https://x.com/${replyToHandle ? replyToHandle.slice(1) : "i/web"}/status/${legacy.in_reply_to_status_id_str}`
      : root.url,
    reply_to_author_handle: replyToHandle || root.author_handle,
    replying_to_author_handles: replyToHandle ? [replyToHandle.toLowerCase()] : [],
  };
}

async function extractTweetCard(card) {
  const rawText = await rawInnerText(card, 2500);
  const fullText = normalizeSpace(rawText);
  const content = await safeText(card.locator('[data-testid="tweetText"]').first(), 1800);
  const url = await tweetHrefFromCard(card);
  const postedAt = await safeAttr(card.locator("time").first(), "datetime", 1500);
  const authorHandle = authorHandleFromUrl(url) || fullText.match(/@[\w_]{2,30}/)?.[0] || null;
  const lines = fullText.split("\n").map(normalizeSpace).filter(Boolean);
  const author =
    lines.find((line) => !line.startsWith("@") && !/^(Ad|Promoted|Show more|Translate post)$/i.test(line)) || null;
  if (!url || !content) return null;
  return {
    url,
    tweet_id: tweetIdFromUrl(url),
    author,
    author_handle: authorHandle,
    content,
    posted_at: postedAt,
    engagement: await engagementFromCard(card),
    replying_to_author_handles: parseReplyingToHandles(rawText),
  };
}

async function collectVisibleTweets(page) {
  const cards = await page.locator(TWEET_SELECTOR).all();
  const items = [];
  for (const card of cards) {
    const item = await extractTweetCard(card);
    if (item) items.push(item);
  }
  return dedupeRawItems(items);
}

function searchUrl(keyword, mode) {
  const params = {
    q: keyword,
    src: "typed_query",
  };
  if (mode !== "top") params.f = "live";
  return buildSearchUrl("https://x.com/search", params);
}

async function collectSearchPosts(page, args) {
  await page.goto(searchUrl(args.keyword, args.searchMode), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
  const posts = [];
  let stable = 0;
  let lastCount = 0;
  let lastLoggedCount = 0;
  const capped = args.maxPosts > 0;
  for (let i = 0; i <= args.searchScrolls; i += 1) {
    const visible = await collectVisibleTweets(page);
    posts.push(...visible);
    const deduped = dedupeRawItems(posts);
    posts.length = 0;
    posts.push(...deduped);
    if (posts.length >= lastLoggedCount + 10 || i % 20 === 0) {
      console.log(`[twitter] search scroll ${i}/${args.searchScrolls}: ${posts.length}${capped ? `/${args.maxPosts}` : ""} parent posts`);
      lastLoggedCount = posts.length;
    }
    if (capped && posts.length >= args.maxPosts) break;
    stable = posts.length === lastCount ? stable + 1 : 0;
    if (stable >= args.stableRounds) break;
    lastCount = posts.length;
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1100);
  }
  return posts.slice(0, capped ? args.maxPosts : posts.length);
}

function withParent(reply, parent, index) {
  return {
    ...reply,
    record_type: "twitter_comment",
    parent_tweet_id: parent.tweet_id,
    parent_tweet_url: parent.url,
    parent_author: parent.author,
    parent_author_handle: parent.author_handle,
    parent_content: parent.content,
    parent_posted_at: parent.posted_at,
    reply_to_tweet_id: parent.tweet_id,
    reply_to_tweet_url: parent.url,
    reply_to_author_handle: parent.author_handle,
    thread_position: index,
    reply_depth: 1,
  };
}

function withReplyParent(reply, root, replyParent, index, depth) {
  return {
    ...reply,
    record_type: "twitter_comment",
    parent_tweet_id: root.tweet_id,
    parent_tweet_url: root.url,
    parent_author: root.author,
    parent_author_handle: root.author_handle,
    parent_content: root.content,
    parent_posted_at: root.posted_at,
    reply_to_tweet_id: replyParent.tweet_id,
    reply_to_tweet_url: replyParent.url,
    reply_to_author_handle: replyParent.author_handle,
    thread_position: index,
    reply_depth: depth,
  };
}

function inferCommentTree(parent, comments) {
  const byTweetId = new Map();
  const roots = [];
  const parentHandle = parent.author_handle?.toLowerCase();

  for (const comment of comments) {
    if (comment.reply_to_tweet_id && comment.reply_to_tweet_id !== parent.tweet_id) {
      byTweetId.set(comment.tweet_id, { ...comment, children: [] });
      continue;
    }
    const replyingTo = new Set((comment.replying_to_author_handles || []).map((handle) => handle.toLowerCase()));
    let inferredParent = null;
    if (replyingTo.size > 0 && (!parentHandle || !replyingTo.has(parentHandle))) {
      for (let index = comments.indexOf(comment) - 1; index >= 0; index -= 1) {
        const candidate = comments[index];
        const candidateHandle = candidate.author_handle?.toLowerCase();
        if (candidateHandle && replyingTo.has(candidateHandle)) {
          inferredParent = candidate;
          break;
        }
      }
    }

    if (inferredParent) {
      comment.reply_to_tweet_id = inferredParent.tweet_id;
      comment.reply_to_tweet_url = inferredParent.url;
      comment.reply_to_author_handle = inferredParent.author_handle;
      comment.reply_depth = (inferredParent.reply_depth || 1) + 1;
    } else {
      comment.reply_to_tweet_id = parent.tweet_id;
      comment.reply_to_tweet_url = parent.url;
      comment.reply_to_author_handle = parent.author_handle;
      comment.reply_depth = 1;
    }

    byTweetId.set(comment.tweet_id, { ...comment, children: [] });
  }

  for (const comment of comments) {
    const node = byTweetId.get(comment.tweet_id);
    const parentNode = byTweetId.get(comment.reply_to_tweet_id);
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }

  return roots;
}

async function collectRepliesFromDetailPage(page, target, args, cap) {
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  const replies = [];
  let stable = 0;
  let lastCount = 0;
  const capped = cap > 0;
  for (let i = 0; i <= args.threadScrolls; i += 1) {
    const visible = await collectVisibleTweets(page);
    for (const item of visible) {
      if (!item.tweet_id || item.tweet_id === target.tweet_id) continue;
      if (item.posted_at && target.posted_at && Date.parse(item.posted_at) < Date.parse(target.posted_at)) continue;
      replies.push(item);
    }
    const deduped = dedupeRawItems(replies);
    replies.length = 0;
    replies.push(...deduped);
    if (capped && replies.length >= cap) break;
    stable = replies.length === lastCount ? stable + 1 : 0;
    if (stable >= args.stableRounds) break;
    lastCount = replies.length;
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1100);
  }
  return replies.slice(0, capped ? cap : replies.length);
}

function connectedThreadItems(rawItems, rootId) {
  const byId = new Map(rawItems.filter((item) => item.tweet_id).map((item) => [item.tweet_id, item]));
  const connected = [];
  for (const item of byId.values()) {
    if (item.tweet_id === rootId) continue;
    let cursor = item;
    const seen = new Set();
    while (cursor?.reply_to_tweet_id && !seen.has(cursor.tweet_id)) {
      if (cursor.reply_to_tweet_id === rootId) {
        connected.push(item);
        break;
      }
      seen.add(cursor.tweet_id);
      cursor = byId.get(cursor.reply_to_tweet_id);
    }
  }
  return connected;
}

async function collectThreadCommentsFromNetwork(page, parent, args) {
  const responses = [];
  const onResponse = async (response) => {
    const url = response.url();
    if (!url.includes("/TweetDetail") && !url.includes("/TweetResultByRestId")) return;
    try {
      responses.push(await response.json());
    } catch {
      // Ignore non-JSON or already-consumed responses.
    }
  };

  page.on("response", onResponse);
  try {
    await page.goto(parent.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    let stable = 0;
    let lastCount = 0;
    for (let i = 0; i <= args.threadScrolls; i += 1) {
      const parsed = responses.flatMap((body) => [...collectTweetObjects(body).values()]);
      const count = new Set(parsed.map((tweet) => tweet.rest_id)).size;
      stable = count === lastCount ? stable + 1 : 0;
      if (stable >= args.stableRounds) break;
      lastCount = count;
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(900);
    }
  } finally {
    page.off("response", onResponse);
  }

  const tweets = new Map();
  for (const body of responses) {
    for (const [id, tweet] of collectTweetObjects(body)) tweets.set(id, tweet);
  }
  const rawItems = [...tweets.values()]
    .map((tweet) => tweetObjectToRawItem(tweet, parent))
    .filter((item) => item.content && item.tweet_id);
  const connected = connectedThreadItems(rawItems, parent.tweet_id);
  const capped = args.maxCommentsPerPost > 0 ? connected.slice(0, args.maxCommentsPerPost) : connected;
  const byId = new Map(capped.map((item) => [item.tweet_id, item]));
  for (const item of capped) {
    if (item.reply_to_tweet_id !== parent.tweet_id && !byId.has(item.reply_to_tweet_id)) {
      item.reply_to_tweet_id = parent.tweet_id;
      item.reply_to_tweet_url = parent.url;
      item.reply_to_author_handle = parent.author_handle;
    }
  }
  return capped.map((item, index) => ({
    ...item,
    thread_position: index + 1,
    reply_depth: depthForItem(item, parent.tweet_id, byId),
  }));
}

function depthForItem(item, rootId, byId) {
  let depth = 1;
  let cursor = item;
  const seen = new Set();
  while (cursor?.reply_to_tweet_id && cursor.reply_to_tweet_id !== rootId && !seen.has(cursor.tweet_id)) {
    seen.add(cursor.tweet_id);
    cursor = byId.get(cursor.reply_to_tweet_id);
    if (cursor) depth += 1;
  }
  return depth;
}

async function collectThreadCommentsDomRecursive(page, parent, args) {
  const rootReplies = await collectRepliesFromDetailPage(page, parent, args, args.maxCommentsPerPost);
  const comments = rootReplies.map((reply, index) => withParent(reply, parent, index + 1));
  const seen = new Set([parent.tweet_id, ...comments.map((comment) => comment.tweet_id)]);
  const maxDepth = args.maxDepth === 0 ? Number.POSITIVE_INFINITY : args.maxDepth;

  for (let index = 0; index < comments.length; index += 1) {
    const current = comments[index];
    if ((current.reply_depth || 1) >= maxDepth) continue;
    const childCap = args.maxChildRepliesPerComment;
    const childReplies = await collectRepliesFromDetailPage(page, current, args, childCap);
    let added = 0;
    for (const child of childReplies) {
      if (!child.tweet_id || seen.has(child.tweet_id)) continue;
      seen.add(child.tweet_id);
      added += 1;
      comments.push(withReplyParent(child, parent, current, comments.length + 1, (current.reply_depth || 1) + 1));
    }
    if (added > 0) {
      console.log(`[twitter] ${added} child replies under ${current.tweet_id}`);
    }
  }

  inferCommentTree(parent, comments);
  return comments;
}

async function collectThreadComments(page, parent, args) {
  if (args.treeMode === "network") {
    const networkItems = await collectThreadCommentsFromNetwork(page, parent, args);
    if (networkItems.length > 0) return networkItems;
    console.log(`[twitter] no TweetDetail network comments for ${parent.tweet_id}; falling back to DOM recursion`);
  }
  return collectThreadCommentsDomRecursive(page, parent, args);
}

function parentAsItem(parent) {
  return {
    ...parent,
    record_type: "twitter_post",
    parent_tweet_id: null,
    parent_tweet_url: null,
    thread_position: 0,
    reply_depth: 0,
  };
}

const PARENT_FIELDS_TO_DROP = new Set([
  "parent_tweet_id", "parent_tweet_url",
  "parent_author", "parent_author_handle",
  "parent_content", "parent_posted_at",
]);

function stripParentFields(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (!PARENT_FIELDS_TO_DROP.has(k)) out[k] = v;
  }
  return out;
}

function buildNestedPosts(items) {
  const posts = items.filter((item) => item.record_type === "twitter_post");
  const comments = items.filter((item) => item.record_type === "twitter_comment");
  const allIds = new Set(items.filter((i) => i.tweet_id).map((i) => i.tweet_id));
  const childrenOf = new Map();
  const orphanIds = [];

  for (const c of comments) {
    const tid = c.tweet_id;
    const replyTo = c.reply_to_tweet_id;
    const parentId = c.parent_tweet_id;
    let placed = false;
    if (replyTo && replyTo !== tid && allIds.has(replyTo)) {
      if (!childrenOf.has(replyTo)) childrenOf.set(replyTo, []);
      childrenOf.get(replyTo).push(tid);
      placed = true;
    } else if (parentId && parentId !== tid && allIds.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(tid);
      placed = true;
    }
    if (!placed) orphanIds.push(tid);
  }

  const dataById = new Map();
  for (const p of posts) dataById.set(p.tweet_id, p);
  for (const c of comments) dataById.set(c.tweet_id, c);

  function buildNode(tid, visited) {
    if (visited.has(tid)) return null;
    visited.add(tid);
    const raw = dataById.get(tid);
    if (!raw) return null;
    const node = raw.record_type === "twitter_comment" ? stripParentFields(raw) : { ...raw };
    const replies = [];
    for (const childId of childrenOf.get(tid) || []) {
      const child = buildNode(childId, new Set(visited));
      if (child) replies.push(child);
    }
    node.replies = replies;
    return node;
  }

  const result = [];
  for (const p of posts) {
    const node = buildNode(p.tweet_id, new Set());
    if (node) result.push(node);
  }
  if (orphanIds.length > 0) {
    const orphans = orphanIds.map((id) => buildNode(id, new Set())).filter(Boolean);
    if (orphans.length > 0) {
      result.push({ id: "_orphan_comments", record_type: "orphan_bucket", replies: orphans });
    }
  }
  return result;
}

function countAllReplies(node) {
  const replies = node.replies || [];
  return replies.reduce((sum, child) => sum + 1 + countAllReplies(child), 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  args.authDir = absoluteFromCwd(args.authDir);
  args.chromeUserDataDir = absoluteFromCwd(args.chromeUserDataDir);
  validateArgs(args);

  const outputPath = absoluteFromCwd(
    args.output ||
      path.join("outputs", "source_crawls", `${timestampForPath()}_${slugify(args.keyword)}_twitter_comments.json`),
  );

  const session = await newContextForSource({
    source: "twitter",
    authDir: args.authDir,
    headful: args.headful,
    useChromeProfile: args.useChromeProfile,
    chromeUserDataDir: args.chromeUserDataDir,
    profileDirectory: args.profileDirectory,
    cdpUrl: args.cdpUrl,
  });

  const crawlErrors = {};
  const warnings = {};
  const rawItems = [];
  try {
    const posts = await collectSearchPosts(session.page, args);
    console.log(`[twitter] collected ${posts.length} parent posts from search`);
    if (args.includePosts) rawItems.push(...posts.map(parentAsItem));

    for (const [index, post] of posts.entries()) {
      console.log(`[twitter] opening ${index + 1}/${posts.length}: ${post.url}`);
      try {
        const comments = await collectThreadComments(session.page, post, args);
        console.log(`[twitter] ${comments.length} comments from ${post.tweet_id}`);
        rawItems.push(...comments);
      } catch (error) {
        crawlErrors[post.url] = `${error.name || "Error"}: ${error.message || error}`;
      }
    }

    if (!session.usesPersistentProfile) {
      await saveContextState(session.context, args.authDir, "twitter");
    }
  } finally {
    await closeBrowserSession(session);
  }

  const items = dedupeRawItems(rawItems).map((item, index) => makeItem("twitter", index, item));
  if (items.length === 0) warnings.twitter = "No Twitter posts/comments extracted. Check login state, X rate limits, or bot verification.";

  const postCount = items.filter((item) => item.record_type === "twitter_post").length;
  const commentCount = items.filter((item) => item.record_type === "twitter_comment").length;
  const nestedPosts = buildNestedPosts(items);
  const nestedReplies = nestedPosts.reduce((sum, p) => sum + countAllReplies(p), 0);

  const payload = {
    seed_query: args.keyword,
    run_date: todayIso(),
    collection_method: "crawler_only_no_llm_twitter_thread_comments_deep_scroll",
    stats: {
      parent_posts: postCount,
      total_comments: commentCount,
      total_items: items.length,
      nested_replies: nestedReplies,
    },
    crawl_config: {
      max_posts: args.maxPosts,
      max_comments_per_post: args.maxCommentsPerPost,
      search_scrolls: args.searchScrolls,
      thread_scrolls: args.threadScrolls,
      stable_rounds: args.stableRounds,
      max_depth: args.maxDepth,
      max_child_replies_per_comment: args.maxChildRepliesPerComment,
      include_posts: args.includePosts,
      search_mode: args.searchMode,
      tree_mode: args.treeMode,
    },
    crawl_errors: crawlErrors,
    collection_warnings: warnings,
    posts: nestedPosts,
  };

  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Saved ${items.length} items (${postCount} posts, ${commentCount} comments, ${nestedReplies} nested) to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
