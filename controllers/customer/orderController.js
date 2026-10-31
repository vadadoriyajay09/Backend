const { StatusCodes } = require("http-status-codes");
const Order = require("../../models/orderModel");
const ErrorHandler = require("../../middleware/errorHandler");
const razorpay = require("../../utils/razorpayClient");
const crypto = require("crypto");
const Product = require("../../models/productModel");
const { sendPlacedOrderMail, sendPaymentStatusMail } = require("../emailController");
const Coupon = require("../../models/couponModel");
const Cart = require("../../models/cartModel");
const { getActiveDiscountedPrice } = require("../../utils/offerHelper");

const isComboProduct = (item) => {
  if (!item) return false;
  const name = item.name || item.title || item.product?.name || item.product?.title || "";
  const sku = item.sku || item.product?.sku || "";
  return /combo/i.test(name) || /combo/i.test(sku);
};

module.exports.placeOrder = async (req, res, next) => {
  try {
    const { customer, customer_details, items, shipping_address, coupon_id, notes } = req.body;

    if (!items || items.length === 0) {
      return next(new ErrorHandler("Items are required", StatusCodes.BAD_REQUEST));
    }

    if (!customer_details?.email || !customer_details?.name || !customer_details?.phone) {
      return next(
        new ErrorHandler("customer_details (name, email, phone) are required", StatusCodes.BAD_REQUEST)
      );
    }

    const customerId = customer != null ? customer : req.id;
    if (String(customerId) !== String(req.id)) {
      return next(
        new ErrorHandler("Customer id must match the logged-in user (use the same id as in your JWT)", StatusCodes.FORBIDDEN)
      );
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return next(
        new ErrorHandler(
          "Payment gateway is not configured (missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env)",
          StatusCodes.SERVICE_UNAVAILABLE
        )
      );
    }

    let product_total = 0;
    let discount_amount = 0;
    let coupon_discount_amount = 0;
    let shipping_charge = 0;

    const populatedItems = [];

    for (const it of items) {
      const product = await Product.findById(it.product).lean();
      if (!product) {
        return next(new ErrorHandler("Product not found", StatusCodes.NOT_FOUND));
      }

      const websitePrice = Number(product.price?.website_price || 0);
      const perProductShipping = Number(product.price?.shipping_charge || 0);

      // 1. Get dynamic offer discount (replaces old discounted_percentage)
      const discountedVal = await getActiveDiscountedPrice(it.product, websitePrice);
      const discount_per_unit = discountedVal !== null ? (websitePrice - discountedVal) : 0;
      const final_item_unit_price = websitePrice - discount_per_unit;

      const qty = Number(it.quantity || 1);

      // Keep track of base (item_price) and total savings (discount_amount)
      discount_amount += discount_per_unit * qty;
      product_total += websitePrice * qty;
      shipping_charge += perProductShipping * qty;

      populatedItems.push({
        product: it.product,
        sku: it.sku,
        size: it.size,
        name: product.name,
        image_url: product.main_image,
        price: {
          item_price: websitePrice,
          total_price: final_item_unit_price * qty,
          discount_amount: discount_per_unit, // Capture for order review
        },
        quantity: qty,
      });
    }

    let couponDetails = null;
    if (coupon_id) {
      couponDetails = await Coupon.findOne({
        _id: coupon_id,
        status: "active",
        $or: [
          { noExpiry: true },
          { expiryDate: { $gte: new Date() } }
        ]
      });

      if (!couponDetails) {
        return next(new ErrorHandler("Coupon is invalid or has expired", StatusCodes.BAD_REQUEST));
      }

      const totalItemsQty = populatedItems.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0);
      const net_total = Math.max(product_total - discount_amount, 0);

      // Validate minimum cart amount
      if (couponDetails.minimumCartAmount > 0 && net_total < couponDetails.minimumCartAmount) {
        return next(
          new ErrorHandler(
            `Coupon ${couponDetails.code} requires a minimum order of ₹${couponDetails.minimumCartAmount}`,
            StatusCodes.BAD_REQUEST
          )
        );
      }

      // Validate minimum cart quantity & calculate coupon discount
      if (couponDetails.discountType === "buy_x_get_y") {
        const buyX = couponDetails.buyQuantity || 2;
        const getY = couponDetails.getFreeQuantity || 1;
        const minBundle = Math.max(couponDetails.minimumCartQuantity || 0, buyX + getY);

        // Filter to single products only (combos excluded)
        const eligibleItems = populatedItems.filter((it) => !isComboProduct(it));
        const eligibleSingleQty = eligibleItems.reduce((acc, it) => acc + (Number(it.quantity) || 1), 0);

        if (eligibleSingleQty < minBundle) {
          return next(
            new ErrorHandler(
              `Coupon ${couponDetails.code} (Buy ${buyX} Get ${getY} Free) is applicable only on single products and requires at least ${minBundle} single product item(s) in your cart.`,
              StatusCodes.BAD_REQUEST
            )
          );
        }

        // Expand individual unit prices for ELIGIBLE SINGLE PRODUCTS ONLY
        const unitPrices = [];
        for (const it of eligibleItems) {
          const qty = Number(it.quantity || 1);
          const unitPrice = Math.max(Number(it.price.item_price - it.price.discount_amount) || 0, 0);
          for (let q = 0; q < qty; q++) {
            unitPrices.push(unitPrice);
          }
        }
        unitPrices.sort((a, b) => a - b); // Cheapest first
        const bundleSize = buyX + getY;
        const sets = Math.floor(unitPrices.length / bundleSize);
        const freeCount = sets * getY;
        let sumFree = 0;
        for (let i = 0; i < freeCount && i < unitPrices.length; i++) {
          sumFree += unitPrices[i];
        }
        coupon_discount_amount = Number(sumFree.toFixed(2));
      } else if (couponDetails.discountType === "amount") {
        if (couponDetails.minimumCartQuantity > 0 && totalItemsQty < couponDetails.minimumCartQuantity) {
          return next(
            new ErrorHandler(
              `Coupon ${couponDetails.code} requires at least ${couponDetails.minimumCartQuantity} item(s) in your cart.`,
              StatusCodes.BAD_REQUEST
            )
          );
        }
        coupon_discount_amount = Math.min(Number(couponDetails.discountAmount || 0), net_total);
      } else {
        // Percentage discount
        if (couponDetails.minimumCartQuantity > 0 && totalItemsQty < couponDetails.minimumCartQuantity) {
          return next(
            new ErrorHandler(
              `Coupon ${couponDetails.code} requires at least ${couponDetails.minimumCartQuantity} item(s) in your cart.`,
              StatusCodes.BAD_REQUEST
            )
          );
        }
        if (couponDetails.percentage) {
          coupon_discount_amount = Number(((net_total * couponDetails.percentage) / 100).toFixed(2));
        }
      }
    }

    const total_amount = Number(
      (product_total - discount_amount - coupon_discount_amount + shipping_charge)
        .toFixed(2)
    );

    if (!Number.isFinite(total_amount) || total_amount < 0) {
      return next(
        new ErrorHandler("Invalid order total. Check product prices and discounts.", StatusCodes.BAD_REQUEST)
      );
    }

    // Razorpay INR minimum is typically ₹1.00 (100 paise)
    const amountPaise = Math.round(total_amount * 100);
    if (amountPaise < 100) {
      return next(
        new ErrorHandler(
          `Order total is ₹${total_amount} after discounts. Minimum payable amount is ₹1. Reduce the coupon or add items.`,
          StatusCodes.BAD_REQUEST
        )
      );
    }

    let razorpayOrder;
    try {
      razorpayOrder = await razorpay.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: "RCPT-" + Date.now(),
        notes: {
          customer_email: customer_details.email,
          customer_name: customer_details.name,
        },
      });
    } catch (rzpErr) {
      console.error("Razorpay orders.create failed:", rzpErr?.error || rzpErr?.message || rzpErr);
      const rzpMsg =
        rzpErr?.error?.description ||
        rzpErr?.error?.reason ||
        rzpErr?.message ||
        "Could not create Razorpay order. Check keys and amount.";
      return next(new ErrorHandler(rzpMsg, StatusCodes.BAD_REQUEST));
    }

    const orderID = "ORD-" + Date.now();

    const newOrder = await Order.create({
      customer: customerId,
      customer_details,
      items: populatedItems,
      shipping_address,
      notes,
      coupon_id,
      orderID,
      payment: {
        product_total,
        shipping_charge,
        total_amount,
        discount_amount,
        coupon_discount_amount,
        payment_details: {
          razorpay_order_id: razorpayOrder.id,
          razorpay_amount: razorpayOrder.amount,
          status: "created",
        },
        payment_method: "Online",
        payment_status: "Pending",
      },
    });

    try {
      await sendPlacedOrderMail({
        email: customer_details.email,
        order: newOrder,
        items: populatedItems,
        razorpayOrder,
      });
    } catch (mailErr) {
      console.error("sendPlacedOrderMail failed (order still created):", mailErr?.message || mailErr);
    }

    return res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Order placed successfully",
      razorpayOrder,
      data: newOrder,
    });

  } catch (error) {
    next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.verifyPaymentStatus = async (req, res, next) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      order_id,
    } = req.body;

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    const isValid = expectedSignature === razorpay_signature;

    const order = await Order.findById(order_id);
    if (!order) {
      return next(new ErrorHandler("Order not found", StatusCodes.NOT_FOUND));
    }

    if (isValid) {
      order.payment.payment_status = "Paid";
      order.payment.payment_details = {
        ...order.payment.payment_details,
        razorpay_payment_id,
        razorpay_signature,
        status: "paid",
      };
      order.order_status = "processing";

      await order.save();

      // await sendOrderMail(
      //   order.customer_details.email,
      //   order.orderID,
      //   order.items,
      //   order.payment.total_amount
      // )

      return res.status(StatusCodes.OK).json({
        success: true,
        message: "Payment verified successfully",
        data: order,
      });
    } else {
      return next(
        new ErrorHandler("Payment verification failed", StatusCodes.BAD_REQUEST)
      );
    }
  } catch (error) {
    return next(new ErrorHandler(error, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.updatePaymentStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { payment_status, payment_details } = req.body;

    const order = await Order.findById(id).populate("items.product");
    if (!order)
      return next(new ErrorHandler("Order not found", StatusCodes.NOT_FOUND));

    if (payment_status) order.payment.payment_status = payment_status;

    if (payment_details) {
      order.payment.payment_details = {
        ...order.payment.payment_details,
        ...payment_details,
      };
    }

    if (payment_status === "Paid") {
      order.order_status = "processing";

      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.product._id,
          { $inc: { qty: -item.quantity } },
          { new: true }
        );
      }

      const couponId = order.coupon_id;
      if (couponId) {
        const coupon = await Coupon.findById(couponId);

        if (coupon) {
          const alreadyExists = coupon.orderIds.includes(order._id);

          if (!alreadyExists) {
            coupon.orderIds.push(order._id);
            coupon.usageCount += 1;
            await coupon.save();
          }
        }
      }

      await sendPaymentStatusMail({
        email: order.customer_details.email,
        name: order.customer_details.name,
        order,
      });
    }

    await order.save();

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Payment status updated successfully",
      data: order,
    });

  } catch (error) {
    return next(
      new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR)
    );
  }
};

module.exports.getCustomerAllOrders = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    let { page = 1, perPage = 10 } = req.query;

    page = parseInt(page);
    perPage = parseInt(perPage);

    if (!customerId) {
      return next(
        new ErrorHandler("Customer ID is required", StatusCodes.BAD_REQUEST)
      );
    }

    const totalCount = await Order.countDocuments({ customer: customerId });

    const orders = await Order.find({ customer: customerId })
      .select(
        "_id orderID createdAt order_status payment items shipment shipping_address customer"
      )
      .populate({
        path: "items.product",
        select: "name",
      })
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage);

    const formattedOrders = orders.map((order) => {
      const products = order.items.map((item) => ({
        name: item.product?.name || "Unknown",
        quantity: item.quantity,
        price: `₹${item.price?.item_price || 0}`,
      }));

      const totalItems = order.items.reduce(
        (sum, item) => sum + item.quantity,
        0
      );

      const shipping = order.shipping_address;
      const shippingAddress = `${shipping.address_line_1}, ${shipping.address_line_2}, ${shipping.city}, ${shipping.state} - ${shipping.pincode}`;

      return {
        _id: order._id,
        customer: order.customer,
        order_id: `#${order.orderID}`,
        date: new Date(order.createdAt).toISOString().split("T")[0],
        status: order.order_status,
        total: `₹${order.payment.total_amount}`,
        items: totalItems,
        products,
        shippingAddress,
        trackingNumber: order.shipment?.tracking_Id || "N/A",
        courierPartner: order.shipment?.delivery_partner || "",
        shipmentStatus: order.shipment?.shipment_status || "pending",
        trackingUrl: order.shipment?.tracking_url || null,
        payment_status: order.payment.payment_status,
        payment_details: order.payment.payment_details || {},
      };
    });

    res.status(StatusCodes.OK).json({
      success: true,
      count: formattedOrders.length,
      data: formattedOrders,
      pagination: {
        total_items: totalCount,
        total_pages: Math.ceil(totalCount / perPage),
        current_page_item: formattedOrders.length,
        page_no: page,
        items_per_page: perPage,
      },
    });
  } catch (error) {
    return next(
      new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR)
    );
  }
};

module.exports.getCustomerOrderById = async (req, res, next) => {
  try {
    const { customerId, orderId } = req.params;

    if (!customerId || !orderId) {
      return next(
        new ErrorHandler(
          "Customer ID and Order ID are required",
          StatusCodes.BAD_REQUEST
        )
      );
    }

    const order = await Order.findOne({ _id: orderId, customer: customerId })
      // .populate("customer", "-password")
      .populate("items.product")
      .lean();

    if (!order) {
      return next(
        new ErrorHandler(
          "Order not found for this customer",
          StatusCodes.NOT_FOUND
        )
      );
    }

    res.status(StatusCodes.OK).json({
      success: true,
      data: order,
    });
  } catch (error) {
    return next(
      new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR)
    );
  }
};

module.exports.validateCoupon = async (req, res, next) => {
  try {
    const { code } = req.body;
    const cartTotal = Number(req.body.cart_total ?? req.body.cartTotal ?? 0);
    const cartQuantity = Number(req.body.cart_quantity ?? req.body.cartQuantity ?? 0);

    if (!code || typeof code !== "string" || code.trim().length === 0) {
      return next(new ErrorHandler("Coupon code is required", StatusCodes.BAD_REQUEST));
    }

    const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });

    if (!coupon) {
      return res.status(StatusCodes.NOT_FOUND).json({
        success: false,
        message: "Invalid coupon code",
      });
    }

    if (coupon.status !== "active") {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: "Coupon is inactive",
      });
    }

    if (!coupon.noExpiry && coupon.expiryDate) {
      const now = new Date();
      if (now > coupon.expiryDate) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: "Coupon has expired",
        });
      }
    }

    // Minimum cart quantity validation
    if (coupon.discountType === "buy_x_get_y") {
      const buyX = coupon.buyQuantity || 2;
      const getY = coupon.getFreeQuantity || 1;
      const minRequired = Math.max(coupon.minimumCartQuantity || 0, buyX + getY);

      let singleQuantity = Number(req.body.single_quantity ?? req.body.singleQuantity ?? -1);

      if (singleQuantity < 0 && req.id) {
        try {
          const userCart = await Cart.findOne({ customer_id: req.id }).populate("items.product", "name title sku");
          if (userCart && Array.isArray(userCart.items)) {
            singleQuantity = userCart.items
              .filter((it) => it.product && !isComboProduct(it.product))
              .reduce((sum, it) => sum + (Number(it.quantity) || 1), 0);
          }
        } catch (err) {
          // ignore error and fallback
        }
      }

      const effectiveQty = singleQuantity >= 0 ? singleQuantity : cartQuantity;

      if (effectiveQty > 0 && effectiveQty < minRequired) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          success: false,
          message: `Coupon "${coupon.code}" (Buy ${buyX} Get ${getY} Free) is valid only on single products and requires at least ${minRequired} single product item(s). Add ${minRequired - effectiveQty} more single product(s) to unlock.`,
        });
      }
    } else if (coupon.minimumCartQuantity > 0 && cartQuantity > 0 && cartQuantity < coupon.minimumCartQuantity) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: `This coupon requires a minimum of ${coupon.minimumCartQuantity} item(s) in your cart`,
      });
    }

    if (coupon.minimumCartAmount > 0 && cartTotal > 0 && cartTotal < coupon.minimumCartAmount) {
      return res.status(StatusCodes.BAD_REQUEST).json({
        success: false,
        message: `This coupon requires a minimum order of ₹${coupon.minimumCartAmount}`,
      });
    }

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Coupon is valid",
      data: {
        code: coupon.code,
        discountType: coupon.discountType || "percentage",
        discountPercentage: coupon.percentage,
        discountAmount: coupon.discountAmount || 0,
        buyQuantity: coupon.buyQuantity || 0,
        getFreeQuantity: coupon.getFreeQuantity || 0,
        note: coupon.note,
        expiryDate: coupon.noExpiry ? null : coupon.expiryDate,
        noExpiry: coupon.noExpiry,
        minimumCartQuantity: coupon.minimumCartQuantity || 0,
        minimumCartAmount: coupon.minimumCartAmount || 0,
        _id: coupon._id
      },
    });
  } catch (error) {
    return next(new ErrorHandler(error.message || "Error validating coupon", StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.getActiveCoupons = async (req, res, next) => {
  try {
    const now = new Date();

    const coupons = await Coupon.find({
      status: "active",
      $or: [{ noExpiry: true }, { expiryDate: { $gte: now } }, { expiryDate: null }],
    })
      .sort({ minimumCartAmount: 1, minimumCartQuantity: 1 })
      .select("code percentage discountType discountAmount buyQuantity getFreeQuantity note expiryDate noExpiry minimumCartQuantity minimumCartAmount");

    return res.status(StatusCodes.OK).json({
      success: true,
      data: coupons.map((coupon) => ({
        _id: coupon._id,
        code: coupon.code,
        discountType: coupon.discountType || "percentage",
        discountPercentage: coupon.percentage,
        discountAmount: coupon.discountAmount || 0,
        buyQuantity: coupon.buyQuantity || 0,
        getFreeQuantity: coupon.getFreeQuantity || 0,
        note: coupon.note,
        expiryDate: coupon.noExpiry ? null : coupon.expiryDate,
        noExpiry: coupon.noExpiry,
        minimumCartQuantity: coupon.minimumCartQuantity || 0,
        minimumCartAmount: coupon.minimumCartAmount || 0,
      })),
    });
  } catch (error) {
    return next(new ErrorHandler(error.message || "Error fetching coupons", StatusCodes.INTERNAL_SERVER_ERROR));
  }
};
