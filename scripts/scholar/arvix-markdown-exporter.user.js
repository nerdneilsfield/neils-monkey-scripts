// ==UserScript==
// @name         Arvix Paper to Markdown Exporter (Enhanced)
// @namespace    http://tampermonkey.net/
// @version      0.0.1
// @description  Export Arvix papers to Markdown with complete metadata, TextBundle and Base64 formats
// @author       Qi Deng <dengqi935@gmail.com>
// @match        https://arxiv.org/html/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/turndown/7.1.2/turndown.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @connect      arxiv.org
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/arvix-markdown-exporter.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/arvix-markdown-exporter.user.js
// ==/UserScript==

/* eslint-disable no-console */
(function () {
  'use strict';

  // -----------------------------
  // 0) Config & Feature Flags
  // -----------------------------
  const Config = {
    APP_NAME: 'arXiv → Markdown',
    VERSION: '0.1.0-skeleton',
    BASE_ORIGIN: 'https://arxiv.org',
    UI: {
      zIndex: 999999,
      position: 'right',
    },
    // —— 引文与脚注策略（已按你的决策设定）——
    CITATION: {
      style: 'footnote+references', // 'footnote+references' | 'bracket+references'
      namespaces: { reference: 'R', footnote: 'F' }, // 参考文献脚注前缀R；正文脚注前缀F
    },
    // —— 图片与 SVG 策略（已按你的决策设定）——
    IMAGES: {
      preferRaster: true,           // 优先<img>位图
      inlineSvgInMarkdown: true,    // 无位图时内联<svg>到 Markdown（Links/Base64形态）
      embedSvgInTextBundle: true,   // TextBundle 中落地 .svg 文件资源
      maxBytes: 2.5 * 1024 * 1024,  // Base64单图最大体积（占位）
      maxDim: 4096,                 // 统一最长边限制（占位）
      concurrency: 4,               // 下载并发（占位）
    },
    FIGURES: { captionStyle: 'plain' }, // 或 'italic'
    // —— 数学编号策略（已按你的决策设定）——
    MATH: {
      displayTag: 'inline',         // 将编号内嵌到 $$ ... \tag{n} $$ 中
      normalizeDelimiters: true,    // 规范 $...$ 与 $$...$$
      decodeEntitiesInsideMath: true,
    },
    // —— 打包策略（先占位，后续你可接 JSZip/fflate 等）——
    PACK: {
      provider: 'native',           // 'native' | 'jszip' | 'fflate'（骨架阶段仅占位）
    },
  };

  // -----------------------------
  // 1) Logger (轻量)
  // -----------------------------
  const Log = {
    info: (...a) => console.log(`[${Config.APP_NAME}]`, ...a),
    warn: (...a) => console.warn(`[${Config.APP_NAME}]`, ...a),
    error: (...a) => console.error(`[${Config.APP_NAME}]`, ...a),
  };

  // -----------------------------
  // 2) Utils
  // -----------------------------
  const U = {
    /** @param {string} sel @param {ParentNode=} root */
    $(sel, root) { return (root || document).querySelector(sel); },
    /** @param {string} sel @param {ParentNode=} root */
    $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); },
    text(node) { return (node?.textContent || '').trim(); },
    attr(node, name) { return node?.getAttribute?.(name) || null; },
    /** 合并软换行：将同段内的换行压成空格 */
    mergeSoftWraps(s) { return (s || '').replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim(); },
    /** 绝对化 URL（结合 <base> 与站点 origin） */
    absolutize(url, baseHref = null) {
      try {
        if (!url) return url;
        if (/^(?:data|blob|https?):/i.test(url)) return url;
        const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : 'https://arxiv.org';
        if (url.startsWith('/')) return origin + url;
        const rawBase = baseHref || U.$('base')?.getAttribute?.('href') || (typeof location !== 'undefined' ? location.href : origin + '/');
        const baseAbs = /^https?:\/\//i.test(rawBase) ? rawBase : (rawBase.startsWith('/') ? origin + rawBase : (typeof location !== 'undefined' ? location.href : origin + '/'));
        return new URL(url, baseAbs).toString();
      } catch { return url; }
    },
    /** 从路径或<base>解析 arXiv id 与版本 */
    parseArxivIdVersion() {
      const base = U.$('base')?.href || location.pathname;
      // 期望形如 /html/2509.03654v1/ 或 /html/2509.03654v1
      const m = String(base).match(/\/html\/(\d{4}\.\d{5})(v\d+)\//) || String(base).match(/\/html\/(\d{4}\.\d{5})(v\d+)/);
      if (m) return { id: m[1], version: m[2] };
      return { id: null, version: null };
    },
    /** 简单节流（占位） */
    delay(ms) { return new Promise(r => setTimeout(r, ms)); },
    /** 粗略的 slug 化标题为锚点用（占位） */
    slug(s) { return (s || '').toLowerCase().replace(/[^a-z0-9\- ]/g, '').replace(/\s+/g, '-').slice(0, 80); },
  };

  // -----------------------------
  // 3) ArxivAdapter（解析层骨架）
  // -----------------------------
  /**
 * ArxivAdapter — 解析 arXiv HTML 视图 (/html/{id}v{n}) 的适配器
 * 使用方式：
 *   const adapter = new ArxivAdapter(document);
 *   const meta = adapter.getMeta();
 *   const bib = adapter.collectBibliography();
 *   const citeMap = adapter.buildCitationMap(bib);
 *   const sections = adapter.walkSections();
 *   // 之后可配合你自己的 Emitter/Exporter 逐步填充
 */
  class ArxivAdapter {
    /**
     * @param {Document} doc
     */
    constructor(doc) {
      this.doc = doc;
      this.baseHref = this._baseHref();
      this.origin = this._origin() || 'https://arxiv.org';
      const { id, version } = this._parseArxivIdVersion();
      this.arxivId = id;
      this.version = version;
      this.links = {
        abs: id ? `${this.origin}/abs/${id}` : null,
        html: id && version ? `${this.origin}/html/${id}${version}` : (typeof location !== 'undefined' ? location.href : null),
        pdf: id ? `${this.origin}/pdf/${id}` : null,
      };
    }

    // ============ 对外主接口 ============

    /**
     * 提取论文元信息：标题、作者数组、摘要、arXiv id/版本与常用链接
     * @returns {{title:string, authors:Array<{name:string, aff?:string, mail?:string}>, abstract:string, arxivId?:string, version?:string, links?:Record<string,string|null>}}
     */
    getMeta() {
      const title =
        this._text(this._$('h1.ltx_title.ltx_title_document')) ||
        (typeof document !== 'undefined' ? document.title : '') ||
        'Untitled';

      const authors = this._parseAuthors();
      const abstract = this._parseAbstract();

      return {
        title,
        authors,
        abstract,
        arxivId: this.arxivId,
        version: this.version,
        links: this.links,
      };
    }

    /**
     * 收集参考文献条目（文末 bib），并提取编号、完整文本、可用链接（若有）
     * @returns {Array<{num:number, id:string, text:string, doi?:string, url?:string}>}
     */
    collectBibliography() {
      const items = [];
      const bibLis = this._all('li.ltx_bibitem[id^="bib."]');
      for (const li of bibLis) {
        const id = li.getAttribute('id') || '';
        const tag = this._text(this._$('.ltx_tag_bibitem', li)) || '';
        const num = this._parseBibNumber(id) ?? this._parseBibNumber(tag) ?? items.length + 1;

        let text = '';
        const blocks = this._all('.ltx_bibblock, .ltx_bibitem', li);
        text = blocks.length
          ? this._mergeSoftWraps(blocks.map(b => this._text(b)).filter(Boolean).join(' '))
          : this._mergeSoftWraps(this._text(li));

        let doi, url;
        for (const a of this._all('a[href]', li)) {
          const href = a.getAttribute('href') || '';
          if (/^mailto:/i.test(href) || href.startsWith('#')) continue;
          if (/^https?:\/\//i.test(href)) {
            if (!url) url = href;
            if (href.includes('doi.org')) { doi = href; break; }
          }
        }
        items.push({ num, id, text, doi, url });
      }
      // —— 去重（按编号）+ 排序
      const uniq = new Map();
      for (const it of items) if (!uniq.has(it.num)) uniq.set(it.num, it);
      return Array.from(uniq.values()).sort((a, b) => a.num - b.num);
    }


    /**
     * 构建“文中引文锚 → 编号”的映射，用于将 [n] 或 [^Rn] 正确替换
     * 兼容相对/绝对锚：'#bib.bib17'、'bib.bib17'、'https://arxiv.org/html/...#bib.bib17'
     * @param {Array<{num:number, id:string}>} bibItems
     * @returns {Map<string, number>}
     */
    buildCitationMap(bibItems) {
      const map = new Map();
      // 把 li 的 id（如 'bib.bib17'）映射到编号
      for (const it of bibItems || []) {
        if (!it?.id || typeof it.num !== 'number') continue;
        const id = it.id; // 例如 'bib.bib17'
        const hash = `#${id}`;
        map.set(id, it.num);
        map.set(hash, it.num);
        // 兼容绝对/相对 URL 形式
        if (this.links.html) {
          map.set(`${this.links.html}${hash}`, it.num);
        }
      }

      // 再扫描正文中出现的 cite/ref，补充未知形式
      const anchors = this._all('a[href*="#bib."]');
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
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
      const docTitle = this._mergeSoftWraps(this._text(this._$('h1.ltx_title.ltx_title_document')));

      // 支持：section / subsection / subsubsection
      const SEC_SEL = 'section.ltx_section[id^="S"], section.ltx_subsection[id^="S"], section.ltx_subsubsection[id^="S"]';
      const sections = this._all(SEC_SEL);
      const seen = new Set();
      const out = [];

      for (const sec of sections) {
        // 标题：通配任何 h2..h6 + .ltx_title（避免漏 h3/h4）
        const h = this._$(':is(h2,h3,h4,h5,h6).ltx_title', sec);
        const title = this._mergeSoftWraps(this._text(h) || 'Section');

        // 跳过与文档主标题同文的分节
        if (title && docTitle && this._eqLoose(title, docTitle)) continue;

        // 分节去重 key
        const id = sec.getAttribute('id') || '';
        const key = `${id}|${title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // 仅采集“直属当前 sec”的节点；排除落在任何子 section 里的节点
        const NODE_SEL = [
          'div.ltx_para > p.ltx_p',
          'table.ltx_equation',
          'math[display="block"]',
          'figure.ltx_figure',
          'table.ltx_tabular',
          'ul', 'ol',
          'pre.ltx_verbatim', '.ltx_listing pre',
          'div.ltx_note.ltx_role_footnote'
        ].join(',');

        const nodes = this._all(NODE_SEL, sec).filter(n => {
          const nearest = n.closest(SEC_SEL);
          if (nearest !== sec) return false;                        // 只要直属本节
          if (n.matches?.('math[display="block"]') && n.closest('table.ltx_equation')) return false; // 交给 table 处理
          if (n.matches?.('div.ltx_para > p.ltx_p') && n.closest('li')) return false;                 // 列表内段落交给列表
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
      if (node.matches && node.matches('table.ltx_equation')) {
        const m = this._$('math[display="block"]', node);
        const tex = this._extractTeX(m);
        if (!tex) return null;
        const tagText = this._text(this._$('.ltx_tag_equation, .ltx_tag.ltx_tag_equation', node));
        const tag = this._stripParen(tagText); // '(3)' -> '3'
        return { type: 'display', tex, tag };
      }

      // 情况 B：直接是 math 元素
      const isMath = node.tagName && node.tagName.toLowerCase() === 'math';
      const mathEl = isMath ? node : this._$('math', node);
      if (!mathEl) return null;
      const display = (mathEl.getAttribute('display') || '').toLowerCase() === 'block';
      const tex = this._extractTeX(mathEl);
      if (!tex) return null;

      let tag;
      if (display) {
        const tbl = mathEl.closest('table.ltx_equation');
        if (tbl) {
          const tagText = this._text(this._$('.ltx_tag_equation, .ltx_tag.ltx_tag_equation', tbl));
          tag = this._stripParen(tagText);
        }
      }
      return { type: display ? 'display' : 'inline', tex, tag };
    }

    /**
     * 提取 figure：优先 <img>；没有则 <svg>
     * @param {Element} fig 预期 figure.ltx_figure
     * @returns {{kind:'img'|'svg', src?:string, inlineSvg?:string, caption?:string, id?:string}|null}
     */
    extractFigure(fig) {
      if (!fig) return null;
      const id = fig.getAttribute('id') || null;

      // 处理 figcaption：把 MathML → $TeX$；清理 "Figure n: "
      let caption = '';
      const capEl = this._$('figcaption.ltx_caption', fig);
      if (capEl) {
        const clone = capEl.cloneNode(true);
        for (const m of Array.from(clone.querySelectorAll('math'))) {
          const tex = this._extractTeX(m);
          m.replaceWith(document.createTextNode(tex ? `$${tex}$` : ''));
        }
        caption = this._mergeSoftWraps(clone.textContent || '')
          .replace(/^\s*Figure\s+\d+\s*[:.]\s*/i, '')
          .trim();
      }

      const img = this._$('img', fig);
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || null;
        if (raw) {
          const src = this._abs(raw);   // 绝对化
          return { kind: 'img', src, caption, id };
        }
      }
      const svg = this._$('svg', fig);
      if (svg) {
        const inlineSvg = svg.outerHTML;
        return { kind: 'svg', inlineSvg, caption, id };
      }
      return null;
    }

    /**
     * 提取表格；当列数过大或结构复杂时，降级为 html 字符串
     * @param {Element} tbl 预期 table.ltx_tabular
     * @returns {{headers?:string[][], rows?:string[][], html?:string}}
     */
    extractTable(tbl) {
      if (!tbl) return { html: '' };
      const rows = Array.from(tbl.querySelectorAll('tr'));
      const colCount = rows.reduce((m, r) => Math.max(m, r.children.length), 0);
      const tooWide = colCount > 12;

      if (tooWide) {
        return { html: tbl.outerHTML };
      }

      const headers = [];
      const body = [];

      // 头部（有 thead 用 thead；否则首行若含 th 也视为表头）
      const thead = tbl.querySelector('thead');
      if (thead) {
        for (const tr of thead.querySelectorAll('tr')) {
          headers.push(this._cellsToText(tr.querySelectorAll('th, td')));
        }
      } else {
        const first = rows[0];
        if (first && first.querySelector('th')) {
          headers.push(this._cellsToText(first.querySelectorAll('th, td')));
        }
      }

      // 主体
      const bodyRows = thead ? tbl.querySelectorAll('tbody tr') :
        (headers.length ? rows.slice(1) : rows);
      for (const tr of bodyRows) {
        body.push(this._cellsToText(tr.querySelectorAll('td, th')));
      }

      return { headers, rows: body };
    }

    /**
     * 提取脚注（若有）—— arXiv/LaTeXML 的脚注结构不统一，这里做通用兜底
     * @param {Element} node e.g., div.ltx_note.ltx_role_footnote
     * @returns {{key:string, content:string}|null}
     */
    extractFootnote(node) {
      if (!node) return null;
      const id = node.getAttribute('id') || '';
      const n = this._parseFootnoteNumber(id);
      const key = n != null ? `F${n}` : (id ? `F_${id}` : null);
      const content = this._mergeSoftWraps(this._text(node));
      if (!key || !content) return null;
      return { key, content };
    }

    // ============ 私有：作者/摘要/工具 ============


    // 宽松字符串比较（忽略空白/标点/大小写）
    _eqLoose(a, b) {
      const norm = s => String(s || '')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '');
      return norm(a) === norm(b);
    }

    /**
     * 解析作者块：尽可能逐人拆分；若结构仅给出一串姓名，也返回单条记录
     * @returns {Array<{name:string, aff?:string, mail?:string}>}
     */
    _parseAuthors() {
      const authors = [];
      const box = this._$('div.ltx_authors');
      if (!box) return authors;

      // 常见结构：一个 .ltx_creator.ltx_role_author 打包所有作者姓名 + notes（单位/邮箱）
      const creators = this._all('.ltx_creator.ltx_role_author, .ltx_author, .ltx_creator', box);
      if (creators.length === 0) {
        // 后备：直接解析名称与邮箱/单位
        const names = this._text(this._$('.ltx_personname', box));
        const aff = this._mergeSoftWraps(this._text(this._$('.ltx_contact.ltx_role_address, .ltx_affiliation', box)));
        const mails = this._collectEmails(box);
        if (names) {
          const splitNames = this._splitPersonList(names);
          if (splitNames.length > 1 && mails.length <= 1) {
            // 多个作者但没有逐人邮箱：按人名展开，不附邮箱
            for (const nm of splitNames) authors.push({ name: nm, aff });
          } else {
            // 作为一条记录保留
            authors.push({ name: names, aff, mail: mails.join(', ') || undefined });
          }
        }
        return authors;
      }

      // 遍历每个 creator，尽可能逐人生成
      for (const c of creators) {
        const names = this._text(this._$('.ltx_personname', c)) || this._text(c);
        const aff = this._mergeSoftWraps(this._text(this._$('.ltx_contact.ltx_role_address, .ltx_affiliation', c)));
        const mails = this._collectEmails(c);
        const splitNames = this._splitPersonList(names);

        if (splitNames.length > 1 && mails.length <= 1) {
          for (const nm of splitNames) authors.push({ name: nm, aff });
        } else if (splitNames.length > 1 && mails.length >= splitNames.length) {
          // 尝试一一对应（保守：长度一致时才配对）
          for (let i = 0; i < splitNames.length; i++) {
            authors.push({ name: splitNames[i], aff, mail: mails[i] });
          }
        } else {
          authors.push({ name: names, aff, mail: mails.join(', ') || undefined });
        }
      }

      return authors;
    }

    /**
     * 摘要：div.ltx_abstract 内所有 p.ltx_p 合并
     * @returns {string}
     */
    _parseAbstract() {
      const box = this._$('div.ltx_abstract');
      if (!box) return '';
      const paras = this._all('p.ltx_p, .ltx_para', box).map(p => this._text(p)).filter(Boolean);
      let abs = this._mergeSoftWraps(paras.join('\n\n'));
      // 去掉可能的 "Abstract." 标题词
      abs = abs.replace(/^\s*Abstract\.?\s*/i, '').trim();
      return abs;
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
      txt = txt.replace(/<[^>]*@[^>]*>/g, '');              // <name@org>
      txt = txt.replace(/\([^()]*@[^()]*\)/g, '');          // (name@org)

      // 标准化分隔符：, ; 、 ， ； 以及 and/&/与/和
      // 用竖线作为临时分隔符，避免多次 split 累积空格
      txt = txt
        .replace(/\s*(?:,|;|，|；|、)\s*/g, '|')
        .replace(/\s+(?:and|&|与|和)\s+/gi, '|');

      // 拆分
      let parts = txt.split('|').map(p => p.trim()).filter(Boolean);

      // 过滤 "et al." 之类
      parts = parts.filter(p => !/et\s*al\.?$/i.test(p));

      // 清理单个姓名中的脚注/上标/编号/奇怪的标记
      parts = parts.map(name => {
        let n = name;

        // 去掉左右多余标点
        n = n.replace(/^[\s,;·•]+|[\s,;·•]+$/g, '');

        // 去掉常见脚注符号（* † ‡ § ¶ ‖ # ^ ~）
        n = n.replace(/[\*\u2020\u2021\u00A7\u00B6\u2016#\^~]+/g, '');

        // 去掉 Unicode 上标数字 ⁰¹²³⁴⁵⁶⁷⁸⁹
        n = n.replace(/[\u2070-\u2079\u00B9\u00B2\u00B3]+/g, '');

        // 去掉姓名前后的纯数字或编号 (例如 1, 2, a), (1), ^1 等
        n = n.replace(/^\s*[\(\[]?[0-9a-zA-Z]+[\)\]]?\s*/g, '');
        n = n.replace(/\s*[\(\[]?[0-9a-zA-Z]+[\)\]]?\s*$/g, '');

        // 清理多余空白
        n = n.replace(/\s{2,}/g, ' ').trim();

        return n;
      }).filter(n => n && n.length >= 2);

      // 去重（保留顺序）
      const seen = new Set();
      const out = [];
      for (const n of parts) {
        const key = n.toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push(n); }
      }
      return out;
    }

    // ============ 私有：通用工具 ============

    _$(sel, root) { return (root || this.doc).querySelector(sel); }
    _all(sel, root) { return Array.from((root || this.doc).querySelectorAll(sel)); }
    _text(node) { return (node && node.textContent ? String(node.textContent) : '').replace(/\s+\u00A0/g, ' ').trim(); }

    _mergeSoftWraps(s) {
      return String(s || '')
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\u00A0/g, ' ')
        .trim();
    }

    _abs(url) {
      try {
        if (!url) return url;
        if (/^(?:data|blob|https?):/i.test(url)) return url;
        const origin = this._origin() || 'https://arxiv.org';
        if (url.startsWith('/')) return origin + url;   // 站内绝对路径
        const base = this._baseHref() || (typeof location !== 'undefined' ? location.href : origin + '/');
        return new URL(url, base).toString();
      } catch { return url; }
    }

    _slug(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9\- ]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 80);
    }

    _origin() {
      try { return (typeof location !== 'undefined' && location.origin) ? location.origin : null; } catch { return null; }
    }

    _baseHref() {
      const b = this._$('base');
      const raw = b ? (b.getAttribute('href') || '') : (typeof location !== 'undefined' ? location.href : '');
      const origin = this._origin() || 'https://arxiv.org';

      if (!raw) return (typeof location !== 'undefined' ? location.href : origin + '/');
      if (/^https?:\/\//i.test(raw)) return raw;        // 已是绝对
      if (raw.startsWith('/')) return origin + raw;     // 站内绝对路径 → 拼上 origin
      try { return new URL(raw, (typeof location !== 'undefined' ? location.href : origin + '/')).toString(); }
      catch { return (typeof location !== 'undefined' ? location.href : origin + '/'); }
    }

    _parseArxivIdVersion() {
      // 支持 /html/2509.03654v1 与 /html/2509.03654v1/ 两种
      const src = this.baseHref || (typeof location !== 'undefined' ? location.pathname : '');
      const m = String(src).match(/\/html\/(\d{4}\.\d{5})(v\d+)(?:\/|$)/);
      return m ? { id: m[1], version: m[2] } : { id: null, version: null };
    }

    _parseBibNumber(s) {
      if (!s) return null;
      // 'bib.bib17' → 17 ; '[17]' → 17 ; '(17)' → 17
      const m = String(s).match(/(?:bib\.bib)?(\d{1,4})\b/);
      return m ? parseInt(m[1], 10) : null;
    }

    _normalizeBibHref(href) {
      if (!href) return href;
      // 统一成 '#bib.bibN' 形式
      const m = String(href).match(/#(bib\.bib\d{1,4})\b/);
      return m ? `#${m[1]}` : href;
    }

    _stripParen(s) {
      if (!s) return '';
      const m = String(s).trim().match(/^\(?\s*([^)]+?)\s*\)?$/);
      return m ? m[1] : String(s).trim();
    }

    _sectionDepth(sec) {
      let d = 1, p = sec.parentElement;
      while (p) {
        if (p.matches && (p.matches('section.ltx_section') || p.matches('section.ltx_subsection') || p.matches('section.ltx_subsubsection'))) d++;
        p = p.parentElement;
      }
      return d;
    }

    _cellsToText(cells) {
      return Array.from(cells).map(td => this._mergeSoftWraps(this._text(td)));
    }

    _collectEmails(root) {
      const all = [];
      for (const a of this._all('a[href^="mailto:"]', root || this.doc)) {
        const raw = (a.getAttribute('href') || '').slice('mailto:'.length);
        // 多邮箱以逗号/分号分隔
        const parts = raw.split(/[;,]/).map(x => x.trim()).filter(Boolean);
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
      if (!mathEl) return '';
      // 优先 annotation[application/x-tex]，其次 alttext
      const ann = mathEl.querySelector('annotation[encoding="application/x-tex"]');
      if (ann && ann.textContent) return String(ann.textContent).trim();
      const alt = mathEl.getAttribute('alttext');
      if (alt) return String(alt).trim();
      // 兜底：无 TeX 则返回空
      return '';
    }
  }

  // -----------------------------
  // 4) MarkdownEmitter（生成层）
  // 兼容全局 Config 与 U（utils）
  // -----------------------------
  class MarkdownEmitter {
    constructor(config = (typeof Config !== 'undefined' ? Config : {})) {
      this.cfg = config;
      this.buffers = {
        head: [],
        body: [],
        footnotes: [],   // F* & R* 合并
        references: [],  // 文末参考条目
      };
    }

    /** @param {{title:string,authors:Array<{name:string,aff?:string,mail?:string}>,abstract:string,arxivId?:string,version?:string,links?:Record<string,string|null>}} meta */
    emitFrontMatter(meta) {
      const head = this.buffers.head;

      // Title
      head.push(`# ${meta.title || 'Untitled'}`);
      head.push('');

      // Authors（逐行）
      if (meta.authors && meta.authors.length) {
        head.push('## Authors');
        for (const a of meta.authors) {
          const parts = [];
          if (a.name) parts.push(a.name);
          const tails = [];
          if (a.aff) tails.push(a.aff);
          if (a.mail) tails.push(`<${a.mail}>`);
          const line = tails.length ? `${parts.join(' ')} — ${tails.join('; ')}` : parts.join(' ');
          head.push(`- ${line}`);
        }
        head.push('');
      }

      // Abstract
      if (meta.abstract) {
        head.push('## Abstract');
        head.push(this._mergeSoftWraps(meta.abstract));
        head.push('');
      }

      // Publication Info（arXiv links）
      const linkAbs = meta.links?.abs ? `**abs:** ${meta.links.abs}` : '';
      const linkHtml = meta.links?.html ? (linkAbs ? `, **html:** ${meta.links.html}` : `**html:** ${meta.links.html}`) : '';
      const linkPdf = meta.links?.pdf ? ((linkAbs || linkHtml) ? `, **pdf:** ${meta.links.pdf}` : `**pdf:** ${meta.links.pdf}`) : '';
      if (meta.arxivId || linkAbs || linkHtml || linkPdf) {
        head.push(`**arXiv:** ${meta.arxivId || 'unknown'}${meta.version ? ` (${meta.version})` : ''}${linkAbs || linkHtml || linkPdf ? ' — ' : ''}${linkAbs}${linkHtml}${linkPdf}`);
        head.push('');
      }
    }

    emitTOCPlaceholder() {
      this.buffers.head.push('## Table of Contents');
      this.buffers.head.push('[TOC]');
      this.buffers.head.push('');
    }

    emitHeading(level, title, anchor) {
      const h = Math.min(6, Math.max(2, level || 2));
      const text = this._mergeSoftWraps(title || 'Section');
      // 仅输出标题；锚点可由渲染器自动生成（也可改用 Pandoc {#anchor} 语法）
      this.buffers.body.push(`${'#'.repeat(h)} ${text}`);
      this.buffers.body.push('');
    }

    emitParagraph(text) {
      if (!text) return;
      this.buffers.body.push(this._mergeSoftWraps(String(text)));
      this.buffers.body.push('');
    }

    /** @param {{type:'inline'|'display', tex:string, tag?:string}} math */
    emitMath(math) {
      if (!math?.tex) return;
      if (math.type === 'display') {
        const tag = math.tag ? ` \\tag{${math.tag}}` : '';
        this.buffers.body.push(`$$\n${math.tex}${tag}\n$$`);
        this.buffers.body.push('');
      } else {
        // 行内：保持最简语法；由上游确保不与已有 $ 冲突
        this.buffers.body.push(this._mergeSoftWraps(`$${math.tex}$`));
        this.buffers.body.push('');
      }
    }

    /** @param {{kind:'img'|'svg', path?:string, caption?:string, inlineSvg?:string}} fig */
    emitFigure(fig) {
      if (!fig) return;

      // 在插入图片前，若上一个 body 行不是空行，补一个空行，避免粘段
      this._ensureBlockGap();

      const caption = this._mergeSoftWraps(fig.caption || '');
      const captionLine = caption
        ? (this.cfg?.FIGURES?.captionStyle === 'italic' ? `*${caption}*` : caption)
        : '';

      if (fig.kind === 'img' && (fig.path || fig.src)) {
        const path = fig.path || fig.src;
        // 1) 图片行
        this.buffers.body.push(`![${caption}](${path})`);
        // 2) 紧跟一行图题（可见文本，包含 $..$ 的公式）
        if (captionLine) this.buffers.body.push(captionLine);
        // 3) 收尾空行
        this.buffers.body.push('');
        return;
      }

      if (fig.kind === 'svg') {
        if (this.cfg?.IMAGES?.inlineSvgInMarkdown && fig.inlineSvg) {
          // 1) 内联 SVG（占一整块）
          this.buffers.body.push(fig.inlineSvg);
          // 2) 紧跟一行图题
          if (captionLine) this.buffers.body.push(captionLine);
          // 3) 收尾空行
          this.buffers.body.push('');
        } else if (fig.path) {
          this.buffers.body.push(`![${caption}](${fig.path})`);
          if (captionLine) this.buffers.body.push(captionLine);
          this.buffers.body.push('');
        } else {
          this.buffers.body.push('<!-- TODO: SVG figure placeholder -->');
          if (captionLine) this.buffers.body.push(captionLine);
          this.buffers.body.push('');
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
        this.buffers.body.push('');
        return;
      }

      const headers = Array.isArray(table.headers) && table.headers.length ? table.headers : [];
      const rows = Array.isArray(table.rows) ? table.rows : [];

      const escapeCell = (s) => this._escapeTableCell(String(s ?? ''));
      const line = (arr, cols) => `| ${Array.from({ length: cols }, (_, i) => escapeCell(arr[i] ?? '')).join(' | ')} |`;

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
      this.buffers.body.push(`| ${Array.from({ length: cols }).map(() => '---').join(' | ')} |`);

      // 表体
      for (const r of rows) {
        this.buffers.body.push(line(r, cols));
      }
      this.buffers.body.push('');
    }

    /** 参考文献（文末） */
    emitReferences(bibItems) {
      if (!bibItems?.length) return;
      const out = this.buffers.references;
      out.push('## References');
      for (const it of bibItems) {
        let line = `[${it.num}] ${this._mergeSoftWraps(it.text || '')}`;
        // 附加 DOI/URL（避免重复）
        if (it.doi && !line.includes(it.doi)) line += ` DOI: ${it.doi}`;
        if (it.url && !line.includes(it.url)) line += ` URL: ${it.url}`;
        out.push(line);
      }
      out.push('');
    }

    /** 脚注：合并 F/R 两类脚注（顺序遵循调用次序） */
    emitFootnotes(footnoteItems) {
      if (!footnoteItems?.length) return;
      const out = this.buffers.footnotes;
      for (const f of footnoteItems) {
        if (!f?.key || !f?.content) continue;
        out.push(`[^${f.key}]: ${this._mergeSoftWraps(f.content)}`);
      }
      out.push('');
    }

    compose() {
      return [
        this.buffers.head.join('\n'),
        this.buffers.body.join('\n'),
        this.buffers.footnotes.join('\n'),
        this.buffers.references.join('\n'),
      ].join('\n');
    }

    // =============== 私有工具 ===============

    _mergeSoftWraps(s) {
      return String(s || '')
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\u00A0/g, ' ')
        .trim();
    }

    _escapeTableCell(s) {
      // 转义竖线与回车；保留基本 Markdown 可读性
      return s
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, '<br>')
        .replace(/\t/g, ' ')
        .trim();
    }

    /** 若 body 末尾不是空行，则补一个空行，保证块级元素前有分隔 */
    _ensureBlockGap() {
      const body = this.buffers?.body;
      if (!body || !body.length) return;
      // 找到最后一个非空元素
      for (let i = body.length - 1; i >= 0; i--) {
        const line = body[i];
        if (line === '') return;          // 已是空行，无需再加
        if (typeof line === 'string') {
          // 末行是非空字符串 -> 补一个空行
          body.push('');
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
    constructor(config = (typeof Config !== 'undefined' ? Config : {})) {
      this.cfg = Object.assign({
        IMAGES: { maxBytes: 2.5 * 1024 * 1024, maxDim: 4096, concurrency: 4, preferRaster: true }
      }, config);

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
      const logger = (typeof Log !== 'undefined') ? Log : console;
      try {
        if (!url) return { path: url };

        // dataURL 直接注册
        if (/^data:/i.test(url)) {
          const parsed = this._dataUrlToBlob(url);
          const name = this._uniqueName(this._filenameFromURL('image'), this._extFromMime(parsed.type));
          const assetPath = `assets/${name}`;
          const hash = await this._hashArrayBuffer(await parsed.blob.arrayBuffer());
          const idx = this._registerAsset({ name, blob: parsed.blob, mime: parsed.type, path: assetPath, dataURL: url, hash });
          return { path: url, assetPath, name, mime: parsed.type, bytes: parsed.blob.size };
        }

        // 跨域抓取 Blob
        const blob = await this._limit(() => this._getBlob(url));
        if (!blob) return { path: url };

        // GIF 动图：避免 Canvas 破坏动效；原样保留
        if (/image\/gif/i.test(blob.type)) {
          const name = this._uniqueName(this._filenameFromURL(url), '.gif');
          const assetPath = `assets/${name}`;
          const hash = await this._hashArrayBuffer(await blob.arrayBuffer());
          const idx = this._registerAsset({ name, blob, mime: 'image/gif', path: assetPath, hash });
          return { path: url, assetPath, name, mime: 'image/gif', bytes: blob.size };
        }

        // 其他位图：按需缩放/转码（优先 webp，回退 png）
        const maxDim = opts.maxDim || this.cfg.IMAGES.maxDim || 4096;
        const maxBytes = opts.maxBytes || this.cfg.IMAGES.maxBytes || (2.5 * 1024 * 1024);

        const scaled = await this._maybeScaleAndTranscode(blob, { maxDim, maxBytes });
        const outBlob = scaled.blob;
        const mime = outBlob.type || 'image/png';

        // 生成资源名与存储
        const name = this._uniqueName(this._filenameFromURL(url), this._extFromMime(mime));
        const assetPath = `assets/${name}`;
        const hash = await this._hashArrayBuffer(await outBlob.arrayBuffer());
        const idx = this._registerAsset({ name, blob: outBlob, mime, path: assetPath, hash });

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
        logger?.warn?.('AssetsManager.fetchRaster error:', err);
        return { path: url };
      }
    }

    /**
     * 记录/导出 SVG 资源
     * - 返回 inlineSvg 用于内联
     * - 同时注册 Blob 以便 TextBundle 落地
     */
    async registerSvg(svgElement, suggestedName = 'figure.svg') {
      const logger = (typeof Log !== 'undefined') ? Log : console;
      try {
        const serialized = this._serializeSvg(svgElement);
        const mime = 'image/svg+xml';
        const blob = new Blob([serialized], { type: mime });
        const ext = '.svg';
        const base = this._stripExt(suggestedName) || 'figure';
        const name = this._uniqueName(base, ext);
        const assetPath = `assets/${name}`;
        const hash = await this._hashArrayBuffer(await blob.arrayBuffer());

        this._registerAsset({ name, blob, mime, path: assetPath, hash });
        return { path: null, inlineSvg: serialized, assetPath, name, mime, bytes: blob.size };
      } catch (err) {
        logger?.warn?.('AssetsManager.registerSvg error:', err);
        return { path: null, inlineSvg: svgElement?.outerHTML || '<!-- svg -->' };
      }
    }

    /** 返回资源浅拷贝列表：[{name,mime,path,blob?,dataURL?}] */
    list() { return this.assets.slice(); }

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
      const a = (typeof assetOrIndex === 'number') ? this.assets[assetOrIndex] : assetOrIndex;
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
        const logger = (typeof Log !== 'undefined') ? Log : console;
        if (typeof GM_xmlhttpRequest === 'function') {
          try {
            GM_xmlhttpRequest({
              method: 'GET',
              url,
              responseType: 'blob',
              onload: (resp) => {
                const blob = resp.response;
                if (blob instanceof Blob) return resolve(blob);
                // 某些环境下是 ArrayBuffer
                if (resp.response && resp.response.byteLength) {
                  const type = this._contentTypeFromHeaders(resp.responseHeaders) || this._mimeFromURL(url) || 'application/octet-stream';
                  return resolve(new Blob([resp.response], { type }));
                }
                resolve(null);
              },
              onerror: (e) => reject(e),
            });
            return;
          } catch (e) {
            logger?.warn?.('GM_xmlhttpRequest failed, fallback to fetch:', e);
          }
        }
        // Fallback: fetch
        fetch(url, { mode: 'cors', credentials: 'omit' })
          .then(r => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`)))
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
      let type = preferWebP ? 'image/webp' : 'image/png';
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
        return { img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    async _drawToBlob(img, w, h, mime = 'image/png', q) {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      // 关闭插值锯齿
      if (ctx.imageSmoothingEnabled !== undefined) ctx.imageSmoothingEnabled = true;
      if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);

      // toBlob 异步更省内存；Safari 早期可能不支持，退回 toDataURL
      const blob = await new Promise((res) => {
        if (canvas.toBlob) {
          canvas.toBlob((b) => res(b || this._dataURLToBlob(canvas.toDataURL(mime, q)).blob), mime, q);
        } else {
          res(this._dataURLToBlob(canvas.toDataURL(mime, q)).blob);
        }
      });
      return blob;
    }

    async _supportsWebP() {
      if (typeof this._webpSupport !== 'undefined') return this._webpSupport;
      const c = document.createElement('canvas');
      const ok = c.toDataURL && c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
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
      const cleanBase = this._sanitizeName(base || 'asset');
      const cleanExt = ext && ext.startsWith('.') ? ext : (ext ? `.${ext}` : '');
      let n = `${cleanBase}${cleanExt}`;
      let i = 1;
      while (this._assetNames.has(n)) {
        n = `${cleanBase}_${String(++i).padStart(2, '0')}${cleanExt}`;
      }
      this._assetNames.add(n);
      return n;
    }

    _filenameFromURL(urlOrBase) {
      try {
        const u = new URL(urlOrBase, location.href);
        const last = u.pathname.split('/').filter(Boolean).pop() || 'image';
        return this._stripExt(this._sanitizeName(last));
      } catch {
        return this._stripExt(this._sanitizeName(String(urlOrBase || 'image')));
      }
    }

    _stripExt(name) {
      return String(name || '').replace(/\.[a-z0-9]+$/i, '');
    }

    _sanitizeName(s) {
      return String(s || 'asset').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'asset';
    }

    _extFromMime(mime) {
      mime = (mime || '').toLowerCase();
      if (mime.includes('image/webp')) return '.webp';
      if (mime.includes('image/png')) return '.png';
      if (mime.includes('image/jpeg') || mime.includes('image/jpg')) return '.jpg';
      if (mime.includes('image/svg')) return '.svg';
      if (mime.includes('image/gif')) return '.gif';
      return '.bin';
    }

    _mimeFromURL(url) {
      const m = String(url || '').toLowerCase().match(/\.(png|jpe?g|webp|gif|svg)\b/);
      if (!m) return null;
      const ext = m[1];
      return {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml'
      }[ext] || null;
    }

    async _blobToDataURL(blob) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
    }

    _dataUrlToBlob(dataURL) {
      const m = String(dataURL).match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
      if (!m) return { blob: new Blob([new Uint8Array(0)], { type: 'application/octet-stream' }), type: 'application/octet-stream' };
      const mime = m[1] || 'application/octet-stream';
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
        if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        if (!el.getAttribute('xmlns:xlink')) el.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
        const xml = new XMLSerializer().serializeToString(el);
        // 某些环境需在最前加入 XML 声明以增强兼容
        return /^<\?xml/i.test(xml) ? xml : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
      } catch {
        return svgEl?.outerHTML || '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      }
    }

    async _hashArrayBuffer(ab) {
      try {
        if (crypto?.subtle?.digest) {
          const buf = await crypto.subtle.digest('SHA-1', ab);
          const arr = Array.from(new Uint8Array(buf));
          return arr.map(b => b.toString(16).padStart(2, '0')).join('');
        }
      } catch { /* ignore */ }
      // 退化为简易字符串 hash（DJ2）
      let h = 5381, i = 0, u8 = new Uint8Array(ab);
      for (; i < u8.length; i++) h = ((h << 5) + h) + u8[i];
      return (h >>> 0).toString(16);
    }
  }

  // -----------------------------
  // 6) Exporter（三形态导出）
  // 依赖：可选 Config；不依赖第三方库
  // -----------------------------
  class Exporter {
    constructor(config = (typeof Config !== 'undefined' ? Config : {})) {
      this.cfg = config;
      this._assetsProvider = null; // 可绑定 AssetsManager 或 assets 数组
    }

    /** 绑定资源来源（AssetsManager 实例或 assets 数组） */
    bindAssets(providerOrArray) {
      this._assetsProvider = providerOrArray || null;
    }

    /** 纯链接版 Markdown（不嵌入资源） */
    async asMarkdownLinks(markdown) {
      return String(markdown || '');
    }

    /**
     * Base64 版 Markdown（把 assets/<name> 与 HTML src/href 内的相对路径替换为 dataURL）
     * @param {string} markdown
     * @param {Array<{name:string, mime:string, path:string, blob?:Blob, dataURL?:string}>=} assets
     */
    async asMarkdownBase64(markdown, assets) {
      let md = String(markdown || '');
      const list = await this._resolveAssets(assets);
      if (!list.length) return md;

      // 构建 path -> dataURL 映射（仅对含 blob 的资源）
      const path2data = new Map();
      for (const a of list) {
        const p = a.path || (a.name ? `assets/${a.name}` : null);
        if (!p) continue;
        const dataURL = a.dataURL || (a.blob ? await this._blobToDataURL(a.blob) : null);
        if (!dataURL) continue;
        path2data.set(p, dataURL);
        // 兼容常见相对写法
        path2data.set(`./${p}`, dataURL);
        path2data.set(`/${p}`, dataURL);
      }

      // 替换 Markdown 与 HTML 路径
      for (const [p, durl] of path2data.entries()) {
        // 1) Markdown 链接/图片：(assets/xxx)
        md = md.replace(new RegExp(`\\((\\s*?)${this._escReg(p)}(\\s*?)\\)`, 'g'), (_m, a, b) => `(${a}${durl}${b})`);
        // 2) HTML 属性：src="assets/xxx" / src='assets/xxx'
        md = md.replace(new RegExp(`(src|href)=(")${this._escReg(p)}(")`, 'g'), (_m, k, q1, q2) => `${k}=${q1}${durl}${q2}`);
        md = md.replace(new RegExp(`(src|href)=(')${this._escReg(p)}(')`, 'g'), (_m, k, q1, q2) => `${k}=${q1}${durl}${q2}`);
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
      const textMd = this._utf8(`\ufeff${String(markdown || '')}`); // 带 BOM 以兼容部分编辑器
      const info = {
        version: 2,
        type: 'net.daringfireball.markdown',   // 也可用 'public.plain-text'
        creatorIdentifier: 'qiqi.arxiv.md.exporter',
        transient: false
      };
      const infoJson = this._utf8(JSON.stringify(info, null, 2));

      files.push({ name: 'text.md', data: textMd });
      files.push({ name: 'info.json', data: infoJson });

      const list = await this._resolveAssets(assets);
      for (const a of list) {
        if (!a?.blob || !a?.name) continue;
        const data = new Uint8Array(await a.blob.arrayBuffer());
        files.push({ name: `assets/${a.name}`, data });
      }

      const zipBlob = await this._zip(files);
      return { filename: 'export.textbundle', blob: zipBlob };
    }

    // ============== 私有辅助 ==============

    async _resolveAssets(assetsMaybe) {
      if (Array.isArray(assetsMaybe)) return assetsMaybe;
      if (this._assetsProvider) {
        if (Array.isArray(this._assetsProvider)) return this._assetsProvider;
        if (typeof this._assetsProvider.list === 'function') {
          try { return this._assetsProvider.list() || []; } catch { /* ignore */ }
        }
      }
      // 尝试从全局钩子读取（可选）
      if (typeof window !== 'undefined' && Array.isArray(window.__ARXIV_MD_ASSETS__)) {
        return window.__ARXIV_MD_ASSETS__;
      }
      return [];
    }

    _escReg(s) {
      return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async _blobToDataURL(blob) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
    }

    _utf8(str) {
      return new TextEncoder().encode(String(str ?? ''));
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
        this._pushU32(localHeader, 0x04034b50);  // local file header sig
        this._pushU16(localHeader, 20);          // version needed
        this._pushU16(localHeader, 0);           // flags
        this._pushU16(localHeader, 0);           // method = 0 (stored)
        this._pushU16(localHeader, dosTime);     // time
        this._pushU16(localHeader, dosDate);     // date
        this._pushU32(localHeader, crc);         // CRC32
        this._pushU32(localHeader, data.length); // compressed size
        this._pushU32(localHeader, data.length); // uncompressed size
        this._pushU16(localHeader, nameBytes.length); // name length
        this._pushU16(localHeader, 0);           // extra length

        const localHeaderBytes = new Uint8Array(localHeader);
        const fileOffset = offset;
        offset += localHeaderBytes.length + nameBytes.length + data.length;

        files.push({
          nameBytes,
          data,
          crc,
          localHeaderBytes,
          fileOffset
        });
      }

      // 构建 central directory
      const central = [];
      for (const f of files) {
        const nameLen = f.nameBytes.length;
        const dataLen = f.data.length;

        this._pushU32(central, 0x02014b50);  // central file header sig
        this._pushU16(central, 20);          // version made by
        this._pushU16(central, 20);          // version needed
        this._pushU16(central, 0);           // flags
        this._pushU16(central, 0);           // method
        this._pushU16(central, dosTime);     // time
        this._pushU16(central, dosDate);     // date
        this._pushU32(central, f.crc);       // CRC
        this._pushU32(central, dataLen);     // comp size
        this._pushU32(central, dataLen);     // uncomp size
        this._pushU16(central, nameLen);     // name len
        this._pushU16(central, 0);           // extra len
        this._pushU16(central, 0);           // comment len
        this._pushU16(central, 0);           // disk number
        this._pushU16(central, 0);           // internal attrs
        this._pushU32(central, 0);           // external attrs
        this._pushU32(central, f.fileOffset);// relative offset
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

      const blob = new Blob(chunks, { type: 'application/zip' });
      return blob;
    }

    _pushU16(arr, n) {
      arr.push(n & 0xff, (n >>> 8) & 0xff);
    }
    _pushU32(arr, n) {
      arr.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    }

    _dosTime(d) {
      const h = d.getHours(), m = d.getMinutes(), s = Math.floor(d.getSeconds() / 2);
      return (h << 11) | (m << 5) | s;
    }
    _dosDate(d) {
      const y = d.getFullYear() - 1980, m = d.getMonth() + 1, day = d.getDate();
      return (y << 9) | (m << 5) | day;
    }

    // —— CRC32 —— //
    _crcTable() {
      if (this.__crcTable) return this.__crcTable;
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
      }
      this.__crcTable = table;
      return table;
    }
    _crc32(u8) {
      const tbl = this._crcTable();
      let c = 0 ^ (-1);
      for (let i = 0; i < u8.length; i++) {
        c = (c >>> 8) ^ tbl[(c ^ u8[i]) & 0xFF];
      }
      return (c ^ (-1)) >>> 0;
    }
  }

  // -----------------------------
  // 7) Controller（编排）· 完整实现
  // 依赖：ArxivAdapter / AssetsManager / MarkdownEmitter / Exporter / U / Log / Config
  // -----------------------------
  class Controller {
    constructor() {
      this.adapter = new ArxivAdapter(document);
      this.assets = new AssetsManager();
      this.emitter = new MarkdownEmitter();
      this.exporter = new Exporter();
      // 让 Exporter 能直接拿到资源列表
      this.exporter.bindAssets(this.assets);
    }

    /**
     * 端到端生成 Markdown
     * @param {'links'|'base64'|'textbundle'} mode
     */
    async runPipeline(mode = 'links') {
      Log.info('Pipeline start:', mode);

      const meta = this.adapter.getMeta();
      this._lastMeta = meta;
      const bib = this.adapter.collectBibliography();
      const citeMap = this.adapter.buildCitationMap(bib);
      const sections = this.adapter.walkSections();

      // 已引用参考号（用于生成 R* 脚注）
      this._cited = new Set();
      // 正文脚注（F*）
      const footF = [];

      // 清空段落去重缓存
      this._paraSeen = undefined;
      this._paraQueue = undefined;

      // 头部
      this.emitter.emitFrontMatter(meta);
      this.emitter.emitTOCPlaceholder();

      // 正文
      for (const sec of sections) {
        this.emitter.emitHeading(sec.level || 2, sec.title || 'Section', sec.anchor);

        for (const node of (sec.nodes || [])) {
          // 段落（含行内数学/引文替换 + 清噪 + 近邻去重）
          if (this._isParagraph(node)) {
            const text = this._renderParagraphWithMathAndCites(node, citeMap);
            this._emitParagraphDedup(text);
            continue;
          }

          // 块级数学
          if (this._isDisplayMath(node) ||
            (node.tagName?.toLowerCase() === 'math' && (node.getAttribute('display') || '').toLowerCase() === 'block')) {
            const m = this.adapter.extractMath(node);
            if (m) this.emitter.emitMath(m);
            continue;
          }

          // 图（位图优先；textbundle 落地 SVG 文件，其它模式内联）
          if (node.matches && node.matches('figure.ltx_figure')) {
            const fig = this.adapter.extractFigure(node);
            if (!fig) continue;

            if (fig.kind === 'img') {
              if (mode === 'links') {
                this.emitter.emitFigure({ kind: 'img', path: fig.src, caption: fig.caption });
              } else {
                const r = await this.assets.fetchRaster(fig.src);
                this.emitter.emitFigure({ kind: 'img', path: r.assetPath || r.path, caption: fig.caption });
              }
            } else if (fig.kind === 'svg') {
              if (mode === 'textbundle') {
                let svgEl = null;
                try {
                  if (fig.inlineSvg) {
                    svgEl = new DOMParser().parseFromString(fig.inlineSvg, 'image/svg+xml').documentElement;
                  } else if (node.querySelector) {
                    svgEl = node.querySelector('svg');
                  }
                } catch { }
                const r = await this.assets.registerSvg(svgEl, (fig.id ? `${fig.id}.svg` : 'figure.svg'));
                this.emitter.emitFigure({ kind: 'svg', path: r.assetPath, caption: fig.caption });
              } else {
                this.emitter.emitFigure({ kind: 'svg', inlineSvg: fig.inlineSvg, caption: fig.caption });
              }
            }
            continue;
          }

          // 表
          if (node.matches && node.matches('table.ltx_tabular')) {
            const t = this.adapter.extractTable(node);
            this.emitter.emitTable(t);
            continue;
          }

          // 列表（转行内数学与引文，再近邻去重逐行落）
          if (node.matches && node.matches('ul, ol')) {
            const lines = this._renderList(node, citeMap, 0);
            for (const l of lines) this._emitParagraphDedup(l);
            continue;
          }

          // 代码块
          if (node.matches && node.matches('pre.ltx_verbatim, .ltx_listing pre')) {
            const code = (node.textContent || '').replace(/\s+$/, '');
            this.emitter.emitParagraph('```\n' + code + '\n```');
            continue;
          }

          // 正文脚注
          if (node.matches && node.matches('div.ltx_note.ltx_role_footnote')) {
            const f = this.adapter.extractFootnote(node);
            if (f) footF.push(f);
            continue;
          }

          // 兜底：当作段落处理并去重
          const fallback = (node.textContent || '').trim();
          if (fallback) this._emitParagraphDedup(fallback);
        }
      }

      // 生成参考脚注（R*，直接写全参考条目文本+DOI/URL）
      const footR = this._makeReferenceFootnotes(bib, this._cited);

      // 合并 F*/R* 脚注并按 key 去重
      const footMap = new Map();
      for (const f of [...(footF || []), ...(footR || [])]) {
        if (f?.key && f?.content && !footMap.has(f.key)) footMap.set(f.key, f.content);
      }
      this.emitter.emitFootnotes([...footMap].map(([key, content]) => ({ key, content })));

      // 文末参考
      this.emitter.emitReferences(bib);

      // 收口
      const markdown = this.emitter.compose();
      return markdown;
    }

    // —— 导出 —— //

    async exportLinks() {
      const md = await this.runPipeline('links');
      await (typeof GM_setClipboard === 'function' ? GM_setClipboard(md, { type: 'text' }) : Promise.resolve());
      this._downloadText(md, this._suggestFileName('links', 'md'));     // ★ 改名
      alert('已生成 Links 版 Markdown。');
    }

    async exportBase64() {
      const md = await this.runPipeline('base64');
      const out = await this.exporter.asMarkdownBase64(md, this.assets.list());
      this._downloadText(out, this._suggestFileName('base64', 'md'));   // ★ 改名
      alert('已生成 Base64 版 Markdown。');
    }

    async exportTextBundle() {
      const md = await this.runPipeline('textbundle');
      const tb = await this.exporter.asTextBundle(md, this.assets.list());
      this._downloadBlob(tb.blob, this._suggestFileName('textbundle', 'textbundle')); // ★ 统一命名
      alert('已生成 TextBundle。');
    }

    // —— 节点类型判断 —— //
    _isParagraph(n) { return n.matches && (n.matches('div.ltx_para > p.ltx_p') || n.matches('p.ltx_p')); }
    _isDisplayMath(n) {
      if (!n?.matches) return false;
      if (n.matches('table.ltx_equation')) return true;
      // 只有“不在 table.ltx_equation 里的 block math”才算一条
      if (n.matches('math[display="block"]') && !n.closest('table.ltx_equation')) return true;
      return false;
    }

    // 追加：清理噪声文本
    _cleanNoiseText(s) {
      return String(s || '')
        // 去掉 arXiv 的提示垃圾
        .replace(/\bReport issue for preceding element\b/gi, '')
        .replace(/\bSee\s*\d+(\.\d+)?\b/gi, '')
        // 折叠多余空白
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\u00A0/g, ' ')
        .trim();
    }


    // —— 行内数学 + 引文处理 —— //
    _renderParagraphWithMathAndCites(pNode, citeMap) {
      const clone = pNode.cloneNode(true);

      // 行内 <math> → $...$
      for (const m of Array.from(clone.querySelectorAll('math'))) {
        const isDisplay = (m.getAttribute('display') || '').toLowerCase() === 'block';
        if (isDisplay) continue;
        const tex = this.adapter.extractMath(m)?.tex || '';
        m.replaceWith(document.createTextNode(tex ? `$${tex}$` : ''));
      }

      // 文中引文 → [^R{n}]
      for (const a of Array.from(clone.querySelectorAll('a[href*="#bib."]'))) {
        const href = a.getAttribute('href') || '';
        const key = this._normalizeBibHref(href);
        const n = citeMap.get(key) ?? this._parseBibNumber(href);
        if (n != null) this._cited.add(n);
        a.replaceWith(document.createTextNode(n != null ? `[^R${n}]` : (a.textContent || '')));
      }

      // 其它链接变纯文本
      for (const a of Array.from(clone.querySelectorAll('a'))) {
        a.replaceWith(document.createTextNode(a.textContent || ''));
      }

      return this._cleanNoiseText(clone.textContent || '');
    }


    // —— 列表渲染（简单 Markdown） —— //
    _renderList(listNode, citeMap, depth = 0) {
      const lines = [];
      const ordered = listNode.tagName.toLowerCase() === 'ol';
      let idx = 1;
      for (const li of Array.from(listNode.children)) {
        if (li.tagName?.toLowerCase() !== 'li') continue;
        // 把 li 中的块拆解：优先段落/内联
        const parts = [];
        // 先将行内数学和引用处理到文本
        const text = this._renderParagraphWithMathAndCites(li, citeMap);
        if (text) parts.push(text);

        const bullet = ordered ? `${idx}. ` : `- `;
        const indent = '  '.repeat(depth);
        const first = `${indent}${bullet}${parts.shift() || ''}`.trimEnd();
        if (first) lines.push(first);

        // 嵌套列表
        const sublists = Array.from(li.children).filter(c => /^(ul|ol)$/i.test(c.tagName));
        for (const sub of sublists) {
          lines.push(...this._renderList(sub, citeMap, depth + 1));
        }
        idx++;
      }
      return lines;
    }

    // 追加：近邻去重（保留最近 50 段的指纹）
    _emitParagraphDedup(text) {
      if (!this._paraSeen) { this._paraSeen = new Set(); this._paraQueue = []; }
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
      const lookup = new Map((bibItems || []).map(b => [b.num, b]));
      for (const n of nums) {
        const it = lookup.get(n);
        if (!it) continue;
        // 直接放整条参考文本 + DOI/URL（若未包含）
        let content = it.text || '';
        if (it.doi && !content.includes(it.doi)) content += ` DOI: ${it.doi}`;
        if (it.url && !content.includes(it.url)) content += ` URL: ${it.url}`;
        out.push({ key: `R${n}`, content: content.trim() });
      }
      return out;
    }

    // —— 工具 —— //
    _normalizeBibHref(href) {
      const m = String(href || '').match(/#(bib\.bib\d{1,4})\b/);
      return m ? `#${m[1]}` : href;
    }
    _parseBibNumber(s) {
      const m = String(s || '').match(/(?:bib\.bib)?(\d{1,4})\b/);
      return m ? parseInt(m[1], 10) : null;
    }
    _mergeSoftWraps(s) {
      return String(s || '')
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\u00A0/g, ' ')
        .trim();
    }

    // —— 文件下载 —— //
    _suggestFileName(tag, ext = 'md') {
      const { id } = U.parseArxivIdVersion();
      const rawTitle = (this._lastMeta?.title || document.title || 'untitled');

      const safeId = String(id || 'unknown').replace(/[^\w.-]+/g, '_');

      const safeTitle = String(rawTitle)
        .normalize('NFKC')                      // 统一宽度形态
        .replace(/\s+/g, '_')                   // 空格→下划线
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '') // 移除 Windows 不允许字符 & 控制符
        .replace(/\.+$/g, '')                   // 去掉结尾的点（Windows 不允许）
        .replace(/_{2,}/g, '_')                 // 合并多下划线
        .replace(/^_+|_+$/g, '')                // 去掉首尾下划线
        .slice(0, 120)                          // 控长度，避免过长文件名
        || 'untitled';

      const base = `arxiv_${safeId}_${safeTitle}_${tag}`;
      return ext ? `${base}.${ext}` : base;
    }

    _downloadText(text, filename) {
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      this._downloadBlob(blob, filename);
    }
    _downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
    }
  }
  // 8) UI（悬浮面板 · 懒加载预览）
  // -----------------------------
  const UI = {
    mount(controller) {
      const Z = (typeof Config !== 'undefined' && Config.UI?.zIndex) || 999999;
      const side = (typeof Config !== 'undefined' && Config.UI?.position) || 'right';

      GM_addStyle?.(`
      :root {
        --ax-bg: #ffffff; --ax-text: #111827; --ax-muted: #6b7280;
        --ax-border: #e5e7eb; --ax-panel: rgba(255,255,255,0.96);
        --ax-accent: #b31b1b; --ax-accent-600: #971616; --ax-shadow: 0 12px 32px rgba(0,0,0,.15);
      }
      @media (prefers-color-scheme: dark) {
        :root { --ax-bg:#0f1115; --ax-text:#e5e7eb; --ax-muted:#9ca3af; --ax-border:#30363d;
                --ax-panel: rgba(17,17,17,.92); --ax-accent:#cf3a3a; --ax-accent-600:#b32f2f; --ax-shadow:0 16px 40px rgba(0,0,0,.4); }
      }
      .arxiv-md-panel {
        position: fixed; ${side === 'right' ? 'right: 16px;' : 'left: 16px;'}
        bottom: 16px; z-index: ${Z};
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans CJK SC";
        background: var(--ax-panel); color: var(--ax-text);
        border: 1px solid var(--ax-border); border-radius: 12px;
        padding: 10px 10px; box-shadow: var(--ax-shadow);
        backdrop-filter: saturate(1.1) blur(6px);
        user-select: none;
      }
      .arxiv-md-panel__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px 0}
      .arxiv-md-panel__title{margin:0;font-size:13px;letter-spacing:.2px;font-weight:700;display:inline-flex;align-items:center;gap:6px}
      .arxiv-md-badge{display:inline-block;padding:2px 6px;font-size:11px;font-weight:700;color:#fff;background:var(--ax-accent);border-radius:999px}
      .arxiv-md-panel__drag{cursor:grab;opacity:.9;font-size:11px;color:var(--ax-muted)}
      .arxiv-md-panel__drag:active{cursor:grabbing}
      .arxiv-md-panel__btns{display:flex;flex-wrap:wrap;gap:6px}
      .arxiv-md-btn{margin:0;padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:var(--ax-accent);color:#fff;font-weight:700;font-size:12px;box-shadow:0 1px 0 rgba(0,0,0,.08)}
      .arxiv-md-btn:hover{background:var(--ax-accent-600)}
      .arxiv-md-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}
      .arxiv-md-btn--secondary{background:transparent;color:var(--ax-text);border:1px solid var(--ax-border)}
      .arxiv-md-btn--secondary:hover{background:rgba(0,0,0,.05)}
      .arxiv-md-btn--ghost{background:transparent;color:var(--ax-muted)}
      .arxiv-md-btn--ghost:hover{color:var(--ax-text)}
      .arxiv-md-hide{display:none!important}

      /* 预览层（懒加载后才注入 DOM） */
      .arxiv-md-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:${Z + 1};display:none}
      .arxiv-md-modal{position:fixed;inset:5% 8%;background:var(--ax-bg);color:var(--ax-text);border:1px solid var(--ax-border);border-radius:12px;box-shadow:var(--ax-shadow);display:none;z-index:${Z + 2};overflow:hidden;display:flex;flex-direction:column}
      .arxiv-md-modal__bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ax-border)}
      .arxiv-md-modal__title{font-size:13px;font-weight:700}
      .arxiv-md-modal__tools{display:flex;gap:6px;align-items:center}
      .arxiv-md-modal__select{font-size:12px;padding:4px 6px}
      .arxiv-md-modal__body{flex:1;overflow:auto;padding:12px;background:linear-gradient(180deg,rgba(0,0,0,.02),transparent 60%)}
      .arxiv-md-modal__pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Microsoft Yahei Mono",monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.45;padding:12px;border:1px dashed var(--ax-border);border-radius:8px;background:#fff0}
      @media (prefers-color-scheme: dark){.arxiv-md-modal__pre{background:rgba(255,255,255,.02)}}
    `);

      // 面板
      const panel = document.createElement('div');
      panel.className = 'arxiv-md-panel';
      panel.innerHTML = `
      <div class="arxiv-md-panel__head">
        <div class="arxiv-md-panel__title">
          <span class="arxiv-md-badge">arXiv</span>
          <span>Markdown 导出</span>
        </div>
        <button class="arxiv-md-btn arxiv-md-btn--ghost" data-action="toggle">折叠</button>
        <span class="arxiv-md-panel__drag" title="拖拽移动位置">⇕</span>
      </div>
      <div class="arxiv-md-panel__btns" data-role="buttons">
        <button class="arxiv-md-btn" data-action="preview" data-mode="links">预览 · Links</button>
        <button class="arxiv-md-btn arxiv-md-btn--secondary" data-action="preview" data-mode="base64">预览 · Base64</button>
        <button class="arxiv-md-btn" data-action="links">导出 · 链接</button>
        <button class="arxiv-md-btn" data-action="base64">导出 · Base64</button>
        <button class="arxiv-md-btn arxiv-md-btn--secondary" data-action="textbundle">导出 · TextBundle</button>
      </div>
    `;
      document.body.appendChild(panel);

      // 折叠
      const btns = panel.querySelector('[data-role="buttons"]');
      panel.querySelector('[data-action="toggle"]')?.addEventListener('click', () => {
        btns.classList.toggle('arxiv-md-hide');
      });

      // 按钮事件（预览为懒加载）
      panel.addEventListener('click', async (e) => {
        const btn = e.target;
        if (!(btn instanceof HTMLButtonElement)) return;
        const act = btn.getAttribute('data-action');
        try {
          if (act === 'links') return controller.exportLinks();
          if (act === 'base64') return controller.exportBase64();
          if (act === 'textbundle') return controller.exportTextBundle();
          if (act === 'preview') {
            const mode = btn.getAttribute('data-mode') || 'links';
            const md = await UI._genMarkdownForPreview(controller, mode);
            const { overlay, modal } = UI._ensurePreview();   // ★ 懒加载
            UI._openPreview(modal, overlay, md, mode, controller);
          }
        } catch (err) {
          (typeof Log !== 'undefined' ? Log : console).error(err);
          alert('执行失败：' + (err?.message || err));
        }
      });

      // 拖拽与位置持久化
      const dragHandle = panel.querySelector('.arxiv-md-panel__drag');
      let dragging = false, sx = 0, sy = 0, startRect = null;
      const saved = UI._loadPos();
      if (saved) {
        panel.style.left = saved.left != null ? `${saved.left}px` : '';
        panel.style.right = saved.right != null ? `${saved.right}px` : '';
        panel.style.top = saved.top != null ? `${saved.top}px` : '';
        panel.style.bottom = saved.bottom != null ? `${saved.bottom}px` : '';
      }
      const onMove = (ev) => {
        if (!dragging) return;
        const dx = ev.clientX - sx; const dy = ev.clientY - sy;
        let left = startRect.left + dx; let top = startRect.top + dy;
        left = Math.max(8, Math.min(window.innerWidth - startRect.width - 8, left));
        top = Math.max(8, Math.min(window.innerHeight - startRect.height - 8, top));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.right = '';
        panel.style.top = `${Math.round(top)}px`;
        panel.style.bottom = '';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        UI._savePos(panel);
      };
      dragHandle?.addEventListener('mousedown', (ev) => {
        dragging = true; sx = ev.clientX; sy = ev.clientY; startRect = panel.getBoundingClientRect();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    },

    // 懒加载预览 DOM（只在点击预览时创建）
    _ensurePreview() {
      let overlay = document.querySelector('.arxiv-md-overlay');
      let modal = document.querySelector('.arxiv-md-modal');
      if (overlay && modal) return { overlay, modal };

      overlay = document.createElement('div');
      overlay.className = 'arxiv-md-overlay';
      modal = document.createElement('div');
      modal.className = 'arxiv-md-modal';
      modal.innerHTML = `
      <div class="arxiv-md-modal__bar">
        <div class="arxiv-md-modal__title">Markdown 预览</div>
        <div class="arxiv-md-modal__tools">
          <select class="arxiv-md-modal__select" data-role="mode">
            <option value="links" selected>Links</option>
            <option value="base64">Base64</option>
          </select>
          <button class="arxiv-md-btn arxiv-md-btn--secondary" data-action="copy">复制</button>
          <button class="arxiv-md-btn" data-action="download">下载 .md</button>
          <button class="arxiv-md-btn arxiv-md-btn--ghost" data-action="close">关闭</button>
        </div>
      </div>
      <div class="arxiv-md-modal__body">
        <pre class="arxiv-md-modal__pre" data-role="content">加载中...</pre>
      </div>
    `;
      document.body.appendChild(overlay);
      document.body.appendChild(modal);

      // 事件仅在首次创建时绑定
      overlay.addEventListener('click', () => UI._closePreview(modal, overlay));
      modal.addEventListener('click', async (e) => {
        const el = e.target;
        if (!(el instanceof HTMLButtonElement)) return;
        const act = el.getAttribute('data-action');
        if (act === 'close') return UI._closePreview(modal, overlay);
        if (act === 'copy') {
          const md = modal.querySelector('[data-role="content"]')?.textContent || '';
          if (typeof GM_setClipboard === 'function') GM_setClipboard(md, { type: 'text' });
          else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(md);
        }
        if (act === 'download') {
          const md = modal.querySelector('[data-role="content"]')?.textContent || '';
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
          a.download = 'arxiv_preview.md'; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 0);
        }
      });
      modal.querySelector('[data-role="mode"]')?.addEventListener('change', async (e) => {
        const mode = e.target.value;
        const md = await UI._genMarkdownForPreview(window.__AX_CTRL__, mode);
        const pre = modal.querySelector('[data-role="content"]');
        pre.textContent = md;
      });

      return { overlay, modal };
    },

    async _genMarkdownForPreview(controller, mode) {
      const md = await controller.runPipeline(mode);
      if (mode === 'base64') return await controller.exporter.asMarkdownBase64(md, controller.assets.list());
      return md;
    },

    _openPreview(modal, overlay, md, mode) {
      const select = modal.querySelector('[data-role="mode"]');
      const useMode = mode || 'links';
      if (select) select.value = useMode;
      modal.querySelector('[data-role="content"]').textContent = md || '';
      overlay.style.display = 'block'; modal.style.display = 'flex';
    },
    _closePreview(modal, overlay) {
      overlay.style.display = 'none'; modal.style.display = 'none';
    },

    _savePos(panel) {
      const r = panel.getBoundingClientRect();
      localStorage.setItem('axmd.panel.pos', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    },
    _loadPos() {
      try { return JSON.parse(localStorage.getItem('axmd.panel.pos') || 'null'); } catch { return null; }
    }
  };

  // -----------------------------
  // 9) Boot（不做任何预览调用）
  // -----------------------------
  function boot() {
    try {
      const ok = /\/html\/\d{4}\.\d{5}v\d+/.test(location.pathname);
      if (!ok) {
        (typeof Log !== 'undefined' ? Log : console).warn('[arXiv → Markdown] 当前不在 arXiv HTML 视图，UI 不加载。');
        return;
      }
      const ctrl = new Controller();
      // 供懒加载预览的 change 事件访问
      window.__AX_CTRL__ = ctrl; // 可选：若不喜欢全局可改闭包
      UI.mount(ctrl);
      (typeof Log !== 'undefined' ? Log : console).info(`[${(typeof Config !== 'undefined' ? Config.APP_NAME : 'arXiv → Markdown')}] UI mounted`);
    } catch (err) {
      (typeof Log !== 'undefined' ? Log : console).error('Boot error:', err);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();