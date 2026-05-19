#!/usr/bin/env node
// Extract cookies for a given domain pattern from Chrome profile, decrypt them, write Playwright storageState.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

const SOURCE_HOSTS = {
  twitter: ["%x.com", "%twitter.com"],
  linkedin: ["%linkedin.com"],
  reddit: ["%reddit.com"],
};

const source = process.argv[2];
const profile = process.argv[3] || "Profile 1";
const outputArg = process.argv[4];

if (!source || !SOURCE_HOSTS[source]) {
  console.error(`Usage: node extract_chrome_cookies.mjs <twitter|linkedin|reddit> [profile] [outputPath]`);
  process.exit(1);
}
const output = outputArg || `.crawler-auth/${source}.storageState.json`;
const hosts = SOURCE_HOSTS[source];

const cookiesDb = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", profile, "Cookies");
const tmpCopy = `/tmp/chrome_cookies_${source}_${Date.now()}.db`;
execSync(`cp '${cookiesDb}' '${tmpCopy}'`);

const password = execSync(`security find-generic-password -wa 'Chrome'`).toString().trim();
const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
const iv = Buffer.alloc(16, 0x20);

function decrypt(encryptedValue) {
  if (!encryptedValue || encryptedValue.length < 3) return "";
  const prefix = encryptedValue.slice(0, 3).toString();
  if (prefix !== "v10" && prefix !== "v11") return encryptedValue.toString("utf8");
  const ciphertext = encryptedValue.slice(3);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  if (decrypted.length > 32 && decrypted.slice(0, 32).some(b => b < 0x20 || b > 0x7e)) {
    return decrypted.slice(32).toString("utf8");
  }
  return decrypted.toString("utf8");
}

const db = new Database(tmpCopy, { readonly: true });
const whereClause = hosts.map(() => "host_key LIKE ?").join(" OR ");
const rows = db.prepare(
  `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE ${whereClause}`
).all(...hosts);
db.close();
await fs.unlink(tmpCopy).catch(() => {});

const cookies = [];
for (const r of rows) {
  let value = r.value;
  if (!value && r.encrypted_value) {
    try {
      value = decrypt(r.encrypted_value);
    } catch (e) {
      console.error(`failed to decrypt ${r.name}: ${e.message}`);
      continue;
    }
  }
  let expires = -1;
  if (r.expires_utc && r.expires_utc > 0) {
    const unixMicros = r.expires_utc - 11644473600000000;
    expires = Math.floor(unixMicros / 1000000);
  }
  const sameSiteMap = { "-1": "None", "0": "None", "1": "Lax", "2": "Strict" };
  cookies.push({
    name: r.name,
    value,
    domain: r.host_key,
    path: r.path,
    expires,
    httpOnly: !!r.is_httponly,
    secure: !!r.is_secure,
    sameSite: sameSiteMap[String(r.samesite)] || "Lax",
  });
}

const state = { cookies, origins: [] };
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(state, null, 2));

const names = cookies.map(c => c.name);
console.log(`Wrote ${cookies.length} cookies for ${source} to ${output}`);
const keyMarkers = {
  twitter: ["auth_token", "ct0", "twid"],
  linkedin: ["li_at", "JSESSIONID", "bcookie"],
  reddit: ["reddit_session", "token_v2"],
};
for (const m of keyMarkers[source]) {
  console.log(`has ${m}: ${names.includes(m)}`);
}
