const express = require("express");
const path = require("path");
const puppeteer = require("puppeteer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8000;
const EXTENSION_PATH = path.resolve("./", "extension");
const EXTENSION_ID = "lkbebcjgcmobigpeffafkodonchffocl";
const TIMEOUT_DURATION = 100000;

let browser;
let page;

async function initializeBrowser() {
  try {
    console.log("Launching puppeteer...");
    browser = await puppeteer.launch({
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--no-first-run",
        "--no-sandbox",
        "--no-zygote",
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
      executablePath:
        process.env.NODE_ENV == "production"
          ? process.env.PUPPETEER_EXECUTABLE_PATH
          : puppeteer.executablePath(),
      timeout: 100000,
    });
    console.log("Browser launched successfully");

    // Create a single page
    page = await browser.newPage();

    // Configure extension
    console.log("Configuring extension...");
    const optionsPageUrl = `chrome-extension://${EXTENSION_ID}/options/options.html`;
    await page.goto(optionsPageUrl, { waitUntil: "networkidle2", timeout: TIMEOUT_DURATION });
    await page.click("#save_top");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const optInUrl = `chrome-extension://${EXTENSION_ID}/options/optin/opt-in.html`;
    await page.goto(optInUrl, { waitUntil: "networkidle2", timeout: TIMEOUT_DURATION });
    await page.click("#optin-enable");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("Extension configured");
  } catch (error) {
    console.error("Error initializing browser:", error);
    throw error;
  }
}

app.get("/generate-pdf", async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  try {
    console.log(`Navigating to ${url}...`);
    const targetUrl = decodeURIComponent(url);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log("Navigation complete");

    console.log("Generating PDF...");
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
    }, { timeout: 60000 });
    console.log("PDF generated");

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="generated_page.pdf"',
    });
    res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generating PDF:", error);
    res.status(500).json({ error: "Error generating PDF", message: error.message });
  }
});

async function startServer() {
  try {
    await initializeBrowser();
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});