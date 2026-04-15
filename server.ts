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

// ═══════════════════════════════════════════════════════════════
//  المنخل الصارم (Strict Sieve) — ثوابت الفلترة
// ═══════════════════════════════════════════════════════════════

/** كلمات ممنوعة: أي نص يحتويها يُرفض فوراً */
const BLACKLIST_WORDS = [
  'test', 'null', 'undefined', 'unknown', 'temp', 'demo',
  'بحث', 'خيارات', 'سجل', 'أرشيف', 'تحميل', 'قراءة',
  'نسخة', 'كتاب', 'pdf', 'sample', 'example', 'placeholder',
  'lorem', 'ipsum', 'dummy', 'fake', 'mock', 'todo',
  'fixme', 'xxx', 'blank', 'empty', 'none', 'n/a',
];

/** أصغر طول مسموح لعنوان كتاب حقيقي */
const MIN_TITLE_LENGTH = 5;

/** أكبر عدد كتب مسموح من رابط واحد */
const MAX_BOOKS_PER_SCRAPE = 100;

/** أقصى طول محتوى نصي (لتجنب كسر Firestore) */
const MAX_CONTENT_LENGTH = 50000;

/**
 *  الفلتر الصارم: يرفض النصوص الزبالة
 *  - يتحقق من القائمة السوداء
 *  - يرفض النصوص القصيرة جداً
 *  - يرفض النصوص الفارغة أو التي تحتوي فقط أرقام/رموز
 */
function isCleanText(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < MIN_TITLE_LENGTH) return false;

  // رفض النصوص التي هي فقط أرقام أو رموز
  if (/^[\d\W\s]+$/.test(cleaned)) return false;

  // رفض أي نص يحتوي كلمة من القائمة السوداء
  return !BLACKLIST_WORDS.some(word => cleaned.includes(word));
}

/**
 *  المنخل الرئيسي: يقبل فقط الروابط التي:
 *  1. تنتهي بـ .pdf
 *  2. يحتوي نص الربط على اسم كتاب حقيقي (بعد التنظيف)
 */
function isValidBookPdfLink(href: string | undefined, linkText: string): boolean {
  if (!href || typeof href !== 'string') return false;
  if (!linkText || typeof linkText !== 'string') return false;

  // الفلتر الأساسي: الرابط يجب أن ينتهي بـ .pdf (حساس لحالة الأحرف أقل)
  const hrefLower = href.toLowerCase();
  if (!hrefLower.endsWith('.pdf')) return false;

  // تنظيف نص الرابط
  const cleanText = linkText.trim();
  if (!isCleanText(cleanText)) return false;

  return true;
}

/**
 *  تنظيف عنوان الكتب: يزيل الضجيج ويحتفظ بالاسم الحقيقي
 */
function sanitizeTitle(rawTitle: string): string {
  let title = rawTitle.trim();

  // إزالة الأرقام البادئة (مثل "1. " أو "12-")
  title = title.replace(/^\d+[\.\-\s\)]+/, '');

  // إزالة التواريخ بين قوسين
  title = title.replace(/\(\d{4}\)/g, '');
  title = title.replace(/\d{4}\s*هـ/g, '');

  // تقسيم على الفواصل والأقسام - نأخذ الجزء الأول فقط
  title = title.split('-')[0].split('|')[0].split('،')[0].split(':')[0].trim();

  // إزالة الأقواس الفارغة والمحتواة
  title = title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();

  // إزالة كلمات الضجيج من العنوان
  title = title.replace(/تحميل|قراءة|كتاب|نسخة|pdf|online|free|مجاني/gi, '').trim();

  // إزالة المسافات الزائدة
  title = title.replace(/\s+/g, ' ').trim();

  return title;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // ═══════════════════════════════════════════════════════════════
  //  API: جلب الكتب — المنخل الصارم
  // ═══════════════════════════════════════════════════════════════
  app.post("/api/scrape", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "الرابط مطلوب" });

    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      const $ = cheerio.load(response.data);

      // مسح عناصر الضجيج قبل البحث
      $("script, style, nav, footer, header, .ads, #sidebar, .menu, .nav, .comment, .share").remove();

      // ═══════════════════════════════════════════════════
      //  المنخل: نبحث فقط عن روابط .pdf حقيقية
      // ═══════════════════════════════════════════════════
      const bookLinks: { title: string; url: string }[] = [];
      const seenTitles = new Set<string>();

      $("a").each((_i, el) => {
        const href = $(el).attr("href");
        const rawText = $(el).text().trim();

        // الفلتر الصارم: فقط روابط PDF مع اسم كتاب حقيقي
        if (!isValidBookPdfLink(href, rawText)) return;

        // تنظيف العنوان
        const cleanTitle = sanitizeTitle(rawText);

        // إعادة التحقق بعد التنظيف
        if (!isCleanText(cleanTitle)) return;
        if (cleanTitle.length < MIN_TITLE_LENGTH) return;

        // منع التكرار
        if (seenTitles.has(cleanTitle)) return;
        seenTitles.add(cleanTitle);

        // بناء الرابط المطلق
        const absoluteUrl = new URL(href!, url).href;

        bookLinks.push({
          title: cleanTitle,
          url: absoluteUrl,
        });
      });

      // إذا وجدنا أكثر من كتاب واحد — نُرجع قائمة
      if (bookLinks.length > 0) {
        return res.json({
          type: 'list',
          items: bookLinks.slice(0, MAX_BOOKS_PER_SCRAPE)
        });
      }

      // إذا لم نجد روابط PDF — نحاول استخراج كتاب واحد من الصفحة
      let title = $("meta[property='og:title']").attr("content") ||
                  $("title").text().trim() ||
                  $("h1").first().text().trim() || "";

      // تنظيف العنوان
      title = title.split('|')[0].split('-')[0].trim();
      title = sanitizeTitle(title);

      // إذا العنوان غير صالح بعد التنظيف — نرفض
      if (!isCleanText(title) || title.length < MIN_TITLE_LENGTH) {
        return res.json({
          type: 'empty',
          message: 'لم يتم العثور على كتب PDF صالحة في هذا الرابط.'
        });
      }

      const author = $("meta[name='author']").attr("content") ||
                     $("meta[property='book:author']").attr("content") ||
                     $(".author").text().trim() || "مؤلف غير معروف";

      // تنظيف المحتوى
      const rawText = $("body").text().replace(/\s+/g, ' ').trim();

      res.json({
        type: 'book',
        title,
        author: isCleanText(author) ? author : "مؤلف غير معروف",
        sourceUrl: url,
        content: rawText.slice(0, MAX_CONTENT_LENGTH)
      });

    } catch (error) {
      console.error("Scraping error:", error);
      res.status(500).json({ error: "فشل في جلب البيانات من هذا الرابط" });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  API: جلب محتوى كتاب معين
  // ═══════════════════════════════════════════════════════════════
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
      // حد أقصى للمحتوى لمنع كسر Firestore
      res.json({ content: content.slice(0, MAX_CONTENT_LENGTH) });
    } catch (error) {
      res.status(500).json({ error: "فشل في جلب المحتوى" });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  //  API: رفع وتحليل ملف PDF
  // ═══════════════════════════════════════════════════════════════
  app.post("/api/upload-pdf", upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "لم يتم رفع ملف" });

    try {
      const data = await pdf(req.file.buffer);
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

  // Vite middleware
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
