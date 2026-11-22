const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: false,
    },
    customer_details: {
      name: {
        type: String,
        required: true,
      },
      email: {
        type: String,
        required: true,
      },
      phone: {
        type: String,
        required: true,
      },
    },
    orderID: {
      type: String,
      required: true,
      unique: true,
    },
    notes: {
      type: String,
      default: "",
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: false,
        },
        sku: {
          type: String,
        },
        name: {
          type: String,
        },
        image_url: {
          type: String,
        },
        size: {
          package_weight: { type: String },
          number_of_piecces: { type: String },
        },
        price: {
          item_price: { type: Number },
          total_price: { type: Number },
        },
        quantity: {
          type: Number,
          required: true,
          default: 1,
        },
      },
    ],
    payment: {
      product_total: {
        type: Number,
        required: true,
      },
      shipping_charge: {
        type: Number,
        default: 0,
      },
      discount_amount: {
        type: Number,
        default: 0,
      },
      coupon_discount_amount: {
        type: Number,
        default: 0,
      },
      total_amount: {
        type: Number,
        required: true,
      },
      payment_details: {
        razorpay_order_id: { type: String },
        status: { type: String },
        razorpay_payment_id: { type: String },
        razorpay_signature: { type: String },
        transaction_id: { type: String },
        payment_method: { type: String },
        razorpay_amount: { type: Number },
        bank_reference: { type: String },
        payment_channel: { type: String },
        payment_time: { type: Date },
        bank_reference_number: { type: String },
        description: { type: String },
      },
      payment_method: {
        type: String,
        enum: ["COD", "Online", "Pending", "Cash", "UPI", "Card"],
        default: "Pending",
      },
      payment_status: {
        type: String,
        enum: ["Pending", "Paid", "Canceled", "Authorized", "Failed"],
        default: "Pending",
      },
    },
    shipment: {
      tracking_Id: {
        type: String,
      },
      tracking_url: {
        type: String,
      },
      delivery_partner: {
        type: String,
      },
      charge: {
        type: Number,
        default: 0,
      },
      shipment_status: {
        type: String,
        default: "pending",
      },
      is_shipment_confirmed: {
        type: Number,
        enum: [0, 1],
        default: 0,
      },
    },
    order_status: {
      type: String,
      enum: ["pending", "processing", "accept", "delivered", "cancelled"],
      default: "pending",
    },
    label_create: {
      type: Number,
      enum: [0, 1, 2],
      default: 0,
    },
    coupon_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
    },
    shipping_address: {
      type: {
        type: String,
        enum: ["home", "work", "other"],
        required: true,
      },
      address_line_1: {
        type: String,
        required: true,
      },
      address_line_2: {
        type: String,
        required: true,
      },
      city: {
        type: String,
        required: true,
      },
      state: {
        type: String,
        required: true,
      },
      country: {
        type: String,
        default: "India",
      },
      pincode: {
        type: String,
        required: true,
      },
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);