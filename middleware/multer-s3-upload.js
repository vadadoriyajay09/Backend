const multer = require("multer");
const multerS3 = require("multer-s3");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { awsS3, getRailwayS3, getRailwayBucket } = require("../utils/s3");
const ErrorHandler = require("../middleware/errorHandler");
const { StatusCodes } = require("http-status-codes");

// Stable URL for a private Railway object, served by GET /media/* (presigned redirect).
// Set MEDIA_BASE_URL (e.g. https://api.nutrajun.com) so stored URLs are absolute;
// without it a relative "/media/<key>" is stored.
const buildMediaUrl = (key) => {
  const base = (process.env.MEDIA_BASE_URL || "").replace(/\/+$/, "");
  return `${base}/media/${key.split("/").map(encodeURIComponent).join("/")}`;
};

// Returns the Railway object key for a stable media URL, or null if it isn't one.
const getRailwayKey = (url) => {
  if (typeof url !== "string") return null;
  let pathname;
  try {
    pathname = new URL(url, "http://placeholder").pathname;
  } catch (e) {
    return null;
  }
  if (!pathname.startsWith("/media/Nutrajun/")) return null;
  try {
    return decodeURIComponent(pathname.slice("/media/".length));
  } catch (e) {
    return null;
  }
};

// New uploads go to the private Railway Bucket; file.location becomes the stable media URL.
const railwayStorage = (folderName) => {
  // Built on first upload so a missing Railway config can't break server startup.
  let storage;
  const getStorage = () => {
    if (!storage) {
      storage = multerS3({
        s3: getRailwayS3(),
        bucket: getRailwayBucket(),
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
          const fileName = `${Date.now()}-${file.originalname}`;
          cb(null, `Nutrajun/${folderName}/${fileName}`);
        },
      });
    }
    return storage;
  };
  return {
    _handleFile(req, file, cb) {
      let target;
      try {
        target = getStorage();
      } catch (err) {
        return cb(err);
      }
      target._handleFile(req, file, (err, info) => {
        if (err) return cb(err);
        cb(null, { ...info, location: buildMediaUrl(info.key) });
      });
    },
    _removeFile(req, file, cb) {
      getStorage()._removeFile(req, file, cb);
    },
  };
};

const uploadFile = (folderName) => {
  return multer({
    storage: railwayStorage(folderName),
    // ✅ Increased file size limits for images and videos
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB per file
      files: 20, // Maximum 20 files
    },

    fileFilter: (req, file, cb) => {
      const allowedMimes = [
        "image/jpeg",
        "image/png",
        "video/mp4",
        "video/quicktime",
      ];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(
          new ErrorHandler(
            "Invalid file type. Only JPEG, PNG, MP4, and MOV allowed.",
            StatusCodes.BAD_REQUEST
          )
        );
      }
    },
  });
};

const deleteFileFromS3 = async (fileKeys) => {
  try {
    if (!fileKeys) return;

    const keys = Array.isArray(fileKeys) ? fileKeys : [fileKeys];

    // AWS URLs -> AWS S3 (unchanged behavior); /media/ URLs -> Railway Bucket.
    const objectsToDelete = keys
      .filter((url) => typeof url === "string" && url.includes(".amazonaws.com/"))
      .map((url) => ({
        Key: url.split(".amazonaws.com/")[1],
      }));

    const railwayObjects = keys
      .filter((url) => !(typeof url === "string" && url.includes(".amazonaws.com/")))
      .map(getRailwayKey)
      .filter(Boolean)
      .map((Key) => ({ Key }));

    if (objectsToDelete.length > 0) {
      await awsS3.send(
        new DeleteObjectsCommand({
          Bucket: "nutrajun",
          Delete: { Objects: objectsToDelete },
        })
      );
    }

    if (railwayObjects.length > 0) {
      await getRailwayS3().send(
        new DeleteObjectsCommand({
          Bucket: getRailwayBucket(),
          Delete: { Objects: railwayObjects },
        })
      );
    }

  } catch (error) {
    throw new ErrorHandler(
      `Failed to delete files from S3: ${error.message}`,
      StatusCodes.INTERNAL_SERVER_ERROR
    );
  }
};

module.exports = {
  uploadFile,
  deleteFileFromS3,
  getRailwayKey,
  buildMediaUrl,
};