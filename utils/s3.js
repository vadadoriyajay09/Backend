// s3.js
const { S3Client } = require("@aws-sdk/client-s3");

// Legacy AWS S3 client (existing files stay here during the migration period).
const awsS3 = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
  },
});

// Railway Bucket (private, S3-compatible). Created lazily and never falls back
// to AWS defaults: a missing endpoint would otherwise silently target AWS.
let railwayClient;
const getRailwayS3 = () => {
  if (!railwayClient) {
    let endpoint = process.env.AWS_ENDPOINT_URL || process.env.RAILWAY_S3_ENDPOINT_URL;
    let bucket = process.env.AWS_S3_BUCKET_NAME || process.env.RAILWAY_S3_BUCKET_NAME;
    let region = process.env.AWS_DEFAULT_REGION || process.env.RAILWAY_S3_REGION || "auto";
    let accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.RAILWAY_S3_ACCESS_KEY_ID;
    let secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.RAILWAY_S3_SECRET_ACCESS_KEY;

    const defaultEndpoint = "https://t3.storageapi.dev";
    const defaultBucket = "nutrajun-5brvsc9bwumqf2de";
    const defaultRegion = "auto";
    const defaultAccessKey = "tid_ziHaPwkeONfNLkGdVkZmyh_BXCaXbgdwkYtnjgdWdaWzweldvv";
    const defaultSecretKey = "tsec_vl1vk+bazmVI+BnDVdNpV9KF2_3KO0Yf-TxH2F0lyrkSNwzvFMMyGumvEh1BynzDgpALsb";

    // Fallback if missing or contains unexpanded Railway template strings (${{...}})
    if (!endpoint || endpoint.includes("${{")) endpoint = defaultEndpoint;
    if (!bucket || bucket.includes("${{")) bucket = defaultBucket;
    if (!region || region.includes("${{")) region = defaultRegion;
    if (!accessKeyId || accessKeyId.includes("${{")) accessKeyId = defaultAccessKey;
    if (!secretAccessKey || secretAccessKey.includes("${{")) secretAccessKey = defaultSecretKey;

    railwayClient = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      // Railway buckets require path-style addressing for S3 API compatibility
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "false" ? false : true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return railwayClient;
};

const getRailwayBucket = () => {
  const b = process.env.AWS_S3_BUCKET_NAME || process.env.RAILWAY_S3_BUCKET_NAME;
  if (!b || b.includes("${{")) {
    return "nutrajun-5brvsc9bwumqf2de";
  }
  return b;
};

module.exports = { awsS3, getRailwayS3, getRailwayBucket };
