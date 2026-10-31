const { StatusCodes } = require("http-status-codes");
const ErrorHandler = require("../../middleware/errorHandler");
const Product = require("../../models/productModel");
const { default: mongoose } = require("mongoose");
const User = require("../../models/adminModel");
const Customer = require("../../models/customerModel");
const { sanitizeProductForResponse } = require("../../utils/productContentSanitizer");

module.exports.getProductsCustomerHome = async (req, res, next) => {
  try {
    const visibilityFilter = req.query.visibility_home || 1;
    const products = await Product.find({ visibility_home: visibilityFilter, status: 1 }).sort({ createdAt: -1 });

    return res.status(StatusCodes.OK).json({
      code: StatusCodes.OK,
      success: true,
      message: "Products retrieved successfully",
      data: products.map(sanitizeProductForResponse),
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message,
        error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

module.exports.searchProductsCustomer = async (req, res, next) => {
  try {
    const { query } = req.query;
    if (!query) {
      return next(
        new ErrorHandler("Search query is required", StatusCodes.BAD_REQUEST)
      );
    }

    const products = await Product.find({
      status: 1,
      $or: [
        { name: { $regex: query, $options: "i" } },
        { title: { $regex: query, $options: "i" } },
        { description: { $regex: query, $options: "i" } },
      ],
    });

    return res.status(StatusCodes.OK).json({
      code: StatusCodes.OK,
      success: true,
      message: "Search results retrieved successfully",
      data: products.map(sanitizeProductForResponse),
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message,
        error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

module.exports.getSingleProductCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;

    let product;
    if (mongoose.Types.ObjectId.isValid(id)) {
      product = await Product.findOne({ _id: id, status: 1 });
    } else {
      product = await Product.findOne({ sku: id, status: 1 });
    }

    if (!product) {
      return next(new ErrorHandler("Product not found", StatusCodes.NOT_FOUND));
    }

    return res.status(StatusCodes.OK).json({
      code: StatusCodes.OK,
      success: true,
      message: "Product retrieved successfully",
      data: sanitizeProductForResponse(product),
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message,
        error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

module.exports.getAllProductsCustomer = async (req, res, next) => {
  try {
    const parsePositiveInt = (value, fallback) => {
      const parsed = parseInt(value, 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
    };

    const {
      category,
      minPrice,
      maxPrice,
      qty,
      search,
      status = 1,
      page,
      perPage,
      page_no,
      items_per_page,
      limit,
      stock_availability
    } = req.query;

    const productType = req.query.productType;
    const normalizedPage = parsePositiveInt(page_no ?? page, 1);
    const normalizedItemsPerPage = parsePositiveInt(items_per_page ?? perPage ?? limit, 10);

    if (productType === undefined) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "productType is required. Allowed values: 0 (Normal) or 1 (Inquiry)",
      });
    }

    if (!["0", "1"].includes(productType)) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Invalid productType. Allowed values are 0 (Normal) or 1 (Inquiry)",
      });
    }

    let filter = {};

    filter.inquiry = Number(productType);

    if (stock_availability !== undefined) {
      if (!["0", "1"].includes(stock_availability)) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Invalid stock_availability. Allowed values are 0 or 1",
        });
      }
      filter.stock_availability = Number(stock_availability);
    }

    if (category) {
      const categoryArray = Array.isArray(category)
        ? category
        : category.split(",").map(id => id.trim());
      const normalizedCategories = categoryArray
        .filter(Boolean)
        .map((id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id));
      filter.category = { $in: normalizedCategories };
    }

    if (qty) {
      filter.qty = { $gte: Number(qty) };
    }

    if (minPrice != null || maxPrice != null) {
      filter["price.website_price"] = {};
      if (minPrice != null)
        filter["price.website_price"].$gte = Number(minPrice);
      if (maxPrice != null)
        filter["price.website_price"].$lte = Number(maxPrice);
    }

    if (search && String(search).trim()) {
      const searchText = String(search).trim();
      filter.$or = [
        { name: { $regex: searchText, $options: "i" } },
        { title: { $regex: searchText, $options: "i" } },
        { description: { $regex: searchText, $options: "i" } },
        { sku: { $regex: searchText, $options: "i" } },
      ];
    }

    filter.status = Number(status);

    const skip = (normalizedPage - 1) * normalizedItemsPerPage;
    const deterministicSort = { createdAt: -1, _id: -1 };
    const matchStage = { $match: filter };
    const dedupeStage = {
      $group: {
        _id: "$_id",
        doc: { $first: "$$ROOT" },
      },
    };

    const [products, totalCountResult] = await Promise.all([
      Product.aggregate([
        matchStage,
        { $sort: deterministicSort },
        dedupeStage,
        { $replaceRoot: { newRoot: "$doc" } },
        { $sort: deterministicSort },
        { $skip: skip },
        { $limit: normalizedItemsPerPage },
      ]),
      Product.aggregate([
        matchStage,
        dedupeStage,
        { $count: "total_items" },
      ]),
    ]);

    const totalCount = totalCountResult[0]?.total_items || 0;

    return res.status(StatusCodes.OK).json({
      code: StatusCodes.OK,
      success: true,
      message: "Product retrieved successfully",
      data: products.map(sanitizeProductForResponse),
      pagination: {
        total_items: totalCount,
        total_pages: Math.ceil(totalCount / normalizedItemsPerPage),
        current_page_item: products.length,
        page_no: normalizedPage,
        items_per_page: normalizedItemsPerPage,
      },
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message,
        error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

module.exports.addReviewCustomer = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const rating = Number(req.body.rating);
    const comment = req.body.comment?.trim?.() || "";
    const title = req.body.title?.trim?.() || "";

    // Parse user_detail (may be string if sent via FormData)
    let user_detail = req.body.user_detail;
    if (typeof user_detail === "string") {
      try {
        user_detail = JSON.parse(user_detail);
      } catch (e) {
        user_detail = { name: user_detail };
      }
    }

    if (!user_detail || !user_detail.name) {
      user_detail = {
        name: req.body.name || req.user?.name || "Customer",
        email: req.body.email || req.user?.email || "",
        mobile_number: req.body.mobile_number || req.body.phone || "",
        country: req.body.country || "India",
      };
    }

    // Attach profile_photo if available
    let customerPhoto = user_detail.profile_photo || req.user?.profile_photo || "";
    const customerId = req.user?._id || req.body.customer_id;
    if (!customerPhoto && customerId) {
      try {
        const foundCustomer = await Customer.findById(customerId).select("profile_photo name");
        if (foundCustomer?.profile_photo) {
          customerPhoto = foundCustomer.profile_photo;
        }
      } catch (e) {
        // ignore
      }
    }
    user_detail.profile_photo = customerPhoto;

    if (!rating || !comment || !user_detail?.name) {
      return next(
        new ErrorHandler(
          "Name, Rating and Comment are required",
          StatusCodes.BAD_REQUEST
        )
      );
    }

    if (rating < 1 || rating > 5) {
      return next(
        new ErrorHandler(
          "Rating must be between 1 and 5",
          StatusCodes.BAD_REQUEST
        )
      );
    }

    const product = await Product.findById(productId);
    if (!product) {
      return next(new ErrorHandler("Product not found", StatusCodes.NOT_FOUND));
    }

    // Capture uploaded image from multer (req.file.location) or body
    const reviewImage = req.file?.location || req.body.image || null;

    // Check if user already reviewed
    const existingIndex = product.reviews.findIndex((rev) => {
      const existingName = rev.user_detail?.name?.toString()?.toLowerCase();
      const currentName = user_detail?.name?.toString()?.toLowerCase();
      const existingEmail = rev.user_detail?.email?.toString()?.toLowerCase();
      const currentEmail = user_detail?.email?.toString()?.toLowerCase();

      return (
        (existingEmail && currentEmail && existingEmail === currentEmail) ||
        (existingName && currentName && existingName === currentName)
      );
    });

    const reviewObj = {
      rating,
      title,
      comment,
      user_detail,
      image: reviewImage,
      visible: 1,
      created_at: new Date(),
    };

    if (existingIndex >= 0) {
      if (!reviewImage && product.reviews[existingIndex].image) {
        reviewObj.image = product.reviews[existingIndex].image;
      }
      product.reviews[existingIndex] = {
        ...(product.reviews[existingIndex].toObject?.() || product.reviews[existingIndex]),
        ...reviewObj,
      };
    } else {
      product.reviews.push(reviewObj);
    }

    await product.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: existingIndex >= 0 ? "Review updated successfully" : "Review added successfully",
      data: reviewObj,
    });
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message || "Something went wrong",
        StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};
