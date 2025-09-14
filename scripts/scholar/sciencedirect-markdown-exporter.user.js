// ==UserScript==
// @name         ScienceDirect Paper to Markdown Exporter (Enhanced)
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  Export ScienceDirect papers to Markdown with complete metadata, TextBundle and Base64 formats
// @author       Qi Deng <dengqi935@gmail.com>
// @match        https://www.sciencedirect.com/science/article/pii/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/turndown/7.1.2/turndown.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @connect      sciencedirect.com
// @connect      ars.els-cdn.com
// @run-at       document-idle
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/sciencedirect-markdown-exporter.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/sciencedirect-markdown-exporter.user.js
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  "use strict";

  // -----------------------------
  // 0) Config & Feature Flags
  // -----------------------------
  const Config = {
    APP_NAME: "ScienceDirect → Markdown",
    VERSION: "0.1.0-skeleton",
    BASE_ORIGIN: "https://www.sciencedirect.com",
    UI: {
      zIndex: 999999,
      position: "right",
    },
    // —— 引文与脚注策略（已按你的决策设定）——
    CITATION: {
      style: "footnote+references", // 'footnote+references' | 'bracket+references'
      namespaces: { reference: "R", footnote: "F" }, // 参考文献脚注前缀R；正文脚注前缀F
    },
    // —— 图片与 SVG 策略（已按你的决策设定）——
    IMAGES: {
      preferRaster: true, // 优先<img>位图
      inlineSvgInMarkdown: true, // 无位图时内联<svg>到 Markdown（Links/Base64形态）
      embedSvgInTextBundle: true, // TextBundle 中落地 .svg 文件资源
      maxBytes: 2.5 * 1024 * 1024, // Base64单图最大体积（占位）
      maxDim: 4096, // 统一最长边限制（占位）
      concurrency: 4, // 下载并发（占位）
    },
    FIGURES: { captionStyle: "plain" }, // 或 'italic'
    // —— 数学编号策略（已按你的决策设定）——
    MATH: {
      displayTag: "inline", // 将编号内嵌到 $$ ... \tag{n} $$ 中
      normalizeDelimiters: true, // 规范 $...$ 与 $$...$$
      decodeEntitiesInsideMath: true,
    },
    // —— 表格处理策略 ——
    TABLES: {
      mode: "html", // 'html' | 'markdown' | 'auto'
      cleanOutput: true, // 清理无用的CSS类和样式
      preserveStructure: true, // 保持表格的完整结构
    },
    // —— 打包策略（先占位，后续你可接 JSZip/fflate 等）——
    PACK: {
      provider: "native", // 'native' | 'jszip' | 'fflate'（骨架阶段仅占位）
    },
  };

  // -----------------------------
  // 1) Logger (轻量)
  // -----------------------------
  const Log = {
    entries: [],
    info: (...a) => {
      console.log(`[${Config.APP_NAME}]`, ...a);
      Log._addEntry("info", ...a);
    },
    warn: (...a) => {
      console.warn(`[${Config.APP_NAME}]`, ...a);
      Log._addEntry("warn", ...a);
    },
    error: (...a) => {
      console.error(`[${Config.APP_NAME}]`, ...a);
      Log._addEntry("error", ...a);
    },
    _addEntry: (level, ...args) => {
      const timestamp = new Date().toISOString();
      const message = args
        .map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
        )
        .join(" ");
      Log.entries.push({ timestamp, level, message });
      Log._updateUI();
    },
    _updateUI: () => {
      const logPanel = document.querySelector('[data-role="debug-log"]');
      if (logPanel && !logPanel.classList.contains("sciencedirect-md-hide")) {
        const content = logPanel.querySelector(".sciencedirect-md-log__content");
        if (content) {
          content.textContent = Log.entries
            .map(
              (entry) =>
                `[${entry.timestamp.substring(
                  11,
                  19
                )}] ${entry.level.toUpperCase()}: ${entry.message}`
            )
            .join("\n");
          content.scrollTop = content.scrollHeight;
        }
      }
    },
    clear: () => {
      Log.entries = [];
      Log._updateUI();
    },
    copy: () => {
      const logText = Log.entries
        .map(
          (entry) =>
            `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${
              entry.message
            }`
        )
        .join("\n");
      navigator.clipboard
        .writeText(logText)
        .then(() => {
          console.log("Debug log copied to clipboard");
        })
        .catch((err) => {
          console.error("Failed to copy log:", err);
        });
    },
  };

  // -----------------------------
  // 2) Utils
  // -----------------------------
  const U = {
    /** @param {string} sel @param {ParentNode=} root */
    $(sel, root) {
      return (root || document).querySelector(sel);
    },
    /** @param {string} sel @param {ParentNode=} root */
    $all(sel, root) {
      return Array.from((root || document).querySelectorAll(sel));
    },
    text(node) {
      return (node?.textContent || "").trim();
    },
    attr(node, name) {
      return node?.getAttribute?.(name) || null;
    },
    /** 合并软换行：将同段内的换行压成空格 */
    mergeSoftWraps(s) {
      return (s || "")
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    },
    /** 绝对化 URL（结合 <base> 与站点 origin） */
    absolutize(url, baseHref = null) {
      try {
        if (!url) return url;
        if (/^(?:data|blob|https?):/i.test(url)) return url;
        const origin =
          typeof location !== "undefined" && location.origin
            ? location.origin
            : "https://www.sciencedirect.com";
        if (url.startsWith("/")) return origin + url;
        const rawBase =
          baseHref ||
          U.$("base")?.getAttribute?.("href") ||
          (typeof location !== "undefined" ? location.href : origin + "/");
        const baseAbs = /^https?:\/\//i.test(rawBase)
          ? rawBase
          : rawBase.startsWith("/")
          ? origin + rawBase
          : typeof location !== "undefined"
          ? location.href
          : origin + "/";
        return new URL(url, baseAbs).toString();
      } catch {
        return url;
      }
    },
    /** 从路径或<base>解析 ScienceDirect PII */
    parseScienceDirectIdVersion() {
      const base = U.$("base")?.href || location.pathname;
      // 期望形如 /html/2509.03654v1/ 或 /html/2509.03654v1
      const m =
        String(base).match(/\/html\/(\d{4}\.\d{5})(v\d+)\//) ||
        String(base).match(/\/html\/(\d{4}\.\d{5})(v\d+)/);
      if (m) return { id: m[1], version: m[2] };
      return { id: null, version: null };
    },
    /** 简单节流（占位） */
    delay(ms) {
      return new Promise((r) => setTimeout(r, ms));
    },
    /** 粗略的 slug 化标题为锚点用（占位） */
    slug(s) {
      return (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\- ]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 80);
    },
  };

  // -----------------------------
  // 3) ScienceDirectAdapter（解析层骨架）
  // -----------------------------
  /**
   * ScienceDirectAdapter — 解析 ScienceDirect 文章页面 (/science/article/pii/{PII}) 的适配器
   * 使用方式：
   *   const adapter = new ScienceDirectAdapter(document);
   *   const meta = adapter.getMeta();
   *   const bib = adapter.collectBibliography();
   *   const citeMap = adapter.buildCitationMap(bib);
   *   const sections = adapter.walkSections();
   *   // 之后可配合你自己的 Emitter/Exporter 逐步填充
   */
  class ScienceDirectAdapter {
    /**
     * @param {Document} doc
     */
    constructor(doc) {
      this.doc = doc;
      this.baseHref = this._baseHref();
      this.origin = this._origin() || "https://www.sciencedirect.com";
      const { id, version } = this._parseScienceDirectIdVersion();
      this.sciencedirectId = id;
      this.version = version;
      this.links = {
        article: id ? `${this.origin}/science/article/pii/${id}` : 
                (typeof location !== "undefined" ? location.href : null),
        pdf: id ? `${this.origin}/science/article/pii/${id}/pdfft` : null,
        doi: null // Will be extracted from the page content
      };
    }

    // ============ 对外主接口 ============

    /**
     * 提取论文元信息：标题、作者数组、摘要、ScienceDirect PII与常用链接
     * @returns {{title:string, authors:Array<{name:string, aff?:string, mail?:string}>, abstract:string, sciencedirectId?:string, version?:string, links?:Record<string,string|null>}}
     */
    getMeta() {
      const title =
        this._text(this._$(".title-text")) ||
        (typeof document !== "undefined" ? document.title : "") ||
        "Untitled";

      const authors = this._parseAuthors();
      const abstract = this._parseAbstract();
      const highlights = this._parseHighlights();
      const keywords = this._parseKeywords();
      
      // Extract DOI from page
      const doiLink = this._$("a.doi[href*='doi.org']");
      const doi = doiLink ? doiLink.getAttribute("href") : null;
      
      // Update links with DOI if found
      if (doi) {
        this.links.doi = doi;
      }
      
      // Extract journal and publication info
      const journalInfo = this._extractJournalInfo();

      return {
        title,
        authors,
        abstract,
        sciencedirectId: this.sciencedirectId,
        version: this.version,
        links: this.links,
        journal: journalInfo.journal,
        volume: journalInfo.volume,
        pages: journalInfo.pages,
        year: journalInfo.year,
        doi: doi,
        highlights,
        keywords
      };
    }

    /**
     * 收集参考文献条目（文末 bib），并提取编号、完整文本、可用链接（若有）
     * @returns {Array<{num:number, id:string, text:string, doi?:string, url?:string}>}
     */
    collectBibliography() {
      const items = [];
      
      // ScienceDirect references: section.bibliography ol.references > li
      const bibSection = this._$("section.bibliography") || this._$("#references");
      if (!bibSection) return items;
      
      const bibLis = this._all("ol.references > li, .references li", bibSection);
      
      for (const li of bibLis) {
        const id = li.getAttribute("id") || "";
        
        // Extract reference number from id like "ref-id-bib1" or from label
        let num = items.length + 1;
        const labelEl = this._$("span.label, .reference-number", li);
        const labelText = labelEl ? this._text(labelEl) : "";
        
        if (labelText) {
          const numMatch = labelText.match(/\d+/);
          if (numMatch) num = parseInt(numMatch[0], 10);
        }
        
        if (!num && id) {
          const idMatch = id.match(/(\d+)$/);
          if (idMatch) num = parseInt(idMatch[1], 10);
        }

        // Extract reference text content
        let text = "";
        const titleEl = this._$("div.title, .reference-title", li);
        const authorsEl = this._$(".authors, .reference-authors", li);
        const hostEl = this._$(".host, .reference-journal", li);
        
        if (titleEl || authorsEl || hostEl) {
          // Build structured text
          const parts = [];
          if (authorsEl) parts.push(this._text(authorsEl));
          if (titleEl) parts.push(this._text(titleEl));
          if (hostEl) parts.push(this._text(hostEl));
          text = parts.filter(Boolean).join(". ");
        } else {
          // Fallback: use all text content excluding label
          const clone = li.cloneNode(true);
          const labelToRemove = this._$("span.label, .reference-number", clone);
          if (labelToRemove) labelToRemove.remove();
          text = this._text(clone);
        }
        
        text = this._mergeSoftWraps(text).trim();

        // Extract links (DOI, URLs)
        let doi, url;
        for (const a of this._all("a[href]", li)) {
          const href = a.getAttribute("href") || "";
          if (/^mailto:/i.test(href) || href.startsWith("#")) continue;
          if (/^https?:\/\//i.test(href)) {
            if (!url) url = href;
            if (href.includes("doi.org") || href.includes("dx.doi.org")) {
              doi = href;
              break;
            }
          }
        }
        
        if (text) {
          items.push({ num, id, text, doi, url });
        }
      }
      
      // Deduplicate and sort by number
      const uniq = new Map();
      for (const it of items) {
        if (!uniq.has(it.num)) uniq.set(it.num, it);
      }
      return Array.from(uniq.values()).sort((a, b) => a.num - b.num);
    }

    /**
     * 构建“文中引文锚 → 编号”的映射，用于将 [n] 或 [^Rn] 正确替换
     * 兼容相对/绝对锚：'#bib17'、'bib17'、'https://www.sciencedirect.com/science/article/pii/...#bib17'
     * @param {Array<{num:number, id:string}>} bibItems
     * @returns {Map<string, number>}
     */
    buildCitationMap(bibItems) {
      const map = new Map();
      // 把 li 的 id（如 'ref-id-bib17'）映射到编号
      for (const it of bibItems || []) {
        if (!it?.id || typeof it.num !== "number") continue;
        const id = it.id; // 例如 'ref-id-bib17'
        const hash = `#${id}`;
        map.set(id, it.num);
        map.set(hash, it.num);
        // 兼容绝对/相对 URL 形式
        if (this.links.html) {
          map.set(`${this.links.html}${hash}`, it.num);
        }
      }

      // 再扫描正文中出现的 cite/ref，补充未知形式（不同模板：#bibNN, #b0005, data-xocs-content-type="reference"）
      const anchors = this._all('a[href*="#bib"], a[href^="#b"], a[data-xocs-content-type="reference"]');
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const key = this._normalizeBibHref(href);
        const n = this._parseBibNumber(href);
        if (!map.has(key) && n != null) map.set(key, n);
      }
      return map;
    }

    /**
     * 遍历分节（section.ltx_section），返回含层级/标题/锚与“就地内容节点列表”的数组
     * 节内节点保持 DOM 顺序，仅收集：段落、块级公式、图、表、列表、代码、脚注
     * @returns {Array<{level:number, title:string, anchor:string, nodes:Element[]}>}
     */
    walkSections() {
      const docTitle = this._mergeSoftWraps(
        this._text(this._$(".title-text"))
      );

      // ScienceDirect sections: old OA uses id^=sec, non-OA often id^=s (e.g., s0005)
      const SEC_SEL = 'section[id^="sec"], section[id^="s"]';
      const sections = this._all(SEC_SEL);
      const seen = new Set();
      const out = [];

      for (const sec of sections) {
        // ScienceDirect titles: h2.u-h4 or similar
        const h = this._$(":is(h2,h3,h4,h5,h6)", sec);
        const title = this._mergeSoftWraps(this._text(h) || "Section");

        // 跳过与文档主标题同文的分节
        if (title && docTitle && this._eqLoose(title, docTitle)) continue;

        // 分节去重 key
        const id = sec.getAttribute("id") || "";
        const key = `${id}|${title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // 仅采集“直属当前 sec”的节点；排除落在任何子 section 里的节点
        const NODE_SEL = [
          "div[id^='p']", // ScienceDirect paragraphs
          "figure[id^='f']", // Figures (non-OA: f0005)
          "figure[id^='fig']", // Figures (OA: fig1)
          "figure.figure", // Generic figure block
          "div.tables[id^='tbl']", // Tables  
          'math[display="block"]', // Math equations
          "ul", // Unordered lists
          "ol", // Ordered lists
          "pre", // Code blocks
        ].join(",");

        const nodes = this._all(NODE_SEL, sec).filter((n) => {
          const nearest = n.closest(SEC_SEL);
          if (nearest !== sec) return false; // 只要直属本节
          if (n.matches?.("div[id^='p']") && n.closest("li"))
            return false; // 列表内段落交给列表
          return true;
        });

        // 用实际 hN 作为 Markdown 层级；无标题则以深度兜底
        let level = 2 + this._sectionDepth(sec);
        if (h && /^h[2-6]$/i.test(h.tagName)) {
          level = Math.max(2, Math.min(6, parseInt(h.tagName.slice(1), 10)));
        }

        const anchor = id || this._slug(title);
        out.push({ level, title, anchor, nodes });
      }
      return out;
    }

    // ============ 内容元素级提取（给上层按需调用） ============

    /**
     * 提取段落文本（合并软换行）
     * @param {Element} p 预期为 p.ltx_p
     * @returns {string}
     */
    extractParagraph(p) {
      return this._mergeSoftWraps(this._text(p));
    }

    /**
     * 识别块级/行内数学并抽 TeX；块级尽量补上编号（\tag{n}）
     * 可接受：math 元素本体，或 table.ltx_equation 容器
     * @param {Element} node
     * @returns {{type:'inline'|'display', tex:string, tag?:string}|null}
     */
    extractMath(node) {
      if (!node) return null;

      // 情况 A：table.ltx_equation（常见块级结构，编号在左侧单元格）
      if (node.matches && node.matches("table.ltx_equation")) {
        const m = this._$('math[display="block"]', node);
        const tex = this._extractTeX(m);
        if (!tex) return null;
        const tagText = this._text(
          this._$(".ltx_tag_equation, .ltx_tag.ltx_tag_equation", node)
        );
        const tag = this._stripParen(tagText); // '(3)' -> '3'
        return { type: "display", tex, tag };
      }

      // 情况 B：直接是 math 元素
      const isMath = node.tagName && node.tagName.toLowerCase() === "math";
      const mathEl = isMath ? node : this._$("math", node);
      if (!mathEl) return null;
      const display =
        (mathEl.getAttribute("display") || "").toLowerCase() === "block";
      const tex = this._extractTeX(mathEl);
      if (!tex) return null;

      let tag;
      if (display) {
        const tbl = mathEl.closest("table.ltx_equation");
        if (tbl) {
          const tagText = this._text(
            this._$(".ltx_tag_equation, .ltx_tag.ltx_tag_equation", tbl)
          );
          tag = this._stripParen(tagText);
        }
      }
      return { type: display ? "display" : "inline", tex, tag };
    }

    /**
     * 提取 figure：优先 <img>；没有则 <svg>
     * @param {Element} fig 预期 figure.figure
     * @returns {{kind:'img'|'svg', src?:string, inlineSvg?:string, caption?:string, id?:string}|null}
     */
    extractFigure(fig) {
      if (!fig) return null;
      const id = fig.getAttribute("id") || null;

      // Extract figure number and caption from ScienceDirect structure
      let caption = "";
      let figureNumber = "";
      
      // Look for figure title/caption in various possible locations
      const capEl = this._$("span.captions, figcaption, .caption", fig);
      if (capEl) {
        const clone = capEl.cloneNode(true);
        
        // Remove download links and their text before processing
        const downloadLinks = Array.from(clone.querySelectorAll('a[href*="image"], a.download-link, .download-link'));
        downloadLinks.forEach(link => link.remove());
        
        const hasMathJax = clone.querySelector('span.MathJax_SVG, span.MJX_Assistive_MathML');
        if (hasMathJax) {
          // Prefer converting MathJax-rendered nodes and drop raw <math> to avoid duplicates
          for (const svg of Array.from(clone.querySelectorAll('span.MathJax_SVG'))) {
            let tex = "";
            const mml = svg.getAttribute('data-mathml');
            if (mml) {
              try {
                const doc = new DOMParser().parseFromString(mml, 'application/xml');
                const mathEl = doc.querySelector('math');
                if (mathEl) tex = this._extractTeX(mathEl) || "";
              } catch {}
            }
            if (!tex) {
              const assist = svg.parentElement?.querySelector('span.MJX_Assistive_MathML math');
              if (assist) tex = this._extractTeX(assist) || "";
            }
            if (tex) {
              const isDisplay = !!(svg.closest('.display') || svg.closest('span.display'));
              svg.replaceWith(document.createTextNode(isDisplay ? `$$${tex}$$` : `$${tex}$`));
            }
          }
          // Remove any raw <math> to avoid duplicated math content
          for (const m of Array.from(clone.querySelectorAll('math'))) m.remove();
        } else {
          // Convert raw <math> elements to TeX
          for (const m of Array.from(clone.querySelectorAll("math"))) {
            const tex = this._extractTeX(m);
            m.replaceWith(document.createTextNode(tex ? `$${tex}$` : ""));
          }
        }
        // Remove MathJax scaffolding nodes
        for (const junk of Array.from(
          clone.querySelectorAll('script[type="math/mml"], span.MathJax_SVG, span.MJX_Assistive_MathML, span.MathJax_Preview')
        )) junk.remove();
        const fullText = this._mergeSoftWraps(clone.textContent || "");
        
        // Extract figure number and caption
        const figMatch = fullText.match(/^(Fig\.?\s*\d+\.?)\s*(.*)$/i);
        if (figMatch) {
          figureNumber = figMatch[1].trim();
          caption = figMatch[2].trim();
        } else {
          caption = fullText.replace(/^\s*Fig\.?\s*\d+\s*[:.]\s*/i, "").trim();
        }
      }

      // Look for download links to extract actual image URLs
      const downloadLinks = this._all("a[href*='image'], a[href*='gr'], .download-link", fig);
      let imageUrl = null;
      
      for (const link of downloadLinks) {
        const href = link.getAttribute("href");
        if (href) {
          // Prefer full-size image, then high-res
          if (href.includes("full-size") || href.includes("gr") && href.includes(".jpg")) {
            imageUrl = this._abs(href);
            break;
          } else if (href.includes("high-res") || href.includes("image")) {
            imageUrl = this._abs(href);
            // Continue looking for full-size, but keep this as fallback
          }
        }
      }

      // Fallback to regular img element
      if (!imageUrl) {
        const img = this._$("img", fig);
        if (img) {
          const raw = img.getAttribute("src") || img.getAttribute("data-src") || null;
          if (raw) {
            imageUrl = this._abs(raw);
          }
        }
      }

      if (imageUrl) {
        // Construct proper image URL for ScienceDirect
        let finalImageUrl = imageUrl;
        
        // If it looks like a ScienceDirect image path, construct full URL
        if (imageUrl.includes("gr") && !imageUrl.startsWith("http")) {
          // Extract PII from current URL to construct image URL
          const currentUrl = typeof location !== "undefined" ? location.href : "";
          const piiMatch = currentUrl.match(/pii\/([A-Z0-9]+)/i);
          if (piiMatch) {
            const pii = piiMatch[1];
            const figNum = (figureNumber.match(/\d+/) || ["1"])[0];
            finalImageUrl = `https://ars.els-cdn.com/content/image/1-s2.0-${pii}-gr${figNum}.jpg`;
          }
        }

        return { 
          kind: "img", 
          src: finalImageUrl, 
          caption, 
          figureNumber,
          id 
        };
      }

      // Check for SVG
      const svg = this._$("svg", fig);
      if (svg) {
        const inlineSvg = svg.outerHTML;
        return { kind: "svg", inlineSvg, caption, figureNumber, id };
      }
      
      return null;
    }

    /**
     * 提取表格；当列数过大或结构复杂时，降级为 html 字符串
     * @param {Element} tblContainer 预期 div.tables 容器或直接的 table 元素
     * @returns {{headers?:string[][], rows?:string[][], html?:string}}
     */
    extractTable(tblContainer) {
      if (!tblContainer) return { html: "" };

      // 找到实际的表格元素
      let tbl = tblContainer;
      if (tblContainer.matches && tblContainer.matches("div.tables")) {
        tbl = this._$("table", tblContainer);
        if (!tbl) return { html: "" };
      }

      // 根据配置决定输出格式
      if (Config.TABLES.mode === "html" || Config.TABLES.mode === "auto") {
        // 对于ScienceDirect，输出整个容器以包含表格标题
        const targetElement = tblContainer.matches && tblContainer.matches("div.tables") 
          ? tblContainer 
          : tbl;
        const html = Config.TABLES.cleanOutput
          ? this._cleanTableHtml(targetElement)
          : targetElement.outerHTML;
        return { html };
      }

      // 仅在用户明确要求时才生成Markdown表格
      if (Config.TABLES.mode === "markdown") {
        const rows = Array.from(tbl.querySelectorAll("tr"));
        const colCount = rows.reduce(
          (m, r) => Math.max(m, r.children.length),
          0
        );

        // 如果表格太复杂，仍然降级为HTML
        if (colCount > 12) {
          return { html: tbl.outerHTML };
        }

        // 原有的Markdown生成逻辑
        const headers = [];
        const body = [];

        const thead = tbl.querySelector("thead");
        if (thead) {
          for (const tr of thead.querySelectorAll("tr")) {
            headers.push(this._cellsToText(tr.querySelectorAll("th, td")));
          }
        } else {
          const first = rows[0];
          if (first && first.querySelector("th")) {
            headers.push(this._cellsToText(first.querySelectorAll("th, td")));
          }
        }

        const bodyRows = thead
          ? tbl.querySelectorAll("tbody tr")
          : headers.length
          ? rows.slice(1)
          : rows;
        for (const tr of bodyRows) {
          body.push(this._cellsToText(tr.querySelectorAll("td, th")));
        }

        return { headers, rows: body };
      }

      // 默认返回HTML
      return { html: tbl.outerHTML };
    }

    /**
     * 清理表格HTML，移除LaTeX特定的类名和样式
     * @param {Element} table
     * @returns {string}
     */
    _cleanTableHtml(table) {
      const clone = table.cloneNode(true);

      // 转换表格/标题中的数学：优先 MathJax，否则 <math> → $...$
      const hasMj = clone.querySelector('span.MathJax_SVG, span.MJX_Assistive_MathML');
      if (hasMj) {
        for (const svg of Array.from(clone.querySelectorAll('span.MathJax_SVG'))) {
          let tex = "";
          const mml = svg.getAttribute('data-mathml');
          if (mml) {
            try {
              const doc = new DOMParser().parseFromString(mml, 'application/xml');
              const mathEl = doc.querySelector('math');
              if (mathEl) tex = this._extractTeX(mathEl) || "";
            } catch {}
          }
          if (!tex) {
            const assist = svg.parentElement?.querySelector('span.MJX_Assistive_MathML math');
            if (assist) tex = this._extractTeX(assist) || "";
          }
          if (tex) {
            const isDisplay = !!(svg.closest('.display') || svg.closest('span.display'));
            svg.replaceWith(document.createTextNode(isDisplay ? `$$${tex}$$` : `$${tex}$`));
          }
        }
        for (const m of Array.from(clone.querySelectorAll('math'))) m.remove();
      } else {
        for (const m of Array.from(clone.querySelectorAll('math'))) {
          const tex = this._extractTeX(m);
          m.replaceWith(document.createTextNode(tex ? `$${tex}$` : ""));
        }
      }
      for (const junk of Array.from(
        clone.querySelectorAll('script[type="math/mml"], span.MathJax_SVG, span.MJX_Assistive_MathML, span.MathJax_Preview')
      )) junk.remove();

      // 移除LaTeX特定的类名，保留基本结构类
      const elements = clone.querySelectorAll("*");
      elements.forEach((el) => {
        if (el.className) {
          const keepClasses = el.className
            .split(" ")
            .filter((cls) =>
              /^(table|thead|tbody|tfoot|tr|th|td|text-center|text-left|text-right)$/.test(
                cls
              )
            );
          el.className = keepClasses.join(" ");
        }

        // 移除内联样式，保留重要的对齐属性
        if (el.style) {
          const textAlign = el.style.textAlign;
          const verticalAlign = el.style.verticalAlign;

          el.removeAttribute("style");

          if (textAlign) el.style.textAlign = textAlign;
          if (verticalAlign) el.style.verticalAlign = verticalAlign;
        }
      });

      return clone.outerHTML;
    }

    /**
     * 提取脚注（若有）—— ScienceDirect 的脚注结构，这里做通用兜底
     * @param {Element} node e.g., div.ltx_note.ltx_role_footnote
     * @returns {{key:string, content:string}|null}
     */
    extractFootnote(node) {
      if (!node) return null;
      const id = node.getAttribute("id") || "";
      const n = this._parseFootnoteNumber(id);
      const key = n != null ? `F${n}` : id ? `F_${id}` : null;
      const content = this._mergeSoftWraps(this._text(node));
      if (!key || !content) return null;
      return { key, content };
    }

    // ============ 私有：作者/摘要/工具 ============

    // 宽松字符串比较（忽略空白/标点/大小写）
    _eqLoose(a, b) {
      const norm = (s) =>
        String(s || "")
          .toLowerCase()
          .replace(/[\s\p{P}\p{S}]+/gu, "");
      return norm(a) === norm(b);
    }

    /**
     * 解析作者块：尽可能逐人拆分；若结构仅给出一串姓名，也返回单条记录
     * @returns {Array<{name:string, aff?:string, mail?:string}>}
     */
    _parseAuthors() {
      const authors = [];
      const box = this._$(".AuthorGroups, .author-group, #author-group");
      if (!box) return authors;

      // Build affiliation map: code (a,b,1,2) -> text
      const affMap = new Map();
      let affDls = this._all('dl.affiliation', box);
      if (!affDls.length) affDls = this._all('dl.affiliation'); // fallback to document
      const normCode = (s) => {
        const m = String(s || '').toLowerCase().match(/([a-z0-9]+)/);
        return m ? m[1] : String(s || '').trim().toLowerCase();
      };
      for (const dl of affDls) {
        const codeRaw = this._text(this._$('dt sup', dl) || this._$('dt', dl)).trim();
        const code = normCode(codeRaw);
        const text = this._mergeSoftWraps(this._text(this._$('dd', dl)) || "");
        if (code && text) {
          affMap.set(code, text);
          // also map uppercase variant for safety
          affMap.set(code.toUpperCase(), text);
        }
      }

      // Collect author nodes: anchors and buttons
      const nodes = [
        ...this._all("a[href*='/author/']", box),
        ...this._all("button[data-xocs-content-type='author']", box),
      ];

      for (const node of nodes) {
        const givenName = this._text(this._$(".given-name", node)) || "";
        const surname = this._text(this._$(".surname", node)) || "";
        const name = `${givenName} ${surname}`.trim();
        if (!name) continue;

        // affiliation codes may appear multiple times
        const codes = Array.from(node.querySelectorAll('.author-ref sup'))
          .map((s) => normCode(this._mergeSoftWraps(s.textContent || "").trim()))
          .filter(Boolean);
        const uniqCodes = Array.from(new Set(codes));
        const affTexts = uniqCodes.map((c) => affMap.get(c) || affMap.get(c.toUpperCase())).filter(Boolean);
        const aff = affTexts.length ? affTexts.join('; ') : (uniqCodes.length ? `(${uniqCodes.join(',')})` : undefined);

        authors.push({ name, aff, mail: undefined });
      }

      // Fallback: if no nodes found, try to split box text (best-effort)
      if (nodes.length === 0) {
        const authorText = this._text(box);
        if (authorText) {
          const names = authorText
            .replace(/Author links open overlay panel/gi, '')
            .split(/,|\band\b/)
            .map((n) => n.trim())
            .filter(Boolean);
          for (const n of names) authors.push({ name: n });
        }
      }

      return authors;
    }

    /**
     * 摘要：div.ltx_abstract 内所有 p.ltx_p 合并
     * @returns {string}
     */
    _parseAbstract() {
      // Prefer non-OA structure
      const abstractsBox = this._$(".Abstracts, #abstracts");
      if (abstractsBox) {
        // Prefer the true author abstract, avoid author-highlights
        const authorAbs = this._$(".abstract.author", abstractsBox) || this._$(".abstract:not(.author-highlights)", abstractsBox);
        const toText = (node) => {
          if (!node) return "";
          const clone = node.cloneNode(true);
          // convert inline math
          for (const m of Array.from(clone.querySelectorAll('math'))) {
            const tex = this._extractTeX(m);
            m.replaceWith(document.createTextNode(tex ? `$${tex}$` : ""));
          }
          for (const svg of Array.from(clone.querySelectorAll('span.MathJax_SVG'))) {
            let tex = "";
            const mml = svg.getAttribute('data-mathml');
            if (mml) {
              try {
                const doc = new DOMParser().parseFromString(mml, 'application/xml');
                const mathEl = doc.querySelector('math');
                if (mathEl) tex = this._extractTeX(mathEl) || "";
              } catch {}
            }
            if (!tex) {
              const assist = svg.parentElement?.querySelector('span.MJX_Assistive_MathML math');
              if (assist) tex = this._extractTeX(assist) || "";
            }
            if (tex) svg.replaceWith(document.createTextNode(`$${tex}$`));
          }
          for (const junk of Array.from(
            clone.querySelectorAll('script[type="math/mml"], span.MathJax_SVG, span.MJX_Assistive_MathML, span.MathJax_Preview')
          )) junk.remove();
          // anchors to text
          for (const a of Array.from(clone.querySelectorAll('a'))) {
            a.replaceWith(document.createTextNode(a.textContent || ""));
          }
          return this._mergeSoftWraps(clone.textContent || "");
        };
        if (authorAbs) {
          // Target non-OA structure: container #asXXXX > div[id^=sp]
          const as = this._$("[id^='as']", authorAbs) || authorAbs;
          const paras = this._all("div[id^='sp'], p", as);
          if (paras.length) {
            const lines = paras.map((p) => this._mergeSoftWraps(toText(p)).replace(/^[•\-\*]\s*/, '')).filter(Boolean);
            const body = lines.join(' ');
            return body.replace(/^\s*Abstract\.?\s*/i, '').trim();
          }
          const body = this._mergeSoftWraps(toText(authorAbs));
          return body.replace(/^\s*Abstract\.?\s*/i, '').trim();
        }
      }
      // Fallback old structure (#abs0010)
      const box = this._$("#abs0010");
      if (box) {
        const abstractPara = this._$("#abspara0010", box) || box;
        let abs = this._mergeSoftWraps(this._text(abstractPara) || this._text(box));
        abs = abs.replace(/^\s*Abstract\.?\s*/i, "").trim();
        return abs;
      }
      return "";
    }

    _parseHighlights() {
      const out = [];
      const abstractsBox = this._$(".Abstracts, #abstracts");
      if (!abstractsBox) return out;
      const hl = this._$(".abstract.author-highlights, .author-highlights", abstractsBox);
      if (!hl) return out;
      const items = this._all('li', hl);
      for (const it of items) {
        const clone = it.cloneNode(true);
        for (const a of Array.from(clone.querySelectorAll('a'))) a.replaceWith(document.createTextNode(a.textContent || ""));
        for (const m of Array.from(clone.querySelectorAll('math'))) {
          const tex = this._extractTeX(m);
          m.replaceWith(document.createTextNode(tex ? `$${tex}$` : ""));
        }
        for (const junk of Array.from(
          clone.querySelectorAll('script[type="math/mml"], span.MathJax_SVG, span.MJX_Assistive_MathML, span.MathJax_Preview')
        )) junk.remove();
        const t = this._mergeSoftWraps(this._text(clone)).replace(/^[•\-\*]\s*/, '').trim();
        if (t) out.push(t);
      }
      // Deduplicate consecutive duplicates
      return Array.from(new Set(out));
    }

    _parseKeywords() {
      const out = [];
      const kwBox = this._$(".Keywords, .keywords-section");
      if (!kwBox) return out;
      // Common structures: div.keyword > span, or list of anchors/spans
      const spans = this._all('.keyword span, .keyword, span.keyword, a.keyword', kwBox);
      for (const s of spans) {
        const t = this._mergeSoftWraps(this._text(s)).trim();
        if (t) out.push(t);
      }
      // de-duplicate
      return Array.from(new Set(out));
    }

    /**
     * Extract journal and publication information from ScienceDirect page
     * @returns {{journal: string, volume: string, pages: string, year: string}}
     */
    _extractJournalInfo() {
      // Extract journal name from publication title
      const journalElement = this._$(".publication-title-link");
      const journal = journalElement ? this._text(journalElement) : "";
      
      // Extract volume, pages, year from .text-xs section  
      const metaElement = this._$(".text-xs");
      let volume = "", pages = "", year = "";
      
      if (metaElement) {
        const metaText = this._text(metaElement);
        
        // Extract volume: "Volume 3, 2022, Pages 119-132"
        const volumeMatch = metaText.match(/Volume\s+(\d+)/i);
        if (volumeMatch) volume = volumeMatch[1];
        
        // Extract pages: "Pages 119-132"
        const pagesMatch = metaText.match(/Pages\s+([\d\-]+)/i);
        if (pagesMatch) pages = pagesMatch[1];
        
        // Extract year: "2022"
        const yearMatch = metaText.match(/(\d{4})/);
        if (yearMatch) year = yearMatch[1];
      }
      
      return { journal, volume, pages, year };
    }

    /**
     * 将作者字符串按常见分隔符拆分为姓名数组，并清理脚注/邮箱/标记
     * 例： "Alice Zhang1, Bob Lee*, and Carol de Silva† (carol@x.com)" ->
     *      ["Alice Zhang", "Bob Lee", "Carol de Silva"]
     * @param {string} s
     * @returns {string[]}
     */
    _splitPersonList(s) {
      if (!s) return [];
      let txt = this._mergeSoftWraps(String(s));

      // 去掉邮箱（<...> 或 括号里的 email）
      txt = txt.replace(/<[^>]*@[^>]*>/g, ""); // <name@org>
      txt = txt.replace(/\([^()]*@[^()]*\)/g, ""); // (name@org)

      // 标准化分隔符：, ; 、 ， ； 以及 and/&/与/和
      // 用竖线作为临时分隔符，避免多次 split 累积空格
      txt = txt
        .replace(/\s*(?:,|;|，|；|、)\s*/g, "|")
        .replace(/\s+(?:and|&|与|和)\s+/gi, "|");

      // 拆分
      let parts = txt
        .split("|")
        .map((p) => p.trim())
        .filter(Boolean);

      // 过滤 "et al." 之类
      parts = parts.filter((p) => !/et\s*al\.?$/i.test(p));

      // 清理单个姓名中的脚注/上标/编号/奇怪的标记
      parts = parts
        .map((name) => {
          let n = name;

          // 去掉左右多余标点
          n = n.replace(/^[\s,;·•]+|[\s,;·•]+$/g, "");

          // 去掉常见脚注符号（* † ‡ § ¶ ‖ # ^ ~）
          n = n.replace(/[\*\u2020\u2021\u00A7\u00B6\u2016#\^~]+/g, "");

          // 去掉 Unicode 上标数字 ⁰¹²³⁴⁵⁶⁷⁸⁹
          n = n.replace(/[\u2070-\u2079\u00B9\u00B2\u00B3]+/g, "");

          // 去掉姓名前后的纯数字或编号 (例如 1, 2, a), (1), ^1 等
          n = n.replace(/^\s*[\(\[]?[0-9a-zA-Z]+[\)\]]?\s*/g, "");
          n = n.replace(/\s*[\(\[]?[0-9a-zA-Z]+[\)\]]?\s*$/g, "");

          // 清理多余空白
          n = n.replace(/\s{2,}/g, " ").trim();

          return n;
        })
        .filter((n) => n && n.length >= 2);

      // 去重（保留顺序）
      const seen = new Set();
      const out = [];
      for (const n of parts) {
        const key = n.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(n);
        }
      }
      return out;
    }

    // ============ 私有：通用工具 ============

    _$(sel, root) {
      return (root || this.doc).querySelector(sel);
    }
    _all(sel, root) {
      return Array.from((root || this.doc).querySelectorAll(sel));
    }
    _text(node) {
      return (node && node.textContent ? String(node.textContent) : "")
        .replace(/\s+\u00A0/g, " ")
        .trim();
    }

    _mergeSoftWraps(s) {
      return String(s || "")
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\u00A0/g, " ")
        .trim();
    }

    _abs(url) {
      try {
        if (!url) return url;
        if (/^(?:data|blob|https?):/i.test(url)) return url;
        const origin = this._origin() || "https://www.sciencedirect.com";
        if (url.startsWith("/")) return origin + url; // 站内绝对路径
        const base =
          this._baseHref() ||
          (typeof location !== "undefined" ? location.href : origin + "/");
        return new URL(url, base).toString();
      } catch {
        return url;
      }
    }

    _slug(s) {
      return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\- ]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 80);
    }

    _origin() {
      try {
        return typeof location !== "undefined" && location.origin
          ? location.origin
          : null;
      } catch {
        return null;
      }
    }

    _baseHref() {
      const b = this._$("base");
      const raw = b
        ? b.getAttribute("href") || ""
        : typeof location !== "undefined"
        ? location.href
        : "";
      const origin = this._origin() || "https://www.sciencedirect.com";

      if (!raw)
        return typeof location !== "undefined" ? location.href : origin + "/";
      if (/^https?:\/\//i.test(raw)) return raw; // 已是绝对
      if (raw.startsWith("/")) return origin + raw; // 站内绝对路径 → 拼上 origin
      try {
        return new URL(
          raw,
          typeof location !== "undefined" ? location.href : origin + "/"
        ).toString();
      } catch {
        return typeof location !== "undefined" ? location.href : origin + "/";
      }
    }

    _parseScienceDirectIdVersion() {
      // Extract PII from ScienceDirect URL: /science/article/pii/S2666603022000136
      const src =
        this.baseHref ||
        (typeof location !== "undefined" ? location.pathname : "") ||
        (typeof location !== "undefined" ? location.href : "");
      const m = String(src).match(/\/science\/article\/pii\/([A-Z0-9]+)/i);
      return m ? { id: m[1], version: null } : { id: null, version: null };
    }

    _parseBibNumber(s) {
      if (!s) return null;
      // '#bib17' → 17 ; '[17]' → 17 ; '(17)' → 17
      const m = String(s).match(/#?bib(\d{1,4})\b/);
      return m ? parseInt(m[1], 10) : null;
    }

    _normalizeBibHref(href) {
      if (!href) return href;
      // 统一成 '#bibN' 形式
      const m = String(href).match(/#(bib\d{1,4})\b/);
      return m ? `#${m[1]}` : href;
    }

    _stripParen(s) {
      if (!s) return "";
      const m = String(s)
        .trim()
        .match(/^\(?\s*([^)]+?)\s*\)?$/);
      return m ? m[1] : String(s).trim();
    }

    _sectionDepth(sec) {
      let d = 1,
        p = sec.parentElement;
      while (p) {
        if (
          p.matches &&
          (p.matches("section.ltx_section") ||
            p.matches("section.ltx_subsection") ||
            p.matches("section.ltx_subsubsection"))
        )
          d++;
        p = p.parentElement;
      }
      return d;
    }

    _cellsToText(cells) {
      return Array.from(cells).map((td) =>
        this._mergeSoftWraps(this._text(td))
      );
    }

    _collectEmails(root) {
      const all = [];
      for (const a of this._all('a[href^="mailto:"]', root || this.doc)) {
        const raw = (a.getAttribute("href") || "").slice("mailto:".length);
        // 多邮箱以逗号/分号分隔
        const parts = raw
          .split(/[;,]/)
          .map((x) => x.trim())
          .filter(Boolean);
        for (const p of parts) if (!all.includes(p)) all.push(p);
      }
      return all;
    }

    _parseFootnoteNumber(id) {
      if (!id) return null;
      // 常见 id：footnote.N 或 note.N
      const m = String(id).match(/(?:footnote|note)\.(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    }

    _extractTeX(mathEl) {
      if (!mathEl) return "";
      // 优先 annotation[application/x-tex]，其次 alttext
      const ann = mathEl.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      if (ann && ann.textContent) return String(ann.textContent).trim();
      const alt = mathEl.getAttribute("alttext");
      if (alt) return String(alt).trim();
      // 兜底：尝试从 MathML 结构粗略转换为 TeX（适配非 OA 的 MathJax Assistive MathML）
      try {
        const toTex = (node) => {
          if (!node) return "";
          const tag = (node.tagName || "").toLowerCase();
          const text = (s) => (s || "").replace(/\s+/g, " ").trim();
          const kids = Array.from(node.childNodes || []);
          const joinKids = () => kids.map((c) => (c.nodeType === 1 ? toTex(c) : text(c.nodeValue))).join("");

          switch (tag) {
            case "math":
            case "mrow":
              return kids.map((c) => (c.nodeType === 1 ? toTex(c) : text(c.nodeValue))).join("");
            case "mi":
            case "mn":
            case "mtext":
              return text(node.textContent);
            case "mo": {
              const v = text(node.textContent);
              if (v === "×") return "\\times";
              if (v === "−" || v === "–") return "-";
              if (v === "·") return "\\cdot";
              if (v === "∞") return "\\infty";
              if (v === "≤") return "\\le";
              if (v === "≥") return "\\ge";
              return v;
            }
            case "msup": {
              const base = toTex(node.firstElementChild);
              const sup = toTex(node.lastElementChild);
              return `{${base}}^{${sup}}`;
            }
            case "msub": {
              const base = toTex(node.firstElementChild);
              const sub = toTex(node.lastElementChild);
              return `{${base}}_{${sub}}`;
            }
            case "msubsup": {
              const [base, sub, sup] = kids.filter((k) => k.nodeType === 1).map((el) => toTex(el));
              return `{${base}}_{${sub}}^{${sup}}`;
            }
            case "mfrac": {
              const [num, den] = kids.filter((k) => k.nodeType === 1).map((el) => toTex(el));
              return `\\frac{${num}}{${den}}`;
            }
            case "msqrt": {
              const inner = joinKids();
              return `\\sqrt{${inner}}`;
            }
            case "mfenced": {
              const open = node.getAttribute("open") || "(";
              const close = node.getAttribute("close") || ")";
              const inner = joinKids();
              return `${open}${inner}${close}`;
            }
            case "mspace":
              return " ";
            default:
              return text(node.textContent);
          }
        };
        return toTex(mathEl) || "";
      } catch {
        return "";
      }
    }
  }

  // -----------------------------
  // 4) MarkdownEmitter（生成层）
  // 兼容全局 Config 与 U（utils）
  // -----------------------------
  class MarkdownEmitter {
    constructor(config = typeof Config !== "undefined" ? Config : {}) {
      this.cfg = config;
      this.buffers = {
        head: [],
        body: [],
        footnotes: [], // F* & R* 合并
        references: [], // 文末参考条目
      };
    }

    /** @param {{title:string,authors:Array<{name:string,aff?:string,mail?:string}>,abstract:string,sciencedirectId?:string,version?:string,links?:Record<string,string|null>}} meta */
    emitFrontMatter(meta) {
      const head = this.buffers.head;

      // Title
      head.push(`# ${meta.title || "Untitled"}`);
      head.push("");

      // Authors（逐行）
      if (meta.authors && meta.authors.length) {
        head.push("## Authors");
        for (const a of meta.authors) {
          const parts = [];
          if (a.name) parts.push(a.name);
          const tails = [];
          if (a.aff) tails.push(a.aff);
          if (a.mail) tails.push(`<${a.mail}>`);
          const line = tails.length
            ? `${parts.join(" ")} — ${tails.join("; ")}`
            : parts.join(" ");
          head.push(`- ${line}`);
        }
        head.push("");
      }

      // Abstract
      if (meta.abstract) {
        head.push("## Abstract");
        head.push(this._mergeSoftWraps(meta.abstract));
        head.push("");
      }

      // Highlights (if any)
      if (Array.isArray(meta.highlights) && meta.highlights.length) {
        head.push("## Highlights");
        for (const h of meta.highlights) head.push(`- ${this._mergeSoftWraps(h)}`);
        head.push("");
      }

      // Keywords (if any)
      if (Array.isArray(meta.keywords) && meta.keywords.length) {
        head.push("## Keywords");
        head.push(meta.keywords.join(", "));
        head.push("");
      }

      // Publication Info (ScienceDirect links)
      const linkArticle = meta.links?.article ? `**article:** ${meta.links.article}` : "";
      const linkPdf = meta.links?.pdf
        ? linkArticle
          ? `, **pdf:** ${meta.links.pdf}`
          : `**pdf:** ${meta.links.pdf}`
        : "";
      const linkDoi = meta.links?.doi
        ? linkArticle || linkPdf
          ? `, **doi:** ${meta.links.doi}`
          : `**doi:** ${meta.links.doi}`
        : "";
      
      // Add journal info if available
      if (meta.journal || meta.volume || meta.year || meta.pages) {
        const journalParts = [];
        if (meta.journal) journalParts.push(`**${meta.journal}**`);
        if (meta.volume) journalParts.push(`Volume ${meta.volume}`);
        if (meta.year) journalParts.push(meta.year);
        if (meta.pages) journalParts.push(`Pages ${meta.pages}`);
        head.push(journalParts.join(", "));
      }
      
      if (meta.sciencedirectId || linkArticle || linkPdf || linkDoi) {
        const piiInfo = meta.sciencedirectId ? `**PII:** ${meta.sciencedirectId}` : "";
        const links = [linkArticle, linkPdf, linkDoi].filter(Boolean).join("");
        const infoLine = [piiInfo, links].filter(Boolean).join(links ? " — " : "");
        if (infoLine) {
          head.push(infoLine);
        }
        head.push("");
      }
    }

    emitTOCPlaceholder() {
      this.buffers.head.push("## Table of Contents");
      this.buffers.head.push("[TOC]");
      this.buffers.head.push("");
    }

    emitHeading(level, title, anchor) {
      const h = Math.min(6, Math.max(2, level || 2));
      const text = this._mergeSoftWraps(title || "Section");
      // 仅输出标题；锚点可由渲染器自动生成（也可改用 Pandoc {#anchor} 语法）
      this.buffers.body.push(`${"#".repeat(h)} ${text}`);
      this.buffers.body.push("");
    }

    emitParagraph(text) {
      if (!text) return;
      this.buffers.body.push(this._mergeSoftWraps(String(text)));
      this.buffers.body.push("");
    }

    /** @param {{type:'inline'|'display', tex:string, tag?:string}} math */
    emitMath(math) {
      if (!math?.tex) return;
      if (math.type === "display") {
        const tag = math.tag ? ` \\tag{${math.tag}}` : "";
        this.buffers.body.push(`$$\n${math.tex}${tag}\n$$`);
        this.buffers.body.push("");
      } else {
        // 行内：保持最简语法；由上游确保不与已有 $ 冲突
        this.buffers.body.push(this._mergeSoftWraps(`$${math.tex}$`));
        this.buffers.body.push("");
      }
    }

    /** @param {{kind:'img'|'svg', path?:string, caption?:string, inlineSvg?:string}} fig */
    emitFigure(fig) {
      if (!fig) return;

      // 在插入图片前，若上一个 body 行不是空行，补一个空行，避免粘段
      this._ensureBlockGap();

      const caption = this._mergeSoftWraps(fig.caption || "");
      const figureNumber = fig.figureNumber || "";
      
      // Construct full figure title
      let fullCaption = caption;
      if (figureNumber && caption) {
        fullCaption = `${figureNumber} ${caption}`;
      } else if (figureNumber) {
        fullCaption = figureNumber;
      }

      const captionLine = fullCaption
        ? this.cfg?.FIGURES?.captionStyle === "italic"
          ? `*${fullCaption}*`
          : `**${fullCaption}**`
        : "";

      if (fig.kind === "img" && (fig.path || fig.src)) {
        const path = fig.path || fig.src;
        
        // 1) 图片行 - use alt text without figure number for cleaner display
        this.buffers.body.push(`![${caption}](${path})`);
        
        // 2) 空行分隔
        this.buffers.body.push("");
        
        // 3) 图题行（粗体格式，包含图号）
        if (captionLine) {
          this.buffers.body.push(captionLine);
        }
        
        // 4) 收尾空行
        this.buffers.body.push("");
        return;
      }

      if (fig.kind === "svg") {
        if (this.cfg?.IMAGES?.inlineSvgInMarkdown && fig.inlineSvg) {
          // 1) 内联 SVG（占一整块）
          this.buffers.body.push(fig.inlineSvg);
          // 2) 紧跟一行图题
          if (captionLine) this.buffers.body.push(captionLine);
          // 3) 收尾空行
          this.buffers.body.push("");
        } else if (fig.path) {
          this.buffers.body.push(`![${caption}](${fig.path})`);
          if (captionLine) this.buffers.body.push(captionLine);
          this.buffers.body.push("");
        } else {
          this.buffers.body.push("<!-- TODO: SVG figure placeholder -->");
          if (captionLine) this.buffers.body.push(captionLine);
          this.buffers.body.push("");
        }
      }
    }

    /**
     * @param {{headers?:string[][], rows?:string[][], html?:string}} table
     * - 当 html 存在：直接内联 HTML（保持复杂表结构）
     * - 否则：渲染为 GitHub 风格 Markdown 表
     */
    emitTable(table) {
      if (!table) return;
      if (table.html) {
        this.buffers.body.push(table.html);
        this.buffers.body.push("");
        return;
      }

      const headers =
        Array.isArray(table.headers) && table.headers.length
          ? table.headers
          : [];
      const rows = Array.isArray(table.rows) ? table.rows : [];

      const escapeCell = (s) => this._escapeTableCell(String(s ?? ""));
      const line = (arr, cols) =>
        `| ${Array.from({ length: cols }, (_, i) =>
          escapeCell(arr[i] ?? "")
        ).join(" | ")} |`;

      // 列数：取头行/首行最大长度
      const cols = Math.max(
        headers.reduce((m, r) => Math.max(m, r.length), 0),
        rows.reduce((m, r) => Math.max(m, r.length), 0),
        1
      );

      if (headers.length) {
        // 使用第一行作为标题（多行表头合并为一行）
        const flatHead = headers[0];
        this.buffers.body.push(line(flatHead, cols));
      } else {
        // 无表头：生成空表头
        this.buffers.body.push(line([], cols));
      }

      // 分隔行
      this.buffers.body.push(
        `| ${Array.from({ length: cols })
          .map(() => "---")
          .join(" | ")} |`
      );

      // 表体
      for (const r of rows) {
        this.buffers.body.push(line(r, cols));
      }
      this.buffers.body.push("");
    }

    /** 参考文献（文末） */
    emitReferences(bibItems) {
      if (!bibItems?.length) return;
      const out = this.buffers.references;
      out.push("## References");
      for (const it of bibItems) {
        let line = `[${it.num}] ${this._mergeSoftWraps(it.text || "")}`;
        // 附加 DOI/URL（避免重复，使用 markdown 链接格式）
        if (it.doi && !line.includes(it.doi)) {
          const doiUrl = it.doi.startsWith('http') ? it.doi : `https://doi.org/${it.doi}`;
          line += ` [DOI](${doiUrl})`;
        }
        if (it.url && !line.includes(it.url)) line += ` [URL](${it.url})`;
        out.push(line);
      }
      out.push("");
    }

    /** 脚注：合并 F/R 两类脚注（顺序遵循调用次序） */
    emitFootnotes(footnoteItems) {
      if (!footnoteItems?.length) return;
      const out = this.buffers.footnotes;
      for (const f of footnoteItems) {
        if (!f?.key || !f?.content) continue;
        out.push(`[^${f.key}]: ${this._mergeSoftWraps(f.content)}`);
      }
      out.push("");
    }

    compose() {
      return [
        this.buffers.head.join("\n"),
        this.buffers.body.join("\n"),
        this.buffers.footnotes.join("\n"),
        this.buffers.references.join("\n"),
      ].join("\n");
    }

    reset() {
      this.buffers = {
        head: [],
        body: [],
        footnotes: [],
        references: [],
      };
    }

    // =============== 私有工具 ===============

    _mergeSoftWraps(s) {
      return String(s || "")
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\u00A0/g, " ")
        .trim();
    }

    _escapeTableCell(s) {
      // 转义竖线与回车；保留基本 Markdown 可读性
      return s
        .replace(/\|/g, "\\|")
        .replace(/\r?\n/g, "<br>")
        .replace(/\t/g, " ")
        .trim();
    }

    /** 若 body 末尾不是空行，则补一个空行，保证块级元素前有分隔 */
    _ensureBlockGap() {
      const body = this.buffers?.body;
      if (!body || !body.length) return;
      // 找到最后一个非空元素
      for (let i = body.length - 1; i >= 0; i--) {
        const line = body[i];
        if (line === "") return; // 已是空行，无需再加
        if (typeof line === "string") {
          // 末行是非空字符串 -> 补一个空行
          body.push("");
          return;
        }
      }
    }
  }

  // -----------------------------
  // 5) AssetsManager（资源层）
  // 依赖全局 Config 与 Log（若无则用 console 兜底）
  // -----------------------------
  class AssetsManager {
    constructor(config = typeof Config !== "undefined" ? Config : {}) {
      this.cfg = Object.assign(
        {
          IMAGES: {
            maxBytes: 2.5 * 1024 * 1024,
            maxDim: 4096,
            concurrency: 4,
            preferRaster: true,
          },
        },
        config
      );

      this.assets = []; // {name, blob, mime, path, dataURL?, hash}
      this._sem = 0;
      this._queue = [];
      this._assetNames = new Set();
      this._hashIndex = new Map(); // hash -> index in assets
    }

    // ========== Public API ==========

    /**
     * 下载位图、按需缩放/转码；注册为资源并返回占位信息
     * 返回：
     *   - path: 原始 http(s)/data 链接（用于 Links 形态）
     *   - assetPath: "assets/<name>"（用于 TextBundle/离线）
     *   - name, mime, bytes, width, height
     */
    async fetchRaster(url, opts = {}) {
      const logger = typeof Log !== "undefined" ? Log : console;
      try {
        if (!url) return { path: url };

        // dataURL 直接注册
        if (/^data:/i.test(url)) {
          const parsed = this._dataUrlToBlob(url);
          const name = this._uniqueName(
            this._filenameFromURL("image"),
            this._extFromMime(parsed.type)
          );
          const assetPath = `assets/${name}`;
          const hash = await this._hashArrayBuffer(
            await parsed.blob.arrayBuffer()
          );
          const idx = this._registerAsset({
            name,
            blob: parsed.blob,
            mime: parsed.type,
            path: assetPath,
            dataURL: url,
            hash,
          });
          return {
            path: url,
            assetPath,
            name,
            mime: parsed.type,
            bytes: parsed.blob.size,
          };
        }

        // 跨域抓取 Blob
        const blob = await this._limit(() => this._getBlob(url));
        if (!blob) return { path: url };

        // GIF 动图：避免 Canvas 破坏动效；原样保留
        if (/image\/gif/i.test(blob.type)) {
          const name = this._uniqueName(this._filenameFromURL(url), ".gif");
          const assetPath = `assets/${name}`;
          const hash = await this._hashArrayBuffer(await blob.arrayBuffer());
          const idx = this._registerAsset({
            name,
            blob,
            mime: "image/gif",
            path: assetPath,
            hash,
          });
          return {
            path: url,
            assetPath,
            name,
            mime: "image/gif",
            bytes: blob.size,
          };
        }

        // 其他位图：按需缩放/转码（优先 webp，回退 png）
        const maxDim = opts.maxDim || this.cfg.IMAGES.maxDim || 4096;
        const maxBytes =
          opts.maxBytes || this.cfg.IMAGES.maxBytes || 2.5 * 1024 * 1024;

        const scaled = await this._maybeScaleAndTranscode(blob, {
          maxDim,
          maxBytes,
        });
        const outBlob = scaled.blob;
        const mime = outBlob.type || "image/png";

        // 生成资源名与存储
        const name = this._uniqueName(
          this._filenameFromURL(url),
          this._extFromMime(mime)
        );
        const assetPath = `assets/${name}`;
        const hash = await this._hashArrayBuffer(await outBlob.arrayBuffer());
        const idx = this._registerAsset({
          name,
          blob: outBlob,
          mime,
          path: assetPath,
          hash,
        });

        return {
          path: url,
          assetPath,
          name,
          mime,
          bytes: outBlob.size,
          width: scaled.width,
          height: scaled.height,
        };
      } catch (err) {
        logger?.warn?.("AssetsManager.fetchRaster error:", err);
        return { path: url };
      }
    }

    /**
     * 记录/导出 SVG 资源
     * - 返回 inlineSvg 用于内联
     * - 同时注册 Blob 以便 TextBundle 落地
     */
    async registerSvg(svgElement, suggestedName = "figure.svg") {
      const logger = typeof Log !== "undefined" ? Log : console;
      try {
        const serialized = this._serializeSvg(svgElement);
        const mime = "image/svg+xml";
        const blob = new Blob([serialized], { type: mime });
        const ext = ".svg";
        const base = this._stripExt(suggestedName) || "figure";
        const name = this._uniqueName(base, ext);
        const assetPath = `assets/${name}`;
        const hash = await this._hashArrayBuffer(await blob.arrayBuffer());

        this._registerAsset({ name, blob, mime, path: assetPath, hash });
        return {
          path: null,
          inlineSvg: serialized,
          assetPath,
          name,
          mime,
          bytes: blob.size,
        };
      } catch (err) {
        logger?.warn?.("AssetsManager.registerSvg error:", err);
        return {
          path: null,
          inlineSvg: svgElement?.outerHTML || "<!-- svg -->",
        };
      }
    }

    /** 返回资源浅拷贝列表：[{name,mime,path,blob?,dataURL?}] */
    list() {
      return this.assets.slice();
    }

    /** 清空资源 */
    clear() {
      this.assets = [];
      this._assetNames.clear?.();
      this._hashIndex.clear?.();
      this._sem = 0;
      this._queue = [];
    }

    /** 将 Blob 转成 dataURL（供 Base64 形态替换时调用） */
    async toDataURL(assetOrIndex) {
      const a =
        typeof assetOrIndex === "number"
          ? this.assets[assetOrIndex]
          : assetOrIndex;
      if (!a) return null;
      if (a.dataURL) return a.dataURL;
      a.dataURL = await this._blobToDataURL(a.blob);
      return a.dataURL;
    }

    // ========== Internals ==========

    /** 限流：并发不超过 cfg.IMAGES.concurrency */
    _limit(taskFn) {
      const max = Math.max(1, this.cfg.IMAGES?.concurrency || 4);
      return new Promise((resolve, reject) => {
        const run = async () => {
          this._sem++;
          try {
            const v = await taskFn();
            resolve(v);
          } catch (e) {
            reject(e);
          } finally {
            this._sem--;
            const next = this._queue.shift();
            if (next) next();
          }
        };
        if (this._sem < max) run();
        else this._queue.push(run);
      });
    }

    /** 使用 GM_xmlhttpRequest 或 fetch 获取 Blob */
    _getBlob(url) {
      return new Promise((resolve, reject) => {
        const logger = typeof Log !== "undefined" ? Log : console;
        if (typeof GM_xmlhttpRequest === "function") {
          try {
            GM_xmlhttpRequest({
              method: "GET",
              url,
              responseType: "blob",
              onload: (resp) => {
                const blob = resp.response;
                if (blob instanceof Blob) return resolve(blob);
                // 某些环境下是 ArrayBuffer
                if (resp.response && resp.response.byteLength) {
                  const type =
                    this._contentTypeFromHeaders(resp.responseHeaders) ||
                    this._mimeFromURL(url) ||
                    "application/octet-stream";
                  return resolve(new Blob([resp.response], { type }));
                }
                resolve(null);
              },
              onerror: (e) => reject(e),
            });
            return;
          } catch (e) {
            logger?.warn?.("GM_xmlhttpRequest failed, fallback to fetch:", e);
          }
        }
        // Fallback: fetch
        fetch(url, { mode: "cors", credentials: "omit" })
          .then((r) =>
            r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))
          )
          .then(resolve)
          .catch(reject);
      });
    }

    _contentTypeFromHeaders(headers) {
      if (!headers) return null;
      const m = String(headers).match(/content-type:\s*([^\r\n]+)/i);
      return m ? m[1].trim() : null;
    }

    async _maybeScaleAndTranscode(blob, { maxDim, maxBytes }) {
      // 直接读取原宽高
      const { img, width, height } = await this._imageFromBlob(blob);

      let targetW = width;
      let targetH = height;

      // 尺寸约束
      const maxSide = Math.max(width, height);
      if (maxSide > maxDim) {
        const scale = maxDim / maxSide;
        targetW = Math.max(1, Math.round(width * scale));
        targetH = Math.max(1, Math.round(height * scale));
      }

      // 首次尝试：WebP（若支持，否则 PNG）
      const preferWebP = await this._supportsWebP();
      let type = preferWebP ? "image/webp" : "image/png";
      let quality = preferWebP ? 0.92 : undefined;

      let out = await this._drawToBlob(img, targetW, targetH, type, quality);
      // 若体积仍超限，逐步降质量，再不行则继续缩边
      let iter = 0;
      while (out.size > maxBytes && iter < 8) {
        iter++;
        if (preferWebP && quality > 0.6) {
          quality = Math.max(0.6, quality - 0.07);
        } else {
          targetW = Math.max(1, Math.floor(targetW * 0.85));
          targetH = Math.max(1, Math.floor(targetH * 0.85));
        }
        out = await this._drawToBlob(img, targetW, targetH, type, quality);
      }

      return { blob: out, width: targetW, height: targetH };
    }

    async _imageFromBlob(blob) {
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = (e) => rej(e);
          im.src = url;
        });
        return {
          img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    async _drawToBlob(img, w, h, mime = "image/png", q) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      // 关闭插值锯齿
      if (ctx.imageSmoothingEnabled !== undefined)
        ctx.imageSmoothingEnabled = true;
      if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);

      // toBlob 异步更省内存；Safari 早期可能不支持，退回 toDataURL
      const blob = await new Promise((res) => {
        if (canvas.toBlob) {
          canvas.toBlob(
            (b) =>
              res(b || this._dataURLToBlob(canvas.toDataURL(mime, q)).blob),
            mime,
            q
          );
        } else {
          res(this._dataURLToBlob(canvas.toDataURL(mime, q)).blob);
        }
      });
      return blob;
    }

    async _supportsWebP() {
      if (typeof this._webpSupport !== "undefined") return this._webpSupport;
      const c = document.createElement("canvas");
      const ok =
        c.toDataURL &&
        c.toDataURL("image/webp").indexOf("data:image/webp") === 0;
      this._webpSupport = ok;
      return ok;
    }

    _registerAsset(rec) {
      // 去重：按 hash 去重
      if (rec.hash && this._hashIndex.has(rec.hash)) {
        return this._hashIndex.get(rec.hash);
      }
      const idx = this.assets.push(rec) - 1;
      if (rec.hash) this._hashIndex.set(rec.hash, idx);
      this._assetNames.add(rec.name);
      return idx;
    }

    _uniqueName(base, ext) {
      const cleanBase = this._sanitizeName(base || "asset");
      const cleanExt = ext && ext.startsWith(".") ? ext : ext ? `.${ext}` : "";
      let n = `${cleanBase}${cleanExt}`;
      let i = 1;
      while (this._assetNames.has(n)) {
        n = `${cleanBase}_${String(++i).padStart(2, "0")}${cleanExt}`;
      }
      this._assetNames.add(n);
      return n;
    }

    _filenameFromURL(urlOrBase) {
      try {
        const u = new URL(urlOrBase, location.href);
        const last = u.pathname.split("/").filter(Boolean).pop() || "image";
        return this._stripExt(this._sanitizeName(last));
      } catch {
        return this._stripExt(this._sanitizeName(String(urlOrBase || "image")));
      }
    }

    _stripExt(name) {
      return String(name || "").replace(/\.[a-z0-9]+$/i, "");
    }

    _sanitizeName(s) {
      return (
        String(s || "asset")
          .replace(/[^\w.-]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 64) || "asset"
      );
    }

    _extFromMime(mime) {
      mime = (mime || "").toLowerCase();
      if (mime.includes("image/webp")) return ".webp";
      if (mime.includes("image/png")) return ".png";
      if (mime.includes("image/jpeg") || mime.includes("image/jpg"))
        return ".jpg";
      if (mime.includes("image/svg")) return ".svg";
      if (mime.includes("image/gif")) return ".gif";
      return ".bin";
    }

    _mimeFromURL(url) {
      const m = String(url || "")
        .toLowerCase()
        .match(/\.(png|jpe?g|webp|gif|svg)\b/);
      if (!m) return null;
      const ext = m[1];
      return (
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          gif: "image/gif",
          svg: "image/svg+xml",
        }[ext] || null
      );
    }

    async _blobToDataURL(blob) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ""));
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
    }

    _dataUrlToBlob(dataURL) {
      const m = String(dataURL).match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
      if (!m)
        return {
          blob: new Blob([new Uint8Array(0)], {
            type: "application/octet-stream",
          }),
          type: "application/octet-stream",
        };
      const mime = m[1] || "application/octet-stream";
      const isB64 = !!m[2];
      const data = decodeURIComponent(m[3]);
      if (isB64) {
        const bin = atob(data);
        const len = bin.length;
        const u8 = new Uint8Array(len);
        for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
        return { blob: new Blob([u8], { type: mime }), type: mime };
      } else {
        return { blob: new Blob([data], { type: mime }), type: mime };
      }
    }

    _serializeSvg(svgEl) {
      // 若缺少 xmlns，补齐
      try {
        const el = svgEl.cloneNode(true);
        if (!el.getAttribute("xmlns"))
          el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        if (!el.getAttribute("xmlns:xlink"))
          el.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
        const xml = new XMLSerializer().serializeToString(el);
        // 某些环境需在最前加入 XML 声明以增强兼容
        return /^<\?xml/i.test(xml)
          ? xml
          : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
      } catch {
        return (
          svgEl?.outerHTML || '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
        );
      }
    }

    async _hashArrayBuffer(ab) {
      try {
        if (crypto?.subtle?.digest) {
          const buf = await crypto.subtle.digest("SHA-1", ab);
          const arr = Array.from(new Uint8Array(buf));
          return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
        }
      } catch {
        /* ignore */
      }
      // 退化为简易字符串 hash（DJ2）
      let h = 5381,
        i = 0,
        u8 = new Uint8Array(ab);
      for (; i < u8.length; i++) h = (h << 5) + h + u8[i];
      return (h >>> 0).toString(16);
    }
  }

  // -----------------------------
  // 6) Exporter（三形态导出）
  // 依赖：可选 Config；不依赖第三方库
  // -----------------------------
  class Exporter {
    constructor(config = typeof Config !== "undefined" ? Config : {}) {
      this.cfg = config;
      this._assetsProvider = null; // 可绑定 AssetsManager 或 assets 数组
    }

    /** 绑定资源来源（AssetsManager 实例或 assets 数组） */
    bindAssets(providerOrArray) {
      this._assetsProvider = providerOrArray || null;
    }

    /** 纯链接版 Markdown（不嵌入资源） */
    async asMarkdownLinks(markdown) {
      return String(markdown || "");
    }

    /**
     * Base64 版 Markdown（把 assets/<name> 与 HTML src/href 内的相对路径替换为 dataURL）
     * @param {string} markdown
     * @param {Array<{name:string, mime:string, path:string, blob?:Blob, dataURL?:string}>=} assets
     */
    async asMarkdownBase64(markdown, assets) {
      let md = String(markdown || "");
      const list = await this._resolveAssets(assets);
      if (!list.length) return md;

      // 构建 path -> dataURL 映射（仅对含 blob 的资源）
      const path2data = new Map();
      for (const a of list) {
        const p = a.path || (a.name ? `assets/${a.name}` : null);
        if (!p) continue;
        const dataURL =
          a.dataURL || (a.blob ? await this._blobToDataURL(a.blob) : null);
        if (!dataURL) continue;
        path2data.set(p, dataURL);
        // 兼容常见相对写法
        path2data.set(`./${p}`, dataURL);
        path2data.set(`/${p}`, dataURL);
      }

      // 替换 Markdown 与 HTML 路径
      for (const [p, durl] of path2data.entries()) {
        // 1) Markdown 链接/图片：(assets/xxx)
        md = md.replace(
          new RegExp(`\\((\\s*?)${this._escReg(p)}(\\s*?)\\)`, "g"),
          (_m, a, b) => `(${a}${durl}${b})`
        );
        // 2) HTML 属性：src="assets/xxx" / src='assets/xxx'
        md = md.replace(
          new RegExp(`(src|href)=(")${this._escReg(p)}(")`, "g"),
          (_m, k, q1, q2) => `${k}=${q1}${durl}${q2}`
        );
        md = md.replace(
          new RegExp(`(src|href)=(')${this._escReg(p)}(')`, "g"),
          (_m, k, q1, q2) => `${k}=${q1}${durl}${q2}`
        );
      }
      return md;
    }

    /**
     * TextBundle（打包 info.json + text.md + assets/* 为 ZIP；可命名为 .textbundle 或 .textpack）
     * @param {string} markdown
     * @param {Array<{name:string, mime:string, path:string, blob?:Blob}>=} assets
     * @returns {Promise<{filename:string, blob:Blob}>}
     */
    async asTextBundle(markdown, assets) {
      const files = [];
      const textMd = this._utf8(`\ufeff${String(markdown || "")}`); // 带 BOM 以兼容部分编辑器
      const info = {
        version: 2,
        type: "net.daringfireball.markdown", // 也可用 'public.plain-text'
        creatorIdentifier: "qiqi.sciencedirect.md.exporter",
        transient: false,
      };
      const infoJson = this._utf8(JSON.stringify(info, null, 2));

      files.push({ name: "text.md", data: textMd });
      files.push({ name: "info.json", data: infoJson });

      const list = await this._resolveAssets(assets);
      for (const a of list) {
        if (!a?.blob || !a?.name) continue;
        const data = new Uint8Array(await a.blob.arrayBuffer());
        files.push({ name: `assets/${a.name}`, data });
      }

      const zipBlob = await this._zip(files);
      return { filename: "export.textbundle", blob: zipBlob };
    }

    // ============== 私有辅助 ==============

    async _resolveAssets(assetsMaybe) {
      if (Array.isArray(assetsMaybe)) return assetsMaybe;
      if (this._assetsProvider) {
        if (Array.isArray(this._assetsProvider)) return this._assetsProvider;
        if (typeof this._assetsProvider.list === "function") {
          try {
            return this._assetsProvider.list() || [];
          } catch {
            /* ignore */
          }
        }
      }
      // 尝试从全局钩子读取（可选）
      if (
        typeof window !== "undefined" &&
        Array.isArray(window.__SCIENCEDIRECT_MD_ASSETS__)
      ) {
        return window.__SCIENCEDIRECT_MD_ASSETS__;
      }
      return [];
    }

    _escReg(s) {
      return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    async _blobToDataURL(blob) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ""));
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
    }

    _utf8(str) {
      return new TextEncoder().encode(String(str ?? ""));
    }

    // —— ZIP 生成（STORED，无压缩），零依赖 —— //
    async _zip(fileEntries) {
      // fileEntries: [{name:string, data:Uint8Array}]
      const files = [];
      let centralSize = 0;
      let offset = 0;
      const now = new Date();
      const dosTime = this._dosTime(now);
      const dosDate = this._dosDate(now);

      // 计算每个文件的局部头和数据
      for (const fe of fileEntries) {
        const nameBytes = this._utf8(fe.name);
        const data = fe.data || new Uint8Array(0);
        const crc = this._crc32(data);

        const localHeader = [];
        this._pushU32(localHeader, 0x04034b50); // local file header sig
        this._pushU16(localHeader, 20); // version needed
        this._pushU16(localHeader, 0); // flags
        this._pushU16(localHeader, 0); // method = 0 (stored)
        this._pushU16(localHeader, dosTime); // time
        this._pushU16(localHeader, dosDate); // date
        this._pushU32(localHeader, crc); // CRC32
        this._pushU32(localHeader, data.length); // compressed size
        this._pushU32(localHeader, data.length); // uncompressed size
        this._pushU16(localHeader, nameBytes.length); // name length
        this._pushU16(localHeader, 0); // extra length

        const localHeaderBytes = new Uint8Array(localHeader);
        const fileOffset = offset;
        offset += localHeaderBytes.length + nameBytes.length + data.length;

        files.push({
          nameBytes,
          data,
          crc,
          localHeaderBytes,
          fileOffset,
        });
      }

      // 构建 central directory
      const central = [];
      for (const f of files) {
        const nameLen = f.nameBytes.length;
        const dataLen = f.data.length;

        this._pushU32(central, 0x02014b50); // central file header sig
        this._pushU16(central, 20); // version made by
        this._pushU16(central, 20); // version needed
        this._pushU16(central, 0); // flags
        this._pushU16(central, 0); // method
        this._pushU16(central, dosTime); // time
        this._pushU16(central, dosDate); // date
        this._pushU32(central, f.crc); // CRC
        this._pushU32(central, dataLen); // comp size
        this._pushU32(central, dataLen); // uncomp size
        this._pushU16(central, nameLen); // name len
        this._pushU16(central, 0); // extra len
        this._pushU16(central, 0); // comment len
        this._pushU16(central, 0); // disk number
        this._pushU16(central, 0); // internal attrs
        this._pushU32(central, 0); // external attrs
        this._pushU32(central, f.fileOffset); // relative offset
        // filename bytes
        central.push(...f.nameBytes);
      }
      const centralBytes = new Uint8Array(central);
      const centralOffset = offset;
      const centralLength = centralBytes.length;
      offset += centralLength;

      // End of central directory
      const end = [];
      this._pushU32(end, 0x06054b50);
      this._pushU16(end, 0); // disk
      this._pushU16(end, 0); // disk start
      this._pushU16(end, files.length); // entries on this disk
      this._pushU16(end, files.length); // total entries
      this._pushU32(end, centralLength);
      this._pushU32(end, centralOffset);
      this._pushU16(end, 0); // comment length
      const endBytes = new Uint8Array(end);

      // 拼装所有片段
      const chunks = [];
      for (const f of files) {
        chunks.push(f.localHeaderBytes, f.nameBytes, f.data);
      }
      chunks.push(centralBytes, endBytes);

      const blob = new Blob(chunks, { type: "application/zip" });
      return blob;
    }

    _pushU16(arr, n) {
      arr.push(n & 0xff, (n >>> 8) & 0xff);
    }
    _pushU32(arr, n) {
      arr.push(
        n & 0xff,
        (n >>> 8) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 24) & 0xff
      );
    }

    _dosTime(d) {
      const h = d.getHours(),
        m = d.getMinutes(),
        s = Math.floor(d.getSeconds() / 2);
      return (h << 11) | (m << 5) | s;
    }
    _dosDate(d) {
      const y = d.getFullYear() - 1980,
        m = d.getMonth() + 1,
        day = d.getDate();
      return (y << 9) | (m << 5) | day;
    }

    // —— CRC32 —— //
    _crcTable() {
      if (this.__crcTable) return this.__crcTable;
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
      }
      this.__crcTable = table;
      return table;
    }
    _crc32(u8) {
      const tbl = this._crcTable();
      let c = 0 ^ -1;
      for (let i = 0; i < u8.length; i++) {
        c = (c >>> 8) ^ tbl[(c ^ u8[i]) & 0xff];
      }
      return (c ^ -1) >>> 0;
    }
  }

  // -----------------------------
  // 7) Controller（编排）· 完整实现
  // 依赖：ScienceDirectAdapter / AssetsManager / MarkdownEmitter / Exporter / U / Log / Config
  // -----------------------------
  class Controller {
    constructor() {
      this.adapter = new ScienceDirectAdapter(document);
      this.assets = new AssetsManager();
      this.emitter = new MarkdownEmitter();
      this.exporter = new Exporter();
      // 让 Exporter 能直接拿到资源列表
      this.exporter.bindAssets(this.assets);

      // 缓存系统
      this._cache = {
        meta: null,
        bibliography: null,
        citationMap: null,
        sections: null,
        baseMarkdown: null, // 基础Markdown内容（links模式）
        lastPageHash: null, // 页面内容哈希
        assetsSnapshot: null, // 资源快照
      };
    }

    /**
     * 等待文章主体与引用内容加载完成（适配非 Open Access 页面异步加载）
     * - 条件：存在至少一个 section[id^="sec"]，并且出现段落 div[id^='p'] 或参考文献条目/引文锚
     * - 超时：默认 20s（仍继续执行，以当下已加载内容为准）
     */
    async _waitForArticleContent(maxWaitMs = 20000) {
      const checkReady = () => {
        const hasSec = !!document.querySelector("section[id^='sec'], section[id^='s']");
        const hasPara = !!document.querySelector("section[id^='sec'] div[id^='p'], section[id^='s'] div[id^='p']");
        const hasBib = !!document.querySelector(
          "section.bibliography ol.references li, #references li"
        );
        const hasCiteAnchors = !!document.querySelector("a[href*='#bib'], a[href^='#b'], a[data-xocs-content-type='reference']");
        // If authors have superscripts, wait for affiliations to load
        const wantsAff = !!document.querySelector('.AuthorGroups .author-ref sup, .author-group .author-ref sup, #author-group .author-ref sup');
        const hasAff = !!document.querySelector('dl.affiliation dt sup, dl.affiliation dt');
        const authorAffReady = wantsAff ? hasAff : true;
        return hasSec && (hasPara || hasBib || hasCiteAnchors) && authorAffReady;
      };

      if (checkReady()) return true;

      return await new Promise((resolve) => {
        let done = false;
        let triedExpand = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          try { observer.disconnect(); } catch {}
          clearTimeout(timer);
          resolve(!!ok);
        };

        const observer = new MutationObserver(() => {
          tryExpand();
          if (checkReady()) finish(true);
        });
        try {
          observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true,
          });
        } catch {}

        const timer = setTimeout(() => finish(false), Math.max(1000, maxWaitMs));

        // 保险：页面 load 后再检查一次
        if (document.readyState === 'complete') {
          setTimeout(() => { tryExpand(); if (checkReady()) finish(true); }, 0);
        } else {
          window.addEventListener('load', () => {
            setTimeout(() => { tryExpand(); if (checkReady()) finish(true); }, 0);
          }, { once: true });
        }

        function tryExpand() {
          if (triedExpand) return;
          const hasAff = !!document.querySelector('dl.affiliation dt sup, dl.affiliation dt');
          const wantsAff = !!document.querySelector('.AuthorGroups .author-ref sup, .author-group .author-ref sup, #author-group .author-ref sup');
          if (hasAff || !wantsAff) return;
          // Try clicking Show more to expand author affiliations
          let btn = document.querySelector('#show-more-btn');
          if (!btn) {
            btn = Array.from(document.querySelectorAll('.Banner button, #banner button, .wrapper button'))
              .find((b) => /show\s*more/i.test(b.textContent || '')) ||
              document.querySelector("button.button-link[data-aa-button='icon-expand']");
          }
          if (btn) {
            triedExpand = true;
            try { btn.click(); } catch {}
          }
        }
      });
    }

    _prepareRun(mode, clearCache = true) {
      Log.info("Preparing run for mode:", mode, "clearCache:", clearCache);

      // 1) 清空文本缓冲
      if (typeof this.emitter?.reset === "function") {
        this.emitter.reset();
      } else {
        this.emitter = new MarkdownEmitter(); // 兼容：万一没有 reset()
      }

      // 2) 清空资源（即使 links 模式也清空，避免历史资产影响后续替换）
      if (this.assets && typeof this.assets.clear === "function") {
        this.assets.clear();
      }

      // 3) 清空本次运行的状态寄存
      this._cited = new Set();
      this._lastMeta = null;

      // 4) 可选择性清除缓存（页面刷新或强制重新生成时）
      if (clearCache) {
        this._invalidateCache();
      }
    }

    // -----------------------------
    // 缓存辅助方法
    // -----------------------------

    /**
     * 生成页面哈希用于缓存失效检测
     */
    _getPageHash() {
      const title = document.title || "";
      const bodyLength = document.body ? document.body.textContent.length : 0;
      const abstractLength = U.$("div.ltx_abstract")?.textContent?.length || 0;
      return `${title}-${bodyLength}-${abstractLength}`;
    }

    /**
     * 构建基础缓存数据（使用原始完整逻辑，固定为links模式）
     */
    async _buildBaseCacheWithOriginalLogic() {
      Log.info("Building base cache data with original logic...");

      // 等待文章主体完成异步加载（非 OA 页面常见）
      const ok = await this._waitForArticleContent(20000);
      Log.info("Article content ready:", ok);

      // 提取基础数据
      const meta = this.adapter.getMeta();
      Log.info("Cached metadata:", {
        title: meta.title,
        authors: meta.authors.length,
      });
      this._lastMeta = meta;

      const bib = this.adapter.collectBibliography();
      Log.info("Cached bibliography:", bib.length, "references");

      const citeMap = this.adapter.buildCitationMap(bib);
      const sections = this.adapter.walkSections();
      Log.info("Cached sections:", sections.length);

      // 缓存基础数据
      this._cache.meta = meta;
      this._cache.bibliography = bib;
      this._cache.citationMap = citeMap;
      this._cache.sections = sections;

      // 生成基础Markdown（使用links模式的完整原始逻辑）
      this._cache.baseMarkdown = await this._generateBaseCacheMarkdown(
        meta,
        bib,
        citeMap,
        sections
      );

      Log.info("Base cache built successfully");
    }

    /**
     * 生成基础缓存Markdown（完整原始逻辑，固定links模式）
     */
    async _generateBaseCacheMarkdown(meta, bib, citeMap, sections) {
      // 重置状态
      this._cited = new Set();
      const footF = [];
      this._paraSeen = undefined;
      this._paraQueue = undefined;

      // 头部
      this.emitter.emitFrontMatter(meta);
      this.emitter.emitTOCPlaceholder();

      // 正文 - 使用原始完整逻辑但固定links模式
      for (const sec of sections) {
        this.emitter.emitHeading(
          sec.level || 2,
          sec.title || "Section",
          sec.anchor
        );

        for (const node of sec.nodes || []) {
          // 段落（含行内数学/引文替换 + 清噪 + 近邻去重）
          if (this._isParagraph(node)) {
            const text = this._renderParagraphWithMathAndCites(node, citeMap);
            this._emitParagraphDedup(text);
            continue;
          }

          // 块级数学
          if (
            this._isDisplayMath(node) ||
            (node.tagName?.toLowerCase() === "math" &&
              (node.getAttribute("display") || "").toLowerCase() === "block")
          ) {
            const m = this.adapter.extractMath(node);
            if (m) this.emitter.emitMath(m);
            continue;
          }

          // 图（固定使用links模式逻辑）
          if (node.matches && node.matches("figure.figure")) {
            const fig = this.adapter.extractFigure(node);
            if (!fig) continue;

            if (fig.kind === "img") {
              // 固定使用links模式
              this.emitter.emitFigure({
                kind: "img",
                path: fig.src,
                caption: fig.caption,
              });
            } else if (fig.kind === "svg") {
              // 固定使用内联SVG模式（非textbundle）
              this.emitter.emitFigure({
                kind: "svg",
                inlineSvg: fig.inlineSvg,
                caption: fig.caption,
              });
            }
            continue;
          }

          // 表
          if (node.matches && node.matches("div.tables")) {
            const t = this.adapter.extractTable(node);
            this.emitter.emitTable(t);
            continue;
          }

          // 列表（转行内数学与引文，再近邻去重逐行落）
          if (node.matches && node.matches("ul, ol")) {
            const lines = this._renderList(node, citeMap, 0);
            for (const l of lines) this._emitParagraphDedup(l);
            continue;
          }

          // 代码块
          if (
            node.matches &&
            node.matches("pre.ltx_verbatim, .ltx_listing pre")
          ) {
            const code = (node.textContent || "").replace(/\s+$/, "");
            this.emitter.emitParagraph("```\n" + code + "\n```");
            continue;
          }

          // 正文脚注
          if (node.matches && node.matches("div.ltx_note.ltx_role_footnote")) {
            const f = this.adapter.extractFootnote(node);
            if (f) footF.push(f);
            continue;
          }

          // 兜底：当作段落处理并去重
          const fallback = (node.textContent || "").trim();
          if (fallback) this._emitParagraphDedup(fallback);
        }
      }

      // 生成参考脚注（R*，直接写全参考条目文本+DOI/URL）
      const footR = this._makeReferenceFootnotes(bib, this._cited);

      // 合并 F*/R* 脚注并按 key 去重
      const footMap = new Map();
      for (const f of [...(footF || []), ...(footR || [])]) {
        if (f?.key && f?.content && !footMap.has(f.key))
          footMap.set(f.key, f.content);
      }
      this.emitter.emitFootnotes(
        [...footMap].map(([key, content]) => ({ key, content }))
      );

      // 文末参考
      this.emitter.emitReferences(bib);

      // 生成最终Markdown
      return this.emitter.compose();
    }

    /**
     * 根据模式处理差异（使用原始逻辑）
     */
    async _processForModeWithOriginalLogic(mode) {
      if (mode === "links") {
        Log.info("Using cached links mode markdown...");
        return this._cache.baseMarkdown;
      } else {
        Log.info("Processing mode-specific logic for:", mode);
        // 对于非links模式，需要重新运行图片处理逻辑
        return await this._regenerateWithModeSpecificLogic(mode);
      }
    }

    /**
     * 使用缓存数据重新生成特定模式的Markdown
     */
    async _regenerateWithModeSpecificLogic(mode) {
      const { meta, bib, citeMap, sections } = this._cache;

      // 重置状态
      this._cited = new Set();
      const footF = [];
      this._paraSeen = undefined;
      this._paraQueue = undefined;

      // 重置emitter（为了避免与缓存构建时的冲突）
      this.emitter.reset();

      // 头部
      this.emitter.emitFrontMatter(meta);
      this.emitter.emitTOCPlaceholder();

      // 正文 - 使用原始逻辑但根据模式处理图片
      for (const sec of sections) {
        this.emitter.emitHeading(
          sec.level || 2,
          sec.title || "Section",
          sec.anchor
        );

        for (const node of sec.nodes || []) {
          // 段落（含行内数学/引文替换 + 清噪 + 近邻去重）
          if (this._isParagraph(node)) {
            const text = this._renderParagraphWithMathAndCites(node, citeMap);
            this._emitParagraphDedup(text);
            continue;
          }

          // 块级数学
          if (
            this._isDisplayMath(node) ||
            (node.tagName?.toLowerCase() === "math" &&
              (node.getAttribute("display") || "").toLowerCase() === "block")
          ) {
            const m = this.adapter.extractMath(node);
            if (m) this.emitter.emitMath(m);
            continue;
          }

          // 图（根据模式使用不同逻辑 - 原始完整逻辑）
          if (node.matches && node.matches("figure.figure")) {
            const fig = this.adapter.extractFigure(node);
            if (!fig) continue;

            if (fig.kind === "img") {
              if (mode === "links") {
                this.emitter.emitFigure({
                  kind: "img",
                  path: fig.src,
                  caption: fig.caption,
                });
              } else {
                const r = await this.assets.fetchRaster(fig.src);
                this.emitter.emitFigure({
                  kind: "img",
                  path: r.assetPath || r.path,
                  caption: fig.caption,
                });
              }
            } else if (fig.kind === "svg") {
              if (mode === "textbundle") {
                let svgEl = null;
                try {
                  if (fig.inlineSvg) {
                    svgEl = new DOMParser().parseFromString(
                      fig.inlineSvg,
                      "image/svg+xml"
                    ).documentElement;
                  } else if (node.querySelector) {
                    svgEl = node.querySelector("svg");
                  }
                } catch {}
                const r = await this.assets.registerSvg(
                  svgEl,
                  fig.id ? `${fig.id}.svg` : "figure.svg"
                );
                this.emitter.emitFigure({
                  kind: "svg",
                  path: r.assetPath,
                  caption: fig.caption,
                });
              } else {
                this.emitter.emitFigure({
                  kind: "svg",
                  inlineSvg: fig.inlineSvg,
                  caption: fig.caption,
                });
              }
            }
            continue;
          }

          // 表
          if (node.matches && node.matches("div.tables")) {
            const t = this.adapter.extractTable(node);
            this.emitter.emitTable(t);
            continue;
          }

          // 列表（转行内数学与引文，再近邻去重逐行落）
          if (node.matches && node.matches("ul, ol")) {
            const lines = this._renderList(node, citeMap, 0);
            for (const l of lines) this._emitParagraphDedup(l);
            continue;
          }

          // 代码块
          if (
            node.matches &&
            node.matches("pre.ltx_verbatim, .ltx_listing pre")
          ) {
            const code = (node.textContent || "").replace(/\s+$/, "");
            this.emitter.emitParagraph("```\n" + code + "\n```");
            continue;
          }

          // 正文脚注
          if (node.matches && node.matches("div.ltx_note.ltx_role_footnote")) {
            const f = this.adapter.extractFootnote(node);
            if (f) footF.push(f);
            continue;
          }

          // 兜底：当作段落处理并去重
          const fallback = (node.textContent || "").trim();
          if (fallback) this._emitParagraphDedup(fallback);
        }
      }

      // 生成参考脚注（R*，直接写全参考条目文本+DOI/URL）
      const footR = this._makeReferenceFootnotes(bib, this._cited);

      // 合并 F*/R* 脚注并按 key 去重
      const footMap = new Map();
      for (const f of [...(footF || []), ...(footR || [])]) {
        if (f?.key && f?.content && !footMap.has(f.key))
          footMap.set(f.key, f.content);
      }
      this.emitter.emitFootnotes(
        [...footMap].map(([key, content]) => ({ key, content }))
      );

      // 文末参考
      this.emitter.emitReferences(bib);

      // 生成最终Markdown
      return this.emitter.compose();
    }

    /**
     * 清除缓存
     */
    _invalidateCache() {
      this._cache = {
        meta: null,
        bibliography: null,
        citationMap: null,
        sections: null,
        baseMarkdown: null,
        lastPageHash: null,
        assetsSnapshot: null,
      };
      Log.info("Cache invalidated");
    }

    /**
     * 端到端生成 Markdown
     * @param {'links'|'base64'|'textbundle'} mode
     */
    async runPipeline(mode = "links") {
      this._prepareRun(mode, true); // 改为每次运行清除缓存，确保解析最新 DOM（作者/机构等）
      Log.info("Pipeline start:", mode);

      // 检查缓存有效性
      const currentPageHash = this._getPageHash();
      const cacheValid =
        this._cache.lastPageHash === currentPageHash &&
        this._cache.baseMarkdown;

      if (!cacheValid) {
        Log.info("Cache invalid or missing, rebuilding base cache...");
        await this._buildBaseCacheWithOriginalLogic();
        this._cache.lastPageHash = currentPageHash;
      } else {
        Log.info("Using cached data for faster processing...");
        // 恢复缓存的状态
        this._lastMeta = this._cache.meta;
      }

      // 根据模式处理差异
      const result = await this._processForModeWithOriginalLogic(mode);
      Log.info(
        "Pipeline completed. Generated markdown:",
        result.length,
        "characters"
      );
      return result;
    }

    // —— 导出 —— //

    async exportLinks() {
      const md = await this.runPipeline("links");
      await (typeof GM_setClipboard === "function"
        ? GM_setClipboard(md, { type: "text" })
        : Promise.resolve());
      this._downloadText(md, this._suggestFileName("links", "md")); // ★ 改名
      alert("已生成 Links 版 Markdown。");
    }

    async exportBase64() {
      const md = await this.runPipeline("base64");
      const out = await this.exporter.asMarkdownBase64(md, this.assets.list());
      this._downloadText(out, this._suggestFileName("base64", "md")); // ★ 改名
      alert("已生成 Base64 版 Markdown。");
    }

    async exportTextBundle() {
      const md = await this.runPipeline("textbundle");
      const tb = await this.exporter.asTextBundle(md, this.assets.list());
      this._downloadBlob(
        tb.blob,
        this._suggestFileName("textbundle", "textbundle")
      ); // ★ 统一命名
      alert("已生成 TextBundle。");
    }

    // —— 节点类型判断 —— //
    _isParagraph(n) {
      return (
        n.matches &&
        (
          // ScienceDirect paragraphs collected in walkSections()
          n.matches("div[id^='p']") ||
          // Legacy LaTeXML paragraphs (arxiv-like)
          n.matches("div.ltx_para > p.ltx_p") ||
          n.matches("p.ltx_p")
        )
      );
    }
    _isDisplayMath(n) {
      if (!n?.matches) return false;
      if (n.matches("table.ltx_equation")) return true;
      // 只有“不在 table.ltx_equation 里的 block math”才算一条
      if (
        n.matches('math[display="block"]') &&
        !n.closest("table.ltx_equation")
      )
        return true;
      return false;
    }

    // 追加：清理噪声文本
    _cleanNoiseText(s) {
      return (
        String(s || "")
          // 去掉页面的提示垃圾
          .replace(/\bReport issue for preceding element\b/gi, "")
          .replace(/\bSee\s*\d+(\.\d+)?\b/gi, "")
          // 清理下载链接文本
          .replace(/Download:\s*Download\s+[\w\s().-]+/gi, "")
          .replace(/Download\s+[\w\s().-]+image\s*\(\d+KB?\)/gi, "")
          // 折叠多余空白
          .replace(/[ \t]*\n[ \t]*/g, " ")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\u00A0/g, " ")
          .trim()
      );
    }

    // —— 行内数学 + 引文处理 —— //
    _renderParagraphWithMathAndCites(pNode, citeMap) {
      const clone = pNode.cloneNode(true);

        // 行内 <math> → $...$
        for (const m of Array.from(clone.querySelectorAll("math"))) {
          const isDisplay =
            (m.getAttribute("display") || "").toLowerCase() === "block";
          if (isDisplay) continue;
          const tex = this.adapter.extractMath(m)?.tex || "";
          m.replaceWith(document.createTextNode(tex ? `$${tex}$` : ""));
        }

        // 处理 MathJax 渲染（非 OA）：将 SVG/Assistive MathML 转为 $...$ / $$...$$
        for (const svg of Array.from(clone.querySelectorAll('span.MathJax_SVG'))) {
          let tex = "";
          const mml = svg.getAttribute('data-mathml');
          if (mml) {
            try {
              const doc = new DOMParser().parseFromString(mml, 'application/xml');
              const mathEl = doc.querySelector('math');
              if (mathEl) tex = this.adapter._extractTeX(mathEl) || "";
            } catch {}
          }
          if (!tex) {
            const assist = svg.parentElement?.querySelector('span.MJX_Assistive_MathML math');
            if (assist) tex = this.adapter._extractTeX(assist) || "";
          }
          if (tex) {
            const isDisplay = !!(svg.closest('.display') || svg.closest('span.display'));
            const node = document.createTextNode(isDisplay ? `$$${tex}$$` : `$${tex}$`);
            svg.replaceWith(node);
          }
        }
      // 清理 MathJax 注入的辅助节点，避免脚本内 MathML 文本泄漏到最终文本
      for (const junk of Array.from(
        clone.querySelectorAll(
          'script[type="math/mml"], span.MathJax_SVG, span.MJX_Assistive_MathML, span.MathJax_Preview'
        )
      )) {
        junk.remove();
      }

      // 文中引文 → [^R{n}] - 智能处理引用组
      this._processCitations(clone, citeMap);

      // 其它链接变纯文本
      for (const a of Array.from(clone.querySelectorAll("a"))) {
        a.replaceWith(document.createTextNode(a.textContent || ""));
      }

      return this._cleanNoiseText(clone.textContent || "");
    }

    // —— 列表渲染（简单 Markdown） —— //
    _renderList(listNode, citeMap, depth = 0) {
      const lines = [];
      const ordered = listNode.tagName.toLowerCase() === "ol";
      let idx = 1;
      for (const li of Array.from(listNode.children)) {
        if (li.tagName?.toLowerCase() !== "li") continue;
        // 把 li 中的块拆解：优先段落/内联
        const parts = [];
        // 先将行内数学和引用处理到文本
        const text = this._renderParagraphWithMathAndCites(li, citeMap);
        if (text) parts.push(text);

        const bullet = ordered ? `${idx}. ` : `- `;
        const indent = "  ".repeat(depth);
        const first = `${indent}${bullet}${parts.shift() || ""}`.trimEnd();
        if (first) lines.push(first);

        // 嵌套列表
        const sublists = Array.from(li.children).filter((c) =>
          /^(ul|ol)$/i.test(c.tagName)
        );
        for (const sub of sublists) {
          lines.push(...this._renderList(sub, citeMap, depth + 1));
        }
        idx++;
      }
      return lines;
    }

    // 追加：近邻去重（保留最近 50 段的指纹）
    _emitParagraphDedup(text) {
      if (!this._paraSeen) {
        this._paraSeen = new Set();
        this._paraQueue = [];
      }
      const clean = this._cleanNoiseText(text);
      if (!clean) return;
      const key = clean.toLowerCase();
      if (this._paraSeen.has(key)) return;
      // 推入 emitter
      this.emitter.emitParagraph(clean);
      // 记录指纹
      this._paraSeen.add(key);
      this._paraQueue.push(key);
      if (this._paraQueue.length > 50) {
        const old = this._paraQueue.shift();
        this._paraSeen.delete(old);
      }
    }

    // —— 参考文献脚注 R* 生成 —— //
    _makeReferenceFootnotes(bibItems, citedSet) {
      const out = [];
      const nums = Array.from(citedSet || []).sort((a, b) => a - b);
      const lookup = new Map((bibItems || []).map((b) => [b.num, b]));
      for (const n of nums) {
        const it = lookup.get(n);
        if (!it) continue;
        // 直接放整条参考文本 + DOI/URL（若未包含，使用 markdown 链接格式）
        let content = it.text || "";
        if (it.doi && !content.includes(it.doi)) {
          const doiUrl = it.doi.startsWith('http') ? it.doi : `https://doi.org/${it.doi}`;
          content += ` [DOI](${doiUrl})`;
        }
        if (it.url && !content.includes(it.url)) content += ` [URL](${it.url})`;
        out.push({ key: `R${n}`, content: content.trim() });
      }
      return out;
    }

    // —— 工具 —— //
    _normalizeBibHref(href) {
      const m = String(href || "").match(/#(bib\d{1,4})\b/);
      return m ? `#${m[1]}` : href;
    }
    _parseBibNumber(s) {
      const m = String(s || "").match(/#?bib(\d{1,4})\b/);
      return m ? parseInt(m[1], 10) : null;
    }
    
    /**
     * 智能处理引用组 - 支持 [1,2] 和 [[1], [2], [3]] 格式
     * @param {Element} container - 包含引用的容器元素
     * @param {Map} citeMap - 引用映射
     */
    _processCitations(container, citeMap) {
      // 支持多模板的引文锚：#bibN（OA）、#b0005（非OA）、以及 reference 型锚
      const citations = Array.from(
        container.querySelectorAll('a[href*="#bib"], a[href^="#b"], a[data-xocs-content-type="reference"]')
      );
      if (citations.length === 0) return;

      // 按文档顺序处理每个引用
      citations.forEach(citation => {
        const href = citation.getAttribute("href") || "";
        const key = this._normalizeBibHref(href);
        let n = citeMap.get(key) ?? this._parseBibNumber(href);
        if (n == null) {
          // 兜底：从锚文本中提取编号，如 "[19]" / "19"
          const t = (citation.textContent || "").trim();
          const m = t.match(/\[(\d{1,4})\]/) || t.match(/\b(\d{1,4})\b/);
          if (m) n = parseInt(m[1] || m[0], 10);
        }
        
        if (n != null) {
          this._cited.add(n);
          
          // 检查引用的上下文，智能处理方括号
          const citationText = citation.textContent || "";
          let footnoteText;
          
          // 如果引用文本已经包含方括号 [43]，直接使用脚注格式
          if (citationText.includes('[') && citationText.includes(']')) {
            footnoteText = `[^R${n}]`;
          } else {
            // 如果是纯数字，也使用脚注格式
            footnoteText = `[^R${n}]`;
          }
          
          citation.replaceWith(document.createTextNode(footnoteText));
        } else {
          citation.replaceWith(document.createTextNode(citation.textContent || ""));
        }
      });

      // 后处理：清理多余的方括号和格式化引用组
      this._cleanupCitationGroups(container);
    }

    /**
     * 清理引用组格式，处理 [41,42] 和 [[43], [44], [45]] 等情况
     * @param {Element} container - 容器元素
     */
    _cleanupCitationGroups(container) {
      // 为了避免跨标签断裂，先基于纯文本进行归一化
      let content = container.textContent || '';

      // 1) 扁平化任意长度的嵌套方括号组：
      //    [[^R19], [^R20], [^R21], [^R22]] → [^R19][^R20][^R21][^R22]
      content = content.replace(/\[\s*((?:\[\^R\d+\]\s*(?:,\s*)?)*)\s*\]/g, (m, inner) => {
        const items = inner.match(/\[\^R\d+\]/g);
        return items ? items.join('') : m;
      });

      // 2) 单层方括号中逗号分隔的多个：
      //    [^R41, ^R42, ^R43] → [^R41][^R42][^R43]
      content = content.replace(/\[\s*(?:\^R\d+\s*(?:,\s*)?)+\s*\]/g, (m) => {
        const items = m.match(/\^R\d+/g);
        return items ? items.map((x) => `[${x}]`).join('') : m;
      });

      // 3) 移除相邻脚注间的逗号：[^R19], [^R20] → [^R19][^R20]
      while (/(\[\^R\d+\])\s*,\s*(?=\[\^R\d+\])/.test(content)) {
        content = content.replace(/(\[\^R\d+\])\s*,\s*(?=\[\^R\d+\])/g, '$1');
      }

      // 4) 清理双层包裹：[[^Rn]] → [^Rn]
      content = content.replace(/\[\s*(\[\^R\d+\])\s*\]/g, '$1');

      // 5) 规范化空白
      content = content.replace(/\s{2,}/g, ' ');

      // 用纯文本回写（不保留标签，段落渲染返回的也是纯文本）
      container.textContent = content;
    }
    
    _mergeSoftWraps(s) {
      return String(s || "")
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\u00A0/g, " ")
        .trim();
    }

    // —— 文件下载 —— //
    _suggestFileName(tag, ext = "md") {
      const { id } = U.parseScienceDirectIdVersion();
      const rawTitle = this._lastMeta?.title || document.title || "untitled";

      const safeId = String(id || "unknown").replace(/[^\w.-]+/g, "_");

      const safeTitle =
        String(rawTitle)
          .normalize("NFKC") // 统一宽度形态
          .replace(/\s+/g, "_") // 空格→下划线
          .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "") // 移除 Windows 不允许字符 & 控制符
          .replace(/\.+$/g, "") // 去掉结尾的点（Windows 不允许）
          .replace(/_{2,}/g, "_") // 合并多下划线
          .replace(/^_+|_+$/g, "") // 去掉首尾下划线
          .slice(0, 120) || // 控长度，避免过长文件名
        "untitled";

      const base = `sciencedirect_${safeId}_${safeTitle}_${tag}`;
      return ext ? `${base}.${ext}` : base;
    }

    _downloadText(text, filename) {
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      this._downloadBlob(blob, filename);
    }
    _downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 0);
    }
  }
  // 8) UI（悬浮面板 · 懒加载预览）
  // -----------------------------
  const UI = {
    mount(controller) {
      const Z = (typeof Config !== "undefined" && Config.UI?.zIndex) || 999999;
      const side =
        (typeof Config !== "undefined" && Config.UI?.position) || "right";

      GM_addStyle?.(`
        :root {
          --ax-bg: #ffffff; --ax-text: #111827; --ax-muted: #6b7280;
          --ax-border: #e5e7eb; --ax-panel: rgba(255,255,255,0.96);
          --ax-accent: #eb6500; --ax-accent-600: #cc5500; --ax-shadow: 0 12px 32px rgba(0,0,0,.15);
        }
        @media (prefers-color-scheme: dark) {
          :root { --ax-bg:#0f1115; --ax-text:#e5e7eb; --ax-muted:#9ca3af; --ax-border:#30363d;
                  --ax-panel: rgba(17,17,17,.92); --ax-accent:#ff7a1a; --ax-accent-600:#eb6500; --ax-shadow:0 16px 40px rgba(0,0,0,.4); }
        }
        .sciencedirect-md-panel {
          position: fixed; ${side === "right" ? "right: 16px;" : "left: 16px;"}
          bottom: 16px; z-index: ${Z};
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans CJK SC";
          background: var(--ax-panel); color: var(--ax-text);
          border: 1px solid var(--ax-border); border-radius: 12px;
          padding: 10px 10px; box-shadow: var(--ax-shadow);
          backdrop-filter: saturate(1.1) blur(6px);
          user-select: none;
        }
        .sciencedirect-md-panel__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px 0}
        .sciencedirect-md-panel__title{margin:0;font-size:13px;letter-spacing:.2px;font-weight:700;display:inline-flex;align-items:center;gap:6px}
        .sciencedirect-md-badge{display:inline-block;padding:2px 6px;font-size:11px;font-weight:700;color:#fff;background:var(--ax-accent);border-radius:999px}
        .sciencedirect-md-panel__drag{cursor:grab;opacity:.9;font-size:11px;color:var(--ax-muted)}
        .sciencedirect-md-panel__drag:active{cursor:grabbing}
        .sciencedirect-md-panel__btns{display:flex;flex-wrap:wrap;gap:6px}
        .sciencedirect-md-btn{margin:0;padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:var(--ax-accent);color:#fff;font-weight:700;font-size:12px;box-shadow:0 1px 0 rgba(0,0,0,.08)}
        .sciencedirect-md-btn:hover{background:var(--ax-accent-600)}
        .sciencedirect-md-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}
        .sciencedirect-md-btn--secondary{background:transparent;color:var(--ax-text);border:1px solid var(--ax-border)}
        .sciencedirect-md-btn--secondary:hover{background:rgba(0,0,0,.05)}
        .sciencedirect-md-btn--ghost{background:transparent;color:var(--ax-muted)}
        .sciencedirect-md-btn--ghost:hover{color:var(--ax-text)}
        .sciencedirect-md-hide{display:none!important}
  
        /* Debug Log Panel */
        .sciencedirect-md-log{margin-top:8px;border:1px solid var(--ax-border);border-radius:8px;background:rgba(0,0,0,.02)}
        .sciencedirect-md-log__header{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid var(--ax-border);background:rgba(0,0,0,.03)}
        .sciencedirect-md-log__title{font-size:11px;font-weight:700;color:var(--ax-muted)}
        .sciencedirect-md-log__actions{display:flex;gap:4px}
        .sciencedirect-md-log__btn{padding:2px 6px;font-size:10px;border:0;border-radius:4px;cursor:pointer;background:transparent;color:var(--ax-muted);font-weight:500}
        .sciencedirect-md-log__btn:hover{color:var(--ax-text);background:rgba(0,0,0,.05)}
        .sciencedirect-md-log__content{height:120px;overflow-y:auto;padding:6px 8px;font-family:ui-monospace,SFMono-Regular,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:10px;line-height:1.3;white-space:pre-wrap;word-break:break-word;color:var(--ax-text);background:#fff0}
        @media (prefers-color-scheme: dark){.sciencedirect-md-log{background:rgba(255,255,255,.02)}.sciencedirect-md-log__header{background:rgba(255,255,255,.03)}.sciencedirect-md-log__content{background:rgba(0,0,0,.1)}}
  
        /* Footer */
        .sciencedirect-md-footer{margin-top:8px;padding-top:6px;border-top:1px solid var(--ax-border);text-align:center;font-size:10px;color:var(--ax-muted)}
        .sciencedirect-md-footer a{color:var(--ax-accent);text-decoration:none}
        .sciencedirect-md-footer a:hover{text-decoration:underline}
  
        /* 预览层（懒加载后才注入 DOM） */
        .sciencedirect-md-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:${
          Z + 1
        };display:none}
        .sciencedirect-md-modal{position:fixed;inset:5% 8%;background:var(--ax-bg);color:var(--ax-text);border:1px solid var(--ax-border);border-radius:12px;box-shadow:var(--ax-shadow);display:none;z-index:${
          Z + 2
        };overflow:hidden;display:flex;flex-direction:column}
        .sciencedirect-md-modal__bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ax-border)}
        .sciencedirect-md-modal__title{font-size:13px;font-weight:700}
        .sciencedirect-md-modal__tools{display:flex;gap:6px;align-items:center}
        .sciencedirect-md-modal__select{font-size:12px;padding:4px 6px}
        .sciencedirect-md-modal__body{flex:1;overflow:auto;padding:12px;background:linear-gradient(180deg,rgba(0,0,0,.02),transparent 60%)}
        .sciencedirect-md-modal__pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Microsoft Yahei Mono",monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.45;padding:12px;border:1px dashed var(--ax-border);border-radius:8px;background:#fff0}
        @media (prefers-color-scheme: dark){.sciencedirect-md-modal__pre{background:rgba(255,255,255,.02)}}
      `);

      // 面板
      const panel = document.createElement("div");
      panel.className = "sciencedirect-md-panel";
      panel.innerHTML = `
        <div class="sciencedirect-md-panel__head">
          <div class="sciencedirect-md-panel__title">
            <span class="sciencedirect-md-badge">ScienceDirect</span>
            <span>Markdown 导出</span>
          </div>
          <button class="sciencedirect-md-btn sciencedirect-md-btn--ghost" data-action="toggle">折叠</button>
          <span class="sciencedirect-md-panel__drag" title="拖拽移动位置">⇕</span>
        </div>
        <div class="sciencedirect-md-panel__btns" data-role="buttons">
          <button class="sciencedirect-md-btn" data-action="preview" data-mode="links">预览 · Links</button>
          <button class="sciencedirect-md-btn sciencedirect-md-btn--secondary" data-action="preview" data-mode="base64">预览 · Base64</button>
          <button class="sciencedirect-md-btn" data-action="links">导出 · 链接</button>
          <button class="sciencedirect-md-btn" data-action="base64">导出 · Base64</button>
          <button class="sciencedirect-md-btn sciencedirect-md-btn--secondary" data-action="textbundle">导出 · TextBundle</button>
          <button class="sciencedirect-md-btn sciencedirect-md-btn--ghost" data-action="debug-log">调试日志</button>
        </div>
        <div class="sciencedirect-md-log sciencedirect-md-hide" data-role="debug-log">
          <div class="sciencedirect-md-log__header">
            <span class="sciencedirect-md-log__title">调试日志</span>
            <div class="sciencedirect-md-log__actions">
              <button class="sciencedirect-md-log__btn" data-action="clear-log">清空</button>
              <button class="sciencedirect-md-log__btn" data-action="copy-log">复制</button>
            </div>
          </div>
          <div class="sciencedirect-md-log__content"></div>
        </div>
        <div class="sciencedirect-md-footer">
          © Qi Deng - <a href="https://github.com/nerdneilsfield/neils-monkey-scripts/" target="_blank">GitHub</a>
        </div>
      `;
      document.body.appendChild(panel);

      // 折叠
      const btns = panel.querySelector('[data-role="buttons"]');
      panel
        .querySelector('[data-action="toggle"]')
        ?.addEventListener("click", () => {
          btns.classList.toggle("sciencedirect-md-hide");
        });

      // 按钮事件（预览为懒加载）
      panel.addEventListener("click", async (e) => {
        const btn = e.target;
        if (!(btn instanceof HTMLButtonElement)) return;
        const act = btn.getAttribute("data-action");
        try {
          if (act === "links") return controller.exportLinks();
          if (act === "base64") return controller.exportBase64();
          if (act === "textbundle") return controller.exportTextBundle();
          if (act === "preview") {
            const mode = btn.getAttribute("data-mode") || "links";
            const md = await UI._genMarkdownForPreview(controller, mode);
            const { overlay, modal } = UI._ensurePreview(); // ★ 懒加载
            UI._openPreview(modal, overlay, md, mode, controller);
          }
          if (act === "debug-log") {
            const logPanel = panel.querySelector('[data-role="debug-log"]');
            logPanel.classList.toggle("sciencedirect-md-hide");
            if (!logPanel.classList.contains("sciencedirect-md-hide")) {
              Log._updateUI(); // Update content when showing
            }
          }
          if (act === "clear-log") {
            Log.clear();
          }
          if (act === "copy-log") {
            Log.copy();
          }
        } catch (err) {
          (typeof Log !== "undefined" ? Log : console).error(err);
          alert("执行失败：" + (err?.message || err));
        }
      });

      // 拖拽与位置持久化
      const dragHandle = panel.querySelector(".sciencedirect-md-panel__drag");
      let dragging = false,
        sx = 0,
        sy = 0,
        startRect = null;
      const saved = UI._loadPos();
      if (saved) {
        panel.style.left = saved.left != null ? `${saved.left}px` : "";
        panel.style.right = saved.right != null ? `${saved.right}px` : "";
        panel.style.top = saved.top != null ? `${saved.top}px` : "";
        panel.style.bottom = saved.bottom != null ? `${saved.bottom}px` : "";
      }
      const onMove = (ev) => {
        if (!dragging) return;
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        let left = startRect.left + dx;
        let top = startRect.top + dy;
        left = Math.max(
          8,
          Math.min(window.innerWidth - startRect.width - 8, left)
        );
        top = Math.max(
          8,
          Math.min(window.innerHeight - startRect.height - 8, top)
        );
        panel.style.left = `${Math.round(left)}px`;
        panel.style.right = "";
        panel.style.top = `${Math.round(top)}px`;
        panel.style.bottom = "";
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        UI._savePos(panel);
      };
      dragHandle?.addEventListener("mousedown", (ev) => {
        dragging = true;
        sx = ev.clientX;
        sy = ev.clientY;
        startRect = panel.getBoundingClientRect();
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    },

    // 懒加载预览 DOM（只在点击预览时创建）
    _ensurePreview() {
      let overlay = document.querySelector(".sciencedirect-md-overlay");
      let modal = document.querySelector(".sciencedirect-md-modal");
      if (overlay && modal) return { overlay, modal };

      overlay = document.createElement("div");
      overlay.className = "sciencedirect-md-overlay";
      modal = document.createElement("div");
      modal.className = "sciencedirect-md-modal";
      modal.innerHTML = `
        <div class="sciencedirect-md-modal__bar">
          <div class="sciencedirect-md-modal__title">Markdown 预览</div>
          <div class="sciencedirect-md-modal__tools">
            <select class="sciencedirect-md-modal__select" data-role="mode">
              <option value="links" selected>Links</option>
              <option value="base64">Base64</option>
            </select>
            <button class="sciencedirect-md-btn sciencedirect-md-btn--secondary" data-action="copy">复制</button>
            <button class="sciencedirect-md-btn" data-action="download">下载 .md</button>
            <button class="sciencedirect-md-btn sciencedirect-md-btn--ghost" data-action="close">关闭</button>
          </div>
        </div>
        <div class="sciencedirect-md-modal__body">
          <pre class="sciencedirect-md-modal__pre" data-role="content">加载中...</pre>
        </div>
      `;
      document.body.appendChild(overlay);
      document.body.appendChild(modal);

      // 事件仅在首次创建时绑定
      overlay.addEventListener("click", () => UI._closePreview(modal, overlay));
      modal.addEventListener("click", async (e) => {
        const el = e.target;
        if (!(el instanceof HTMLButtonElement)) return;
        const act = el.getAttribute("data-action");
        if (act === "close") return UI._closePreview(modal, overlay);
        if (act === "copy") {
          const md =
            modal.querySelector('[data-role="content"]')?.textContent || "";
          if (typeof GM_setClipboard === "function")
            GM_setClipboard(md, { type: "text" });
          else if (navigator.clipboard?.writeText)
            await navigator.clipboard.writeText(md);
        }
        if (act === "download") {
          const md =
            modal.querySelector('[data-role="content"]')?.textContent || "";
          const a = document.createElement("a");
          a.href = URL.createObjectURL(
            new Blob([md], { type: "text/markdown;charset=utf-8" })
          );
          a.download = "sciencedirect_preview.md";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 0);
        }
      });
      modal
        .querySelector('[data-role="mode"]')
        ?.addEventListener("change", async (e) => {
          const mode = e.target.value;
          const md = await UI._genMarkdownForPreview(window.__SD_CTRL__, mode);
          const pre = modal.querySelector('[data-role="content"]');
          pre.textContent = md;
        });

      return { overlay, modal };
    },

    async _genMarkdownForPreview(controller, mode) {
      controller._prepareRun(mode, true); // 预览时也清除缓存，避免旧解析结果
      const md = await controller.runPipeline(mode);
      if (mode === "base64")
        return await controller.exporter.asMarkdownBase64(
          md,
          controller.assets.list()
        );
      return md;
    },

    _openPreview(modal, overlay, md, mode) {
      const select = modal.querySelector('[data-role="mode"]');
      const useMode = mode || "links";
      if (select) select.value = useMode;
      modal.querySelector('[data-role="content"]').textContent = md || "";
      overlay.style.display = "block";
      modal.style.display = "flex";
    },
    _closePreview(modal, overlay) {
      overlay.style.display = "none";
      modal.style.display = "none";
    },

    _savePos(panel) {
      const r = panel.getBoundingClientRect();
      localStorage.setItem(
        "axmd.panel.pos",
        JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })
      );
    },
    _loadPos() {
      try {
        return JSON.parse(localStorage.getItem("axmd.panel.pos") || "null");
      } catch {
        return null;
      }
    },
  };

  // -----------------------------
  // 9) Boot（不做任何预览调用）
  // -----------------------------
  function boot() {
    try {
      const ok = /\/science\/article\/pii\/[A-Z0-9]+/i.test(location.pathname);
      if (!ok) {
        (typeof Log !== "undefined" ? Log : console).warn(
          "[ScienceDirect → Markdown] 当前不在 ScienceDirect 文章页面，UI 不加载。"
        );
        return;
      }
      const ctrl = new Controller();
      // 供懒加载预览的 change 事件访问
      window.__SD_CTRL__ = ctrl; // 可选：若不喜欢全局可改闭包
      UI.mount(ctrl);
      (typeof Log !== "undefined" ? Log : console).info(
        `[${
          typeof Config !== "undefined" ? Config.APP_NAME : "ScienceDirect → Markdown"
        }] UI mounted`
      );
    } catch (err) {
      (typeof Log !== "undefined" ? Log : console).error("Boot error:", err);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
