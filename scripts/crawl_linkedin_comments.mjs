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
  parseCompactNumber,
  parseEngagementLabel,
  safeAttr,
  safeText,
  slugify,
  timestampForPath,
  todayIso,
} from "./utils.mjs";

const POST_SELECTOR = '[data-urn^="urn:li:activity:"]';

function parseArgs(argv) {
  const args = {
    authDir: ".crawler-auth",
    headful: false,
    useChromeProfile: false,
    chromeUserDataDir: DEFAULT_CHROME_USER_DATA_DIR,
    profileDirectory: "Default",
    cdpUrl: null,
    maxPosts: 50,
    maxCommentsPerPost: 200,
    searchScrolls: 80,
    threadScrolls: 60,
    stableRounds: 8,
    sortBy: "relevance",
    datePosted: "past-year",
    includePosts: true,
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
    else if (arg === "--sort-by") args.sortBy = argv[++i];
    else if (arg === "--date-posted") args.datePosted = argv[++i];
    else if (arg === "--comments-only") args.includePosts = false;
    else if (arg === "--skip-comments") args.skipComments = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/crawl_linkedin_comments.mjs --keyword "EOR Singapore"

Options:
  --keyword, -k             Search keyword.
  --output, -o              Output JSON path.
  --max-posts               Max posts to open. Default: 50.
  --max-comments-per-post   Max comments per post. Default: 200.
  --search-scrolls          Max search page scrolls. Default: 80.
  --thread-scrolls          Max post detail page scrolls. Default: 60.
  --stable-rounds           Stop after N scrolls with no new items. Default: 8.
  --sort-by                 LinkedIn sort: relevance, date_posted. Default: relevance.
  --date-posted             Filter: past-24h, past-week, past-month, past-year, anytime. Default: past-year.
  --comments-only           Skip parent posts in output.
  --headful                 Show browser window.
  --use-chrome-profile      Reuse local Chrome profile.
`);
}

function validateArgs(args) {
  if (!args.keyword) throw new Error("--keyword is required");
}

function searchUrl(keyword, args) {
  const params = {
    keywords: keyword,
    origin: "GLOBAL_SEARCH_HEADER",
  };
  if (args.sortBy === "date_posted") params.sortBy = '"date_posted"';
  const dateMap = {
    "past-24h": '"past-24h"',
    "past-week": '"past-week"',
    "past-month": '"past-month"',
    "past-year": '"past-year"',
  };
  if (args.datePosted && dateMap[args.datePosted]) params.datePosted = dateMap[args.datePosted];
  return buildSearchUrl("https://www.linkedin.com/search/results/content/", params);
}

function urnFromActivity(urn) {
  const match = String(urn || "").match(/urn:li:activity:(\d+)/);
  return match ? match[1] : null;
}

function postUrlFromUrn(urn) {
  const id = urnFromActivity(urn);
  return id ? `https://www.linkedin.com/feed/update/urn:li:activity:${id}/` : null;
}

async function extractAllPostsOnPage(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const results = [];
    const cards = document.querySelectorAll('[data-urn^="urn:li:activity:"]');
    for (const card of cards) {
      const urn = card.getAttribute("data-urn") || "";
      const m = urn.match(/urn:li:activity:(\d+)/);
      if (!m) continue;
      const activityId = m[1];
      const pick = (sel) => {
        const el = card.querySelector(sel);
        return el ? norm(el.innerText) : "";
      };
      const author = pick(".update-components-actor__title") ||
                     pick(".update-components-actor__name");
      const subDesc = pick(".update-components-actor__sub-description");
      const content = pick(".update-components-text .break-words") ||
                      pick(".feed-shared-text .break-words") ||
                      pick(".feed-shared-update-v2__description .break-words") ||
                      pick(".update-components-text") ||
                      pick(".feed-shared-update-v2__description");
      const reactions = pick(".social-details-social-counts__reactions-count") ||
                        pick(".social-details-social-counts__social-proof-fallback-number");
      const commentsCount = pick(".social-details-social-counts__comments") ||
                            (card.querySelector("[aria-label*='comment' i]")?.getAttribute("aria-label") || "");
      results.push({
        record_type: "linkedin_post",
        post_id: activityId,
        urn,
        url: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
        author: author || null,
        author_handle: null,
        content: content || "",
        posted_at: subDesc || null,
        _reactionsText: reactions,
        _commentsText: commentsCount,
      });
    }
    return results;
  });
}

function enrichEngagement(raw) {
  const reactions = raw._reactionsText || "";
  const commentsText = raw._commentsText || "";
  const engagement = mergeEngagement(
    { likes: parseCompactNumber(reactions) },
    parseEngagementLabel(`${reactions} reactions ${commentsText}`),
  );
  const { _reactionsText, _commentsText, ...rest } = raw;
  return { ...rest, engagement };
}

async function collectSearchPosts(page, args) {
  const url = searchUrl(args.keyword, args);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  // Check for login redirect
  if (/\/login|\/checkpoint|\/authwall/.test(page.url())) {
    throw new Error(`LinkedIn redirected to auth wall: ${page.url()}. Re-extract cookies.`);
  }

  const seen = new Set();
  const posts = [];
  let stable = 0;
  let lastCount = 0;
  let lastLogged = 0;
  const capped = args.maxPosts > 0;

  for (let i = 0; i <= args.searchScrolls; i += 1) {
    const cards = await extractAllPostsOnPage(page);
    for (const raw of cards) {
      if (!raw.post_id || seen.has(raw.post_id)) continue;
      seen.add(raw.post_id);
      posts.push(enrichEngagement(raw));
      if (capped && posts.length >= args.maxPosts) break;
    }
    if (posts.length >= lastLogged + 5 || i % 10 === 0) {
      console.log(`[linkedin] search scroll ${i}/${args.searchScrolls}: ${posts.length}${capped ? `/${args.maxPosts}` : ""} posts`);
      lastLogged = posts.length;
    }
    if (capped && posts.length >= args.maxPosts) break;
    stable = posts.length === lastCount ? stable + 1 : 0;
    if (stable >= args.stableRounds) break;
    lastCount = posts.length;
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1200);
  }
  return posts.slice(0, capped ? args.maxPosts : posts.length);
}

async function expandAllReplies(page, root) {
  // Click "Load more comments" repeatedly
  for (let i = 0; i < 30; i += 1) {
    const btn = root.locator('button:has-text("Load more comments"), button:has-text("Load previous comments"), .comments-comments-list__load-more-comments-button').first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  // Expand replies
  for (let i = 0; i < 30; i += 1) {
    const replyBtn = root.locator('button.comments-comment-item__show-replies-button, button:has-text("Load more replies"), button:has-text("more replies")').first();
    if (!(await replyBtn.isVisible().catch(() => false))) break;
    await replyBtn.click().catch(() => {});
    await page.waitForTimeout(800);
  }
}

async function extractComment(item, parentPostId) {
  const authorLoc = item.locator(".comments-post-meta__name-text, .comments-comment-meta__description-title").first();
  const author = await safeText(authorLoc);

  const subLoc = item.locator(".comments-post-meta__headline, .comments-comment-meta__description-subtitle").first();
  const subDesc = await safeText(subLoc);

  const contentLoc = item.locator(".comments-comment-item__main-content .feed-shared-main-content, .comments-comment-item-content-body, .update-components-text").first();
  const content = await safeText(contentLoc, 1500);

  const timeLoc = item.locator(".comments-comment-meta__data, time").first();
  const postedAt = (await safeText(timeLoc)) || subDesc || null;

  const urn = await safeAttr(item, "data-id");
  const commentId = (urn && urn.match(/(\d{10,})/)?.[1]) || null;

  const reactionsText = await safeText(item.locator(".comments-comment-social-bar__reactions-count, .social-details-social-counts__reactions-count").first());
  const engagement = mergeEngagement({ likes: parseCompactNumber(reactionsText) });

  return {
    record_type: "linkedin_comment",
    post_id: commentId || `c_${Math.random().toString(36).slice(2, 10)}`,
    parent_post_id: parentPostId,
    url: null,
    author: author || null,
    author_handle: null,
    content: content || "",
    posted_at: postedAt,
    engagement,
  };
}

async function collectPostComments(page, post, args) {
  const url = post.url;
  if (!url) return [];
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);

  if (/\/login|\/authwall/.test(page.url())) {
    throw new Error(`auth wall on post page: ${page.url()}`);
  }

  // Scroll to bottom of the post to reveal comments section
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(900);
  }

  // Click "Most relevant" / "Show comments" trigger if comments are collapsed
  const showCommentsBtn = page.locator('button[aria-label*="comment" i], button:has-text("comments"), button:has-text("评论")').first();
  if (await showCommentsBtn.isVisible().catch(() => false)) {
    await showCommentsBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  const commentSelectors = [
    "article.comments-comment-entity",
    ".comments-comment-item",
    ".comments-comment-entity",
    "[data-id^='urn:li:comment:']",
  ];
  const combinedSelector = commentSelectors.join(", ");

  // Scroll to load more comments + click load buttons
  let prevCount = 0;
  let stable = 0;
  for (let i = 0; i < args.threadScrolls; i += 1) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(800);
    await expandAllReplies(page, page);
    const count = await page.locator(combinedSelector).count().catch(() => 0);
    if (count === prevCount) stable += 1;
    else stable = 0;
    if (stable >= 4) break;
    prevCount = count;
    if (args.maxCommentsPerPost > 0 && count >= args.maxCommentsPerPost * 1.5) break;
  }

  const items = await page.locator(combinedSelector).all();
  const seen = new Set();
  const comments = [];
  for (const item of items) {
    try {
      const parsed = await extractComment(item, post.post_id);
      const key = `${parsed.author}|${parsed.content}`.slice(0, 200);
      if (!parsed.content || seen.has(key)) continue;
      seen.add(key);
      const isReply = await item.evaluate((el) => Boolean(el.closest(".comments-comment-item__replies-list, .comments-comment-item__replies, .comments-comment-entity__replies-list, .comments-replies-list"))).catch(() => false);
      parsed.is_reply = !!isReply;
      comments.push(parsed);
      if (args.maxCommentsPerPost > 0 && comments.length >= args.maxCommentsPerPost) break;
    } catch { /* skip */ }
  }
  return comments;
}

function parentAsItem(post) {
  return {
    record_type: "linkedin_post",
    post_id: post.post_id,
    url: post.url,
    author: post.author,
    author_handle: post.author_handle,
    content: post.content,
    posted_at: post.posted_at,
    engagement: post.engagement,
  };
}

function commentAsItem(c) {
  return {
    record_type: "linkedin_comment",
    post_id: c.post_id,
    parent_post_id: c.parent_post_id,
    is_reply: c.is_reply,
    url: c.url,
    author: c.author,
    author_handle: c.author_handle,
    content: c.content,
    posted_at: c.posted_at,
    engagement: c.engagement,
  };
}

function buildNestedPosts(items) {
  const postsById = new Map();
  const parentChildren = new Map();
  const orphans = [];

  for (const item of items) {
    if (item.record_type === "linkedin_post") {
      postsById.set(item.post_id, { ...item, replies: [] });
    }
  }
  for (const item of items) {
    if (item.record_type !== "linkedin_comment") continue;
    const parentId = item.parent_post_id;
    if (parentId && postsById.has(parentId)) {
      parentChildren.set(parentId, [...(parentChildren.get(parentId) || []), item]);
    } else {
      orphans.push(item);
    }
  }

  const result = [];
  for (const [pid, post] of postsById) {
    const children = parentChildren.get(pid) || [];
    // Top-level comments first (is_reply=false), then attach replies under nearest preceding top-level
    const topLevel = children.filter((c) => !c.is_reply).map((c) => ({ ...c, replies: [] }));
    const replies = children.filter((c) => c.is_reply);
    // Naive: append all replies to the last top-level (LinkedIn DOM order preserves grouping)
    for (const reply of replies) {
      const target = topLevel[topLevel.length - 1];
      if (target) target.replies.push({ ...reply, replies: [] });
      else topLevel.push({ ...reply, replies: [] });
    }
    post.replies = topLevel;
    result.push(post);
  }
  if (orphans.length > 0) {
    result.push({
      id: "_orphan_comments",
      record_type: "orphan_bucket",
      replies: orphans.map((o) => ({ ...o, replies: [] })),
    });
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
      path.join("outputs", "source_crawls", `${timestampForPath()}_${slugify(args.keyword)}_linkedin_comments.json`),
  );

  const session = await newContextForSource({
    source: "linkedin",
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
    console.log(`[linkedin] collected ${posts.length} parent posts from search`);
    if (args.includePosts) rawItems.push(...posts.map(parentAsItem));

    if (!args.skipComments) {
      for (const [index, post] of posts.entries()) {
        console.log(`[linkedin] opening ${index + 1}/${posts.length}: ${post.url}`);
        try {
          const comments = await collectPostComments(session.page, post, args);
          console.log(`[linkedin] ${comments.length} comments from ${post.post_id}`);
          rawItems.push(...comments.map(commentAsItem));
        } catch (error) {
          crawlErrors[post.url] = `${error.name || "Error"}: ${error.message || error}`;
        }
      }
    } else {
      console.log(`[linkedin] --skip-comments enabled, skipping ${posts.length} thread pages`);
    }

    if (!session.usesPersistentProfile) {
      await saveContextState(session.context, args.authDir, "linkedin");
    }
  } finally {
    await closeBrowserSession(session);
  }

  const items = dedupeRawItems(rawItems).map((item, index) => makeItem("linkedin", index, item));
  if (items.length === 0) warnings.linkedin = "No LinkedIn posts/comments extracted. Check login state or LinkedIn anti-bot.";

  const postCount = items.filter((item) => item.record_type === "linkedin_post").length;
  const commentCount = items.filter((item) => item.record_type === "linkedin_comment").length;
  const nestedPosts = buildNestedPosts(items);
  const nestedReplies = nestedPosts.reduce((sum, p) => sum + countAllReplies(p), 0);

  const payload = {
    seed_query: args.keyword,
    run_date: todayIso(),
    collection_method: "crawler_only_no_llm_linkedin_thread_comments_deep_scroll",
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
      include_posts: args.includePosts,
      sort_by: args.sortBy,
      date_posted: args.datePosted,
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
