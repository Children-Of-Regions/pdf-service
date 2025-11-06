import express from "express";
import puppeteer from "puppeteer";
import { PassThrough } from "stream";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "10mb" }));

// Test mode flag - read from environment variable, default to false (production mode)
const TEST_MODE = process.env.TEST_MODE === 'true';

// OAuth2 client setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.OAUTH_CALLBACK_URL || `http://localhost:${PORT}/oauth/callback`
);
let tokens = null;
const drive = google.drive({ version: "v3", auth: oauth2Client });

// Load tokens if exist
if (fs.existsSync("tokens.json")) {
  try {
    tokens = JSON.parse(fs.readFileSync("tokens.json", "utf8"));
    oauth2Client.setCredentials(tokens);
    console.log("Loaded existing tokens");
  } catch (err) {
    console.error("Failed to load tokens:", err.message);
  }
}

// Template replacement function
function replaceTemplate(template, data) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    let value = data[key];
    if (value === undefined) return `{{${key}}}`;

    // Դաշտեր, որոնք պետք է ունենան հատուկ ձևավորում
    const listFields = [
      "interests",
      "webinars",
      "team",
      "position",
      "trips",
      "tasks",
      "leadershipAcademy"
    ];

    if (listFields.includes(key)) {
      // Հեռացնել վերջի դատարկ տողերը
      const lines = String(value)
        .split("\n")
        .map(line => line.trim())
        .filter(line => line !== "");

      // Եթե միայն մեկ տող՝ որպես <p>
      if (lines.length === 1) {
        return `<p>${lines[0]}</p>`;
      }

      // Եթե մեկից շատ են՝ որպես <ul><li>...</li></ul>
      return `<ul>` + lines.map(line => `<li>${line.replace(/^- /, "").trim()}</li>`).join("") + `</ul>`;
    }

    // Այլ դաշտերի համար նոր տողերը փոխարինել <br>-ով
    return String(value).replace(/\n/g, "<br>");
  });
}

// Start OAuth flow
app.get("/auth", (req, res) => {
  if (TEST_MODE) {
    return res.send("<h1>Test Mode Active</h1><p>PDFs will be saved locally. No authentication needed.</p>");
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/drive"],
    prompt: "consent",
  });
  res.redirect(url);
});

// OAuth callback
app.get("/oauth/callback", async (req, res) => {
  if (TEST_MODE) {
    return res.send("<h1>Test Mode Active</h1><p>No authentication needed in test mode.</p>");
  }
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(newTokens);
    fs.writeFileSync("tokens.json", JSON.stringify(newTokens, null, 2));
    tokens = newTokens;
    res.send("<h1>Authentication successful!</h1><p>You can now upload PDFs.</p>");
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("Authentication failed");
  }
});

// Check auth status
app.get("/auth-status", (req, res) => {
  if (TEST_MODE) {
    return res.json({ authenticated: true, testMode: true });
  }
  if (tokens) {
    res.json({ authenticated: true, testMode: false });
  } else {
    res.json({ authenticated: false, authUrl: "/auth", testMode: false });
  }
});

function formatDate(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day} / ${month} / ${year}`;
}

// Main endpoint: Template + Data → PDF → Drive or Local
app.post("/upload-pdf", async (req, res) => {
  console.log("Full request body:", req.body);
  
  const { 
    name, region, community, age, status, img, interests, team, position, 
    webinars, trips, tasks, leadershipAcademy, communityActivities, 
    outsideActivities, feadback, giverPosition, giver, previousMonths,
    previousCourses, previousTrips, previousVolunteering, previousTasks,
    currentMonths, currentCourses, currentTrips, currentVolunteering,
    currentTasks, date, fileName, folderId, futurePlans, storyImg, storyTitle, storyText, storyLink 
  } = req.body;
  
  // Skip authentication check in test mode
  if (!TEST_MODE) {
    // Load tokens if needed
    if (!tokens && fs.existsSync("tokens.json")) {
      tokens = JSON.parse(fs.readFileSync("tokens.json", "utf8"));
      oauth2Client.setCredentials(tokens);
    }
    if (!tokens) return res.status(401).json({ error: "Not authenticated", authUrl: "/auth" });
  }
  
  try {
    // Read template.html file
    const templatePath = path.join(process.cwd(), 'template.html');
    if (!fs.existsSync(templatePath)) {
      return res.status(400).json({ error: "template.html file not found" });
    }
    
    const htmlTemplate = fs.readFileSync(templatePath, 'utf8');
    
    // Prepare data object for replacement
    const templateData = {
      name, region, community, age, status, img, interests, team, position,
      webinars, trips, tasks, leadershipAcademy, communityActivities,
      outsideActivities, feadback, giverPosition, giver, previousMonths,
      previousCourses, previousTrips, previousVolunteering, previousTasks,
      currentMonths, currentCourses, currentTrips, currentVolunteering,
      currentTasks, date: formatDate(date), futurePlans, storyImg, storyTitle, storyText, storyLink
    };
    
    // Replace template placeholders with actual data
    const processedHtml = replaceTemplate(htmlTemplate, templateData);
    
    const pdfFileName = fileName ? `${fileName}.pdf` : `document-${Date.now()}.pdf`;
    let browser;
    
    try {
      browser = await puppeteer.launch({ headless: "new" });
      const page = await browser.newPage();
      await page.setContent(processedHtml, { waitUntil: "networkidle0", timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Remove elements based on empty conditions
      await page.evaluate((data) => {
        // Remove academy element if leadershipAcademy and story is empty
        if (!data.leadershipAcademy || data.leadershipAcademy.trim() === '') {
          const academyElement = document.getElementById('academy');
          if (academyElement) {
            academyElement.remove();
          }
        }

        if (!data.storyText || data.storyText.trim() === '') {
          const storyElement = document.getElementById('story');
          if (storyElement) {
            storyElement.remove();
          }
        }
        
        // Remove team-related elements if team is empty
        if (!data.team || data.team.trim() === '') {
          const elementsToRemove = ['team', 'position', 'team-break-line', 'feadback'];
          elementsToRemove.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
              element.remove();
            }
          });
        }
        
        // Remove story-link element if storyLink is empty
        if (!data.storyLink || data.storyLink.trim() === '') {
          const storyLinkElement = document.getElementById('story-link');
          if (storyLinkElement) {
            storyLinkElement.remove();
          }
        }
        
        // Remove chart-container if any previous data is empty (but not if it's 0)
        const previousData = [
          data.previousMonths,
          data.previousCourses,
          data.previousTrips,
          data.previousVolunteering,
          data.previousTasks
        ];
        
        const hasEmptyPreviousData = previousData.some(value => 
          value === undefined || value === null || 
          (typeof value === 'string' && value.trim() === '')
        );
        
        if (hasEmptyPreviousData) {
          const chartContainer = document.getElementById('chart-container');
          if (chartContainer) {
            chartContainer.remove();
          }
        }
      }, templateData);
      
      await page.evaluate(() => {
        const canvases = document.querySelectorAll("canvas");
        canvases.forEach(canvas => {
          const img = document.createElement("img");
          img.src = canvas.toDataURL("image/png", 1.0); 
          img.style.width = canvas.style.width || canvas.width + "px";
          img.style.height = canvas.style.height || canvas.height + "px";
          canvas.replaceWith(img); 
        });
      });
      
      const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
      const heightInMM = Math.max(297, (bodyHeight * 0.264583)); 
      const pdfBuffer = await page.pdf({
        printBackground: true,
        margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
        width: "210mm",
        height: `${heightInMM}mm`,
      });
      
      if (TEST_MODE) {
        // Save locally in test mode
        const outputDir = path.join(process.cwd(), 'test-pdfs');
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const localPath = path.join(outputDir, pdfFileName);
        fs.writeFileSync(localPath, pdfBuffer);
        
        console.log(`✅ PDF saved locally: ${localPath}`);
        
        res.json({
          success: true,
          testMode: true,
          localPath: localPath,
          fileName: pdfFileName,
          message: "PDF saved locally in test-pdfs folder"
        });
      } else {
        // Upload to Drive in production mode
        const bufferStream = new PassThrough();
        bufferStream.end(pdfBuffer);
        const fileMetadata = { name: pdfFileName };
        if (folderId) fileMetadata.parents = [folderId];
        const file = await drive.files.create({
          requestBody: fileMetadata,
          media: { mimeType: "application/pdf", body: bufferStream },
          fields: "id, webViewLink",
        });
        
        res.json({
          success: true,
          testMode: false,
          fileId: file.data.id,
          viewLink: file.data.webViewLink,
        });
      }
    } catch (err) {
      console.error("PDF generation error:", err);
      res.status(500).json({ error: err.message });
    } finally {
      if (browser) await browser.close();
    }
  } catch (err) {
    console.error("Template processing error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 PDF API running on http://localhost:${PORT}`);
  if (TEST_MODE) {
    console.log(`⚠️  TEST MODE: PDFs will be saved locally in 'test-pdfs' folder`);
  } else {
    console.log(`📝 Visit http://localhost:${PORT}/auth to authenticate`);
  }
});