// ==UserScript==
// @name         MDPI Chapter to Markdown Exporter (Framework)
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Export MDPI chapter pages to Markdown (Links/Base64/TextBundle) — Framework Only
// @author       qiqi
// @match        https://www.mdpi.com/*
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
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/mdpi-markdown-exporter.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/scholar/mdpi-markdown-exporter.user.js
// ==/UserScript==

/* eslint-disable no-console */
(function () {
    'use strict';

    // -----------------------------
    // 0) Config & Feature Flags
    // -----------------------------
    const Config = {
        APP_NAME: 'MDPI → Markdown',
        VERSION: '0.1.0-framework',
        BASE_ORIGIN: 'https://www.mdpi.com',
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
        info: (...a) => console.log(`[${Config.APP_NAME}]`, ...a),
        warn: (...a) => console.warn(`[${Config.APP_NAME}]`, ...a),
        error: (...a) => console.error(`[${Config.APP_NAME}]`, ...a),
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
    class MDPIAdapter {
        /**
         * @param {Document} doc
         */
        constructor(doc) {
            this.doc = doc;
            this.baseHref = location.href;
            this.origin = location.origin;
            // MDPI 静态资源常走 pub.mdpi-res.com
            this.cdnOrigin = (doc.documentElement.innerHTML.includes('pub.mdpi-res.com'))
                ? 'https://pub.mdpi-res.com'
                : this.origin;

            const metaDOI = U.$('meta[name="citation_doi"]')?.getAttribute('content') || '';
            this.doi = metaDOI || null;

            // 站点链接
            this.links = {
                html: location.href,
                html_full: U.$('meta[name="citation_fulltext_html_url"]')?.getAttribute('content') || null,
                doi: this.doi ? `https://doi.org/${this.doi.replace(/^https?:\/\/doi\.org\//i, '')}` : null,
                pdf: U.$('meta[name="citation_pdf_url"]')?.getAttribute('content') || null,
            };

            // 供 walk 时使用
            this._citeMap = new Map();
        }

        // ===== 工具 =====

        _abs(url) {
            if (!url) return url;
            // 图像大多以 /sensors/... or /.../article_deploy/... 开头，默认走 cdn
            if (/^\/(sensors|.*\/article_deploy)\//i.test(url)) return new URL(url, this.cdnOrigin).toString();
            return U.absolutize(url, this.baseHref);
        }

        _cleanCaption(label, desc) {
            // 去掉 "Figure N." / "Fig. N." 前缀
            const l = String(label || '').replace(/^\s*(figure|fig\.?)\s*\d+[.:]?\s*/i, '').trim();
            const d = String(desc || '').replace(/^\s*(figure|fig\.?)\s*\d+[.:]?\s*/i, '').trim();
            const merged = [l, d].filter(Boolean).join(l && d ? ' ' : '') || l || d;
            return U.mergeSoftWraps(merged);
        }

        _parseRefNumber(hrefOrId) {
            // "#B1-sensors-25-00973" / "B12-sensors-..." / "...#B3-sensors-..."
            const s = String(hrefOrId || '');
            const m = s.match(/#?B(\d{1,4})\b/i);
            return m ? parseInt(m[1], 10) : null;
        }

        // —— MathML → TeX（摘自 SpringerAdapter，同步最常用标签）——
        _mmlToTex(el) {
            if (!el) return null;
            const s = [];
            const walk = (node) => {
                if (!node || !node.tagName) return;
                const tag = node.tagName.toLowerCase();
                const child = () => { for (const c of node.children) walk(c); };
                const text = (t) => { s.push(String(t || '')); };
                switch (tag) {
                    case 'math': child(); break;
                    case 'mrow': child(); break;
                    case 'mi':
                    case 'mn':
                    case 'mo': {
                        const t = (node.textContent || '').trim();
                        if (/^log$/i.test(t)) { s.push('\\log '); break; }   // 前缀 log
                        // 其它保持原样
                        s.push(t);
                        break;
                    }
                    case 'mfrac': {
                        const [a, b] = Array.from(node.children);
                        s.push('\\frac{'); if (a) walk(a); s.push('}{'); if (b) walk(b); s.push('}'); break;
                    }
                    case 'msqrt': { s.push('\\sqrt{'); child(); s.push('}'); break; }
                    case 'msup': {
                        const [base, sup] = Array.from(node.children);
                        if (base) walk(base); s.push('^'); s.push('{'); if (sup) walk(sup); s.push('}'); break;
                    }
                    case 'msub': {
                        const [base, sub] = Array.from(node.children);
                        if (base) walk(base); s.push('_'); s.push('{'); if (sub) walk(sub); s.push('}'); break;
                    }
                    case 'msubsup': {
                        const [base, sub, sup] = Array.from(node.children);
                        if (base) walk(base);
                        s.push('_'); s.push('{'); if (sub) walk(sub); s.push('}');
                        s.push('^'); s.push('{'); if (sup) walk(sup); s.push('}');
                        break;
                    }

                    case 'mfenced': {
                        const open = node.getAttribute('open') || '(';
                        const close = node.getAttribute('close') || ')';
                        s.push(open); child(); s.push(close); break;
                    }
                    default: child(); break;
                }
            };
            walk(el);
            return U.mergeSoftWraps(s.join('')).replace(/\s+/g, ' ');
        }

        _findEquationNumberNearby(node) {
            const scope = node?.closest?.('figure, div, p, table, section') || node?.parentElement || null;
            if (!scope) return null;
            const t = scope.textContent || '';
            const m = t.match(/\((\d{1,3})\)\s*$/);
            return m ? m[1] : null;
        }

        // 1) 解析作者区：姓名 + 紧随其后的 <sup>（如 "1,*"）
        // 新增/替换：解析作者块（保留 name+marks）
        _parseAuthorsFromHeader() {
            const root = U.$('.art-authors'); if (!root) return [];
            const out = [];
            for (const drop of U.$all('.art-authors .profile-card-drop', root)) {
                const name = (drop.textContent || '').trim();
                let sup = drop.nextSibling;
                while (sup && !(sup.tagName === 'SUP' && /[\d*†]+/.test(sup.textContent || ''))) sup = sup.nextSibling;
                const marks = sup ? sup.textContent.replace(/\s+/g, '') : '';
                out.push({ name, marks });
            }
            return out;
        }

        // 新增/替换：解析机构与备注；数字→机构，*,†→备注；无上标但有机构名→自动编号
        _parseAffiliationsAndNotes() {
            const root = U.$('.art-affiliations');
            const aff = [], notes = [];
            if (!root) return { aff, notes };

            let autoNum = 1;
            for (const row of U.$all('.affiliation', root)) {
                const keyEl = row.querySelector('.affiliation-item sup');
                const nameEl = row.querySelector('.affiliation-name');
                const txt = U.mergeSoftWraps(nameEl ? nameEl.textContent || '' : '').trim();
                if (!txt) continue;

                const key = (keyEl && (keyEl.textContent || '').trim()) || '';
                if (/^\d+$/.test(key)) {
                    aff.push({ key, text: txt });
                } else if (/^[*†]+$/.test(key)) {
                    notes.push({ key, text: txt });        // e.g. "* Author to whom correspondence..."
                } else {
                    // 没有上标，但确实是机构名 → 自动编号
                    aff.push({ key: String(autoNum++), text: txt });
                }
            }
            return { aff, notes };
        }

        // ===== Public API =====

        getMeta() {
            const title =
                U.$('meta[name="citation_title"]')?.getAttribute('content') ||
                U.text(U.$('h1')) || document.title || 'Untitled';

            // 1) 作者：meta → 对象数组 {name}，页面兜底
            const headerAuthors = this._parseAuthorsFromHeader();
            let authors = headerAuthors.length
                ? headerAuthors.map(a => {
                    const nm = this._normalizeName(a.name);
                    return { name: a.marks ? `${nm}<sup>${a.marks}</sup>` : nm };
                })
                : U.$all('meta[name="citation_author"]').map(m => ({ name: this._normalizeName(m.content) }));

            // 机构+备注
            const { aff: affiliations, notes } = this._parseAffiliationsAndNotes();

            // 2) 摘要 / 关键词
            const absRoot = U.$('#html-abstract, section#html-abstract');
            let abstract = '';
            if (absRoot) {
                const parts = [];
                for (const el of U.$all('.html-p', absRoot)) {
                    const html = (typeof this.transformInline === 'function')
                        ? this.transformInline(el, this._citeMap)
                        : (el.textContent || '');
                    const cleaned = html.replace(/<[^>]+>/g, '').trim();
                    if (cleaned) parts.push(cleaned);
                }
                abstract = parts.join('\n\n');
            }

            const keywords = U.$all('#html-keywords a').map(a => a.textContent.trim()).filter(Boolean);

            // 3) 额外字段（供本脚本命名用；不改通用 Exporter）
            const extra = {
                journal: U.$('meta[name="citation_journal_title"]')?.content || 'MDPI',
                year: U.$('meta[name="citation_year"]')?.content || '',
                volume: U.$('meta[name="citation_volume"]')?.content || '',
                issue: U.$('meta[name="citation_issue"]')?.content || '',
                article: (new URL(location.href)).pathname.split('/').pop() || ''
            };

            return { title, authors, abstract, keywords, doi: this.doi, links: this.links, affiliations, notes };
        }

        async collectBibliography() {
            const list = U.$('#html-references_list');
            const items = list ? U.$all('li[id^="B"]', list) : [];
            const out = [];
            let num = 1;
            for (const li of items) {
                const id = li.id || `B${num}`;

                const clone = li.cloneNode(true);
                for (const a of Array.from(clone.querySelectorAll('a'))) {
                    a.replaceWith(document.createTextNode(a.textContent || '')); // 去链接留文字
                }
                const text = U.mergeSoftWraps(clone.textContent || '');

                const doiA = li.querySelector('a[href*="doi.org/"]');
                const url = doiA ? doiA.getAttribute('href') : null;
                const doi = url ? url.replace(/^https?:\/\/doi\.org\//i, '') : null;

                out.push({ num, id, text, url, doi });
                num++;
            }
            return out;
        }


        buildCitationMap(bibItems) {
            const map = new Map();
            for (const it of (bibItems || [])) {
                if (!Number.isInteger(it?.num)) continue;
                const id = it.id || '';
                if (!id) continue;
                map.set(`#${id}`, it.num);
                map.set(id, it.num);
                map.set(`${location.pathname}#${id}`, it.num);
                map.set(`${location.origin}${location.pathname}#${id}`, it.num);
            }
            this._citeMap = map;
            return map;
        }

        transformInline(node, citeMap) {
            const root = node.cloneNode(true);

            // 0) 处理HTML列表
            for (const ul of Array.from(root.querySelectorAll('ul.html-disc, ul.html-bullet'))) {
                const items = Array.from(ul.querySelectorAll('li')).map(li => {
                    const text = (li.textContent || '').trim();
                    return `- ${text}`;
                }).join('\n');
                ul.replaceWith(document.createTextNode('\n\n' + items + '\n\n'));
            }

            // 1) 处理斜体
            for (const span of Array.from(root.querySelectorAll('span.html-italic'))) {
                const text = (span.textContent || '').trim();
                if (text) {
                    span.replaceWith(document.createTextNode(`*${text}*`));
                }
            }

            // 2) 文内参考
            for (const a of Array.from(root.querySelectorAll('a.html-bibr[href^="#"]'))) {
                const href = a.getAttribute('href') || '';
                const n = this._citeMap.get(href) || this._citeMap.get(href.replace(/^#/, '')) || this._parseRefNumber(href);
                a.replaceWith(document.createTextNode(Number.isInteger(n) ? `[^R${n}]` : ''));
            }

            // 3) 算法表格特殊处理
            for (const table of Array.from(root.querySelectorAll('table.html-array_table'))) {
                const processAlgorithmContent = (text) => {
                    // 提取 LaTeX 格式（在 $ 符号内的）并移除重复的纯文本
                    // 例如：PosPixel←∅$PosPixel←∅$ → $PosPixel←∅$
                    text = text.replace(/([^$\s]+[←∈≠∪]+[^$\s]*)\s*\$([^$]+)\$/g, (match, plain, latex) => {
                        // 如果 LaTeX 内容包含相似的内容，只保留 LaTeX
                        if (latex.includes(plain.substring(0, 3))) {
                            return `$${latex}$`;
                        }
                        return match;
                    });

                    // 清理独立的 Unicode 数学符号
                    text = text.replace(/([A-Za-z]+[←∈≠∪]+[A-Za-z∅]*)\s+/g, '');

                    // 移除 <math> 标签
                    text = text.replace(/<math[^>]*>[\s\S]*?<\/math>/g, '');

                    // 合并空格
                    text = text.replace(/\s+/g, ' ');

                    return text.trim();
                };

                const algorithmTitle = table.querySelector('b')?.textContent || '';
                const lines = [];

                // 添加标题
                if (algorithmTitle) {
                    lines.push(algorithmTitle);
                }

                // 处理 Require 行
                const requireText = table.textContent?.match(/Require:[^1]*/)?.[0];
                if (requireText) {
                    lines.push(processAlgorithmContent(requireText));
                }

                // 处理编号行
                const rows = Array.from(table.querySelectorAll('dt, dd'));
                if (rows.length > 0) {
                    for (const row of rows) {
                        const lineNum = row.parentElement?.querySelector('dt')?.textContent || '';
                        const lineContent = (row.querySelector('.html-p')?.innerHTML || row.textContent || '').trim();
                        const processed = processAlgorithmContent(lineContent);
                        if (lineNum && processed) {
                            lines.push(`${lineNum} ${processed}`);
                        } else if (processed) {
                            lines.push(processed);
                        }
                    }
                } else {
                    // 如果没有结构化的行，按行号分割
                    const content = (table.textContent || '');
                    const lineMatches = content.matchAll(/(\d+):\s*([^0-9][^\n]*?)(?=\d+:|$)/g);
                    for (const match of lineMatches) {
                        const processed = processAlgorithmContent(match[2]);
                        if (processed) {
                            lines.push(`${match[1]}: ${processed}`);
                        }
                    }
                }

                // 构建 Markdown 代码块，确保前后有空行
                let markdown = '\n\n```algorithm\n';
                markdown += lines.join('\n');
                markdown += '\n```\n\n';

                table.replaceWith(document.createTextNode(markdown));
            }

            // 4) 处理公式区域（包括可能不完整的）
            for (const div of Array.from(root.querySelectorAll('.html-disp-formula-info'))) {
                const label = div.querySelector('label')?.textContent || '';
                const mjDisplay = div.querySelector('.MathJax_Display');

                // 尝试提取公式内容
                let formula = '';

                // 从 MathJax_Display 提取
                if (mjDisplay && mjDisplay.textContent?.trim()) {
                    formula = mjDisplay.textContent.trim();
                }

                // 如果没有内容，查找前面的段落可能包含公式
                if (!formula) {
                    const prevElement = div.previousElementSibling;
                    if (prevElement) {
                        const text = prevElement.textContent || '';
                        // 查找可能的公式模式
                        const formulaMatch = text.match(/H\s*=\s*T[·⋅]\s*TDP.*$/);
                        if (formulaMatch) {
                            formula = 'H = T \\cdot TDP';
                        }
                    }
                }

                // 生成公式块
                if (formula && label) {
                    div.replaceWith(document.createTextNode(`\n\n$$${formula} \\tag{${label}}$$\n\n`));
                } else if (label) {
                    // 公式缺失但有标签
                    div.replaceWith(document.createTextNode(`\n\n$$\\text{[Formula ${label} missing]}$$\n\n`));
                } else {
                    div.remove();
                }
            }

            // 5) MathJax 处理
            const mjToTex = (el) => {
                // 检查空的 MathJax Display
                if (el.classList.contains('MathJax_Display') && !el.textContent?.trim()) {
                    const parent = el.closest('.html-disp-formula-info');
                    if (parent) {
                        const label = parent.querySelector('label')?.textContent || '';
                        return label ? `$$\\text{[Formula missing]} \\tag{${label}}$$` : '';
                    }
                    return '';
                }

                // 其他 MathJax 提取逻辑...
                const assist = el.querySelector('.MJX_Assistive_MathML');
                if (assist) {
                    let t = (assist.textContent || '').trim();
                    if (t.includes('<math')) {
                        try {
                            const mml = new DOMParser().parseFromString(t, 'text/xml').documentElement;
                            const tex = this._mmlToTex(mml) || '';
                            return tex ? `$${tex}$` : '';
                        } catch { }
                    }
                    if (!/^\$.+\$$/.test(t)) t = '$' + t + '$';
                    return t;
                }

                const mmlStr = el.getAttribute('data-mathml');
                if (mmlStr) {
                    try {
                        const mml = new DOMParser().parseFromString(mmlStr, 'text/xml').documentElement;
                        const tex = this._mmlToTex(mml) || '';
                        return tex ? `$${tex}$` : '';
                    } catch { }
                }

                return '';
            };

            // 6) 处理公式显示区域
            for (const div of Array.from(root.querySelectorAll('.html-disp-formula-info'))) {
                const mjDisplay = div.querySelector('.MathJax_Display');
                const label = div.querySelector('label')?.textContent || '';

                if (mjDisplay) {
                    const tex = mjToTex(mjDisplay);
                    if (tex) {
                        // 修正 \tag 格式
                        const replacement = tex.includes('$$')
                            ? tex.replace('$$', `$$ \\tag{${label}}`)
                            : `$${tex}$ (${label})`;
                        div.replaceWith(document.createTextNode('\n' + replacement + '\n'));
                    } else if (label) {
                        div.replaceWith(document.createTextNode(`\n$$\\text{[Formula missing]} \\tag{${label}}$$\n`));
                    } else {
                        div.remove();
                    }
                }
            }

            // 7) 处理其他 MathJax
            for (const span of Array.from(root.querySelectorAll('span.MathJax'))) {
                const tex = mjToTex(span);
                if (tex) {
                    const prev = span.previousSibling;
                    if (prev && prev.nodeType === 3) {
                        prev.textContent = prev.textContent
                            .replace(/\b[eE]\s*[pP]\s*[sS]\s*$/, '')
                            .replace(/\bO\s*\(\s*n\s*[\d\s√^]*\)\s*$/i, '')
                            .replace(/\blog\s*n\s*$/i, '');
                    }

                    const fixed = tex
                        .replace(/\u2212/g, '-')
                        .replace(/\$log\s*([A-Za-z0-9])\$/g, '$\\log $1$');

                    span.replaceWith(document.createTextNode(fixed));
                } else {
                    span.remove();
                }
            }

            // 清理残留元素
            for (const x of Array.from(root.querySelectorAll(
                'span.MathJax_Preview, script[type="math/mml"], .MJX_Assistive_MathML, math'
            ))) {
                x.remove();
            }

            // 8) 获取HTML并后处理
            let html = root.innerHTML
                .replace(/&nbsp;/g, ' ')
                .replace(/\s{3,}/g, ' ')
                .trim();

            // 修正常见的 LaTeX 错误
            html = html
                .replace(/\$\\tage\{/g, '$\\tag{')  // 修正 \tage 拼写错误
                .replace(/\$\s*\\tag\{\(/g, '$$\\tag{')  // 修正独立公式的 tag
                .replace(/\)\}\s*\$/g, '}$$')  // 配对结束
                .replace(/\\tag\{\((\d+)\)\}/g, '\\tag{$1}');  // 简化标签格式

            // 合并括号内的公式
            html = html.replace(/\(\s*\$O\(([^$]*)\$\s*\$([^$]+)\$\s*\)/g, '$O($1$2)$');
            html = html.replace(/\(\s*\$([^$]+)\$\s*\$([^$]+)\$\s*\)/g, '$($1 $2)$');

            // 修正 log 格式
            html = html.replace(/\$([^$]*)\$/g, (m, body) => {
                const b = body
                    .replace(/\blog\s*([A-Za-z0-9])/g, '\\log $1')
                    .replace(/\blog\s+/g, '\\log ');
                return `$${b}$`;
            });

            // 脚注处理
            html = html.replace(/\[\s*((?:\[\^R\d+\]\s*(?:,\s*)?)*)\s*\]/g, (m, inner) =>
                inner.replace(/,\s*/g, ', ')
            );
            html = html.replace(/\[\s*\[\^R(\d+)\]\s*[–—-]\s*\[\^R(\d+)\]\s*\]/g, '[^R$1]–[^R$2]');

            // 最终清理
            html = html
                .replace(/&nbsp;/g, ' ')
                .replace(/\s{3,}/g, ' ')
                .trim();

            // 修复不完整的公式标签
            html = html.replace(/\$\s*\\tag\{([^}]+)\}\s*$/gm, (match, tag) => {
                // 如果只有 tag 没有公式内容，尝试从上下文恢复
                return `$$\\text{[Formula]} \\tag{${tag}}$$`;
            });

            // 确保代码块前后有空行
            html = html.replace(/([^\n])\n```/g, '$1\n\n```');
            html = html.replace(/```\n([^\n])/g, '```\n\n$1');

            return html;
        }

        walkSections() {
            const out = [];
            const root = U.$('.html-body') || document.body;

            const secs = U.$all('section[id^="sec"]', root);
            for (const sec of secs) {
                // MDPIAdapter.walkSections 内，找到 titleEl 的那行并替换：
                const titleEl = sec.querySelector(':scope > h2, :scope > header > h2, :scope > h3, :scope > header > h3, :scope > h4, :scope > header > h4');
                if (!titleEl) continue; // 没标题跳过，避免输出“Section”
                const rawTitle = U.text(titleEl) || '';
                const title = U.mergeSoftWraps(rawTitle);

                // 标题级别：按标签名决定
                let level = 2;
                const tn = (titleEl.tagName || '').toUpperCase();
                if (tn === 'H3') level = 3;
                else if (tn === 'H4') level = 4;

                const anchor = sec.id || U.slug(title);
                const nodes = [];

                for (let el = sec.firstElementChild; el; el = el.nextElementSibling) {
                    if (el === titleEl) continue;

                    // 段落：div.html-p → 造一个 <p>，并做最小清洗（引文、行内 MathML）
                    if (el.matches && el.matches('div.html-p')) {
                        const p = document.createElement('p');
                        p.innerHTML = el.innerHTML; // 克隆其子结构（保留 <a>/<em>/<strong> 等行内格式）

                        // 引文 a.html-bibr → [^Rn]
                        for (const a of Array.from(p.querySelectorAll('a.html-bibr[href^="#B"]'))) {
                            const href = a.getAttribute('href') || '';
                            const n = this._citeMap.get(href) || this._citeMap.get(href.replace(/^#/, '')) || this._parseRefNumber(href);
                            if (Number.isInteger(n) && n > 0) a.replaceWith(document.createTextNode(`[^R${n}]`));
                        }

                        // 行内 MathML → `$...$`
                        const pendingBlocks = [];
                        for (const m of Array.from(p.querySelectorAll('math'))) {
                            const tex = this._mmlToTex(m);
                            if (!tex) continue;
                            const isBlock = (m.getAttribute('display') || '').toLowerCase() === 'block';

                            if (isBlock) {
                                // 1) 先克隆出来，稍后与段落一并入列（保持相对顺序尽量不乱）
                                const blk = m.cloneNode(true);
                                pendingBlocks.push(blk);

                                // 2) 安全移除：不要用 p.removeChild(m)
                                try {
                                    if (typeof m.remove === 'function') m.remove();
                                    else if (m.parentNode) m.parentNode.removeChild(m);
                                } catch (_) {
                                    // 忽略个别浏览器的奇怪行为，避免阻断
                                }
                            } else {
                                // 行内 math → $...$（就地替换即可）
                                m.replaceWith(document.createTextNode(`$${tex}$`));
                            }
                        }


                        // 空段落过滤
                        const txt = (p.textContent || '').trim();
                        if (txt) nodes.push(p);

                        // 把块级公式紧跟着这个段落入列（保证不乱序、也不卡在段首）
                        for (const blk of pendingBlocks) nodes.push(blk);

                        continue;
                    }

                    // 图：div.html-fig-wrap → 造一个 <figure>，把原根存起来
                    if (el.matches && el.matches('div.html-fig-wrap')) {
                        const fig = document.createElement('figure');
                        // 暗藏原节点引用
                        fig.__mdpiFig = el;
                        nodes.push(fig);
                        continue;
                    }

                    // 表（原生 <table> 直接交给 extractTable）
                    if (/^table$/i.test(el.tagName)) { nodes.push(el); continue; }

                    // 列表/代码
                    if (/^(ul|ol|pre)$/i.test(el.tagName)) { nodes.push(el); continue; }

                    // 块级 MathML（少数情况是独立节点）
                    if (/^math$/i.test(el.tagName)) { nodes.push(el); continue; }
                }
                out.push({ level, title, anchor, nodes });
            }
            return out;
        }

        // —— 提取：块级方程 ——（给 Controller 分支使用；MDPI 多为 <math>，仍兜底支持）
        extractEquationBlock(node) {
            const m = node?.querySelector?.('math') || null;
            if (!m) return null;
            const tex = this._mmlToTex(m);
            if (!tex) return null;
            const tagNo = this._findEquationNumberNearby(node) || null;
            return { type: 'display', tex: tagNo ? `${tex} \\tag{${tagNo}}` : tex };
        }

        // —— 提取：<math> ——（Controller 有 tag==='math' 分支会用）
        extractMath(m) {
            const tex = this._mmlToTex(m);
            if (!tex) return null;
            const isDisplay = (m.getAttribute('display') || '').toLowerCase() === 'block';
            const tagNo = this._findEquationNumberNearby(m) || null;
            return { type: isDisplay ? 'display' : 'inline', tex: tagNo ? `${tex} \\tag{${tagNo}}` : tex };
        }

        // —— 识别“表格型 figure”与容器：MDPI 我们直接在 walk 阶段分流，这里给默认实现即可 —— 
        isTableLikeFigure(node) { return !!(node && node.querySelector && node.querySelector('table')); }
        isTableContainer(node) { return !!(node && node.matches && node.matches('div.html-table-wrap, div.table-wrap')); }

        // —— 提取：表 ——（与 SpringerAdapter 同款策略：简单表 → Markdown，复杂/超宽 → 内嵌 HTML）
        async extractTable(node) {
            const table = node.tagName?.toLowerCase() === 'table' ? node : node.querySelector?.('table');
            if (!table) return { html: node.outerHTML };

            // 1) 判定是否直接回退为 HTML（更稳）
            const hasSpan = table.querySelector('td[rowspan], td[colspan], th[rowspan], th[colspan]');
            const hasBlockMath = !!table.querySelector('math[display="block"], .html-disp-formula-info, .equation');
            const hasNestedTable = !!table.querySelector('table table');
            const hasFigureLike = !!table.querySelector('img, svg, figure, .html-fig-wrap');
            const rowsAll = Array.from(table.querySelectorAll('tr'));
            const colCount = rowsAll.reduce((m, r) => Math.max(m, r.children.length), 0);
            const maxCols = 8;

            if (hasSpan || hasBlockMath || hasNestedTable || hasFigureLike || colCount > maxCols) {
                return { html: table.outerHTML };
            }

            // 2) 收集表头与表体（先走行内转换，再做 Markdown）
            const headers = [];
            const thead = table.querySelector('thead');
            if (thead) {
                for (const tr of thead.querySelectorAll('tr')) {
                    headers.push(this._cellsToText(tr.querySelectorAll('th, td')));
                }
            }
            const body = [];
            const tb = table.querySelector('tbody') || table;
            for (const tr of tb.querySelectorAll('tr')) {
                body.push(this._cellsToText(tr.querySelectorAll('td, th')));
            }

            // 3) 生成 Markdown 表格
            // 若无 thead，则用第一行 body 充当表头（可选）
            const lines = [];
            if (headers.length) {
                const h = headers[0].map(this._escapeMdCell);
                lines.push('| ' + h.join(' | ') + ' |');
                lines.push('|' + h.map(() => ' --- ').join('|') + '|');
            } else if (body.length) {
                const h = body[0].map(this._escapeMdCell);
                lines.push('| ' + h.join(' | ') + ' |');
                lines.push('|' + h.map(() => ' --- ').join('|') + '|');
                body.shift(); // 第一行已经被当头
            }

            for (const r of body) {
                const row = r.map(this._escapeMdCell);
                lines.push('| ' + row.join(' | ') + ' |');
            }

            return { markdown: lines.join('\n') };
        }

        // —— 单元格 → 纯文本/内联 HTML（保留 sub/sup/em/strong/code，处理行内公式/脚注/链接） —— //
        _cellsToText(cells) {
            const out = [];
            for (const td of Array.from(cells)) {
                // a) 统一做行内转换（<math>→$…$、脚注、残影清理等）
                let html = (typeof this.transformInline === 'function')
                    ? this.transformInline(td, this._citeMap)
                    : (td.innerHTML || '');

                // b) <a> → Markdown 链接
                html = html.replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, txt) =>
                    `[${U.unescapeHtml(txt)}](${U.absolutize(href)})`
                );

                // c) 允许的行内标签白名单；其他标签去掉；<br> 统一为 <br>
                html = html
                    .replace(/<br\s*\/?>/gi, '<br>') // 标准化换行
                    .replace(/<(?!\/?(sub|sup|em|strong|code)\b)[^>]+>/gi, '') // 去掉非白名单标签
                    .replace(/\s+/g, ' ')
                    .trim();

                // d) 空单元格至少放一个空格，维持栅格
                out.push(html || ' ');
            }
            return out;
        }

        // —— Markdown 单元格字符转义（管道与反斜杠等），并把 <br> 转换成换行占位 —— //
        _escapeMdCell(s) {
            // 允许内联 HTML（sub/sup/em/strong/code 已保留），主要处理 | 与 \
            return String(s)
                .replace(/\|/g, '\\|')
                .replace(/\\/g, '\\\\')
                .replace(/<br>/gi, '<br>'); // GFM 允许 <br> 直接渲染
        }


        // —— 新增：姓,名 → 名 姓
        _normalizeName(s) {
            s = String(s || '').trim();
            const m = s.match(/^\s*([^,]+)\s*,\s*(.+)$/); // Last, First
            if (m) return `${m[2]} ${m[1]}`.replace(/\s+/g, ' ').trim();
            return s;
        }

        // —— 新增：可见作者块兜底
        _authorsFromPage() {
            const root = U.$('.art-authors, #authors');
            if (!root) return [];
            const raw = Array.from(root.querySelectorAll('a, span, div'))
                .map(e => (e.textContent || '').trim())
                .filter(Boolean);
            const names = [...new Set(raw)].filter(x => /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(x));
            return names;
        }




        // —— 提取：图 ——（div.html-fig-wrap → 取 data-large/original/lsrc，清洗标题）
        async extractFigure(node) {
            // node 可能是我们在 walk 里造的 <figure>，原根在 __mdpiFig；也可能未来扩展成原生 <figure>
            const root = node.__mdpiFig || node;
            // 过滤掉包含 <table> 的“表样式 figure”
            if (this.isTableLikeFigure(root)) return null;

            const id = root.getAttribute?.('id') || null;

            const img = root.querySelector?.('img[data-large], img[data-original], img[data-lsrc], img[src]') || null;
            const pick = img?.getAttribute('data-large')
                || img?.getAttribute('data-original')
                || img?.getAttribute('data-lsrc')
                || img?.getAttribute('src')
                || null;
            const src = pick ? this._abs(pick) : null;

            // 标题：div.html-fig_caption / .html-fig_description
            const labelEl = root.querySelector?.('.html-fig_caption b, .html-fig_caption strong') || null;
            const label = labelEl ? (labelEl.textContent || '').trim().replace(/\s+/g, ' ') : '';
            const descEl = root.querySelector?.('.html-fig_caption, .html-fig_description') || null;
            let desc = '';
            if (descEl) {
                // 去掉 labelEl 自身的文字，保留后续描述
                const clone = descEl.cloneNode(true);
                if (labelEl) {
                    for (const b of Array.from(clone.querySelectorAll('b, strong'))) b.remove();
                }
                desc = U.mergeSoftWraps(clone.textContent || '');
            }
            let caption = this._cleanCaption(label, desc) || '';

            if (typeof this.transformInline === 'function') {
                const tmp = document.createElement('div');
                tmp.innerHTML = caption;
                const transformed = this.transformInline(tmp, this._citeMap);
                // transformInline 应返回字符串，这里做个兜底
                caption = typeof transformed === 'string' ? transformed : String(transformed || '');
                // 再去一次标签（极少会有 <em> 之类），只留纯文本
                caption = caption.replace(/<[^>]+>/g, '');
            }

            // SVG 可能极少见，MDPI 主流是位图
            if (src) return { kind: 'img', id, src, caption };
            // 兜底：若存在 svg
            const svg = root.querySelector?.('svg');
            if (svg) return { kind: 'svg', id, inlineSvg: svg.outerHTML, caption };
            return null;
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
            this.adapter = new MDPIAdapter(document);
            this.assets = new AssetsManager();
            this.emitter = new MarkdownEmitter();
            this.exporter = new Exporter();
            this.exporter.bindAssets(this.assets);
        }

        async runPipeline(mode = 'links') {
            this._prepareRun(mode);   // 每次运行先清空
            Log.info('Pipeline start:', mode);

            // 1) Meta / Bib / CiteMap
            const meta = this.adapter.getMeta();
            this._lastMeta = meta;

            const bib = await this.adapter.collectBibliography();
            const citeMap = this.adapter.buildCitationMap(bib);

            const sections = this.adapter.walkSections();

            this._cited = new Set();
            const footF = []; // 预留：非参考类脚注

            // 2) Front matter + TOC
            this.emitter.emitFrontMatter(meta);
            if (Array.isArray(meta.affiliations) && meta.affiliations.length) {
                this.emitter.emitHeading(2, 'Affiliations', 'affiliations');
                for (const a of meta.affiliations) {
                    if (!/^\d+$/.test(a.key)) continue;        // 只输出数字上标
                    this.emitter.emitParagraph(`- <sup>${a.key}</sup> ${a.text}`);
                }
            }
            if (Array.isArray(meta.notes) && meta.notes.length) {
                this.emitter.emitHeading(2, 'Notes', 'notes');
                for (const n of meta.notes) {
                    this.emitter.emitParagraph(`- <sup>${n.key}</sup> ${n.text}`);
                }
            }
            this.emitter.emitTOCPlaceholder();

            // 3) 主体渲染
            for (const sec of sections) {
                this.emitter.emitHeading(sec.level || 2, sec.title || 'Section', sec.anchor);

                for (const node of (sec.nodes || [])) {
                    // —— 优先尝试“站点无关”的块级公式抽取 —— //
                    if (this.adapter.extractEquationBlock) {
                        const em = this.adapter.extractEquationBlock(node);
                        if (em) { this.emitter.emitMath(em); continue; }
                    }

                    const tag = (node.tagName || '').toLowerCase();

                    // —— 段落（支持 adapter.transformParagraph 钩子）—— //
                    if (tag === 'p') {
                        const text = (typeof this.adapter.transformInline === 'function')
                            ? this.adapter.transformInline(node, citeMap)
                            : this._renderParagraphWithCites(node, citeMap);
                        if (text && /\S/.test(text)) this.emitter.emitParagraph(text);
                        continue;
                    }

                    // —— 公式 <math>（站点无关）—— //
                    if (tag === 'math') {
                        const m = this.adapter.extractMath ? this.adapter.extractMath(node) : null;
                        if (m) this.emitter.emitMath(m);
                        continue;
                    }

                    // —— 表：容器 + “表样式figure” + 原生 <table> —— //
                    if (
                        (node.matches && (
                            (this.adapter.isTableContainer && this.adapter.isTableContainer(node)) ||
                            (this.adapter.isTableLikeFigure && this.adapter.isTableLikeFigure(node))
                        )) ||
                        tag === 'table'
                    ) {
                        const t = await this.adapter.extractTable(node);
                        this.emitter.emitTable(t);
                        continue;
                    }

                    // —— 图：纯图片 figure（非表样式）—— //
                    if (tag === 'figure' && !(this.adapter.isTableLikeFigure && this.adapter.isTableLikeFigure(node))) {
                        const fig = await this.adapter.extractFigure(node);
                        if (fig) {
                            if (fig.kind === 'img') {
                                if (mode === 'links') {
                                    this.emitter.emitFigure({ kind: 'img', path: fig.src || fig.path, caption: fig.caption });
                                } else {
                                    const r = await this.assets.fetchRaster(fig.src || fig.path);
                                    this.emitter.emitFigure({ kind: 'img', path: r.assetPath || r.path, caption: fig.caption });
                                }
                                continue;
                            }
                            if (fig.kind === 'svg') {
                                // 兜底去 UI 小图标（保守正则；适配器侧已尽量避免）
                                if (fig.inlineSvg && /class="u-icon"|xlink:href="#icon-eds-/i.test(fig.inlineSvg)) {
                                    // 跳过
                                } else if (mode === 'textbundle') {
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
                                continue;
                            }
                        }
                        // fig==null（例如被识别为表样式），落回其它分支
                    }

                    // —— 列表 / 代码 —— //
                    if (tag === 'ul' || tag === 'ol') {
                        const ordered = (tag === 'ol');
                        const items = Array.from(node.querySelectorAll(':scope > li'));
                        let idx = 1;
                        for (const li of items) {
                            const line = (typeof this.adapter.transformInline === 'function')
                                ? this.adapter.transformInline(li, citeMap)
                                : (li.textContent || '').trim();
                            this.emitter.emitParagraph((ordered ? `${idx}. ` : `- `) + line);
                            idx++;
                        }
                        continue;
                    }
                    if (tag === 'pre') {
                        const code = (node.textContent || '').replace(/\s+$/, '');
                        this.emitter.emitParagraph('```\n' + code + '\n```');
                        continue;
                    }

                    // —— 兜底：允许适配器自定义未知节点渲染 —— //
                    if (typeof this.adapter.renderUnknownNode === 'function') {
                        const txt = this.adapter.renderUnknownNode(node, { citeMap, mode });
                        if (txt) { this.emitter.emitParagraph(txt); continue; }
                    }

                    // —— 最后兜底纯文本 —— //
                    const fallback = (node.textContent || '').trim();
                    if (fallback) {
                        if (typeof this.adapter.transformInline === 'function') {
                            const tmp = document.createElement('div'); tmp.textContent = fallback;
                            const text = this.adapter.transformInline(tmp, citeMap);
                            this.emitter.emitParagraph(text);
                        } else {
                            this.emitter.emitParagraph(fallback);
                        }
                    }
                }
            }

            // 4) 脚注区（References → footnotes），其余脚注合并去重
            const footR = this._makeReferenceFootnotes(bib);
            const footMap = new Map();
            for (const f of [...(footF || []), ...(footR || [])]) {
                if (f?.key && f?.content && !footMap.has(f.key)) footMap.set(f.key, f.content);
            }
            this.emitter.emitFootnotes([...footMap].map(([key, content]) => ({ key, content })));

            // 5) References（全集）
            this.emitter.emitReferences(bib);

            // 6) 汇总输出
            return this.emitter.compose();
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

        _prepareRun(mode) {
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
        .mdpi-md-panel { position: fixed; ${side === 'right' ? 'right: 16px;' : 'left: 16px;'} bottom: 16px; z-index: ${Z};
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Noto Sans CJK SC";
          background: var(--ax-panel); color: var(--ax-text);
          border: 1px solid var(--ax-border); border-radius: 12px; padding: 10px 10px; box-shadow: var(--ax-shadow);
          backdrop-filter: saturate(1.1) blur(6px); user-select: none; }
        .mdpi-md-panel__head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px 0}
        .mdpi-md-panel__title{margin:0;font-size:13px;letter-spacing:.2px;font-weight:700;display:inline-flex;align-items:center;gap:6px}
        .mdpi-md-badge{display:inline-block;padding:2px 6px;font-size:11px;font-weight:700;color:#fff;background:var(--ax-accent);border-radius:999px}
        .mdpi-md-panel__drag{cursor:grab;opacity:.9;font-size:11px;color:var(--ax-muted)} .mdpi-md-panel__drag:active{cursor:grabbing}
        .mdpi-md-panel__btns{display:flex;flex-wrap:wrap;gap:6px}
        .mdpi-md-btn{margin:0;padding:6px 10px;border:0;border-radius:8px;cursor:pointer;background:var(--ax-accent);color:#fff;font-weight:700;font-size:12px;box-shadow:0 1px 0 rgba(0,0,0,.08)}
        .mdpi-md-btn:hover{background:var(--ax-accent-600)}
        .mdpi-md-btn:focus-visible{outline:2px solid #fff;outline-offset:2px}
        .mdpi-md-btn--secondary{background:transparent;color:var(--ax-text);border:1px solid var(--ax-border)}
        .mdpi-md-btn--secondary:hover{background:rgba(0,0,0,.05)}
        .mdpi-md-btn--ghost{background:transparent;color:var(--ax-muted)} .mdpi-md-btn--ghost:hover{color:var(--ax-text)}
        .mdpi-md-hide{display:none!important}
        .mdpi-md-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:${Z + 1};display:none}
        .mdpi-md-modal{position:fixed;inset:5% 8%;background:var(--ax-bg);color:var(--ax-text);border:1px solid var(--ax-border);border-radius:12px;box-shadow:var(--ax-shadow);display:none;z-index:${Z + 2};overflow:hidden;display:flex;flex-direction:column}
        .mdpi-md-modal__bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ax-border)}
        .mdpi-md-modal__title{font-size:13px;font-weight:700}
        .mdpi-md-modal__tools{display:flex;gap:6px;align-items:center}
        .mdpi-md-modal__select{font-size:12px;padding:4px 6px}
        .mdpi-md-modal__body{flex:1;overflow:auto;padding:12px;background:linear-gradient(180deg,rgba(0,0,0,.02),transparent 60%)}
        .mdpi-md-modal__pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Microsoft Yahei Mono",monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.45;padding:12px;border:1px dashed var(--ax-border);border-radius:8px;background:#fff0}
        @media (prefers-color-scheme: dark){.mdpi-md-modal__pre{background:rgba(255,255,255,.02)}}
        `);

            const panel = document.createElement('div');
            panel.className = 'mdpi-md-panel';
            panel.innerHTML = `
        <div class="mdpi-md-panel__head">
          <div class="mdpi-md-panel__title">
            <span class="mdpi-md-badge">Springer</span>
            <span>Markdown 导出</span>
          </div>
          <button class="mdpi-md-btn mdpi-md-btn--ghost" data-action="toggle">折叠</button>
          <span class="mdpi-md-panel__drag" title="拖拽移动位置">⇕</span>
        </div>
        <div class="mdpi-md-panel__btns" data-role="buttons">
          <button class="mdpi-md-btn" data-action="preview" data-mode="links">预览 · Links</button>
          <button class="mdpi-md-btn mdpi-md-btn--secondary" data-action="preview" data-mode="base64">预览 · Base64</button>
          <button class="mdpi-md-btn" data-action="links">导出 · 链接</button>
          <button class="mdpi-md-btn" data-action="base64">导出 · Base64</button>
          <button class="mdpi-md-btn mdpi-md-btn--secondary" data-action="textbundle">导出 · TextBundle</button>
        </div>
        `;
            document.body.appendChild(panel);

            const btns = panel.querySelector('[data-role="buttons"]');
            panel.querySelector('[data-action="toggle"]')?.addEventListener('click', () => btns.classList.toggle('mdpi-md-hide'));

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
                } catch (err) {
                    Log.error(err);
                    alert('执行失败：' + (err?.message || err));
                }
            });

            // 拖拽（可选：持久化）
            const dragHandle = panel.querySelector('.mdpi-md-panel__drag');
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
            let overlay = document.querySelector('.mdpi-md-overlay');
            let modal = document.querySelector('.mdpi-md-modal');
            if (overlay && modal) return { overlay, modal };

            overlay = document.createElement('div');
            overlay.className = 'mdpi-md-overlay';
            modal = document.createElement('div');
            modal.className = 'mdpi-md-modal';
            modal.innerHTML = `
        <div class="mdpi-md-modal__bar">
          <div class="mdpi-md-modal__title">Markdown 预览</div>
          <div class="mdpi-md-modal__tools">
            <select class="mdpi-md-modal__select" data-role="mode">
              <option value="links" selected>Links</option>
              <option value="base64">Base64</option>
            </select>
            <button class="mdpi-md-btn mdpi-md-btn--secondary" data-action="copy">复制</button>
            <button class="mdpi-md-btn" data-action="download">下载 .md</button>
            <button class="mdpi-md-btn mdpi-md-btn--ghost" data-action="close">关闭</button>
          </div>
        </div>
        <div class="mdpi-md-modal__body">
          <pre class="mdpi-md-modal__pre" data-role="content">加载中...</pre>
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
            controller._prepareRun(mode);
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
            const isMDPI = /(^|\.)mdpi\.com$/.test(location.hostname)
                && /\/\d{4}-\d{4}\/\d+\/\d+\/\d+(?:\/htm)?$/.test(location.pathname);
            if (!isMDPI) return; // 非 MDPI 文章页不加载

            const controller = new Controller();        // 复用同一套 UI/Pipeline
            controller.adapter = new MDPIAdapter(document); // 覆盖为 MDPI
            controller._suggestFileName = function (tag, ext = 'md') {
                const safe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
                const meta = this._lastMeta || {};
                const title = safe(meta.title || 'untitled').slice(0, 80).replace(/\s/g, '_');
                const doi = (meta.doi || meta.links?.doi || '').replace(/^https?:\/\/doi\.org\//i, '').replace(/[^\w.-]+/g, '_');
                const host = 'mdpi';
                const j = safe(meta.extra?.journal || '').replace(/\s/g, '_');
                const y = (meta.extra?.year || '').slice(0, 4);
                const v = meta.extra?.volume || '';
                const i = meta.extra?.issue || '';
                const a = meta.extra?.article || '';
                return `${host}_${j}_${y}_${v}_${i}_${a}_${doi || 'article'}_${title}_${tag}.${ext}`;
            };
            window.__MDPI_CTRL__ = controller;
            UI.mount(controller);
            Log.info('[Scholar Exporter] UI mounted (MDPI)');
        } catch (err) {
            Log.error('MDPI boot error:', err);
        }

    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
