const { StatusCodes } = require("http-status-codes");
const ErrorHandler = require("../../middleware/errorHandler");
const Product = require("../../models/productModel");
const Category = require("../../models/categoryModel");
const { deleteFileFromS3 } = require("../../middleware/multer-s3-upload");
const {
  sanitizeProductForResponse,
  sanitizeProductPayload,
} = require("../../utils/productContentSanitizer");
const { triggerFrontendDeploy } = require("../../services/deployTrigger");

function hasProductChangesThatRequireDeploy(oldProduct, updatedData) {
  if (!oldProduct || !updatedData) return false;

  // Check title/name
  if (oldProduct.title !== updatedData.title) return true;
  if (oldProduct.name !== updatedData.name) return true;

  // Check slug (url_key)
  if (oldProduct.url_key !== updatedData.url_key) return true;

  // Check description
  if (oldProduct.description !== updatedData.description) return true;
  if (oldProduct.short_description !== updatedData.short_description) return true;
  if (JSON.stringify(oldProduct.product_description) !== JSON.stringify(updatedData.product_description)) return true;

  // Check SEO fields (meta)
  const oldMeta = oldProduct.meta || {};
  const newMeta = updatedData.meta || {};
  if (oldMeta.meta_title !== newMeta.meta_title) return true;
  if (oldMeta.meta_description !== newMeta.meta_description) return true;
  if (oldMeta.meta_keywords !== newMeta.meta_keywords) return true;

  // Check status (active/inactive)
  if (oldProduct.status !== updatedData.status) return true;

  // Check main image
  if (oldProduct.main_image !== updatedData.main_image) return true;

  // Check images array
  const oldImages = oldProduct.images || [];
  const newImages = updatedData.images || [];
  if (oldImages.length !== newImages.length) return true;
  for (let i = 0; i < oldImages.length; i++) {
    if (oldImages[i] !== newImages[i]) return true;
  }

  // Check category
  const oldCats = oldProduct.category || [];
  const newCats = updatedData.category || [];
  if (oldCats.length !== newCats.length) return true;
  const oldCatIds = oldCats.map(c => c.toString()).sort();
  const newCatIds = newCats.map(c => c.toString()).sort();
  for (let i = 0; i < oldCatIds.length; i++) {
    if (oldCatIds[i] !== newCatIds[i]) return true;
  }

  // Check anchor tags
  const oldAnchors = oldProduct.anchor_tags || [];
  const newAnchors = updatedData.anchor_tags || [];
  if (JSON.stringify(oldAnchors) !== JSON.stringify(newAnchors)) return true;

  return false;
}


function parseNestedForm(body) {
  const parsed = {};

  for (const key in body) {
    const rawValue = body[key];
    const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;

    if (key.includes("[")) {
      const [base, rest] = key.split("[");
      const bracketContent = rest.split("]")[0];
      const afterBracket = rest.substring(bracketContent.length + 1);
      const index = parseInt(bracketContent, 10);

      if (!isNaN(index)) {
        // Array format: key[0].title
        const subKey = afterBracket.startsWith(".") ? afterBracket.slice(1) : null;
        if (!parsed[base]) parsed[base] = [];
        if (!parsed[base][index]) parsed[base][index] = {};
        if (subKey) {
          parsed[base][index][subKey] = value;
        }
      } else {
        // Object format: meta[meta_title]
        const subKey = bracketContent;
        if (!parsed[base]) parsed[base] = {};
        parsed[base][subKey] = value;
      }
    } else if (key.includes(".") && !key.includes("[")) {
      // Nested: product_details.diet_type
      const parts = key.split(".");
      let current = parsed;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!current[p]) current[p] = {};
        current = current[p];
      }
      current[parts[parts.length - 1]] = value;
    } else {
      parsed[key] = value;
    }
  }

  // Convert sparse arrays to dense and ensure product_details (merge product_detail if present)
  const arrayFields = ["key_benefits", "product_description", "disclaimer"];
  arrayFields.forEach((field) => {
    if (Array.isArray(parsed[field])) {
      parsed[field] = parsed[field].filter((item) => item && (Object.keys(item).length > 0 || item.title || item.description));
    }
  });
  if (parsed.product_detail && !parsed.product_details) {
    parsed.product_details = parsed.product_detail;
  }
  delete parsed.product_detail;

  return parsed;
}

module.exports.createProduct = async (req, res, next) => {
  try {
    const { main_image, images, videos } = req.files || {};

    if (!main_image || main_image.length === 0) {
      return next(new ErrorHandler("Main image is required.", StatusCodes.BAD_REQUEST));
    }

    const parsedBody = sanitizeProductPayload(parseNestedForm(req.body));

    const newProduct = new Product({
      ...parsedBody,
      main_image: main_image[0].location,
      images: images ? images.map((f) => f.location) : [],
      videos: videos ? videos.map((f) => f.location) : [],
    });

    await newProduct.save();
    console.log("✓ Product Created");
    triggerFrontendDeploy();

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Product created successfully",
      data: sanitizeProductForResponse(newProduct),
    });

  } catch (error) {
    return next(new ErrorHandler(error.message, error.statusCode || 500));
  }
};

module.exports.editProduct = async (req, res, next) => {
  try {
    const { productId } = req.params;

    let product = await Product.findById(productId);
    if (!product) {
      return next(
        new ErrorHandler("Product not found.", StatusCodes.NOT_FOUND)
      );
    }

    const parsedBody = sanitizeProductPayload(parseNestedForm(req.body));

    const { main_image, images, videos } = req.files || {};

    let mainImage = product.main_image;
    let updatedImages = product.images ? [...product.images] : [];
    let updatedVideos = product.videos ? [...product.videos] : [];

    if (main_image && main_image.length > 0) {
      if (product.main_image) {
        await deleteFileFromS3(product.main_image);
      }
      mainImage = main_image[0].location;
    }

    if (images && images.length > 0) {
      const newImageUrls = images.map((file) => file.location);
      const existingImages = Array.isArray(parsedBody.existing_images)
        ? parsedBody.existing_images
        : typeof parsedBody.existing_images === "string"
          ? (() => { try { return JSON.parse(parsedBody.existing_images); } catch { return []; } })()
          : [];
      updatedImages = [...existingImages, ...newImageUrls];
    } else if (parsedBody.existing_images !== undefined) {
      const existingImages = Array.isArray(parsedBody.existing_images)
        ? parsedBody.existing_images
        : typeof parsedBody.existing_images === "string"
          ? (() => { try { return JSON.parse(parsedBody.existing_images); } catch { return []; } })()
          : [];
      updatedImages = existingImages;
    }

    if (videos && videos.length > 0) {
      const newVideoUrls = videos.map((file) => file.location);
      const existingVideos = Array.isArray(parsedBody.existing_videos)
        ? parsedBody.existing_videos
        : typeof parsedBody.existing_videos === "string"
          ? (() => { try { return JSON.parse(parsedBody.existing_videos); } catch { return []; } })()
          : [];
      updatedVideos = [...existingVideos, ...newVideoUrls];
    } else if (parsedBody.existing_videos !== undefined) {
      const existingVideos = Array.isArray(parsedBody.existing_videos)
        ? parsedBody.existing_videos
        : typeof parsedBody.existing_videos === "string"
          ? (() => { try { return JSON.parse(parsedBody.existing_videos); } catch { return []; } })()
          : [];
      updatedVideos = existingVideos;
    }

    const newCategoryIds = parsedBody.category || req.body.category || [];
    const newCategoryArray = Array.isArray(newCategoryIds)
      ? newCategoryIds
      : [newCategoryIds].filter(Boolean);

    const oldCategoryIds = product.category || [];

    const removedCategoryIds = oldCategoryIds.filter(
      (id) => !newCategoryArray.includes(id.toString())
    );
    const addedCategoryIds = newCategoryArray.filter(
      (id) => !oldCategoryIds.map((cid) => cid.toString()).includes(id.toString())
    );

    await Promise.all(
      removedCategoryIds.map((catId) =>
        Category.findByIdAndUpdate(
          catId,
          { $pull: { products: product._id } },
          { new: true }
        )
      )
    );

    await Promise.all(
      addedCategoryIds.map((catId) =>
        Category.findByIdAndUpdate(
          catId,
          { $addToSet: { products: product._id } },
          { new: true }
        )
      )
    );

    const excludeFields = ["existing_images", "existing_videos", "category"];
    const baseUpdate = { ...parsedBody };
    excludeFields.forEach((f) => delete baseUpdate[f]);

    const updatedData = {
      ...baseUpdate,
      main_image: mainImage,
      images: updatedImages,
      videos: updatedVideos,
      category: newCategoryArray,
    };

    const isDeployNeeded = hasProductChangesThatRequireDeploy(product, updatedData);

    const updatedProduct = await Product.findByIdAndUpdate(
      productId,
      updatedData,
      { new: true }
    );

    if (isDeployNeeded) {
      triggerFrontendDeploy();
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Product updated successfully",
      data: sanitizeProductForResponse(updatedProduct),
    });
  } catch (error) {
    console.error("Error updating product:", error);
    return next(
      new ErrorHandler(
        error.message,
        error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

module.exports.getProductById = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const product = await Product.findById(productId);

    if (!product) {
      return next(
        new ErrorHandler("Product not found.", StatusCodes.NOT_FOUND)
      );
    }

    res.status(StatusCodes.OK).json({
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

module.exports.getAllProducts = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 10;
    const skip = (page - 1) * perPage;

    // Build filter object
    const filter = {};

    // Category filter
    if (req.query.category) {
      filter.category = req.query.category;
    }

    // Status filter
    if (req.query.status !== undefined && req.query.status !== null && req.query.status !== "") {
      const numericStatus = parseInt(req.query.status);
      if (!isNaN(numericStatus)) {
        filter.status = numericStatus;
      }
    }

    // Search filter (by name or SKU)
    if (req.query.search && req.query.search.trim() !== "") {
      const searchTerm = req.query.search.trim();
      filter.$or = [
        { name: { $regex: searchTerm, $options: "i" } },
        { sku: { $regex: searchTerm, $options: "i" } }
      ];
    }

    // Product type filter: 0 = main selling products, 1 = freeze-dried / inquiry products
    if (req.query.productType !== undefined && req.query.productType !== null && req.query.productType !== "") {
      const productType = parseInt(req.query.productType, 10);
      if (productType === 0 || productType === 1) {
        filter.inquiry = productType;
      }
    }

    const [products, totalProductsCount] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1, _id: -1 })  // Added _id to ensure consistent sorting
        .skip(skip)
        .limit(perPage),
      Product.countDocuments(filter),
    ]);

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Products retrieved successfully",
      data: products.map(sanitizeProductForResponse),
      pagination: {
        total_items: totalProductsCount,
        total_pages: Math.ceil(totalProductsCount / perPage),
        current_page_item: products.length,
        page_no: page,
        items_per_page: perPage,
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

module.exports.deleteProductImages = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { imageLinks } = req.body;

    if (!productId) {
      return next(
        new ErrorHandler("Product ID is required.", StatusCodes.BAD_REQUEST)
      );
    }

    if (!Array.isArray(imageLinks) || imageLinks.length === 0) {
      return next(
        new ErrorHandler(
          "imageLinks must be a non-empty array of image URLs.",
          StatusCodes.BAD_REQUEST
        )
      );
    }

    const product = await Product.findById(productId);
    if (!product) {
      return next(new ErrorHandler("Product not found.", StatusCodes.NOT_FOUND));
    }

    // ✅ Delete from S3
    await deleteFileFromS3(imageLinks);

    // ✅ Remove image links from product
    const updatedImages = product.images.filter(
      (img) => !imageLinks.includes(img)
    );

    product.images = updatedImages;
    await product.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Selected image(s) deleted successfully from S3 and product.",
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

module.exports.deleteProduct = async (req, res, next) => {
  try {
    const { productId } = req.params;
    const product = await Product.findById(productId);
    if (!product) {
      return next(new ErrorHandler("Product not found.", StatusCodes.NOT_FOUND));
    }

    const allMediaToDelete = [];
    if (product.main_image) allMediaToDelete.push(product.main_image);

    if (Array.isArray(product.images) && product.images.length > 0) {
      product.images.forEach((img) => {
        const url = typeof img === "string" ? img : img?.url || img?.name;
        if (url) allMediaToDelete.push(url);
      });
    }

    if (Array.isArray(product.videos) && product.videos.length > 0) {
      product.videos.forEach((vid) => {
        const url = typeof vid === "string" ? vid : vid?.url || vid?.name;
        if (url) allMediaToDelete.push(url);
      });
    }

    if (allMediaToDelete.length > 0) {
      await deleteFileFromS3(allMediaToDelete);
    }


    if (Array.isArray(product.category) && product.category.length > 0) {
      await Promise.all(
        product.category.map((catId) =>
          Category.findByIdAndUpdate(
            catId,
            { $pull: { products: product._id } },
            { new: true }
          )
        )
      );
    }

    await Product.findByIdAndDelete(productId);
    triggerFrontendDeploy();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Product and its images deleted successfully",
    });
  } catch (error) {
    return next(
      new ErrorHandler(error.message, error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR)
    );
  }
};

module.exports.deleteReview = async (req, res, next) => {
  try {
    const { productId, reviewId } = req.params;

    const product = await Product.findById(productId);
    if (!product)
      return next(new ErrorHandler("Product not found", StatusCodes.NOT_FOUND));

    const reviewIndex = product.reviews.findIndex(
      (r) => r._id.toString() === reviewId
    );

    if (reviewIndex === -1) {
      return next(
        new ErrorHandler("Review not found", StatusCodes.NOT_FOUND)
      );
    }

    product.reviews.splice(reviewIndex, 1);

    await product.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Review deleted successfully",
      data: product,
    });
  } catch (error) {
    return next(
      new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR)
    );
  }
};

module.exports.getAllReviews = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || req.query.page_no, 10) || 1;
    const perPage = parseInt(req.query.perPage || req.query.items_per_page, 10) || 10;
    const skip = (page - 1) * perPage;

    const productMatch = {};
    if (req.query.search && req.query.search.trim() !== "") {
      const searchTerm = req.query.search.trim();
      productMatch.$or = [
        { name: { $regex: searchTerm, $options: "i" } },
        { sku: { $regex: searchTerm, $options: "i" } },
      ];
    }
    if (req.query.status !== undefined && req.query.status !== null && req.query.status !== "") {
      const numericStatus = parseInt(req.query.status, 10);
      if (!Number.isNaN(numericStatus)) {
        productMatch.status = numericStatus;
      }
    }

    const pipeline = [];
    if (Object.keys(productMatch).length > 0) {
      pipeline.push({ $match: productMatch });
    }

    pipeline.push(
      { $unwind: "$reviews" },
      {
        $project: {
          productId: "$_id",
          product: {
            _id: "$_id",
            name: "$name",
            title: "$title",
            main_image: "$main_image",
            sku: "$sku",
            status: "$status",
          },
          review: "$reviews",
        },
      }
    );

    const reviewMatch = {};
    if (req.query.visible !== undefined && req.query.visible !== null && req.query.visible !== "") {
      const visible = parseInt(req.query.visible, 10);
      if (!Number.isNaN(visible)) {
        reviewMatch["review.visible"] = visible;
      }
    }
    if (Object.keys(reviewMatch).length > 0) {
      pipeline.push({ $match: reviewMatch });
    }

    pipeline.push({ $sort: { "review.created_at": -1, "review._id": -1 } });

    const facetPipeline = [
      ...pipeline,
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: perPage }],
          meta: [{ $count: "total_items" }],
        },
      },
    ];

    const result = await Product.aggregate(facetPipeline);
    const facet = result?.[0] || {};
    const rows = facet?.data || [];
    const totalItems = facet?.meta?.[0]?.total_items || 0;

    const data = rows.map((item) => ({
      ...item.review,
      _id: item.review?._id,
      reviewId: item.review?._id,
      productId: item.productId,
      product: item.product,
      customer: item.review?.user_detail || null,
      customerName: item.review?.user_detail?.name || "",
      email: item.review?.user_detail?.email || "",
      createdAt: item.review?.created_at || null,
    }));

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Reviews retrieved successfully",
      data,
      pagination: {
        total_items: totalItems,
        total_pages: Math.ceil(totalItems / perPage) || 1,
        current_page_item: data.length,
        page_no: page,
        items_per_page: perPage,
      },
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.getReviewById = async (req, res, next) => {
  try {
    const { productId, reviewId } = req.params;
    const product = await Product.findById(productId).select("name title main_image sku status reviews");
    if (!product) return next(new ErrorHandler("Product not found", StatusCodes.NOT_FOUND));

    const review = (product.reviews || []).find((r) => r?._id?.toString() === reviewId);
    if (!review) return next(new ErrorHandler("Review not found", StatusCodes.NOT_FOUND));

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Review retrieved successfully",
      data: {
        ...review.toObject(),
        _id: review._id,
        reviewId: review._id,
        productId: product._id,
        product: {
          _id: product._id,
          name: product.name,
          title: product.title,
          main_image: product.main_image,
          sku: product.sku,
          status: product.status,
        },
        customer: review.user_detail || null,
        customerName: review?.user_detail?.name || "",
        email: review?.user_detail?.email || "",
        createdAt: review?.created_at || null,
      },
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.updateReviewVisibility = async (req, res, next) => {
  try {
    const { productId, reviewId } = req.params;
    let { visible, hidden } = req.body || {};

    if (visible === undefined) {
      if (hidden === undefined) {
        return next(new ErrorHandler("visible or hidden value is required", StatusCodes.BAD_REQUEST));
      }
      visible = Number(hidden) === 1 || hidden === true ? 0 : 1;
    }

    const normalizedVisible = Number(visible) === 1 || visible === true ? 1 : 0;

    const product = await Product.findOneAndUpdate(
      { _id: productId, "reviews._id": reviewId },
      { $set: { "reviews.$.visible": normalizedVisible } },
      { new: true }
    );

    if (!product) {
      return next(new ErrorHandler("Product or review not found", StatusCodes.NOT_FOUND));
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      message: `Review ${normalizedVisible === 1 ? "visible" : "hidden"} successfully`,
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};
