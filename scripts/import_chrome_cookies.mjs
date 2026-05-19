#!/usr/bin/env node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDir } from "./utils.mjs";

const SOURCE_DOMAINS = {
  twitter: ["x.com", "twitter.com"],
  reddit: ["reddit.com"],
  farcaster: ["warpcast.com"],
  snapshot_tally: ["tally.xyz", "snapshot.box", "snapshot.org"],
  medium: ["medium.com"],
  mirror: ["mirror.xyz"],
  linkedin: ["linkedin.com"],
  quora: ["quora.com"],
};

const CHROME_EPOCH_OFFSET_US = 11644473600000000;
const DEFAULT_PROFILE = "Profile 1";

function parseArgs(argv) {
  const args = {
    profileDirectory: DEFAULT_PROFILE,
    authDir: ".crawler-auth",
    sources: Object.keys(SOURCE_DOMAINS),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile-directory") args.profileDirectory = argv[++i];
    else if (arg === "--auth-dir") args.authDir = argv[++i];
    else if (arg === "--sources") args.sources = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function chromeCookiesPath(profileDirectory) {
  const profilePath = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    profileDirectory,
  );
  const candidates = [
    path.join(profilePath, "Network", "Cookies"),
    path.join(profilePath, "Cookies"),
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || candidates[0];
}

function chromeTimeToUnixSeconds(value) {
  const asNumber = Number(value || 0);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return -1;
  return Math.floor((asNumber - CHROME_EPOCH_OFFSET_US) / 1_000_000);
}

function sameSiteFromChrome(value) {
  if (value === 1) return "Lax";
  if (value === 2) return "Strict";
  return "None";
}

function getChromeSafeStoragePassword() {
  return execFileSync("security", [
    "find-generic-password",
    "-w",
    "-s",
    "Chrome Safe Storage",
    "-a",
    "Chrome",
  ], { encoding: "utf8" }).trim();
}

function chromeCookieKey() {
  return crypto.pbkdf2Sync(
    getChromeSafeStoragePassword(),
    "saltysalt",
    1003,
    16,
    "sha1",
  );
}

function decryptChromeCookie({ hostKey, value, encryptedHex, key }) {
  if (value) return value;
  if (!encryptedHex) return "";
  const encrypted = Buffer.from(encryptedHex, "hex");
  if (encrypted.length === 0) return "";
  if (!encrypted.subarray(0, 3).equals(Buffer.from("v10"))) {
    return "";
  }
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  const decrypted = Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]);
  const hostDigest = crypto.createHash("sha256").update(hostKey).digest();
  if (decrypted.length > 32 && decrypted.subarray(0, 32).equals(hostDigest)) {
    return decrypted.subarray(32).toString("utf8");
  }
  return decrypted.toString("utf8");
}

function loadRows(cookiesDb, domains) {
  const where = domains.map((domain) => `host_key like '%${domain.replaceAll("'", "''")}'`).join(" or ");
  const sql = `
    select
      host_key,
      name,
      value,
      hex(encrypted_value) as encrypted_hex,
      path,
      expires_utc,
      is_secure,
      is_httponly,
      samesite
    from cookies
    where ${where};
  `;
  const raw = execFileSync("sqlite3", ["-json", cookiesDb, sql], { encoding: "utf8" });
  return JSON.parse(raw || "[]");
}

function toPlaywrightCookie(row, key) {
  const value = decryptChromeCookie({
    hostKey: row.host_key,
    value: row.value,
    encryptedHex: row.encrypted_hex,
    key,
  });
  if (!value) return null;
  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || "/",
    expires: chromeTimeToUnixSeconds(row.expires_utc),
    httpOnly: Boolean(row.is_httponly),
    secure: Boolean(row.is_secure),
    sameSite: sameSiteFromChrome(row.samesite),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node scripts/import_chrome_cookies.mjs
  node scripts/import_chrome_cookies.mjs --profile-directory "Profile 1"
  node scripts/import_chrome_cookies.mjs --sources twitter,linkedin,quora
`);
    return;
  }

  const cookiesDb = chromeCookiesPath(args.profileDirectory);
  await fs.access(cookiesDb);
  await ensureDir(args.authDir);
  const key = chromeCookieKey();

  for (const source of args.sources) {
    const domains = SOURCE_DOMAINS[source];
    if (!domains) throw new Error(`Unknown source: ${source}`);
    const rows = loadRows(cookiesDb, domains);
    const cookies = rows.map((row) => toPlaywrightCookie(row, key)).filter(Boolean);
    const state = { cookies, origins: [] };
    const outPath = path.join(args.authDir, `${source}.storageState.json`);
    await fs.writeFile(outPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    console.log(`[${source}] saved ${cookies.length} cookies to ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
