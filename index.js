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

let browser;
let page;
const queue = [];
let isProcessing = false;

async function initializeBrowser() {
  try {
    console.log("Launching puppeteer...");
    browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--single-process",
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
    page = await browser.newPage();
    console.log("New page created");

    await configureExtension();

    return { browser, page };
  } catch (error) {
    console.error("Error launching browser:", error);
    throw error;
  }
}

async function configureExtension() {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Operation timed out")), TIMEOUT_DURATION)
  );

  console.log("Configuring extension...");
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
}

async function generatePDF(url) {
  console.log(`Navigating to ${url}...`);
  const targetUrl = decodeURIComponent(url);
  // await Promise.race([
  //   page.goto(targetUrl, { waitUntil: "networkidle2" }),
  //   timeoutPromise,
  // ]);
  const navigationPromise = page.goto(targetUrl, {
    waitUntil: "networkidle2",
    timeout: TIMEOUT_DURATION,
  });

  try {
    await navigationPromise;
    console.log("Navigation completed with networkidle2");
  } catch (error) {
    if (error.name === "TimeoutError") {
      console.log(
        `Navigation timed out after ${
          TIMEOUT_DURATION / 1000
        } seconds, but continuing anyway`
      );
    } else if (error.message.includes("Navigating frame was detached")) {
      await browser.close();
      await initializeBrowser();
      throw new Error("Navigating frame was detached, retry later");
    } else {
      throw error; // Re-throw if it's not a timeout error or frame detachment
    }
  }
  console.log("Navigation complete");

  console.log("Generating PDF...");
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
    timeout: 0,
  });
  console.log("PDF generated");

  return pdfBuffer;
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

  // Ensure the URL has a protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  queue.push({ url, res });
  processQueue();
});

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

process.on("SIGINT", async () => {
  if (browser) {
    await browser.close();
  }
  process.exit();
});
