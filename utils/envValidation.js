/**
 * utils/envValidation.js
 * Startup validation for Railway Object Storage & environment configuration.
 */

const validateEnv = () => {
  const required = [
    "AWS_ENDPOINT_URL",
    "AWS_S3_BUCKET_NAME",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "MEDIA_BASE_URL",
  ];

  const missing = required.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    console.error(`❌ STORAGE CONFIG WARNING: Missing required environment variables: ${missing.join(", ")}`);
  } else {
    console.log("✓ Storage environment variables validated successfully");
  }
};

module.exports = { validateEnv };
