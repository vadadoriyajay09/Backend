const { Resend } = require("resend");

const resendApiKey = process.env.RESEND_API_KEY;

if (!resendApiKey) {
  console.error("RESEND_API_KEY is missing from environment variables");
}

const resend = new Resend(resendApiKey || "RESEND_API_KEY_MISSING");

module.exports = { resend };


