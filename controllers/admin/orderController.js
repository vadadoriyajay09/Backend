const { StatusCodes } = require("http-status-codes");
const exceljs = require("exceljs");
const ErrorHandler = require("../../middleware/errorHandler");
const Order = require("../../models/orderModel");
const { generateBarcodeBase64 } = require("../../utils/barcodeHelper");
const {
  sendOrderAcceptedMail,
  sendShipmentTrackingMail,
} = require("../emailController");

const ALLOWED_SHIPMENT_STATUSES = [
  "pending",
  "packed",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "shipped",
  "delivered",
  "cancelled",
];

module.exports.getAllOrders = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 10;
    const skip = (page - 1) * perPage;

    const {
      _id,
      shipment_status,
      payment_status,
      order_status,
      customerID,
      fromDate,
      toDate,
    } = req.query;

    const filter = {};

    if (_id) {
      filter._id = _id;
    }

    if (shipment_status) {
      filter["shipment.shipment_status"] = shipment_status;
    }

    if (payment_status) {
      filter["payment.payment_status"] = payment_status;
    }

    if (order_status) {
      filter["order_status"] = order_status;
    }

    if (customerID) {
      filter.customer = customerID;
    }

    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = new Date(fromDate);
      if (toDate) filter.createdAt.$lte = new Date(toDate);
    }

    const [orders, totalOrdersCount] = await Promise.all([
      Order.find(filter)
        .select(
          "orderID customer customer_details items order_status payment.payment_status _id createdAt shipment.shipment_status payment.total_amount shipment.is_shipment_confirmed"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage),
      Order.countDocuments(filter),
    ]);

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Orders retrieved successfully",
      data: orders,
      pagination: {
        total_items: totalOrdersCount,
        total_pages: Math.ceil(totalOrdersCount / perPage),
        current_page_item: orders.length,
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

module.exports.getOrderById = async (req, res, next) => {
  try {
    const { _id } = req.params;

    const order = await Order.findById(_id)
      .populate("items.product")
      .populate("customer", "name email phone");

    if (!order) {
      return next(new ErrorHandler("Order not found", StatusCodes.NOT_FOUND));
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Order retrieved successfully",
      data: order,
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

module.exports.updateShipment = async (req, res, next) => {
  try {
    const { _id } = req.params;
    const {
      tracking_Id,
      delivery_partner,
      shipment_status,
      is_shipment_confirmed,
    } = req.body;

    const order = await Order.findById(_id);
    if (!order) {
      return next(new ErrorHandler("Order not found", StatusCodes.NOT_FOUND));
    }

    if (!order.shipment || typeof order.shipment !== "object") {
      order.shipment = {
        shipment_status: "pending",
        is_shipment_confirmed: 0,
      };
    }

    if (order.order_status !== "accept") {
      return next(
        new ErrorHandler(
          "Cannot update shipment. Order must be accepted first.",
          StatusCodes.BAD_REQUEST
        )
      );
    }

    const prevTracking = order.shipment?.tracking_Id || "";

    if (tracking_Id !== undefined && tracking_Id !== null) {
      order.shipment.tracking_Id = String(tracking_Id).trim();
    }
    if (delivery_partner !== undefined && delivery_partner !== null) {
      order.shipment.delivery_partner = String(delivery_partner).trim();
    }

    if (shipment_status) {
      const normalized = String(shipment_status).trim().toLowerCase();
      if (!ALLOWED_SHIPMENT_STATUSES.includes(normalized)) {
        return next(
          new ErrorHandler(
            `Invalid shipment status. Allowed: ${ALLOWED_SHIPMENT_STATUSES.join(", ")}`,
            StatusCodes.BAD_REQUEST
          )
        );
      }
      order.shipment.shipment_status = normalized;
    }

    if (is_shipment_confirmed === true || is_shipment_confirmed === 1) {
      order.shipment.is_shipment_confirmed = 1;
    } else if (is_shipment_confirmed === false || is_shipment_confirmed === 0) {
      order.shipment.is_shipment_confirmed = 0;
    }

    const hasTracking = Boolean(order.shipment.tracking_Id);
    const hasPartner = Boolean(order.shipment.delivery_partner);
    if (hasTracking && hasPartner) {
      order.shipment.is_shipment_confirmed = 1;
      if (!shipment_status) {
        order.shipment.shipment_status = "shipped";
      }
    }

    await order.save();

    const newTracking = order.shipment?.tracking_Id || "";
    if (
      newTracking &&
      newTracking !== prevTracking &&
      order.customer_details?.email
    ) {
      try {
        await sendShipmentTrackingMail({
          email: order.customer_details.email,
          order,
        });
      } catch (e) {
        console.error("sendShipmentTrackingMail failed:", e.message);
      }
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Shipment details updated",
      data: order,
    });
  } catch (error) {
   return next(new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR));
  }
};

const allowedStatuses = [
  "pending",
  "processing",
  "accept",
  "delivered",
  "cancelled",
];

module.exports.updateOrderStatus = async (req, res, next) => {
  try {
    const { _id } = req.params;
    const { status } = req.body;

    if (!status || !allowedStatuses.includes(status)) {
      return next(
        new ErrorHandler(
          `Invalid order status. Allowed statuses are: ${allowedStatuses.join(
            ", "
          )}`,
          StatusCodes.BAD_REQUEST
        )
      );
    }

    const order = await Order.findById(_id);
    if (!order) {
      return next(new ErrorHandler("Order not found", StatusCodes.NOT_FOUND));
    }

    if (order.order_status === status) {
      return next(
        new ErrorHandler(`Order is already ${status}`, StatusCodes.BAD_REQUEST)
      );
    }

    if (status === "accept") {
      const paymentStatus = order.payment.payment_status;
      const paymentMethod = order.payment.payment_method || "Pending";

      if (paymentMethod !== "COD" && paymentStatus !== "Paid") {
        return next(
          new ErrorHandler(
            "Cannot accept order. Payment is not completed.",
            StatusCodes.BAD_REQUEST
          )
        );
      }
    }

    if (status === "delivered") {
      if (order.order_status !== "accept") {
        return next(
          new ErrorHandler(
            "Cannot deliver. Order must be accepted first.",
            StatusCodes.BAD_REQUEST
          )
        );
      }

      if (!order.shipment?.is_shipment_confirmed) {
        return next(
          new ErrorHandler(
            "Cannot deliver. Shipment is not confirmed.",
            StatusCodes.BAD_REQUEST
          )
        );
      }
    }

    order.order_status = status;
    await order.save();

    if (status === "accept" && order.customer_details?.email) {
      try {
        await sendOrderAcceptedMail({
          email: order.customer_details.email,
          order,
        });
      } catch (e) {
        console.error("sendOrderAcceptedMail failed:", e.message);
      }
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: `Order status updated to ${status}`,
      data: order,
    });
  } catch (error) {
    return next(
      new ErrorHandler(error.message, StatusCodes.INTERNAL_SERVER_ERROR)
    );
  }
};

module.exports.downloadOrderExcel = async (req, res, next) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return next(
        new ErrorHandler("Order IDs are required", StatusCodes.NOT_FOUND)
      );
    }

    const orders = await Order.find({ _id: { $in: ids } }).populate(
      "items.product",
      "name"
    );

    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet("Orders");

    worksheet.columns = [
      { header: "Order _id", key: "_id", width: 25 },
      { header: "Order ID", key: "orderID", width: 15 },
      { header: "Customer", key: "customer", width: 25 },
      { header: "Date", key: "date", width: 20 },
      { header: "Shipping Address", key: "shippingAddress", width: 40 },
      { header: "Product", key: "product", width: 30 },
      { header: "Quantity", key: "quantity", width: 10 },
      { header: "Selling Price", key: "item_price", width: 15 },
      { header: "Total (Item × Qty)", key: "total_price", width: 20 },
      { header: "Shipping Amount", key: "shipping", width: 15 },
      // { header: "Tax", key: "tax", width: 10 },
      { header: "Final Paid Amount", key: "total_amount", width: 20 },
      { header: "Payment Status", key: "payment_status", width: 15 },
      { header: "Tracking Number", key: "tracking_Id", width: 25 },
    ];

    orders.forEach((order) => {
      order.items.forEach((item) => {
        worksheet.addRow({
          _id: order._id.toString(),
          orderID: order.orderID,
          customer: order.customer ? order.customer.toString() : "Walk-in Customer",
          date: order.createdAt.toISOString().split("T")[0],
          shippingAddress: `${order.shipping_address.address_line_1}, ${order.shipping_address.address_line_2}, ${order.shipping_address.city}, ${order.shipping_address.state}, ${order.shipping_address.pincode}`,
          product: item.product?.name || "Unknown",
          quantity: item.quantity,
          item_price: item.price?.item_price || 0,
          total_price: item.price?.total_price || 0,
          shipping: order.payment.shipping_charge || 0,
          // tax: order.payment.tax_amount || 0, // optional: only if you use `tax_amount` in schema
          total_amount: order.payment.total_amount,
          payment_status: order.payment.payment_status,
          tracking_Id: order.shipment.tracking_Id || "",
        });
      });
    });

    const currentDate = new Date().toISOString().split("T")[0];
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=orders_${currentDate}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return next(
      new ErrorHandler(
        error.message,
        error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
      )
    );
  }
};

module.exports.createAdminBill = async (req, res, next) => {
  try {
    const {
      customer_details,
      items,
      shipping_address,
      payment,
      notes,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return next(
        new ErrorHandler("At least one item is required", StatusCodes.BAD_REQUEST)
      );
    }

    const orderID = "BILL-" + Date.now().toString().slice(-8);

    let customerId = null;
    const phone = customer_details?.phone ? String(customer_details.phone).trim() : "";
    const email = customer_details?.email ? String(customer_details.email).trim().toLowerCase() : "";
    const name = customer_details?.name ? String(customer_details.name).trim() : "Walk-in Customer";

    if (phone || email) {
      try {
        const Customer = require("../../models/customerModel");
        const query = [];
        if (email) query.push({ email });
        if (phone && /^[6-9]\d{9}$/.test(phone)) query.push({ mobile_number: phone });

        if (query.length > 0) {
          let existingCustomer = await Customer.findOne({ $or: query });
          if (!existingCustomer) {
            const guestEmail = email || `customer_${Date.now()}@nutrajun.com`;
            existingCustomer = await Customer.create({
              name,
              email: guestEmail,
              mobile_number: (/^[6-9]\d{9}$/.test(phone)) ? phone : undefined,
            });
          }
          if (existingCustomer) {
            customerId = existingCustomer._id;
          }
        }
      } catch (custErr) {
        console.warn("Could not find/create customer for bill:", custErr.message);
      }
    }

    const populatedItems = items.map((it) => {
      const itemPrice = Number(it.price || it.item_price || 0);
      const qty = Number(it.quantity || 1);
      const totalPrice = Number(it.total_price || (itemPrice * qty) || 0);

      return {
        product: it.product || it.productId || undefined,
        sku: it.sku || "",
        name: it.name || "Item",
        image_url: it.image_url || it.image || "",
        size: {
          package_weight: it.size?.package_weight || it.weight || "",
          number_of_piecces: it.size?.number_of_piecces || "",
        },
        price: {
          item_price: itemPrice,
          total_price: totalPrice,
        },
        quantity: qty,
      };
    });

    const productTotal = Number(payment?.product_total || 0);
    const discountAmount = Number(payment?.discount_amount || 0);
    const shippingCharge = Number(payment?.shipping_charge || 0);
    const totalAmount = Number(payment?.total_amount || Math.max(0, productTotal - discountAmount + shippingCharge));

    const newOrder = await Order.create({
      customer: customerId || undefined,
      customer_details: {
        name,
        email: email || "walkin@nutrajun.com",
        phone: phone || "N/A",
      },
      items: populatedItems,
      shipping_address: shipping_address || {
        address_line_1: "In-Store / Direct Sale",
        city: "Surat",
        state: "Gujarat",
        country: "India",
        pincode: "395006",
      },
      notes: notes || "Offline / Direct Store Bill",
      orderID,
      payment: {
        product_total: productTotal,
        shipping_charge: shippingCharge,
        discount_amount: discountAmount,
        coupon_discount_amount: Number(payment?.coupon_discount_amount || 0),
        total_amount: totalAmount,
        payment_method: payment?.payment_method || "Cash",
        payment_status: payment?.payment_status || "Paid",
      },
      order_status: "delivered",
      shipment: {
        shipment_status: "delivered",
        is_shipment_confirmed: 1,
      },
    });

    res.status(StatusCodes.CREATED).json({
      success: true,
      message: "Bill created successfully",
      data: newOrder,
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