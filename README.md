# Twitter & Reddit Keyword Crawler

Playwright-based deep crawler for Twitter (X) and Reddit. Searches keywords, collects posts and all nested comments/replies as structured JSON. No API tokens or LLM required.

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

## Auth / Cookies

To use your existing Chrome login session:

```bash
# Option 1: Import cookies from a running Chrome (with remote debugging)
# Start Chrome with: --remote-debugging-port=9222
node scripts/import_chrome_cookies.mjs --source twitter --cdp-url http://127.0.0.1:9222

# Option 2: Interactive login
node scripts/crawl_twitter_comments.mjs --keyword test --headful
# Log in manually in the browser window, cookies are saved automatically

# Option 3: Use Chrome profile directly
node scripts/crawl_twitter_comments.mjs --keyword test --chrome-profile
```

## File Structure

```
scripts/
  browser.mjs                    # Browser session management (Playwright)
  utils.mjs                      # Shared utilities (slugify, enrichment, parsing)
  crawl_twitter_comments.mjs     # Twitter deep crawler (single keyword)
  crawl_reddit_comments.mjs      # Reddit deep crawler (single keyword)
  run_twitter_keyword_batch.mjs  # Twitter batch runner (multi-keyword)
  run_reddit_keyword_batch.mjs   # Reddit batch runner (multi-keyword)
  import_chrome_cookies.mjs      # Chrome cookie importer
  clone_chrome_profile.mjs       # Chrome profile cloner
```
