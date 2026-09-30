/**
 * utils/mediaUrl.js
 * Centralized utility for building and parsing Railway media URLs.
 */

const getMediaBaseUrl = () => {
  const base = process.env.MEDIA_BASE_URL || "https://api.nutrajun.com";
  return base.replace(/\/+$/, "");
};

/**
 * Returns a stable media URL for a given Railway S3 object key or legacy S3 URL.
 * Example: Nutrajun/products/image.jpg -> https://api.nutrajun.com/media/Nutrajun/products/image.jpg
 */
const getMediaUrl = (pathOrKey) => {
  if (!pathOrKey || typeof pathOrKey !== "string") return "";

  const base = getMediaBaseUrl();

  // If already a media URL with current base, return as-is
  if (pathOrKey.startsWith(`${base}/media/`)) {
    return pathOrKey;
  }

  // If it's an AWS S3 URL, extract key and convert to Railway media URL
  if (pathOrKey.includes(".amazonaws.com/")) {
    const key = pathOrKey.split(".amazonaws.com/")[1];
    return `${base}/media/${key.replace(/^\/+/, "")}`;
  }

  // If starts with /media/
  if (pathOrKey.startsWith("/media/")) {
    const key = pathOrKey.slice("/media/".length);
    return `${base}/media/${key.replace(/^\/+/, "")}`;
  }

  // If full HTTP URL to another domain with /media/
  if (pathOrKey.startsWith("http://") || pathOrKey.startsWith("https://")) {
    try {
      const parsed = new URL(pathOrKey);
      if (parsed.pathname.startsWith("/media/")) {
        const key = parsed.pathname.slice("/media/".length);
        return `${base}/media/${key.replace(/^\/+/, "")}`;
      }
    } catch (e) {
      // Fallback
    }
  }

  // Raw key format: Nutrajun/products/filename.jpg
  const cleanKey = pathOrKey.replace(/^\/+/, "");
  return `${base}/media/${cleanKey}`;
};

/**
 * Parses a media URL or legacy AWS URL and extracts the Railway S3 object key.
 * Example: https://api.nutrajun.com/media/Nutrajun/products/image.jpg -> Nutrajun/products/image.jpg
 */
const getRailwayKey = (urlOrKey) => {
  if (!urlOrKey || typeof urlOrKey !== "string") return null;

  // Handle AWS S3 URLs first
  if (urlOrKey.includes(".amazonaws.com/")) {
    const key = urlOrKey.split(".amazonaws.com/")[1];
    return key ? decodeURIComponent(key.replace(/^\/+/, "")) : null;
  }

  let pathname = urlOrKey;
  if (urlOrKey.startsWith("http://") || urlOrKey.startsWith("https://")) {
    try {
      pathname = new URL(urlOrKey).pathname;
    } catch (e) {
      pathname = urlOrKey;
    }
  }

  if (pathname.startsWith("/media/")) {
    const key = pathname.slice("/media/".length);
    return key ? decodeURIComponent(key.replace(/^\/+/, "")) : null;
  }

  if (pathname.startsWith("Nutrajun/")) {
    return decodeURIComponent(pathname.replace(/^\/+/, ""));
  }

  if (pathname.includes("Nutrajun/")) {
    const key = pathname.slice(pathname.indexOf("Nutrajun/"));
    return decodeURIComponent(key);
  }

  return null;
};

module.exports = {
  getMediaBaseUrl,
  getMediaUrl,
  getRailwayKey,
};
