// ==UserScript==
// @name         Reddit Post Markdown Exporter
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @description  Export Reddit posts and comments to Markdown format with batch or selective download
// @author       Qi Deng
// @match        https://www.reddit.com/r/*/comments/*
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/lib/turndown.umd.js#sha256-bNU+0rwWe4WVADj+kwuhXm7nhfx2/c/hbaHk979TOpw=
// @downloadURL  https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/social/reddit.user.js
// @updateURL    https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/social/reddit.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULT_LOAD_TIMEOUT = 2000;
    const MAX_SCROLL_ATTEMPTS = 30;

    // Wait for shreddit-post to be available
    async function waitForElement(selector, timeout = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const element = document.querySelector(selector);
            if (element) return element;
            await new Promise(r => setTimeout(r, 100));
        }
        throw new Error(`Element ${selector} not found after ${timeout}ms`);
    }

    // Initialize script after shreddit-post is loaded
    async function initScript() {
        try {
            await waitForElement('shreddit-post');
            console.log('Reddit Export Script: shreddit-post found, initializing...');
        } catch (e) {
            console.warn('Reddit Export Script: This page does not appear to be a Reddit post page with new UI.');
            return;
        }

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
            linkReferenceStyle: 'inlined'
        });

        turndownService.addRule('lazyImage', {
            filter: 'img',
            replacement: function (content, node) {
                const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
                const alt = node.alt || '';
                if (src && !src.includes('redd.it/award_images/')) {
                    return `![${alt}](${src})`;
                }
                return '';
            }
        });

        // --- Variables for Selective Download ---
        const selectedComments = new Set();
        const commentCache = new Map();
        let commentOrderCounter = 0;

        // --- Panel with Tokyo Night Light Theme ---
        function __redInjectStyles() {
            if (document.getElementById('red-style')) return;
            const css = `
#redPanel{position:fixed; top:80px; right:20px; width:320px; background:#FAFBFC; color:#343b58;
  border:1px solid #d8dee9; border-radius:16px; padding:12px; z-index:10010;
  box-shadow:0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04); font-size:13px; line-height:1.4;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);}
#redPanel.collapsed{width:48px; height:48px; padding:0; overflow:hidden; cursor:pointer;}
#redPanel .red-icon{display:none; width:48px; height:48px; align-items:center; justify-content:center; font-size:20px;}
#redPanel.collapsed .red-icon{display:flex;}
#redPanel.collapsed .red-header, #redPanel.collapsed .red-body{display:none;}
#redPanel .red-header{display:flex; align-items:center; justify-content:space-between; font-weight:600;
  margin-bottom:10px; color:#0969da;}
#redPanel .red-actions{display:flex; gap:6px;}
#redPanel .red-toggle, #redPanel .red-clear{padding:5px 10px; border-radius:8px; border:1px solid #d0d7de;
  background:#ffffff; color:#565a76; cursor:pointer; font-size:12px; transition:all 0.2s;}
#redPanel .red-toggle:hover, #redPanel .red-clear:hover{background:#f3f4f6; border-color:#8c96a8;}
#redPanel .red-body{display:block;}
#red-btns{display:grid; grid-template-columns:1fr; gap:8px; margin-bottom:12px;}
.red-btn{padding:9px 14px; border-radius:10px; border:1px solid; color:#fff; font-weight:500;
  cursor:pointer; transition:all 0.2s; font-size:13px;}
.red-btn:disabled{opacity:0.5; cursor:not-allowed;}
.red-btn:hover:not(:disabled){transform:translateY(-1px); box-shadow:0 4px 12px rgba(0,0,0,0.15);}
.red-primary{background:linear-gradient(135deg,#6B9BD1,#5B8DC4); border-color:#5B8DC4;}
.red-secondary{background:linear-gradient(135deg,#70C0B8,#5AAA9F); border-color:#5AAA9F;}
#red-logwrap{border-top:1px solid #e5e9f0; padding-top:10px; margin-top:10px;}
#red-logwrap .log-title{color:#565a76; font-weight:500; margin-bottom:6px; font-size:12px;}
#red-log{max-height:120px; overflow:auto; background:#f6f8fa; border:1px solid #d0d7de;
  border-radius:8px; padding:8px; font-family:'SF Mono',Monaco,Consolas,monospace; font-size:11px; line-height:1.4;}
#red-log::-webkit-scrollbar{width:6px;}
#red-log::-webkit-scrollbar-track{background:#e5e9f0; border-radius:3px;}
#red-log::-webkit-scrollbar-thumb{background:#8b92a8; border-radius:3px;}
#red-log .warn{color:#9D6500;}
#red-log .error{color:#CF222E;}
.select-comment-button{position:absolute; top:8px; right:8px; z-index:50; padding:4px 10px;
  background:#ffffff; color:#565a76; border:1px solid #d0d7de; border-radius:6px; cursor:pointer;
  font-size:12px; transition:all 0.2s;}
.select-comment-button:hover{background:#f3f4f6; border-color:#6B9BD1;}
.select-comment-button.selected{background:#dff7ff; color:#0969da; border-color:#54aeff;}
shreddit-comment.comment-selected{background:#f0f8ff !important; border-left:3px solid #54aeff !important;}
            `;
            const style = document.createElement('style');
            style.id = 'red-style'; 
            style.textContent = css;
            document.head.appendChild(style);
        }

        function __redEnsurePanel() {
            __redInjectStyles();
            let panel = document.getElementById('redPanel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'redPanel';
                panel.innerHTML = `
                  <div class="red-icon">📥</div>
                  <div class="red-header">
                    <div>Reddit Export</div>
                    <div class="red-actions">
                      <button class="red-toggle" id="redToggle">Collapse</button>
                      <button class="red-clear" id="redClear">Clear</button>
                    </div>
                  </div>
                  <div class="red-body">
                    <div id="red-btns"></div>
                    <div id="red-logwrap">
                      <div class="log-title">Log</div>
                      <div id="red-log"></div>
                    </div>
                  </div>
                `;
                document.body.appendChild(panel);

                panel.addEventListener('click', (e) => {
                    if (panel.classList.contains('collapsed') && !e.target.closest('button')) {
                        panel.classList.remove('collapsed');
                    }
                });

                panel.querySelector('#redToggle').addEventListener('click', (e) => {
                    e.stopPropagation();
                    panel.classList.add('collapsed');
                });

                panel.querySelector('#redClear').addEventListener('click', () => {
                    const el = document.getElementById('red-log');
                    if (el) el.innerHTML = '';
                });
            }
            return panel;
        }

        // Console hook
        (function __redHookConsole() {
            if (window.__redConsoleHooked__) return;
            window.__redConsoleHooked__ = true;
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
                const el = document.getElementById('red-log');
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
        function __mdEscape(s) {
            return (s || '').toString().replace(/[*`_\[\]<>]/g, m => `\\${m}`);
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
            return sanitized || 'reddit_post';
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

        async function yieldToBrowser(ms = 0) {
            if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
                await new Promise(resolve => requestIdleCallback(() => resolve()));
            } else {
                await new Promise(resolve => setTimeout(resolve, ms));
            }
        }

        // Smooth scrolling helper
        function smoothScrollTo(targetY, duration = 300) {
            return new Promise(resolve => {
                const startY = window.scrollY;
                const distance = targetY - startY;
                const startTime = performance.now();

                function animate(currentTime) {
                    const elapsed = currentTime - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    const easeProgress = progress < 0.5
                        ? 2 * progress * progress
                        : -1 + (4 - 2 * progress) * progress;
                    const newY = startY + distance * easeProgress;
                    window.scrollTo(0, newY);

                    if (progress < 1) {
                        requestAnimationFrame(animate);
                    } else {
                        resolve();
                    }
                }
                requestAnimationFrame(animate);
            });
        }

        // Human-like scroll
        async function humanLikeScrollToBottom() {
            const startY = window.scrollY;
            const targetY = document.body.scrollHeight;
            const totalDistance = targetY - startY;

            if (totalDistance <= 100) return;

            let currentY = startY;
            const steps = 5 + Math.floor(Math.random() * 3);

            for (let i = 0; i < steps; i++) {
                const baseStep = totalDistance / steps;
                const randomVariation = (Math.random() - 0.5) * 0.3;
                const stepSize = baseStep * (1 + randomVariation);
                currentY += stepSize;

                await smoothScrollTo(currentY, 150 + Math.random() * 150);
                await new Promise(r => setTimeout(r, 30 + Math.random() * 70));
            }

            await smoothScrollTo(document.body.scrollHeight, 200);
        }

        // Get post information
        function getPostInfo() {
            const postEl = document.querySelector('shreddit-post');
            if (!postEl) return '# No Post Found\n\n';

            const title = postEl.getAttribute('post-title') || 'Untitled';
            const author = postEl.getAttribute('author') || 'Unknown';
            const subreddit = postEl.getAttribute('subreddit-prefixed-name') || '';
            const score = postEl.getAttribute('score') || '0';
            const commentCount = postEl.getAttribute('comment-count') || '0';
            const created = postEl.getAttribute('created-timestamp') || '';
            const url = window.location.href;

            const contentSlot = postEl.querySelector('[slot="text-body"]');
            let contentMd = '';
            if (contentSlot) {
                try {
                    const contentHtml = contentSlot.innerHTML || '';
                    contentMd = turndownService.turndown(contentHtml);
                } catch (e) {
                    console.warn('Failed to convert post content:', e);
                    contentMd = contentSlot.textContent || '';
                }
            }

            let md = `# ${title}\n\n`;
            md += `**URL:** ${url}\n\n`;
            md += `**Author:** u/${author} | **Subreddit:** ${subreddit}\n\n`;
            md += `**Score:** ${score} | **Comments:** ${commentCount}`;
            if (created) {
                const date = new Date(created);
                md += ` | **Posted:** ${date.toLocaleString()}`;
            }
            md += `\n\n`;

            if (contentMd.trim()) {
                md += `## Post Content\n\n`;
                md += contentMd + '\n\n';
            }

            md += `---\n\n`;
            return md;
        }

        function __getCommentId(commentEl) {
            return commentEl.getAttribute('thingid') || commentEl.id || '';
        }

        function __parseCommentToMarkdown(commentEl, level = 0) {
            const indent = '  '.repeat(level);
            const author = commentEl.getAttribute('author') || '[deleted]';
            const scoreSlot = commentEl.querySelector('[slot="score"]');
            const score = scoreSlot?.textContent?.trim() || '0';

            const contentSlot = commentEl.querySelector('[slot="comment"]');
            let content = '';
            
            try {
                if (contentSlot) {
                    const contentHtml = contentSlot.innerHTML || '';
                    content = turndownService.turndown(contentHtml);
                } else {
                    const deletedMsg = commentEl.querySelector('faceplate-deleted-comment-message');
                    if (deletedMsg) {
                        content = '[deleted]';
                    } else {
                        content = commentEl.textContent?.trim() || '';
                    }
                }
            } catch (e) {
                console.warn('Failed to parse comment, using text content:', e);
                content = contentSlot?.textContent || '[parsing failed]';
            }

            const time = commentEl.getAttribute('created-timestamp') || '';
            let timeStr = '';
            if (time) {
                try {
                    const date = new Date(time);
                    timeStr = ` · ${date.toLocaleString()}`;
                } catch (e) {
                    console.warn('Failed to parse timestamp:', e);
                }
            }

            let md = `${indent}**u/${__mdEscape(author)}**`;
            md += ` (${score} points)${timeStr}\n`;
            md += `${indent}${content.split('\n').join('\n' + indent)}\n\n`;

            return md;
        }

        function cacheCommentMarkdown(commentEl) {
            if (!commentEl || commentEl.hasAttribute('isloadmore')) return;
            const commentId = __getCommentId(commentEl);
            if (!commentId) return;
            const depth = parseInt(commentEl.getAttribute('depth') || '0', 10);
            const markdown = __parseCommentToMarkdown(commentEl, depth);
            const existing = commentCache.get(commentId);
            const order = existing?.order ?? commentOrderCounter++;
            commentCache.set(commentId, { order, markdown, depth });
        }

        function getSortedCachedComments(filterFn = () => true) {
            const entries = [];
            commentCache.forEach((value, id) => {
                if (filterFn(id, value)) {
                    entries.push({ id, ...value });
                }
            });
            entries.sort((a, b) => a.order - b.order);
            return entries;
        }

        function ensureCacheFromDom() {
            if (commentCache.size > 0) return;
            const commentElements = document.querySelectorAll('shreddit-comment:not([isloadmore])');
            commentElements.forEach(cacheCommentMarkdown);
        }

        // Expand collapsed comments (in <details> elements)
        async function expandCollapsedComments() {
            const collapsedComments = document.querySelectorAll('shreddit-comment details[role="article"]:not([open])');
            if (collapsedComments.length > 0) {
                console.log(`Expanding ${collapsedComments.length} collapsed comments...`);
                for (const detail of collapsedComments) {
                    try {
                        detail.open = true;
                        await new Promise(r => setTimeout(r, 50));
                    } catch (e) {
                        console.warn('Failed to expand collapsed comment:', e);
                    }
                }
            }
        }

        // Click "Show replies" buttons to expand nested threads
        async function expandNestedReplies() {
            const commentTree = document.querySelector('shreddit-comments-page') || document.body;

            // Find all expand buttons for nested replies
            const expandButtons = commentTree.querySelectorAll('button[aria-label*="Toggle Comment Thread"], button[aria-controls*="comment-children"]');
            if (expandButtons.length > 0) {
                console.log(`Found ${expandButtons.length} collapsed reply threads, expanding...`);
                for (const btn of expandButtons) {
                    try {
                        const isExpanded = btn.getAttribute('aria-expanded') === 'true';
                        if (!isExpanded) {
                            btn.click();
                            await new Promise(r => setTimeout(r, 200));
                        }
                    } catch (e) {
                        console.warn('Failed to expand reply thread:', e);
                    }
                }
            }
        }

        // Load more comments using scroll
        async function loadAllComments() {
            console.log('Loading all comments with scroll...');
            let maxCommentsSeen = commentCache.size;
            let stagnantCycles = 0;
            const commentTree = document.querySelector('shreddit-comments-page') || document.body;

            for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
                // Expand collapsed comments first
                await expandCollapsedComments();

                // Expand nested reply threads
                await expandNestedReplies();

                // Click "Show more" / "Load more" buttons
                const moreButtons = commentTree.querySelectorAll('shreddit-comment[isloadmore], button[aria-label*="more comments"], button[aria-label*="More replies"]');
                if (moreButtons.length > 0) {
                    console.log(`Found ${moreButtons.length} 'more' buttons, clicking...`);
                    for (const btn of moreButtons) {
                        try {
                            btn.click();
                            await new Promise(r => setTimeout(r, 300));
                        } catch (e) {
                            console.warn('Failed to click more button:', e);
                        }
                    }
                }

                // Scroll to load virtualized content
                await humanLikeScrollToBottom();
                await new Promise(r => setTimeout(r, DEFAULT_LOAD_TIMEOUT));

                const currentComments = commentTree.querySelectorAll('shreddit-comment:not([isloadmore])');
                const currentCount = currentComments.length;

                currentComments.forEach(cacheCommentMarkdown);

                const totalSeen = commentCache.size;
                console.log(`Visible: ${currentCount}, Total seen (cached): ${totalSeen}`);

                if (totalSeen > maxCommentsSeen) {
                    maxCommentsSeen = totalSeen;
                    stagnantCycles = 0;
                } else {
                    stagnantCycles++;
                    if (stagnantCycles >= 3) {
                        console.log(`No new comments for ${stagnantCycles} cycles, stopping.`);
                        break;
                    }
                }
            }

            // Final pass to ensure all are expanded
            await expandCollapsedComments();
            await expandNestedReplies();
            await new Promise(r => setTimeout(r, 1000));

            // Cache any newly visible comments
            const finalComments = commentTree.querySelectorAll('shreddit-comment:not([isloadmore])');
            finalComments.forEach(cacheCommentMarkdown);

            await smoothScrollTo(0, 400);
            console.log(`Finished loading. Total unique comments cached: ${commentCache.size}`);
        }

        async function getAllCommentsMarkdown() {
            ensureCacheFromDom();
            const cached = getSortedCachedComments();
            let md = `## Comments (${cached.length})\n\n`;

            for (let i = 0; i < cached.length; i++) {
                md += cached[i].markdown;
                if (i % 10 === 0) {
                    await yieldToBrowser(0);
                }
            }

            return md;
        }

        async function getSelectedCommentsMarkdown() {
            ensureCacheFromDom();
            const cached = getSortedCachedComments(id => selectedComments.has(id));
            let md = `## Selected Comments (${cached.length})\n\n`;

            for (let i = 0; i < cached.length; i++) {
                md += cached[i].markdown;
                if (i % 10 === 0) {
                    await yieldToBrowser(0);
                }
            }

            return md;
        }

        function updateDownloadButtonCount() {
            const btn1 = document.getElementById('downloadSelectedCommentsButton');
            if (btn1) {
                btn1.innerText = `Download Selected (${selectedComments.size})`;
                btn1.disabled = selectedComments.size === 0;
            }
        }

        function addSelectButton(commentEl) {
            if (commentEl.dataset.__hasSelectButton === '1') return;
            if (commentEl.hasAttribute('isloadmore')) return;

            const commentId = __getCommentId(commentEl);
            if (!commentId) {
                console.warn("Could not find ID for comment, skipping");
                return;
            }

            cacheCommentMarkdown(commentEl);

            const selectButton = document.createElement('button');
            selectButton.classList.add('select-comment-button');
            selectButton.innerText = 'Select';

            if (selectedComments.has(commentId)) {
                selectButton.innerText = 'Deselect';
                selectButton.classList.add('selected');
                commentEl.classList.add('comment-selected');
            }

            selectButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (selectedComments.has(commentId)) {
                    selectedComments.delete(commentId);
                    selectButton.innerText = 'Select';
                    selectButton.classList.remove('selected');
                    commentEl.classList.remove('comment-selected');
                    console.log(`Deselected: ${commentId}`);
                } else {
                    selectedComments.add(commentId);
                    selectButton.innerText = 'Deselect';
                    selectButton.classList.add('selected');
                    commentEl.classList.add('comment-selected');
                    console.log(`Selected: ${commentId}`);
                }
                updateDownloadButtonCount();
            });

            let inserted = false;
            if (commentEl.shadowRoot?.querySelector('slot[name="header"]')) {
                const slotWrapper = document.createElement('div');
                slotWrapper.slot = 'header';
                slotWrapper.style.display = 'inline-flex';
                slotWrapper.style.alignItems = 'center';
                slotWrapper.style.gap = '6px';
                slotWrapper.appendChild(selectButton);
                commentEl.appendChild(slotWrapper);
                inserted = true;
            }

            if (!inserted) {
                commentEl.appendChild(selectButton);
            }
            commentEl.dataset.__hasSelectButton = '1';
        }

        function addSelectButtonsToAllComments() {
            console.log("Adding select buttons to comments...");
            const commentTree = document.querySelector('shreddit-comments-page') || document.body;
            const commentElements = commentTree.querySelectorAll('shreddit-comment:not([isloadmore])');
            commentElements.forEach(addSelectButton);
            console.log(`Added select buttons to ${commentElements.length} comments.`);
            updateDownloadButtonCount();
        }

        function addDownloadAllButton() {
            const button = document.createElement('button');
            button.id = 'downloadAllCommentsButton';
            button.innerText = 'Download All Comments';
            button.className = 'red-btn red-primary';

            button.addEventListener('click', async () => {
                const originalText = button.innerText;
                button.innerText = 'Loading comments...';
                button.disabled = true;
                console.log("Starting download all...");

                try {
                    await loadAllComments();
                    addSelectButtonsToAllComments();

                    button.innerText = 'Generating Markdown...';
                    const postMd = getPostInfo();
                    const commentsMd = await getAllCommentsMarkdown();
                    const fullMarkdown = postMd + commentsMd;

                    const postTitle = document.querySelector('shreddit-post')?.getAttribute('post-title') || 'reddit_post';
                    const filename = `${sanitizeFilename(postTitle)}_${formatDownloadDateTime()}_all.md`;
                    downloadMarkdownFile(filename, fullMarkdown);

                    button.innerText = 'Download complete!';
                    console.log("Download complete!");
                } catch (error) {
                    console.error("Error during download:", error);
                    button.innerText = 'Download failed!';
                } finally {
                    setTimeout(() => {
                        button.innerText = originalText;
                    }, 1000);
                    button.disabled = false;
                }
            });

            (__redEnsurePanel().querySelector('#red-btns') || document.body).appendChild(button);
        }

        function addDownloadSelectedButton() {
            const button = document.createElement('button');
            button.id = 'downloadSelectedCommentsButton';
            button.innerText = 'Download Selected (0)';
            button.disabled = true;
            button.className = 'red-btn red-secondary';

            button.addEventListener('click', async () => {
                if (selectedComments.size === 0) {
                    console.warn("Please select at least one comment!");
                    return;
                }

                const originalText = button.innerText;
                button.innerText = 'Generating Markdown...';
                button.disabled = true;

                try {
                    const postMd = getPostInfo();
                    const commentsMd = await getSelectedCommentsMarkdown();
                    const fullMarkdown = postMd + commentsMd;

                    const postTitle = document.querySelector('shreddit-post')?.getAttribute('post-title') || 'reddit_post';
                    const filename = `${sanitizeFilename(postTitle)}_${formatDownloadDateTime()}_selected.md`;
                    downloadMarkdownFile(filename, fullMarkdown);

                    button.innerText = 'Download complete!';
                    console.log("Download complete!");
                } catch (error) {
                    console.error("Error during download:", error);
                    button.innerText = 'Download failed!';
                } finally {
                    button.disabled = selectedComments.size === 0;
                    setTimeout(() => {
                        button.innerText = originalText;
                        button.disabled = selectedComments.size === 0;
                    }, 1000);
                }
            });

            (__redEnsurePanel().querySelector('#red-btns') || document.body).appendChild(button);
            updateDownloadButtonCount();
        }

        // MutationObserver - limited scope
        const commentTree = document.querySelector('shreddit-comments-page') || document.body;
        const pendingObserverComments = new Set();
        let observerScheduled = false;
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (!m.addedNodes) continue;
                for (const node of m.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.tagName === 'SHREDDIT-COMMENT' && !node.hasAttribute('isloadmore')) {
                        pendingObserverComments.add(node);
                    } else if (node.querySelectorAll) {
                        node.querySelectorAll('shreddit-comment:not([isloadmore])').forEach(el => pendingObserverComments.add(el));
                    }
                }
            }

            if (!observerScheduled && pendingObserverComments.size > 0) {
                observerScheduled = true;
                requestAnimationFrame(() => {
                    observerScheduled = false;
                    pendingObserverComments.forEach(el => {
                        addSelectButton(el);
                    });
                    pendingObserverComments.clear();
                    updateDownloadButtonCount();
                });
            }
        });

        // Script Initialization
        console.log("Reddit Export Script initialized.");
        __redEnsurePanel();

        addDownloadAllButton();
        addDownloadSelectedButton();
        addSelectButtonsToAllComments();

        observer.observe(commentTree, { childList: true, subtree: true });
        console.log("Observing for dynamically loaded comments.");
    }

    // Start initialization
    initScript().catch(e => console.error('Reddit Export Script failed to initialize:', e));

})();
