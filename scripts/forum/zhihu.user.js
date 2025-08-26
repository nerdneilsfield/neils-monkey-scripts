// ==UserScript==
// @name         知乎问题回答批量/选择性导出为 Markdown
// @namespace    http://tampermonkey.net/
// @version      0.7.3
// @description  在知乎问题页提供下载全部回答或选择部分回答导出为 Markdown 的功能
// @author       Qi Deng
// @match        https://www.zhihu.com/question/*
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/lib/turndown.umd.js
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/forum/zhihu.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/forum/zhihu.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Turndown Configuration ---
    const turndownService = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        fence: '```',
        emDelimiter: '*',
        strongDelimiter: '**',
        linkStyle: 'inlined',
        linkReferenceStyle: 'inlined',
        defaultReplacement: function (content) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = content;
            return tempDiv.textContent || tempDiv.innerText || '';
        }
    });

    turndownService.addRule('lazyImage', {
        filter: 'img',
        replacement: function (content, node) {
            const src = node.getAttribute('data-original') || node.getAttribute('data-actualsrc') || node.src;
            const alt = node.alt || '';
            if (src) {
                return `![${alt}](${src})`;
            }
            return '';
        }
    });
    // --- End Turndown Configuration ---

    // --- Variables for Selective Download ---
    const selectedAnswers = new Set(); // Set to store the tokens of selected answers
    // --- End Variables for Selective Download ---


    // --- Functions for General Use (or shared) ---

    /* === ZUD Panel, Styles & Log Hook === */
    function __zudInjectStyles() {
        if (document.getElementById('zud-style')) return;
        const css = `
#zudPanel{position:fixed; top:80px; right:20px; width:300px; background:rgba(22,24,30,.92); color:#E9EEF9;
  border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:10px; z-index:10010; box-shadow:0 6px 24px rgba(0,0,0,.25); backdrop-filter:blur(6px); font-size:13px; line-height:1.35;}
#zudPanel .zud-header{display:flex; align-items:center; justify-content:space-between; font-weight:600; margin-bottom:6px;}
#zudPanel .zud-actions{display:flex; gap:6px;}
#zudPanel .zud-toggle, #zudPanel .zud-clear{padding:4px 8px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.08); color:#E9EEF9; cursor:pointer;}
#zudPanel .zud-body{display:block;}
#zudPanel.collapsed .zud-body{display:none;}
#zud-btns{display:grid; grid-template-columns:1fr; gap:8px; margin-bottom:10px;}
.zud-btn{padding:8px 12px; border-radius:10px; border:1px solid rgba(255,255,255,.12); color:#fff; font-weight:600; cursor:pointer; box-shadow:0 3px 10px rgba(0,0,0,.2);}
.zud-primary{background:linear-gradient(180deg,#4A90E2,#265DAD);}
.zud-secondary{background:linear-gradient(180deg,#2AB67B,#2C8F6E);}
.zud-purple{background:linear-gradient(180deg,#A794FF,#7358DC);}
.zud-teal{background:linear-gradient(180deg,#20C997,#169E78);}
#zud-topn{border-top:1px solid rgba(255,255,255,.08); padding-top:8px; margin-top:6px;}
#zud-topn .row{margin:8px 0 10px;}
#zud-topn input[type=number]{width:88px; padding:6px 8px; border-radius:10px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); color:#E9EEF9; outline:none;}
#zud-topn input[type=range]{width:100%;}
#zud-topn .grid{display:grid; grid-template-columns:1fr 1fr; gap:8px;}
#zud-logwrap{border-top:1px solid rgba(255,255,255,.08); padding-top:8px; margin-top:8px;}
#zud-log{max-height:180px; overflow:auto; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08); border-radius:8px; padding:6px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; line-height:1.4;}
#zud-log .warn{color:#FFDD88;} #zud-log .error{color:#FF8585;}
        `;
        const style = document.createElement('style');
        style.id = 'zud-style'; style.textContent = css;
        document.head.appendChild(style);
    }
    function __zudEnsurePanel() {
        __zudInjectStyles();
        let panel = document.getElementById('zudPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'zudPanel';
            panel.innerHTML = `
              <div class="zud-header">
                <div>Markdown 导出</div>
                <div class="zud-actions">
                  <button class="zud-toggle" id="zudToggle">折叠</button>
                  <button class="zud-clear" id="zudClear">清空日志</button>
                </div>
              </div>
              <div class="zud-body">
                <div id="zud-btns"></div>
                <div id="zud-topn">
                  <div class="row"><label>下载前 N 条</label>
                    <input id="zudRange" type="range" min="1" max="200" value="50">
                    <div style="margin-top:6px">
                      <input id="zudInput" type="number" min="1" step="1" value="50">
                      <span id="zudHint" style="margin-left:8px;opacity:.8;"></span>
                    </div>
                  </div>
                  <div class="grid">
                    <button id="zudTopN" class="zud-btn zud-primary">下载前 N 条</button>
                    <button id="zudTopNC" class="zud-btn zud-purple">前 N 条（含评论）</button>
                    <button id="zudLoadN" class="zud-btn zud-secondary" style="grid-column:1/3;">加载至 N 条</button>
                  </div>
                </div>
                <div id="zud-logwrap">
                  <div id="zud-log"></div>
                </div>
              </div>
            `;
            document.body.appendChild(panel);
            const body = panel.querySelector('.zud-body');
            panel.querySelector('#zudToggle').addEventListener('click', ()=>{
                panel.classList.toggle('collapsed');
            });
            panel.querySelector('#zudClear').addEventListener('click', ()=>{
                const el = document.getElementById('zud-log'); if (el) el.innerHTML = '';
            });
            // slider sync
            const range = panel.querySelector('#zudRange');
            const input = panel.querySelector('#zudInput');
            const hint  = panel.querySelector('#zudHint');
            const headerText = document.querySelector('.List-headerText')?.innerText || '';
            const m = headerText.match(/([0-9][0-9,\\.]*\\s*(?:万|k|K)?)/);
            const total = m ? parseInt(__parseZhihuCount(m[1])) : 200;
            range.max = Math.max(50, Math.min(total, 2000));
            hint.textContent = `/ 估算最多 ${range.max}（总 ${total}）`;
            range.addEventListener('input', ()=>{ input.value = range.value; });
            input.addEventListener('input', ()=>{
                const v = Math.max(1, parseInt(input.value||'1', 10));
                input.value = String(v);
                range.value = String(Math.min(v, parseInt(range.max,10)));
            });
            // TopN actions
            const setBusy = (flag)=>{ panel.querySelectorAll('button, input').forEach(el=> el.disabled = flag); };
            panel.querySelector('#zudLoadN').addEventListener('click', async ()=>{
                const n = parseInt(input.value,10) || 50;
                setBusy(true); try { await loadAtLeastNAnswers(n); } finally { setBusy(false); }
            });
            panel.querySelector('#zudTopN').addEventListener('click', async ()=>{
                const n = parseInt(input.value,10) || 50;
                setBusy(true); try {
                    await loadAtLeastNAnswers(n);
                    const questionMd = getQuestionInfo();
                    const answersMd = await getTopNAnswersMarkdown(n);
                    const fullMd = questionMd + answersMd;
                    const title = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                    const filename = `${sanitizeFilename(title)}_${formatDownloadDateTime()}_top${n}.md`;
                    downloadMarkdownFile(filename, fullMd);
                } finally { setBusy(false); }
            });
            panel.querySelector('#zudTopNC').addEventListener('click', async ()=>{
                const n = parseInt(input.value,10) || 30;
                setBusy(true); try {
                    await loadAtLeastNAnswers(n);
                    const questionMd = getQuestionInfo();
                    const answersMd = await getTopNAnswersMarkdownWithComments(n);
                    const fullMd = questionMd + answersMd;
                    const title = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                    const filename = `${sanitizeFilename(title)}_${formatDownloadDateTime()}_top${n}_with_comments.md`;
                    downloadMarkdownFile(filename, fullMd);
                } finally { setBusy(false); }
            });
        }
        return panel;
    }
    (function __zudHookConsole(){
        if (window.__zudConsoleHooked__) return; window.__zudConsoleHooked__=true;
        const orig = {log: console.log, warn: console.warn, error: console.error};
        function push(type, args){
            const msg = Array.from(args).map(x => {
                try { return (typeof x === 'object') ? JSON.stringify(x) : String(x); } catch(_){ return String(x); }
            }).join(' ');
            const line = `[${new Date().toLocaleTimeString()}] ${type.toUpperCase()} ${msg}`;
            const el = document.getElementById('zud-log');
            if (el) {
                const div = document.createElement('div'); div.textContent = line; if (type!=='log') div.className = type;
                el.appendChild(div); el.scrollTop = el.scrollHeight;
            }
        }
        console.log = (...a)=>{ try{push('log',a);}catch(_){ } orig.log(...a); };
        console.warn = (...a)=>{ try{push('warn',a);}catch(_){ } orig.warn(...a); };
        console.error = (...a)=>{ try{push('error',a);}catch(_){ } orig.error(...a); };
    })();


    // Number parser extended for comments like "2.3 万", "2.3k", "1,234"
    function __parseZhihuCount(text) {
        const s = (text || '').toString().trim().replace(/\s+/g, '');
        const mWan = s.match(/([\d.]+)万/i);
        if (mWan) return String(Math.round(parseFloat(mWan[1]) * 10000));
        const mk = s.match(/([\d.]+)k/i);
        if (mk) return String(Math.round(parseFloat(mk[1]) * 1000));
        const m = s.match(/[\d,]+/);
        return m ? m[0].replace(/,/g, '') : '0';
    }
    function __getUpvoteCountFromAnswer(answerEl) {
        const voteBtn = answerEl.querySelector('button[aria-label*="赞同"], .VoteButton, .VoteButton--up');
        const raw = voteBtn?.getAttribute('aria-label') || voteBtn?.textContent || '';
        return __parseZhihuCount(raw);
    }
    function __getCommentCountFromAnswer(answerEl) {
        const cbtn = answerEl.querySelector('.ContentItem-action .Zi--Comment')?.closest('button');
        const raw = cbtn?.textContent || '';
        return __parseZhihuCount(raw);
    }
    function __getAnswerId(answerEl) {
        return answerEl.getAttribute('name') || answerEl.dataset.zop?.itemId || answerEl.id || '';
    }
    function __formatUnixTs(sec) {
        if (!sec) return '';
        try {
            const d = new Date(sec * 1000);
            const y = d.getFullYear();
            const M = String(d.getMonth()+1).padStart(2,'0');
            const D = String(d.getDate()).padStart(2,'0');
            const h = String(d.getHours()).padStart(2,'0');
            const m = String(d.getMinutes()).padStart(2,'0');
            return `${y}-${M}-${D} ${h}:${m}`;
        } catch (_) { return ''; }
    }
    function __mdEscape(s) {
        return (s||'').toString().replace(/[\*`_\[\]<>]/g, m => `\\${m}`);
    }
    function __peopleLink(author) {
        const name = author?.name || '匿名用户';
        const token = author?.url_token;
        const url = token ? `https://www.zhihu.com/people/${token}` : '';
        return url ? `[${__mdEscape(name)}](${url})` : `**${__mdEscape(name)}**`;
    }


    // Robust count parsers for Zhihu-style numbers (e.g., "赞同 8,127", "8.1 万", "8.1k")
    function __parseZhihuCount(text) {
        const s = (text || '').toString().trim().replace(/\s+/g, '');
        // "8.1 万"
        const mWan = s.match(/([\d.]+)万/i);
        if (mWan) return String(Math.round(parseFloat(mWan[1]) * 10000));
        // "8.1k" / "8.1K"
        const mk = s.match(/([\d.]+)k/i);
        if (mk) return String(Math.round(parseFloat(mk[1]) * 1000));
        // pure digits with/or commas
        const m = s.match(/[\d,]+/);
        return m ? m[0].replace(/,/g, '') : '0';
    }

    function __getUpvoteCountFromAnswer(answerEl) {
        // Prefer aria-label with "赞同"
        const voteBtn = answerEl.querySelector('button[aria-label*="赞同"], .VoteButton, .VoteButton--up');
        const raw = voteBtn?.getAttribute('aria-label') || voteBtn?.textContent || '';
        return __parseZhihuCount(raw);
    }


    // Yield control to the browser to keep UI responsive


// --- Comment Fetching ---
    async function __fetchAllRootComments(answerId, orderBy = 'score') {
        let next = `https://www.zhihu.com/api/v4/comment_v5/answers/${answerId}/root_comment?order_by=${orderBy}&limit=20&offset=0`;
        const all = [];
        while (next) {
            const res = await fetch(next, { credentials: 'include' });
            if (!res.ok) { console.warn("fetch root comments failed", answerId, res.status); break; }
            const j = await res.json();
            (j.data || []).forEach(x => all.push(x));
            const p = j.paging || {};
            if (p.is_end) break;
            next = p.next;
            await yieldToBrowser(0);
        }
        return all;
    }
    async function __fetchAllChildComments(rootId) {
        let next = `https://www.zhihu.com/api/v4/comment_v5/comment/${rootId}/child_comment?order_by=ts&limit=20&offset=0`;
        const all = [];
        while (next) {
            const res = await fetch(next, { credentials: 'include' });
            if (!res.ok) { console.warn("fetch child comments failed", rootId, res.status); break; }
            const j = await res.json();
            (j.data || []).forEach(x => all.push(x));
            const p = j.paging || {};
            if (p.is_end) break;
            next = p.next;
            await yieldToBrowser(0);
        }
        return all;
    }
    async function __fetchCommentsForAnswer(answerId) {
        const roots = await __fetchAllRootComments(answerId);
        for (const rc of roots) {
            if ((rc.child_comment_count || 0) > 0) {
                rc.child_comments_full = await __fetchAllChildComments(rc.id);
            } else {
                rc.child_comments_full = [];
            }
        }
        return roots;
    }
    function __buildChildTree(childList) {
        const byId = new Map();
        childList.forEach(c => { c.children = []; byId.set(String(c.id), c); });
        const roots = [];
        childList.forEach(c => {
            const pid = String(c.reply_comment_id || '');
            if (pid && byId.has(pid)) {
                byId.get(pid).children.push(c);
            } else {
                roots.push(c);
            }
        });
        return roots;
    }
    function __commentToMarkdown(c, depth = 0) {
        const indent = '  '.repeat(depth);
        const who = __peopleLink(c.author);
        const like = c.like_count ?? 0;
        const when = __formatUnixTs(c.created_time);
        const contentMd = turndownService.turndown(c.content || '');
        let out = `${indent}- ${who} · 👍 ${like} · 🕒 ${when}\n`;
        out += `${indent}  ${contentMd}\n`;
        if (c.children && c.children.length) {
            for (const ch of c.children) {
                out += __commentToMarkdown(ch, depth + 1);
            }
        }
        return out;
    }
    function __commentsBlockMarkdown(roots) {
        if (!roots || roots.length === 0) return '';
        let md = `#### 评论 (${roots.length})\n\n`;
        for (const rc of roots) {
            md += __commentToMarkdown(rc, 0);
            if (rc.child_comments_full && rc.child_comments_full.length) {
                const tree = __buildChildTree(rc.child_comments_full);
                for (const t of tree) md += __commentToMarkdown(t, 1);
            }
        }
        md += '\n';
        return md;
    }
async function yieldToBrowser(ms = 0) {
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            await new Promise(resolve => requestIdleCallback(() => resolve()));
        } else {
            await new Promise(resolve => setTimeout(resolve, ms));
        }
    }


    // Function to get current date and time in YYYY-MM-DD_HH-MM-SS format
    function formatDownloadDateTime() {
        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
        return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
    }

    // Function to sanitize filename, allowing Chinese characters but removing invalid ones
    function sanitizeFilename(title) {
        // Remove characters invalid in most file systems: \ / : * ? " < > |
        // Also remove control characters and potentially problematic leading/trailing spaces/dots
        let sanitized = title.replace(/[\\/:*?"<>|]/g, '_');
        sanitized = sanitized.replace(/^\s+|\s+$/g, ''); // Trim leading/trailing whitespace
        sanitized = sanitized.replace(/\.+$/g, ''); // Remove trailing dots
        return sanitized;
    }

    // Function to expand collapsed content
     async function expandCollapsedContent() {
        console.log("UserScript: Expanding collapsed content...");
        let expandedCount = 0;
        let buttons;

        // Expand question description
        const questionMoreButton = document.querySelector('.QuestionRichText-more');
        if (questionMoreButton) {
            // Check if the button is visible and the text indicates it's collapsed
            if (questionMoreButton.offsetParent !== null && questionMoreButton.innerText.includes('显示全部')) {
                questionMoreButton.click();
                expandedCount++;
                 await new Promise(resolve => setTimeout(resolve, 300)); // Wait for animation/render
            }
        }

        // Expand answer content
        buttons = document.querySelectorAll('.RichContent-collapsedText.Button--plain');
        console.log(`UserScript: Found ${buttons.length} collapsed answer buttons.`);
        for (const button of buttons) {
            // Check if the button is visible
            if (button.offsetParent !== null) {
                button.click();
                expandedCount++;
                // Add a small delay to avoid overwhelming the browser
                 await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
         console.log(`UserScript: Expanded ${expandedCount} collapsed sections.`);
         // Wait a bit more for all content to settle after expansion
         await new Promise(resolve => setTimeout(resolve, 1000));
    }


    // Function to create and download the file
    function downloadMarkdownFile(filename, content) {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Function to extract question information
    function getQuestionInfo() {
        const title = document.querySelector('.QuestionHeader-title')?.innerText || 'No Title';
        const url = window.location.href;
         // Select the description text element, not the container that might include the "show more" button
        const descriptionElement = document.querySelector('.QuestionRichText .RichText.ztext');
        const descriptionHtml = descriptionElement?.innerHTML || '';
        const descriptionMd = turndownService.turndown(descriptionHtml);

        const topics = Array.from(document.querySelectorAll('.QuestionHeader-topics .Tag-content a')).map(topic => topic.innerText);
         // Adjust selector for question author name if necessary based on provided HTML
         const questionAuthorElement = document.querySelector('.QuestionAuthor .AuthorInfo-name a');
        const author = questionAuthorElement?.innerText || 'Anonymous';
        // Question author URL might not be easily available or needed, skipped for now.

        const followerCount = document.querySelector('.QuestionFollowStatus .NumberBoard-item:nth-child(1) .NumberBoard-itemValue')?.getAttribute('title') || 'N/A';
        const viewCount = document.querySelector('.QuestionFollowStatus .NumberBoard-item:nth-child(2) .NumberBoard-itemValue')?.getAttribute('title') || 'N/A';
        const answerCount = document.querySelector('.List-headerText span')?.innerText.match(/\d+/)?.[0] || 'N/A';

        let md = `# ${title}\n\n`;
        md += `**URL:** ${url}\n\n`;
         if (author !== 'Anonymous') {
             md += `**提问者:** ${author}\n\n`;
         }
        if (topics.length > 0) {
            md += `**话题:** ${topics.join(', ')}\n\n`;
        }
        md += `**关注者:** ${followerCount} | **被浏览:** ${viewCount} | **回答数:** ${answerCount}\n\n`;

        if (descriptionMd.trim()) { // Check if description content is not just whitespace
             md += `## 问题描述\n\n`;
             md += descriptionMd + '\n\n';
        } else {
             md += `## 问题描述\n\n无\n\n`;
        }

        md += `--- \n\n`; // Separator

        return md;
    }
    // --- End Functions for General Use ---


    // --- Functions for Download ALL ---

    // Function to scroll to load all answers (Correctly included now)
    async function loadAllAnswers() {
        const headerSpan = document.querySelector('.List-headerText span');
        const headerText = headerSpan?.innerText || '';
        const totalAnswers = parseInt(__parseZhihuCount(headerText)) || 999999;

        let lastCount = 0;
        let stagnant = 0;
        const maxAttempts = 400;

        const listContainer = document.getElementById('QuestionAnswers-answers');

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const answers = document.querySelectorAll('.AnswerItem');
            const now = answers.length;
            if (now >= totalAnswers) {
                console.log(`UserScript: Reached total answers ${now}/${totalAnswers}.`);
                break;
            }

            // try to reveal more by scrolling window and container
            const last = answers[answers.length - 1];
            if (last && last.scrollIntoView) {
                last.scrollIntoView({ block: 'end' });
            }
            window.scrollBy(0, Math.max(200, Math.floor(window.innerHeight * 0.9)));
            if (listContainer) {
                try { listContainer.scrollTop = listContainer.scrollHeight; } catch(_) {}
            }

            // click possible "更多"/"继续浏览内容"按钮
            const moreBtns = [
                'button.ContentItem-more',
                '.QuestionAnswers-answerList .PaginationButton',
                'button:has(.Zi--ArrowDown)',
                'button:has(.Zi--ChevronDown)'
            ];
            for (const sel of moreBtns) {
                const btn = document.querySelector(sel);
                if (btn && btn.offsetParent !== null) { try { btn.click(); } catch(_) {} }
            }

            await new Promise(r => setTimeout(r, 800));

            const after = document.querySelectorAll('.AnswerItem').length;
            if (after === lastCount) {
                stagnant++;
            } else {
                stagnant = 0;
                lastCount = after;
            }
            if (stagnant >= 10) {
                console.log(`UserScript: No progress after ${stagnant} idle cycles, stopping at ${after}/${totalAnswers}.`);
                break;
            }
        }

        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 200));
    }


    // Function to extract and format ALL answers
    async function getAllAnswersMarkdown(batchSize = 10) {
    const answerElements = Array.from(document.querySelectorAll('.AnswerItem'));
    const chunks = [];
    let index = 0;

    for (let i = 0; i < answerElements.length; i += batchSize) {
        const batch = answerElements.slice(i, i + batchSize);
        for (const answerEl of batch) {
            index++;
            const authorEl = answerEl.querySelector('.AuthorInfo-name a');
            const authorName = authorEl?.innerText || '匿名用户';
            const authorUrl = authorEl?.href || '#';

            const upvoteCount = __getUpvoteCountFromAnswer(answerEl);

            const commentCount = __getCommentCountFromAnswer(answerEl);

            const timeElement = answerEl.querySelector('time');
            const time = timeElement ? (timeElement.getAttribute('data-tooltip') || timeElement.innerText || '').replace('发布于 ', '').replace('编辑于 ', '编辑于 ') : '未知时间';

            const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
            const contentMd = turndownService.turndown(contentHtml);

            chunks.push(`### ${index}. ${authorName}\n\n`);
            if (authorUrl && authorUrl !== '#') {
                chunks.push(`[${authorName}](${authorUrl})\n\n`);
            }
            chunks.push(`**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`);
            chunks.push(contentMd + '\n\n');
            chunks.push(`--- \n\n`);
        }
        // yield to the browser after each batch
        await yieldToBrowser(0);
    }

    let fullMd = `## 全部回答 (${index})\n\n`;
    fullMd += chunks.join('');
    return fullMd;
}

    // Function to add the Download All button
    function addDownloadAllButton() {
        console.log("UserScript: addDownloadAllButton function started.");

        const button = document.createElement('button');
        button.id = 'downloadAllAnswersButton'; // Add an ID
        button.innerText = '下载全部回答 (Markdown)';
        /* style moved to class */ button.className = 'zud-btn zud-primary'; // = `

        button.addEventListener('click', async () => {
            button.innerText = '正在加载回答...';
            button.disabled = true;
            console.log("UserScript: Starting download all...");

            try {
                console.log("UserScript: Loading all answers...");
                await loadAllAnswers();
                 console.log("UserScript: All answers loaded.");

                button.innerText = '正在展开内容...';
                console.log("UserScript: Expanding collapsed content...");
                 await expandCollapsedContent();
                 console.log("UserScript: Collapsed content expanded.");

                button.innerText = '正在生成 Markdown...';
                 console.log("UserScript: Generating Markdown for all answers...");

                const questionMd = getQuestionInfo();
                const answersMd = await getAllAnswersMarkdown();
                const fullMarkdown = questionMd + answersMd;

                const questionTitle = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                 // Generate filename: SanitizedTitle_YYYY-MM-DD_HH-MM-SS.md
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_all.md`;

                downloadMarkdownFile(filename, fullMarkdown);

                button.innerText = '下载完成!';
                 console.log("UserScript: Download all complete!");

            } catch (error) {
                 console.error("UserScript: An error occurred during download all:", error); // Log errors
                 button.innerText = '下载失败!';
            } finally {
                 button.disabled = false;
                 setTimeout(() => {
                     button.innerText = '下载全部回答 (Markdown)'; // Reset button text
                 }, 3000);
            }
        });

        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
        console.log("UserScript: Download all button added.");
    }

    // Add "Download All (with comments)" button
    function addDownloadAllWithCommentsButton() {
        const button = document.createElement('button');
        button.id = 'downloadAllWithCommentsButton';
        button.innerText = '下载全部回答（含评论）';
        /* style moved to class */ button.className = 'zud-btn zud-purple'; // = `
        button.addEventListener('click', async () => {
            button.disabled = true;
            button.innerText = '正在加载回答...';
            try {
                await loadAllAnswers();
                button.innerText = '正在展开内容...';
                await expandCollapsedContent();
                button.innerText = '正在抓取评论...';
                const questionMd = getQuestionInfo();
                const answersMd = await getAllAnswersMarkdownWithComments();
                const fullMd = questionMd + answersMd;
                const questionTitle = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_all_with_comments.md`;
                downloadMarkdownFile(filename, fullMd);
                button.innerText = '下载完成!';
            } catch (e) {
                console.error(e);
                button.innerText = '下载失败!';
            } finally {
                setTimeout(()=>{ button.innerText = '下载全部回答（含评论）'; button.disabled=false; }, 3000);
            }
        });
        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
    }

    // Add "Download Selected (with comments)" button
    function addDownloadSelectedWithCommentsButton() {
        const button = document.createElement('button');
        button.id = 'downloadSelectedWithCommentsButton';
        button.innerText = '下载已选回答（含评论）';
        button.disabled = selectedAnswers.size === 0;
        /* style moved to class */ button.className = 'zud-btn zud-teal'; // = `
        button.addEventListener('click', async () => {
            if (selectedAnswers.size === 0) { alert('请先选择至少一个回答'); return; }
            button.disabled = true;
            button.innerText = '正在展开内容...';
            try {
                await expandCollapsedContent();
                button.innerText = '正在抓取评论...';
                const questionMd = getQuestionInfo();
                const answersMd = await getSelectedAnswersMarkdownWithComments();
                const fullMd = questionMd + answersMd;
                const questionTitle = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_selected_with_comments.md`;
                downloadMarkdownFile(filename, fullMd);
                button.innerText = '下载完成!';
            } catch (e) {
                console.error(e);
                button.innerText = '下载失败!';
            } finally {
                setTimeout(()=>{ button.innerText = '下载已选回答（含评论）'; button.disabled=false; }, 3000);
            }
        });
        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
    }

    // --- End Functions for Download ALL ---


    // --- Functions for Selective Download ---

    // Function to update the count on the main download button
    function updateDownloadButtonCount() {
        const btn1 = document.getElementById('downloadSelectedAnswersButton');
        if (btn1) {
            btn1.innerText = `下载已选回答 (${selectedAnswers.size})`;
            btn1.disabled = selectedAnswers.size === 0;
        }
        const btn2 = document.getElementById('downloadSelectedWithCommentsButton');
        if (btn2) {
            btn2.innerText = '下载已选回答（含评论）';
            btn2.disabled = selectedAnswers.size === 0;
        }
    }

    // Function to add the select button to an individual answer
    function addSelectButton(answerElement, __retry=0) {
        // Avoid adding button multiple times or to elements that aren't full answers
        // mark to avoid duplicates
        if (answerElement.dataset.__hasSelectButton === '1') return;

        if (answerElement.querySelector('.select-answer-button') || !answerElement.classList.contains('AnswerItem')) {
            return;
        }

        const answerToken = answerElement.getAttribute('name') || answerElement.dataset.zop?.itemId || answerElement.id;

        if (!answerToken) {
             console.warn("UserScript: Could not find token for answer, skipping select button:", answerElement);
             return;
        }

        const metaDiv = answerElement.querySelector('.ContentItem-meta');

        if (metaDiv) {
             if (metaDiv.querySelector('.select-answer-button')) {
                  return;
             }

            const selectButton = document.createElement('button');
            selectButton.classList.add('select-answer-button');
            selectButton.innerText = '[选择]';
            selectButton.style.cssText = `
                position: absolute; /* 使用绝对定位 */
                top: 5px; /* 距离顶部的距离 */
                right: 5px; /* 距离右侧的距离 */
                z-index: 50; /* 确保在大部分内容之上 */
                padding: 2px 5px;
                background-color: #f0f0f0;
                color: #333;
                border: 1px solid #ccc;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
                vertical-align: middle;
            `;
             // Ensure the answer item is positioned relatively for absolute children
             // Check if it already has position: relative or absolute
             const answerItemStyle = window.getComputedStyle(answerElement).position;
             if (answerItemStyle !== 'relative' && answerItemStyle !== 'absolute') {
                 answerElement.style.position = 'relative';
             }


            if (selectedAnswers.has(answerToken)) {
                 selectButton.innerText = '[取消选择]';
                 selectButton.style.backgroundColor = '#e0f7e0';
            }


            selectButton.addEventListener('click', () => {
                if (selectedAnswers.has(answerToken)) {
                    selectedAnswers.delete(answerToken);
                    selectButton.innerText = '[选择]';
                    selectButton.style.backgroundColor = '#f0f0f0';
                    console.log(`UserScript: Deselected answer: ${answerToken}`);
                } else {
                    selectedAnswers.add(answerToken);
                    selectButton.innerText = '[取消选择]';
                    selectButton.style.backgroundColor = '#e0f7e0';
                    console.log(`UserScript: Selected answer: ${answerToken}`);
                }
                updateDownloadButtonCount();
            });

             // Append the button directly to the answer item element
             answerElement.appendChild(selectButton);
             answerElement.dataset.__hasSelectButton = '1'; console.log("UserScript: Select button added to AnswerItem.");


        } else {
            if (__retry < 5) { setTimeout(() => addSelectButton(answerElement, __retry+1), 200); } else { console.warn("UserScript: meta not ready after retries", answerElement); }
        }
    }

    // Function to add select buttons to all existing answers
    function addSelectButtonsToAllAnswers() {
        console.log("UserScript: Adding select buttons to initial answers...");
        const answerElements = document.querySelectorAll('.AnswerItem');
        answerElements.forEach(addSelectButton);
        console.log(`UserScript: Added select buttons to ${answerElements.length} initial answers.`);
         updateDownloadButtonCount(); // Initial update after adding buttons
    }

    // Function to extract and format ONLY selected answers
    async function getSelectedAnswersMarkdown(batchSize = 10) {
    const answerElements = Array.from(document.querySelectorAll('.AnswerItem'));
    const chunks = [];
    let selectedIndex = 0;
    const exportedAnswerTokens = new Set();

    for (let i = 0; i < answerElements.length; i += batchSize) {
        const batch = answerElements.slice(i, i + batchSize);
        for (const answerEl of batch) {
            const answerToken = answerEl.getAttribute('name') || answerEl.dataset.zop?.itemId || answerEl.id;
            if (answerToken && selectedAnswers.has(answerToken)) {
                selectedIndex++;
                exportedAnswerTokens.add(answerToken);

                const authorEl = answerEl.querySelector('.AuthorInfo-name a');
                const authorName = authorEl?.innerText || '匿名用户';
                const authorUrl = authorEl?.href || '#';

                const upvoteCount = __getUpvoteCountFromAnswer(answerEl);

                const commentCount = __getCommentCountFromAnswer(answerEl);

                const timeElement = answerEl.querySelector('time');
                const time = timeElement ? (timeElement.getAttribute('data-tooltip') || timeElement.innerText || '').replace('发布于 ', '').replace('编辑于 ', '编辑于 ') : '未知时间';

                const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
                const contentMd = turndownService.turndown(contentHtml);

                chunks.push(`### ${selectedIndex}. ${authorName}\n\n`);
                if (authorUrl && authorUrl !== '#') {
                    chunks.push(`[${authorName}](${authorUrl})\n\n`);
                }
                chunks.push(`**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`);
                chunks.push(contentMd + '\n\n');
                chunks.push(`--- \n\n`);
            }
        }
        await yieldToBrowser(0);
    }

    let fullMd = `## 已选回答 (${selectedIndex}/${selectedAnswers.size})\n\n`;
    fullMd += chunks.join('');

    if (exportedAnswerTokens.size !== selectedAnswers.size) {
        console.warn(`UserScript: Expected to export ${selectedAnswers.size} answers, but found only ${exportedAnswerTokens.size} in the DOM.`);
    }

    return fullMd;


    // Builders including comments



}

    // Function to add the main download selected button
    function addMainDownloadButton() {
         console.log("UserScript: addMainDownloadButton function started.");

        const button = document.createElement('button');
        button.id = 'downloadSelectedAnswersButton';
        button.innerText = '下载已选回答 (0)';
        button.disabled = true;
        /* style moved to class */ button.className = 'zud-btn zud-secondary'; // = `

        button.addEventListener('click', async () => {
             if (selectedAnswers.size === 0) {
                 alert("请先选择至少一个回答！");
                 return;
             }

            button.innerText = '正在展开内容...';
            button.disabled = true;
            console.log("UserScript: Starting selected answers download...");

            try {
                console.log("UserScript: Expanding collapsed content...");
                 await expandCollapsedContent();
                 console.log("UserScript: Collapsed content expanded.");

                button.innerText = `正在生成 Markdown (${selectedAnswers.size}个回答)...`;
                 console.log("UserScript: Generating Markdown for selected answers...");

                const questionMd = getQuestionInfo();
                const answersMd = await getSelectedAnswersMarkdown();
                const fullMarkdown = questionMd + answersMd;

                const questionTitle = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                 // Generate filename: SanitizedTitle_YYYY-MM-DD_HH-MM-SS_selected.md
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_selected.md`;


                downloadMarkdownFile(filename, fullMarkdown);

                button.innerText = '下载完成!';
                 console.log("UserScript: Download complete!");

            } catch (error) {
                 console.error("UserScript: An error occurred during selected download:", error);
                 button.innerText = '下载失败!';
            } finally {
                 updateDownloadButtonCount();
                 setTimeout(() => {
                     updateDownloadButtonCount();
                 }, 3000);
            }
        });

        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
        console.log("UserScript: Download selected button added.");

        updateDownloadButtonCount();
    }
    // --- End Functions for Selective Download ---


    // === Builders including comments (top-level) ===
async function getAllAnswersMarkdownWithComments(batchSize = 8) {
    const answerElements = Array.from(document.querySelectorAll('.AnswerItem'));
    const chunks = [];
    let index = 0;
    for (let i = 0; i < answerElements.length; i += batchSize) {
        const batch = answerElements.slice(i, i + batchSize);
        for (const answerEl of batch) {
            index++;
            const authorEl = answerEl.querySelector('.AuthorInfo-name a');
            const authorName = authorEl?.innerText || '匿名用户';
            const authorUrl = authorEl?.href || '#';
            const upvoteCount = __getUpvoteCountFromAnswer(answerEl);
            const commentCount = __getCommentCountFromAnswer(answerEl);
            const timeElement = answerEl.querySelector('time');
            const time = timeElement ? (timeElement.getAttribute('data-tooltip') || timeElement.innerText || '').replace('发布于 ', '').replace('编辑于 ', '编辑于 ') : '未知时间';
            const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
            const contentMd = turndownService.turndown(contentHtml);

            chunks.push(`### ${index}. ${authorName}\n\n`);
            if (authorUrl && authorUrl !== '#') chunks.push(`[${authorName}](${authorUrl})\n\n`);
            chunks.push(`**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`);
            chunks.push(contentMd + '\n\n');

            const answerId = __getAnswerId(answerEl);
            if (answerId) {
                const comments = await __fetchCommentsForAnswer(answerId);
                chunks.push(__commentsBlockMarkdown(comments));
            } else {
                chunks.push('_（未能识别回答 ID，评论跳过）_\n\n');
            }
            chunks.push(`--- \n\n`);
        }
        await yieldToBrowser(0);
    }
    let fullMd = `## 全部回答 (${index})\n\n`;
    fullMd += chunks.join('');
    return fullMd;
}

async function getSelectedAnswersMarkdownWithComments(batchSize = 8) {
    const answerElements = Array.from(document.querySelectorAll('.AnswerItem'));
    const chunks = [];
    let selectedIndex = 0;
    for (let i = 0; i < answerElements.length; i += batchSize) {
        const batch = answerElements.slice(i, i + batchSize);
        for (const answerEl of batch) {
            const token = __getAnswerId(answerEl);
            if (!token || !selectedAnswers.has(token)) continue;
            selectedIndex++;
            const authorEl = answerEl.querySelector('.AuthorInfo-name a');
            const authorName = authorEl?.innerText || '匿名用户';
            const authorUrl = authorEl?.href || '#';
            const upvoteCount = __getUpvoteCountFromAnswer(answerEl);
            const commentCount = __getCommentCountFromAnswer(answerEl);
            const timeElement = answerEl.querySelector('time');
            const time = timeElement ? (timeElement.getAttribute('data-tooltip') || timeElement.innerText || '').replace('发布于 ', '').replace('编辑于 ', '编辑于 ') : '未知时间';
            const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
            const contentMd = turndownService.turndown(contentHtml);

            chunks.push(`### ${selectedIndex}. ${authorName}\n\n`);
            if (authorUrl && authorUrl !== '#') chunks.push(`[${authorName}](${authorUrl})\n\n`);
            chunks.push(`**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`);
            chunks.push(contentMd + '\n\n');

            const comments = await __fetchCommentsForAnswer(token);
            chunks.push(__commentsBlockMarkdown(comments));
            chunks.push(`--- \n\n`);
        }
        await yieldToBrowser(0);
    }
    let fullMd = `## 已选回答 (${selectedIndex}/${selectedAnswers.size})\n\n`;
    fullMd += chunks.join('');
    return fullMd;
}

// --- MutationObserver Setup ---
     // Also observe the whole document in case answers mount outside the list container
     const observer2 = new MutationObserver((mutations) => {
        const newlyAdded = new Set();
        for (const m of mutations) {
            if (!m.addedNodes) continue;
            for (const node of m.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.classList && node.classList.contains('AnswerItem')) newlyAdded.add(node);
                else if (node.querySelectorAll) node.querySelectorAll('.AnswerItem').forEach(el => newlyAdded.add(el));
            }
        }
        if (newlyAdded.size > 0) {
            setTimeout(() => newlyAdded.forEach(el => addSelectButton(el)), 50);
        }
     });

     const observer = new MutationObserver(
    // Debounced batch processing of added answers
    (mutations => {
        const newlyAdded = new Set();
        for (const mutation of mutations) {
            if (!mutation.addedNodes) continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.classList && node.classList.contains('AnswerItem')) {
                    newlyAdded.add(node);
                } else if (node.querySelectorAll) {
                    node.querySelectorAll('.AnswerItem').forEach(el => newlyAdded.add(el));
                }
            }
        }
        if (window.__zh_dl_debounceTimer) clearTimeout(window.__zh_dl_debounceTimer);
        window.__zh_dl_debounceTimer = setTimeout(() => {
            newlyAdded.forEach(addSelectButton);
            updateDownloadButtonCount();
        }, 100);
    })
);
    // --- End MutationObserver Setup ---


    // --- Script Initialization ---
    console.log("UserScript: Zhihu Download Script started.");
    __zudEnsurePanel();

    addDownloadAllWithCommentsButton();
    addDownloadSelectedWithCommentsButton();

    // Add BOTH main buttons
    addDownloadAllButton(); // Download All
    addMainDownloadButton(); // Download Selected (positioned lower)


    // Add select buttons to answers already present on the page
    addSelectButtonsToAllAnswers();

    // Start observing the answer list for new answers
    const answerListContainer = document.getElementById('QuestionAnswers-answers');

    observer2.observe(document.body, { childList: true, subtree: true });
    console.log("UserScript: Also observing body for dynamically loaded AnswerItem.");
if (answerListContainer) {
        observer.observe(answerListContainer, { childList: true, subtree: true });
        console.log("UserScript: Started observing answer list for new answers and adding select buttons.");
    } else {
        console.warn("UserScript: Could not find answer list container (#QuestionAnswers-answers), dynamic loading of select buttons might not work.");
    }


})();