const { resend } = require("../config/emailConfig");

/**
 * Helper to get a valid sender address for Resend.
 * Resend does not allow sending from public domains like @gmail.com or @yahoo.com.
 * If an unverified domain is detected, it falls back to onboarding@resend.dev for testing.
 */
const getValidSender = () => {
  const configuredSender = process.env.EMAIL_FROM || process.env.EMAIL;
  if (!configuredSender || /@(gmail\.com|yahoo\.com|outlook\.com|hotmail\.com)/i.test(configuredSender)) {
    console.warn(
      `[Resend Warning] "${configuredSender}" cannot be used as sender on Resend. Resend requires a verified custom domain (e.g. orders@nutrajun.com) or "onboarding@resend.dev" for testing. Using "Nutrajun <onboarding@resend.dev>".`
    );
    return "Nutrajun <onboarding@resend.dev>";
  }
  return configuredSender;
};

/**
 * Function to send an OTP email via Resend HTTPS API
 * @param {string} email - Recipient's email
 * @param {string} subject - Email subject
 * @param {string} message - Email content (HTML)
 */
//otp mail
module.exports.OTPEmail = async (email, subject, message) => {
  const fromEmail = getValidSender();
  console.log("Starting OTP email send via Resend from:", fromEmail);
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
  const fromEmail = getValidSender();
  console.log("Starting ORDER email send via Resend from:", fromEmail);
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
