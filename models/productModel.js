const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  short_description: { type: String, required: true },
  disclaimer: [{ type: String }],
  category: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },
  ],
  url_key: {
    type: String
  },
  qty: {
    type: Number,
    required: true,
    min: [0, "Quantity cannot be less than 0"],
    validate: {
      validator: function (v) {
        if (v === 0 && this.stock_availability !== 0) {
          this.stock_availability = 0;
        } else if (v > 0 && this.stock_availability === 0) {
          this.stock_availability = 1;
        }
        return true;
      },
    },
  },
  stock_availability: {
    type: Number,
    enum: [0, 1],
    required: true,
    default: 1,
  },
  visibility_home: {
    type: Number,
    enum: [0, 1],
    required: true
  },
  status: {
    type: Number,
    enum: [0, 1],
    default: 0
  },
  sku: {
    type: String,
    required: true,
    unique: true
  },
  price: {
    website_price: { type: Number, required: true },
    product_price: { type: Number, required: true },
    discounted_percentage: { type: Number },
    shipping_charge: { type: Number },
  },
  platform_link: {
    amazon: { type: String },
    flipkart: { type: String },
  },
  anchor_tags: [
    {
      label: { type: String, trim: true },
      url: { type: String, trim: true },
    },
  ],
  inquiry: {
    type: Number, enum: [0, 1], default: 0
  },
  meta: {
    meta_title: { type: String },
    meta_description: { type: String },
    meta_keywords: { type: String },
  },
  product_details: {
    diet_type: { type: String },
    flavor: { type: String },
    item_form: { type: String },
    brand: { type: String },
    speciality: { type: String },
    number_of_piecces: { type: String },
    package_weight: { type: String },
  },
  additional_information: {
    generic_name: { type: String },
    weight: { type: String },
    dimensions: { type: String },
    marketed_by: { type: String },
    country_of_origin: { type: String },
    best_before: { type: String },
    manufacturer: { type: String },
    license_no: { type: String },
    customer_care_details: { type: String },
  },
  key_benefits: [
    {
      title: { type: String },
      description: { type: String },
    },
  ],
  product_description: [
    {
      title: { type: String },
      description: { type: String },
    },
  ],
  main_image: {
    type: String
  },
  images: [
    { type: String }
  ],
  videos: [
    {
      type: String
    },
  ],
  reviews: [
    {
      user_detail: {
        name: { type: String, required: true },
        email: { type: String },
        mobile_number: { type: String },
        country: { type: String },
        profile_photo: { type: String },
      },
      rating: { type: Number, min: 1, max: 5, required: true },
      title: { type: String },
      comment: { type: String, required: true },
      image: { type: String },
      visible: { type: Number, enum: [0, 1], default: 1 },
      created_at: { type: Date, default: Date.now },
    },
  ],
  payment_detail: {
    free_shipping: { type: Number, enum: [0, 1] },
    cod_available: { type: Number, enum: [0, 1] },
  },

  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Product", productSchema);
