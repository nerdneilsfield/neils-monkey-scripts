// ==UserScript==
// @name         IEEE Paper to Markdown Exporter (Enhanced)
// @namespace    http://tampermonkey.net/
// @version      2.0.4
// @description  Export IEEE papers to Markdown with complete metadata, TextBundle and Base64 formats
// @author       Qi Deng <dengqi935@gmail.com>
// @match        https://ieeexplore.ieee.org/abstract/document/*
// @match        https://ieeexplore.ieee.org/document/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/turndown/7.1.2/turndown.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      ieeexplore.ieee.org
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/ieee-markdown-exporter.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/ieee-markdown-exporter.user.js
// ==/UserScript==

(function () {
  "use strict";

  // 配置
  const CONFIG = {
    API_BASE: "https://ieeexplore.ieee.org/rest/document",
    BUTTON_CONTAINER_ID: "ieee-markdown-exporter-buttons",
    MAX_RETRY: 3,
    RETRY_DELAY: 1000,
    IMAGE_QUALITY: 0.95,
    DEBUG: true,
    IMG_CONCURRENCY: 4,
    FETCH_TIMEOUT_MS: 15000,
    ZIP_ENGINE: "auto", // 'auto' | 'jszip' | 'fflate'
    ZIP_TIMEOUT_MS: 25000, // JSZip 尝试时间；超时则切换到 fflate
    DEBUG: true,
    IMG_CONCURRENCY: 4,
    FETCH_TIMEOUT_MS: 15000,
    BASE64: {
      GIF_TO_PNG: true, // 开启 GIF → PNG/WebP
      TARGET: "png", // 'png' | 'webp' ；默认 png 最兼容
      WEBP_QUALITY: 0.92, // 仅对 webp 有效
      MAX_BYTES: 6_000_000, // dataURL 估算字节上限（~6MB）
      MAX_DIM: 2400, // 限制最长边；过大自动等比缩放
      MIN_DIM: 512, // 连续降采样的最小保护尺寸
      DOWNSCALE_STEP: 0.85, // 超限时每次缩放比例（连乘）
      FALLBACK_TO_LINK_IF_TOO_BIG: true, // 仍超限则保留原链接而非内嵌
    },
    TEXTBUNDLE: {
      GIF_TO_PNG: true,        // 开启：打包前将 GIF 转码
      TARGET: 'png',           // 'png' | 'webp'（webp 更小；看渲染器兼容）
      WEBP_QUALITY: 0.92,      // 仅对 webp 有效
      MAX_DIM: 2400,           // 最长边上限，超限等比缩放（控制 textpack 体积）
      MIN_DIM: 512,            // 连续降采样的最小保护尺寸
      DOWNSCALE_STEP: 0.85,     // 超限时逐步下采样比例
      ONLY_IF_SMALLER: false   // ← 新增：仅当更小才采用转码结果
    },
    // IEEE 品牌色彩
    COLORS: {
      primary: "#003B5C", // IEEE 深蓝色
      secondary: "#0066CC", // IEEE 浅蓝色
      accent: "#00A0DF", // IEEE 亮蓝色
      success: "#28A745",
      error: "#DC3545",
      warning: "#FFC107",
      light: "#F8F9FA",
    },
  };

  // 工具函数
  const Utils = {
    // 从全局变量获取元数据
    getMetadata() {
      if (
        typeof xplGlobal !== "undefined" &&
        xplGlobal.document &&
        xplGlobal.document.metadata
      ) {
        console.log("Found metadata in xplGlobal:", xplGlobal.document.metadata);
        return xplGlobal.document.metadata;
      }
      return null;
    },

    // 从 URL 或元数据提取文档 ID
    getDocumentId() {
      const metadata = this.getMetadata();
      if (metadata && metadata.articleNumber) {
        return metadata.articleNumber;
      }
      const match = window.location.pathname.match(/\/document\/(\d+)/);
      return match ? match[1] : null;
    },

    // 延迟函数
    delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // 安全的 fetch 请求
    async fetchWithRetry(url, retries = CONFIG.MAX_RETRY) {
      for (let i = 0; i < retries; i++) {
        try {
          const response = await fetch(url, {
            credentials: "include",
            headers: {
              Accept: "application/json, text/html",
              "Content-Type": "application/json",
              Referer: window.location.href,
            },
          });
          if (response.ok) {
            return response;
          }
        } catch (error) {
          console.error(`Fetch attempt ${i + 1} failed:`, error);
          if (i < retries - 1) {
            await this.delay(CONFIG.RETRY_DELAY * (i + 1));
          }
        }
      }
      throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
    },

    // 下载图片并转换为 base64
    async imageToBase64(url, includePrefix = true) {
      try {
        // 处理相对路径
        if (url.startsWith("/")) {
          url = `https://ieeexplore.ieee.org${url}`;
        }

        const response = await fetch(url, {
          credentials: "include",
          headers: {
            Referer: window.location.href,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const blob = await response.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (includePrefix) {
              resolve(reader.result);
            } else {
              // 移除 data:image/xxx;base64, 前缀
              const base64 = reader.result.split(",")[1];
              resolve(base64);
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (error) {
        console.error("Failed to convert image:", url, error);
        return null;
      }
    },

    // 格式化作者信息 - 每个作者一行，用 \n\n 分隔
    formatAuthors(authors) {
      if (!Array.isArray(authors) || authors.length === 0) return "";

      return authors
        .map((author) => {
          let authorStr =
            author.name ||
            `${author.firstName || ""} ${author.lastName || ""}`.trim();
          if (
            author.affiliation &&
            Array.isArray(author.affiliation) &&
            author.affiliation.length > 0
          ) {
            authorStr += `\n*${author.affiliation.join("; ")}*`;
          }
          if (author.orcid) {
            authorStr += `\n[ORCID: ${author.orcid}](https://orcid.org/${author.orcid})`;
          }
          return authorStr;
        })
        .join("\n\n");
    },

    // 清理文件名
    sanitizeFilename(filename) {
      return filename.replace(/[<>:"/\\|?*]/g, "_").substring(0, 200);
    },

    // 安全检查数组
    isValidArray(arr) {
      return Array.isArray(arr) && arr.length > 0;
    },

    async ensureFflate() {
      if (window.fflate && window.fflate.Zip) return true;
      return await new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.min.js";
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });
    },
  };

  // 数据获取类
  class DataFetcher {
    constructor(documentId) {
      this.documentId = documentId;
      this.metadata = Utils.getMetadata();
      this.data = {
        content: null,
        references: null,
        toc: null,
        metadata: this.metadata || {},
        citations: null,
        footnotes: [],
      };
    }

    async fetchAll() {
      console.log("Fetching document data...");

      try {
        // 并行获取所有数据
        const promises = [
          this.fetchContent(),
          this.fetchReferences(),
          this.fetchTOC(),
          this.fetchCitations(),
          this.fetchFootnotes(),
        ];

        await Promise.allSettled(promises);

        // 如果没有从全局变量获取到元数据，尝试从API获取
        if (!this.metadata) {
          console.log("Fetching metadata with documentId:", this.documentId);
          await this.fetchMetadata().catch((e) =>
            console.warn("Could not fetch metadata:", e)
          );
        }

        console.log("Data fetched successfully");
        return this.data;
      } catch (error) {
        console.error("Error fetching data:", error);
        throw error;
      }
    }

    // DataFetcher：新增方法
    async fetchFootnotes() {
      try {
        const url = `${CONFIG.API_BASE}/${this.documentId}/footnotes`;
        const resp = await Utils.fetchWithRetry(url);
        const json = await resp.json();
        // 兼容多种返回结构（你给的例子是 { footnote: [...] }）
        if (json && Array.isArray(json.footnote)) {
          this.data.footnotes = json.footnote;
        } else if (Array.isArray(json)) {
          this.data.footnotes = json;
        } else {
          this.data.footnotes = [];
        }
      } catch (e) {
        console.warn("Footnotes not available:", e);
        this.data.footnotes = [];
      }
    }

    async fetchContent() {
      try {
        const contentUrl = `${CONFIG.API_BASE}/${this.documentId}/`;
        console.log("Fetching content with URL:", contentUrl);
        const response = await Utils.fetchWithRetry(contentUrl);
        const html = await response.text();

        // 解析HTML获取文章内容
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        this.data.content = doc;
      } catch (error) {
        console.warn("Could not fetch content:", error);
        this.data.content = null;
      }
    }

    async fetchReferences() {
      try {
        const referencesUrl = `${CONFIG.API_BASE}/${this.documentId}/references?start=1&count=200`;
        console.log("Fetching references with URL:", referencesUrl);
        const response = await Utils.fetchWithRetry(referencesUrl);
        this.data.references = await response.json();
      } catch (error) {
        console.warn("Could not fetch references:", error);
        this.data.references = null;
      }
    }

    async fetchTOC() {
      try {
        const tocUrl = `${CONFIG.API_BASE}/${this.documentId}/toc`;
        console.log("Fetching TOC with URL:", tocUrl);
        const response = await Utils.fetchWithRetry(tocUrl);
        this.data.toc = await response.json();
      } catch (error) {
        console.warn("Could not fetch TOC:", error);
        this.data.toc = null;
      }
    }

    async fetchCitations() {
      try {
        const citationsUrl = `${CONFIG.API_BASE}/${this.documentId}/citations`;
        console.log("Fetching citations with URL:", citationsUrl);
        const response = await Utils.fetchWithRetry(citationsUrl);
        this.data.citations = await response.json();
      } catch (error) {
        console.warn("Citations not available:", error);
        this.data.citations = null;
      }
    }

    async fetchMetadata() {
      try {
        const metadataUrl = `${CONFIG.API_BASE}/${this.documentId}/metadata`;
        console.log("Fetching metadata with URL:", metadataUrl);
        const response = await Utils.fetchWithRetry(metadataUrl);
        const metadata = await response.json();
        console.log("Metadata:", metadata);
        this.data.metadata = { ...this.data.metadata, ...metadata };
      } catch (error) {
        console.warn("Could not fetch additional metadata:", error);
      }
    }
  }

  // IEEE 特定的 Markdown 转换器
  class IEEEMarkdownConverter {
    constructor(data) {
      this.data = data;
      this.images = [];
      this.citations = new Map();
      this.footnoteCounter = 1;
    }

    async convert() {
      console.log("Converting IEEE document to Markdown...");

      let markdown = "";

      // 添加元数据头部（包含abstract）
      markdown += this.generateHeader();

      console.log(`Markdown after header: ${markdown}`);

      // 添加关键词
      if (this.data.metadata && this.data.metadata.keywords) {
        markdown += this.generateKeywords();
      }

      // 添加目录
      if (this.data.toc && Utils.isValidArray(this.data.toc)) {
        markdown += this.generateTOC();
      }

      // 转换主内容 - 使用专门的IEEE处理方法
      if (this.data.content) {
        markdown += await this.convertIEEEContent();
      }

      markdown += this.generatePublisherFootnotes(); // 在 References 之前追加

      // 添加参考文献（编号列表格式，与arXiv/Springer一致）
      markdown += this.generateReferencesList();

      // 添加参考文献（作为脚注格式）
      markdown += this.generateFootnotes();

      // 添加引用信息
      if (this.data.citations) {
        markdown += this.generateCitations();
      }

      markdown = this.fixAlignedTagsBlocks(markdown);
      markdown = this.normalizeMathDelimiters(markdown);

      // ★ 新增：仅在数学环境内解码 HTML 实体（修复 &lt; &gt; &amp; 等）
      markdown = this.decodeEntitiesInsideMath(markdown);

      markdown = markdown.replace("\\$", "$");

      markdown = this.mergeSoftWraps(markdown);
      markdown = this.removeUnnecessaryBlankLines
        ? this.removeUnnecessaryBlankLines(markdown)
        : markdown;

      return markdown;
    }

    renderAbstract(raw) {
      try {
        // 把 meta.abstract 包进一个容器，用现有 processTextContent 解析公式/脚注/实体
        const doc = new DOMParser().parseFromString(`<div id="__abs__">${raw}</div>`, 'text/html');
        const html = doc.body.querySelector('#__abs__')?.innerHTML ?? String(raw);
        let md = this.processTextContent(html);
        // 只在数学环境内解码 &lt; &amp; 等实体，避免正文被误动
        md = this.decodeEntitiesInsideMath(md);
        return md;
      } catch {
        // 兜底：当纯文本走一遍轻解析
        return this.processTextContent(String(raw));
      }
    }

    // 更健壮的 HTML 实体解码：支持数值(十进制/十六进制)、常见命名实体、二次转义；NBSP→空格
    _decodeEntities(input) {
      if (!input) return '';
      let s = String(input);

      s = s.replace("eqno", "tag");
      s = s.replace("\\bb ", "\\mathbb ");
      s = s.replace("\\rm ", "\\mathrm ");
      s = s.replace("\\bf ", "\\mathbf ");
      s = s.replace("\\it ", "\\mathit ");
      s = s.replace("\\cal ", "\\mathcal ");
      s = s.replace("\\scr ", "\\mathscr ");
      s = s.replace("\\frak ", "\\mathfrak ");
      s = s.replace("\\sf ", "\\mathsf ");

      // 快速剪枝：没有 & 就直接返回
      if (s.indexOf('&') === -1) return s;

      // 1) 先解码数值实体（支持缺少分号的场景）
      const decNumRE = /&#(\d+);?/g;
      const hexNumRE = /&#x([0-9a-fA-F]+);?/g;
      s = s.replace(hexNumRE, (_, hex) => {
        const cp = parseInt(hex, 16);
        try { return String.fromCodePoint(cp); } catch { return _; }
      });
      s = s.replace(decNumRE, (_, num) => {
        const cp = parseInt(num, 10);
        try { return String.fromCodePoint(cp); } catch { return _; }
      });

      // 2) 命名实体的兜底表（Math/常见符号）
      const MAP = {
        lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
        nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
        le: '≤', ge: '≥', ne: '≠', plusmn: '±', pm: '±',
        times: '×', divide: '÷', minus: '−', middot: '·', bull: '•', hellip: '…',
        rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓',
        langle: '⟨', rangle: '⟩', laquo: '«', raquo: '»',
        prime: '′', Prime: '″',
        alpha: 'α', beta: 'β', gamma: 'γ', Gamma: 'Γ', delta: 'δ', Delta: 'Δ',
        epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', Theta: 'Θ', iota: 'ι', kappa: 'κ',
        lambda: 'λ', Lambda: 'Λ', mu: 'μ', nu: 'ν', xi: 'ξ', Xi: 'Ξ', pi: 'π', Pi: 'Π',
        rho: 'ρ', sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', Phi: 'Φ', chi: 'χ',
        psi: 'ψ', Psi: 'Ψ', omega: 'ω', Omega: 'Ω',
        reg: '®', copy: '©', trade: '™'
      };

      // 3) 先用 textarea 做一轮标准解码（能解大多数命名实体）
      const ta = document.createElement('textarea');

      // 可能存在“二次转义”（如 &amp;lt;），我们做最多两轮
      for (let i = 0; i < 2; i++) {
        ta.innerHTML = s;
        const once = ta.value;
        // 如果没有变化，就跳出循环，避免无意义重解码
        if (once === s) break;
        s = once;
      }

      // 4) 再用兜底表处理剩余的命名实体（含缺分号场景）
      s = s.replace(/&([a-zA-Z][a-zA-Z0-9]+);?/g, (m, name) => MAP[name] ?? m);

      // 5) 统一把 NBSP → 普通空格
      s = s.replace(/\u00A0/g, ' ');

      return s;
    }

    decodeEntitiesInsideMath(markdown) {
      // 先处理块级：\n$$\n ... \n$$\n
      const displayRE = /\n\$\$\n([\s\S]*?)\n\$\$\n/g;
      markdown = markdown.replace(displayRE, (_, body) => {
        const decoded = this._decodeEntities(body);
        return `\n\n\n$$\n${decoded}\n$$\n\n\n`;
      });

      // 再处理行内：$ ... $   （避免匹配 \$，用前缀捕获）
      const inlineRE = /(^|[^\\])\$([^\n$]+?)\$/g;
      markdown = markdown.replace(inlineRE, (m, pre, body) => {
        const decoded = this._decodeEntities(body.replace(/\s*\n\s*/g, ' '));
        return `${pre}$${decoded}$`;
      });

      return markdown;
    }

    // 用这个替换你原来的 mergeParagraphToOneLine
    mergeSoftWraps(markdown) {
      // 统一行结束符
      const lines = markdown.replace(/\r\n?/g, '\n').split('\n');

      const out = [];
      let buf = [];        // 收集“普通段落”的行
      let mode = null;     // 'code' | 'math'
      const codeFenceRE = /^(\s*)(```|~~~)/;
      const mathFenceRE = /^\s*\$\$\s*$/;
      const headingRE = /^\s{0,3}#{1,6}\s/;
      const hrRE = /^\s{0,3}(?:-|\*){3,}\s*$/;
      const blockquoteRE = /^\s{0,3}>\s/;
      const listItemRE = /^\s*(?:-|\*|\+|\d+\.)\s+/;
      const tableRowRE = /^\s*\|/;
      const tableSepRE = /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/;

      const flushBuf = () => {
        if (!buf.length) return;
        // 连接段落里的软换行：trim 每行再用空格拼
        // 你若要自动拼接连字符可启用下面一行（把行尾的 “con-” 去掉破折）
        // for (let i=0;i<buf.length-1;i++) buf[i] = buf[i].replace(/([A-Za-z])-\s*$/,'$1');
        const text = buf.map(s => s.trim()).join(' ').replace(/\s{2,}/g, ' ').trim();
        out.push(text);
        buf = [];
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 处于代码块
        if (mode === 'code') {
          out.push(line);
          if (codeFenceRE.test(line)) mode = null;
          continue;
        }
        // 处于数学块
        if (mode === 'math') {
          out.push(line);
          if (mathFenceRE.test(line)) mode = null;
          continue;
        }

        // 块开始：先把缓冲段落吐出
        if (codeFenceRE.test(line)) { flushBuf(); mode = 'code'; out.push(line); continue; }
        if (mathFenceRE.test(line)) { flushBuf(); mode = 'math'; out.push(line); continue; }

        // 这些结构行直接输出，不合并
        if (
          headingRE.test(line) || hrRE.test(line) || blockquoteRE.test(line) ||
          listItemRE.test(line) || tableRowRE.test(line) || tableSepRE.test(line)
        ) { flushBuf(); out.push(line); continue; }

        // 空行：结束一个段落
        if (line.trim() === '') { flushBuf(); out.push(''); continue; }

        // 普通文本：进入缓冲
        buf.push(line);
      }
      // 文件末尾还有段落
      flushBuf();

      // 折叠多余空行（最多两个）
      return out.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    removeUnnecessaryBlankLines(markdown) {
      // find text have a \n\n behind and a \n\n in end
      return markdown.replace(/\n{3,}/g, '\n\n');
    }

    fixAlignedTagsBlocks(markdown) {
      // 匹配 $$ ... \begin{aligned} ... \end{aligned} ... $$
      const rx = /\$\$\s*\\begin\{aligned\}([\s\S]*?)\\end\{aligned\}\s*\$\$/g;
      return markdown.replace(rx, (m, body) => {
        if (!/\\tag\{[^}]+\}/.test(body)) return m; // 没有 \tag 就不处理，保留 aligned

        // 按 \\ 切分每一行
        const lines = body
          .split(/\\\\\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
        // 去掉对齐用的 &（含多对齐点）。如有 \& 希少见，这里不特判
        const toBlock = (line) => {
          const cleaned = line.replace(/&/g, "").trim();
          return `\n\n$$\n${cleaned}\n$$\n\n`;
        };

        // 多段独立 display，保留行内的 \tag{...}
        const blocks = lines.map(toBlock).join("\n");
        return `\n\n${blocks}\n\n`;
      });
    }

    // 1) 新增方法：规范数学定界符
    normalizeMathDelimiters(markdown) {
      //   let out = markdown;
      //   // 将“单行” $$...$$ 视为行内并改为 $...$
      //   //   out = out.replace(/\$\$([^\n]+?)\$\$/g, (_, expr) => `$${expr.trim()}$`);
      // 将 \( ... \) 规范为行内 $
      markdown = markdown.replace(
        /\\\((.+?)\\\)/g,
        (_, expr) => `$${expr.trim()}$`
      );
      // 将 \[ ... \] 规范为块级 $$...$$（保留换行）
      markdown = markdown.replace(
        /\\\[(.+?)\\\]/gs,
        (_, expr) => `\n\n$$\n${expr.trim()}\n$$\n\n`
      );
      //   // 仅把“无换行”的 $$...$$ 误用改为 $...$（行间块不受影响）
      //   out = out.replace(/\$\$([^\n]+?)\$\$/g, (_, expr) => `$${expr.trim()}$`);

      //   // 去重：相邻重复的 $$ 块删除第二个
      //   out = out.replace(
      //     /\n\$\$\n([\s\S]*?)\n\$\$\n(\s*\n\$\$\n\1\n\$\$\n)+/g,
      //     (m, body) => `\n$$\n${body}\n$$\n`
      //   );
      //   // 清理 $ 两侧意外空格
      //   out = out.replace(/\$\s+/g, "$").replace(/\s+\$/g, "$");
      // 仅把“无换行”的 $$...$$ 视作误用并改为 $...$
      // markdown = markdown.replace(
      //   /\$\$([^\n]+?)\$\$/g,
      //   (_, expr) => `$${expr.trim()}$`
      // );

      // 可选：去掉紧邻的重复块级公式（有些页面会出现一份正文+一份“View Source”）
      // markdown = markdown.replace(
      //   /\n\$\$\n([\s\S]*?)\n\$\$\n(\s*\n\$\$\n\1\n\$\$\n)+/g,
      //   (_, body) => `\n\n$$\n${body}\n$$\n\n`
      // );

      // // 只把“无换行且不含 \tag”的 $$…$$ 视为行内误用
      // markdown = markdown.replace(/\$\$([^\n]+?)\$\$/g, (m, expr) => {
      //   return expr.includes("\\tag") ? m : `$${expr.trim()}$`;
      // });
      return markdown;
    }

    // 单独导出 /footnotes 的内容
    generatePublisherFootnotes() {
      const fns = Array.isArray(this.data.footnotes) ? this.data.footnotes : [];
      if (fns.length === 0) return "";

      // 数字排序（label/id 存在谁用谁）
      const items = [...fns].sort((a, b) => {
        const ax = parseFloat(a?.label ?? a?.id ?? 1);
        const bx = parseFloat(b?.label ?? b?.id ?? 1);
        if (Number.isNaN(ax) || Number.isNaN(bx)) return 0;
        return ax - bx;
      });

      let md = "\n## Footnotes\n\n";
      items.forEach((fn, i) => {
        const label = String(fn?.label ?? fn?.id ?? i + 1);
        const raw = fn?.text ?? "";
        // 即便 fixMojibake 意外不可用，也不会抛错
        const fixed = this.fixMojibake ? this.fixMojibake(raw) : raw;
        const text = this.processTextContent(fixed);
        md += `${label}. ${text}\n\n`;
      });
      return md;
    }

    fixMojibake(s) {
      if (!s) return "";
      try {
        // 将被当作 UTF-16 的 Latin-1 文本转换为正确的 UTF-8
        // 注：escape 在浏览器环境仍可用；Tampermonkey 里也可用
        return decodeURIComponent(escape(s));
      } catch (_) {
        return (s || "")
          .replace(/â€™/g, "’")
          .replace(/â€˜/g, "‘")
          .replace(/â€œ/g, "“")
          .replace(/â€\x9D/g, "”")
          .replace(/â€“/g, "–")
          .replace(/â€”/g, "—")
          .replace(/â€¦/g, "…")
          .replace(/Â/g, "");
      }
    }

    async convertIEEEContent() {
      if (!this.data.content) return "";

      //let markdown = '## Content\n\n';
      let markdown = "";

      // 查找IEEE文档的主要容器
      const bodyWrapper = this.data.content.querySelector("#BodyWrapper");
      const article = bodyWrapper?.querySelector("#article");

      if (!article) {
        console.warn("Could not find IEEE article structure");
        return markdown;
      }

      // 处理IEEE的section结构
      const sections = article.querySelectorAll(".section");

      for (const section of sections) {
        markdown += this.processSectionElement(section);
      }

      // 处理致谢部分（通常在sections外面）
      const acknowledgments = article.querySelector("h3");
      if (
        acknowledgments &&
        acknowledgments.textContent.includes("ACKNOWLEDGMENTS")
      ) {
        const ackContent = acknowledgments.nextElementSibling;
        if (ackContent && ackContent.tagName === "P") {
          markdown += `\n## ${acknowledgments.textContent.trim()}\n\n`;
          markdown += this.processTextContent(ackContent.innerHTML) + "\n\n";
        }
      }

      return markdown;
    }

    processSectionElement(section) {
      let sectionMarkdown = "";

      // 处理section标题
      const header = section.querySelector(".header.article-hdr");
      if (header) {
        const kicker = header.querySelector(".kicker");
        const h2 = header.querySelector("h2");

        if (h2) {
          let titleText = h2.textContent.trim();

          // 处理SECTION标记，合并到标题中
          if (kicker) {
            const kickerText = kicker.textContent.trim();
            if (kickerText && !titleText.includes(kickerText)) {
              titleText = `${kickerText} ${titleText}`;
            }
          }

          // 判断是主section还是子section
          if (section.classList.contains("section_2")) {
            sectionMarkdown += `\n### ${titleText}\n\n`;
          } else {
            sectionMarkdown += `\n## ${titleText}\n\n`;
          }
        }
      }

      // 处理section内容
      const contentElements = Array.from(section.children).filter(
        (child) => !child.classList.contains("header")
      );

      for (const element of contentElements) {
        if (element.classList.contains("section_2")) {
          // 递归处理子section
          sectionMarkdown += this.processSectionElement(element);
        } else {
          sectionMarkdown += this.processContentElement(element);
        }
      }

      return sectionMarkdown;
    }

    processContentElement(element) {
      let markdown = "";

      switch (element.tagName.toLowerCase()) {
        case "p":
          markdown += this.processParagraph(element);
          break;
        case "ul":
        case "ol":
          markdown += this.processList(element);
          break;
        case "div":
          if (element.classList.contains("figure")) {
            markdown += this.processFigure(element);
          } else if (element.classList.contains("section_2")) {
            markdown += this.processSectionElement(element);
          } else {
            // 处理其他div内容
            for (const child of element.children) {
              markdown += this.processContentElement(child);
            }
          }
          break;
        case "h3":
          markdown += `\n### ${element.textContent.trim()}\n\n`;
          break;
        case "h4":
          markdown += `\n#### ${element.textContent.trim()}\n\n`;
          break;
        case "table":
          markdown += this.processTable(element);
          break;
        case 'disp-formula':
          {
            const tex = element.querySelector('tex-math')?.textContent || '';
            const body = this._stripTeXDelims(tex, 'display');
            return `\n\n\n$$\n${body}\n$$\n\n\n`;
          }
        case 'inline-formula':
          {
            const tex = element.querySelector('tex-math')?.textContent || '';
            const body = this._stripTeXDelims(tex, 'inline');
            return `$${body}$`;
          }
        default:
          // 处理其他元素的文本内容
          if (element.textContent.trim()) {
            markdown += this.processTextContent(element.innerHTML) + "\n\n";
          }
      }

      return markdown;
    }

    processParagraph(p) {
      // 检查段落是否包含图片
      const figure = p.querySelector(".figure");
      if (figure) {
        return this.processFigure(figure);
      }

      // 处理普通段落
      const content = this.processTextContent(p.innerHTML);
      if (!content) return "";
      if (/\n\$\$\n/.test(content)) {
        return `\n${content}\n`; // 块级公式周围空行
      }
      return content ? content + "\n\n" : "";
    }

    processList(listElement) {
      let markdown = "\n";
      const items = listElement.querySelectorAll("li");
      const isOrdered = listElement.tagName.toLowerCase() === "ol";

      items.forEach((item, index) => {
        const bullet = isOrdered ? `${index + 1}. ` : "- ";
        const content = this.processTextContent(item.innerHTML);
        markdown += `${bullet}${content}\n`;
      });

      return markdown + "\n";
    }

    shortImageAlt(alt) {
      if (!alt) return "";
      alt = alt.replace(/\n{2,}/g, "\n\n").slice(0, 10);
      alt = alt.trim();
      while (alt[alt.length - 1] == "\n") {
        alt = alt.slice(0, alt.length - 1);
      }
      while (alt[0] == "\n") {
        alt = alt.slice(1);
      }

      if (alt.length > 20) {
        alt = alt.slice(0, 20) + "...";
      }

      return alt;
    }


    // 忽略：公式切片/小图标/双小图
    _shouldIgnoreImageUrl(u) {
      const s = (u || '').toLowerCase();
      return /eqinline/.test(s) || /icon\.support\.gif$/.test(s) || /-small-small\./.test(s);
    }

    // 规范化：相对 → 绝对；small → large
    _sanitizeImageHref(href) {
      let u = href || '';
      if (u.startsWith('/')) u = `https://ieeexplore.ieee.org${u}`;
      u = u.replace(/(\b|-)small(\b|-)/g, 'large');  // 尽量取大图
      return u;
    }

    // 在多个候选中挑“最佳”一张
    _selectBestFigureImage(urls) {
      const cand = (urls || [])
        .map(u => this._sanitizeImageHref(u))
        .filter(u => !!u && !this._shouldIgnoreImageUrl(u));

      // 1) 强偏好 fig-X-source-*（整幅图）
      let best = cand.find(u => /fig-\d+-source-/i.test(u));
      if (best) return best;

      // 2) 次选含 /fig- 或 -fig- 的
      best = cand.find(u => /\/fig[-_]/i.test(u) || /-fig[-_]/i.test(u));
      if (best) return best;

      if (typeof this.log === 'function') {
        this.log(`figure: candidates=${urls.length} selected=${best ? best.split('/').pop() : 'none'}`);
      }

      // 3) 最后退：第一张非忽略
      return cand[0] || null;
    }

    processFigure(figure) {
      let md = '';

      // 收集候选 URL（优先 a[href]，其次 img[src]）
      const urls = [];
      figure.querySelectorAll('.img-wrap').forEach(w => {
        const a = w.querySelector('a'); if (a && a.href) urls.push(a.href);
        const img = w.querySelector('img'); if (img && img.src) urls.push(img.src);
      });

      const best = this._selectBestFigureImage(urls);
      if (best) {
        const imageData = { src: best, alt: '', id: this.images.length + 1 };
        this.images.push(imageData);
        md += `\n![${imageData.alt || `Figure ${imageData.id}`}](${imageData.src})\n\n`;
      } else {
        // 取不到就只给图题并记一笔：不把“假图”写进 markdown
        if (typeof this.log === 'function') this.log('figure: skip image (eqinline or none)');
      }

      // 图题
      const cap = figure.querySelector('.figcaption');
      if (cap) {
        const title = cap.querySelector('.title')?.textContent?.trim() || '';
        const body = cap.querySelector('fig')?.textContent?.trim() || '';
        const text = [title, body].filter(Boolean).join(' ');
        if (text) md += `*${this.processTextContent(text)}*\n\n`;
      }
      return md;
    }

    processTable(tableEl) {
      // 优先用 thead；没有就用第一行当表头
      const hasThead = !!tableEl.querySelector("thead");
      const headerCells = hasThead
        ? Array.from(
          tableEl.querySelectorAll(
            "thead tr:last-child th, thead tr:last-child td"
          )
        )
        : Array.from((tableEl.querySelector("tr") || {}).children || []);
      if (!headerCells.length) return "";

      const header = headerCells.map((c) =>
        this.processTextContent(c.innerHTML)
      );
      let md = "\n";
      md += `| ${header.join(" | ")} |\n`;
      md += `| ${header.map(() => "---").join(" | ")} |\n`;

      // 收集数据行
      let bodyRows = Array.from(tableEl.querySelectorAll("tbody tr"));
      if (!bodyRows.length) {
        // 没有 <tbody>，那就全取，但跳过首行（已作表头）
        const all = Array.from(tableEl.querySelectorAll("tr"));
        bodyRows = all.slice(1);
      }

      for (const tr of bodyRows) {
        const cells = Array.from(tr.children).map((td) =>
          this.processTextContent(td.innerHTML)
        );
        if (cells.length) md += `| ${cells.join(" | ")} |\n`;
      }
      md += "\n";
      return md;
    }

    // 1) 新增：剥离已有 TeX 定界（避免双重 $$；inline 会压掉换行）
    _stripTeXDelims(latex, mode /* 'display' | 'inline' */) {
      let s = String(latex || '').trim();

      // 先剥 $$…$$（带空白）
      if (/^\s*\$\$[\s\S]*\$\$\s*$/.test(s)) {
        s = s.replace(/^\s*\$\$\s*/, '').replace(/\s*\$\$\s*$/, '');
      }
      // 再剥 \[...\] / \(...\) / 单 $...$
      s = s.replace(/^\s*\\\[\s*/, '').replace(/\s*\\\]\s*$/, '');
      s = s.replace(/^\s*\\\(\s*/, '').replace(/\s*\\\)\s*$/, '');
      if (/^\s*\$[^\$]*\$\s*$/.test(s)) {
        s = s.replace(/^\s*\$\s*/, '').replace(/\s*\$\s*$/, '');
      }

      // inline 模式去掉内部换行以免渲染器断行
      if (mode === 'inline') s = s.replace(/\s*\n\s*/g, ' ').trim();
      return s;
    }

    processTextContent(html) {
      if (!html) return "";
      let text = html;

      // (A) 先把隐藏的 tex2jax_ignore 整块移除，避免重复放出一份“纯 LaTeX 文本”
      text = text.replace(
        /<span[^>]*class="[^"]*\btex2jax_ignore\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
        ''
      );

      // (B) 参考文献链接 -> 脚注
      text = text.replace(
        /<a[^>]*ref-type="bibr"[^>]*anchor="([^"]*)"[^>]*>\[?(\d+)\]?<\/a>/gi,
        (_, anchor, number) => `[^${this.getOrCreateFootnote(anchor || `ref${number}`)}]`
      );

      // 脚注引用（与参考文献分开）
      text = text.replace(
        /<a[^>]*ref-type="fn"[^>]*anchor="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi,
        (_, id) => `[^${this.getOrCreateFootnote(id)}]`
      );

      // (C) 行间公式：只抽取 tex-math 的内容，剥定界后统一成块级 $$…$$
      text = text.replace(
        /<disp-formula[^>]*>[\s\S]*?<tex-math[^>]*>([\s\S]*?)<\/tex-math>[\s\S]*?<\/disp-formula>/gi,
        (_, latex) => {
          const body = this._stripTeXDelims(latex, 'display');
          return `\n\n\n$$\n${body}\n$$\n\n\n`;
        }
      );

      // (D) 行内公式：同理，统一成 $…$
      text = text.replace(
        /<inline-formula[^>]*>[\s\S]*?<tex-math[^>]*>([\s\S]*?)<\/tex-math>[\s\S]*?<\/inline-formula>/gi,
        (_, latex) => {
          const body = this._stripTeXDelims(latex, 'inline');
          return `$${body}$`;
        }
      );

      // (E) 其他页面内链与样式
      text = text.replace(/<a[^>]*ref-type="fig"[^>]*>(.*?)<\/a>/gi, "$1"); // 图引用保留文本
      text = text.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
      text = text.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");

      // (F) 噪音清理（先于去标签）
      text = text.replace(/\bView Source\b/gi, "");

      // (G) 去其他标签（到这一步，公式已被替换为纯文本 $$ 或 $ 包裹，不会被误删）
      text = text.replace(/<[^>]*>/g, "");

      // (H) 温和空白清理：保留换行，保护 $$ 块
      text = text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      // 注意：不要在这里做 “$$单行→$ 行内” 的归一化！
      // 把它放到 convert() 的最后一步统一做，避免二次碰撞。

      return text;
    }

    getOrCreateFootnote(refId) {
      if (!this.citations.has(refId)) {
        this.citations.set(refId, this.footnoteCounter++);
      }
      return this.citations.get(refId);
    }

    generateHeader() {
      console.log(`Generating header with title: ${this.data.metadata.title}`);
      console.log(`Generating header with abstract: ${this.data.metadata.abstract}`);
      const meta = this.data.metadata || {};
      let header = "";

      // 标题
      header += `# ${meta.title || meta.displayDocTitle || "Untitled Paper"
        }\n\n`;

      // 摘要放在作者信息之前
      if (meta.abstract) {
        header += "## Abstract\n\n";
        header += this.renderAbstract(meta.abstract) + "\n\n";
      }

      // 作者信息
      if (Utils.isValidArray(meta.authors)) {
        header += "## Authors\n\n";
        header += Utils.formatAuthors(meta.authors) + "\n\n";
      }

      // 出版信息
      header += "## Publication Information\n\n";

      const info = [];

      if (meta.publicationTitle) {
        info.push(`**Journal:** ${meta.publicationTitle}`);
      }

      if (meta.publicationYear) {
        info.push(`**Year:** ${meta.publicationYear}`);
      }

      if (meta.volume) {
        info.push(`**Volume:** ${meta.volume}`);
      }

      if (meta.issue) {
        info.push(`**Issue:** ${meta.issue}`);
      }

      if (meta.startPage && meta.endPage) {
        info.push(`**Pages:** ${meta.startPage}-${meta.endPage}`);
      }

      if (meta.doi) {
        info.push(`**DOI:** [${meta.doi}](https://doi.org/${meta.doi})`);
      }

      if (meta.articleNumber) {
        info.push(`**Article Number:** ${meta.articleNumber}`);
      }

      if (Utils.isValidArray(meta.issn)) {
        const issnList = meta.issn
          .map((i) => `${i.format}: ${i.value}`)
          .join(", ");
        info.push(`**ISSN:** ${issnList}`);
      }

      header += info.join("\n") + "\n\n";

      // 指标信息
      if (meta.metrics) {
        header += "## Metrics\n\n";
        const metrics = [];

        if (meta.metrics.citationCountPaper) {
          metrics.push(
            `**Paper Citations:** ${meta.metrics.citationCountPaper}`
          );
        }

        if (meta.metrics.citationCountPatent) {
          metrics.push(
            `**Patent Citations:** ${meta.metrics.citationCountPatent}`
          );
        }

        if (meta.metrics.totalDownloads) {
          metrics.push(`**Total Downloads:** ${meta.metrics.totalDownloads}`);
        }

        if (metrics.length > 0) {
          header += metrics.join("\n") + "\n\n";
        }
      }

      // 资助信息
      if (
        meta.fundingAgencies &&
        meta.fundingAgencies.fundingAgency &&
        Utils.isValidArray(meta.fundingAgencies.fundingAgency)
      ) {
        header += "## Funding\n\n";
        meta.fundingAgencies.fundingAgency.forEach((funding) => {
          header += `- ${funding.fundingName}`;
          if (funding.grantNumber) {
            header += ` (Grant: ${funding.grantNumber})`;
          }
          header += "\n";
        });
        header += "\n";
      }

      header += "---\n\n";

      return header;
    }

    generateKeywords() {
      let keywords = "## Keywords\n\n";
      const meta = this.data.metadata;

      if (Utils.isValidArray(meta.keywords)) {
        meta.keywords.forEach((kwGroup) => {
          if (Utils.isValidArray(kwGroup.kwd)) {
            keywords += `**${kwGroup.type}:** ${kwGroup.kwd.join(", ")}\n\n`;
          }
        });
      }

      return keywords;
    }

    generateTOC() {
      let toc = "## Table of Contents\n\n";

      toc = toc + "[TOC]\n\n";

      //             if (Utils.isValidArray(this.data.toc)) {
      //                 this.data.toc.forEach(item => {
      //                     const indent = '  '.repeat((item.part || 1) - 1);
      //                     const label = item.label ? `${item.label} ` : '';
      //                     toc += `${indent}- [${label}${item.title}](#${item.id || item.title.toLowerCase().replace(/\s+/g, '-')})\n`;
      //                 });
      //             }

      //             return toc + '\n';
    }

    generateFootnotes() {
      if (
        !this.data.references ||
        !this.data.references.references ||
        !Utils.isValidArray(this.data.references.references)
      ) {
        return "";
      }

      let footnotes = "\n## Reference Footnotes\n\n";

      // 创建引用ID到引用数据的映射
      const refMap = new Map();
      this.data.references.references.forEach((ref) => {
        // 尝试多种可能的ID格式
        const possibleIds = [
          `ref${ref.order}`,
          `${ref.order}`,
          ref.id,
          ref.refId,
        ].filter((id) => id !== undefined);

        possibleIds.forEach((id) => {
          refMap.set(id, ref);
        });
      });

      // 按脚注编号顺序生成参考文献
      const sortedCitations = Array.from(this.citations.entries()).sort(
        (a, b) => a[1] - b[1]
      );

      sortedCitations.forEach(([refId, footnoteNumber]) => {
        const ref = refMap.get(refId);
        if (ref) {
          footnotes += `[^${footnoteNumber}]: `;

          // 格式化参考文献文本
          let refText = ref.text || "";

          // 清理HTML标签
          refText = refText.replace(/<[^>]*>/g, "");

          footnotes += refText;

          // 添加链接
          if (ref.links) {
            if (ref.links.crossRefLink) {
              footnotes += ` [DOI](${ref.links.crossRefLink})`;
            } else if (ref.links.documentLink) {
              footnotes += ` [IEEE](https://ieeexplore.ieee.org${ref.links.documentLink})`;
            }
          }

          // 添加Google Scholar链接
          if (ref.googleScholarLink) {
            footnotes += ` [Google Scholar](${ref.googleScholarLink})`;
          }

          footnotes += "\n\n";
        }
      });

      // 添加未被引用的参考文献（如果有）
      if (refMap.size > this.citations.size) {
        footnotes += "\n### Additional References\n\n";

        this.data.references.references.forEach((ref) => {
          const possibleIds = [
            `ref${ref.order}`,
            `${ref.order}`,
            ref.id,
            ref.refId,
          ].filter((id) => id !== undefined);

          const isReferenced = possibleIds.some((id) => this.citations.has(id));

          if (!isReferenced) {
            footnotes += `${ref.order}. ${ref.text || ""}\n\n`;
          }
        });
      }

      return footnotes;
    }

    generateReferencesList() {
      if (
        !this.data.references ||
        !this.data.references.references ||
        !Utils.isValidArray(this.data.references.references)
      ) {
        return "";
      }

      let referencesList = "\n## References\n\n";

      // 按order排序生成编号列表格式的References
      const sortedReferences = [...this.data.references.references].sort(
        (a, b) => (a.order || 0) - (b.order || 0)
      );

      sortedReferences.forEach((ref) => {
        // 生成编号列表格式：[1] 作者, "标题", 期刊, 年份...
        let refText = ref.text || "";
        
        // 清理HTML标签
        refText = refText.replace(/<[^>]*>/g, "");
        
        referencesList += `[${ref.order}] ${refText}`;

        // 添加链接
        if (ref.links) {
          if (ref.links.crossRefLink) {
            referencesList += ` DOI: ${ref.links.crossRefLink}`;
          } else if (ref.links.documentLink) {
            referencesList += ` IEEE: https://ieeexplore.ieee.org${ref.links.documentLink}`;
          }
        }

        // 添加Google Scholar链接
        if (ref.googleScholarLink) {
          referencesList += ` [Google Scholar](${ref.googleScholarLink})`;
        }

        referencesList += "\n\n";
      });

      return referencesList;
    }

    generateCitations() {
      // 安全检查citations数据结构
      if (!this.data.citations) {
        return "";
      }

      let citations = "";

      // 检查不同可能的数据结构
      let citationsList = null;

      if (Utils.isValidArray(this.data.citations.paperCitations)) {
        citationsList = this.data.citations.paperCitations;
      } else if (Utils.isValidArray(this.data.citations)) {
        citationsList = this.data.citations;
      } else if (
        this.data.citations.citations &&
        Utils.isValidArray(this.data.citations.citations)
      ) {
        citationsList = this.data.citations.citations;
      }

      if (!citationsList) {
        console.warn("No valid citations array found");
        return "";
      }

      citations += "\n## Citing Papers\n\n";

      citationsList.forEach((citation, index) => {
        citations += `${index + 1}. `;

        if (Utils.isValidArray(citation.authors)) {
          citations += citation.authors.join(", ") + ". ";
        }

        if (citation.title) {
          citations += `"${citation.title}". `;
        }

        if (citation.publicationTitle) {
          citations += `*${citation.publicationTitle}*. `;
        }

        if (citation.year) {
          citations += `${citation.year}. `;
        }

        if (citation.links && citation.links.documentLink) {
          citations += `[Link](https://ieeexplore.ieee.org${citation.links.documentLink})`;
        }

        citations += "\n\n";
      });

      return citations;
    }
  }

  // TextBundle 生成器
  class TextBundleGenerator {
    constructor(markdown, images, metadata, onProgress, onLog) {
      this.markdown = markdown;
      this.images = images || [];
      this.metadata = metadata;
      this.zip = new JSZip();
      this.onProgress =
        typeof onProgress === "function" ? onProgress : () => { };
      this.onLog = typeof onLog === "function" ? onLog : () => { };
    }

    log(...args) {
      this.onLog(args.join(" "));
    }

    _time(tag) {
      if (!this._t0) this._t0 = {};
      this._t0[tag] = performance.now();
    }
    _timeEnd(tag) {
      if (this._t0 && this._t0[tag] != null) {
        const dt = (performance.now() - this._t0[tag]).toFixed(1);
        delete this._t0[tag];
        return dt;
      }
      return null;
    }

    async _mapLimit(arr, limit, iter) {
      const ret = [];
      let i = 0,
        active = 0,
        idx = 0;
      return await new Promise((resolve) => {
        const next = () => {
          while (active < limit && i < arr.length) {
            const cur = i++,
              myIndex = idx++;
            active++;
            Promise.resolve(iter(arr[myIndex], myIndex))
              .then((v) => (ret[myIndex] = v))
              .catch((e) => {
                this.log(`image#${myIndex} error: ${e}`);
                ret[myIndex] = null;
              })
              .finally(() => {
                active--;
                if (i >= arr.length && active === 0) resolve(ret);
                else next();
              });
          }
        };
        next();
      });
    }

    async _withTimeout(promise, ms, label = "op") {
      let timer;
      const t = new Promise((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`${label} timeout ${ms}ms`)),
          ms
        );
      });
      try {
        return await Promise.race([promise, t]);
      } finally {
        clearTimeout(timer);
      }
    }

    getExtFromType(type) {
      switch ((type || "").toLowerCase()) {
        case "image/png":
          return ".png";
        case "image/jpeg":
          return ".jpg";
        case "image/webp":
          return ".webp";
        case "image/gif":
          return ".gif";
        case "image/svg+xml":
          return ".svg";
        default:
          return ".bin";
      }
    }

    updateImagePathsWithMap(markdown, replacements) {
      let out = markdown;
      for (const { src, file } of replacements) {
        const rx = new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        out = out.replace(rx, file);
      }
      return out;
    }

    // 用 JSZip 打包（文本轻压缩、图片 STORE）
    async _zipWithJSZip(files) {
      this.log("zip[jszip]: adding files");
      const z = new JSZip();
      for (const f of files) {
        if (f.type === "text") {
          z.file(f.path, f.data, { compression: "DEFLATE" }); // 文本轻压缩：由 compressionOptions.level 决定
        } else {
          z.file(f.path, f.data, {
            binary: true,
            compression: f.store ? "STORE" : "DEFLATE",
          });
        }
      }
      this.log("zip[jszip]: generateAsync...");
      const blob = await z.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 3 },
          streamFiles: true,
        },
        (meta) => {
          const p = 80 + Math.round((meta.percent || 0) * 0.2);
          this.onProgress(Math.min(100, p));
          // 更密日志：每 5% 打一次
          if (CONFIG.DEBUG && Math.round(meta.percent) % 5 === 0) {
            this.log(
              `zip[jszip]: ${Math.round(meta.percent)}% file=${meta.currentFile || ""
              }`
            );
          }
        }
      );
      this.log("zip[jszip]: done");
      return blob;
    }

    // 用 fflate 打包（完全在内存中，但更快；图片 level=0）
    async _zipWithFflate(files) {
      if (!(window.fflate && window.fflate.Zip)) {
        const ok = await Utils.ensureFflate();
        if (!ok) throw new Error("fflate not available");
      }
      const { Zip } = window.fflate;
      this.log("zip[fflate]: adding files");

      const chunks = [];
      const zip = new Zip((err, chunk, final) => {
        if (err) {
          this.log("zip[fflate] err:", err);
          return;
        }
        chunks.push(chunk);
        if (final) this.log("zip[fflate]: stream final");
      });

      let i = 0;
      for (const f of files) {
        i++;
        const name = f.path;
        if (f.type === "text") {
          const u8 = new TextEncoder().encode(f.data);
          zip.add(name, u8, { level: 3 }); // 文本轻压缩
        } else {
          const buf = new Uint8Array(await f.data.arrayBuffer());
          zip.add(name, buf, { level: f.store ? 0 : 3 }); // 图片不压缩
        }
        // 计算粗略进度（按文件数）
        const p = 80 + Math.round((i / files.length) * 18);
        this.onProgress(Math.min(98, p));
        if (CONFIG.DEBUG)
          this.log(`zip[fflate]: added ${i}/${files.length} ${name}`);
        // 让出事件循环，避免 UI 卡住
        await Promise.resolve();
      }
      zip.end();
      this.log("zip[fflate]: ending...");

      // 拼合块
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      const blob = new Blob([out], { type: "application/zip" });
      this.log(`zip[fflate]: done size=${blob.size}`);
      return blob;
    }

    async generate() {
      this.log('stage:init');
      this.onProgress(58);

      // 1) info.json
      const info = {
        version: 2,
        type: 'net.daringfireball.markdown',
        creatorIdentifier: 'ieee-paper-exporter',
        sourceURL: window.location.href,
        transient: false,
        creatorURL: 'https://github.com/yourusername/ieee-paper-exporter',
        createdAt: new Date().toISOString(),
        metadata: this.metadata ? {
          title: this.metadata.title,
          authors: Array.isArray(this.metadata.authors)
            ? this.metadata.authors.map(a => a.name || `${a.firstName || ''} ${a.lastName || ''}`.trim())
            : [],
          doi: this.metadata.doi,
          year: this.metadata.publicationYear,
          journal: this.metadata.publicationTitle
        } : {}
      };

      // 2) 抓图 + 可选 GIF 转码 + 统计压缩率
      const files = [];           // { path, type:'text'|'blob', data, store:boolean }
      const replacements = [];    // [{ src, file }]
      const N = this.images.length;
      let done = 0;

      // 压缩率统计
      let convCount = 0;          // 采用了更小转码的张数
      let convWorseCount = 0;     // 转码更大而放弃的张数
      let bytesOrig = 0;          // 原始图片总字节
      let bytesConv = 0;          // 采用后图片总字节

      this.log(`stage:images start count=${N} concurrency=${CONFIG.IMG_CONCURRENCY}`);

      await this._mapLimit(this.images, CONFIG.IMG_CONCURRENCY, async (img, idx) => {
        const t0 = performance.now();
        const raw = await this.fetchImageAsBlob(img.src);
        const dt = (performance.now() - t0).toFixed(1);

        if (!raw) {
          this.log(`image#${idx} miss  time=${dt}ms url=${img.src}`);
          done++; this.onProgress(60 + Math.round((done / Math.max(1, N)) * 18));
          return;
        }

        const before = raw.size;
        let chosenBlob = raw;
        let chosenExt = this.getExtFromType(raw.type); // 例如 '.gif'
        let usedConvert = false;

        // 仅对 GIF 做转码；其它格式直接走原图
        const isGif = (raw.type || '').toLowerCase() === 'image/gif';
        if (isGif && CONFIG.TEXTBUNDLE?.GIF_TO_PNG) {
          const { blob: convBlob, converted, ext: convExt } = await this._convertGifBlobIfNeeded(raw);
          if (converted && convBlob) {
            const after = convBlob.size;
            const pct = ((after / Math.max(1, before)) * 100).toFixed(1);
            const saved = (100 - parseFloat(pct)).toFixed(1);

            if (!CONFIG.TEXTBUNDLE.ONLY_IF_SMALLER || after < before) {
              chosenBlob = convBlob;
              chosenExt = convExt; // '.png' 或 '.webp'
              usedConvert = true;
              convCount++;
              this.log(`conv#${idx}: gif -> ${convExt.slice(1)}  ${before}B -> ${after}B  (${pct}% of original, -${saved}%)`);
            } else {
              convWorseCount++;
              this.log(`conv#${idx}: gif -> ${convExt.slice(1)}  ${before}B -> ${after}B  (worse) keep GIF`);
            }
          }
        }

        // 写入文件表（图片一律 STORE，不再二次压缩）
        const filename = `assets/image_${img.id}${chosenExt}`;
        files.push({ path: filename, type: 'blob', data: chosenBlob, store: true });
        replacements.push({ src: img.src, file: filename });

        // 统计
        bytesOrig += before;
        bytesConv += chosenBlob.size;

        if (!usedConvert) {
          this.log(`image#${idx} ok    time=${dt}ms size=${chosenBlob.size} file=${filename}`);
        }

        done++; this.onProgress(60 + Math.round((done / Math.max(1, N)) * 18));
      });

      this.log(`stage:images done ${done}/${N}`);

      // 3) 更新正文中的图片路径并加入文本文件
      const md = this.updateImagePathsWithMap(this.markdown, replacements);
      files.push({ path: 'text.md', type: 'text', data: md, store: false });
      files.push({ path: 'info.json', type: 'text', data: JSON.stringify(info, null, 2), store: false });
      this.onProgress(80);
      this.log(`stage:text prepared len=${md.length}`);

      // 4) 选择打包引擎（保留你的 use 逻辑）
      const use = (CONFIG.ZIP_ENGINE || 'auto').toLowerCase();
      this.log(`stage:zip start engine=${use}`);

      let blob;
      if (use === 'fflate') {
        const ok = await Utils.ensureFflate();
        if (!ok) throw new Error('fflate not available');
        blob = await this._zipWithFflate(files);
        this.log('stage:zip done via fflate');
      } else if (use === 'jszip' || use === 'auto') {
        try {
          // JSZip 带进度（内部把 80→100 的进度映射）
          blob = await this._withTimeout(
            this._zipWithJSZip(files),
            CONFIG.ZIP_TIMEOUT_MS || 25000,
            'zip-jszip'
          );
          this.log('stage:zip done via jszip');
        } catch (e) {
          this.log(`jszip fail/timeout -> fallback fflate: ${e && e.message}`);
          const ok = await Utils.ensureFflate();
          if (!ok) throw new Error('fflate load failed');
          blob = await this._zipWithFflate(files);
          this.log('stage:zip done via fflate');
        }
      } else {
        // 兜底走 fflate
        const ok = await Utils.ensureFflate();
        if (!ok) throw new Error('fflate not available');
        blob = await this._zipWithFflate(files);
        this.log('stage:zip done via fflate');
      }

      // 5) 汇总压缩率与打包体积
      const assetRatio = bytesConv / Math.max(1, bytesOrig);
      const assetPct = (assetRatio * 100).toFixed(1);
      const assetSaved = (100 - parseFloat(assetPct)).toFixed(1);
      this.log(`conv: summary converted_better=${convCount}/${N}, worse_kept=${convWorseCount}, assets ${bytesOrig}B -> ${bytesConv}B  (${assetPct}% of original, -${assetSaved}%)`);

      const approxUncompressed = bytesConv + (JSON.stringify(info).length + md.length);
      const packPct = ((blob.size / Math.max(1, approxUncompressed)) * 100).toFixed(1);
      this.log(`zip: summary pack_size=${blob.size}B  vs_uncompressed≈${approxUncompressed}B  (≈${packPct}%)`);

      this.onProgress(100);
      this.log('stage:all done');
      return blob;
    }

    // 放在 class TextBundleGenerator 内部！
    async fetchImageAsBlob(url) {
      let finalUrl = url;
      if (finalUrl.startsWith("/"))
        finalUrl = `https://ieeexplore.ieee.org${finalUrl}`;
      const label = finalUrl.split("?")[0].slice(-48);

      // 原生 fetch 带超时
      try {
        this.log(`fetch start ${label}`);
        const res = await this._withTimeout(
          fetch(finalUrl, {
            credentials: "include",
            headers: { Referer: window.location.href },
          }),
          CONFIG.FETCH_TIMEOUT_MS,
          `fetch ${label}`
        );

        if (res && res.ok) {
          const b = await res.blob();
          this.log(`fetch ok   ${label} size=${b.size}`);
          return b;
        }
        throw new Error(`status ${res && res.status}`);
      } catch (e) {
        this.log(`fetch fail  ${label}: ${e.message || e}`);
        // GM_xmlhttpRequest 兜底
        if (typeof GM_xmlhttpRequest === "function") {
          this.log(`GMXHR try   ${label}`);
          return await new Promise((resolve) => {
            GM_xmlhttpRequest({
              url: finalUrl,
              method: "GET",
              responseType: "arraybuffer",
              timeout: CONFIG.FETCH_TIMEOUT_MS,
              headers: { Referer: window.location.href },
              onload: (resp) => {
                try {
                  const m =
                    resp.responseHeaders &&
                    resp.responseHeaders.match(/content-type:\s*([^\r\n]+)/i);
                  const mime =
                    m && m[1] ? m[1].trim() : "application/octet-stream";
                  const blob = new Blob([resp.response], { type: mime });
                  this.log(`GMXHR ok   ${label} size=${blob.size}`);
                  resolve(blob);
                } catch (err) {
                  this.log(`GMXHR err  ${label}: ${err}`);
                  resolve(null);
                }
              },
              onerror: () => {
                this.log(`GMXHR fail ${label}`);
                resolve(null);
              },
              ontimeout: () => {
                this.log(`GMXHR tout ${label}`);
                resolve(null);
              },
            });
          });
        }
        return null;
      }
    }

    _dataURLToBlob(durl) {
      const arr = durl.split(','), mime = arr[0].match(/:(.*?);/)[1];
      const bstr = atob(arr[1]); const n = bstr.length; const u8 = new Uint8Array(n);
      for (let i = 0; i < n; i++) u8[i] = bstr.charCodeAt(i);
      return new Blob([u8], { type: mime });
    }
    _loadImageFromBlob(blob) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
      });
    }
    _boundedSize(w, h, maxDim) {
      if (!maxDim || (w <= maxDim && h <= maxDim)) return { w, h, scale: 1 };
      const s = Math.min(maxDim / w, maxDim / h);
      return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
    }
    async _drawToBlob(img, fmt /* 'png'|'webp'*/, quality) {
      const { w, h } = this._boundedSize(img.naturalWidth || img.width, img.naturalHeight || img.height, CONFIG.TEXTBUNDLE.MAX_DIM);
      if ('OffscreenCanvas' in window) {
        const oc = new OffscreenCanvas(w, h); const ctx = oc.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        return await oc.convertToBlob({ type: (fmt === 'webp' ? 'image/webp' : 'image/png'), quality });
      } else {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        return await new Promise(res => c.toBlob(res, (fmt === 'webp' ? 'image/webp' : 'image/png'), quality));
      }
    }
    async _convertGifBlobIfNeeded(blob) {
      const isGif = (blob.type || '').toLowerCase() === 'image/gif';
      if (!isGif || !CONFIG.TEXTBUNDLE.GIF_TO_PNG) return { blob, converted: false, ext: this.getExtFromType(blob.type), ratio: 1 };

      try {
        const img = await this._loadImageFromBlob(blob); // 抓首帧（IEEE 图基本是静态 GIF）
        // 目标优先 webp，否则 png
        let out = null, target = (CONFIG.TEXTBUNDLE.TARGET === 'webp' ? 'webp' : 'png');
        try { out = await this._drawToBlob(img, target, CONFIG.TEXTBUNDLE.WEBP_QUALITY); }
        catch (_) { target = 'png'; out = await this._drawToBlob(img, 'png'); }

        // 如仍过大可继续等比降采样（不强制，可按 MAX_DIM 控制；这里示例：按 MAX_DIM 逐次降低）
        let cur = out, curW = img.naturalWidth || img.width, curH = img.naturalHeight || img.height;
        let maxDim = Math.min(CONFIG.TEXTBUNDLE.MAX_DIM, Math.max(curW, curH));
        // 已经按 MAX_DIM 生成一次，一般不再循环；若想更激进，可按需要再循环缩小

        const ratio = cur.size / Math.max(1, blob.size);
        const ext = (target === 'webp' ? '.webp' : '.png');
        return { blob: cur, converted: true, ext, ratio };
      } catch (e) {
        this.log(`conv: gif->png/webp failed: ${e && e.message || e}`);
        return { blob, converted: false, ext: this.getExtFromType(blob.type), ratio: 1 };
      }
    }
  }
  // Base64 Markdown 生成器
  class Base64MarkdownGenerator {
    constructor(markdown, images, onProgress, onLog) {
      this.markdown = markdown;
      this.images = images || [];
      this.onProgress =
        typeof onProgress === "function" ? onProgress : () => { };
      this.onLog = typeof onLog === "function" ? onLog : () => { };
      this.concurrency = CONFIG.IMG_CONCURRENCY || 4;
    }

    // —— 并发控制 —— //
    async _mapLimit(arr, limit, fn) {
      const ret = [];
      let i = 0,
        active = 0,
        idx = 0;
      return await new Promise((resolve) => {
        const next = () => {
          while (active < limit && i < arr.length) {
            const my = idx++;
            const item = arr[i++];
            active++;
            Promise.resolve(fn(item, my))
              .then((v) => (ret[my] = v))
              .catch((e) => {
                this.onLog(`b64: err #${my}: ${(e && e.message) || e}`);
                ret[my] = null;
              })
              .finally(() => {
                active--;
                i >= arr.length && active === 0 ? resolve(ret) : next();
              });
          }
        };
        next();
      });
    }

    // —— 基础工具 —— //
    async _fetchBlob(url) {
      try {
        let u = url;
        if (u.startsWith("/")) u = `https://ieeexplore.ieee.org${u}`;
        const res = await fetch(u, {
          credentials: "include",
          headers: { Referer: window.location.href },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        return await res.blob();
      } catch (e) {
        // GMXHR 兜底
        if (typeof GM_xmlhttpRequest === "function") {
          return await new Promise((resolve) => {
            GM_xmlhttpRequest({
              url,
              method: "GET",
              responseType: "arraybuffer",
              headers: { Referer: window.location.href },
              onload: (resp) => {
                const m =
                  resp.responseHeaders &&
                  resp.responseHeaders.match(/content-type:\s*([^\r\n]+)/i);
                const mime =
                  m && m[1] ? m[1].trim() : "application/octet-stream";
                resolve(new Blob([resp.response], { type: mime }));
              },
              onerror: () => resolve(null),
              ontimeout: () => resolve(null),
            });
          });
        }
        return null;
      }
    }

    _blobToDataURL(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
    }

    _dataURLBytes(durl) {
      const i = durl.indexOf(",");
      if (i < 0) return durl.length;
      const b64len = durl.length - (i + 1);
      // base64 解码字节估算（考虑尾部=）
      const pad = durl.endsWith("==") ? 2 : durl.endsWith("=") ? 1 : 0;
      return Math.ceil((b64len * 3) / 4) - pad;
    }

    _boundedSize(w, h, maxDim) {
      if (!maxDim || (w <= maxDim && h <= maxDim)) return { w, h, scale: 1 };
      const s = Math.min(maxDim / w, maxDim / h);
      return {
        w: Math.max(1, Math.round(w * s)),
        h: Math.max(1, Math.round(h * s)),
        scale: s,
      };
    }

    _loadImageFromBlob(blob) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = (e) => {
          URL.revokeObjectURL(url);
          reject(e);
        };
        img.src = url;
      });
    }

    async _drawToDataURL(img, maxDim, fmt, quality) {
      const { w, h } = this._boundedSize(
        img.naturalWidth || img.width,
        img.naturalHeight || img.height,
        maxDim
      );
      // OffscreenCanvas 优先（更快）
      let durl;
      if ("OffscreenCanvas" in window) {
        const oc = new OffscreenCanvas(w, h);
        const ctx = oc.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        // 对于 png，quality 被忽略；webp 受控
        const blob = await oc.convertToBlob({
          type: fmt === "webp" ? "image/webp" : "image/png",
          quality,
        });
        durl = await this._blobToDataURL(blob);
      } else {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        durl = c.toDataURL(
          fmt === "webp" ? "image/webp" : "image/png",
          quality
        );
      }
      return durl;
    }

    async _gifBlobToConvertedDataURL(blob) {
      try {
        const img = await this._loadImageFromBlob(blob); // 抓首帧
        // 先试用户指定目标（webp 更小，但兼容性看渲染器）
        if (CONFIG.BASE64.TARGET === "webp") {
          try {
            return await this._drawToDataURL(
              img,
              CONFIG.BASE64.MAX_DIM,
              "webp",
              CONFIG.BASE64.WEBP_QUALITY
            );
          } catch (_) {
            /* fallthrough to png */
          }
        }
        // 默认 PNG（最兼容）
        return await this._drawToDataURL(img, CONFIG.BASE64.MAX_DIM, "png");
      } catch (e) {
        this.onLog(`b64: gif->png fail: ${(e && e.message) || e}`);
        return null;
      }
    }

    async _maybeConvertAndEncode(img, idx) {
      // 拉原图为 Blob
      const blob = await this._fetchBlob(img.src);
      if (!blob)
        return {
          src: img.src,
          b64: null,
          keepLink: true,
          reason: "fetch-fail",
        };

      const isGif = (blob.type || "").toLowerCase() === "image/gif";
      let durl;

      if (isGif && CONFIG.BASE64.GIF_TO_PNG) {
        this.onLog(`b64: #${idx} gif→${CONFIG.BASE64.TARGET}`);
        durl = await this._gifBlobToConvertedDataURL(blob);
        if (!durl)
          return {
            src: img.src,
            b64: null,
            keepLink: true,
            reason: "convert-fail",
          };
      } else {
        // 非 GIF 保持原格式（直接 base64）
        durl = await this._blobToDataURL(blob);
      }

      // 体积控制：超限则连续降采样
      let bytes = this._dataURLBytes(durl);
      if (CONFIG.BASE64.MAX_BYTES && bytes > CONFIG.BASE64.MAX_BYTES) {
        this.onLog(
          `b64: #${idx} too big ${bytes}B > ${CONFIG.BASE64.MAX_BYTES}B, downscaling...`
        );
        // 如果不是 GIF 转码产物，先转成可绘制位图再缩
        let workDurl = durl;
        let curW = null,
          curH = null;
        try {
          // 先把 dataURL 读成 Image
          const imgEl = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = durl;
          });
          curW = imgEl.naturalWidth || imgEl.width;
          curH = imgEl.naturalHeight || imgEl.height;

          let maxDim = Math.min(CONFIG.BASE64.MAX_DIM, Math.max(curW, curH));
          while (
            bytes > CONFIG.BASE64.MAX_BYTES &&
            maxDim >= CONFIG.BASE64.MIN_DIM
          ) {
            maxDim = Math.floor(maxDim * CONFIG.BASE64.DOWNSCALE_STEP);
            workDurl = await this._drawToDataURL(
              imgEl,
              maxDim,
              CONFIG.BASE64.TARGET === "webp" ? "webp" : "png",
              CONFIG.BASE64.WEBP_QUALITY
            );
            bytes = this._dataURLBytes(workDurl);
            this.onLog(`b64: #${idx} down -> maxDim=${maxDim} bytes=${bytes}`);
          }
          durl = workDurl;
        } catch (e) {
          this.onLog(`b64: #${idx} downscale fail: ${(e && e.message) || e}`);
        }
      }

      // 仍超限 → 兜底策略
      if (
        CONFIG.BASE64.MAX_BYTES &&
        this._dataURLBytes(durl) > CONFIG.BASE64.MAX_BYTES
      ) {
        if (CONFIG.BASE64.FALLBACK_TO_LINK_IF_TOO_BIG) {
          this.onLog(`b64: #${idx} keep link (still too big)`);
          return {
            src: img.src,
            b64: null,
            keepLink: true,
            reason: "oversize",
          };
        }
      }

      return { src: img.src, b64: durl, keepLink: false };
    }

    async generate() {
      const N = this.images.length;
      this.onLog(
        `b64: start images=${N} concurrency=${this.concurrency} target=${CONFIG.BASE64.TARGET}`
      );
      if (N === 0) {
        this.onProgress(1);
        return this.markdown;
      }

      let done = 0;
      const pairs = await this._mapLimit(
        this.images,
        this.concurrency,
        async (img, idx) => {
          const out = await this._maybeConvertAndEncode(img, idx);
          done++;
          this.onProgress(done / N);
          if (out.keepLink)
            this.onLog(`b64: #${idx} -> keep link (${out.reason})`);
          else
            this.onLog(
              `b64: #${idx} -> inline ok size=${this._dataURLBytes(out.b64)}B`
            );
          return out;
        }
      );

      // 统一替换
      let outMd = this.markdown;
      for (const it of pairs) {
        if (!it) continue;
        if (it.b64) {
          const escaped = it.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          outMd = outMd.replace(new RegExp(escaped, "g"), it.b64);
        } // keepLink: 不替换
      }
      this.onLog("b64: replace done");
      return outMd;
    }
  }

  // UI 管理器
  class UIManager {
    constructor() {
      this.container = null;
      this.isProcessing = false;
      this.progressBar = null;
      
      // 缓存系统
      this.cache = {
        lastPageHash: null,
        metadata: null,
        converter: null,
        markdown: null,
        images: null
      };
    }

    init() {
      this.createButtons();
      this.attachEventListeners();
    }

    createButtons() {
      // 检查是否已存在
      if (document.getElementById(CONFIG.BUTTON_CONTAINER_ID)) {
        return;
      }

      // Add compact CSS styling
      const styleTag = document.createElement('style');
      styleTag.textContent = `
        :root {
          --ieee-bg: #ffffff; --ieee-text: #111827; --ieee-muted: #6b7280;
          --ieee-border: #e5e7eb; --ieee-panel: rgba(255,255,255,0.96);
          --ieee-accent: #003B5C; --ieee-accent-600: #002847; --ieee-shadow: 0 12px 32px rgba(0,0,0,.15);
        }
        @media (prefers-color-scheme: dark) {
          :root { --ieee-bg:#0f1115; --ieee-text:#e5e7eb; --ieee-muted:#9ca3af; --ieee-border:#30363d;
                  --ieee-panel: rgba(17,17,17,.92); --ieee-accent:#0066CC; --ieee-accent-600:#0052a3; --ieee-shadow:0 16px 40px rgba(0,0,0,.4); }
        }
        .ieee-md-panel {
          position: fixed; right: 16px; bottom: 16px; z-index: 9999;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans CJK SC";
          background: var(--ieee-panel); color: var(--ieee-text);
          border: 1px solid var(--ieee-border); border-radius: 12px;
          padding: 10px 10px; box-shadow: var(--ieee-shadow);
          backdrop-filter: saturate(1.1) blur(6px);
          user-select: none;
        }
        .ieee-md-panel__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px 0}
        .ieee-md-panel__title{margin:0;font-size:13px;letter-spacing:.2px;font-weight:700;display:inline-flex;align-items:center;gap:6px}
        .ieee-md-badge{display:inline-block;padding:2px 6px;font-size:11px;font-weight:700;color:#fff;background:var(--ieee-accent);border-radius:999px}
        .ieee-md-panel__drag{cursor:grab;opacity:.9;font-size:11px;color:var(--ieee-muted)}
        .ieee-md-panel__drag:active{cursor:grabbing}
        .ieee-md-panel__btns{display:flex;flex-wrap:wrap;gap:6px}
        .ieee-md-btn{margin:0;padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:var(--ieee-accent);color:#fff;font-weight:700;font-size:12px;box-shadow:0 1px 0 rgba(0,0,0,.08)}
        .ieee-md-btn:hover{background:var(--ieee-accent-600)}
        .ieee-md-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}
        .ieee-md-btn--secondary{background:transparent;color:var(--ieee-text);border:1px solid var(--ieee-border)}
        .ieee-md-btn--secondary:hover{background:rgba(0,0,0,.05)}
        .ieee-md-btn--ghost{background:transparent;color:var(--ieee-muted)}
        .ieee-md-btn--ghost:hover{color:var(--ieee-text)}
        .ieee-md-hide{display:none!important}

        /* Debug Log Panel */
        .ieee-md-log{margin-top:8px;border:1px solid var(--ieee-border);border-radius:8px;background:rgba(0,0,0,.02)}
        .ieee-md-log__header{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid var(--ieee-border);background:rgba(0,0,0,.03)}
        .ieee-md-log__title{font-size:11px;font-weight:700;color:var(--ieee-muted)}
        .ieee-md-log__actions{display:flex;gap:4px}
        .ieee-md-log__btn{padding:2px 6px;font-size:10px;border:0;border-radius:4px;cursor:pointer;background:transparent;color:var(--ieee-muted);font-weight:500}
        .ieee-md-log__btn:hover{color:var(--ieee-text);background:rgba(0,0,0,.05)}
        .ieee-md-log__content{height:120px;overflow-y:auto;padding:6px 8px;font-family:ui-monospace,SFMono-Regular,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:10px;line-height:1.3;white-space:pre-wrap;word-break:break-word;color:var(--ieee-text);background:#fff0}
        @media (prefers-color-scheme: dark){.ieee-md-log{background:rgba(255,255,255,.02)}.ieee-md-log__header{background:rgba(255,255,255,.03)}.ieee-md-log__content{background:rgba(0,0,0,.1)}}

        /* Footer */
        .ieee-md-footer{margin-top:8px;padding-top:6px;border-top:1px solid var(--ieee-border);text-align:center;font-size:10px;color:var(--ieee-muted)}
        .ieee-md-footer a{color:var(--ieee-accent);text-decoration:none}
        .ieee-md-footer a:hover{text-decoration:underline}
      `;
      document.head.appendChild(styleTag);

      // 创建按钮容器
      this.container = document.createElement("div");
      this.container.id = CONFIG.BUTTON_CONTAINER_ID;
      this.container.className = 'ieee-md-panel';

      this.container.innerHTML = `
        <div class="ieee-md-panel__head">
          <div class="ieee-md-panel__title">
            <span class="ieee-md-badge">IEEE</span>
            <span>Markdown Export</span>
          </div>
          <button class="ieee-md-btn ieee-md-btn--ghost" data-action="toggle">折叠</button>
          <span class="ieee-md-panel__drag" title="拖拽移动位置">⇕</span>
        </div>
        <div class="ieee-md-panel__btns" data-role="buttons">
          <button class="ieee-md-btn" data-action="preview" data-mode="links">Preview · Links</button>
          <button class="ieee-md-btn ieee-md-btn--secondary" data-action="preview" data-mode="base64">Preview · Base64</button>
          <button class="ieee-md-btn" data-action="links">Export · Links</button>
          <button class="ieee-md-btn" data-action="base64">Export · Base64</button>
          <button class="ieee-md-btn ieee-md-btn--secondary" data-action="textbundle">Export · TextBundle</button>
          <button class="ieee-md-btn ieee-md-btn--ghost" data-action="debug-log">Debug Log</button>
        </div>
        <div class="ieee-md-log ieee-md-hide" data-role="debug-log">
          <div class="ieee-md-log__header">
            <span class="ieee-md-log__title">调试日志</span>
            <div class="ieee-md-log__actions">
              <button class="ieee-md-log__btn" data-action="clear-log">清空</button>
              <button class="ieee-md-log__btn" data-action="copy-log">复制</button>
            </div>
          </div>
          <div class="ieee-md-log__content"></div>
        </div>
        <div class="ieee-md-footer">
          © Qi Deng - <a href="https://github.com/nerdneilsfield/neils-monkey-scripts/" target="_blank">GitHub</a>
        </div>
      `;

      // Setup event listeners for compact UI
      const btns = this.container.querySelector('[data-role="buttons"]');
      this.container.querySelector('[data-action="toggle"]')?.addEventListener('click', () => {
        btns.classList.toggle('ieee-md-hide');
        const debugLog = this.container.querySelector('[data-role="debug-log"]');
        const footer = this.container.querySelector('.ieee-md-footer');
        debugLog?.classList.add('ieee-md-hide');
        footer?.classList.toggle('ieee-md-hide');
      });

      // Debug log toggle
      this.container.querySelector('[data-action="debug-log"]')?.addEventListener('click', () => {
        const debugLog = this.container.querySelector('[data-role="debug-log"]');
        debugLog?.classList.toggle('ieee-md-hide');
      });

      // Clear log
      this.container.querySelector('[data-action="clear-log"]')?.addEventListener('click', () => {
        const logContent = this.container.querySelector('.ieee-md-log__content');
        if (logContent) logContent.textContent = '';
      });

      // Copy log
      this.container.querySelector('[data-action="copy-log"]')?.addEventListener('click', () => {
        const logContent = this.container.querySelector('.ieee-md-log__content');
        if (logContent && navigator.clipboard) {
          navigator.clipboard.writeText(logContent.textContent || '');
        }
      });

      // Store reference to log content for updating
      this.logContent = this.container.querySelector('.ieee-md-log__content');

      // …创建按钮们后：把需要被折叠的元素登记起来
      this.sections = [
        btns,
        this.container.querySelector('[data-role="debug-log"]'),
        this.container.querySelector('.ieee-md-footer')
      ].filter(Boolean);

      // 保存 toggle 引用 & 状态位
      this.toggleBtn = this.container.querySelector('[data-action="toggle"]');
      this.minimized = false;

      // 添加到页面
      document.body.appendChild(this.container);
    }

    // 辅助函数：使颜色变暗
    darkenColor(color, amount) {
      const hex = color.replace("#", "");
      const r = Math.max(
        0,
        parseInt(hex.substr(0, 2), 16) - Math.round(255 * amount)
      );
      const g = Math.max(
        0,
        parseInt(hex.substr(2, 2), 16) - Math.round(255 * amount)
      );
      const b = Math.max(
        0,
        parseInt(hex.substr(4, 2), 16) - Math.round(255 * amount)
      );
      return `#${r.toString(16).padStart(2, "0")}${g
        .toString(16)
        .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }

    appendLog(msg) {
      try {
        if (!this.logContent) return;
        const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
        const line = `[${ts}] ${msg}\n`;
        this.logContent.textContent += line;
        this.logContent.scrollTop = this.logContent.scrollHeight;
        if (CONFIG.DEBUG) console.log("[IEEE Export]", msg);
      } catch (e) {
        /* noop */
      }
    }

    // 缓存相关方法
    _getPageHash() {
      const title = document.title || '';
      const bodyLength = document.body ? document.body.textContent.length : 0;
      const metadata = Utils.getMetadata();
      const articleNumber = metadata?.articleNumber || '';
      return `${title}-${bodyLength}-${articleNumber}`;
    }

    async _buildBaseCache() {
      this.appendLog('🔄 Building base cache...');
      
      const documentId = Utils.getDocumentId();
      if (!documentId) throw new Error("Could not find document ID");
      
      const fetcher = new DataFetcher(documentId);
      const t0 = performance.now();
      const data = await fetcher.fetchAll();
      
      const converter = new IEEEMarkdownConverter(data);
      const markdown = await converter.convert();
      const images = converter.images || [];
      
      // Store in cache
      this.cache.metadata = data.metadata;
      this.cache.converter = converter;
      this.cache.markdown = markdown;
      this.cache.images = images;
      this.cache.lastPageHash = this._getPageHash();
      
      const dt = (performance.now() - t0).toFixed(1);
      this.appendLog(`✅ Base cache built: ${markdown.length} chars, ${images.length} images (${dt}ms)`);
      return { data, converter, markdown, images };
    }

    async _getCachedOrBuild() {
      const currentHash = this._getPageHash();
      const cacheValid = this.cache.lastPageHash === currentHash && this.cache.markdown;
      
      if (cacheValid) {
        this.appendLog('⚡ Using cached data for faster processing');
        return {
          data: { metadata: this.cache.metadata },
          converter: this.cache.converter,
          markdown: this.cache.markdown,
          images: this.cache.images
        };
      } else {
        this.appendLog('💾 Cache invalid or missing, rebuilding...');
        return await this._buildBaseCache();
      }
    }

    // 辅助函数：使颜色变亮
    lightenColor(color, amount) {
      const hex = color.replace("#", "");
      const r = Math.min(
        255,
        parseInt(hex.substr(0, 2), 16) + Math.round(255 * amount)
      );
      const g = Math.min(
        255,
        parseInt(hex.substr(2, 2), 16) + Math.round(255 * amount)
      );
      const b = Math.min(
        255,
        parseInt(hex.substr(4, 2), 16) + Math.round(255 * amount)
      );
      return `#${r.toString(16).padStart(2, "0")}${g
        .toString(16)
        .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    }

    toggleMinimize() {
      //   const buttons = this.container.querySelectorAll(
      //     "button:not(:last-child)"
      //   );
      //   const progressBar = this.progressBar;
      //   const status = document.getElementById("export-status");
      //   const isMinimized = buttons[0].style.display === "none";

      //   buttons.forEach((btn) => {
      //     btn.style.display = isMinimized ? "block" : "none";
      //   });

      //   if (progressBar)
      //     progressBar.style.display =
      //       isMinimized && this.isProcessing ? "block" : "none";
      //   if (status && status.style.display === "block") {
      //     status.style.display = isMinimized ? "block" : "none";
      //   }

      //   const toggleBtn = this.container.querySelector("button:last-child");
      //   toggleBtn.innerHTML = isMinimized ? "−" : "+";

      this.minimized = !this.minimized;
      for (const el of this.sections) {
        if (!el) continue;
        if (this.minimized) {
          // 记住原 display
          if (!el.dataset._disp)
            el.dataset._disp = getComputedStyle(el).display || "block";
          el.style.display = "none";
        } else {
          el.style.display = el.dataset._disp || "block";
        }
      }
      // 进度条在折叠时也隐藏；展开时仅在处理状态下显示
      if (this.progressBar) {
        this.progressBar.style.display = this.minimized
          ? "none"
          : this.isProcessing
            ? "block"
            : this.progressBar.dataset._disp || "block";
      }
      if (this.toggleBtn)
        this.toggleBtn.textContent = this.minimized ? "+" : "−";
    }

    attachEventListeners() {
      // Event delegation for all button clicks
      this.container.addEventListener('click', async (e) => {
        const button = e.target.closest('[data-action]');
        if (!button) return;
        
        const action = button.dataset.action;
        const mode = button.dataset.mode;
        
        if (this.isProcessing && !['toggle', 'debug-log', 'clear-log', 'copy-log'].includes(action)) {
          return;
        }
        
        switch (action) {
          case 'preview':
            await this.handlePreview(mode);
            break;
          case 'links':
            await this.handleExport("markdown");
            break;
          case 'base64':
            await this.handleExport("base64");
            break;
          case 'textbundle':
            await this.handleExport("textbundle");
            break;
          case 'toggle':
            // Already handled in createButtons
            break;
          case 'debug-log':
            // Already handled in createButtons
            break;
          case 'clear-log':
            // Already handled in createButtons
            break;
          case 'copy-log':
            // Already handled in createButtons
            break;
        }
      });
    }
    
    async handlePreview(mode) {
      this.isProcessing = true;
      this.updateStatus("🔍 Generating preview...", "info");
      this.appendLog(`preview:start mode=${mode}`);
      
      try {
        // Use cache-aware data retrieval
        const { data, converter, markdown, images } = await this._getCachedOrBuild();
        
        let finalMarkdown;
        if (mode === 'base64') {
          this.appendLog("base64:preview-start");
          const b64gen = new Base64MarkdownGenerator(
            markdown,
            images,
            () => {}, // no progress callback needed for preview
            (m) => this.appendLog(m)
          );
          finalMarkdown = await b64gen.generate();
          this.appendLog(`base64:preview-done len=${finalMarkdown.length}`);
        } else {
          finalMarkdown = markdown;
        }
        
        this.showPreview(finalMarkdown, mode);
        this.appendLog(`preview:done mode=${mode} len=${finalMarkdown.length}`);
        
      } catch (error) {
        this.updateStatus(`❌ Preview failed: ${error.message}`, "error");
        this.appendLog(`preview:error ${error.message}`);
      } finally {
        this.isProcessing = false;
        this.enableButtons();
      }
    }
    
    showPreview(content, mode) {
      // Create or get preview modal
      let overlay = document.querySelector('.ieee-preview-overlay');
      let modal = document.querySelector('.ieee-preview-modal');
      
      if (!overlay || !modal) {
        overlay = document.createElement('div');
        overlay.className = 'ieee-preview-overlay';
        overlay.style.cssText = `
          position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 10000; display: flex;
          align-items: center; justify-content: center;
        `;
        
        modal = document.createElement('div');
        modal.className = 'ieee-preview-modal';
        modal.style.cssText = `
          background: white; border-radius: 12px; width: 90%; height: 80%; max-width: 1000px;
          box-shadow: 0 20px 60px rgba(0,0,0,.3); display: flex; flex-direction: column;
          overflow: hidden;
        `;
        
        modal.innerHTML = `
          <div style="padding: 16px; border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; align-items: center;">
            <h3 style="margin: 0; color: #003B5C;">Preview - ${mode}</h3>
            <button class="close-preview" style="background: none; border: none; font-size: 24px; cursor: pointer;">&times;</button>
          </div>
          <div style="flex: 1; overflow: auto; padding: 16px;">
            <pre style="white-space: pre-wrap; font-family: monospace; line-height: 1.4;">${content}</pre>
          </div>
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Close handlers
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) {
            overlay.remove();
          }
        });
        
        modal.querySelector('.close-preview').addEventListener('click', () => {
          overlay.remove();
        });
      } else {
        // Update existing modal
        modal.querySelector('h3').textContent = `Preview - ${mode}`;
        modal.querySelector('pre').textContent = content;
        overlay.style.display = 'flex';
      }
    }

    async copyTextToClipboard(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch { }
      // 回退：隐藏 textarea
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    async handleExport(type) {
      this.isProcessing = true;
      this.showProgress(0);
      this.updateStatus("🚀 Initializing export...", "info");
      this.disableButtons();
      this.appendLog(`export:start type=${type}`);

      try {
        // Use cache-aware data retrieval  
        this.updateStatus("📦 Loading data (with caching)...", "info");
        this.showProgress(15);
        
        const { data, converter, markdown, images } = await this._getCachedOrBuild();
        this.showProgress(50);

        const metadata = data.metadata || {};
        const filename = Utils.sanitizeFilename(
          metadata.title ||
          metadata.displayDocTitle ||
          `IEEE_Paper_${documentId}`
        );

        // —— 分支：TextPack / Base64 / Markdown / Copy ——
        if (type === "textbundle") {
          this.updateStatus("📦 Creating TextPack...", "info");
          this.appendLog("textpack:start");
          const generator = new TextBundleGenerator(
            markdown,
            images,
            metadata,
            (p) => this.showProgress(p),
            (m) => this.appendLog(m)
          );
          const blob = await generator.generate();
          this.appendLog(`textpack:done size=${blob.size}`);
          this.downloadFile(blob, `${filename}.textpack`, "application/zip");
          this.showProgress(100);
          this.updateStatus("✅ Exported TextPack.", "success");
        } else if (type === "base64") {
          this.updateStatus("🖼️ Embedding images as Base64...", "info");
          this.appendLog("base64:start");
          const b64gen = new Base64MarkdownGenerator(
            markdown,
            images,
            (p) => this.showProgress(60 + Math.round(p * 0.35)), // 保守映射到 60~95%
            (m) => this.appendLog(m)
          );
          const processed = await b64gen.generate();
          this.appendLog(`base64:done len=${processed.length}`);
          const blob = new Blob([processed], {
            type: "text/markdown;charset=utf-8",
          });
          this.downloadFile(blob, `${filename}_base64.md`, "text/markdown");
          this.showProgress(100);
          this.updateStatus("✅ Exported Markdown (Base64).", "success");
        } else if (type === "markdown") {
          this.updateStatus("📝 Generating Markdown (Links)...", "info");
          this.appendLog("links:start");
          const blob = new Blob([markdown], {
            type: "text/markdown;charset=utf-8",
          });
          this.downloadFile(blob, `${filename}.md`, "text/markdown");
          this.appendLog("links:done download");
          this.showProgress(100);
          this.updateStatus("✅ Exported Markdown (Links).", "success");
        } else if (type === "copy-markdown") {
          this.updateStatus(
            "📋 Preparing Markdown (Links) for clipboard...",
            "info"
          );
          this.appendLog("copy-links:start");
          const ok = await this.copyTextToClipboard(markdown);
          this.appendLog(`copy-links:done ok=${ok}`);
          if (ok) {
            this.updateStatus("✅ Markdown copied to clipboard.", "success");
          } else {
            this.updateStatus(
              "❌ Copy failed. You can download the .md instead.",
              "error"
            );
          }
          this.showProgress(100);
        }

        setTimeout(() => {
          this.hideStatus();
          this.hideProgress();
        }, 2500);
      } catch (error) {
        console.error("Export error:", error);
        this.appendLog(`error:${error && error.message}`);
        this.updateStatus(`❌ Error: ${error.message}`, "error");
        this.hideProgress();
        setTimeout(() => this.hideStatus(), 4000);
      } finally {
        this.isProcessing = false;
        this.enableButtons();
      }
    }

    showProgress(percent) {
      // For compact UI, show progress in log only
      if (percent % 20 === 0 || percent === 100) {
        this.appendLog(`Progress: ${Math.min(100, Math.max(0, percent))}%`);
      }
    }

    hideProgress() {
      // No explicit progress bar in compact UI
    }

    updateStatus(message, type) {
      // For compact UI, show status in log with appropriate emoji
      const statusEmoji = {
        info: "ℹ️",
        success: "✅",
        error: "❌", 
        warning: "⚠️"
      };
      
      const emoji = statusEmoji[type] || "📋";
      this.appendLog(`${emoji} ${message}`);
    }

    hideStatus() {
      // No explicit status area in compact UI
    }

    disableButtons() {
      this.container.querySelectorAll(".ieee-md-btn").forEach((btn) => {
        if (!btn.dataset.action || ['toggle', 'debug-log', 'clear-log', 'copy-log'].includes(btn.dataset.action)) {
          return; // Don't disable these buttons
        }
        btn.disabled = true;
        btn.style.opacity = "0.6";
        btn.style.cursor = "not-allowed";
      });
    }

    enableButtons() {
      this.container.querySelectorAll(".ieee-md-btn").forEach((btn) => {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
      });
    }

    downloadFile(blob, filename, mimeType) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // 清理
      setTimeout(() => URL.revokeObjectURL(url), 100);
    }
  }

  // 主函数
  function init() {
    console.log("IEEE Paper to Markdown Exporter initialized");

    // 等待页面加载完成
    const initUI = () => {
      // 检查是否在正确的页面
      if (!window.location.href.includes("/document/")) {
        console.warn("Not on a document page");
        return;
      }

      const ui = new UIManager();
      ui.init();

      // 输出元数据信息到控制台（用于调试）
      const metadata = Utils.getMetadata();
      if (metadata) {
        console.log("Paper metadata available:", metadata);
      }
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initUI);
    } else {
      // 延迟一下确保xplGlobal已加载
      setTimeout(initUI, 1000);
    }
  }

  // 启动插件
  init();
})();
