const express = require("express");
const path = require("path");
const puppeteer = require("puppeteer");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
const PORT = process.env.PORT || 8000;

const EXTENSION_PATH = path.resolve("./", "extension");
const EXTENSION_ID = "lkbebcjgcmobigpeffafkodonchffocl";
const TIMEOUT_DURATION = 180000;
const MAX_QUEUE_SIZE = 5;
const CLEANUP_INTERVAL = 60000;

let browser;
let page;
const queue = [];
let isProcessing = false;

async function handlePageError(error) {
  console.error('Page crashed:', error);
  try {
    await browser.close();
    await initializeBrowser();
  } catch (err) {
    console.error('Failed to recover from page crash:', err);
  }
}

async function initializeBrowser() {
  try {
    console.log("Launching puppeteer...");
    browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--single-process",
        "--no-zygote",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--disable-default-apps",
        "--disable-sync",
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
      executablePath:
        process.env.NODE_ENV === "production"
          ? process.env.PUPPETEER_EXECUTABLE_PATH
          : puppeteer.executablePath(),
      timeout: 100000,
    });

    browser.on('targetcreated', async (target) => {
      const newPage = await target.page();
      if (newPage) newPage.on('error', handlePageError);
    });

    console.log("Browser launched successfully");
    page = await browser.newPage();
    await configureExtension();

    await page.setJavaScriptEnabled(false);
    await page.setViewport({ width: 375, height: 667 });
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1"
    );
    await page.setCacheEnabled(false);

    console.log("New page created");
    return { browser, page };
  } catch (error) {
    console.error("Error launching browser:", error);
    throw error;
  }
}

async function configureExtension() {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Extension configuration timed out")), TIMEOUT_DURATION)
  );

  console.log("Configuring extension...");
  try {
    const optionsPageUrl = `chrome-extension://${EXTENSION_ID}/options/options.html`;
    await Promise.race([
      page.goto(optionsPageUrl, { waitUntil: "networkidle2" }),
      timeoutPromise,
    ]);
    await Promise.race([page.click("#save_top"), timeoutPromise]);

    const optInUrl = `chrome-extension://${EXTENSION_ID}/options/optin/opt-in.html`;
    await Promise.race([
      page.goto(optInUrl, { waitUntil: "networkidle2" }),
      timeoutPromise,
    ]);
    await Promise.race([page.click("#optin-enable"), timeoutPromise]);
    console.log("Extension configured");
  } catch (error) {
    console.error("Error configuring extension:", error);
    throw error;
  }
}

async function generatePDF(url) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("PDF generation timed out")), TIMEOUT_DURATION)
  );

  console.log(`Navigating to ${url}...`);
  const targetUrl = decodeURIComponent(url);

  try {
    // First, check if the page is still valid
    if (!page.isClosed()) {
      await page.reload(); // Reset the page state
    } else {
      // If page is closed, create a new one
      page = await browser.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setViewport({ width: 375, height: 667 });
      await page.setUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1"
      );
      await page.setCacheEnabled(false);
    }

    // Navigate with more robust error handling
    try {
      await Promise.race([
        page.goto(targetUrl, {
          waitUntil: "networkidle2",
          timeout: TIMEOUT_DURATION / 3,
        }),
        timeoutPromise,
      ]);
      console.log("Navigation completed with networkidle2");
    } catch (navigationError) {
      if (navigationError.message.includes("Navigating frame was detached") ||
          navigationError.message.includes("detached Frame")) {
        console.log("Page detached during navigation, attempting recovery...");
        await initializeBrowser(); // Reinitialize the browser
        throw new Error("Page detached during navigation, please retry");
      }
      throw navigationError;
    }

    // Generate PDF with additional error checking
    console.log("Generating PDF...");
    const pdfBuffer = await Promise.race([
      page.pdf({
        format: "A4",
        margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
        printBackground: true,
        timeout: TIMEOUT_DURATION,
      }),
      timeoutPromise,
    ]);

    console.log("PDF generated successfully");
    return pdfBuffer;
  } catch (error) {
    console.error("Error in PDF generation:", error);
    if (error.message.includes("detached Frame")) {
      await initializeBrowser(); // Reinitialize the browser
      throw new Error("Page detached during PDF generation, please retry");
    }
    throw error;
  }
}

async function processQueue() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const { url, res } = queue.shift();

  try {
    const start = Date.now();
    const pdfBuffer = await generatePDF(url);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="generated_page.pdf"',
    });

    res.send(pdfBuffer);
    const end = Date.now();
    console.log(`PDF sent, time taken: ${end - start}ms`);
  } catch (error) {
    console.error("Error processing request:", error);
    res
      .status(500)
      .json({ error: "Error generating PDF", message: error.message });
  } finally {
    isProcessing = false;
    processQueue();
  }
}

app.get(["/generate-pdf"], async (req, res) => {
  let url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  if (queue.length >= MAX_QUEUE_SIZE) {
    return res.status(503).json({
      error: "Server is busy",
      message: "Too many requests in queue",
    });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  queue.push({ url, res });
  processQueue();
});

// Periodic cleanup of unused pages
setInterval(async () => {
  if (!isProcessing && browser) {
    try {
      const pages = await browser.pages();
      if (pages.length > 1) {
        console.log(`Cleaning up ${pages.length - 1} unused pages`);
        for (let i = 1; i < pages.length; i++) {
          await pages[i].close();
        }
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }
}, CLEANUP_INTERVAL);

// Graceful shutdown
async function shutdown() {
  console.log("Shutting down server...");
  if (browser) {
    await browser.close();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  try {
    await initializeBrowser();
    console.log("Browser and page initialized");
  } catch (error) {
    console.error("Failed to initialize browser:", error);
    process.exit(1);
  }
});
