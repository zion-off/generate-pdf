const express = require("express");
const path = require("path");
const puppeteer = require("puppeteer");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8000;

const EXTENSION_PATH = path.resolve("./", "extension");
const EXTENSION_ID = "lkbebcjgcmobigpeffafkodonchffocl";
const TIMEOUT_DURATION = 300000;

app.use(cors());

async function getBrowser() {
  let browser;
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
      timeout: 0,
    });

    console.log("Browser launched successfully");
    return browser;
  } catch (error) {
    console.error("Error launching browser:", error);
    throw error; // Propagate the error to handle it in the calling function
  }
}

app.get("/generate-pdf", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  let browser;
  try {
    console.log("Launching browser...");
    browser = await getBrowser();
    console.log("Browser launched");

    const page = await browser.newPage();
    console.log("New page created");

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Operation timed out")),
        TIMEOUT_DURATION
      )
    );

    console.log("Configuring extension...");
    const optionsPageUrl = `chrome-extension://${EXTENSION_ID}/options/options.html`;
    await Promise.race([
      page.goto(optionsPageUrl, { waitUntil: "networkidle2" }),
      timeoutPromise,
    ]);
    await Promise.race([page.click("#save_top"), timeoutPromise]);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const optInUrl = `chrome-extension://${EXTENSION_ID}/options/optin/opt-in.html`;
    await Promise.race([
      page.goto(optInUrl, { waitUntil: "networkidle2" }),
      timeoutPromise,
    ]);
    await Promise.race([page.click("#optin-enable"), timeoutPromise]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("Extension configured");

    console.log(`Navigating to ${url}...`);
    const targetUrl = decodeURIComponent(url);
    await Promise.race([page.goto(targetUrl, { timeout: 0 }), timeoutPromise]);
    console.log("Navigation complete");

    console.log("Generating PDF...");
    // const pdfBuffer = await Promise.race([
    //   page.pdf({
    //     format: "A4",
    //     printBackground: true,
    //     margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
    //   }),
    //   timeoutPromise,
    // ]);
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "1cm", right: "1cm", bottom: "1cm", left: "1cm" },
    }, { timeout: 0 });
    console.log("PDF generated");

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="generated_page.pdf"',
    });

    res.send(pdfBuffer);
  } catch (error) {
    console.error("Error generating PDF:", error);
    res
      .status(500)
      .json({ error: "Error generating PDF", message: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
