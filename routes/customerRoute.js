const express = require("express");
const router = express.Router()
const { protectRoute, allowAccess } = require("../middleware/auth");

const customerAuthController = require("../controllers/customer/customerAuthController");
const customerController = require("../controllers/customer/customerController");
const customerProductController = require("../controllers/customer/productCustomer");
const customerCategoryController = require("../controllers/customer/categoryCoustomer");
const cartController = require("../controllers/customer/cartController");
const orderController = require("../controllers/customer/orderController");
const paymentController = require("../controllers/paymentController");
const wishlistController = require("../controllers/customer/wishlistController");
const offerCustomerController = require("../controllers/customer/offerCustomerController");
const bannerCustomerController = require("../controllers/customer/bannerCustomerController");
const Order = require("../models/orderModel");
const { createContact } = require("../controllers/admin/contactController");
const { createAffiliate } = require("../controllers/admin/affiliateController");
const { getAllGalleryMainWeb } = require("../controllers/admin/galleryController");
const { uploadFile } = require("../middleware/multer-s3-upload");

const uploadReviewPhoto = uploadFile("reviews").single("image");


// Register OTP routes
router.post("/customer/auth/register/send-otp", customerAuthController.sendRegisterOTP);
router.post("/customer/auth/register/verify-otp", customerAuthController.verifyRegisterOTP);

router.post("/customer/auth/login/send-otp", customerAuthController.sendLoginOTP);
router.post("/customer/auth/login/verify-otp", customerAuthController.verifyLoginOTP);

router.post("/customer/auth/google", customerAuthController.googleAuth);

router.post("/customer/auth/check-customer", customerAuthController.checkCustomerByEmail);

// profile
router.get("/customer/get/:id", protectRoute, allowAccess(["customer"]), customerController.getCustomerData);
router.put("/customer/update/:id", protectRoute, allowAccess(["customer"]), customerController.updateCustomerData);
router.get("/customer/profile-status/:id", protectRoute, allowAccess(["customer"]), customerController.checkProfileCompletion);

//Product 
router.get("/customer/product/home", customerProductController.getProductsCustomerHome)
router.get("/customer/product/all", customerProductController.getAllProductsCustomer)
router.get("/customer/product/one/:id", customerProductController.getSingleProductCustomer)

//Offer
router.get("/customer/offer/home", offerCustomerController.getHomeOffers);
router.get("/customer/offer/product/:productId", offerCustomerController.getOfferForProduct);

//Banner
router.get("/customer/banner/all", bannerCustomerController.getActiveBanners);

//Category
router.get("/customer/category/all", customerCategoryController.getAllCategories)
router.get("/customer/category/one/:categoryId", customerCategoryController.getCategoryById)

//Review
router.post("/customer/review/add/:productId", protectRoute, allowAccess(["customer"]), uploadReviewPhoto, customerProductController.addReviewCustomer)

//Cart
router.post("/customer/cart/add", protectRoute, allowAccess(["customer"]), cartController.addToCart)
router.get("/customer/cart/items", protectRoute, allowAccess(["customer"]), cartController.getCart)
router.put("/customer/cart/item/remove", protectRoute, allowAccess(["customer"]), cartController.removeItem)
router.put("/customer/cart/item/update-quantity", protectRoute, allowAccess(["customer"]), cartController.updateQuantity)
router.delete("/customer/cart/clear", protectRoute, allowAccess(["customer"]), cartController.clearCart)

// wishlist
router.post("/customer/wishlist/add", protectRoute, allowAccess(["customer"]), wishlistController.addToWishlist);
router.get("/customer/wishlist", protectRoute, allowAccess(["customer"]), wishlistController.getWishlist);
router.delete("/customer/wishlist/remove/:productId", protectRoute, allowAccess(["customer"]), wishlistController.removeFromWishlist);
router.delete("/customer/wishlist/clear", protectRoute, allowAccess(["customer"]), wishlistController.clearWishlist);
router.get("/customer/wishlist/check/:productId", protectRoute, allowAccess(["customer"]), wishlistController.checkWishlistProduct);

//order
router.post("/customer/order/create", protectRoute, allowAccess(["customer"]), orderController.placeOrder)
// router.get("/customer/order/verify-payment/:order_id", protectRoute, allowAccess(["customer"]), orderController.verifyPaymentStatus)
router.post("/customer/order/verify-payment", protectRoute, allowAccess(["customer"]), orderController.verifyPaymentStatus)
router.get("/customer/order/all/:customerId", protectRoute, allowAccess(["customer"]), orderController.getCustomerAllOrders)
router.get("/customer/order/one/:customerId/:orderId", protectRoute, allowAccess(["customer"]), orderController.getCustomerOrderById)
router.post("/customer/coupon/validate", protectRoute, allowAccess(["customer"]), orderController.validateCoupon)
router.get("/customer/coupon/list", protectRoute, allowAccess(["customer"]), orderController.getActiveCoupons)

router.get("/payment/status/:payment_id", paymentController.checkPaymentStatus);

router.get("/blog", customerController.getBlogs)
router.get("/blog/:id", customerController.getBlog)
router.post("/contact/sent", createContact);
router.post("/affiliate/join", createAffiliate);
router.get("/gallery", getAllGalleryMainWeb);

router.get("/order/invoice/:orderId", async (req, res) => {
  const orderId = req.params.orderId;
  const order = await Order.findById(orderId).lean().populate("items.product");

  paymentController.generateInvoicePDF(order, (err, filePath) => {
    if (err) {
      return res.status(500).json({ message: "Error generating invoice." });
    }
    res.download(filePath);
  });
});

module.exports = router
