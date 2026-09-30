require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");
const xss = require("xss-clean");
const rateLimit = require("express-rate-limit");
const hpp = require("hpp");
const errorMiddleware = require("./errors/error");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);

// ==================== 🛡 SECURITY MIDDLEWARE ====================

// Add HTTP security headers
app.use(helmet());

app.use(mongoSanitize());

app.use(xss());

app.use(hpp());

app.use(compression());

// Increase body parser limits for large file uploads
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// CORS setup (configure your frontend origin in production)
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Limit repeated requests to public APIs (brute-force / DDoS protection)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: {
    success: false,
    message: "Too many requests from this IP, please try again later.",
  },
});
app.use("/api", limiter);

// Hide detailed Express info in errors
app.disable("x-powered-by");

// Log requests (only in development)
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// ==================== ⚙️ CORE MIDDLEWARE ====================
// ✅ Allow large uploads (images/videos)

// Default headers for all routes
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  next();
});

// ==================== 🚀 ROUTES ====================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "🚀 Nutrajun Secure API is running safely.",
  });
});

const routeIndex = require("./routes/index");
app.use("/api/v1", routeIndex);

// Stable media URLs for private Railway Bucket objects (302 to presigned URL)
app.use("/media", require("./routes/mediaRoute"));

// Handle undefined routes (404)
app.all("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Can't find ${req.originalUrl} on this server.`,
  });
});

// ==================== 🧱 ERROR HANDLER ====================
app.use(errorMiddleware);

// ==================== ⚡ EXIT HANDLERS ====================
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION 💥 Shutting down...");
  console.error(err.name, err.message);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION 💥 Shutting down...");
  console.error(err.name, err.message);
  server.close(() => process.exit(1));
});

process.on("SIGTERM", () => {
  console.log("👋 SIGTERM RECEIVED. Shutting down gracefully.");
  server.close(() => console.log("💤 Process terminated."));
});

process.on("exit", () => console.log("🛑 App exiting..."));

// ==================== EXPORT ====================
module.exports = { app, server };
