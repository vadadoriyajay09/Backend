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
    const {
      AWS_ENDPOINT_URL,
      AWS_DEFAULT_REGION,
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
      AWS_S3_BUCKET_NAME,
    } = process.env;
    if (
      !AWS_ENDPOINT_URL ||
      !AWS_DEFAULT_REGION ||
      !AWS_ACCESS_KEY_ID ||
      !AWS_SECRET_ACCESS_KEY ||
      !AWS_S3_BUCKET_NAME
    ) {
      throw new Error("Railway bucket environment variables are not configured");
    }
    railwayClient = new S3Client({
      endpoint: AWS_ENDPOINT_URL,
      region: AWS_DEFAULT_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
      // Older Railway buckets may need path-style addressing.
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      // Non-AWS S3 implementations may not support the newer default checksums.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return railwayClient;
};

const getRailwayBucket = () => process.env.AWS_S3_BUCKET_NAME;

module.exports = { awsS3, getRailwayS3, getRailwayBucket };
