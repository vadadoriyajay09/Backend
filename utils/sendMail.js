const { transporterOTP, transporterORDER } = require("../config/emailConfig");

/**
 * Function to send an email
 * @param {string} email - Recipient's email
 * @param {string} subject - Email subject
 * @param {string} message - Email content (HTML)
 */
//otp mail
module.exports.OTPEmail = async (email, subject, message) => {
  const mailOptions = {
    from: process.env.EMAIL,
    to: email,
    subject: subject,
    html: message,
  };

  console.log("Starting OTP email send");
  try {
    await transporterOTP.sendMail(mailOptions);
    console.log("OTP email sent successfully");
  } catch (error) {
    console.error("OTP email send failed:", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }
};

module.exports.ORDEREmail = async (email, subject, message) => {
  const mailOptions = {
    from: process.env.EMAIL,
    to: email,
    subject: subject,
    html: message,
  };

  console.log("Starting ORDER email send");
  try {
    await transporterORDER.sendMail(mailOptions);
    console.log("ORDER email sent successfully");
  } catch (error) {
    console.error("ORDER email send failed:", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }
};
