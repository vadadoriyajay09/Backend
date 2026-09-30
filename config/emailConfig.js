const nodemailer = require("nodemailer");

const emailUser = process.env.EMAIL;
const emailPassword = process.env.EMAIL_PASSWORD;

if (!emailUser || !emailPassword) {
  console.error("EMAIL or EMAIL_PASSWORD is missing");
}

const createTransporter = () => {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: emailUser,
      pass: emailPassword,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
};

module.exports.transporterOTP = createTransporter();
module.exports.transporterORDER = createTransporter();

