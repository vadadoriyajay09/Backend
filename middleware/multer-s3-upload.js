const multer = require("multer");
const multerS3 = require("multer-s3");
const { DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { getRailwayS3, getRailwayBucket } = require("../utils/s3");
const { getMediaUrl, getRailwayKey } = require("../utils/mediaUrl");
const ErrorHandler = require("../middleware/errorHandler");
const { StatusCodes } = require("http-status-codes");

// New uploads go to private Railway Bucket; file.location becomes the stable media URL.
const railwayStorage = (folderName) => {
  let storage;
  const getStorage = () => {
    if (!storage) {
      storage = multerS3({
        s3: getRailwayS3(),
        bucket: getRailwayBucket(),
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
          const cleanOriginalName = file.originalname.replace(/\s+/g, "_");
          const fileName = `${Date.now()}-${cleanOriginalName}`;
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
        const mediaUrl = getMediaUrl(info.key);
        cb(null, { ...info, location: mediaUrl });
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

/**
 * Deletes objects from Railway Object Storage.
 * Does not call legacy AWS S3 delete APIs.
 */
const deleteFileFromS3 = async (fileKeys) => {
  try {
    if (!fileKeys) return;

    const keys = Array.isArray(fileKeys) ? fileKeys : [fileKeys];

    const railwayObjects = keys
      .map(getRailwayKey)
      .filter(Boolean)
      .map((Key) => ({ Key }));

    if (railwayObjects.length > 0) {
      await getRailwayS3().send(
        new DeleteObjectsCommand({
          Bucket: getRailwayBucket(),
          Delete: { Objects: railwayObjects },
        })
      );
      console.log(`✓ Deleted ${railwayObjects.length} object(s) from Railway storage`);
    }
  } catch (error) {
    console.error("Failed to delete files from Railway storage:", error);
    throw new ErrorHandler(
      `Failed to delete files from Railway storage: ${error.message}`,
      StatusCodes.INTERNAL_SERVER_ERROR
    );
  }
};

module.exports = {
  uploadFile,
  deleteFileFromS3,
  getRailwayKey,
  buildMediaUrl: getMediaUrl,
};