const { StatusCodes } = require("http-status-codes");
const mongoose = require("mongoose");
const ErrorHandler = require("../../middleware/errorHandler");
const Banner = require("../../models/bannerModel");
const { deleteFileFromS3 } = require("../../middleware/multer-s3-upload");

// Create Banner
module.exports.createBanner = async (req, res, next) => {
  try {
    const imageUrl = req.file?.location || req.body.image;

    if (!imageUrl) {
      return next(
        new ErrorHandler("Banner image is required", StatusCodes.BAD_REQUEST)
      );
    }

    const {
      title = "",
      subtitle = "",
      link = "/products",
      button_text = "Shop Now",
      status = 1,
      priority = 0,
    } = req.body;

    const banner = new Banner({
      title,
      subtitle,
      image: imageUrl,
      link: link || "/products",
      button_text: button_text || "Shop Now",
      status: Number(status) === 0 ? 0 : 1,
      priority: Number(priority) || 0,
    });

    await banner.save();

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Banner created successfully",
      data: banner,
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message || "Failed to create banner",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

// Get All Banners (Admin)
module.exports.getAllBanners = async (req, res, next) => {
  try {
    const { search, status } = req.query;
    let query = {};

    if (search && search.trim()) {
      query.$or = [
        { title: { $regex: search.trim(), $options: "i" } },
        { subtitle: { $regex: search.trim(), $options: "i" } },
      ];
    }

    if (status !== undefined && status !== "") {
      query.status = Number(status);
    }

    const banners = await Banner.find(query).sort({
      priority: -1,
      createdAt: -1,
    });

    res.status(StatusCodes.OK).json({
      success: true,
      count: banners.length,
      data: banners,
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message || "Failed to fetch banners",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

// Get Single Banner by ID
module.exports.getBannerById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid banner id", StatusCodes.BAD_REQUEST));
    }

    const banner = await Banner.findById(id);
    if (!banner) {
      return next(new ErrorHandler("Banner not found", StatusCodes.NOT_FOUND));
    }

    res.status(StatusCodes.OK).json({
      success: true,
      data: banner,
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message || "Failed to fetch banner",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

// Update Banner
module.exports.updateBanner = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid banner id", StatusCodes.BAD_REQUEST));
    }

    const banner = await Banner.findById(id);
    if (!banner) {
      return next(new ErrorHandler("Banner not found", StatusCodes.NOT_FOUND));
    }

    const {
      title,
      subtitle,
      link,
      button_text,
      status,
      priority,
    } = req.body;

    const newImageUrl = req.file?.location;
    if (newImageUrl) {
      if (banner.image && banner.image !== newImageUrl) {
        try {
          await deleteFileFromS3(banner.image);
        } catch (e) {
          // ignore S3 delete error
        }
      }
      banner.image = newImageUrl;
    } else if (req.body.image) {
      banner.image = req.body.image;
    }

    if (title !== undefined) banner.title = title;
    if (subtitle !== undefined) banner.subtitle = subtitle;
    if (link !== undefined) banner.link = link;
    if (button_text !== undefined) banner.button_text = button_text;
    if (status !== undefined) banner.status = Number(status) === 0 ? 0 : 1;
    if (priority !== undefined) banner.priority = Number(priority) || 0;

    await banner.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Banner updated successfully",
      data: banner,
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message || "Failed to update banner",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

// Toggle Banner Status
module.exports.toggleBannerStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid banner id", StatusCodes.BAD_REQUEST));
    }

    const banner = await Banner.findById(id);
    if (!banner) {
      return next(new ErrorHandler("Banner not found", StatusCodes.NOT_FOUND));
    }

    banner.status = banner.status === 1 ? 0 : 1;
    await banner.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: `Banner ${banner.status === 1 ? "activated" : "deactivated"} successfully`,
      data: banner,
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message || "Failed to toggle banner status",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

// Delete Banner
module.exports.deleteBanner = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid banner id", StatusCodes.BAD_REQUEST));
    }

    const banner = await Banner.findByIdAndDelete(id);
    if (!banner) {
      return next(new ErrorHandler("Banner not found", StatusCodes.NOT_FOUND));
    }

    if (banner.image) {
      try {
        await deleteFileFromS3(banner.image);
      } catch (e) {
        // ignore
      }
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Banner deleted successfully",
      data: banner,
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message || "Failed to delete banner",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};
