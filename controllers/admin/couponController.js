const Coupon = require("../../models/couponModel");
const { StatusCodes } = require("http-status-codes");
const ErrorHandler = require("../../middleware/errorHandler");
const orderModel = require("../../models/orderModel");

module.exports.createCoupon = async (req, res, next) => {
  try {
    const { code, percentage, status, note, expiryDate, noExpiry } = req.body;

    const existing = await Coupon.findOne({ code: code.toUpperCase() });
    if (existing) {
      return next(new ErrorHandler("Coupon code already exists", StatusCodes.BAD_REQUEST));
    }

    const reqMinQty = req.body.minimumCartQuantity !== undefined
      ? req.body.minimumCartQuantity
      : req.body.minimum_cart_quantity;
    const minimumCartQuantity = (reqMinQty !== undefined && reqMinQty !== null && reqMinQty !== "")
      ? Math.max(parseInt(reqMinQty) || 0, 0)
      : 0;

    const reqMinAmount = req.body.minimumCartAmount !== undefined
      ? req.body.minimumCartAmount
      : req.body.minimum_cart_amount;
    const minimumCartAmount = (reqMinAmount !== undefined && reqMinAmount !== null && reqMinAmount !== "")
      ? Math.max(parseFloat(reqMinAmount) || 0, 0)
      : 0;

    let discountType = "percentage";
    if (req.body.discountType === "amount") {
      discountType = "amount";
    } else if (req.body.discountType === "buy_x_get_y") {
      discountType = "buy_x_get_y";
    }

    const discountAmount = discountType === "amount"
      ? Math.max(parseFloat(req.body.discountAmount) || 0, 0)
      : 0;

    const percentageVal = discountType === "percentage"
      ? Math.max(parseFloat(percentage) || 0, 0)
      : 0;

    const buyQuantity = discountType === "buy_x_get_y"
      ? Math.max(parseInt(req.body.buyQuantity ?? req.body.buy_quantity ?? 2) || 2, 1)
      : 0;

    const getFreeQuantity = discountType === "buy_x_get_y"
      ? Math.max(parseInt(req.body.getFreeQuantity ?? req.body.get_free_quantity ?? 1) || 1, 1)
      : 0;

    let finalMinQty = minimumCartQuantity;
    if (discountType === "buy_x_get_y") {
      finalMinQty = Math.max(finalMinQty, buyQuantity + getFreeQuantity);
    }

    const newCoupon = new Coupon({
      code: code.toUpperCase(),
      percentage: percentageVal,
      discountType,
      discountAmount,
      buyQuantity,
      getFreeQuantity,
      status,
      note,
      expiryDate: noExpiry ? null : expiryDate,
      noExpiry: !!noExpiry,
      minimumCartQuantity: finalMinQty,
      minimumCartAmount,
    });

    await newCoupon.save();

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Coupon created successfully",
      data: newCoupon,
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.updateCoupon = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    if (updateData.noExpiry) {
      updateData.expiryDate = null;
    }

    const reqMinQty = updateData.minimumCartQuantity !== undefined
      ? updateData.minimumCartQuantity
      : updateData.minimum_cart_quantity;

    if (reqMinQty !== undefined && reqMinQty !== null && reqMinQty !== "") {
      updateData.minimumCartQuantity = Math.max(parseInt(reqMinQty) || 0, 0);
    }

    const reqMinAmount = updateData.minimumCartAmount !== undefined
      ? updateData.minimumCartAmount
      : updateData.minimum_cart_amount;

    if (reqMinAmount !== undefined && reqMinAmount !== null && reqMinAmount !== "") {
      updateData.minimumCartAmount = Math.max(parseFloat(reqMinAmount) || 0, 0);
    }

    if (updateData.discountType) {
      if (updateData.discountType === "amount") {
        updateData.discountType = "amount";
        updateData.discountAmount = Math.max(parseFloat(updateData.discountAmount) || 0, 0);
        updateData.percentage = 0;
        updateData.buyQuantity = 0;
        updateData.getFreeQuantity = 0;
      } else if (updateData.discountType === "buy_x_get_y") {
        updateData.discountType = "buy_x_get_y";
        updateData.discountAmount = 0;
        updateData.percentage = 0;
        updateData.buyQuantity = Math.max(parseInt(updateData.buyQuantity ?? updateData.buy_quantity ?? 2) || 2, 1);
        updateData.getFreeQuantity = Math.max(parseInt(updateData.getFreeQuantity ?? updateData.get_free_quantity ?? 1) || 1, 1);
        const minBundle = updateData.buyQuantity + updateData.getFreeQuantity;
        if (!updateData.minimumCartQuantity || updateData.minimumCartQuantity < minBundle) {
          updateData.minimumCartQuantity = minBundle;
        }
      } else {
        updateData.discountType = "percentage";
        updateData.discountAmount = 0;
        updateData.buyQuantity = 0;
        updateData.getFreeQuantity = 0;
      }
    }

    const updatedCoupon = await Coupon.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!updatedCoupon) {
      return next(new ErrorHandler("Coupon not found", StatusCodes.NOT_FOUND));
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Coupon updated successfully",
      data: updatedCoupon,
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.deleteCoupon = async (req, res, next) => {
  try {
    const { id } = req.params;

    const deleted = await Coupon.findByIdAndDelete(id);

    if (!deleted) {
      return next(new ErrorHandler("Coupon not found", StatusCodes.NOT_FOUND));
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.getCouponById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const coupon = await Coupon.findById(id).populate("orderIds");

    if (!coupon) {
      return next(new ErrorHandler("Coupon not found", StatusCodes.NOT_FOUND));
    }

    res.status(StatusCodes.OK).json({
      success: true,
      data: coupon,
      totalOrders: coupon.orderIds.length,
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.getAllCoupons = async (req, res, next) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 });

    const result = coupons.map((c) => ({
      ...c.toObject(),
      totalOrders: c.orderIds.length,
    }));

    res.status(StatusCodes.OK).json({
      success: true,
      count: coupons.length,
      data: result,
    });
  } catch (error) {
    return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

module.exports.getCouponAnalyticsById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const coupon = await Coupon.findById(id).lean();
    if (!coupon) {
      return next(new ErrorHandler("Coupon not found", StatusCodes.NOT_FOUND));
    }

    const orders = await orderModel.find({
      coupon_id: id,
      "payment.payment_status": "Paid"  // include only PAID orders
    })
    .populate("customer", "name email phone")
    .lean();

    if (!orders.length) {
      return res.status(StatusCodes.OK).json({
        success: true,
        message: "No paid orders found for this coupon.",
        data: {
          code: coupon.code,
          percentage: coupon.percentage,
          status: coupon.status,
          totalOrders: 0,
          totalRevenue: 0,
          orders: [],
        },
      });
    }

    let totalRevenue = 0;

    const orderDetails = orders.map((order) => {
      const paidAmount = order.payment?.total_amount || 0;
      const totalQty = order.items?.reduce(
        (sum, item) => sum + (item.quantity || 0),
        0
      ) || 0;

      totalRevenue += paidAmount;

      return {
        orderId: order.orderID,
        customer: order.customer_details?.name || "N/A",
        email: order.customer_details?.email || "N/A",
        phone: order.customer_details?.phone || "N/A",
        payment_status: order.payment?.payment_status || "Pending",
        payment_method: order.payment?.payment_method || "Pending",
        paid_amount: paidAmount,
        total_quantity: totalQty,
        order_status: order.order_status,
        shipment_status: order.shipment?.shipment_status || "pending",
        createdAt: order.createdAt,
      };
    });

    res.status(StatusCodes.OK).json({
      success: true,
      data: {
        code: coupon.code,
        percentage: coupon.percentage,
        status: coupon.status,
        expiryDate: coupon.expiryDate,
        noExpiry: coupon.noExpiry,
        usageCount: coupon.usageCount,
        totalOrders: orders.length,
        totalRevenue,
        orders: orderDetails,
      },
    });
  } catch (error) {
    next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};
