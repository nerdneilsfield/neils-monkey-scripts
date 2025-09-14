// ==UserScript==
// @name         Springer Chapter to Markdown Exporter (Framework)
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  Export SpringerLink chapter pages to Markdown (Links/Base64/TextBundle) — Framework Only
// @author       qiqi
// @match        https://link.springer.com/chapter/*
// @match        https://link.springer.com/article/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      link.springer.com
// @connect      media.springernature.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/turndown/7.1.2/turndown.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/springer-markdown-exporter.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/springer-markdown-exporter.user.js
// ==/UserScript==

/* eslint-disable no-console */
(function () {
    'use strict';

    // -----------------------------
    // 0) Config & Feature Flags
    // -----------------------------
    const Config = {
        APP_NAME: 'Springer → Markdown',
        VERSION: '0.1.0-framework',
        BASE_ORIGIN: 'https://link.springer.com',
        UI: {
            zIndex: 999999,
            position: 'right',
        },
        CITATION: {
            style: 'footnote+references', // 'footnote+references' | 'bracket+references'
            namespaces: { reference: 'R', footnote: 'F' },
        },
        IMAGES: {
            preferRaster: true,
            inlineSvgInMarkdown: true,
            embedSvgInTextBundle: true,
            maxBytes: 2.5 * 1024 * 1024,
            maxDim: 4096,
            concurrency: 4,
        },
        FIGURES: { captionStyle: 'plain' }, // or 'italic'
        MATH: {
            displayTag: 'inline',
            normalizeDelimiters: true,
            decodeEntitiesInsideMath: true,
        },
        TABLES: { downcast: 'auto', maxColsMarkdown: 12 }, // 'auto' | 'html' | 'markdown'
        PACK: { provider: 'native' }, // skeleton: built-in zipper in Exporter
    };

    // -----------------------------
    // 1) Logger
    // -----------------------------
    const Log = {
        entries: [],
        info: (...a) => {
            console.log(`[${Config.APP_NAME}]`, ...a);
            Log._addEntry('info', ...a);
        },
        warn: (...a) => {
            console.warn(`[${Config.APP_NAME}]`, ...a);
            Log._addEntry('warn', ...a);
        },
        error: (...a) => {
            console.error(`[${Config.APP_NAME}]`, ...a);
            Log._addEntry('error', ...a);
        },
        _addEntry: (level, ...args) => {
            const timestamp = new Date().toISOString();
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            Log.entries.push({ timestamp, level, message });
            Log._updateUI();
        },
        _updateUI: () => {
            const logPanel = document.querySelector('[data-role="debug-log"]');
            if (logPanel && !logPanel.classList.contains('spring-md-hide')) {
                const content = logPanel.querySelector('.spring-md-log__content');
                if (content) {
                    content.textContent = Log.entries.map(entry => 
                        `[${entry.timestamp.substring(11, 19)}] ${entry.level.toUpperCase()}: ${entry.message}`
                    ).join('\n');
                    content.scrollTop = content.scrollHeight;
                }
            }
        },
        clear: () => {
            Log.entries = [];
            Log._updateUI();
        },
        copy: () => {
            const logText = Log.entries.map(entry => 
                `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`
            ).join('\n');
            navigator.clipboard.writeText(logText).then(() => {
                console.log('Debug log copied to clipboard');
            }).catch(err => {
                console.error('Failed to copy log:', err);
            });
        }
    };

    // -----------------------------
    // 2) Utils
    // -----------------------------
    const U = {
        $(sel, root) { return (root || document).querySelector(sel); },
        $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); },
        text(node) { return (node?.textContent || '').trim(); },
        attr(node, name) { return node?.getAttribute?.(name) || null; },

        mergeSoftWraps(s) {
            return String(s || '')
                .replace(/[ \t]*\n[ \t]*/g, ' ')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/\u00A0/g, ' ')
                .trim();
        },

        absolutize(url, baseHref = null) {
            try {
                if (!url) return url;
                url = String(url).trim();
                if (/^(?:https?|data|blob|mailto|tel):/i.test(url)) return url;
                if (/^\/\//.test(url)) return 'https:' + url; // protocol-relative
                if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+/i.test(url)) return 'https://' + url; // bare host
                const baseAbs = baseHref || (U.$('base')?.getAttribute('href')) || location.href;
                return new URL(url, baseAbs).toString();
            } catch { return url; }
        },

        delay(ms) { return new Promise(r => setTimeout(r, ms)); },

        slug(s) {
            return String(s || '')
                .toLowerCase()
                .replace(/[^a-z0-9\- ]/g, '')
                .replace(/\s+/g, '-')
                .slice(0, 80);
        },
    };

    // -----------------------------
    // 3) SpringerAdapter（解析层）
    // -----------------------------
    // -----------------------------
    class SpringerAdapter {
        /**
         * @param {Document} doc
         */
        constructor(doc) {
            this.doc = doc;
            this.baseHref = this._baseHref();
            this.origin = location.origin || Config.BASE_ORIGIN;

            const metaDOI = U.$('meta[name="citation_doi"]')?.getAttribute('content') || '';
            this.doi = metaDOI || this._parseDOIFromPage() || null;

            this.links = {
                html: location.href,
                doi: this.doi ? `https://doi.org/${this.doi.replace(/^https?:\/\/doi\.org\//i, '')}` : null,
                pdf: U.$('meta[name="citation_pdf_url"]')?.getAttribute('content') || this._derivePdfUrl(),
            };
        }

        // ===== Public API =====

        getMeta() {
            const title =
                U.text(U.$('h1.c-article-title')) ||
                U.$('meta[property="og:title"]')?.getAttribute('content') ||
                document.title ||
                'Untitled';

            const authors = this._parseAuthorsFromMeta();
            const abstract = this._parseAbstract();
            return { title, authors, abstract, doi: this.doi, links: this.links };
        }

        // 1) 直接替换：主动点击“References”标签再抓侧栏引用
        async collectBibliography() {
            // 允许两种写法：#Bib1 或 <section aria-labelledby="Bib1">
            const sec = document.querySelector('section#Bib1, section[aria-labelledby="Bib1"]');
            if (!sec) return [];

            // 主体列表
            const list = sec.querySelectorAll('ol.c-article-references > li.c-article-references__item, ol.c-article-references > li, li.c-article-references__item');
            if (!list || !list.length) return [];

            return this._parseBibListMain(list);
        }

        buildCitationMap(bibItems) {
            const map = new Map();
            const base = (this.links?.html) || location.href;

            for (const it of (bibItems || [])) {
                if (!it?.id || typeof it.num !== 'number') continue;
                const id = it.id;                  // e.g., 'ref-CR7'
                const hash = id.startsWith('#') ? id : `#${id}`;
                map.set(id, it.num);
                map.set(hash, it.num);
                map.set(`${base.replace(/#.*$/, '')}${hash}`, it.num);
            }

            // 正文里的 a[href] 变体兜底
            const sel = 'a[href^="#ref-CR"], a[href*="#ref-CR"]';
            for (const a of document.querySelectorAll(sel)) {
                const href = a.getAttribute('href') || '';
                const n = this._parseRefNumber(href);
                if (Number.isInteger(n) && !map.has(href)) map.set(href, n);
            }
            return map;
        }

        extractEquationBlock(divEl) {
            if (!divEl) return null;
            // 优先 MathJax 的 TeX
            const sc = divEl.querySelector('script[type^="math/tex"]');
            if (sc) {
                const tex = (sc.textContent || '').trim();
                if (tex) return { type: 'display', tex };
            }
            // 次选：MathJax_SVG 的 data-mathml → 走已有 mmlToTex 兜底
            const mj = divEl.querySelector('.MathJax_SVG[ data-mathml], .MathJax_SVG[data-mathml]');
            const dataM = mj?.getAttribute('data-mathml') || '';
            if (dataM) {
                try {
                    const m = new DOMParser().parseFromString(dataM, 'text/xml').documentElement;
                    const tex = this._mmlToTex(m);
                    if (tex) return { type: 'display', tex };
                } catch { }
            }
            return null;
        }

        walkSections() {
            const out = [];
            const isRefTitle = (t) => /^\s*(references|bibliography)\s*$/i.test(String(t || ''));

            const h2s = U.$all('h2.c-article-section__title.js-section-title');
            for (const h2 of h2s) {
                const sec = h2.closest('section') || h2.parentElement;
                const content = sec?.querySelector('.c-article-section__content') || null;
                const h2Title = U.mergeSoftWraps(U.text(h2) || 'Section');
                if (isRefTitle(h2Title)) continue;

                const h2Anchor = sec?.id || U.slug(h2Title);
                const nodesH2 = [];
                if (content) {
                    for (let el = content.firstElementChild; el; el = el.nextElementSibling) {
                        if (el.matches('h3.c-article__sub-heading, h4.c-article__sub-sub-heading, h2.c-article-section__title')) break;
                        if (el.matches('div.c-article-equation')) { nodesH2.push(el); continue; }
                        if (/^(P|FIGURE|UL|OL|PRE|TABLE)$/i.test(el.tagName)) { nodesH2.push(el); continue; }
                        // wrapper：只取一层直接孩子，避免把后续 H3 区内容一网打尽
                        nodesH2.push(...el.querySelectorAll(':scope > p, :scope > figure, :scope > ul, :scope > ol, :scope > pre, :scope > table, :scope > div.c-article-equation'));
                    }
                }
                out.push({ level: 2, title: h2Title, anchor: h2Anchor, nodes: nodesH2 });

                if (!content) continue;
                // H3 子节
                for (const h3 of content.querySelectorAll('h3.c-article__sub-heading')) {
                    const h3Title = U.mergeSoftWraps(U.text(h3) || 'Subsection');
                    if (isRefTitle(h3Title)) continue;
                    const h3Anchor = h3.id || U.slug(`${h2Anchor}-${h3Title}`);

                    const nodesH3 = [];
                    for (let el = h3.nextElementSibling; el && content.contains(el); el = el.nextElementSibling) {
                        if (el.matches('h3.c-article__sub-heading, h4.c-article__sub-sub-heading, h2.c-article-section__title')) break;
                        if (el.matches('div.c-article-equation')) { nodesH3.push(el); continue; }
                        if (/^(P|FIGURE|UL|OL|PRE|TABLE)$/i.test(el.tagName)) { nodesH3.push(el); continue; }
                        nodesH3.push(...el.querySelectorAll(':scope > p, :scope > figure, :scope > ul, :scope > ol, :scope > pre, :scope > table, :scope > div.c-article-equation'));
                    }
                    out.push({ level: 3, title: h3Title, anchor: h3Anchor, nodes: nodesH3 });
                }
            }
            return out;
        }

        // ===== Element-level extractors =====

        extractParagraph(p) { return U.mergeSoftWraps(U.text(p)); }

        /**
         * 轻量 MathML → TeX（常见 Springer 章节无 MathML，此处是兜底）
         * @param {Element} node <math> 或其父块
         */
        extractMath(node) {
            const m = node?.tagName?.toLowerCase() === 'math' ? node : node?.querySelector?.('math');
            if (!m) return null;
            const tex = this._mmlToTex(m);
            // display 判定：有无 block 容器/是否带 display=block
            const isDisplay = (m.getAttribute('display') || '').toLowerCase() === 'block' ||
                (node && /^(div|p|table|section)$/i.test(node.tagName));
            const tag = this._findEquationNumberNearby(node);
            return { type: isDisplay ? 'display' : 'inline', tex, tag };
        }

        /**
         * 图：优先页内 <img> / <svg>；若存在 “Full size image” 链接 → 二跳抓高清图
         * @returns {{kind:'img'|'svg', src?:string, inlineSvg?:string, caption?:string, id?:string}|null}
         */
        async extractFigure(fig) {
            if (!fig) return null;

            // 表样式 figure —— 不当图处理，留给 extractTable
            if (this.isTableLikeFigure(fig)) return null;

            const id = fig.getAttribute('id') || null;

            // 标题：<figcaption><b>Fig. N.</b> + 下方描述
            const labelEl = fig.querySelector('figcaption b.c-article-section__figure-caption,[data-test="figure-caption-text"]');
            const label = labelEl ? (labelEl.textContent || '').trim().replace(/\s+/g, ' ') : '';
            const descEl = fig.querySelector('.c-article-section__figure-description,[data-test="bottom-caption"]');
            const desc = descEl ? U.mergeSoftWraps(descEl.textContent || '') : '';
            let caption = this._cleanCaption ? this._cleanCaption(label, desc) : `${label}${label && desc ? ' ' : ''}${desc}`;

            // inline <img> / <source srcset>
            const inlineImg = fig.querySelector('img, picture source[srcset]');
            const inlinePick = inlineImg
                ? (inlineImg.tagName.toLowerCase() === 'img'
                    ? this._pickImgSource(inlineImg)
                    : (this._bestFromSrcset(inlineImg.getAttribute('srcset') || '') || null))
                : null;
            const inlineUrl = inlinePick ? U.absolutize(inlinePick, this.baseHref) : null;

            // “Full size image” → /figures/{n}
            const jumpA = fig.querySelector('a[data-test="img-link"], a[aria-label^="Full size image"], a[href*="/figures/"]');
            if (jumpA) {
                const url = U.absolutize(jumpA.getAttribute('href') || '', this.baseHref);
                const sat = await (this._getSatelliteFigureDataWithRetry ? this._getSatelliteFigureDataWithRetry(url, 3) : null);
                if (sat?.src) {
                    caption = sat.caption || caption;
                    return { kind: 'img', src: sat.src, caption, id };
                }
            }

            // 用主文图
            if (inlineUrl) return { kind: 'img', src: inlineUrl, caption, id };

            // inline SVG（排除UI小图标）
            const svg = fig.querySelector('svg');
            if (svg && !this.isSvgIcon(svg)) return { kind: 'svg', inlineSvg: svg.outerHTML, caption, id };

            return null;
        }
        /**
         * 表：若本页无 <table>，则尝试 “Full size table” 二跳抓取；最终转为 headers/rows 或 html 降级
         * @returns {{headers?:string[][], rows?:string[][], html?:string}}
         */
        async extractTable(root) {
            if (!root) return { html: '' };

            // 1) 优先：Full size table 链接 → 卫星页
            const tlink = this._selectTableLinkFromNode(root);
            if (tlink) {
                const sat = await (this._getSatelliteTableDataWithRetry ? this._getSatelliteTableDataWithRetry(tlink, 3) : null);
                if (sat?.tableHtml) {
                    const titleHtml = sat.title ? `<div class="table-caption">${U.mergeSoftWraps(sat.title)}</div>\n` : '';
                    return { html: `${titleHtml}${sat.tableHtml}` };
                }
                return { html: `<p><a href="${tlink}" target="_blank" rel="noopener">Open full size table</a></p>` };
            }

            // 2) 主文若真的内嵌了 <table>
            const table = root.tagName.toLowerCase() === 'table' ? root : root.querySelector?.('table');
            if (table) {
                const hasSpan = !!table.querySelector('[rowspan],[colspan]');
                if (hasSpan || (Config.TABLES?.downcast === 'html')) return { html: table.outerHTML };
                return this._tableToMatrix(table);
            }

            // 3) 若传进来的是“表样式 figure”但暂时没有链接，尝试从父容器找链接
            if (root.tagName && root.tagName.toLowerCase() === 'figure' && this.isTableLikeFigure(root)) {
                const parent = root.closest('.c-article-table,[data-container-section="table"]') || root.parentElement;
                const link2 = parent ? this._selectTableLinkFromNode(parent) : null;
                if (link2) {
                    const sat = await (this._getSatelliteTableDataWithRetry ? this._getSatelliteTableDataWithRetry(link2, 3) : null);
                    if (sat?.tableHtml) {
                        const titleHtml = sat.title ? `<div class="table-caption">${U.mergeSoftWraps(sat.title)}</div>\n` : '';
                        return { html: `${titleHtml}${sat.tableHtml}` };
                    }
                    return { html: `<p><a href="${link2}" target="_blank" rel="noopener">Open full size table</a></p>` };
                }
            }

            // 4) 兜底占位
            return { html: `<p>Table not found. Please open the full size table on Springer.</p>` };
        }
        extractFootnote(node) {
            // Springer 结构化脚注较少，这里保持接口
            if (!node) return null;
            const id = node.getAttribute?.('id') || '';
            const content = U.mergeSoftWraps(U.text(node));
            if (!content) return null;
            const key = id ? `F_${id}` : null;
            if (!key) return null;
            return { key, content };
        }

        // —— 判定：这是表容器吗？（主文）——
        isTableContainer(node) {
            if (!node || !node.matches) return false;
            return node.matches('.c-article-table, [data-container-section="table"]');
        }

        // —— 判定：这是“表样式 figure”吗？（figure 外形，但其实是表的壳）——
        isTableLikeFigure(fig) {
            if (!fig) return false;
            if (fig.closest && fig.closest('.c-article-table')) return true;
            if (fig.querySelector && (
                fig.querySelector('[data-test="table-caption"], .c-article-table__figcaption') ||
                fig.querySelector('a[data-test="table-link"], a[aria-label^="Full size table"], a[href*="/tables/"]') ||
                fig.querySelector('table')
            )) return true;
            return false;
        }

        // —— 小图标 svg？（u-icon 或极小尺寸）——
        isSvgIcon(svgEl) {
            if (!svgEl) return false;
            if (svgEl.closest && svgEl.closest('.u-icon')) return true;
            const w = parseInt(svgEl.getAttribute('width') || '0', 10) || 0;
            const h = parseInt(svgEl.getAttribute('height') || '0', 10) || 0;
            return (w && h && (w <= 32 || h <= 32));
        }

        // —— 从节点里挑 “Full size table” 链接 —— 
        _selectTableLinkFromNode(root) {
            if (!root?.querySelector) return null;
            const a = root.querySelector('a[data-test="table-link"], a[aria-label^="Full size table"], a[href*="/tables/"]');
            return a ? U.absolutize(a.getAttribute('href') || '', this.baseHref) : null;
        }

        // ===== Internals =====


        // —— 通用重试 —— //
        async _getSatelliteFigureDataWithRetry(url, tries = 3) {
            let delay = 220;
            for (let i = 0; i < tries; i++) {
                const out = await this._getSatelliteFigureData(url).catch(() => null);
                if (out?.src) return out;
                await this._sleep(delay); delay = Math.min(1200, Math.floor(delay * 1.8));
            }
            return null;
        }

        async _getSatelliteTableDataWithRetry(url, tries = 3) {
            let delay = 220;
            for (let i = 0; i < tries; i++) {
                const out = await this._getSatelliteTableData(url).catch(() => null);
                if (out?.tableHtml) return out;
                await this._sleep(delay); delay = Math.min(1200, Math.floor(delay * 1.8));
            }
            return null;
        }

        // —— Figure 卫星页解析：<h1> + bottom caption + full 图 —— //
        async _getSatelliteFigureData(url) {
            const doc = await this._fetchDoc(url);
            if (!doc) return null;

            // 标题：<h1 class="c-article-satellite-title u-h1" data-test="top-caption" id="Fig3">Fig. 3.</h1>
            const h1 = doc.querySelector('main h1.c-article-satellite-title,[data-test="top-caption"]');
            const pageLabel = h1 ? (h1.textContent || '').trim().replace(/\s+/g, ' ') : '';

            // 描述：<div class="c-article-figure-description" data-test="bottom-caption" id="figure-3-desc"><p>…</p></div>
            const bottomDesc = doc.querySelector('main .c-article-figure-description,[data-test="bottom-caption"]');
            const pageDesc = bottomDesc ? U.mergeSoftWraps(bottomDesc.textContent || '') : '';

            // 组合 caption
            const caption = this._cleanCaption(pageLabel, pageDesc);

            // 图片：优先 <picture><source srcset="…/full/…">；再 fallback 到 <img src>
            const source = doc.querySelector('main picture source[srcset]');
            if (source) {
                const best = this._bestFromSrcset(source.getAttribute('srcset') || '');
                if (best) return { src: U.absolutize(best, url), caption };
            }
            const img = doc.querySelector('main img[src]');
            if (img) return { src: U.absolutize(img.getAttribute('src'), url), caption };

            return { src: null, caption };
        }

        // —— Table 卫星页解析：<h1 id="table-1-title">…</h1> + .c-article-table-container table —— //
        async _getSatelliteTableData(url) {
            const doc = await this._fetchDoc(url);
            if (!doc) return null;

            // 标题
            const h1 = doc.querySelector('main h1.c-article-satellite-title[id^="table-"][id$="-title"], main h1.c-article-satellite-title');
            const title = h1 ? (h1.textContent || '').trim().replace(/\s+/g, ' ') : '';

            // 表：严格从容器取，避免抓到正文段落
            const t = doc.querySelector('main .c-article-table-container table, main .c-table-scroll-wrapper__content table, main table.data, main table');
            if (t) {
                // 仅取 table.outerHTML，避免混入外围正文文本
                return { title, tableHtml: t.outerHTML };
            }
            return { title, tableHtml: null };
        }

        // —— 细节工具 —— //
        _cleanCaption(label, desc) {
            const L = (label || '').replace(/\s+/g, ' ').trim();
            const D = U.mergeSoftWraps(desc || '');
            if (L && D) return `${L} ${D.replace(/^\s*Fig\.\s*\d+\.?\s*/i, '')}`;
            return L || D || '';
        }

        _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        _parseBibListMain(nodeList) {
            const out = [];
            let auto = 1;

            for (const li of Array.from(nodeList)) {
                // 文本段（通常在 <p class="c-article-references__text" id="ref-CRn">）
                const textP = li.querySelector('.c-article-references__text') || li;
                const idRaw = textP.getAttribute('id') || li.getAttribute('id') || '';
                const numById = this._parseRefNumber(idRaw);

                // data-counter="1." 也可兜底取号
                const dc = (li.getAttribute('data-counter') || '').trim();
                const numByDC = dc ? parseInt(dc, 10) : null;

                const num = Number.isInteger(numById) && numById > 0
                    ? numById
                    : (Number.isInteger(numByDC) && numByDC > 0 ? numByDC : (auto++));

                // 纯文本
                let text = U.mergeSoftWraps(textP.textContent || '');

                // DOI/URL
                let doi = null, url = null, gscholar = null;

                // Google Scholar 通常在单独一行：<p class="c-article-references__links">…</p>
                const scholarA = li.querySelector('.c-article-references__links a[href*="scholar.google"]');
                if (scholarA) gscholar = scholarA.getAttribute('href');

                // 文本段里面的链接：先 DOI，再首个非 Scholar 的 http(s)
                for (const a of Array.from(textP.querySelectorAll('a[href]'))) {
                    const href = a.getAttribute('href') || '';
                    if (/^mailto:/i.test(href)) continue;
                    if (!doi && /doi\.org\//i.test(href)) doi = href;
                    if (!url && /^https?:\/\//i.test(href) && !/scholar\.google\./i.test(href)) url = href;
                }

                // 去掉“Google Scholar”尾巴（它本来在 links 段，不应混在 text 里）
                text = text.replace(/\bGoogle Scholar\b\s*$/i, '').trim();

                out.push({ num, id: idRaw || `ref-CR${num}`, text, doi, url, gscholar });
            }

            // 保序 & 去重（按 num）
            const uniq = new Map();
            for (const it of out) if (!uniq.has(it.num)) uniq.set(it.num, it);
            return Array.from(uniq.values()).sort((a, b) => a.num - b.num);
        }



        async _waitFor(fn, timeout = 3500, interval = 120) {
            const t0 = Date.now();
            return new Promise((resolve) => {
                const tick = () => {
                    if (fn()) return resolve(true);
                    if (Date.now() - t0 >= timeout) return resolve(false);
                    setTimeout(tick, interval);
                };
                tick();
            });
        }

        // 2) 新增：激活 References 标签（模拟点击 + 等待 aria 状态）
        async _activateReferencesTab() {
            const btn = U.$('#tab-references');
            const panel = () => U.$('#tabpanel-references');
            if (!btn) return false;
            if (btn.getAttribute('aria-selected') === 'true' || panel()?.getAttribute('aria-hidden') === 'false') return true;
            try { btn.scrollIntoView({ block: 'nearest' }); } catch { }
            this._simulateClick(btn);
            const ok = await this._waitFor(
                () => btn.getAttribute('aria-selected') === 'true' || panel()?.getAttribute('aria-hidden') === 'false',
                1500, 100
            );
            if (!ok) {
                this._simulateClick(btn);
                await this._waitFor(
                    () => btn.getAttribute('aria-selected') === 'true' || panel()?.getAttribute('aria-hidden') === 'false',
                    1500, 100
                );
            }
            return btn.getAttribute('aria-selected') === 'true' || panel()?.getAttribute('aria-hidden') === 'false';
        }

        // 3) 新增：更真实的 click 事件序列
        _simulateClick(el) {
            const fire = (type, props = {}) =>
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, ...props }));
            try { fire('pointerdown'); fire('mousedown'); fire('click'); fire('mouseup'); fire('pointerup'); }
            catch { try { el.click?.(); } catch { } }
        }

        _parseBibList(nodeList) {
            const out = [];
            for (const li of Array.from(nodeList || [])) {
                const id = li.getAttribute('id') || '';
                const num = this._parseRefNumber(id) ?? out.length + 1;

                const txtNode = li.querySelector('.c-article-references__text, .c-reading-companion__reference-citation') || li;
                let text = U.mergeSoftWraps(U.text(txtNode));

                let doi, url, gscholar;
                for (const a of li.querySelectorAll('a[href]')) {
                    const href = a.getAttribute('href') || '';
                    const label = (a.textContent || '').trim();
                    if (/^mailto:/i.test(href)) continue;
                    if (/doi\.org\//i.test(href)) doi = href;
                    if (/scholar\.google\./i.test(href) || /google scholar/i.test(label)) gscholar = href;
                    if (!url && /^https?:\/\//i.test(href) && !/scholar\.google\./i.test(href)) url = href;
                }
                out.push({ num, id, text, doi, url, gscholar });
            }
            const uniq = new Map();
            for (const it of out) if (!uniq.has(it.num)) uniq.set(it.num, it);
            return Array.from(uniq.values()).sort((a, b) => a.num - b.num);
        }

        _collectNodesUntil(parent, startHeading, stopTags = ['H2']) {
            const acc = [];
            let cur = startHeading.nextElementSibling;
            while (cur && parent.contains(cur)) {
                const tag = cur.tagName?.toUpperCase() || '';
                if (stopTags.includes(tag)) break;

                // 允许 wrapper：向下收集一层内容节点
                if (/^(P|FIGURE|UL|OL|PRE|TABLE)$/i.test(tag)) {
                    acc.push(cur);
                } else {
                    acc.push(...Array.from(cur.querySelectorAll('p, figure, ul, ol, pre, table')));
                }
                cur = cur.nextElementSibling;
            }
            return acc;
        }

        _parseAuthorsFromMeta() {
            const authors = [];
            const metas = U.$all('meta[name="citation_author"]', this.doc);
            for (const m of metas) {
                const name = m.getAttribute('content')?.trim();
                if (name) authors.push({ name });
            }
            // TODO: 可从页面 ORCID/aff 扩展
            return authors;
        }

        _parseAbstract() {
            const box = U.$('section#Abs1 .c-article-section__content') || U.$('section#Abs1') || null;
            if (!box) return '';
            const paras = Array.from(box.querySelectorAll('p')).map(p => U.text(p)).filter(Boolean);
            let abs = U.mergeSoftWraps(paras.join('\n\n'));
            abs = abs.replace(/^\s*Abstract\.?\s*/i, '').trim();
            return abs;
        }

        _parseRefNumber(s) {
            if (!s) return null;
            // 兼容 'ref-CR7' / 'rc-ref-CR12' / '#ref-CR3' / 绝对URL...#rc-ref-CR5
            const m = String(s).match(/CR(\d{1,4})(?!\d)/i);
            if (!m) return null;
            const n = Number(m[1]);
            return Number.isInteger(n) && n > 0 ? n : null;
        }

        _cellsToText(cells) {
            return Array.from(cells).map(td => U.mergeSoftWraps(U.text(td)));
        }

        _baseHref() {
            const b = this.doc.querySelector('base');
            const raw = b ? (b.getAttribute('href') || '') : location.href;
            if (!raw) return location.href;
            if (/^https?:\/\//i.test(raw)) return raw;
            if (raw.startsWith('/')) return (location.origin || Config.BASE_ORIGIN) + raw;
            try { return new URL(raw, location.href).toString(); }
            catch { return location.href; }
        }

        _parseDOIFromPage() {
            const DOIText = U.$('[data-test="bibliographic-information__doi"] .c-bibliographic-information__value')?.textContent || '';
            const link = Array.from(this.doc.querySelectorAll('a[href*="doi.org/"]')).map(a => a.getAttribute('href'))[0];
            const s = DOIText || link || '';
            const m = s.match(/10\.\d{4,9}\/\S+/);
            return m ? m[0] : null;
        }

        _derivePdfUrl() {
            const btn = U.$('a[data-test="pdf-link"], a:has(svg[data-icon="download"])');
            return btn?.getAttribute('href') ? U.absolutize(btn.getAttribute('href'), this.baseHref) : null;
        }

        _pickImgSource(imgEl) {
            // 先看 srcset
            const srcset = imgEl.getAttribute('srcset') || imgEl.getAttribute('data-srcset') || '';
            if (srcset) {
                const best = this._bestFromSrcset(srcset);
                if (best) return U.absolutize(best, this.baseHref);
            }

            // 再看 data-full / data-src
            const full = imgEl.getAttribute('data-full-src') || imgEl.getAttribute('data-full') || '';
            if (full) return U.absolutize(full, this.baseHref);

            // 最后用 src / data-src
            const raw = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || null;
            return raw ? U.absolutize(raw, this.baseHref) : null;
        }

        _bestFromSrcset(srcset) {
            const items = String(srcset).split(',')
                .map(s => s.trim())
                .map(seg => {
                    // 形如 "URL 685w" 或只有 "URL"
                    const m = seg.match(/^(.*?)\s+(\d+)w$/);
                    const url = (m ? m[1] : seg.split(/\s+/)[0] || '').trim();
                    const w = m ? parseInt(m[2], 10) : NaN;
                    return { url, w };
                })
                .filter(it => it.url);

            if (!items.length) return null;

            // 1) 优先 /full/ 版本（很多 Springer 的原图在 /full/ 路径）
            const full = items.find(it => /\/full\//i.test(it.url));
            if (full) return full.url;

            // 2) 其余按 w 降序（无 w 视为 0）
            items.sort((a, b) => (Number.isFinite(b.w) ? b.w : 0) - (Number.isFinite(a.w) ? a.w : 0));
            return items[0].url;
        }

        _findFullSizeImageLink(fig) {
            const a = fig.querySelector(
                'a[aria-label*="Full size"], a[aria-label*="Full-size"], a[aria-label*="Full Size"], a[data-track-label*="Full size"], a[href*="/figures/"], a[href*="/figure/"]'
            );
            return a?.getAttribute('href') || null;
        }

        _findFullSizeTableLink(root) {
            const a = root.querySelector(
                'a[aria-label*="Full size table"], a[data-track-label*="Full size table"], a[href*="/tables/"], a[href*="/table/"]'
            );
            return a?.getAttribute('href') || null;
        }

        async _fetchFigurePageBestImage(url) {
            const doc = await this._fetchDoc(url);
            if (!doc) return null;
            // 常见结构：figure img / picture>source[srcset]
            const pic = doc.querySelector('picture source[srcset]');
            if (pic) {
                const best = this._bestFromSrcset(pic.getAttribute('srcset'));
                if (best) return U.absolutize(best, url);
            }
            const img = doc.querySelector('img[src], img[data-src]');
            if (img) {
                const pick = this._pickImgSource(img);
                if (pick) return U.absolutize(pick, url);
            }
            // 兜底：页面上最大的 <img>
            const imgs = Array.from(doc.querySelectorAll('img')).map(el => {
                const w = parseInt(el.getAttribute('width') || '0', 10) || el.naturalWidth || 0;
                const h = parseInt(el.getAttribute('height') || '0', 10) || el.naturalHeight || 0;
                return { el, area: (w * h) || 0 };
            }).sort((a, b) => b.area - a.area);
            if (imgs.length) {
                const raw = imgs[0].el.getAttribute('src') || imgs[0].el.getAttribute('data-src');
                if (raw) return U.absolutize(raw, url);
            }
            return null;
        }

        async _fetchTablePage(url) {
            return await this._fetchDoc(url);
        }

        async _fetchDoc(url) {
            const html = await this._fetchText(url);
            if (!html) return null;
            return new DOMParser().parseFromString(html, 'text/html');
        }

        async _fetchText(url) {
            // 优先 GM_xmlhttpRequest 以跨域
            if (typeof GM_xmlhttpRequest === 'function') {
                return new Promise((resolve, reject) => {
                    try {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url,
                            headers: { 'Accept': 'text/html,application/xhtml+xml' },
                            onload: (resp) => {
                                if (resp.status >= 200 && resp.status < 300) resolve(resp.responseText || '');
                                else reject(new Error(`HTTP ${resp.status}`));
                            },
                            onerror: (e) => reject(e),
                        });
                    } catch (e) {
                        fetch(url, { mode: 'cors', credentials: 'omit' })
                            .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
                            .then(resolve).catch(reject);
                    }
                });
            }
            const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.text();
        }

        _tableToMatrix(table) {
            try {
                const preferHtml = (Config.TABLES?.downcast === 'html');
                const maxCols = (Config.TABLES?.maxColsMarkdown ?? 12);

                // 是否存在跨行/跨列
                const hasSpan = !!table.querySelector('td[rowspan], td[colspan], th[rowspan], th[colspan]');
                // 估计列数（不考虑colgroup复杂情形）
                const rowsAll = Array.from(table.querySelectorAll('tr'));
                const colCount = rowsAll.reduce((m, r) => Math.max(m, r.children.length), 0);

                // 强制 HTML 或复杂/超宽 → HTML 直嵌
                if (preferHtml || hasSpan || colCount > maxCols) {
                    return { html: table.outerHTML };
                }

                // 否则转 Markdown 网格表
                const headers = [];
                const body = [];
                const thead = table.querySelector('thead');

                if (thead) {
                    for (const tr of thead.querySelectorAll('tr')) {
                        headers.push(this._cellsToText(tr.querySelectorAll('th, td')));
                    }
                } else if (rowsAll[0] && rowsAll[0].querySelector('th')) {
                    headers.push(this._cellsToText(rowsAll[0].querySelectorAll('th, td')));
                }

                const bodyRows = thead ? table.querySelectorAll('tbody tr') : (headers.length ? rowsAll.slice(1) : rowsAll);
                for (const tr of bodyRows) {
                    body.push(this._cellsToText(tr.querySelectorAll('td, th')));
                }

                return { headers, rows: body };
            } catch {
                // 兜底：保留原始 HTML，避免信息丢失
                return { html: table.outerHTML };
            }
        }

        _mmlToTex(mathEl) {
            // 极简直译器：mi/mn/mo 文本拼接；mfrac a/b；msqrt sqrt(); msup a^b；msub a_b；msubsup a_b^c
            const s = [];
            const walk = (el) => {
                if (el.nodeType === 3) { s.push(el.nodeValue); return; }
                if (el.nodeType !== 1) return;
                const tag = el.tagName.toLowerCase();

                const child = () => Array.from(el.childNodes).forEach(walk);
                const text = (q = '') => s.push(q);

                switch (tag) {
                    case 'math': child(); break;
                    case 'mrow': child(); break;
                    case 'mi':
                    case 'mn':
                    case 'mo': text(el.textContent || ''); break;
                    case 'mfrac': {
                        const [a, b] = Array.from(el.children);
                        s.push('\\frac{'); if (a) walk(a); s.push('}{'); if (b) walk(b); s.push('}'); break;
                    }
                    case 'msqrt': { s.push('\\sqrt{'); child(); s.push('}'); break; }
                    case 'msup': {
                        const [base, sup] = Array.from(el.children);
                        if (base) walk(base); s.push('^'); s.push('{'); if (sup) walk(sup); s.push('}'); break;
                    }
                    case 'msub': {
                        const [base, sub] = Array.from(el.children);
                        if (base) walk(base); s.push('_'); s.push('{'); if (sub) walk(sub); s.push('}'); break;
                    }
                    case 'msubsup': {
                        const [base, sub, sup] = Array.from(el.children);
                        if (base) walk(base);
                        s.push('_'); s.push('{'); if (sub) walk(sub); s.push('}');
                        s.push('^'); s.push('{'); if (sup) walk(sup); s.push('}');
                        break;
                    }
                    case 'mfenced': { // 括号
                        const open = el.getAttribute('open') || '(';
                        const close = el.getAttribute('close') || ')';
                        s.push(open); child(); s.push(close); break;
                    }
                    default: child(); // 未识别标签直接拼接子节点文本
                }
            };
            walk(mathEl);
            return U.mergeSoftWraps(s.join('')).replace(/\s+/g, ' ');
        }

        _findEquationNumberNearby(node) {
            // 尝试在父块/同级的 ".equation-number" 或 "(n)" 之类提取编号
            const scope = node?.closest?.('figure, div, p, table, section') || node?.parentElement || null;
            if (!scope) return null;
            const t = scope.textContent || '';
            const m = t.match(/\((\d{1,3})\)\s*$/);
            return m ? m[1] : null;
        }
    }


    // -----------------------------
    // 4) MarkdownEmitter（生成层）
    //    复用 arXiv 框架约定：空行规范、脚注/参考脚注等
    // -----------------------------
    class MarkdownEmitter {
        constructor(config = Config) {
            this.cfg = config;
            this.buffers = { head: [], body: [], footnotes: [], references: [] };
        }

        emitFrontMatter(meta) {
            const head = this.buffers.head;
            head.push(`# ${meta.title || 'Untitled'}`);
            head.push('');

            if (meta.authors?.length) {
                head.push('## Authors');
                for (const a of meta.authors) head.push(`- ${[a.name, (a.aff ? `— ${a.aff}` : ''), (a.mail ? `<${a.mail}>` : '')].filter(Boolean).join(' ')}`.trim());
                head.push('');
            }

            if (meta.abstract) {
                head.push('## Abstract');
                head.push(U.mergeSoftWraps(meta.abstract));
                head.push('');
            }

            const linkHtml = meta.links?.html ? `**html:** ${meta.links.html}` : '';
            const linkPdf = meta.links?.pdf ? `${linkHtml ? ', ' : ''}**pdf:** ${meta.links.pdf}` : '';
            const linkDoi = meta.links?.doi ? `${(linkHtml || linkPdf) ? ', ' : ''}**doi:** ${meta.links.doi}` : '';
            if (meta.doi || linkHtml || linkPdf || linkDoi) {
                head.push(`**DOI:** ${meta.doi || 'unknown'}${(linkHtml || linkPdf || linkDoi) ? ' — ' : ''}${linkHtml}${linkPdf}${linkDoi}`);
                head.push('');
            }
        }

        emitTOCPlaceholder() {
            this.buffers.head.push('## Table of Contents');
            this.buffers.head.push('[TOC]');
            this.buffers.head.push('');
        }

        emitHeading(level, title/*, anchor */) {
            const h = Math.min(6, Math.max(2, level || 2));
            const text = U.mergeSoftWraps(title || 'Section');
            this.buffers.body.push(`${'#'.repeat(h)} ${text}`);
            this.buffers.body.push('');
        }

        emitParagraph(text) {
            if (!text) return;
            this.buffers.body.push(U.mergeSoftWraps(String(text)));
            this.buffers.body.push('');
        }

        emitMath(math) {
            if (!math?.tex) return;
            if (math.type === 'display') {
                const tag = math.tag ? ` \\tag{${math.tag}}` : '';
                this.buffers.body.push(`$$\n${math.tex}${tag}\n$$`);
                this.buffers.body.push('');
            } else {
                this.buffers.body.push(U.mergeSoftWraps(`$${math.tex}$`));
                this.buffers.body.push('');
            }
        }

        emitFigure(fig) {
            if (!fig) return;
            this._ensureBlockGap();
            const caption = U.mergeSoftWraps(fig.caption || '');
            if (fig.kind === 'img' && (fig.path || fig.src)) {
                const path = fig.path || fig.src;
                this.buffers.body.push(`![${caption}](${path})`);
                if (caption) this.buffers.body.push(caption);
                this.buffers.body.push('');
                return;
            }
            if (fig.kind === 'svg') {
                if (this.cfg?.IMAGES?.inlineSvgInMarkdown && fig.inlineSvg) {
                    this.buffers.body.push(fig.inlineSvg);
                    if (caption) this.buffers.body.push(caption);
                    this.buffers.body.push('');
                } else if (fig.path) {
                    this.buffers.body.push(`![${caption}](${fig.path})`);
                    if (caption) this.buffers.body.push(caption);
                    this.buffers.body.push('');
                } else {
                    this.buffers.body.push('<!-- TODO: SVG figure placeholder -->');
                    if (caption) this.buffers.body.push(caption);
                    this.buffers.body.push('');
                }
            }
        }

        emitTable(table) {
            if (!table) return;

            // 直接嵌入 HTML（CommonMark/GFM/Typora/Obsidian 都支持块级 HTML）
            if (table.html) {
                this._ensureBlockGap();
                this.buffers.body.push(String(table.html).trim());
                this.buffers.body.push('');
                return;
            }

            // Markdown 网格表分支
            const headers = Array.isArray(table.headers) && table.headers.length ? table.headers : [];
            const rows = Array.isArray(table.rows) ? table.rows : [];
            const escapeCell = (s) => this._escapeTableCell(String(s ?? ''));
            const line = (arr, cols) => `| ${Array.from({ length: cols }, (_, i) => escapeCell(arr[i] ?? '')).join(' | ')} |`;

            const cols = Math.max(
                headers.reduce((m, r) => Math.max(m, r.length), 0),
                rows.reduce((m, r) => Math.max(m, r.length), 0),
                1
            );

            if (headers.length) this.buffers.body.push(line(headers[0], cols));
            else this.buffers.body.push(line([], cols));
            this.buffers.body.push(`| ${Array.from({ length: cols }).map(() => '---').join(' | ')} |`);
            for (const r of rows) this.buffers.body.push(line(r, cols));
            this.buffers.body.push('');
        }

        emitReferences(bibItems) {
            if (!bibItems?.length) return;
            const out = this.buffers.references;
            out.push('## References');
            const list = bibItems.slice().sort((a, b) => a.num - b.num);
            for (const it of list) {
                let line = `[${it.num}] ${U.mergeSoftWraps(it.text || '')}`;
                const extras = [];
                if (it.doi) extras.push(`DOI: ${it.doi}`);
                if (it.url) extras.push(it.url);
                if (it.gscholar) extras.push(`[Google Scholar](${it.gscholar})`);
                if (extras.length) line += ` ${extras.join(' ')}`;
                out.push(line);
            }
            out.push('');
        }

        emitFootnotes(footnoteItems) {
            if (!footnoteItems?.length) return;
            const out = this.buffers.footnotes;
            for (const f of footnoteItems) {
                if (!f?.key || !f?.content) continue;
                out.push(`[^${f.key}]: ${U.mergeSoftWraps(f.content)}`);
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

        reset() {
            this.buffers = { head: [], body: [], footnotes: [], references: [] };
        }

        _ensureBlockGap() {
            const body = this.buffers?.body;
            if (!body || !body.length) return;
            for (let i = body.length - 1; i >= 0; i--) {
                const line = body[i];
                if (line === '') return;
                if (typeof line === 'string') { body.push(''); return; }
            }
        }

        _escapeTableCell(s) {
            return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').replace(/\t/g, ' ').trim();
        }
    }

    // -----------------------------
    // 5) AssetsManager（资源层）
    //    精简：位图抓取/转码 + SVG 注册 + 列表/清理
    // -----------------------------
    class AssetsManager {
        constructor(config = Config) {
            this.cfg = Object.assign({ IMAGES: { maxBytes: 2.5 * 1024 * 1024, maxDim: 4096, concurrency: 4, preferRaster: true } }, config);
            this.assets = [];
            this._assetNames = new Set();
        }

        async fetchRaster(url) {
            try {
                if (!url) return { path: url };
                // data: 情况直接注册
                if (/^data:/i.test(url)) {
                    const parsed = this._dataUrlToBlob(url);
                    const name = this._uniqueName(this._filenameFromURL('image'), this._extFromMime(parsed.type));
                    const assetPath = `assets/${name}`;
                    this._registerAsset({ name, blob: parsed.blob, mime: parsed.type, path: assetPath, originalUrl: null, dataURL: url });
                    return { path: assetPath, assetPath, name, mime: parsed.type, bytes: parsed.blob.size, originalUrl: null };
                }

                // 远程抓取
                const blob = await this._getBlob(url);
                if (!blob) return { path: url, originalUrl: url };

                const scaled = await this._maybeScale(blob, { maxDim: this.cfg.IMAGES.maxDim, maxBytes: this.cfg.IMAGES.maxBytes });
                const outBlob = scaled.blob;
                const mime = outBlob.type || 'image/png';
                const name = this._uniqueName(this._filenameFromURL(url), this._extFromMime(mime));
                const assetPath = `assets/${name}`;

                this._registerAsset({ name, blob: outBlob, mime, path: assetPath, originalUrl: url });
                return {
                    path: assetPath,          // 统一返回 assetPath，后续 Markdown 用它
                    assetPath,
                    name, mime,
                    bytes: outBlob.size,
                    width: scaled.width, height: scaled.height,
                    originalUrl: url
                };
            } catch (err) {
                Log.warn('AssetsManager.fetchRaster error:', err);
                return { path: url, originalUrl: url };
            }
        }

        async registerSvg(svgEl, suggestedName = 'figure.svg') {
            try {
                const xml = this._serializeSvg(svgEl);
                const mime = 'image/svg+xml';
                const blob = new Blob([xml], { type: mime });
                const base = this._stripExt(suggestedName) || 'figure';
                const name = this._uniqueName(base, '.svg');
                const assetPath = `assets/${name}`;
                this._registerAsset({ name, blob, mime, path: assetPath });
                return { path: null, inlineSvg: xml, assetPath, name, mime, bytes: blob.size };
            } catch (err) {
                Log.warn('AssetsManager.registerSvg error:', err);
                return { path: null, inlineSvg: svgEl?.outerHTML || '<!-- svg -->' };
            }
        }

        list() { return this.assets.slice(); }
        clear() { this.assets = []; this._assetNames.clear?.(); }

        // ----- internals -----
        _registerAsset(rec) {
            this.assets.push(rec);
            this._assetNames.add(rec.name);
            return this.assets.length - 1;
        }

        _uniqueName(base, ext) {
            const cleanBase = this._sanitizeName(base || 'asset');
            const cleanExt = ext && ext.startsWith('.') ? ext : (ext ? `.${ext}` : '');
            let n = `${cleanBase}${cleanExt}`, i = 1;
            while (this._assetNames.has(n)) n = `${cleanBase}_${String(++i).padStart(2, '0')}${cleanExt}`;
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
        _stripExt(name) { return String(name || '').replace(/\.[a-z0-9]+$/i, ''); }
        _sanitizeName(s) { return String(s || 'asset').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'asset'; }
        _extFromMime(mime) {
            mime = (mime || '').toLowerCase();
            if (mime.includes('image/webp')) return '.webp';
            if (mime.includes('image/png')) return '.png';
            if (mime.includes('image/jpeg') || mime.includes('image/jpg')) return '.jpg';
            if (mime.includes('image/svg')) return '.svg';
            if (mime.includes('image/gif')) return '.gif';
            return '.bin';
        }

        _dataUrlToBlob(dataURL) {
            const m = String(dataURL).match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
            if (!m) return { blob: new Blob([new Uint8Array(0)], { type: 'application/octet-stream' }), type: 'application/octet-stream' };
            const mime = m[1] || 'application/octet-stream', isB64 = !!m[2], data = decodeURIComponent(m[3]);
            if (isB64) {
                const bin = atob(data), len = bin.length, u8 = new Uint8Array(len);
                for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
                return { blob: new Blob([u8], { type: mime }), type: mime };
            } else {
                return { blob: new Blob([data], { type: mime }), type: mime };
            }
        }

        async _getBlob(url) {
            if (typeof GM_xmlhttpRequest === 'function') {
                return new Promise((resolve, reject) => {
                    try {
                        GM_xmlhttpRequest({
                            method: 'GET', url, responseType: 'blob',
                            onload: (resp) => {
                                const blob = resp.response;
                                if (blob instanceof Blob) return resolve(blob);
                                if (resp.response && resp.response.byteLength) {
                                    const type = /content-type:\s*([^\r\n]+)/i.exec(resp.responseHeaders || '')?.[1]?.trim() || 'application/octet-stream';
                                    return resolve(new Blob([resp.response], { type }));
                                }
                                resolve(null);
                            },
                            onerror: (e) => reject(e),
                        });
                    } catch (e) {
                        fetch(url, { mode: 'cors' }).then(r => r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))).then(resolve).catch(reject);
                    }
                });
            }
            const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.blob();
        }

        async _maybeScale(blob, { maxDim, maxBytes }) {
            const { img, width, height } = await this._imageFromBlob(blob);
            let targetW = width, targetH = height;

            const maxSide = Math.max(width, height);
            if (maxSide > maxDim) {
                const scale = maxDim / maxSide;
                targetW = Math.max(1, Math.round(width * scale));
                targetH = Math.max(1, Math.round(height * scale));
            }

            const preferWebP = this._supportsWebP();
            let type = preferWebP ? 'image/webp' : 'image/png';
            let quality = preferWebP ? 0.92 : undefined;
            let out = await this._draw(img, targetW, targetH, type, quality);

            let iter = 0;
            while (out.size > maxBytes && iter < 6) {
                iter++;
                if (preferWebP && quality > 0.6) quality = Math.max(0.6, quality - 0.07);
                else { targetW = Math.max(1, Math.floor(targetW * 0.85)); targetH = Math.max(1, Math.floor(targetH * 0.85)); }
                out = await this._draw(img, targetW, targetH, type, quality);
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
            } finally { URL.revokeObjectURL(url); }
        }
        async _draw(img, w, h, mime = 'image/png', q) {
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (ctx.imageSmoothingEnabled !== undefined) ctx.imageSmoothingEnabled = true;
            if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, w, h);
            const blob = await new Promise((res) => {
                if (canvas.toBlob) canvas.toBlob((b) => res(b || this._dataUrlToBlob(canvas.toDataURL(mime, q)).blob), mime, q);
                else res(this._dataUrlToBlob(canvas.toDataURL(mime, q)).blob);
            });
            return blob;
        }
        _supportsWebP() { const c = document.createElement('canvas'); return c.toDataURL && c.toDataURL('image/webp').indexOf('data:image/webp') === 0; }
        _serializeSvg(svgEl) {
            try {
                const el = svgEl.cloneNode(true);
                if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                if (!el.getAttribute('xmlns:xlink')) el.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
                const xml = new XMLSerializer().serializeToString(el);
                return /^<\?xml/i.test(xml) ? xml : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
            } catch { return svgEl?.outerHTML || '<svg xmlns="http://www.w3.org/2000/svg"></svg>'; }
        }
    }

    // -----------------------------
    // 6) Exporter（三形态导出）
    // -----------------------------
    class Exporter {
        constructor(config = Config) {
            this.cfg = config;
            this._assetsProvider = null;
        }
        bindAssets(providerOrArray) { this._assetsProvider = providerOrArray || null; }

        async asMarkdownLinks(markdown) { return String(markdown || ''); }

        async asMarkdownBase64(markdown, assets) {
            let md = String(markdown || '');
            const list = await this._resolveAssets(assets);
            if (!list.length) return md;

            // 预生成 dataURL
            const records = [];
            for (const a of list) {
                let dataURL = a.dataURL;
                if (!dataURL && a.blob instanceof Blob) dataURL = await this._blobToDataURL(a.blob);
                if (!dataURL) continue;

                const paths = new Set();
                // 资产路径（TextBundle/Links 模式下使用）
                if (a.path) {
                    paths.add(a.path);
                    paths.add(`./${a.path}`);
                    paths.add(`/${a.path}`);
                }
                // 原始 URL（Links 模式或某些意外路径）
                if (a.originalUrl) {
                    paths.add(a.originalUrl);
                    // 有些页面会加协议相对、或 URL 编码差异，这里补一个协议相对匹配
                    if (/^https?:\/\//i.test(a.originalUrl)) {
                        const protoRel = a.originalUrl.replace(/^https?:/, '');
                        paths.add(protoRel);
                    }
                }
                records.push({ paths: Array.from(paths), dataURL });
            }

            // 替换函数（() 链接；HTML 的 src|href；以及 srcset 内的 URL）
            const replaceOne = (text, from, to) => {
                const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Markdown/HTML () 链接
                text = text.replace(new RegExp(`\\((\\s*?)${esc}(\\s*?)\\)`, 'g'), (_m, a, b) => `(${a}${to}${b})`);
                // HTML 属性 src/href
                text = text.replace(new RegExp(`(src|href)=(")${esc}(")`, 'g'), (_m, k, q1, q2) => `${k}=${q1}${to}${q2}`);
                text = text.replace(new RegExp(`(src|href)=(')${esc}(')`, 'g'), (_m, k, q1, q2) => `${k}=${q1}${to}${q2}`);
                // srcset（用空格或逗号分隔的一串 URL + 尺寸；逐个替换 URL）
                text = text.replace(new RegExp(`(srcset=)("([^"]*)")`, 'g'), (_m, attr, quoted, inner) => {
                    const replaced = inner.split(',').map(seg => {
                        const parts = seg.trim().split(/\s+/);
                        if (!parts.length) return seg;
                        if (parts[0] === from) parts[0] = to;
                        return parts.join(' ');
                    }).join(', ');
                    return `${attr}"${replaced}"`;
                });
                return text;
            };

            for (const rec of records) {
                for (const p of rec.paths) md = replaceOne(md, p, rec.dataURL);
            }
            return md;
        }

        async asTextBundle(markdown, assets) {
            const files = [];
            const textMd = this._utf8(`\ufeff${String(markdown || '')}`);
            const info = { version: 2, type: 'net.daringfireball.markdown', creatorIdentifier: 'qiqi.springer.md.exporter', transient: false };
            const infoJson = this._utf8(JSON.stringify(info, null, 2));
            files.push({ name: 'text.md', data: textMd });
            files.push({ name: 'info.json', data: infoJson });

            // 打包资产
            const list = await this._resolveAssets(assets);
            for (const a of list) {
                if (!a?.blob || !a?.name) continue;
                const data = new Uint8Array(await a.blob.arrayBuffer());
                files.push({ name: `assets/${a.name}`, data });
            }

            // 诊断：扫描 markdown 中未打包的外链资源
            const diag = this._diagnoseExternalResources(String(markdown || ''));
            if (diag.external.length) {
                const report = this._buildDiagnosticsReport(diag, list);
                files.push({ name: 'diagnostics.txt', data: this._utf8(report) });
            }

            const zipBlob = await this._zip(files);
            return { filename: 'export.textbundle', blob: zipBlob, diagnostics: diag, external_count: diag.external.length };
        }

        // internals

        _diagnoseExternalResources(md) {
            const externals = new Set();

            const addIfExternal = (u) => {
                if (!u) return;
                const s = String(u).trim();
                // 忽略 data:, mailto:, 相对/本地 assets
                if (/^(data:|mailto:)/i.test(s)) return;
                if (/^(?:https?:)?\/\//i.test(s)) { externals.add(s.startsWith('//') ? ('https:' + s) : s); return; }
            };

            // 1) Markdown 图片：![alt](URL)
            const mdImg = /!\[[^\]]*\]\(([^)]+)\)/g;
            for (let m; (m = mdImg.exec(md));) addIfExternal(m[1]);

            // 2) HTML src/href
            const htmlSrc = /(src|href)=["']([^"']+)["']/gi;
            for (let m; (m = htmlSrc.exec(md));) addIfExternal(m[2]);

            // 3) srcset（逗号分隔）
            const srcset = /srcset=["']([^"']+)["']/gi;
            for (let m; (m = srcset.exec(md));) {
                const inner = m[1].split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
                inner.forEach(addIfExternal);
            }

            return { external: Array.from(externals).sort() };
        }

        // Exporter._buildDiagnosticsReport —— 新增
        _buildDiagnosticsReport(diag, assetList) {
            const lines = [];
            lines.push('Springer → Markdown · TextBundle Diagnostics');
            lines.push('===========================================');
            lines.push('');
            lines.push(`Unpacked external resources: ${diag.external.length}`);
            for (const url of diag.external) lines.push(`- ${url}`);
            lines.push('');
            lines.push(`Packed assets: ${Array.isArray(assetList) ? assetList.length : 0}`);
            if (Array.isArray(assetList)) {
                for (const a of assetList) {
                    const sz = (a?.blob?.size ?? 0);
                    lines.push(`- assets/${a.name} (${sz} bytes${a.originalUrl ? `; from ${a.originalUrl}` : ''})`);
                }
            }
            lines.push('');
            lines.push('Hint: 若仍有外链，说明对应资源未成功抓取或某些路径未被替换（如直接写死 https://media.springernature.com/...）。请检查提到的 URL，并确认在 textbundle 模式下对图片统一使用 AssetsManager.fetchRaster 的返回路径。');
            return lines.join('\n');
        }

        async _resolveAssets(assetsMaybe) {
            if (Array.isArray(assetsMaybe)) return assetsMaybe;
            if (this._assetsProvider) {
                if (Array.isArray(this._assetsProvider)) return this._assetsProvider;
                if (typeof this._assetsProvider.list === 'function') { try { return this._assetsProvider.list() || []; } catch { } }
            }
            return [];
        }
        _escReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
        async _blobToDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || '')); r.onerror = rej; r.readAsDataURL(blob); }); }
        _utf8(str) { return new TextEncoder().encode(String(str ?? '')); }

        // Minimal STORED zip (no compression)
        async _zip(fileEntries) {
            const files = [];
            let centralSize = 0, offset = 0;
            const now = new Date(), dosTime = this._dosTime(now), dosDate = this._dosDate(now);

            for (const fe of fileEntries) {
                const nameBytes = this._utf8(fe.name);
                const data = fe.data || new Uint8Array(0);
                const crc = this._crc32(data);

                const localHeader = [];
                this._pushU32(localHeader, 0x04034b50);
                this._pushU16(localHeader, 20);
                this._pushU16(localHeader, 0);
                this._pushU16(localHeader, 0);
                this._pushU16(localHeader, dosTime);
                this._pushU16(localHeader, dosDate);
                this._pushU32(localHeader, crc);
                this._pushU32(localHeader, data.length);
                this._pushU32(localHeader, data.length);
                this._pushU16(localHeader, nameBytes.length);
                this._pushU16(localHeader, 0);

                const localHeaderBytes = new Uint8Array(localHeader);
                const fileOffset = offset;
                offset += localHeaderBytes.length + nameBytes.length + data.length;

                files.push({ nameBytes, data, crc, localHeaderBytes, fileOffset });
            }

            const central = [];
            for (const f of files) {
                const nameLen = f.nameBytes.length, dataLen = f.data.length;
                this._pushU32(central, 0x02014b50);
                this._pushU16(central, 20);
                this._pushU16(central, 20);
                this._pushU16(central, 0);
                this._pushU16(central, 0);
                this._pushU16(central, dosTime);
                this._pushU16(central, dosDate);
                this._pushU32(central, f.crc);
                this._pushU32(central, dataLen);
                this._pushU32(central, dataLen);
                this._pushU16(central, nameLen);
                this._pushU16(central, 0);
                this._pushU16(central, 0);
                this._pushU16(central, 0);
                this._pushU16(central, 0);
                this._pushU32(central, 0);
                this._pushU32(central, f.fileOffset);
                central.push(...f.nameBytes);
            }
            const centralBytes = new Uint8Array(central);
            const centralOffset = offset;
            const centralLength = centralBytes.length;
            offset += centralLength;

            const end = [];
            this._pushU32(end, 0x06054b50);
            this._pushU16(end, 0);
            this._pushU16(end, 0);
            this._pushU16(end, files.length);
            this._pushU16(end, files.length);
            this._pushU32(end, centralLength);
            this._pushU32(end, centralOffset);
            this._pushU16(end, 0);
            const endBytes = new Uint8Array(end);

            const chunks = [];
            for (const f of files) chunks.push(f.localHeaderBytes, f.nameBytes, f.data);
            chunks.push(centralBytes, endBytes);

            return new Blob(chunks, { type: 'application/zip' });
        }
        _pushU16(arr, n) { arr.push(n & 0xff, (n >>> 8) & 0xff); }
        _pushU32(arr, n) { arr.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff); }
        _dosTime(d) { const h = d.getHours(), m = d.getMinutes(), s = Math.floor(d.getSeconds() / 2); return (h << 11) | (m << 5) | s; }
        _dosDate(d) { const y = d.getFullYear() - 1980, m = d.getMonth() + 1, day = d.getDate(); return (y << 9) | (m << 5) | day; }
        _crc32(u8) { const tbl = this._crcTable(); let c = 0 ^ (-1); for (let i = 0; i < u8.length; i++) c = (c >>> 8) ^ tbl[(c ^ u8[i]) & 0xFF]; return (c ^ (-1)) >>> 0; }
        _crcTable() { if (this.__crcTable) return this.__crcTable; const table = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[i] = c >>> 0; } this.__crcTable = table; return table; }
    }

    // -----------------------------
    // 7) Controller（编排）
    // -----------------------------
    class Controller {
        constructor() {
            this.adapter = new SpringerAdapter(document);
            this.assets = new AssetsManager();
            this.emitter = new MarkdownEmitter();
            this.exporter = new Exporter();
            this.exporter.bindAssets(this.assets);
            
            // 缓存系统
            this._cache = {
                meta: null,
                bibliography: null,
                citationMap: null,
                sections: null,
                baseMarkdown: null,    // 基础Markdown内容（links模式）
                lastPageHash: null,    // 页面内容哈希
                assetsSnapshot: null   // 资源快照
            };
        }

        // -----------------------------
        // 缓存辅助方法
        // -----------------------------
        
        /**
         * 生成页面哈希用于缓存失效检测
         */
        _getPageHash() {
            const title = document.title || '';
            const bodyLength = document.body ? document.body.textContent.length : 0;
            const abstractLength = U.$('div[role="doc-abstract"], .c-article-section--abstract')?.textContent?.length || 0;
            return `${title}-${bodyLength}-${abstractLength}`;
        }

        /**
         * 构建基础缓存数据（使用原始完整逻辑，固定为links模式）
         */
        async _buildBaseCacheWithOriginalLogic() {
            Log.info('Building base cache data with original logic...');
            
            // 提取基础数据
            const meta = this.adapter.getMeta();
            Log.info('Cached metadata:', { title: meta.title, authors: meta.authors.length });
            this._lastMeta = meta;
            
            const bib = await this.adapter.collectBibliography();
            Log.info('Cached bibliography:', bib.length, 'references');
            
            const citeMap = this.adapter.buildCitationMap(bib);
            const sections = this.adapter.walkSections();
            Log.info('Cached sections:', sections.length);

            // 缓存基础数据
            this._cache.meta = meta;
            this._cache.bibliography = bib;
            this._cache.citationMap = citeMap;
            this._cache.sections = sections;

            // 生成基础Markdown（使用links模式的完整原始逻辑）
            this._cache.baseMarkdown = await this._generateBaseCacheMarkdown(meta, bib, citeMap, sections);
            
            Log.info('Base cache built successfully');
        }

        /**
         * 生成基础缓存Markdown（完整原始逻辑，固定links模式）
         */
        async _generateBaseCacheMarkdown(meta, bib, citeMap, sections) {
            // 重置状态
            this._cited = new Set();
            const footF = [];

            this.emitter.emitFrontMatter(meta);
            this.emitter.emitTOCPlaceholder();

            for (const sec of sections) {
                this.emitter.emitHeading(sec.level || 2, sec.title || 'Section', sec.anchor);

                for (const node of (sec.nodes || [])) {
                    const tag = (node.tagName || '').toLowerCase();

                    // —— 段落（含行内TeX、脚注、行内格式保留、去掉UI图标）——
                    if (this.adapter.isElementParagraph(node)) {
                        const ptext = this.adapter.renderParagraphWithInlineMathAndCitations(node, citeMap, footF);
                        this.emitter.emitParagraph(ptext);
                        continue;
                    }

                    // —— 数学块——
                    if (this.adapter.isDisplayMath(node)) {
                        const mathStr = this.adapter.extractDisplayMath(node);
                        this.emitter.emitMath(mathStr);
                        continue;
                    }

                    // —— 图片——
                    if (this.adapter.isFigure(node)) {
                        const fig = await this.adapter.extractFigure(node, 'links'); // 固定links模式
                        this.emitter.emitFigure(fig);
                        continue;
                    }

                    // —— 表格 ——
                    if (this.adapter.isTable(node)) {
                        const table = this.adapter.extractTable(node);
                        this.emitter.emitTable(table);
                        continue;
                    }

                    // —— 列表 ——
                    if (this.adapter.isList(node)) {
                        const listMd = this.adapter.renderListWithInlineMathAndCitations(node, citeMap, footF);
                        this.emitter.emitParagraph(listMd);
                        continue;
                    }

                    // —— 代码块——
                    if (this.adapter.isCodeBlock(node)) {
                        const code = this.adapter.extractCodeBlock(node);
                        this.emitter.emitParagraph(code);
                        continue;
                    }

                    // —— 脚注（收集但不直接渲染）——
                    if (this.adapter.isFootnote(node)) {
                        const foot = this.adapter.extractFootnote(node);
                        if (foot) footF.push(foot);
                        continue;
                    }

                    // —— 兜底——
                    if (node.textContent && node.textContent.trim()) {
                        const fallback = this.adapter.cleanTextContent(node.textContent);
                        if (fallback.length > 5) {
                            this.emitter.emitParagraph(fallback);
                        }
                    }
                }
            }

            // References（全部参考）
            this.emitter.emitReferences(bib);

            return this.emitter.compose();
        }

        /**
         * 根据模式处理差异（使用原始逻辑）
         */
        async _processForModeWithOriginalLogic(mode) {
            if (mode === 'links') {
                Log.info('Using cached links mode markdown...');
                return this._cache.baseMarkdown;
            } else {
                Log.info('Processing mode-specific logic for:', mode);
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

            // 重置emitter（为了避免与缓存构建时的冲突）
            this.emitter.reset();

            this.emitter.emitFrontMatter(meta);
            this.emitter.emitTOCPlaceholder();

            for (const sec of sections) {
                this.emitter.emitHeading(sec.level || 2, sec.title || 'Section', sec.anchor);

                for (const node of (sec.nodes || [])) {
                    const tag = (node.tagName || '').toLowerCase();

                    // —— 段落（含行内TeX、脚注、行内格式保留、去掉UI图标）——
                    if (this.adapter.isElementParagraph(node)) {
                        const ptext = this.adapter.renderParagraphWithInlineMathAndCitations(node, citeMap, footF);
                        this.emitter.emitParagraph(ptext);
                        continue;
                    }

                    // —— 数学块——
                    if (this.adapter.isDisplayMath(node)) {
                        const mathStr = this.adapter.extractDisplayMath(node);
                        this.emitter.emitMath(mathStr);
                        continue;
                    }

                    // —— 图片（根据模式使用不同逻辑）——
                    if (this.adapter.isFigure(node)) {
                        const fig = await this.adapter.extractFigure(node, mode); // 使用传入的模式
                        this.emitter.emitFigure(fig);
                        continue;
                    }

                    // —— 表格 ——
                    if (this.adapter.isTable(node)) {
                        const table = this.adapter.extractTable(node);
                        this.emitter.emitTable(table);
                        continue;
                    }

                    // —— 列表 ——
                    if (this.adapter.isList(node)) {
                        const listMd = this.adapter.renderListWithInlineMathAndCitations(node, citeMap, footF);
                        this.emitter.emitParagraph(listMd);
                        continue;
                    }

                    // —— 代码块——
                    if (this.adapter.isCodeBlock(node)) {
                        const code = this.adapter.extractCodeBlock(node);
                        this.emitter.emitParagraph(code);
                        continue;
                    }

                    // —— 脚注（收集但不直接渲染）——
                    if (this.adapter.isFootnote(node)) {
                        const foot = this.adapter.extractFootnote(node);
                        if (foot) footF.push(foot);
                        continue;
                    }

                    // —— 兜底——
                    if (node.textContent && node.textContent.trim()) {
                        const fallback = this.adapter.cleanTextContent(node.textContent);
                        if (fallback.length > 5) {
                            this.emitter.emitParagraph(fallback);
                        }
                    }
                }
            }

            // References（全部参考）
            this.emitter.emitReferences(bib);

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
                assetsSnapshot: null
            };
            Log.info('Cache invalidated');
        }

        async runPipeline(mode = 'links') {
            this._prepareRun(mode, false); // false表示不清除缓存
            Log.info('Pipeline start:', mode);

            // 检查缓存有效性
            const currentPageHash = this._getPageHash();
            const cacheValid = this._cache.lastPageHash === currentPageHash && this._cache.baseMarkdown;

            if (!cacheValid) {
                Log.info('Cache invalid or missing, rebuilding base cache...');
                await this._buildBaseCacheWithOriginalLogic();
                this._cache.lastPageHash = currentPageHash;
            } else {
                Log.info('Using cached data for faster processing...');
                // 恢复缓存的状态
                this._lastMeta = this._cache.meta;
            }

            // 根据模式处理差异
            const result = await this._processForModeWithOriginalLogic(mode);
            Log.info('Pipeline completed. Generated markdown:', result.length, 'characters');
            return result;
        }

        // —— 导出 —— //
        async exportLinks() {
            const md = await this.runPipeline('links');
            try { if (typeof GM_setClipboard === 'function') GM_setClipboard(md, { type: 'text' }); } catch { }
            this._downloadText(md, this._suggestFileName('links', 'md'));
            alert('已生成 Links 版 Markdown。');
        }
        async exportBase64() {
            const md = await this.runPipeline('base64');                // ← 必须是 'base64'
            const out = await this.exporter.asMarkdownBase64(md, this.assets.list());
            this._downloadText(out, this._suggestFileName('base64', 'md'));
            alert('已生成 Base64 版 Markdown。');
        }

        async exportTextBundle() {
            const md = await this.runPipeline('textbundle'); // 确保是 textbundle 模式
            const tb = await this.exporter.asTextBundle(md, this.assets.list());
            this._downloadBlob(tb.blob, this._suggestFileName('textbundle', 'textbundle'));
            if (tb && typeof tb.external_count === 'number') {
                if (tb.external_count > 0) {
                    alert(`TextBundle 已生成，但仍有 ${tb.external_count} 个外链未打包（详见包内 diagnostics.txt）。`);
                } else {
                    alert('已生成 TextBundle（所有资源均已打包）。');
                }
            } else {
                alert('已生成 TextBundle。');
            }
        }

        _prepareRun(mode, clearCache = true) {
            Log.info('Preparing run for mode:', mode, 'clearCache:', clearCache);
            
            // 1) 清空文本缓冲
            if (typeof this.emitter?.reset === 'function') {
                this.emitter.reset();
            } else {
                this.emitter = new MarkdownEmitter(); // 兼容：万一你没加 reset()
            }

            // 2) 清空资源（即使 links 模式也清空，避免历史资产影响后续替换）
            if (this.assets && typeof this.assets.clear === 'function') {
                this.assets.clear();
            }

            // 3) 清空本次运行的状态寄存
            this._cited = new Set();
            this._lastMeta = null;

            // 4)（可选）确保导出器仍绑定当前资产管理器
            if (this.exporter && typeof this.exporter.bindAssets === 'function') {
                this.exporter.bindAssets(this.assets);
            }

            // 5) 标记本次运行模式（如需在调试中使用）
            this._runMode = mode || 'links';
            
            // 6) 可选择性清除缓存（页面刷新或强制重新生成时）
            if (clearCache) {
                this._invalidateCache();
            }
        }


        // —— 文中引文处理（[ ^R{n} ]） —— //
        _renderParagraphWithCites(pNode, citeMap) {
            const node = pNode.cloneNode(true);

            // 去掉所有 UI 图标（不会影响公式）
            node.querySelectorAll('svg.u-icon, .u-icon svg, .c-article__pill-button svg').forEach(el => el.remove());
            // 删除仅含图标的空链接
            for (const a of Array.from(node.querySelectorAll('a'))) {
                if (!a.textContent || !a.textContent.trim()) a.remove();
            }

            // MathJax 内联 TeX
            for (const mj of Array.from(node.querySelectorAll('span.mathjax-tex'))) {
                const sc = mj.querySelector('script[type^="math/tex"]');
                if (sc) {
                    const isDisplay = /mode=display/i.test(sc.getAttribute('type') || '');
                    const tex = (sc.textContent || '').trim();
                    mj.replaceWith(document.createTextNode(isDisplay ? `$$\n${tex}\n$$` : `$${tex}$`));
                }
            }

            // 文内引文 #ref-CR* / #rc-ref-CR* → [^Rn]
            const sel = 'a[href^="#ref-CR"], a[href^="#rc-ref-CR"], a[href*="#ref-CR"], a[href*="#rc-ref-CR"]';
            for (const a of Array.from(node.querySelectorAll(sel))) {
                const href = a.getAttribute('href') || '';
                let n = citeMap.get(href)
                    ?? citeMap.get(href.replace(/^#/, ''))
                    ?? citeMap.get(href.replace(location.origin, ''))
                    ?? this.adapter._parseRefNumber(href);
                if (Number.isInteger(n) && n > 0) {
                    this._cited?.add?.(n);
                    a.replaceWith(document.createTextNode(`[^R${n}]`));
                } else {
                    a.replaceWith(document.createTextNode(a.textContent || ''));
                }
            }

            // 其余链接 → Markdown 链接
            for (const a of Array.from(node.querySelectorAll('a'))) {
                const href = a.getAttribute('href') || '';
                const txt = a.textContent || href;
                if (href) a.replaceWith(document.createTextNode(`[${txt}](${U.absolutize(href)})`));
                else a.replaceWith(document.createTextNode(txt));
            }

            // 行内强调/代码/上下标
            const s = this._nodeToMarkdownInline(node);

            // 修复 [[^R9], [^R11]] → [^R9], [^R11]
            return this._cleanNoiseText(
                s
                    .replace(/\[\s*(\[\^R\d+\](?:\s*,\s*\[\^R\d+\])*)\s*\]/g, '$1')
                    .replace(/\(\s*\[\^R(\d+)\]\s*\)/g, '[^R$1]')
            );
        }

        // Controller._nodeToMarkdownInline —— 新增：保留 **加粗**/*斜体*、`code`、<sub>/<sup>
        _nodeToMarkdownInline(root) {
            const out = [];
            const walk = (el) => {
                if (el.nodeType === 3) { out.push(el.nodeValue); return; }
                if (el.nodeType !== 1) return;
                const tag = el.tagName.toLowerCase();
                const kids = () => Array.from(el.childNodes).forEach(walk);

                if (tag === 'strong' || tag === 'b') { out.push('**'); kids(); out.push('**'); return; }
                if (tag === 'em' || tag === 'i') { out.push('*'); kids(); out.push('*'); return; }
                if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
                    const txt = (el.textContent || '').replace(/`/g, '\\`'); out.push('`' + txt + '`'); return;
                }
                if (tag === 'sub' || tag === 'sup') { // Markdown 无原生语法，用内联 HTML
                    out.push(`<${tag}>${(el.textContent || '').trim()}</${tag}>`); return;
                }
                if (tag === 'br') { out.push('  \n'); return; }
                // 其它行内元素/无关包装
                kids();
            };
            Array.from(root.childNodes).forEach(walk);
            return out.join('');
        }

        _renderList(listNode, citeMap, depth = 0) {
            const lines = [];
            const ordered = listNode.tagName.toLowerCase() === 'ol';
            let idx = 1;
            for (const li of Array.from(listNode.children)) {
                if (li.tagName?.toLowerCase() !== 'li') continue;
                const text = this._renderParagraphWithCites(li, citeMap);
                const bullet = ordered ? `${idx}. ` : `- `;
                const indent = '  '.repeat(depth);
                const first = `${indent}${bullet}${text}`.trimEnd();
                if (first) lines.push(first);

                // 嵌套列表
                const sublists = Array.from(li.children).filter(c => /^(ul|ol)$/i.test(c.tagName));
                for (const sub of sublists) lines.push(...this._renderList(sub, citeMap, depth + 1));
                idx++;
            }
            return lines;
        }

        _makeReferenceFootnotes(bibItems/*, citedSetIgnored */) {
            const out = [];
            const list = (bibItems || []).slice().sort((a, b) => a.num - b.num);
            for (const it of list) {
                const parts = [];
                const main = (it.text || '').trim();
                if (main) parts.push(main);
                if (it.doi) parts.push(`DOI: ${it.doi}`);
                if (it.url) parts.push(it.url);
                if (it.gscholar) parts.push(`[Google Scholar](${it.gscholar})`);
                out.push({ key: `R${it.num}`, content: parts.join(' ') });
            }
            return out;
        }

        _cleanNoiseText(s) {
            return String(s || '')
                .replace(/[ \t]*\n[ \t]*/g, ' ')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/\u00A0/g, ' ')
                .trim();
        }

        _suggestFileName(tag, ext = 'md') {
            const rawTitle = (this._lastMeta?.title || document.title || 'untitled');
            const safeTitle = String(rawTitle)
                .normalize('NFKC')
                .replace(/\s+/g, '_')
                .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
                .replace(/\.+$/g, '')
                .replace(/_{2,}/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 120) || 'untitled';

            const doiPart = (this._lastMeta?.doi || 'unknown').replace(/[^\w.-]+/g, '_');
            const base = `springer_${doiPart}_${safeTitle}_${tag}`;
            return ext ? `${base}.${ext}` : base;
        }

        _downloadText(text, filename) { this._downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename); }
        _downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
        }
    }

    // -----------------------------
    // 8) UI（悬浮面板 · 懒加载预览）
    //    基于 arXiv 版 UI 的轻改：Badge → “Springer”
    // -----------------------------
    const UI = {
        mount(controller) {
            const Z = (Config.UI?.zIndex) || 999999;
            const side = (Config.UI?.position) || 'right';

            GM_addStyle?.(`
        :root {
          --ax-bg: #ffffff; --ax-text: #111827; --ax-muted: #6b7280;
          --ax-border: #e5e7eb; --ax-panel: rgba(255,255,255,0.96);
          --ax-accent: #052e8b; --ax-accent-600: #05206b; --ax-shadow: 0 12px 32px rgba(0,0,0,.15);
        }
        @media (prefers-color-scheme: dark) {
          :root { --ax-bg:#0f1115; --ax-text:#e5e7eb; --ax-muted:#9ca3af; --ax-border:#30363d;
                  --ax-panel: rgba(17,17,17,.92); --ax-accent:#388bfd; --ax-accent-600:#2f74d0; --ax-shadow:0 16px 40px rgba(0,0,0,.4); }
        }
        .springer-md-panel { position: fixed; ${side === 'right' ? 'right: 16px;' : 'left: 16px;'} bottom: 16px; z-index: ${Z};
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans CJK SC";
          background: var(--ax-panel); color: var(--ax-text);
          border: 1px solid var(--ax-border); border-radius: 12px; padding: 10px 10px; box-shadow: var(--ax-shadow);
          backdrop-filter: saturate(1.1) blur(6px); user-select: none; }
        .springer-md-panel__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px 0}
        .springer-md-panel__title{margin:0;font-size:13px;letter-spacing:.2px;font-weight:700;display:inline-flex;align-items:center;gap:6px}
        .springer-md-badge{display:inline-block;padding:2px 6px;font-size:11px;font-weight:700;color:#fff;background:var(--ax-accent);border-radius:999px}
        .springer-md-panel__drag{cursor:grab;opacity:.9;font-size:11px;color:var(--ax-muted)} .springer-md-panel__drag:active{cursor:grabbing}
        .springer-md-panel__btns{display:flex;flex-wrap:wrap;gap:6px}
        .springer-md-btn{margin:0;padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:var(--ax-accent);color:#fff;font-weight:700;font-size:12px;box-shadow:0 1px 0 rgba(0,0,0,.08)}
        .springer-md-btn:hover{background:var(--ax-accent-600)}
        .springer-md-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}
        .springer-md-btn--secondary{background:transparent;color:var(--ax-text);border:1px solid var(--ax-border)}
        .springer-md-btn--secondary:hover{background:rgba(0,0,0,.05)}
        .springer-md-btn--ghost{background:transparent;color:var(--ax-muted)} .springer-md-btn--ghost:hover{color:var(--ax-text)}
        .springer-md-hide{display:none!important}
        
        /* Debug Log Panel */
        .springer-md-log{margin-top:8px;border:1px solid var(--ax-border);border-radius:8px;background:rgba(0,0,0,.02)}
        .springer-md-log__header{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid var(--ax-border);background:rgba(0,0,0,.03)}
        .springer-md-log__title{font-size:11px;font-weight:700;color:var(--ax-muted)}
        .springer-md-log__actions{display:flex;gap:4px}
        .springer-md-log__btn{padding:2px 6px;font-size:10px;border:0;border-radius:4px;cursor:pointer;background:transparent;color:var(--ax-muted);font-weight:500}
        .springer-md-log__btn:hover{color:var(--ax-text);background:rgba(0,0,0,.05)}
        .springer-md-log__content{height:120px;overflow-y:auto;padding:6px 8px;font-family:ui-monospace,SFMono-Regular,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:10px;line-height:1.3;white-space:pre-wrap;word-break:break-word;color:var(--ax-text);background:#fff0}
        @media (prefers-color-scheme: dark){.springer-md-log{background:rgba(255,255,255,.02)}.springer-md-log__header{background:rgba(255,255,255,.03)}.springer-md-log__content{background:rgba(0,0,0,.1)}}
        
        /* Footer */
        .springer-md-footer{margin-top:8px;padding-top:6px;border-top:1px solid var(--ax-border);text-align:center;font-size:10px;color:var(--ax-muted)}
        .springer-md-footer a{color:var(--ax-accent);text-decoration:none}
        .springer-md-footer a:hover{text-decoration:underline}
        
        .springer-md-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:${Z + 1};display:none}
        .springer-md-modal{position:fixed;inset:5% 8%;background:var(--ax-bg);color:var(--ax-text);border:1px solid var(--ax-border);border-radius:12px;box-shadow:var(--ax-shadow);display:none;z-index:${Z + 2};overflow:hidden;display:flex;flex-direction:column}
        .springer-md-modal__bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ax-border)}
        .springer-md-modal__title{font-size:13px;font-weight:700}
        .springer-md-modal__tools{display:flex;gap:6px;align-items:center}
        .springer-md-modal__select{font-size:12px;padding:4px 6px}
        .springer-md-modal__body{flex:1;overflow:auto;padding:12px;background:linear-gradient(180deg,rgba(0,0,0,.02),transparent 60%)}
        .springer-md-modal__pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Microsoft Yahei Mono",monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.45;padding:12px;border:1px dashed var(--ax-border);border-radius:8px;background:#fff0}
        @media (prefers-color-scheme: dark){.springer-md-modal__pre{background:rgba(255,255,255,.02)}}
        `);

            const panel = document.createElement('div');
            panel.className = 'springer-md-panel';
            panel.innerHTML = `
        <div class="springer-md-panel__head">
          <div class="springer-md-panel__title">
            <span class="springer-md-badge">Springer</span>
            <span>Markdown 导出</span>
          </div>
          <button class="springer-md-btn springer-md-btn--ghost" data-action="toggle">折叠</button>
          <span class="springer-md-panel__drag" title="拖拽移动位置">⇕</span>
        </div>
        <div class="springer-md-panel__btns" data-role="buttons">
          <button class="springer-md-btn" data-action="preview" data-mode="links">预览 · Links</button>
          <button class="springer-md-btn springer-md-btn--secondary" data-action="preview" data-mode="base64">预览 · Base64</button>
          <button class="springer-md-btn" data-action="links">导出 · 链接</button>
          <button class="springer-md-btn" data-action="base64">导出 · Base64</button>
          <button class="springer-md-btn springer-md-btn--secondary" data-action="textbundle">导出 · TextBundle</button>
          <button class="springer-md-btn springer-md-btn--ghost" data-action="debug-log">调试日志</button>
        </div>
        <div class="springer-md-log springer-md-hide" data-role="debug-log">
          <div class="springer-md-log__header">
            <span class="springer-md-log__title">调试日志</span>
            <div class="springer-md-log__actions">
              <button class="springer-md-log__btn" data-action="clear-log">清空</button>
              <button class="springer-md-log__btn" data-action="copy-log">复制</button>
            </div>
          </div>
          <div class="springer-md-log__content"></div>
        </div>
        <div class="springer-md-footer">
          © Qi Deng - <a href="https://github.com/nerdneilsfield/neils-monkey-scripts/" target="_blank">GitHub</a>
        </div>
        `;
            document.body.appendChild(panel);

            const btns = panel.querySelector('[data-role="buttons"]');
            panel.querySelector('[data-action="toggle"]')?.addEventListener('click', () => btns.classList.toggle('springer-md-hide'));

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
                        const { overlay, modal } = UI._ensurePreview();
                        UI._openPreview(modal, overlay, md, mode, controller);
                    }
                    if (act === 'debug-log') {
                        const logPanel = panel.querySelector('[data-role="debug-log"]');
                        logPanel.classList.toggle('springer-md-hide');
                        if (!logPanel.classList.contains('springer-md-hide')) {
                            Log._updateUI(); // Update content when showing
                        }
                    }
                    if (act === 'clear-log') {
                        Log.clear();
                    }
                    if (act === 'copy-log') {
                        Log.copy();
                    }
                } catch (err) {
                    Log.error(err);
                    alert('执行失败：' + (err?.message || err));
                }
            });

            // 拖拽（可选：持久化）
            const dragHandle = panel.querySelector('.springer-md-panel__drag');
            let dragging = false, sx = 0, sy = 0, startRect = null;
            const onMove = (ev) => {
                if (!dragging) return;
                const dx = ev.clientX - sx, dy = ev.clientY - sy;
                let left = startRect.left + dx, top = startRect.top + dy;
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
            };
            dragHandle?.addEventListener('mousedown', (ev) => {
                dragging = true; sx = ev.clientX; sy = ev.clientY; startRect = panel.getBoundingClientRect();
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        },

        _ensurePreview() {
            let overlay = document.querySelector('.springer-md-overlay');
            let modal = document.querySelector('.springer-md-modal');
            if (overlay && modal) return { overlay, modal };

            overlay = document.createElement('div');
            overlay.className = 'springer-md-overlay';
            modal = document.createElement('div');
            modal.className = 'springer-md-modal';
            modal.innerHTML = `
        <div class="springer-md-modal__bar">
          <div class="springer-md-modal__title">Markdown 预览</div>
          <div class="springer-md-modal__tools">
            <select class="springer-md-modal__select" data-role="mode">
              <option value="links" selected>Links</option>
              <option value="base64">Base64</option>
            </select>
            <button class="springer-md-btn springer-md-btn--secondary" data-action="copy">复制</button>
            <button class="springer-md-btn" data-action="download">下载 .md</button>
            <button class="springer-md-btn springer-md-btn--ghost" data-action="close">关闭</button>
          </div>
        </div>
        <div class="springer-md-modal__body">
          <pre class="springer-md-modal__pre" data-role="content">加载中...</pre>
        </div>
        `;
            document.body.appendChild(overlay);
            document.body.appendChild(modal);

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
                    a.download = 'springer_preview.md'; a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 0);
                }
            });
            modal.querySelector('[data-role="mode"]')?.addEventListener('change', async (e) => {
                const mode = e.target.value;
                const md = await UI._genMarkdownForPreview(window.__SP_CTRL__, mode);
                modal.querySelector('[data-role="content"]').textContent = md;
            });

            return { overlay, modal };
        },

        async _genMarkdownForPreview(controller, mode) {
            controller._prepareRun(mode, false);  // ← 预览时不清除缓存
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
        _closePreview(modal, overlay) { overlay.style.display = 'none'; modal.style.display = 'none'; },
    };

    // -----------------------------
    // 9) Boot
    // -----------------------------
    function boot() {
        try {
            const ok = /^\/chapter\//.test(location.pathname) || /^\/article\//.test(location.pathname);
            if (!ok) { Log.warn('当前不在 Springer 章节页或文章页，UI 不加载。'); return; }
            const controller = new Controller();
            window.__SP_CTRL__ = controller; // for preview
            UI.mount(controller);
            Log.info(`[${Config.APP_NAME}] UI mounted`);
        } catch (err) {
            Log.error('Boot error:', err);
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
