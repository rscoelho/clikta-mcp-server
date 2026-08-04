export const API_URL = (process.env.CLIKTA_API_URL || "https://clikta.com").replace(/\/+$/, "");
export const API_TOKEN = process.env.CLIKTA_API_TOKEN || "";
export const HEADLESS = process.env.CLIKTA_MCP_HEADLESS === "true";
