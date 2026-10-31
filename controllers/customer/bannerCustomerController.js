const { StatusCodes } = require("http-status-codes");
const ErrorHandler = require("../../middleware/errorHandler");
const Banner = require("../../models/bannerModel");

// Get Active Banners for Home Page
module.exports.getActiveBanners = async (req, res, next) => {
  try {
    const banners = await Banner.find({ status: 1 }).sort({
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
        error.message || "Failed to fetch active banners",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};
