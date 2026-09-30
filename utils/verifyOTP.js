const OTP = require("../models/OTP");
const crypto = require("crypto");
const ErrorHandler = require("../middleware/errorHandler");
const { StatusCodes } = require("http-status-codes");
const otpTemplate = require("../view/otpTemplate");
const sendEmail = require("./sendMail");

/**
 * @desc Common OTP Verification Function
 * @param {String} email - User's email
 * @param {String} otp - OTP entered by the user
 * @param {String} type - OTP type (register, login, order, etc.)
 * @returns {Boolean} - True if OTP is valid, otherwise throws an error
 */
const verifyOTP = async (email, otp, type) => {
  const otpEntry = await OTP.findOne({ email, type });

  if (!otpEntry) {
    throw new ErrorHandler("OTP not found", StatusCodes.BAD_REQUEST);
  }

  if (otpEntry.otp !== otp) {
    throw new ErrorHandler("Invalid OTP", StatusCodes.BAD_REQUEST);
  }

  if (new Date() > otpEntry.expires_at) {
    await OTP.deleteOne({ email, type });
    throw new ErrorHandler("OTP expired", StatusCodes.BAD_REQUEST);
  }

  await OTP.deleteOne({ email, type });
  return true;
};

const sendOTP = async (email, type) => {
  try {
    const otp = crypto.randomInt(100000, 999999).toString();
    await OTP.findOneAndUpdate(
      { email, type },
      { otp, expires_at: new Date(Date.now() + 5 * 60 * 1000), type },
      { upsert: true }
    );

    const subject = "Your OTP Code";
    const message = otpTemplate(otp);
    await sendEmail.OTPEmail(email, subject, message);
  } catch (error) {
    throw error;
  }
};

module.exports = { verifyOTP, sendOTP };
