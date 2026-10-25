/** Optional destinations: no upstream marketing/help links are used as fallbacks. */
export const brandLinks = {
  website: process.env.VITE_BRAND_WEBSITE_URL?.trim(),
  docs: process.env.VITE_BRAND_DOCS_URL?.trim(),
  support: process.env.VITE_BRAND_SUPPORT_URL?.trim(),
};
