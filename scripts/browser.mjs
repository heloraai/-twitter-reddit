import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { ensureDir, fileExists } from "./utils.mjs";

export const DEFAULT_CHROME_USER_DATA_DIR = path.join(
  process.env.HOME || "",
  "Library",
  "Application Support",
  "Google",
  "Chrome",
);

export const SOURCE_HOME = {
  twitter: "https://x.com/home",
  reddit: "https://www.reddit.com/",
  farcaster: "https://warpcast.com/",
  snapshot_tally: "https://www.tally.xyz/",
  medium: "https://medium.com/",
  mirror: "https://mirror.xyz/",
  linkedin: "https://www.linkedin.com/feed/",
  quora: "https://www.quora.com/",
};

export function storageStatePath(authDir, source) {
  return path.join(authDir, `${source}.storageState.json`);
}

export async function newContextForSource({
  source,
  authDir,
  headful = false,
  useChromeProfile = false,
  chromeUserDataDir = DEFAULT_CHROME_USER_DATA_DIR,
  profileDirectory = "Default",
  cdpUrl = null,
}) {
  const contextOptions = {
    viewport: { width: 1440, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    locale: "en-US",
  };
  if (source === "linkedin") {
    delete contextOptions.userAgent;
  }

  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] || (await browser.newContext(contextOptions));
    const page = await context.newPage();
    return {
      browser,
      context,
      page,
      statePath: null,
      usesPersistentProfile: true,
      usesRemoteBrowser: true,
    };
  }

  if (useChromeProfile) {
    let context;
    try {
      context = await chromium.launchPersistentContext(chromeUserDataDir, {
        ...contextOptions,
        channel: "chrome",
        headless: false,
        args: [`--profile-directory=${profileDirectory}`],
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (/正在现有的浏览器会话中打开|existing browser session|ProcessSingleton|Singleton/i.test(message)) {
        throw new Error(
          `Chrome profile "${profileDirectory}" is already open. Quit Chrome first, or restart Chrome with --remote-debugging-port=9222 and pass --cdp-url http://127.0.0.1:9222.`,
        );
      }
      throw error;
    }
    const page = context.pages()[0] || (await context.newPage());
    return {
      browser: null,
      context,
      page,
      statePath: null,
      usesPersistentProfile: true,
    };
  }

  await ensureDir(authDir);
  const browser = await chromium.launch({ headless: !headful });
  const statePath = storageStatePath(authDir, source);
  if (await fileExists(statePath)) {
    contextOptions.storageState = statePath;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  return { browser, context, page, statePath };
}

export async function saveContextState(context, authDir, source) {
  await ensureDir(authDir);
  const statePath = storageStatePath(authDir, source);
  await context.storageState({ path: statePath });
  return statePath;
}

export async function importSourceCookiesFromCdp({ source, authDir, cdpUrl }) {
  const home = SOURCE_HOME[source];
  if (!home) throw new Error(`Unknown source for cookie import: ${source}`);
  await ensureDir(authDir);
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error(`No browser context found at ${cdpUrl}`);
    const page = await context.newPage();
    try {
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);
      return await saveContextState(context, authDir, source);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    browser.disconnect();
  }
}

export async function closeBrowserSession({ browser, context, usesRemoteBrowser = false }) {
  if (usesRemoteBrowser) {
    return;
  }
  if (browser) {
    await browser.close();
    return;
  }
  await context.close();
}

export async function runLoginFlow({ source, authDir }) {
  const home = SOURCE_HOME[source];
  if (!home) throw new Error(`Unknown source for login: ${source}`);
  const { browser, context, page } = await newContextForSource({ source, authDir, headful: true });
  await page.goto(home, { waitUntil: "domcontentloaded", timeout: 60000 });
  const rl = readline.createInterface({ input, output });
  await rl.question(`Log in to ${source} in the opened browser, then press Enter here to save cookies...`);
  rl.close();
  const statePath = await saveContextState(context, authDir, source);
  await closeBrowserSession({ browser, context });
  return statePath;
}
