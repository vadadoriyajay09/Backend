const mongoose = require("mongoose");

const bannerSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      default: "",
    },
    subtitle: {
      type: String,
      trim: true,
      default: "",
    },
    image: {
      type: String,
      required: [true, "Banner image is required"],
    },
    link: {
      type: String,
      trim: true,
      default: "/products",
    },
    button_text: {
      type: String,
      trim: true,
      default: "Shop Now",
    },
    status: {
      type: Number,
      enum: [0, 1],
      default: 1, // 1: Active, 0: Inactive
    },
    priority: {
      type: Number,
      default: 0, // Higher number appears first
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Banner", bannerSchema);
