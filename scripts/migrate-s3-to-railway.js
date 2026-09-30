#!/usr/bin/env node
/**
 * AWS S3 -> Railway Bucket migration tool (safe, resumable).
 *
 *   node scripts/migrate-s3-to-railway.js --dry-run
 *   node scripts/migrate-s3-to-railway.js --execute
 *   node scripts/migrate-s3-to-railway.js --execute --update-mongodb
 *
 * Options:
 *   --limit N             only process the first N AWS objects (for trial runs)
 *   --concurrency N       parallel objects (default 8 dry-run, 4 execute)
 *   --include-snapshots   MongoDB phase also covers Order.items.image_url and
 *                         Customer.profile_photo (off by default)
 *
 * Safety guarantees:
 *   - Never deletes anything from AWS (no delete commands are imported or used).
 *   - --dry-run is read-only: no uploads, no MongoDB writes. MongoDB is only
 *     inspected if MIGRATION_DRYRUN_MONGO_URI (a NON-production DB) is set.
 *   - --execute copies objects only; MongoDB is untouched unless --update-mongodb.
 *   - MongoDB URLs are rewritten only after the Railway copy of every object the
 *     document references has been re-verified (size + content type).
 *   - Object keys are preserved exactly: Nutrajun/<folder>/<file>.
 *   - Railway is the source of truth for resuming: already-equivalent objects are
 *     skipped, so re-running never re-uploads verified objects.
 *
 * Env (Backend/.env). The two storage systems use SEPARATE variables; the generic
 * AWS_ENDPOINT_URL / AWS_ACCESS_KEY_ID / ... used by the app's upload code are NOT read here.
 *
 *   # AWS SOURCE (read-only)
 *   AWS_SOURCE_ENDPOINT_URL=https://s3.eu-north-1.amazonaws.com
 *   AWS_SOURCE_BUCKET_NAME=nutrajun
 *   AWS_SOURCE_REGION=eu-north-1
 *   AWS_S3_ACCESS_KEY_ID=...
 *   AWS_S3_SECRET_ACCESS_KEY=...
 *
 *   # RAILWAY DESTINATION
 *   RAILWAY_S3_ENDPOINT_URL=https://t3.storageapi.dev
 *   RAILWAY_S3_BUCKET_NAME=...
 *   RAILWAY_S3_REGION=auto
 *   RAILWAY_S3_ACCESS_KEY_ID=...
 *   RAILWAY_S3_SECRET_ACCESS_KEY=...
 *   RAILWAY_S3_FORCE_PATH_STYLE=true   (optional, only for path-style Railway buckets)
 *
 *   MEDIA_BASE_URL   required for --update-mongodb
 *   DB_URI           used only with --update-mongodb
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

// ------------------------------------------------------------------ config
const EXPECTED_SOURCE_BUCKET = "nutrajun";
const SOURCE_BUCKET = process.env.AWS_SOURCE_BUCKET_NAME;
const SOURCE_REGION = process.env.AWS_SOURCE_REGION;
const SOURCE_ENDPOINT = process.env.AWS_SOURCE_ENDPOINT_URL;
// Local test harness only (fake S3 servers): relaxes the "must be real AWS" guards.
const TEST_MODE = process.env.MIGRATION_ALLOW_NON_AWS_ENDPOINTS === "1";
const PREFIX = "Nutrajun/";
const MAX_ATTEMPTS = 3;
const MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3 - 1; // PutObject limit
const LOG_DIR = path.join(__dirname, "..", "migration-logs");
const OBJECT_LOG = path.join(LOG_DIR, "s3-to-railway.jsonl");
const MONGO_LOG = path.join(LOG_DIR, "mongodb-updates.jsonl");
const AWS_URL_RE = /^https:\/\/nutrajun\.s3\.eu-north-1\.amazonaws\.com\/(Nutrajun\/[^?#]+)$/;
const KNOWN_FOLDERS = ["products", "blog-photo", "gallery", "offer-banner", "category-banner"];

// Every field that holds a storage URL (verified against models/*.js).
// "a[]" iterates an array; dots descend into sub-documents.
const URL_FIELDS = [
  { model: "productModel", label: "Product", paths: ["main_image", "images[]", "videos[]", "reviews[].image"] },
  { model: "blogModel", label: "Blog", paths: ["main_image", "main_video", "content[].image", "content[].video"] },
  { model: "galleryModel", label: "Gallery", paths: ["image_url", "video_url"] },
  { model: "offerModel", label: "Offer", paths: ["banner_image"] },
  { model: "categoryModel", label: "Category", paths: ["image"] },
  { model: "orderModel", label: "Order", paths: ["items[].image_url"], snapshot: true },
  { model: "customerModel", label: "Customer", paths: ["profile_photo"], snapshot: true },
];

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY = flag("--dry-run");
const EXEC = flag("--execute");
const UPDATE_MONGO = flag("--update-mongodb");
const INCLUDE_SNAPSHOTS = flag("--include-snapshots");
const LIMIT = opt("--limit") ? parseInt(opt("--limit"), 10) : Infinity;
const CONCURRENCY = parseInt(opt("--concurrency", DRY ? "8" : "4"), 10);

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(2)} ${u[i]}`;
};
const fmtNum = (n) => n.toLocaleString("en-US");

const SECRETS = () =>
  [process.env.AWS_S3_SECRET_ACCESS_KEY, process.env.RAILWAY_S3_SECRET_ACCESS_KEY, process.env.AWS_S3_ACCESS_KEY_ID, process.env.RAILWAY_S3_ACCESS_KEY_ID]
    .filter((s) => s && s.length > 6);
const redact = (msg) => {
  let out = String(msg || "").replace(/X-Amz-[A-Za-z-]+=[^&\s"']+/g, "X-Amz-…=<redacted>");
  for (const s of SECRETS()) out = out.split(s).join("<redacted>");
  return out;
};

const statusOf = (e) => (e && e.$metadata && e.$metadata.httpStatusCode) || 0;
const isNotFound = (e) => statusOf(e) === 404 || ["NotFound", "NoSuchKey"].includes(e && e.name);

// Errors that mean the whole run is misconfigured -> stop safely.
const GLOBAL_NAMES = new Set([
  "InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket", "AccessDenied", "InvalidToken",
  "ExpiredToken", "CredentialsProviderError", "AuthorizationHeaderMalformed", "PermanentRedirect",
  "AllAccessDisabled", "InvalidBucketName",
]);
const GLOBAL_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "EAI_AGAIN"]);
const isGlobalError = (e) =>
  !!e && (GLOBAL_NAMES.has(e.name) || GLOBAL_CODES.has(e.code) || [401, 403].includes(statusOf(e)) ||
    /certificate|altnames|Could not load credentials/i.test(e.message || ""));

class GlobalError extends Error {
  constructor(where, cause) {
    super(`${where}: ${redact(cause.name)}: ${redact(cause.message)}`);
    this.name = "GlobalError";
  }
}

const isTransient = (e) => {
  if (isGlobalError(e)) return false;
  const s = statusOf(e);
  if (s >= 500 || s === 429 || s === 408) return true;
  if (["SlowDown", "RequestTimeout", "ThrottlingException", "TimeoutError", "RequestTimeoutException", "InternalError", "ServiceUnavailable"].includes(e.name)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(e.code) || /socket hang up|aborted|network/i.test(e.message || "");
};

async function withRetry(fn, where) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn();
    } catch (e) {
      if (isGlobalError(e)) throw new GlobalError(where, e);
      if (attempt >= MAX_ATTEMPTS || !isTransient(e)) throw e;
      await sleep(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }
}

function folderOf(key) {
  const rest = key.slice(PREFIX.length);
  const i = rest.indexOf("/");
  return i < 0 ? "(root)" : rest.slice(0, i);
}

// key -> stable media URL (matches middleware/multer-s3-upload.js buildMediaUrl)
const mediaUrlForKey = (base, key) => `${base}/media/${key.split("/").map(encodeURIComponent).join("/")}`;
const keyFromAwsUrl = (url) => {
  if (typeof url !== "string") return null;
  const m = AWS_URL_RE.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
};

// ------------------------------------------------------------------ clients
// Built by initClients() after config validation. Each client is constructed ONLY from
// its own variable group (AWS_SOURCE_* / AWS_S3_* vs RAILWAY_S3_*).
let aws;
let railwayClient;
const railway = () => railwayClient;
const railwayBucket = () => process.env.RAILWAY_S3_BUCKET_NAME;

function initClients() {
  aws = new S3Client({
    region: process.env.AWS_SOURCE_REGION,
    endpoint: process.env.AWS_SOURCE_ENDPOINT_URL,
    forcePathStyle: TEST_MODE,
    credentials: {
      accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
    },
  });
  railwayClient = new S3Client({
    region: process.env.RAILWAY_S3_REGION,
    endpoint: process.env.RAILWAY_S3_ENDPOINT_URL,
    forcePathStyle: process.env.RAILWAY_S3_FORCE_PATH_STYLE === "true" || TEST_MODE,
    credentials: {
      accessKeyId: process.env.RAILWAY_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.RAILWAY_S3_SECRET_ACCESS_KEY,
    },
    // Non-AWS S3 implementations may not support the newer default checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

// Fails fast (exit 64) on missing/unsafe config. Never prints secret values.
function validateConfig() {
  const required = [
    "AWS_SOURCE_ENDPOINT_URL", "AWS_SOURCE_BUCKET_NAME", "AWS_SOURCE_REGION", "AWS_S3_ACCESS_KEY_ID", "AWS_S3_SECRET_ACCESS_KEY",
    "RAILWAY_S3_ENDPOINT_URL", "RAILWAY_S3_BUCKET_NAME", "RAILWAY_S3_REGION", "RAILWAY_S3_ACCESS_KEY_ID", "RAILWAY_S3_SECRET_ACCESS_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) usageError(`Missing required environment variables: ${missing.join(", ")}`);

  let src, dst;
  try { src = new URL(process.env.AWS_SOURCE_ENDPOINT_URL); dst = new URL(process.env.RAILWAY_S3_ENDPOINT_URL); }
  catch (e) { usageError("AWS_SOURCE_ENDPOINT_URL and RAILWAY_S3_ENDPOINT_URL must be valid URLs (including https://)."); }

  if (process.env.AWS_SOURCE_BUCKET_NAME !== EXPECTED_SOURCE_BUCKET && !TEST_MODE)
    usageError(`AWS_SOURCE_BUCKET_NAME must be "${EXPECTED_SOURCE_BUCKET}".`);
  if (!/(^|\.)amazonaws\.com$/i.test(src.hostname) && !TEST_MODE)
    usageError("AWS_SOURCE_ENDPOINT_URL must be an amazonaws.com endpoint (the Railway endpoint can never be used as the source).");
  if (/(^|\.)amazonaws\.com$/i.test(dst.hostname) && !TEST_MODE)
    usageError("RAILWAY_S3_ENDPOINT_URL points at AWS - the destination must be the Railway bucket.");
  if (src.host === dst.host && !TEST_MODE)
    usageError("Source and destination endpoints are the same host - refusing to run.");
  if (process.env.AWS_S3_ACCESS_KEY_ID === process.env.RAILWAY_S3_ACCESS_KEY_ID && !TEST_MODE)
    usageError("Source and destination access keys are identical - refusing to run.");
  if (/^(AKIA|ASIA)/.test(process.env.RAILWAY_S3_ACCESS_KEY_ID) && !TEST_MODE)
    usageError("RAILWAY_S3_ACCESS_KEY_ID looks like an AWS access key - the destination must use Railway credentials.");

  return { src, dst };
}

// Read-only connectivity checks (list only; nothing is written).
async function connectivityChecks() {
  const a = await withRetry(
    () => aws.send(new ListObjectsV2Command({ Bucket: SOURCE_BUCKET, Prefix: PREFIX, MaxKeys: 5 })),
    "AWS source connectivity check"
  );
  console.log(`AWS source check:      OK (ListObjectsV2 Prefix=${PREFIX} MaxKeys=5 -> ${(a.Contents || []).length} key(s) returned)`);
  const r = await withRetry(
    () => railway().send(new ListObjectsV2Command({ Bucket: railwayBucket(), Prefix: PREFIX, MaxKeys: 5 })),
    "Railway destination connectivity check"
  );
  console.log(`Railway dest. check:   OK (ListObjectsV2 Prefix=${PREFIX} MaxKeys=5 -> ${(r.Contents || []).length} key(s) returned)\n`);
}

async function* listAws() {
  let token;
  do {
    const res = await withRetry(
      () => aws.send(new ListObjectsV2Command({ Bucket: SOURCE_BUCKET, Prefix: PREFIX, ContinuationToken: token })),
      "AWS list"
    );
    for (const o of res.Contents || []) yield o;
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
}

async function listRailwayStats() {
  let token, count = 0, size = 0;
  do {
    const res = await withRetry(
      () => railway().send(new ListObjectsV2Command({ Bucket: railwayBucket(), Prefix: PREFIX, ContinuationToken: token })),
      "Railway list"
    );
    for (const o of res.Contents || []) { count++; size += o.Size || 0; }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return { count, size };
}

async function headRailway(key) {
  try {
    return await withRetry(() => railway().send(new HeadObjectCommand({ Bucket: railwayBucket(), Key: key })), "Railway head");
  } catch (e) {
    if (e instanceof GlobalError) throw e;
    if (isNotFound(e)) return null;
    throw e;
  }
}
const headAws = (key) =>
  withRetry(() => aws.send(new HeadObjectCommand({ Bucket: SOURCE_BUCKET, Key: key })), "AWS head");

const sameType = (a, b) => (a.ContentType || "") === (b.ContentType || "");
// Equivalent = same length and same content type.
const equivalent = (src, dst) => Number(src.ContentLength) === Number(dst.ContentLength) && sameType(src, dst);

// ------------------------------------------------------------------ logging
let logStream;
function logResult(rec) {
  if (!EXEC) return;
  if (!logStream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(OBJECT_LOG, { flags: "a" });
  }
  logStream.write(JSON.stringify({ timestamp: new Date().toISOString(), sourceBucket: SOURCE_BUCKET, destinationBucket: railwayBucket(), ...rec }) + "\n");
}

// ------------------------------------------------------------------ bounded worker pool over an async iterator
async function forEachPooled(iter, limit, worker, shouldStop) {
  const inflight = new Set();
  let fatal = null;
  for await (const item of iter) {
    if (fatal || shouldStop()) break;
    const p = worker(item).catch((e) => { if (e instanceof GlobalError && !fatal) fatal = e; }).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= limit) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  if (fatal) throw fatal;
}

// ------------------------------------------------------------------ DRY RUN
async function dryRun() {
  const stats = { total: 0, size: 0, present: 0, presentSize: 0, differs: 0, copy: 0, copyBytes: 0, failed: 0, placeholders: 0 };
  const folders = new Map();
  const bump = (key, f) => {
    const name = folderOf(key);
    if (!folders.has(name)) folders.set(name, { objects: 0, size: 0, copy: 0, present: 0 });
    f(folders.get(name));
  };

  // Pass 1: cheap list-only count so progress lines can show [i/total].
  let limited = 0;
  for await (const o of listAws()) { if (limited++ >= LIMIT) break; }
  const total = Math.min(limited, LIMIT);
  console.log(`AWS listing found ${fmtNum(total)} objects under ${PREFIX}${LIMIT !== Infinity ? ` (limited to ${LIMIT})` : ""}`);

  let i = 0;
  async function check(o) {
    const n = ++i;
    const tag = `[${n}/${total}]`;
    const key = o.Key;
    stats.total++; stats.size += o.Size;
    bump(key, (f) => { f.objects++; f.size += o.Size; });
    if (key.endsWith("/")) { stats.placeholders++; console.log(`${tag} SKIP (folder placeholder) ${key}`); return; }
    try {
      const dst = await headRailway(key);
      if (dst) {
        // Present in Railway; compare with AWS metadata (HeadObject only, no download).
        const src = await headAws(key);
        if (equivalent(src, dst)) {
          stats.present++; stats.presentSize += o.Size; bump(key, (f) => f.present++);
          console.log(`${tag} SKIP ${key}`);
          return;
        }
        stats.differs++;
        console.log(`${tag} WOULD COPY (Railway copy differs) ${key}`);
      } else {
        console.log(`${tag} WOULD COPY ${key}`);
      }
      stats.copy++; stats.copyBytes += o.Size; bump(key, (f) => f.copy++);
    } catch (e) {
      if (e instanceof GlobalError) throw e;
      stats.failed++;
      console.log(`${tag} WOULD FAIL ${key}: ${redact(e.message)}`);
    }
  }

  async function* limitedList() {
    let c = 0;
    for await (const o of listAws()) { if (c++ >= LIMIT) return; yield o; }
  }
  await forEachPooled(limitedList(), CONCURRENCY, check, () => false);

  const rail = await listRailwayStats();
  const mongo = await dryRunMongo();
  printDryRunReport({ stats, folders, rail, mongo });
}

async function dryRunMongo() {
  const uri = process.env.MIGRATION_DRYRUN_MONGO_URI;
  if (!uri) return { skipped: "no non-production database configured (set MIGRATION_DRYRUN_MONGO_URI to inspect one)" };
  if (uri === process.env.DB_URI) return { skipped: "MIGRATION_DRYRUN_MONGO_URI equals DB_URI - refusing to inspect production" };
  const mongoose = require("mongoose");
  await mongoose.connect(uri);
  try {
    const r = await scanMongo(null);
    return r;
  } finally {
    await mongoose.disconnect();
  }
}

function printDryRunReport({ stats, folders, rail, mongo }) {
  const line = "=".repeat(50);
  console.log(`\n${line}\nAWS → RAILWAY MIGRATION DRY RUN\n${line}\n`);
  console.log(`AWS bucket:\n${SOURCE_BUCKET}\n\nPrefix:\n${PREFIX}\n`);
  console.log(`AWS objects:\n${fmtNum(stats.total)}\n\nTotal size:\n${fmtBytes(stats.size)}\n`);
  console.log(`Railway objects under ${PREFIX}:\n${fmtNum(rail.count)} (${fmtBytes(rail.size)})\n`);
  console.log(`Already present in Railway (equivalent):\n${fmtNum(stats.present)}\n`);
  console.log(`Would copy:\n${fmtNum(stats.copy)} (${fmtBytes(stats.copyBytes)})`);
  if (stats.differs) console.log(`  of which present in Railway but different: ${fmtNum(stats.differs)}`);
  console.log(`\nWould skip:\n${fmtNum(stats.present + stats.placeholders)}${stats.placeholders ? ` (incl. ${stats.placeholders} folder placeholders)` : ""}\n`);
  console.log(`Would fail (check errors):\n${fmtNum(stats.failed)}\n`);
  if (mongo.skipped) {
    console.log(`Potential MongoDB URL updates:\nnot calculated - ${mongo.skipped}\n`);
  } else {
    console.log(`Potential MongoDB URL updates:\n${fmtNum(mongo.urls)} URLs in ${fmtNum(mongo.docs)} documents (non-production DB)\n`);
    for (const [k, v] of Object.entries(mongo.byField)) console.log(`  ${k.padEnd(34)} ${fmtNum(v)}`);
    console.log("");
  }
  console.log("AWS deletions:\n0\n");
  console.log(`${line}\n\nBY FOLDER\n`);
  console.log(`${"Folder".padEnd(20)}${"Objects".padStart(10)}${"Size".padStart(14)}${"Would copy".padStart(12)}${"Present".padStart(10)}`);
  console.log("-".repeat(66));
  const names = [...KNOWN_FOLDERS, ...[...folders.keys()].filter((f) => !KNOWN_FOLDERS.includes(f)).sort()];
  for (const name of names) {
    const f = folders.get(name) || { objects: 0, size: 0, copy: 0, present: 0 };
    console.log(`${name.padEnd(20)}${fmtNum(f.objects).padStart(10)}${fmtBytes(f.size).padStart(14)}${fmtNum(f.copy).padStart(12)}${fmtNum(f.present).padStart(10)}`);
  }
  console.log(`\n${line}\nDRY RUN COMPLETE - nothing was uploaded, deleted or modified. Stopping.\n${line}`);
}

// ------------------------------------------------------------------ EXECUTE (copy)
async function migrateOne(o, tag, counters) {
  const key = o.Key;
  const base = { sourceKey: key, sourceSize: o.Size };
  const record = (status, extra = {}) => {
    logResult({ ...base, status, ...extra });
    console.log(`${tag} ${status} ${key}${extra.error ? `: ${extra.error}` : ""}`);
  };
  if (key.endsWith("/")) { record("SKIPPED", { note: "folder placeholder" }); counters.skipped++; return; }

  try {
    let src;
    const existing = await headRailway(key);
    src = await headAws(key);
    if (existing && equivalent(src, existing)) {
      record("SKIPPED", { destinationSize: Number(existing.ContentLength), contentType: existing.ContentType });
      counters.skipped++;
      return;
    }
    if (Number(src.ContentLength) > MAX_SINGLE_PUT_BYTES) {
      throw Object.assign(new Error("object exceeds 5GB single PutObject limit (multipart not implemented)"), { name: "TooLarge" });
    }

    // Copy with retries. Body is streamed (never buffered); IfMatch pins the exact source version.
    await withRetry(async () => {
      const got = await aws.send(new GetObjectCommand({ Bucket: SOURCE_BUCKET, Key: key, IfMatch: src.ETag }));
      try {
        await railway().send(new PutObjectCommand({
          Bucket: railwayBucket(),
          Key: key, // exact key, unchanged
          Body: got.Body,
          ContentLength: Number(src.ContentLength),
          ContentType: src.ContentType,
          CacheControl: src.CacheControl,
          ContentDisposition: src.ContentDisposition,
          ContentEncoding: src.ContentEncoding,
          ContentLanguage: src.ContentLanguage,
          Metadata: src.Metadata,
        }));
      } catch (e) {
        if (got.Body && typeof got.Body.destroy === "function") got.Body.destroy();
        throw e;
      }
    }, "copy");
    record("COPIED", { destinationSize: Number(src.ContentLength), contentType: src.ContentType });
    counters.copied++;

    // Verify: key, length and content type from Railway itself.
    const dst = await headRailway(key);
    if (!dst) throw Object.assign(new Error("verification failed: object missing in Railway after upload"), { name: "VerifyFailed" });
    if (!equivalent(src, dst)) {
      throw Object.assign(new Error(`verification failed: size ${dst.ContentLength}/${src.ContentLength}, type ${dst.ContentType}/${src.ContentType}`), { name: "VerifyFailed" });
    }
    record("VERIFIED", { destinationSize: Number(dst.ContentLength), contentType: dst.ContentType });
    counters.verified++;
  } catch (e) {
    if (e instanceof GlobalError) throw e;
    counters.failed++;
    record("FAILED", { error: redact(e.message || e.name) });
  }
}

let stopping = false;
async function execute() {
  const counters = { total: 0, copied: 0, skipped: 0, verified: 0, failed: 0 };
  let total = 0;
  for await (const _ of listAws()) { if (++total >= LIMIT) break; }
  console.log(`AWS listing found ${fmtNum(total)} objects under ${PREFIX}${LIMIT !== Infinity ? ` (limited to ${LIMIT})` : ""}`);

  process.on("SIGINT", () => { if (!stopping) { stopping = true; console.log("\nSIGINT: finishing in-flight objects, then stopping (re-run to resume)..."); } });

  let i = 0;
  async function* limitedList() {
    let c = 0;
    for await (const o of listAws()) { if (c++ >= LIMIT) return; yield o; }
  }
  try {
    await forEachPooled(limitedList(), CONCURRENCY, (o) => { counters.total++; return migrateOne(o, `[${++i}/${total}]`, counters); }, () => stopping);
  } finally {
    if (logStream) await new Promise((r) => logStream.end(r));
  }
  console.log(`\n${"=".repeat(50)}\nMIGRATION SUMMARY\n${"=".repeat(50)}`);
  console.log(`Total processed: ${fmtNum(counters.total)}\nCopied:   ${fmtNum(counters.copied)}\nSkipped:  ${fmtNum(counters.skipped)}\nVerified: ${fmtNum(counters.verified)}\nFailed:   ${fmtNum(counters.failed)}`);
  console.log("AWS deletions: 0");
  return counters;
}

// ------------------------------------------------------------------ MongoDB
// Walk a document along a path spec; yields { path: "reviews.2.image", value }.
function* walk(doc, spec) {
  function* rec(node, segs, prefix) {
    if (node == null || segs.length === 0) return;
    const [seg, ...rest] = segs;
    const isArr = seg.endsWith("[]");
    const name = isArr ? seg.slice(0, -2) : seg;
    const child = node[name];
    const p = prefix ? `${prefix}.${name}` : name;
    if (isArr) {
      if (!Array.isArray(child)) return;
      for (let i = 0; i < child.length; i++) {
        if (rest.length === 0) yield { path: `${p}.${i}`, value: child[i] };
        else yield* rec(child[i], rest, `${p}.${i}`);
      }
    } else if (rest.length === 0) {
      yield { path: p, value: child };
    } else {
      yield* rec(child, rest, p);
    }
  }
  yield* rec(doc, spec.split("."), "");
}

const projectionFor = (paths) => {
  const proj = { _id: 1 };
  for (const p of paths) proj[p.split(".")[0].replace("[]", "")] = 1;
  return proj;
};

// Read-only scan: counts candidate AWS URLs. With ctx (update mode) it is not used.
async function scanMongo() {
  const out = { urls: 0, docs: 0, byField: {} };
  for (const spec of URL_FIELDS) {
    if (spec.snapshot && !INCLUDE_SNAPSHOTS) continue;
    const Model = require(`../models/${spec.model}`);
    const cursor = Model.collection.find({}, { projection: projectionFor(spec.paths) });
    for await (const doc of cursor) {
      let hit = false;
      for (const p of spec.paths) {
        for (const { value } of walk(doc, p)) {
          if (keyFromAwsUrl(value)) {
            out.urls++; hit = true;
            const k = `${spec.label}.${p}`;
            out.byField[k] = (out.byField[k] || 0) + 1;
          }
        }
      }
      if (hit) out.docs++;
    }
  }
  return out;
}

const maskedHost = (uri) => {
  try { const u = new URL(uri); return `${u.host}${u.pathname}`; } catch (e) { return "(unparseable URI)"; }
};

// Only after every referenced object is verified in Railway is a document rewritten.
async function updateMongo() {
  const base = (process.env.MEDIA_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("MEDIA_BASE_URL is required for --update-mongodb (e.g. https://api.nutrajun.com)");
  if (!/^https:\/\//.test(base) && !TEST_MODE) throw new Error("MEDIA_BASE_URL must be an https:// URL for --update-mongodb");
  if (!process.env.DB_URI) throw new Error("DB_URI is required for --update-mongodb");

  const mongoose = require("mongoose");
  console.log(`\nMongoDB update phase → database: ${maskedHost(process.env.DB_URI)}, media base: ${base}`);
  await mongoose.connect(process.env.DB_URI);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const mlog = fs.createWriteStream(MONGO_LOG, { flags: "a" });
  const sum = { docsScanned: 0, docsUpdated: 0, docsSkippedUnverified: 0, urlsUpdated: 0, docsAlreadyMigrated: 0 };

  const verifyKey = async (key) => {
    const [src, dst] = [await headAws(key).catch((e) => { if (e instanceof GlobalError) throw e; return null; }), await headRailway(key)];
    return !!(src && dst && equivalent(src, dst));
  };

  try {
    for (const spec of URL_FIELDS) {
      if (spec.snapshot && !INCLUDE_SNAPSHOTS) continue;
      const Model = require(`../models/${spec.model}`);
      const cursor = Model.collection.find({}, { projection: projectionFor(spec.paths) });
      for await (const doc of cursor) {
        sum.docsScanned++;
        const changes = []; // { path, from, to, key }
        for (const p of spec.paths) {
          for (const { path: fp, value } of walk(doc, p)) {
            const key = keyFromAwsUrl(value); // non-AWS / already-/media URLs are never candidates
            if (key) changes.push({ path: fp, from: value, to: mediaUrlForKey(base, key), key });
          }
        }
        if (changes.length === 0) continue;

        let allVerified = true;
        for (const c of changes) {
          if (!(await verifyKey(c.key))) { allVerified = false; console.log(`MONGO SKIP ${spec.label} ${doc._id}: not verified in Railway: ${c.key}`); break; }
        }
        if (!allVerified) { sum.docsSkippedUnverified++; continue; }

        // Report BEFORE changing the document (old -> new), then compare-and-set update.
        mlog.write(JSON.stringify({ timestamp: new Date().toISOString(), collection: Model.collection.name, _id: String(doc._id), changes: changes.map(({ path: pth, from, to }) => ({ path: pth, from, to })) }) + "\n");
        const filter = { _id: doc._id };
        const set = {};
        for (const c of changes) { filter[c.path] = c.from; set[c.path] = c.to; }
        const res = await Model.collection.updateOne(filter, { $set: set });
        if (res.modifiedCount === 1) { sum.docsUpdated++; sum.urlsUpdated += changes.length; }
        else console.log(`MONGO SKIP ${spec.label} ${doc._id}: changed concurrently, not updated (re-run to retry)`);
      }
    }
  } finally {
    await new Promise((r) => mlog.end(r));
    await mongoose.disconnect();
  }
  console.log(`MongoDB update: scanned ${fmtNum(sum.docsScanned)} docs, updated ${fmtNum(sum.docsUpdated)} docs (${fmtNum(sum.urlsUpdated)} URLs), left ${fmtNum(sum.docsSkippedUnverified)} untouched (objects not verified)`);
}

// ------------------------------------------------------------------ main
function usageError(msg) {
  console.error(`${msg}\n\nUsage:\n  node scripts/migrate-s3-to-railway.js --dry-run\n  node scripts/migrate-s3-to-railway.js --execute\n  node scripts/migrate-s3-to-railway.js --execute --update-mongodb`);
  process.exit(64);
}

async function main() {
  if (DRY === EXEC) usageError("Specify exactly one of --dry-run or --execute.");
  if (UPDATE_MONGO && !EXEC) usageError("--update-mongodb requires --execute (dry-run never touches MongoDB).");
  if (!Number.isFinite(CONCURRENCY) || CONCURRENCY < 1) usageError("--concurrency must be a positive integer.");
  const { src, dst } = validateConfig();
  initClients();

  const maskBucket = (b) => (b.length <= 8 ? "****" : `${b.slice(0, 4)}...${b.slice(-3)}`);
  console.log(`Mode: ${DRY ? "DRY RUN (read-only)" : `EXECUTE${UPDATE_MONGO ? " + UPDATE MONGODB" : " (MongoDB untouched)"}`}${TEST_MODE ? " [TEST MODE: non-AWS endpoints allowed]" : ""}`);
  console.log(`AWS source: bucket=${SOURCE_BUCKET} region=${SOURCE_REGION} endpoint=${src.host}`);
  console.log(`Railway destination: bucket=${maskBucket(railwayBucket())} region=${process.env.RAILWAY_S3_REGION} endpoint=${dst.host}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);
  await connectivityChecks();

  if (DRY) {
    await dryRun();
    return;
  }
  const counters = await execute();
  if (UPDATE_MONGO) await updateMongo();
  process.exitCode = counters.failed > 0 ? 1 : 0;
}

if (require.main === module) main().catch((e) => {
  if (e instanceof GlobalError) {
    console.error(`\nSTOPPED (configuration/authentication problem): ${e.message}`);
    process.exit(2);
  }
  console.error(`\nERROR: ${redact(e.stack || e.message)}`);
  process.exit(1);
});

module.exports = { walk, keyFromAwsUrl, mediaUrlForKey };
