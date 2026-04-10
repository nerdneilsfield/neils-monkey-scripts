// ==UserScript==
// @name         Reddit Post Markdown Exporter
// @namespace    http://tampermonkey.net/
// @version      0.3.0
// @description  Export Reddit posts and comments to Markdown format with batch or selective download
// @author       Qi Deng
// @match        https://www.reddit.com/r/*/comments/*
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/lib/turndown.umd.js#sha256-bNU+0rwWe4WVADj+kwuhXm7nhfx2/c/hbaHk979TOpw=
// @downloadURL  https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/forum/reddit.user.js
// @updateURL    https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/forum/reddit.user.js
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'Reddit Export Script';
    const DEFAULT_LOAD_TIMEOUT = 2000;
    const MAX_SCROLL_ATTEMPTS = 30;
    const INIT_TIMEOUT = 10000;
    const NAVIGATION_DEBOUNCE_MS = 150;

    const state = {
        activeUrl: '',
        initToken: 0,
        observer: null,
        observerScheduled: false,
        pendingObserverComments: new Set(),
        selectedComments: new Set(),
        commentCache: new Map(),
        reinitTimer: null,
        navigationBound: false
    };

    const turndownService = createTurndownService();

    function createTurndownService() {
        const service = new TurndownService({
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

        service.addRule('lazyImage', {
            filter: 'img',
            replacement(content, node) {
                const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
                const alt = node.alt || '';
                if (src && !src.includes('redd.it/award_images/')) {
                    return `![${alt}](${src})`;
                }
                return '';
            }
        });

        return service;
    }

    function serializeLogArg(value) {
        try {
            return typeof value === 'object' ? JSON.stringify(value) : String(value);
        } catch (_) {
            return String(value);
        }
    }

    function appendLogLine(type, message) {
        const logEl = document.getElementById('red-log');
        if (!logEl) return;

        const line = document.createElement('div');
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        if (type !== 'log') {
            line.className = type;
        }

        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function emitLog(type, args) {
        const consoleMethod = typeof console[type] === 'function' ? console[type] : console.log;
        consoleMethod(`[${SCRIPT_NAME}]`, ...args);
        appendLogLine(type, args.map(serializeLogArg).join(' '));
    }

    function log(...args) {
        emitLog('log', args);
    }

    function warn(...args) {
        emitLog('warn', args);
    }

    function error(...args) {
        emitLog('error', args);
    }

    function waitForElement(selector, { timeout = INIT_TIMEOUT, root = document } = {}) {
        return new Promise((resolve, reject) => {
            const existing = root.querySelector(selector);
            if (existing) {
                resolve(existing);
                return;
            }

            const observeRoot = root === document ? (document.body || document.documentElement) : root;
            if (!observeRoot) {
                reject(new Error(`Cannot observe root for selector ${selector}`));
                return;
            }

            let timerId = null;
            const observer = new MutationObserver(() => {
                const element = root.querySelector(selector);
                if (element) {
                    cleanup();
                    resolve(element);
                }
            });

            function cleanup() {
                observer.disconnect();
                if (timerId !== null) {
                    clearTimeout(timerId);
                }
            }

            observer.observe(observeRoot, { childList: true, subtree: true });

            if (timeout > 0) {
                timerId = window.setTimeout(() => {
                    cleanup();
                    reject(new Error(`Element ${selector} not found after ${timeout}ms`));
                }, timeout);
            }
        });
    }

    function matchesRedditPostUrl(url = window.location.href) {
        try {
            const parsed = new URL(url);
            return parsed.hostname === 'www.reddit.com' && /\/r\/[^/]+\/comments\/[^/]+/.test(parsed.pathname);
        } catch (_) {
            return false;
        }
    }

    function getCommentTree() {
        return document.querySelector('shreddit-comments-page') || document.body;
    }

    function getCommentElements(root = getCommentTree()) {
        if (!root) return [];
        return Array.from(root.querySelectorAll('shreddit-comment:not([isloadmore])'));
    }

    function __redInjectStyles() {
        if (document.getElementById('red-style')) return;
        const css = `
#redPanel{position:fixed; top:80px; right:20px; width:320px; background:#FAFBFC; color:#343b58;
  border:1px solid #d8dee9; border-radius:16px; padding:12px; z-index:10010;
  box-shadow:0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04); font-size:13px; line-height:1.4;
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);}
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

            panel.addEventListener('click', (event) => {
                if (panel.classList.contains('collapsed') && !event.target.closest('button')) {
                    panel.classList.remove('collapsed');
                }
            });

            panel.querySelector('#redToggle').addEventListener('click', (event) => {
                event.stopPropagation();
                panel.classList.add('collapsed');
            });

            panel.querySelector('#redClear').addEventListener('click', () => {
                const logEl = document.getElementById('red-log');
                if (logEl) {
                    logEl.innerHTML = '';
                }
            });
        }

        return panel;
    }

    function resetPanelContent() {
        const buttonsWrap = document.getElementById('red-btns');
        if (buttonsWrap) {
            buttonsWrap.innerHTML = '';
        }

        const logEl = document.getElementById('red-log');
        if (logEl) {
            logEl.innerHTML = '';
        }
    }

    function destroyPanel() {
        const panel = document.getElementById('redPanel');
        if (panel) {
            panel.remove();
        }
    }

    function clearCommentSelectionUi() {
        document.querySelectorAll('[data-red-slot-wrapper="1"]').forEach((wrapper) => wrapper.remove());
        document.querySelectorAll('.select-comment-button').forEach((button) => button.remove());
        document.querySelectorAll('shreddit-comment.comment-selected').forEach((commentEl) => {
            commentEl.classList.remove('comment-selected');
        });
        document.querySelectorAll('shreddit-comment[data-red-has-select-button="1"]').forEach((commentEl) => {
            delete commentEl.dataset.redHasSelectButton;
        });
    }

    function __mdEscape(text) {
        return (text || '').toString().replace(/[*`_\[\]<>]/g, (match) => `\\${match}`);
    }

    function formatDownloadDateTime() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
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
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    async function yieldToBrowser(ms = 0) {
        if (typeof requestIdleCallback === 'function') {
            await new Promise((resolve) => requestIdleCallback(() => resolve()));
        } else {
            await new Promise((resolve) => setTimeout(resolve, ms));
        }
    }

    function smoothScrollTo(targetY, duration = 300) {
        return new Promise((resolve) => {
            const startY = window.scrollY;
            const distance = targetY - startY;
            const startTime = performance.now();

            function animate(currentTime) {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const eased = progress < 0.5
                    ? 2 * progress * progress
                    : -1 + (4 - 2 * progress) * progress;

                window.scrollTo(0, startY + distance * eased);

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    resolve();
                }
            }

            requestAnimationFrame(animate);
        });
    }

    async function humanLikeScrollToBottom() {
        const startY = window.scrollY;
        const targetY = document.body.scrollHeight;
        const totalDistance = targetY - startY;

        if (totalDistance <= 100) {
            return;
        }

        let currentY = startY;
        const steps = 5 + Math.floor(Math.random() * 3);

        for (let index = 0; index < steps; index++) {
            const baseStep = totalDistance / steps;
            const randomVariation = (Math.random() - 0.5) * 0.3;
            currentY += baseStep * (1 + randomVariation);
            await smoothScrollTo(currentY, 150 + Math.random() * 150);
            await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 70));
        }

        await smoothScrollTo(document.body.scrollHeight, 200);
    }

    function getPostInfo() {
        const postEl = document.querySelector('shreddit-post');
        if (!postEl) {
            return '# No Post Found\n\n';
        }

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
                contentMd = turndownService.turndown(contentSlot.innerHTML || '');
            } catch (conversionError) {
                warn('Failed to convert post content:', conversionError);
                contentMd = contentSlot.textContent || '';
            }
        }

        let markdown = `# ${title}\n\n`;
        markdown += `**URL:** ${url}\n\n`;
        markdown += `**Author:** u/${author} | **Subreddit:** ${subreddit}\n\n`;
        markdown += `**Score:** ${score} | **Comments:** ${commentCount}`;
        if (created) {
            markdown += ` | **Posted:** ${new Date(created).toLocaleString()}`;
        }
        markdown += '\n\n';

        if (contentMd.trim()) {
            markdown += `## Post Content\n\n${contentMd}\n\n`;
        }

        markdown += '---\n\n';
        return markdown;
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
                content = turndownService.turndown(contentSlot.innerHTML || '');
            } else if (commentEl.querySelector('faceplate-deleted-comment-message')) {
                content = '[deleted]';
            } else {
                content = commentEl.textContent?.trim() || '';
            }
        } catch (parseError) {
            warn('Failed to parse comment, falling back to text content:', parseError);
            content = contentSlot?.textContent || '[parsing failed]';
        }

        const created = commentEl.getAttribute('created-timestamp') || '';
        const timeText = created ? ` · ${new Date(created).toLocaleString()}` : '';

        let markdown = `${indent}**u/${__mdEscape(author)}**`;
        markdown += ` (${score} points)${timeText}\n`;
        markdown += `${indent}${content.split('\n').join(`\n${indent}`)}\n\n`;
        return markdown;
    }

    function cacheCommentMarkdown(commentEl) {
        if (!commentEl || commentEl.hasAttribute('isloadmore')) {
            return;
        }

        const commentId = __getCommentId(commentEl);
        if (!commentId) {
            return;
        }

        const depth = Number.parseInt(commentEl.getAttribute('depth') || '0', 10);
        state.commentCache.set(commentId, {
            markdown: __parseCommentToMarkdown(commentEl, depth),
            depth
        });
    }

    function getOrderedCommentEntries(filterFn = () => true) {
        const ordered = [];
        const seenIds = new Set();

        getCommentElements().forEach((commentEl) => {
            const commentId = __getCommentId(commentEl);
            if (!commentId || seenIds.has(commentId)) {
                return;
            }

            cacheCommentMarkdown(commentEl);
            const entry = state.commentCache.get(commentId);
            if (entry && filterFn(commentId, entry)) {
                ordered.push({ id: commentId, ...entry });
            }
            seenIds.add(commentId);
        });

        state.commentCache.forEach((entry, commentId) => {
            if (seenIds.has(commentId) || !filterFn(commentId, entry)) {
                return;
            }
            ordered.push({ id: commentId, ...entry });
        });

        return ordered;
    }

    async function expandCollapsedComments() {
        const collapsedComments = document.querySelectorAll('shreddit-comment details[role="article"]:not([open])');
        if (collapsedComments.length === 0) {
            return;
        }

        log(`Expanding ${collapsedComments.length} collapsed comments...`);
        for (const detail of collapsedComments) {
            try {
                detail.open = true;
                await new Promise((resolve) => setTimeout(resolve, 50));
            } catch (expandError) {
                warn('Failed to expand collapsed comment:', expandError);
            }
        }
    }

    async function expandNestedReplies() {
        const commentTree = getCommentTree();
        if (!commentTree) {
            return;
        }

        const expandButtons = commentTree.querySelectorAll(
            'button[aria-label*="Toggle Comment Thread"], button[aria-controls*="comment-children"]'
        );

        if (expandButtons.length === 0) {
            return;
        }

        log(`Found ${expandButtons.length} collapsed reply threads, expanding...`);
        for (const button of expandButtons) {
            try {
                if (button.getAttribute('aria-expanded') !== 'true') {
                    button.click();
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            } catch (expandError) {
                warn('Failed to expand reply thread:', expandError);
            }
        }
    }

    async function loadAllComments() {
        log('Loading all comments with scroll...');
        let maxCommentsSeen = state.commentCache.size;
        let stagnantCycles = 0;
        const commentTree = getCommentTree();

        for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
            await expandCollapsedComments();
            await expandNestedReplies();

            const moreButtons = commentTree?.querySelectorAll(
                'shreddit-comment[isloadmore], button[aria-label*="more comments"], button[aria-label*="More replies"]'
            ) || [];

            if (moreButtons.length > 0) {
                log(`Found ${moreButtons.length} "more" buttons, clicking...`);
                for (const button of moreButtons) {
                    try {
                        button.click();
                        await new Promise((resolve) => setTimeout(resolve, 300));
                    } catch (clickError) {
                        warn('Failed to click more button:', clickError);
                    }
                }
            }

            await humanLikeScrollToBottom();
            await new Promise((resolve) => setTimeout(resolve, DEFAULT_LOAD_TIMEOUT));

            const currentComments = getCommentElements(commentTree);
            currentComments.forEach(cacheCommentMarkdown);

            const totalSeen = state.commentCache.size;
            log(`Visible: ${currentComments.length}, Total cached: ${totalSeen}`);

            if (totalSeen > maxCommentsSeen) {
                maxCommentsSeen = totalSeen;
                stagnantCycles = 0;
            } else {
                stagnantCycles += 1;
                if (stagnantCycles >= 3) {
                    log(`No new comments for ${stagnantCycles} cycles, stopping.`);
                    break;
                }
            }
        }

        await expandCollapsedComments();
        await expandNestedReplies();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        getCommentElements(commentTree).forEach(cacheCommentMarkdown);
        await smoothScrollTo(0, 400);
        log(`Finished loading. Total unique comments cached: ${state.commentCache.size}`);
    }

    async function buildCommentsMarkdown(title, filterFn) {
        const orderedComments = getOrderedCommentEntries(filterFn);
        let markdown = `## ${title} (${orderedComments.length})\n\n`;

        for (let index = 0; index < orderedComments.length; index++) {
            markdown += orderedComments[index].markdown;
            if (index % 10 === 0) {
                await yieldToBrowser();
            }
        }

        return markdown;
    }

    async function getAllCommentsMarkdown() {
        return buildCommentsMarkdown('Comments', () => true);
    }

    async function getSelectedCommentsMarkdown() {
        return buildCommentsMarkdown('Selected Comments', (commentId) => state.selectedComments.has(commentId));
    }

    function updateDownloadButtonCount() {
        const button = document.getElementById('downloadSelectedCommentsButton');
        if (!button) {
            return;
        }

        button.innerText = `Download Selected (${state.selectedComments.size})`;
        button.disabled = state.selectedComments.size === 0;
    }

    function addSelectButton(commentEl) {
        if (commentEl.dataset.redHasSelectButton === '1' || commentEl.hasAttribute('isloadmore')) {
            return;
        }

        const commentId = __getCommentId(commentEl);
        if (!commentId) {
            warn('Could not find ID for comment, skipping');
            return;
        }

        cacheCommentMarkdown(commentEl);

        const selectButton = document.createElement('button');
        selectButton.className = 'select-comment-button';
        selectButton.innerText = state.selectedComments.has(commentId) ? 'Deselect' : 'Select';
        selectButton.classList.toggle('selected', state.selectedComments.has(commentId));
        commentEl.classList.toggle('comment-selected', state.selectedComments.has(commentId));

        selectButton.addEventListener('click', (event) => {
            event.stopPropagation();

            if (state.selectedComments.has(commentId)) {
                state.selectedComments.delete(commentId);
                selectButton.innerText = 'Select';
                selectButton.classList.remove('selected');
                commentEl.classList.remove('comment-selected');
                log(`Deselected: ${commentId}`);
            } else {
                state.selectedComments.add(commentId);
                selectButton.innerText = 'Deselect';
                selectButton.classList.add('selected');
                commentEl.classList.add('comment-selected');
                log(`Selected: ${commentId}`);
            }

            updateDownloadButtonCount();
        });

        let inserted = false;
        if (commentEl.shadowRoot?.querySelector('slot[name="header"]')) {
            const wrapper = document.createElement('div');
            wrapper.slot = 'header';
            wrapper.dataset.redSlotWrapper = '1';
            wrapper.style.display = 'inline-flex';
            wrapper.style.alignItems = 'center';
            wrapper.style.gap = '6px';
            wrapper.appendChild(selectButton);
            commentEl.appendChild(wrapper);
            inserted = true;
        }

        if (!inserted) {
            commentEl.appendChild(selectButton);
        }

        commentEl.dataset.redHasSelectButton = '1';
    }

    function addSelectButtonsToAllComments() {
        const commentElements = getCommentElements();
        log(`Adding select buttons to ${commentElements.length} comments...`);
        commentElements.forEach(addSelectButton);
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
            log('Starting full export...');

            try {
                await loadAllComments();
                addSelectButtonsToAllComments();

                button.innerText = 'Generating Markdown...';
                const markdown = getPostInfo() + await getAllCommentsMarkdown();
                const postTitle = document.querySelector('shreddit-post')?.getAttribute('post-title') || 'reddit_post';
                const filename = `${sanitizeFilename(postTitle)}_${formatDownloadDateTime()}_all.md`;
                downloadMarkdownFile(filename, markdown);

                button.innerText = 'Download complete!';
                log('Full export complete.');
            } catch (downloadError) {
                error('Error during full export:', downloadError);
                button.innerText = 'Download failed!';
            } finally {
                window.setTimeout(() => {
                    button.innerText = originalText;
                    button.disabled = false;
                }, 1000);
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
            if (state.selectedComments.size === 0) {
                warn('Please select at least one comment.');
                return;
            }

            const originalText = button.innerText;
            button.innerText = 'Generating Markdown...';
            button.disabled = true;

            try {
                const markdown = getPostInfo() + await getSelectedCommentsMarkdown();
                const postTitle = document.querySelector('shreddit-post')?.getAttribute('post-title') || 'reddit_post';
                const filename = `${sanitizeFilename(postTitle)}_${formatDownloadDateTime()}_selected.md`;
                downloadMarkdownFile(filename, markdown);

                button.innerText = 'Download complete!';
                log('Selected export complete.');
            } catch (downloadError) {
                error('Error during selected export:', downloadError);
                button.innerText = 'Download failed!';
            } finally {
                window.setTimeout(() => {
                    button.innerText = originalText;
                    button.disabled = state.selectedComments.size === 0;
                }, 1000);
            }
        });

        (__redEnsurePanel().querySelector('#red-btns') || document.body).appendChild(button);
        updateDownloadButtonCount();
    }

    function disconnectCommentObserver() {
        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }
    }

    function connectCommentObserver() {
        disconnectCommentObserver();

        const commentTree = getCommentTree();
        if (!commentTree) {
            warn('Comment tree not found; skipping observer setup.');
            return;
        }

        state.observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes || []) {
                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        continue;
                    }

                    if (node.tagName === 'SHREDDIT-COMMENT' && !node.hasAttribute('isloadmore')) {
                        state.pendingObserverComments.add(node);
                    } else if (node.querySelectorAll) {
                        node.querySelectorAll('shreddit-comment:not([isloadmore])').forEach((commentEl) => {
                            state.pendingObserverComments.add(commentEl);
                        });
                    }
                }
            }

            if (!state.observerScheduled && state.pendingObserverComments.size > 0) {
                state.observerScheduled = true;
                requestAnimationFrame(() => {
                    state.observerScheduled = false;
                    state.pendingObserverComments.forEach((commentEl) => addSelectButton(commentEl));
                    state.pendingObserverComments.clear();
                    updateDownloadButtonCount();
                });
            }
        });

        state.observer.observe(commentTree, { childList: true, subtree: true });
        log('Observing dynamically loaded comments.');
    }

    function resetPageState() {
        disconnectCommentObserver();
        state.selectedComments.clear();
        state.commentCache.clear();
        state.pendingObserverComments.clear();
        state.observerScheduled = false;
        clearCommentSelectionUi();
        resetPanelContent();
    }

    function teardownForNonPostPage() {
        resetPageState();
        destroyPanel();
        state.activeUrl = window.location.href;
    }

    async function initializeForCurrentPage(reason = 'initial load') {
        const initToken = ++state.initToken;

        if (!matchesRedditPostUrl()) {
            teardownForNonPostPage();
            return;
        }

        __redEnsurePanel();
        resetPageState();

        try {
            await waitForElement('shreddit-post');
        } catch (initError) {
            warn('This page does not appear to be a Reddit post page with the new UI.', initError);
            return;
        }

        if (initToken !== state.initToken) {
            return;
        }

        state.activeUrl = window.location.href;
        addDownloadAllButton();
        addDownloadSelectedButton();
        addSelectButtonsToAllComments();
        connectCommentObserver();
        log(`Initialized for ${reason}.`);
    }

    function scheduleReinitialize(reason) {
        if (state.reinitTimer) {
            clearTimeout(state.reinitTimer);
        }

        state.reinitTimer = window.setTimeout(() => {
            state.reinitTimer = null;
            initializeForCurrentPage(reason).catch((initError) => {
                error('Failed to initialize after navigation:', initError);
            });
        }, NAVIGATION_DEBOUNCE_MS);
    }

    function bindNavigationListeners() {
        if (state.navigationBound) {
            return;
        }
        state.navigationBound = true;

        const handlePotentialNavigation = () => {
            if (window.location.href === state.activeUrl) {
                return;
            }

            if (!matchesRedditPostUrl()) {
                teardownForNonPostPage();
                return;
            }

            scheduleReinitialize('navigation');
        };

        const originalPushState = history.pushState.bind(history);
        const originalReplaceState = history.replaceState.bind(history);

        history.pushState = function (...args) {
            const result = originalPushState(...args);
            handlePotentialNavigation();
            return result;
        };

        history.replaceState = function (...args) {
            const result = originalReplaceState(...args);
            handlePotentialNavigation();
            return result;
        };

        window.addEventListener('popstate', handlePotentialNavigation);
        window.addEventListener('hashchange', handlePotentialNavigation);
    }

    bindNavigationListeners();
    initializeForCurrentPage().catch((initError) => {
        error('Failed to initialize script:', initError);
    });
})();
