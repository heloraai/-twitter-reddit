# Twitter, Reddit & LinkedIn Keyword Crawler

Playwright-based deep crawler for Twitter (X), Reddit and LinkedIn. Searches keywords, collects posts and all nested comments/replies as structured JSON. No API tokens or LLM required.

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

### Single keyword

```bash
# Twitter
node scripts/crawl_twitter_comments.mjs --keyword "crypto payment" --output output.json

# Reddit
node scripts/crawl_reddit_comments.mjs --keyword "crypto payment" --output output.json

# LinkedIn (search + post extraction; use --skip-comments for fast mode)
node scripts/crawl_linkedin_comments.mjs --keyword "EOR Singapore" --skip-comments --output output.json
```

### Batch (multiple keywords)

```bash
# Twitter batch
node scripts/run_twitter_keyword_batch.mjs \
  --keywords "USDT payment,stablecoin payment,crypto payment" \
  --output-dir outputs/twitter

# Reddit batch
node scripts/run_reddit_keyword_batch.mjs \
  --keywords "USDT payment,stablecoin payment,crypto payment" \
  --output-dir outputs/reddit

# LinkedIn batch
node scripts/run_linkedin_keyword_batch.mjs \
  --keywords "EOR Singapore,Asia payroll,global employment" \
  --skip-comments \
  --output-dir outputs/linkedin
```

### Using a keywords file

```bash
node scripts/run_twitter_keyword_batch.mjs --keywords-file keywords.txt --output-dir outputs/twitter
```

## Options

### Twitter crawler

| Flag | Default | Description |
|------|---------|-------------|
| `--keyword` | required | Search keyword |
| `--output` | auto | Output JSON path |
| `--max-posts` | 100 | Max posts to collect |
| `--max-comments-per-post` | 99999 | Max comments per post |
| `--search-scrolls` | 80 | Search page scroll count |
| `--thread-scrolls` | 220 | Thread page scroll count |
| `--search-mode` | live | Search tab: live, top, latest |
| `--tree-mode` | network | Comment collection: network (intercept API) or dom |
| `--headful` | false | Show browser window |
| `--cdp-url` | null | Connect to running Chrome via CDP |

Twitter batch flag: `--restart-every` controls how many keywords before clearing `storageState` and cooling down 90s (mitigates rate-limit). When using logged-in cookies via `extract_chrome_cookies.mjs`, set `--restart-every 999` to avoid wiping the session.

### Reddit crawler

| Flag | Default | Description |
|------|---------|-------------|
| `--keyword` | required | Search keyword |
| `--output` | auto | Output JSON path |
| `--max-posts` | 100 | Max posts to collect |
| `--max-comments-per-post` | 999999 | Max comments per post (unlimited) |
| `--search-scrolls` | 60 | Search page scroll count |
| `--thread-scrolls` | 80 | Thread page scroll count |
| `--sort-mode` | relevance | Reddit sort: relevance, hot, new, top |
| `--time-range` | year | Time filter: hour, day, week, month, year, all |
| `--headful` | true | Show browser window |
| `--cdp-url` | null | Connect to running Chrome via CDP |

### LinkedIn crawler

LinkedIn requires login. Use `extract_chrome_cookies.mjs` to inject your existing Chrome session before running.

| Flag | Default | Description |
|------|---------|-------------|
| `--keyword` | required | Search keyword |
| `--output` | auto | Output JSON path |
| `--max-posts` | 50 | Max posts to collect |
| `--max-comments-per-post` | 200 | Max comments per post |
| `--search-scrolls` | 80 | Search page scrolls |
| `--thread-scrolls` | 60 | Post detail page scrolls |
| `--sort-by` | relevance | LinkedIn sort: relevance, date_posted |
| `--date-posted` | past-year | past-24h, past-week, past-month, past-year, anytime |
| `--skip-comments` | false | Skip comment extraction (fast, post-level only) |
| `--headful` | false | Show browser window |

## Auth / Cookies

### Recommended: extract cookies from your existing Chrome profile

`extract_chrome_cookies.mjs` reads Chrome's encrypted cookie database, decrypts with the macOS Keychain key, and writes a Playwright-compatible `storageState.json`. **macOS only.**

```bash
# Twitter
node scripts/extract_chrome_cookies.mjs twitter "Profile 1"

# LinkedIn
node scripts/extract_chrome_cookies.mjs linkedin "Profile 1"

# Reddit
node scripts/extract_chrome_cookies.mjs reddit "Profile 1"
```

Requires `better-sqlite3`:
```bash
npm install better-sqlite3
```

### Alternative: manual login

```bash
# Headful: opens browser, log in once, cookies saved automatically
node scripts/crawl_twitter_comments.mjs --keyword test --headful

# CDP: start Chrome with --remote-debugging-port=9222
node scripts/import_chrome_cookies.mjs --source twitter --cdp-url http://127.0.0.1:9222

# Direct Chrome profile (Chrome must be closed first OR cloned via clone_chrome_profile.mjs)
node scripts/clone_chrome_profile.mjs --profile-directory "Profile 1" --output-dir .crawler-chrome-profile
node scripts/crawl_twitter_comments.mjs --keyword test --use-chrome-profile \
  --chrome-user-data-dir .crawler-chrome-profile --profile-directory "Profile 1"
```

## Intent analysis

After crawling, generate a high-frequency intent / pain-point report:

```bash
node scripts/generate_intent_analysis.mjs --input-dir outputs/twitter --platform twitter
node scripts/generate_intent_analysis.mjs --input-dir outputs/reddit --platform reddit
node scripts/generate_intent_analysis.mjs --input-dir outputs/linkedin --platform linkedin
```

Produces `intent_analysis.md` summarizing 12 intent types, 7 pain-point categories, mentioned entities, regions, top engaging posts.

## Output Format

Each keyword produces a JSON file:

```json
{
  "seed_query": "crypto payment",
  "run_date": "2025-05-18",
  "stats": { "parent_posts": 100, "total_comments": 2400 },
  "crawl_config": { ... },
  "posts": [
    {
      "id": "tw_001",
      "source": "twitter",
      "url": "https://x.com/user/status/123",
      "author": "User Name",
      "content": "Post text...",
      "posted_at": "2025-05-01",
      "engagement": { "likes": 42, "retweets": 5 },
      "region": "US",
      "language": "en",
      "discourse_type": "user_question",
      "mentioned_entities": ["MoonPay", "USDT"],
      "replies": [
        {
          "id": "tw_002",
          "content": "Reply text...",
          "replies": [ ... ]
        }
      ]
    }
  ]
}
```

## File Structure

```
scripts/
  browser.mjs                    # Browser session management (Playwright)
  utils.mjs                      # Shared utilities (slugify, enrichment, parsing)
  crawl_twitter_comments.mjs     # Twitter deep crawler (single keyword)
  crawl_reddit_comments.mjs      # Reddit deep crawler (single keyword)
  crawl_linkedin_comments.mjs    # LinkedIn crawler (single keyword)
  run_twitter_keyword_batch.mjs  # Twitter batch runner
  run_reddit_keyword_batch.mjs   # Reddit batch runner
  run_linkedin_keyword_batch.mjs # LinkedIn batch runner
  generate_intent_analysis.mjs   # Rule-based intent / pain-point analysis
  extract_chrome_cookies.mjs     # Decrypt Chrome cookies → storageState (macOS)
  import_chrome_cookies.mjs      # Chrome cookie importer via CDP
  clone_chrome_profile.mjs       # Chrome profile cloner
```
