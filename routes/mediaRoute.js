const express = require("express");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { getRailwayS3, getRailwayBucket } = require("../utils/s3");

const router = express.Router();

const PRESIGN_EXPIRES_SECONDS = 3600;

// GET /media/Nutrajun/<folder>/<file>
// Redirects to a short-lived presigned URL on the private Railway Bucket.
// The object itself is never downloaded or streamed through this server.
router.get("/*", async (req, res) => {
  const key = req.params[0];

  if (!key || !key.startsWith("Nutrajun/") || key.split("/").includes("..")) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  try {
    const url = await getSignedUrl(
      getRailwayS3(),
      new GetObjectCommand({ Bucket: getRailwayBucket(), Key: key }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS }
    );
    // helmet's default same-origin CORP would block cross-origin <img>/<video>
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    // cache the redirect for less than the presigned URL lifetime
    res.set("Cache-Control", "public, max-age=600");
    return res.redirect(302, url);
  } catch (error) {
    console.error("Media presign failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load media" });
  }
});

module.exports = router;
