// ==UserScript==
// @name         知乎问题回答批量/选择性导出为 Markdown
// @namespace    http://tampermonkey.net/
// @version      0.8.0
// @description  在知乎问题页提供下载全部回答或选择部分回答导出为 Markdown 的功能
// @author       Qi Deng
// @match        https://www.zhihu.com/question/*
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/lib/turndown.umd.js
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/forum/zhihu.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/forum/zhihu.user.js
// @grant        none
// ==/UserScript==

(function () {
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

    // --- Variables for Selective Download ---
    const selectedAnswers = new Set();

    // --- Panel with Tokyo Night Light Theme ---
    function __zudInjectStyles() {
        if (document.getElementById('zud-style')) return;
        const css = `
#zudPanel{position:fixed; top:80px; right:20px; width:320px; background:#FAFBFC; color:#343b58;
  border:1px solid #d8dee9; border-radius:16px; padding:12px; z-index:10010;
  box-shadow:0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04); font-size:13px; line-height:1.4;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);}
#zudPanel.collapsed{width:48px; height:48px; padding:0; overflow:hidden; cursor:pointer;}
#zudPanel .zud-icon{display:none; width:48px; height:48px; align-items:center; justify-content:center; font-size:20px;}
#zudPanel.collapsed .zud-icon{display:flex;}
#zudPanel.collapsed .zud-header, #zudPanel.collapsed .zud-body{display:none;}
#zudPanel .zud-header{display:flex; align-items:center; justify-content:space-between; font-weight:600;
  margin-bottom:10px; color:#0969da;}
#zudPanel .zud-actions{display:flex; gap:6px;}
#zudPanel .zud-toggle, #zudPanel .zud-clear{padding:5px 10px; border-radius:8px; border:1px solid #d0d7de;
  background:#ffffff; color:#565a76; cursor:pointer; font-size:12px; transition:all 0.2s;}
#zudPanel .zud-toggle:hover, #zudPanel .zud-clear:hover{background:#f3f4f6; border-color:#8c96a8;}
#zudPanel .zud-body{display:block;}
#zud-btns{display:grid; grid-template-columns:1fr; gap:8px; margin-bottom:12px;}
.zud-btn{padding:9px 14px; border-radius:10px; border:1px solid; color:#fff; font-weight:500;
  cursor:pointer; transition:all 0.2s; font-size:13px;}
.zud-btn:disabled{opacity:0.5; cursor:not-allowed;}
.zud-btn:hover:not(:disabled){transform:translateY(-1px); box-shadow:0 4px 12px rgba(0,0,0,0.15);}
.zud-primary{background:linear-gradient(135deg,#6B9BD1,#5B8DC4); border-color:#5B8DC4;}
.zud-secondary{background:linear-gradient(135deg,#70C0B8,#5AAA9F); border-color:#5AAA9F;}
.zud-purple{background:linear-gradient(135deg,#9A8FD8,#8578CC); border-color:#8578CC;}
.zud-teal{background:linear-gradient(135deg,#4DBDB6,#3BA39C); border-color:#3BA39C;}
#zud-topn{border-top:1px solid #e5e9f0; padding-top:10px; margin-top:10px;}
#zud-topn .row{margin:10px 0;}
#zud-topn label{color:#565a76; font-weight:500; display:block; margin-bottom:6px;}
#zud-topn input[type=number]{width:100px; padding:6px 10px; border-radius:8px; border:1px solid #d0d7de;
  background:#ffffff; color:#343b58; outline:none; font-size:13px;}
#zud-topn input[type=number]:focus{border-color:#6B9BD1; box-shadow:0 0 0 3px rgba(107,155,209,0.1);}
#zud-topn input[type=range]{width:100%; margin:8px 0;}
#zud-topn .grid{display:grid; grid-template-columns:1fr 1fr; gap:8px;}
#zud-topn .grid .zud-btn:last-child{grid-column:1/3;}
#zud-topn #zudHint{color:#8b92a8; font-size:12px; margin-left:8px;}
#zud-logwrap{border-top:1px solid #e5e9f0; padding-top:10px; margin-top:10px;}
#zud-logwrap .log-title{color:#565a76; font-weight:500; margin-bottom:6px; font-size:12px;}
#zud-log{max-height:120px; overflow:auto; background:#f6f8fa; border:1px solid #d0d7de;
  border-radius:8px; padding:8px; font-family:'SF Mono',Monaco,Consolas,monospace; font-size:11px; line-height:1.4;}
#zud-log::-webkit-scrollbar{width:6px;}
#zud-log::-webkit-scrollbar-track{background:#e5e9f0; border-radius:3px;}
#zud-log::-webkit-scrollbar-thumb{background:#8b92a8; border-radius:3px;}
#zud-log .warn{color:#9D6500;}
#zud-log .error{color:#CF222E;}
.select-answer-button{position:absolute; top:8px; right:8px; z-index:50; padding:4px 10px;
  background:#ffffff; color:#565a76; border:1px solid #d0d7de; border-radius:6px; cursor:pointer;
  font-size:12px; transition:all 0.2s;}
.select-answer-button:hover{background:#f3f4f6; border-color:#6B9BD1;}
.select-answer-button.selected{background:#dff7ff; color:#0969da; border-color:#54aeff;}
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
              <div class="zud-icon">📥</div>
              <div class="zud-header">
                <div>Markdown 导出工具</div>
                <div class="zud-actions">
                  <button class="zud-toggle" id="zudToggle">折叠</button>
                  <button class="zud-clear" id="zudClear">清空</button>
                </div>
              </div>
              <div class="zud-body">
                <div id="zud-btns"></div>
                <div id="zud-topn">
                  <div class="row">
                    <label>下载前 N 条回答</label>
                    <input id="zudRange" type="range" min="1" max="200" value="50">
                    <div style="margin-top:8px">
                      <input id="zudInput" type="number" min="1" step="1" value="50">
                      <span id="zudHint"></span>
                    </div>
                  </div>
                  <div class="grid">
                    <button id="zudTopN" class="zud-btn zud-primary">下载前 N 条</button>
                    <button id="zudTopNC" class="zud-btn zud-purple">前 N 条（含评论）</button>
                    <button id="zudLoadN" class="zud-btn zud-secondary">加载至 N 条</button>
                  </div>
                </div>
                <div id="zud-logwrap">
                  <div class="log-title">运行日志</div>
                  <div id="zud-log"></div>
                </div>
              </div>
            `;
            document.body.appendChild(panel);

            // Toggle between icon and full panel
            panel.addEventListener('click', (e) => {
                if (panel.classList.contains('collapsed') && !e.target.closest('button')) {
                    panel.classList.remove('collapsed');
                }
            });

            panel.querySelector('#zudToggle').addEventListener('click', (e) => {
                e.stopPropagation();
                panel.classList.add('collapsed');
            });

            panel.querySelector('#zudClear').addEventListener('click', () => {
                const el = document.getElementById('zud-log');
                if (el) el.innerHTML = '';
            });

            // Get actual answer count and set slider max
            const headerText = document.querySelector('.List-headerText')?.innerText || '';
            const m = headerText.match(/(\d+)\s*个回答/);
            const total = m ? parseInt(m[1]) : 200;

            const range = panel.querySelector('#zudRange');
            const input = panel.querySelector('#zudInput');
            const hint = panel.querySelector('#zudHint');

            range.max = Math.min(total, 500); // Cap at 500 for performance
            hint.textContent = `共 ${total} 条回答`;

            range.addEventListener('input', () => { input.value = range.value; });
            input.addEventListener('input', () => {
                const v = Math.max(1, parseInt(input.value || '1', 10));
                input.value = String(v);
                range.value = String(Math.min(v, parseInt(range.max, 10)));
            });

            // Button actions
            const setBusy = (flag) => {
                panel.querySelectorAll('button, input').forEach(el => el.disabled = flag);
            };

            panel.querySelector('#zudLoadN').addEventListener('click', async () => {
                const n = parseInt(input.value, 10) || 50;
                setBusy(true);
                try {
                    await loadAtLeastNAnswers(n);
                } finally {
                    setBusy(false);
                }
            });

            panel.querySelector('#zudTopN').addEventListener('click', async () => {
                const n = parseInt(input.value, 10) || 50;
                setBusy(true);
                try {
                    await loadAtLeastNAnswers(n);
                    const questionMd = getQuestionInfo();
                    const answersMd = await getTopNAnswersMarkdown(n);
                    const fullMd = questionMd + answersMd;
                    const title = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                    const filename = `${sanitizeFilename(title)}_${formatDownloadDateTime()}_top${n}.md`;
                    downloadMarkdownFile(filename, fullMd);
                } finally {
                    setBusy(false);
                }
            });

            panel.querySelector('#zudTopNC').addEventListener('click', async () => {
                const n = parseInt(input.value, 10) || 30;
                setBusy(true);
                try {
                    await loadAtLeastNAnswers(n);
                    const questionMd = getQuestionInfo();
                    const answersMd = await getTopNAnswersMarkdownWithComments(n);
                    const fullMd = questionMd + answersMd;
                    const title = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                    const filename = `${sanitizeFilename(title)}_${formatDownloadDateTime()}_top${n}_with_comments.md`;
                    downloadMarkdownFile(filename, fullMd);
                } finally {
                    setBusy(false);
                }
            });
        }
        return panel;
    }

    // Console hook
    (function __zudHookConsole() {
        if (window.__zudConsoleHooked__) return;
        window.__zudConsoleHooked__ = true;
        const orig = { log: console.log, warn: console.warn, error: console.error };
        function push(type, args) {
            const msg = Array.from(args).map(x => {
                try {
                    return (typeof x === 'object') ? JSON.stringify(x) : String(x);
                } catch (_) {
                    return String(x);
                }
            }).join(' ');
            const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
            const el = document.getElementById('zud-log');
            if (el) {
                const div = document.createElement('div');
                div.textContent = line;
                if (type !== 'log') div.className = type;
                el.appendChild(div);
                el.scrollTop = el.scrollHeight;
            }
        }
        console.log = (...a) => { try { push('log', a); } catch (_) { } orig.log(...a); };
        console.warn = (...a) => { try { push('warn', a); } catch (_) { } orig.warn(...a); };
        console.error = (...a) => { try { push('error', a); } catch (_) { } orig.error(...a); };
    })();

    // Helper functions
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
            const M = String(d.getMonth() + 1).padStart(2, '0');
            const D = String(d.getDate()).padStart(2, '0');
            const h = String(d.getHours()).padStart(2, '0');
            const m = String(d.getMinutes()).padStart(2, '0');
            return `${y}-${M}-${D} ${h}:${m}`;
        } catch (_) { return ''; }
    }

    function __mdEscape(s) {
        return (s || '').toString().replace(/[\*`_\[\]<>]/g, m => `\\${m}`);
    }

    function __peopleLink(author) {
        const name = author?.name || '匿名用户';
        const token = author?.url_token;
        const url = token ? `https://www.zhihu.com/people/${token}` : '';
        return url ? `[${__mdEscape(name)}](${url})` : `**${__mdEscape(name)}**`;
    }

    async function yieldToBrowser(ms = 0) {
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            await new Promise(resolve => requestIdleCallback(() => resolve()));
        } else {
            await new Promise(resolve => setTimeout(resolve, ms));
        }
    }

    async function processAnswersWithComments(answers, concurrency = 2) {
        const results = [];
        for (let i = 0; i < answers.length; i += concurrency) {
            const batch = answers.slice(i, i + concurrency);
            const batchResults = await Promise.all(
                batch.map(answer => __fetchCommentsViaDOM(answer))
            );
            results.push(...batchResults);
            closeCommentModal(); // 每批次后关闭可能的弹窗
            await new Promise(r => setTimeout(r, 500));
        }
        return results;
    }

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

    function sanitizeFilename(title) {
        let sanitized = title.replace(/[\\/:*?"<>|]/g, '_');
        sanitized = sanitized.replace(/^\s+|\s+$/g, '');
        sanitized = sanitized.replace(/\.+$/g, '');
        return sanitized;
    }

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

    function getQuestionInfo() {
        const title = document.querySelector('.QuestionHeader-title')?.innerText || 'No Title';
        const url = window.location.href;
        const descriptionElement = document.querySelector('.QuestionRichText .RichText.ztext');
        const descriptionHtml = descriptionElement?.innerHTML || '';
        const descriptionMd = turndownService.turndown(descriptionHtml);
        const topics = Array.from(document.querySelectorAll('.QuestionHeader-topics .Tag-content a')).map(topic => topic.innerText);
        const questionAuthorElement = document.querySelector('.QuestionAuthor .AuthorInfo-name a');
        const author = questionAuthorElement?.innerText || 'Anonymous';
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
        if (descriptionMd.trim()) {
            md += `## 问题描述\n\n`;
            md += descriptionMd + '\n\n';
        } else {
            md += `## 问题描述\n\n无\n\n`;
        }
        md += `--- \n\n`;
        return md;
    }

    // Load at least N answers
    async function loadAtLeastNAnswers(targetCount) {
        console.log(`Loading at least ${targetCount} answers...`);
        let lastCount = 0;
        let stagnant = 0;
        const maxAttempts = 200;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const answers = document.querySelectorAll('.AnswerItem');
            const currentCount = answers.length;

            console.log(`Current: ${currentCount}/${targetCount}`);

            if (currentCount >= targetCount) {
                console.log(`Reached target: ${currentCount}/${targetCount}`);
                break;
            }

            // Scroll to bottom to trigger lazy loading
            window.scrollTo(0, document.body.scrollHeight);

            // Wait for new content to load
            await new Promise(r => setTimeout(r, 2000));

            const newCount = document.querySelectorAll('.AnswerItem').length;
            if (newCount === lastCount) {
                stagnant++;
                if (stagnant >= 10) {
                    console.log(`No progress for ${stagnant} cycles, stopping at ${newCount}`);
                    break;
                }
            } else {
                console.log(`Progress: ${lastCount} -> ${newCount}`);
                stagnant = 0;
                lastCount = newCount;
            }
        }

        // Scroll back to top
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 500));
    }

    // Get top N answers
    async function getTopNAnswersMarkdown(n) {
        const answerElements = Array.from(document.querySelectorAll('.AnswerItem')).slice(0, n);
        let md = `## 前 ${n} 条回答\n\n`;

        for (let i = 0; i < answerElements.length; i++) {
            const answerEl = answerElements[i];
            const authorEl = answerEl.querySelector('.AuthorInfo-name a');
            const authorName = authorEl?.innerText || '匿名用户';
            const authorUrl = authorEl?.href || '#';
            const upvoteCount = __getUpvoteCountFromAnswer(answerEl);
            const commentCount = __getCommentCountFromAnswer(answerEl);
            const timeElement = answerEl.querySelector('time');
            let time = '未知时间';
            if (timeElement) {
                const publishTime = timeElement.getAttribute('data-tooltip')?.replace('发布于 ', '') || '';
                const editText = timeElement.innerText || '';
                if (editText.includes('编辑于')) {
                    time = `发布: ${publishTime} | ${editText}`;
                } else {
                    time = publishTime || editText || '未知时间';
                }
            }
            const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
            const contentMd = turndownService.turndown(contentHtml);

            md += `### ${i + 1}. ${authorName}\n\n`;
            if (authorUrl && authorUrl !== '#') {
                md += `[${authorName}](${authorUrl})\n\n`;
            }
            md += `**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`;
            md += contentMd + '\n\n';
            md += `--- \n\n`;

            await yieldToBrowser(0);
        }

        return md;
    }

    // Get top N answers with comments
    async function getTopNAnswersMarkdownWithComments(n) {
        const answerElements = Array.from(document.querySelectorAll('.AnswerItem')).slice(0, n);
        let md = `## 前 ${n} 条回答（含评论）\n\n`;

        for (let i = 0; i < answerElements.length; i++) {
            const answerEl = answerElements[i];
            const authorEl = answerEl.querySelector('.AuthorInfo-name a');
            const authorName = authorEl?.innerText || '匿名用户';
            const authorUrl = authorEl?.href || '#';
            const upvoteCount = __getUpvoteCountFromAnswer(answerEl);
            const commentCount = __getCommentCountFromAnswer(answerEl);
            const timeElement = answerEl.querySelector('time');
            const time = timeElement ? (timeElement.getAttribute('data-tooltip') || timeElement.innerText || '').replace('发布于 ', '').replace('编辑于 ', '编辑于 ') : '未知时间';
            const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
            const contentMd = turndownService.turndown(contentHtml);

            md += `### ${i + 1}. ${authorName}\n\n`;
            if (authorUrl && authorUrl !== '#') {
                md += `[${authorName}](${authorUrl})\n\n`;
            }
            md += `**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`;
            md += contentMd + '\n\n';

            const answerId = __getAnswerId(answerEl);
            if (answerId) {
                const comments = await __fetchCommentsForAnswer(answerId);
                md += __commentsBlockMarkdown(comments);
            }

            closeCommentModal(); // 确保关闭弹窗
            md += `--- \n\n`;
            await yieldToBrowser(0);
        }

        return md;
    }

    // Comment fetching functions with better error handling
    async function __fetchCommentsForAnswer_old(answerId) {
        try {
            const roots = await __fetchAllRootComments(answerId);
            if (!roots || roots.length === 0) {
                console.log(`No comments found for answer ${answerId}`);
                return [];
            }
            for (const rc of roots) {
                if ((rc.child_comment_count || 0) > 0) {
                    rc.child_comments_full = await __fetchAllChildComments(rc.id);
                } else {
                    rc.child_comments_full = [];
                }
            }
            return roots;
        } catch (error) {
            console.warn(`Failed to fetch comments for answer ${answerId}:`, error);
            return [];
        }
    }

    // 替换原有的评论获取函数
    async function __fetchCommentsForAnswer(answerElOrId) {
        let answerEl, answerId;
        
        // 参数处理保持不变
        if (typeof answerElOrId === 'string') {
            answerId = answerElOrId;
            answerEl = document.querySelector(`[name="${answerId}"]`) || 
                       document.querySelector(`[data-zop*="${answerId}"]`);
            if (!answerEl) {
                console.warn(`Cannot find answer element for ID: ${answerId}`);
                return [];
            }
        } else if (answerElOrId && answerElOrId.querySelector) {
            answerEl = answerElOrId;
            answerId = __getAnswerId(answerEl);
        } else {
            console.error('Invalid parameter for __fetchCommentsForAnswer:', answerElOrId);
            return [];
        }
        
        try {
            const commentCount = __getCommentCountFromAnswer(answerEl);
            if (commentCount === '0') return [];
            
            // 1. 点击评论按钮
            const commentBtn = answerEl.querySelector('.ContentItem-actions button:has(.Zi--Comment)');
            if (!commentBtn) return [];
            
            commentBtn.click();
            await new Promise(r => setTimeout(r, 1500));
            
            // 2. 检查是否有"查看全部"按钮
            const viewAllBtn = answerEl.querySelector('.css-vurnku');
            if (viewAllBtn && viewAllBtn.textContent.includes('查看全部')) {
                // 有弹窗的情况
                viewAllBtn.click();
                await new Promise(r => setTimeout(r, 2000));
                
                const modalContent = document.querySelector('.Modal-content.css-1svde17');
                if (modalContent) {
                    const scrollContainer = modalContent.querySelector('.css-34podr');
                    if (scrollContainer) {
                        let lastHeight = 0;
                        for (let i = 0; i < 20; i++) {
                            scrollContainer.scrollTop = scrollContainer.scrollHeight;
                            await new Promise(r => setTimeout(r, 800));
                            if (scrollContainer.scrollHeight === lastHeight) break;
                            lastHeight = scrollContainer.scrollHeight;
                        }
                        
                        const commentsList = modalContent.querySelector('.css-18ld3w0');
                        const comments = __extractCommentsFromPopup(commentsList);
                        closeCommentModal();
                        return comments;
                    }
                }
            } else {
                // 3. 没有"查看全部"按钮，从内嵌评论获取
                const embeddedComments = answerEl.querySelector('.css-18ld3w0');
                if (embeddedComments) {
                    const comments = __extractCommentsFromPopup(embeddedComments);
                    console.log(`Found ${comments.length} embedded comments`);
                    return comments;
                }
            }
            
            return [];
        } catch(e) {
            console.warn('Failed to get comments:', e);
            closeCommentModal();
            return [];
        }
    }

    function __extractCommentsFromContainer(container) {
        const comments = [];
        const commentItems = container.querySelectorAll('.CommentItem');

        commentItems.forEach(item => {
            const userLink = item.querySelector('.UserLink');
            const author = userLink?.textContent || '匿名用户';
            const content = item.querySelector('.CommentContent')?.textContent || '';
            const likeCount = item.querySelector('.Button--plain')?.textContent?.match(/\d+/)?.[0] || '0';
            const time = item.querySelector('time')?.textContent || '';

            if (content) {
                comments.push({
                    author: { name: author },
                    content: content,
                    like_count: likeCount,
                    created_time: time
                });
            }
        });

        return comments;
    }

    // 修复评论提取函数
    function __extractCommentsFromPopup(commentsList) {
        const comments = [];
        const commentItems = commentsList.querySelectorAll('[data-id]');

        commentItems.forEach(item => {
            const userLink = item.querySelector('a.css-10u695f');
            const author = userLink?.textContent || '匿名用户';
            const content = item.querySelector('.CommentContent')?.textContent || '';

            const likeBtn = item.querySelector('.Button--grey');
            const likeText = likeBtn?.textContent || '0';
            const likeCount = likeText.match(/\d+/)?.[0] || '0';

            // 修复时间获取
            const timeEl = item.querySelector('.css-12cl38p');
            const time = timeEl?.textContent || '';

            const replyTo = item.querySelector('.css-gx7lzm') ?
                item.querySelectorAll('a.css-10u695f')[1]?.textContent : null;

            if (content) {
                comments.push({
                    author: { name: author },
                    content: content,
                    like_count: likeCount,
                    created_time: time,
                    reply_to: replyTo
                });
            }
        });

        return comments;
    }

    function closeCommentModal() {
        const closeBtn = document.querySelector('button[aria-label="关闭"].css-169m58j, button[aria-label="关闭"]:has(.Zi--Close)');
        if (closeBtn) {
            closeBtn.click();
        } else {
            const event = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 });
            document.dispatchEvent(event);
        }
    }

    // 拦截XHR请求获取认证头（备选方案）
    function interceptXHRHeaders() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

        window._xhrHeaders = {};

        XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
            if (header.toLowerCase().startsWith('x-zse-')) {
                window._xhrHeaders[header] = value;
                console.log('Captured header:', header, value);
            }
            return originalSetRequestHeader.apply(this, arguments);
        };
    }

    async function __fetchAllRootComments(answerId, orderBy = 'score') {
        let next = `https://www.zhihu.com/api/v4/comment_v5/answers/${answerId}/root_comment?order_by=${orderBy}&limit=20&offset=0`;
        const all = [];

        // Try to find existing XHR headers from the page
        const getHeaders = () => {
            const headers = {
                'x-requested-with': 'fetch'
            };

            // Try to extract headers from existing page requests if possible
            // This is a workaround since we can't generate the encrypted x-zse-96
            if (window._xhrHeaders) {
                Object.assign(headers, window._xhrHeaders);
            }

            return headers;
        };

        while (next) {
            const res = await fetch(next, {
                credentials: 'include',
                headers: getHeaders()
            });

            if (!res.ok) {
                if (res.status === 403) {
                    console.warn(`评论API需要特殊认证，跳过评论获取 (${answerId})`);
                    return [];  // Return empty if we can't authenticate
                }
                console.warn("fetch root comments failed", answerId, res.status);
                break;
            }

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

        const getHeaders = () => {
            const headers = {
                'x-requested-with': 'fetch'
            };
            if (window._xhrHeaders) {
                Object.assign(headers, window._xhrHeaders);
            }
            return headers;
        };

        while (next) {
            const res = await fetch(next, {
                credentials: 'include',
                headers: getHeaders()
            });

            if (!res.ok) {
                if (res.status === 403) {
                    return [];  // Return empty if we can't authenticate
                }
                console.warn("fetch child comments failed", rootId, res.status);
                break;
            }

            const j = await res.json();
            (j.data || []).forEach(x => all.push(x));
            const p = j.paging || {};
            if (p.is_end) break;
            next = p.next;
            await yieldToBrowser(0);
        }
        return all;
    }

    // async function __fetchCommentsForAnswer(answerId) {
    //     const roots = await __fetchAllRootComments(answerId);
    //     for (const rc of roots) {
    //         if ((rc.child_comment_count || 0) > 0) {
    //             rc.child_comments_full = await __fetchAllChildComments(rc.id);
    //         } else {
    //             rc.child_comments_full = [];
    //         }
    //     }
    //     return roots;
    // }

    // 在 __commentsBlockMarkdown 函数之前添加：

    function __commentToMarkdown(comment, level = 0) {
        const indent = '  '.repeat(level);
        const author = comment.author?.name || '匿名用户';
        const content = comment.content || comment.comment?.content || '';
        const likeCount = comment.like_count || comment.vote_count || '0';
        const time = comment.created_time ? __formatUnixTs(comment.created_time) : '';

        let md = `${indent}**${__mdEscape(author)}**`;
        if (likeCount !== '0') md += ` (${likeCount}赞)`;
        if (time) md += ` · ${time}`;
        md += `\n${indent}${__mdEscape(content)}\n\n`;

        return md;
    }

    function __buildChildTree(childComments) {
        // 简单返回子评论列表，不构建树结构
        return childComments || [];
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

    // Expand collapsed content
    async function expandCollapsedContent() {
        console.log("Expanding collapsed content...");
        let expandedCount = 0;
        const questionMoreButton = document.querySelector('.QuestionRichText-more');
        if (questionMoreButton && questionMoreButton.offsetParent !== null && questionMoreButton.innerText.includes('显示全部')) {
            questionMoreButton.click();
            expandedCount++;
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        const buttons = document.querySelectorAll('.RichContent-collapsedText.Button--plain');
        for (const button of buttons) {
            if (button.offsetParent !== null) {
                button.click();
                expandedCount++;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        console.log(`Expanded ${expandedCount} collapsed sections.`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Load all answers
    async function loadAllAnswers() {
        const headerSpan = document.querySelector('.List-headerText span');
        const headerText = headerSpan?.innerText || '';
        const totalAnswers = parseInt(headerText.match(/\d+/)?.[0]) || 999999;
        let lastCount = 0;
        let stagnant = 0;
        const maxAttempts = 400;
        const listContainer = document.getElementById('QuestionAnswers-answers');

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const answers = document.querySelectorAll('.AnswerItem');
            const now = answers.length;
            if (now >= totalAnswers) {
                console.log(`Reached total answers ${now}/${totalAnswers}.`);
                break;
            }
            const last = answers[answers.length - 1];
            if (last && last.scrollIntoView) {
                last.scrollIntoView({ block: 'end' });
            }
            window.scrollBy(0, Math.max(200, Math.floor(window.innerHeight * 0.9)));
            if (listContainer) {
                try { listContainer.scrollTop = listContainer.scrollHeight; } catch (_) { }
            }
            const moreBtns = [
                'button.ContentItem-more',
                '.QuestionAnswers-answerList .PaginationButton',
                'button:has(.Zi--ArrowDown)',
                'button:has(.Zi--ChevronDown)'
            ];
            for (const sel of moreBtns) {
                const btn = document.querySelector(sel);
                if (btn && btn.offsetParent !== null) { try { btn.click(); } catch (_) { } }
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
                console.log(`No progress after ${stagnant} idle cycles, stopping at ${after}/${totalAnswers}.`);
                break;
            }
        }
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 200));
    }

    // Get all answers markdown
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
            await yieldToBrowser(0);
        }

        let fullMd = `## 全部回答 (${index})\n\n`;
        fullMd += chunks.join('');
        return fullMd;
    }

    // Get all answers with comments
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
                    closeCommentModal(); // 确保关闭弹窗
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

    // Get selected answers markdown
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
            console.warn(`Expected to export ${selectedAnswers.size} answers, but found only ${exportedAnswerTokens.size} in the DOM.`);
        }

        return fullMd;
    }

    // Get selected answers with comments
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
                closeCommentModal(); // 确保关闭弹窗
            }
            await yieldToBrowser(0);
        }
        let fullMd = `## 已选回答 (${selectedIndex}/${selectedAnswers.size})\n\n`;
        fullMd += chunks.join('');
        return fullMd;
    }

    // Update download button count
    function updateDownloadButtonCount() {
        const btn1 = document.getElementById('downloadSelectedAnswersButton');
        if (btn1) {
            btn1.innerText = `下载已选回答 (${selectedAnswers.size})`;
            btn1.disabled = selectedAnswers.size === 0;
        }
        const btn2 = document.getElementById('downloadSelectedWithCommentsButton');
        if (btn2) {
            btn2.innerText = `下载已选回答（含评论）`;
            btn2.disabled = selectedAnswers.size === 0;
        }
    }

    // Add select button to answer
    function addSelectButton(answerElement, __retry = 0) {
        if (answerElement.dataset.__hasSelectButton === '1') return;
        if (answerElement.querySelector('.select-answer-button') || !answerElement.classList.contains('AnswerItem')) {
            return;
        }

        const answerToken = answerElement.getAttribute('name') || answerElement.dataset.zop?.itemId || answerElement.id;
        if (!answerToken) {
            console.warn("Could not find token for answer, skipping select button:", answerElement);
            return;
        }

        const metaDiv = answerElement.querySelector('.ContentItem-meta');
        if (metaDiv) {
            if (metaDiv.querySelector('.select-answer-button')) {
                return;
            }

            const selectButton = document.createElement('button');
            selectButton.classList.add('select-answer-button');
            selectButton.innerText = '选择';

            const answerItemStyle = window.getComputedStyle(answerElement).position;
            if (answerItemStyle !== 'relative' && answerItemStyle !== 'absolute') {
                answerElement.style.position = 'relative';
            }

            if (selectedAnswers.has(answerToken)) {
                selectButton.innerText = '取消选择';
                selectButton.classList.add('selected');
            }

            selectButton.addEventListener('click', () => {
                if (selectedAnswers.has(answerToken)) {
                    selectedAnswers.delete(answerToken);
                    selectButton.innerText = '选择';
                    selectButton.classList.remove('selected');
                    console.log(`Deselected answer: ${answerToken}`);
                } else {
                    selectedAnswers.add(answerToken);
                    selectButton.innerText = '取消选择';
                    selectButton.classList.add('selected');
                    console.log(`Selected answer: ${answerToken}`);
                }
                updateDownloadButtonCount();
            });

            answerElement.appendChild(selectButton);
            answerElement.dataset.__hasSelectButton = '1';
            console.log("Select button added to AnswerItem.");

        } else {
            if (__retry < 5) {
                setTimeout(() => addSelectButton(answerElement, __retry + 1), 200);
            } else {
                console.warn("meta not ready after retries", answerElement);
            }
        }
    }

    // Add select buttons to all answers
    function addSelectButtonsToAllAnswers() {
        console.log("Adding select buttons to initial answers...");
        const answerElements = document.querySelectorAll('.AnswerItem');
        answerElements.forEach(addSelectButton);
        console.log(`Added select buttons to ${answerElements.length} initial answers.`);
        updateDownloadButtonCount();
    }

    // Add download all button
    function addDownloadAllButton() {
        console.log("addDownloadAllButton function started.");
        const button = document.createElement('button');
        button.id = 'downloadAllAnswersButton';
        button.innerText = '下载全部回答 (Markdown)';
        button.className = 'zud-btn zud-primary';

        button.addEventListener('click', async () => {
            button.innerText = '正在加载回答...';
            button.disabled = true;
            console.log("Starting download all...");

            try {
                console.log("Loading all answers...");
                await loadAllAnswers();
                console.log("All answers loaded.");
                button.innerText = '正在展开内容...';
                console.log("Expanding collapsed content...");
                await expandCollapsedContent();
                console.log("Collapsed content expanded.");
                button.innerText = '正在生成 Markdown...';
                console.log("Generating Markdown for all answers...");
                const questionMd = getQuestionInfo();
                const answersMd = await getAllAnswersMarkdown();
                const fullMarkdown = questionMd + answersMd;
                const questionTitle = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_all.md`;
                downloadMarkdownFile(filename, fullMarkdown);
                button.innerText = '下载完成!';
                console.log("Download all complete!");
            } catch (error) {
                console.error("An error occurred during download all:", error);
                button.innerText = '下载失败!';
            } finally {
                button.disabled = false;
                setTimeout(() => {
                    button.innerText = '下载全部回答 (Markdown)';
                }, 3000);
            }
        });

        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
        console.log("Download all button added.");
    }

    // Add download all with comments button
    function addDownloadAllWithCommentsButton() {
        const button = document.createElement('button');
        button.id = 'downloadAllWithCommentsButton';
        button.innerText = '下载全部回答（含评论）';
        button.className = 'zud-btn zud-purple';
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
                setTimeout(() => {
                    button.innerText = '下载全部回答（含评论）';
                    button.disabled = false;
                }, 3000);
            }
        });
        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
    }

    // Add main download button
    function addMainDownloadButton() {
        console.log("addMainDownloadButton function started.");
        const button = document.createElement('button');
        button.id = 'downloadSelectedAnswersButton';
        button.innerText = '下载已选回答 (0)';
        button.disabled = true;
        button.className = 'zud-btn zud-secondary';

        button.addEventListener('click', async () => {
            if (selectedAnswers.size === 0) {
                alert("请先选择至少一个回答！");
                return;
            }
            button.innerText = '正在展开内容...';
            button.disabled = true;
            console.log("Starting selected answers download...");

            try {
                console.log("Expanding collapsed content...");
                await expandCollapsedContent();
                console.log("Collapsed content expanded.");
                button.innerText = `正在生成 Markdown (${selectedAnswers.size}个回答)...`;
                console.log("Generating Markdown for selected answers...");
                const questionMd = getQuestionInfo();
                const answersMd = await getSelectedAnswersMarkdown();
                const fullMarkdown = questionMd + answersMd;
                const questionTitle = document.querySelector('.QuestionHeader-title')?.innerText || '知乎问题';
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_selected.md`;
                downloadMarkdownFile(filename, fullMarkdown);
                button.innerText = '下载完成!';
                console.log("Download complete!");
            } catch (error) {
                console.error("An error occurred during selected download:", error);
                button.innerText = '下载失败!';
            } finally {
                updateDownloadButtonCount();
                setTimeout(() => {
                    updateDownloadButtonCount();
                }, 3000);
            }
        });

        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
        console.log("Download selected button added.");
        updateDownloadButtonCount();
    }

    // Add download selected with comments button
    function addDownloadSelectedWithCommentsButton() {
        const button = document.createElement('button');
        button.id = 'downloadSelectedWithCommentsButton';
        button.innerText = '下载已选回答（含评论）';
        button.disabled = selectedAnswers.size === 0;
        button.className = 'zud-btn zud-teal';
        button.addEventListener('click', async () => {
            if (selectedAnswers.size === 0) {
                alert('请先选择至少一个回答');
                return;
            }
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
                setTimeout(() => {
                    button.innerText = '下载已选回答（含评论）';
                    button.disabled = false;
                }, 3000);
            }
        });
        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
    }

    // MutationObserver Setup
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

    // Script Initialization
    console.log("Zhihu Download Script started.");
    interceptXHRHeaders();
    __zudEnsurePanel();

    addDownloadAllButton();
    addDownloadAllWithCommentsButton();
    addMainDownloadButton();
    addDownloadSelectedWithCommentsButton();

    addSelectButtonsToAllAnswers();

    const answerListContainer = document.getElementById('QuestionAnswers-answers');
    observer2.observe(document.body, { childList: true, subtree: true });
    console.log("Also observing body for dynamically loaded AnswerItem.");
    if (answerListContainer) {
        observer.observe(answerListContainer, { childList: true, subtree: true });
        console.log("Started observing answer list for new answers and adding select buttons.");
    } else {
        console.warn("Could not find answer list container (#QuestionAnswers-answers), dynamic loading of select buttons might not work.");
    }

})();