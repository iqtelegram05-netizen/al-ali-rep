import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");

// Multer setup for PDF uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route: Scrape Book Info or List
  app.post("/api/scrape", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    try {
      const response = await axios.get(url, { 
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      const $ = cheerio.load(response.data);

      // The Extraction Algorithm: Strictly identify book titles (The Sieve)
      const bookLinks: any[] = [];
      const blacklist = ['test', 'temp', 'null', 'undefined', 'unknown', 'بحث', 'خيارات', 'سجل', 'أرشيف'];
      
      // Clean up the page first: remove noise
      $("script, style, nav, footer, header, .ads, #sidebar, .menu, .nav").remove();

      // Look for links that likely represent books
      $("a").each((i, el) => {
        const href = $(el).attr("href");
        let text = $(el).text().trim();
        
        if (!href || !text || text.length < 3) return;

        // Structural Check: Must be a book link or end in .pdf
        const isPdf = href.toLowerCase().endsWith('.pdf');
        const isBookLink = isPdf || 
                          href.includes("book") || 
                          href.includes("read") || 
                          href.match(/\/\d+/) || 
                          href.match(/id=\d+/) ||
                          $(el).find('img[src*="book"]').length > 0;
        
        if (isBookLink) {
          // Blacklist Check
          const isBlacklisted = blacklist.some(word => text.toLowerCase().includes(word.toLowerCase()));
          if (isBlacklisted) return;

          // Aggressive Cleaning: Remove numbers, dates, publishers, and noise
          text = text.replace(/^\d+[\.\-\s]*/, '');
          text = text.replace(/\(\d{4}\)/g, '').replace(/\d{4}\s*هـ/g, '');
          text = text.split('-')[0].split('|')[0].split('،')[0].split(':')[0].trim();
          text = text.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
          text = text.replace(/تحميل|قراءة|كتاب|نسخة|pdf/gi, '').trim();

          if (text.length > 3) {
            bookLinks.push({
              title: text,
              url: new URL(href, url).href
            });
          }
        }
      });

      if (bookLinks.length > 2) {
        // Filter out duplicates and very short titles
        const uniqueLinks = Array.from(new Set(bookLinks.map(l => l.title)))
          .map(title => bookLinks.find(l => l.title === title))
          .filter(l => l.title && l.title.length > 3);
          
        return res.json({ type: 'list', items: uniqueLinks.slice(0, 150) });
      }

      // If not a list, treat as a single book

      let title = $("meta[property='og:title']").attr("content") || 
                  $("title").text().trim() || 
                  $("h1").first().text().trim() || 
                  "عنوان غير معروف";
      
      // Clean title
      title = title.split('|')[0].split('-')[0].trim();
      
      const author = $("meta[name='author']").attr("content") || 
                     $("meta[property='book:author']").attr("content") ||
                     $(".author").text().trim() ||
                     "مؤلف غير معروف";
      
      // Extract raw text content cleanly
      $("script, style, nav, footer, header, .ads, #sidebar").remove();
      const rawText = $("body").text().replace(/\s+/g, ' ').trim();

      res.json({
        type: 'book',
        title,
        author,
        sourceUrl: url,
        content: rawText.slice(0, 50000) // Increased limit for full content
      });
    } catch (error) {
      console.error("Scraping error:", error);
      res.status(500).json({ error: "فشل في جلب البيانات من هذا الرابط" });
    }
  });

  // API Route: Fetch specific book content
  app.post("/api/fetch-content", async (req, res) => {
    const { url } = req.body;
    try {
      const response = await axios.get(url, { 
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      const $ = cheerio.load(response.data);
      $("script, style, nav, footer, header, .ads").remove();
      const content = $("body").text().replace(/\s+/g, ' ').trim();
      res.json({ content });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch content" });
    }
  });

  // API Route: Upload and Parse PDF
  app.post("/api/upload-pdf", upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    try {
      const data = await pdf(req.file.buffer);
      // Limit to ~15 pages worth of text (approx 30,000 chars)
      const text = data.text.slice(0, 30000);
      
      res.json({
        text,
        pageCount: data.numpages
      });
    } catch (error) {
      console.error("PDF parsing error:", error);
      res.status(500).json({ error: "فشل في تحليل ملف PDF" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
