#!/usr/bin/env node
/**
 * Generate intent_analysis.md from a folder of crawl JSON files.
 *
 * Usage:
 *   node scripts/generate_intent_analysis.mjs --input-dir outputs/source_crawls/banxa/reddit
 *   node scripts/generate_intent_analysis.mjs --input-dir outputs/source_crawls/usdgo/twitter --platform twitter
 */
import fs from "node:fs/promises";
import path from "node:path";

// ── Args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input-dir") args.inputDir = argv[++i];
    else if (arg === "--platform") args.platform = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

// ── Helpers ─────────────────────────────────────────────────────────
function countRepliesDeep(replies) {
  let count = 0;
  for (const r of replies || []) {
    count += 1;
    count += countRepliesDeep(r.replies);
  }
  return count;
}

function flattenReplies(replies, out = []) {
  for (const r of replies || []) {
    out.push(r);
    flattenReplies(r.replies, out);
  }
  return out;
}

function topN(map, n = 20) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ── N-gram extraction ───────────────────────────────────────────────
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "about", "up",
  "it", "its", "this", "that", "these", "those", "i", "me", "my", "we",
  "our", "you", "your", "he", "him", "his", "she", "her", "they", "them",
  "their", "what", "which", "who", "whom", "re", "don", "t", "s", "ve",
  "ll", "d", "m", "amp", "gt", "lt", "https", "http", "www", "com",
  "get", "got", "like", "also", "still", "even", "much", "well", "way",
  "going", "make", "know", "think", "want", "see", "look", "use", "one",
  "two", "new", "now", "back", "time", "people", "good", "really", "right",
]);

function extractBigrams(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

// ── Intent classification (rule-based) ──────────────────────────────
const INTENT_RULES = [
  {
    id: "low_fee",
    label: "低费率 / 零费率",
    pattern: /\b(fee|fees|zero.?fee|no.?fee|low.?fee|cheap|expensive|cost|commission|spread|markup|overcharg|highway robbery)\b/i,
    emoji: "💰",
  },
  {
    id: "mobile_pay",
    label: "Apple Pay / Google Pay / 移动支付",
    pattern: /\b(apple\s*pay|google\s*pay|gpay|mobile\s*pay|one.?tap|one.?click|contactless)\b/i,
    emoji: "📱",
  },
  {
    id: "no_kyc",
    label: "免KYC / 隐私入金",
    pattern: /\b(no.?kyc|non.?kyc|without\s*kyc|skip\s*kyc|kyc.?free|privacy|anonymous|no.?registration|no.?id)\b/i,
    emoji: "🔒",
  },
  {
    id: "no_cex",
    label: "去CEX化 / 直接入金",
    pattern: /\b(no\s*cex|without\s*cex|don.?t\s*need\s*(a\s*)?(cex|exchange)|skip\s*(the\s*)?(cex|exchange)|directly|dex\s*only|wallet.?native)\b/i,
    emoji: "🏦",
  },
  {
    id: "embedded",
    label: "嵌入式 / SDK集成",
    pattern: /\b(embed|sdk|api\s*integrat|two\s*lines|widget|headless|plug.?and.?play|drop.?in|white.?label)\b/i,
    emoji: "🔌",
  },
  {
    id: "stablecoin_card",
    label: "稳定币消费卡 / Offramp日常化",
    pattern: /\b(virtual\s*card|debit\s*card|crypto\s*card|spend\s*(usdc|usdt|stablecoin|crypto)|card\s*spend|offramp.*(card|spend)|pay\s*with\s*(usdc|usdt|stablecoin|crypto))\b/i,
    emoji: "💳",
  },
  {
    id: "global_coverage",
    label: "全球可用 / 多币种",
    pattern: /\b(worldwide|global|multi.?currenc|local\s*currenc|available\s*in|countries|regions|cross.?border|emerging\s*market|africa|latin\s*america|southeast\s*asia|latam)\b/i,
    emoji: "🌍",
  },
  {
    id: "compliance",
    label: "合规 / 牌照 / MiCA",
    pattern: /\b(mica|complian|regulat|licens|aml|cft|travel\s*rule|legal|jurisdict|permit|authoriz)\b/i,
    emoji: "⚖️",
  },
  {
    id: "speed",
    label: "速度快 / 即时到账",
    pattern: /\b(instant|fast|quick|real.?time|seconds|minutes|slow|delay|pending|waiting|settlement)\b/i,
    emoji: "⚡",
  },
  {
    id: "ai_agent",
    label: "AI Agent 支付",
    pattern: /\b(ai\s*agent|autonomous\s*pay|programmatic\s*pay|mcp|x402|machine.?to.?machine|m2m|agent\s*pay)\b/i,
    emoji: "🤖",
  },
  {
    id: "bank_block",
    label: "银行封卡 / 风控问题",
    pattern: /\b(bank\s*(block|reject|flag|freez|clos|cancel|restrict|monitor|ban)|card\s*(declin|block|reject)|flagged|frozen\s*account|suspicious)\b/i,
    emoji: "🚫",
  },
  {
    id: "stablecoin_payment",
    label: "稳定币支付 / B2B结算",
    pattern: /\b(stablecoin\s*pay|usdt\s*pay|usdc\s*pay|crypto\s*pay|b2b\s*pay|invoice|settlement|payroll|treasury|merchant|vendor|supplier)\b/i,
    emoji: "🏢",
  },
];

function classifyIntents(text) {
  const matched = [];
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) {
      matched.push(rule.id);
    }
  }
  return matched;
}

// ── Pain point extraction ───────────────────────────────────────────
const PAIN_RULES = [
  { id: "high_fee", label: "费率太高", pattern: /\b(expensive|overcharg|high.?fee|ridiculous.?fee|highway\s*robbery|too\s*much|rip.?off|2.?3\s*%|5\s*%)\b/i },
  { id: "kyc_friction", label: "KYC流程繁琐", pattern: /\b(kyc.*(slow|annoying|frustrat|pain|hard|difficult|takes|forever|hours|days|wait)|hate\s*kyc|stupid\s*kyc)\b/i },
  { id: "bank_block", label: "银行封卡/风控", pattern: /\b(bank\s*(block|reject|flag|freez|clos|cancel|restrict|monitor|ban)|card\s*(declin|block|reject)|flagged|frozen)\b/i },
  { id: "region_restrict", label: "地区限制", pattern: /\b(not\s*available|unavailable|restricted|geo.?block|not\s*supported|my\s*country|region\s*lock|can.?t\s*access)\b/i },
  { id: "slow_settlement", label: "到账慢", pattern: /\b(slow|takes\s*(days|hours|forever)|pending|delay|waiting|settlement\s*time|when\s*will)\b/i },
  { id: "complex_integration", label: "集成复杂", pattern: /\b(complex|complicated|difficult\s*to\s*integrat|hard\s*to\s*(set\s*up|integrat)|documentation\s*suck|confusing\s*api)\b/i },
  { id: "scam_risk", label: "诈骗/安全风险", pattern: /\b(scam|fraud|hack|phishing|rug\s*pull|lost\s*fund|stolen|suspicious|fake)\b/i },
];

function classifyPains(text) {
  const matched = [];
  for (const rule of PAIN_RULES) {
    if (rule.pattern.test(text)) matched.push(rule.id);
  }
  return matched;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.inputDir) {
    console.log("Usage: node generate_intent_analysis.mjs --input-dir <dir> [--platform twitter|reddit] [--output <path>]");
    return;
  }

  // Detect platform from dir name if not specified
  const platform = args.platform || (args.inputDir.includes("twitter") ? "twitter" : "reddit");
  const projectLabel = args.inputDir.includes("banxa") ? "Banxa (Crypto On/Off Ramp)" : args.inputDir.includes("usdgo") ? "USDGo (USDT/Stablecoin Payment)" : path.basename(args.inputDir);
  const platformLabel = platform === "twitter" ? "Twitter" : "Reddit";

  // Load all JSON files
  const files = (await fs.readdir(args.inputDir)).filter((f) => f.endsWith(".json") && f !== "summary.json");
  const allPosts = [];
  const allItems = []; // posts + all flattened replies
  const keywordStats = [];

  for (const file of files) {
    const filePath = path.join(args.inputDir, file);
    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    const posts = data.posts || [];
    const keyword = data.seed_query || path.basename(file, ".json");
    let commentCount = 0;
    for (const post of posts) {
      allPosts.push(post);
      allItems.push(post);
      const replies = flattenReplies(post.replies);
      commentCount += replies.length;
      allItems.push(...replies);
    }
    keywordStats.push({ keyword, posts: posts.length, comments: commentCount });
  }

  const totalPosts = allPosts.length;
  const totalComments = allItems.length - totalPosts;
  const totalItems = allItems.length;

  // ── Discourse type distribution ──
  const discourseMap = new Map();
  for (const item of allItems) {
    const dt = item.discourse_type || "unknown";
    discourseMap.set(dt, (discourseMap.get(dt) || 0) + 1);
  }

  // ── Entity frequency ──
  const entityMap = new Map();
  for (const item of allItems) {
    for (const entity of item.mentioned_entities || []) {
      if (entity.startsWith("@")) continue; // skip @handles for top entities
      entityMap.set(entity, (entityMap.get(entity) || 0) + 1);
    }
  }

  // ── Top @handles ──
  const handleMap = new Map();
  for (const item of allItems) {
    for (const entity of item.mentioned_entities || []) {
      if (entity.startsWith("@")) {
        handleMap.set(entity, (handleMap.get(entity) || 0) + 1);
      }
    }
  }

  // ── Bigram frequency ──
  const bigramMap = new Map();
  for (const item of allItems) {
    const text = [item.title, item.content].filter(Boolean).join(" ");
    for (const bg of extractBigrams(text)) {
      bigramMap.set(bg, (bigramMap.get(bg) || 0) + 1);
    }
  }

  // ── Region distribution ──
  const regionMap = new Map();
  for (const item of allItems) {
    const r = item.region || "unknown";
    regionMap.set(r, (regionMap.get(r) || 0) + 1);
  }

  // ── Intent classification ──
  const intentCounts = new Map();
  const intentExamples = new Map(); // store top-engagement examples per intent
  for (const item of allItems) {
    const text = [item.title, item.content].filter(Boolean).join(" ");
    const intents = classifyIntents(text);
    for (const intent of intents) {
      intentCounts.set(intent, (intentCounts.get(intent) || 0) + 1);
      // Store high-engagement examples
      const likes = item.engagement?.likes || item.engagement?.upvotes || item.engagement?.votes || 0;
      const examples = intentExamples.get(intent) || [];
      if (examples.length < 5 || likes > (examples[examples.length - 1]?.likes || 0)) {
        examples.push({ text: (item.content || "").slice(0, 120), likes, url: item.url });
        examples.sort((a, b) => b.likes - a.likes);
        if (examples.length > 5) examples.pop();
        intentExamples.set(intent, examples);
      }
    }
  }

  // ── Pain point classification ──
  const painCounts = new Map();
  const painExamples = new Map();
  for (const item of allItems) {
    if (item.discourse_type !== "user_pain" && item.discourse_type !== "user_question") continue;
    const text = [item.title, item.content].filter(Boolean).join(" ");
    const pains = classifyPains(text);
    for (const pain of pains) {
      painCounts.set(pain, (painCounts.get(pain) || 0) + 1);
      const likes = item.engagement?.likes || item.engagement?.upvotes || item.engagement?.votes || 0;
      const examples = painExamples.get(pain) || [];
      if (examples.length < 3 || likes > (examples[examples.length - 1]?.likes || 0)) {
        examples.push({ text: (item.content || "").slice(0, 120), likes });
        examples.sort((a, b) => b.likes - a.likes);
        if (examples.length > 3) examples.pop();
        painExamples.set(pain, examples);
      }
    }
  }

  // ── High engagement posts ──
  const topEngagement = [...allPosts]
    .map((p) => ({
      ...p,
      score: (p.engagement?.likes || 0) + (p.engagement?.retweets || 0) + (p.engagement?.upvotes || 0) + (p.engagement?.votes || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  // ── Generate markdown ──
  const DISCOURSE_LABELS = {
    industry_news: "行业新闻/公告",
    user_question: "用户提问",
    user_pain: "用户痛点",
    builder_observation: "Builder 观察",
    user_wish: "用户需求/愿望",
    marketing_pr: "营销/PR",
    user_review: "用户评价",
    industry_analysis: "行业分析",
    builder_question: "Builder 提问",
    governance_proposal: "治理提案",
    unknown: "未分类",
  };

  let md = "";
  md += `# ${projectLabel} ${platformLabel} 高频意图分析\n\n`;
  md += `> 数据来源：${files.length} 个搜索词，${totalPosts} 条父帖 + ${totalComments} 条评论，共 ${totalItems} 条\n`;
  md += `> 爬取时间：${new Date().toISOString().slice(0, 10)}\n`;
  md += `> 分析方法：关键词频率 + 意图分类 + 高赞帖聚类\n\n`;
  md += `---\n\n`;

  // Section 1: Keyword stats
  md += `## 一、关键词数据概览\n\n`;
  md += `| 关键词 | 帖子 | 评论 |\n|--------|------|------|\n`;
  for (const ks of keywordStats.sort((a, b) => b.comments - a.comments)) {
    md += `| ${ks.keyword} | ${ks.posts} | ${ks.comments.toLocaleString()} |\n`;
  }
  md += `\n---\n\n`;

  // Section 2: Discourse type distribution
  md += `## 二、话语类型分布\n\n`;
  md += `| 类型 | 数量 | 占比 |\n|------|------|------|\n`;
  for (const [dt, count] of topN(discourseMap, 15)) {
    const label = DISCOURSE_LABELS[dt] || dt;
    const pct = ((count / totalItems) * 100).toFixed(1);
    md += `| ${label} (${dt}) | ${count.toLocaleString()} | ${pct}% |\n`;
  }
  md += `\n---\n\n`;

  // Section 3: Entity frequency
  md += `## 三、高频实体 Top 20（被提及最多的产品/品牌）\n\n`;
  md += `| 排名 | 实体 | 提及次数 |\n|------|------|----------|\n`;
  for (const [i, [entity, count]] of topN(entityMap, 20).entries()) {
    md += `| ${i + 1} | **${entity}** | ${count.toLocaleString()} |\n`;
  }
  md += `\n---\n\n`;

  // Section 4: Top handles
  if (handleMap.size > 0) {
    md += `## 四、高频 @账号 Top 15\n\n`;
    md += `| 排名 | 账号 | 提及次数 |\n|------|------|----------|\n`;
    for (const [i, [handle, count]] of topN(handleMap, 15).entries()) {
      md += `| ${i + 1} | ${handle} | ${count.toLocaleString()} |\n`;
    }
    md += `\n---\n\n`;
  }

  // Section 5: High-frequency bigrams
  md += `## 五、高频关键词组合 Top 30\n\n`;
  md += `| 关键词组 | 频次 |\n|----------|------|\n`;
  for (const [bg, count] of topN(bigramMap, 30)) {
    md += `| ${bg} | ${count.toLocaleString()} |\n`;
  }
  md += `\n---\n\n`;

  // Section 6: Core user intents
  md += `## 六、核心用户意图分类\n\n`;
  const sortedIntents = [...intentCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [intentId, count] of sortedIntents) {
    const rule = INTENT_RULES.find((r) => r.id === intentId);
    if (!rule) continue;
    const pct = ((count / totalItems) * 100).toFixed(1);
    const stars = count > totalItems * 0.1 ? "⭐⭐⭐⭐⭐" : count > totalItems * 0.05 ? "⭐⭐⭐⭐" : count > totalItems * 0.02 ? "⭐⭐⭐" : "⭐⭐";
    md += `### ${rule.emoji} ${rule.label} ${stars}\n\n`;
    md += `**频率：${count.toLocaleString()} 条 (${pct}%)**\n\n`;

    const examples = intentExamples.get(intentId) || [];
    if (examples.length > 0) {
      md += `典型讨论：\n`;
      for (const ex of examples.slice(0, 3)) {
        const snippet = ex.text.replace(/\n/g, " ").trim();
        if (snippet) md += `- "${snippet}..." ${ex.likes > 0 ? `(${ex.likes.toLocaleString()} likes)` : ""}\n`;
      }
    }
    md += `\n---\n\n`;
  }

  // Section 7: Pain points
  md += `## 七、痛点排行（按频率）\n\n`;
  md += `| 排名 | 痛点 | 提及次数 | 严重程度 |\n|------|------|----------|----------|\n`;
  const sortedPains = [...painCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [i, [painId, count]] of sortedPains.entries()) {
    const rule = PAIN_RULES.find((r) => r.id === painId);
    if (!rule) continue;
    const severity = count > 200 ? "🔴🔴🔴" : count > 100 ? "🔴🔴" : "🔴";
    md += `| ${i + 1} | **${rule.label}** | ${count.toLocaleString()} | ${severity} |\n`;
  }
  md += `\n---\n\n`;

  // Section 8: Region distribution
  md += `## 八、地区分布\n\n`;
  md += `| 地区 | 数量 | 占比 |\n|------|------|------|\n`;
  for (const [region, count] of topN(regionMap, 15)) {
    const pct = ((count / totalItems) * 100).toFixed(1);
    md += `| ${region} | ${count.toLocaleString()} | ${pct}% |\n`;
  }
  md += `\n---\n\n`;

  // Section 9: Top engagement posts
  md += `## 九、高赞帖 Top 15\n\n`;
  for (const [i, post] of topEngagement.entries()) {
    const snippet = (post.content || post.title || "").replace(/\n/g, " ").trim().slice(0, 150);
    const likes = post.engagement?.likes || post.engagement?.upvotes || post.engagement?.votes || 0;
    const retweets = post.engagement?.retweets || post.engagement?.shares || 0;
    const sub = post.subreddit ? ` | r/${post.subreddit}` : "";
    md += `${i + 1}. **${snippet}...** — ${likes.toLocaleString()} likes${retweets ? `, ${retweets.toLocaleString()} retweets` : ""}${sub}\n`;
  }
  md += `\n`;

  // Write output
  const outputPath = args.output || path.join(args.inputDir, "intent_analysis.md");
  await fs.writeFile(outputPath, md, "utf8");
  console.log(`✅ Generated ${outputPath} (${totalItems.toLocaleString()} items from ${files.length} keywords)`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
