import fs from "node:fs/promises";
import path from "node:path";

const REGION_RULES = [
  ["HK", /\b(hong kong|hk|香港)\b/i],
  ["US", /\b(us|usa|united states|america|venmo|ach)\b/i],
  ["EU", /\b(eu|europe|sepa|mica|eur)\b/i],
  ["UK", /\b(uk|britain|gbp|faster payment|london)\b/i],
  ["CN", /\b(china|cn|rmb|cny|中国|人民币)\b/i],
  ["JP", /\b(japan|jp|jpy|yen|日本)\b/i],
  ["SG", /\b(singapore|sg|sgd|新加坡)\b/i],
  ["KR", /\b(korea|kr|krw|韩国|한국)\b/i],
  ["IN", /\b(india|inr|upi|印度)\b/i],
  ["LATAM", /\b(latam|latin america|brazil|mexico|argentina|brl|mxn)\b/i],
  ["SEA", /\b(sea|southeast asia|philippines|vietnam|thailand|indonesia)\b/i],
  ["MENA", /\b(mena|dubai|uae|saudi|middle east)\b/i],
];

const KNOWN_ENTITIES = [
  "MoonPay",
  "Stripe",
  "Coinbase",
  "Ramp",
  "Onramp",
  "Onramper",
  "Banxa",
  "Transak",
  "Mercuryo",
  "Alchemy Pay",
  "PayPal",
  "Venmo",
  "Revolut",
  "Apple Pay",
  "Google Pay",
  "USDC",
  "USDT",
  "Base",
  "Solana",
  "Ethereum",
  "zkp2p",
  "Bridge",
  "Fireblocks",
  "SEPA",
  "MiCA",
];

export const SOURCE_PREFIX = {
  twitter: "tw",
  reddit: "rd",
  farcaster: "fc",
  snapshot_tally: "gv",
  medium: "md",
  mirror: "mr",
  linkedin: "li",
  quora: "qa",
};

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function timestampForPath() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function queryVariants(keyword) {
  const clean = normalizeSpace(keyword).toLowerCase();
  const variants = [clean];
  if (/\bfiat\s+offramp\b/.test(clean)) {
    variants.push(
      "fiat off ramp",
      "fiat off-ramp",
      "crypto to fiat",
      "crypto fiat offramp",
      "offramp fiat",
      "off ramp crypto fiat",
      "onramp offramp fiat",
      "crypto offramps",
      "cash out crypto fiat",
      "convert crypto to fiat",
    );
  } else if (/\bfiat\s+onramp\b/.test(clean)) {
    variants.push(
      "fiat on ramp",
      "fiat on-ramp",
      "fiat to crypto",
      "crypto fiat onramp",
      "onramp fiat",
      "on ramp crypto fiat",
      "onramp offramp fiat",
      "crypto onramps",
      "buy crypto with fiat",
      "convert fiat to crypto",
    );
  }
  return [...new Set(variants)];
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function absoluteFromCwd(file) {
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function safeText(locator, timeout = 1200) {
  try {
    return normalizeSpace(await locator.innerText({ timeout }));
  } catch {
    return "";
  }
}

export async function safeAttr(locator, name, timeout = 1200) {
  try {
    return await locator.getAttribute(name, { timeout });
  } catch {
    return null;
  }
}

export async function scrollForResults(page, selector, targetCount, maxScrolls = 18) {
  let stableRounds = 0;
  let lastCount = 0;
  for (let i = 0; i < maxScrolls; i += 1) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count >= targetCount) return count;
    stableRounds = count === lastCount ? stableRounds + 1 : 0;
    if (stableRounds >= 4) return count;
    lastCount = count;
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(900);
  }
  return page.locator(selector).count().catch(() => 0);
}

export function parseCompactNumber(raw) {
  if (raw == null) return null;
  const text = String(raw).replace(/,/g, "").trim().toLowerCase();
  if (!text || /(^-|^n\/a$)/.test(text)) return null;
  const match = text.match(/([\d.]+)\s*([km万])?/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  if (unit === "k") return Math.round(value * 1000);
  if (unit === "m") return Math.round(value * 1000000);
  if (unit === "万") return Math.round(value * 10000);
  return Math.round(value);
}

export function parseEngagementLabel(label) {
  const text = normalizeSpace(label).toLowerCase();
  const engagement = {};
  const pairs = [
    ["comments", /(?:\b([\d.,]+[km万]?)\s*(replies|reply|comments|comment)\b|([\d.,]+[km万]?)\s*条?评论)/i],
    [
      "retweets",
      /(?:\b([\d.,]+[km万]?)\s*(reposts|repost|retweets|retweet|shares|share|recasts|recast)\b|([\d.,]+[km万]?)\s*(次)?(转发|分享))/i,
    ],
    ["likes", /(?:\b([\d.,]+[km万]?)\s*(likes|like|claps|clap|upvotes|upvote)\b|([\d.,]+[km万]?)\s*(赞|次赞|拍手))/i],
    ["views", /(?:\b([\d.,]+[km万]?)\s*(views|view)\b|([\d.,]+[km万]?)\s*(次)?浏览)/i],
    ["votes", /(?:\b([\d.,]+[km万]?)\s*(votes|vote)\b|([\d.,]+[km万]?)\s*票)/i],
  ];
  for (const [key, regex] of pairs) {
    const match = text.match(regex);
    if (match) engagement[key] = parseCompactNumber(match[1] || match[3]);
  }
  return engagement;
}

export function mergeEngagement(...parts) {
  const out = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part || {})) {
      if (value != null && out[key] == null) out[key] = value;
    }
  }
  return out;
}

export function detectLanguage(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  return "en";
}

export function inferRegion(text) {
  for (const [region, regex] of REGION_RULES) {
    if (regex.test(text)) return region;
  }
  return "unknown";
}

export function classifyDiscourse(text, source) {
  const lower = text.toLowerCase();
  if (source === "snapshot_tally") return "governance_proposal";
  if (/\?$|\bhow do i\b|\bhow to\b|\bwhat is\b|\bbest\b|\bwhich\b|\bcan i\b/.test(lower)) {
    return lower.includes("api") || lower.includes("sdk") || lower.includes("merchant")
      ? "builder_question"
      : "user_question";
  }
  if (/\b(error|blocked|stuck|failed|problem|issue|expensive|kyc|fee|fees|slow|cannot|can't)\b/.test(lower)) {
    return "user_pain";
  }
  if (/\b(wish|would love|need|should add|feature request)\b/.test(lower)) return "user_wish";
  if (/\b(review|tried|used|experience|honest)\b/.test(lower)) return "user_review";
  if (/\b(launch|introducing|integrated|now support|is live|powered by|announcing)\b/.test(lower)) {
    return "marketing_pr";
  }
  if (/\b(building|developer|api|sdk|mini app|dapp|protocol)\b/.test(lower)) return "builder_observation";
  if (/\b(report|analysis|pattern|market|industry|regulation)\b/.test(lower)) return "industry_analysis";
  if (source === "medium" || source === "mirror" || source === "linkedin" || source === "quora") {
    return "industry_analysis";
  }
  return "industry_news";
}

export function extractMentionedEntities(text) {
  const found = new Set();
  for (const entity of KNOWN_ENTITIES) {
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) found.add(entity);
  }
  for (const match of text.matchAll(/(^|\s)@([A-Za-z0-9_]{2,30})/g)) {
    found.add(`@${match[2]}`);
  }
  for (const match of text.matchAll(/\$[A-Z][A-Z0-9]{1,12}\b/g)) {
    found.add(match[0]);
  }
  return [...found].slice(0, 12);
}

export function makeItem(source, index, raw) {
  const text = normalizeSpace([raw.title, raw.content].filter(Boolean).join(" "));
  const prefix = SOURCE_PREFIX[source] || source.slice(0, 2);
  const item = {
    id: `${prefix}_${String(index + 1).padStart(3, "0")}`,
    source,
    url: raw.url || null,
    author: raw.author || null,
    author_handle: raw.author_handle || null,
    content: raw.content || raw.title || "",
    posted_at: raw.posted_at || null,
    engagement: raw.engagement || {},
    region: raw.region || inferRegion(text),
    language: raw.language || detectLanguage(text),
    discourse_type: raw.discourse_type || classifyDiscourse(text, source),
    mentioned_entities: raw.mentioned_entities || extractMentionedEntities(text),
  };
  for (const key of [
    "title",
    "subreddit",
    "proposal_id",
    "dao",
    "seed_query_variant",
    "record_type",
    "tweet_id",
    "parent_tweet_id",
    "parent_tweet_url",
    "parent_author",
    "parent_author_handle",
    "parent_content",
    "parent_posted_at",
    "reply_to_tweet_id",
    "reply_to_tweet_url",
    "reply_to_author_handle",
    "replying_to_author_handles",
    "thread_position",
    "reply_depth",
    "post_id",
    "parent_post_id",
    "is_reply",
    "urn",
  ]) {
    if (raw[key] != null) item[key] = raw[key];
  }
  return item;
}

export function dedupeRawItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.url || normalizeSpace([item.author_handle, item.title, item.content].join("|")).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function buildSearchUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }
  return url.toString();
}
