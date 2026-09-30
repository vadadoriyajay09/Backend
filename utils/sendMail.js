const { resend } = require("../config/emailConfig");

/**
 * Function to send an OTP email via Resend HTTPS API
 * @param {string} email - Recipient's email
 * @param {string} subject - Email subject
 * @param {string} message - Email content (HTML)
 */
//otp mail
module.exports.OTPEmail = async (email, subject, message) => {
  const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL;
  console.log("Starting OTP email send via Resend");
  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: subject,
      html: message,
    });

    if (error) {
      console.error("OTP email send failed via Resend:", {
        name: error.name,
        message: error.message,
      });
      throw new Error(error.message || "Failed to send OTP email via Resend");
    }

    console.log("OTP email sent successfully via Resend");
    return data;
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
  const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL;
  console.log("Starting ORDER email send via Resend");
  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: subject,
      html: message,
    });

    if (error) {
      console.error("ORDER email send failed via Resend:", {
        name: error.name,
        message: error.message,
      });
      throw new Error(error.message || "Failed to send ORDER email via Resend");
    }

    console.log("ORDER email sent successfully via Resend");
    return data;
  } catch (error) {
    console.error("ORDER email send failed:", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    throw error;
  }
};
