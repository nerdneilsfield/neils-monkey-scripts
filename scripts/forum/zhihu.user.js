// ==UserScript==
// @name         知乎问题回答批量/选择性导出为 Markdown
// @namespace    https://github.com/nerdneilsfield
// @version      0.9.0
// @description  在知乎问题页提供下载全部回答或选择部分回答导出为 Markdown 的功能
// @author       Qi Deng
// @license      LGPL-3.0
// @match        https://www.zhihu.com/question/*
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/lib/turndown.umd.js#sha256=bNU+0rwWe4WVADj+kwuhXm7nhfx2/c/hbaHk979TOpw=
// @homepageURL  https://github.com/nerdneilsfield/neils-monkey-scripts
// @supportURL   https://github.com/nerdneilsfield/neils-monkey-scripts/issues
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/forum/zhihu.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/forum/zhihu.user.js
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration / Selector Inventory ---

    const LIMITS = {
        answerLoadWaitTimeout: 1800,
        commentPanelWaitTimeout: 1200,
        commentOpenWaitTimeout: 600,
        waitPollInterval: 120,
        stablePollLimit: 3,
        retryScrollBottomTimes: 6,
        maxNestedReplyThreadsPerAnswer: 80
    };

    const LABELS = {
        anonymousUser: '匿名用户',
        anonymousAuthor: 'Anonymous',
        defaultQuestionTitle: '知乎问题',
        defaultLogTitle: '知乎日志',
        noTitle: 'No Title',
        stopErrorMessage: '__ZUD_STOP__'
    };

    // Selector inventory:
    // - answer loading
    // - comment trigger discovery
    // - full comment roots
    // - reply thread roots
    // - metadata extraction
    // Semantic selectors stay primary; hashed class fallbacks stay secondary.
    const SELECTORS = {
        questionTitle: '.QuestionHeader-title',
        questionDescription: '.QuestionRichText .RichText.ztext',
        questionTopics: '.QuestionHeader-topics .Tag-content a',
        questionAuthor: '.QuestionAuthor .AuthorInfo-name a',
        questionFollowerCount: '.QuestionFollowStatus .NumberBoard-item:nth-child(1) .NumberBoard-itemValue',
        questionViewCount: '.QuestionFollowStatus .NumberBoard-item:nth-child(2) .NumberBoard-itemValue',
        answerItem: '.AnswerItem',
        answerMeta: '.ContentItem-meta',
        answerAuthorLink: '.AuthorInfo-name a',
        answerContent: '.RichText.ztext',
        answerListHeader: '.List-headerText',
        answerListHeaderCount: '.List-headerText span',
        answerExpandButtons: 'button.ContentItem-expandButton, .ContentItem-rightButton.ContentItem-expandButton',
        questionMoreButton: '.QuestionRichText-more',
        collapsedContentButtons: '.RichContent-collapsedText.Button--plain',
        globalCommentTriggerCandidates: '.css-vurnku, button, [role="button"], div, span',
        exactViewAllTrigger: '.css-vurnku',
        globalCommentRootCandidates: '.css-tpyajk, [role="dialog"] .Modal-content, .Modal-content, [role="dialog"], .css-u76jt1, .css-840pn3, .css-18ld3w0',
        scopedCommentRootCandidates: [
            '.css-tpyajk',
            '.css-u76jt1',
            '.css-840pn3',
            '.css-18ld3w0',
            '[role="dialog"] .Modal-content',
            '.Modal-content',
            '[role="dialog"]'
        ],
        commentScrollCandidates: '.css-840pn3, .css-34podr, [class*="scroll"]',
        commentListCandidates: '.Comments-container, .CommentsV2, .CommentsV2-list, .CommentListV2, [class*="Comments"]',
        commentItems: '[data-id], .CommentItem',
        commentModalClose: '[role="dialog"] button[aria-label="关闭"], button[aria-label="关闭"], button:has(.Zi--Close)',
        replyThreadRootCandidates: '.css-tpyajk, .Modal-content, [role="dialog"]',
        replyThreadItems: '.css-34podr [data-id], .css-34podr .CommentItem',
        replyNestedContainer: '.css-16zdamy',
        commentUserLinks: '.UserLink, a[href*="/people/"], a[class*="Link"]'
    };

    const ANSWER_LOAD_WAIT_TIMEOUT = LIMITS.answerLoadWaitTimeout;
    const COMMENT_PANEL_WAIT_TIMEOUT = LIMITS.commentPanelWaitTimeout;
    const COMMENT_OPEN_WAIT_TIMEOUT = LIMITS.commentOpenWaitTimeout;
    const WAIT_POLL_INTERVAL = LIMITS.waitPollInterval;
    const STABLE_POLL_LIMIT = LIMITS.stablePollLimit;
    const RETRY_SCROLL_BOTTOM_TIMES = LIMITS.retryScrollBottomTimes;
    const MAX_NESTED_REPLY_THREADS_PER_ANSWER = LIMITS.maxNestedReplyThreadsPerAnswer;
    const STOP_ERROR_MESSAGE = LABELS.stopErrorMessage;
    const __zudRunState = {
        requested: false,
        running: false,
        label: ''
    };

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

    // --- State ---
    const selectedAnswers = new Set();

    // --- Panel / UI ---
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
#zudPanel .zud-stop{padding:5px 10px; border-radius:8px; border:1px solid #d0d7de;
  background:#fff5f5; color:#b42318; cursor:pointer; font-size:12px; transition:all 0.2s;}
#zudPanel .zud-toggle:hover, #zudPanel .zud-clear:hover{background:#f3f4f6; border-color:#8c96a8;}
#zudPanel .zud-stop:hover:not(:disabled){background:#ffe4e4; border-color:#f04438;}
#zudPanel .zud-stop:disabled{opacity:0.5; cursor:not-allowed;}
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
#zud-logwrap .log-head{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;}
#zud-logwrap .log-title{color:#565a76; font-weight:500; font-size:12px;}
#zud-logwrap .log-actions{display:flex; gap:6px;}
#zudPanel .zud-logbtn{padding:4px 8px; border-radius:8px; border:1px solid #d0d7de;
  background:#ffffff; color:#565a76; cursor:pointer; font-size:11px; transition:all 0.2s;}
#zudPanel .zud-logbtn:hover{background:#f3f4f6; border-color:#8c96a8;}
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
                  <button class="zud-stop" id="zudStop" disabled>停止</button>
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
                  <div class="log-head">
                    <div class="log-title">运行日志</div>
                    <div class="log-actions">
                      <button id="zudCopyLog" class="zud-logbtn">拷贝</button>
                      <button id="zudExportLog" class="zud-logbtn">导出</button>
                    </div>
                  </div>
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

            panel.querySelector('#zudStop').addEventListener('click', () => {
                __requestStop();
            });

            panel.querySelector('#zudCopyLog').addEventListener('click', async () => {
                const text = __getLogText();
                try {
                    if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(text);
                        __trace('log', 'copied', { lines: text ? text.split('\n').length : 0 });
                    } else {
                        throw new Error('clipboard-unavailable');
                    }
                } catch (error) {
                    console.warn('Failed to copy logs:', error);
                }
            });

            panel.querySelector('#zudExportLog').addEventListener('click', () => {
                const text = __getLogText();
                const title = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.defaultLogTitle;
                const filename = `${sanitizeFilename(title)}_${formatDownloadDateTime()}.log`;
                __downloadTextFile(filename, text, 'text/plain;charset=utf-8');
                __trace('log', 'exported', { filename });
            });

            // Get actual answer count and set slider max
            let headerText = document.querySelector(SELECTORS.answerListHeader)?.innerText || '';
            headerText = headerText.replace(',', '');
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
                panel.querySelectorAll('button, input').forEach(el => {
                    if (el.id === 'zudStop') {
                        el.disabled = !flag;
                    } else {
                        el.disabled = flag;
                    }
                });
                __updateStopButton();
            };

            panel.querySelector('#zudLoadN').addEventListener('click', async () => {
                const n = parseInt(input.value, 10) || 50;
                __beginOperation(`load-n:${n}`);
                setBusy(true);
                try {
                    await loadAtLeastNAnswers(n);
                    __endOperation('done');
                } catch (error) {
                    if (__isStopError(error)) {
                        __endOperation('stopped');
                    } else {
                        __endOperation('error');
                        throw error;
                    }
                } finally {
                    setBusy(false);
                }
            });

            panel.querySelector('#zudTopN').addEventListener('click', async () => {
                const n = parseInt(input.value, 10) || 50;
                __beginOperation(`top-n:${n}`);
                setBusy(true);
                try {
                    await loadAtLeastNAnswers(n);
                    const questionMd = getQuestionInfo();
                    const answersMd = await getTopNAnswersMarkdown(n);
                    const fullMd = questionMd + answersMd;
                    const title = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.defaultQuestionTitle;
                    const filename = `${sanitizeFilename(title)}_${formatDownloadDateTime()}_top${n}.md`;
                    downloadMarkdownFile(filename, fullMd);
                    __endOperation('done');
                } catch (error) {
                    if (__isStopError(error)) {
                        __endOperation('stopped');
                    } else {
                        __endOperation('error');
                        throw error;
                    }
                } finally {
                    setBusy(false);
                }
            });

            panel.querySelector('#zudTopNC').addEventListener('click', async () => {
                const n = parseInt(input.value, 10) || 30;
                __beginOperation(`top-n-comments:${n}`);
                setBusy(true);
                try {
                    await loadAtLeastNAnswers(n);
                    const questionMd = getQuestionInfo();
                    const answersMd = await getTopNAnswersMarkdownWithComments(n);
                    const fullMd = questionMd + answersMd;
                    const title = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.defaultQuestionTitle;
                    const filename = `${sanitizeFilename(title)}_${formatDownloadDateTime()}_top${n}_with_comments.md`;
                    downloadMarkdownFile(filename, fullMd);
                    __endOperation('done');
                } catch (error) {
                    if (__isStopError(error)) {
                        __endOperation('stopped');
                    } else {
                        __endOperation('error');
                        throw error;
                    }
                } finally {
                    setBusy(false);
                }
            });
        }
        return panel;
    }

    // --- Logging / Control ---

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

    // --- Shared Utilities ---
    function __parseZhihuCount(text) {
        const s = (text || '').toString().trim().replace(/\s+/g, '');
        const mWan = s.match(/([\d.]+)万/i);
        if (mWan) return String(Math.round(parseFloat(mWan[1]) * 10000));
        const mk = s.match(/([\d.]+)k/i);
        if (mk) return String(Math.round(parseFloat(mk[1]) * 1000));
        const m = s.match(/[\d,]+/);
        return m ? m[0].replace(/,/g, '') : '0';
    }

    function __formatTraceMessage(scope, stage, details = {}) {
        const suffix = Object.entries(details)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        return suffix ? `[${scope}] ${stage} ${suffix}` : `[${scope}] ${stage}`;
    }

    function __trace(scope, stage, details = {}) {
        console.log(__formatTraceMessage(scope, stage, details));
    }

    function __createStopError() {
        const error = new Error(STOP_ERROR_MESSAGE);
        error.name = 'ZudStopError';
        return error;
    }

    function __isStopError(error) {
        return error?.name === 'ZudStopError' || error?.message === STOP_ERROR_MESSAGE;
    }

    function __updateStopButton() {
        const button = document.getElementById('zudStop');
        if (!button) return;
        button.disabled = !__zudRunState.running;
        button.textContent = __zudRunState.requested ? '停止中...' : '停止';
    }

    function __beginOperation(label) {
        __zudRunState.requested = false;
        __zudRunState.running = true;
        __zudRunState.label = label;
        __trace('control', 'operation-start', { label });
        __updateStopButton();
    }

    function __endOperation(status = 'done') {
        __trace('control', 'operation-end', { label: __zudRunState.label, status });
        __zudRunState.requested = false;
        __zudRunState.running = false;
        __zudRunState.label = '';
        __updateStopButton();
    }

    function __requestStop() {
        __zudRunState.requested = true;
        __trace('control', 'stop-requested', { label: __zudRunState.label || 'manual' });
        __updateStopButton();
    }

    function __resetStopRequest() {
        __zudRunState.requested = false;
        __updateStopButton();
    }

    function __throwIfStopRequested(scope = 'control', stage = 'cancelled') {
        if (!__zudRunState.requested) return;
        __trace(scope, stage, { label: __zudRunState.label });
        throw __createStopError();
    }


    function __getUpvoteCountFromAnswer(answerEl) {
        const voteBtn = answerEl.querySelector('button[aria-label*="赞同"], .VoteButton, .VoteButton--up');
        const raw = voteBtn?.getAttribute('aria-label') || voteBtn?.textContent || '';
        return __parseZhihuCount(raw);
    }

    function __getCommentButtonText(button) {
        return (button?.getAttribute('aria-label') || button?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function __looksLikeCommentButton(button) {
        if (!button) return false;
        const raw = __getCommentButtonText(button);
        if (button.querySelector('.Zi--Comment, [class*="Comment"]')) return true;
        return /评论/.test(raw);
    }

    function __getCommentActionButton(answerEl) {
        if (!answerEl) return null;
        const scopedButtons = answerEl.querySelectorAll('.ContentItem-actions button, .ContentItem-action button, button');
        for (const button of scopedButtons) {
            if (__looksLikeCommentButton(button)) return button;
        }
        return null;
    }

    function __getCommentCountFromAnswer(answerEl) {
        const cbtn = __getCommentActionButton(answerEl);
        const raw = __getCommentButtonText(cbtn);
        return __parseZhihuCount(raw);
    }

    function __getAnswerTimeFromAnswer(answerEl) {
        const timeElement = answerEl.querySelector('time');
        if (timeElement) {
            const publishTime = (timeElement.getAttribute('data-tooltip') || '').replace('发布于 ', '').trim();
            const editText = (timeElement.innerText || timeElement.textContent || '').trim();
            if (editText.includes('编辑于') && publishTime) {
                return `发布: ${publishTime} | ${editText}`;
            }
            return publishTime || editText || '未知时间';
        }

        const fallbackSelectors = [
            '.ContentItem-time a',
            '.ContentItem-time span',
            '.ContentItem-time',
            '[class*="ContentItem-time"] a',
            '[class*="ContentItem-time"] span',
            '[class*="ContentItem-time"]'
        ];

        for (const selector of fallbackSelectors) {
            const el = answerEl.querySelector(selector);
            const text = (el?.getAttribute('data-tooltip') || el?.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) return text.replace('发布于 ', '');
        }

        return '未知时间';
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

    async function humanLikeScrollToBottom() {
        const targetBottom = document.body.scrollHeight;
        await smoothScrollTo(targetBottom + 80, 220);
        await __sleep(80);
        await smoothScrollTo(Math.max(0, document.body.scrollHeight - 240), 180);
        await __sleep(120);
        await smoothScrollTo(document.body.scrollHeight + 80, 180);
        await __sleep(80);
    }

    function smoothScrollTo(targetY, duration = 300) {
        return new Promise(resolve => {
            const startY = window.scrollY;
            const distance = targetY - startY;
            const startTime = performance.now();

            function animate(currentTime) {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);

                // 使用easeInOutQuad缓动函数，更自然
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

    async function humanLikeScrollContainerToBottom(container) {
        const maxScrollY = container.scrollHeight - container.clientHeight;
        if (maxScrollY <= container.scrollTop) return;
        await smoothScrollContainer(container, maxScrollY, 180);
        await __sleep(80);
        await smoothScrollContainer(container, Math.max(0, maxScrollY - 140), 120);
        await __sleep(80);
        await smoothScrollContainer(container, maxScrollY, 120);
    }

    function smoothScrollContainer(container, targetY, duration = 200) {
        return new Promise(resolve => {
            const startY = container.scrollTop;
            const distance = targetY - startY;
            const startTime = performance.now();

            function animate(currentTime) {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);

                const easeProgress = progress < 0.5
                    ? 2 * progress * progress
                    : -1 + (4 - 2 * progress) * progress;

                container.scrollTop = startY + distance * easeProgress;

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    resolve();
                }
            }

            requestAnimationFrame(animate);
        });
    }

    async function yieldToBrowser(ms = 0) {
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            await new Promise(resolve => requestIdleCallback(() => resolve()));
        } else {
            await new Promise(resolve => setTimeout(resolve, ms));
        }
    }

    function __sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function __waitForGrowth(getValue, options = {}) {
        const {
            timeoutMs = ANSWER_LOAD_WAIT_TIMEOUT,
            intervalMs = WAIT_POLL_INTERVAL,
            stablePollLimit = STABLE_POLL_LIMIT
        } = options;

        let baseline = Number(getValue()) || 0;
        let stablePolls = 0;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            if (__zudRunState.requested) {
                return { changed: false, value: Number(getValue()) || 0, cancelled: true };
            }
            await __sleep(intervalMs);

            const nextValue = Number(getValue()) || 0;
            if (nextValue > baseline) {
                return { changed: true, value: nextValue, cancelled: false };
            }

            if (nextValue === baseline) {
                stablePolls++;
                if (stablePolls >= stablePollLimit) {
                    return { changed: false, value: nextValue, cancelled: false };
                }
                continue;
            }

            baseline = nextValue;
            stablePolls = 0;
        }

        return { changed: false, value: Number(getValue()) || 0, cancelled: false };
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
            await __sleep(500);
        }
        return results;
    }

    async function __nudgeAnswerLoading() {
        const answers = document.querySelectorAll('.AnswerItem');
        const last = answers[answers.length - 1];
        const listContainer = document.getElementById('QuestionAnswers-answers');

        if (last?.scrollIntoView) {
            last.scrollIntoView({ block: 'end' });
        }

        await humanLikeScrollToBottom();
        window.scrollBy(0, Math.max(200, Math.floor(window.innerHeight * 0.9)));

        if (listContainer) {
            try {
                listContainer.scrollTop = listContainer.scrollHeight;
            } catch (_) { }
        }

        const moreBtns = [
            'button.ContentItem-more',
            '.QuestionAnswers-answerList .PaginationButton',
            '.PaginationButton',
            'button:has(.Zi--ArrowDown)',
            'button:has(.Zi--ChevronDown)'
        ];

        for (const sel of moreBtns) {
            const buttons = document.querySelectorAll(sel);
            for (const btn of buttons) {
                if (btn && btn.offsetParent !== null) {
                    try { btn.click(); } catch (_) { }
                }
            }
        }

        const expandButtons = document.querySelectorAll('button.ContentItem-expandButton, .ContentItem-rightButton.ContentItem-expandButton');
        for (const button of expandButtons) {
            const text = (button.textContent || '').replace(/\s+/g, ' ').trim();
            if (button.offsetParent !== null && /阅读全文/.test(text)) {
                try { button.click(); } catch (_) { }
            }
        }

        await __sleep(120);
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

    function __downloadTextFile(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function downloadMarkdownFile(filename, content) {
        __downloadTextFile(filename, content, 'text/markdown;charset=utf-8');
    }

    function __getLogText() {
        const el = document.getElementById('zud-log');
        if (!el) return '';
        return Array.from(el.children)
            .map(node => (node.textContent || '').trim())
            .filter(Boolean)
            .join('\n');
    }

    function __escapeTableCell(value) {
        return String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
    }

    function __renderMarkdownTable(rows) {
        let md = `| 字段 | 内容 |\n|---|---|\n`;
        for (const [label, value] of rows) {
            md += `| ${__escapeTableCell(label)} | ${__escapeTableCell(value)} |\n`;
        }
        return md;
    }

    function __renderMetricsTable(rows) {
        let md = `| 指标 | 数值 |\n|---|---|\n`;
        for (const [label, value] of rows) {
            md += `| ${__escapeTableCell(label)} | ${__escapeTableCell(value)} |\n`;
        }
        return md;
    }

    function __renderQuestionMarkdown({
        title,
        url,
        author,
        topics,
        followerCount,
        viewCount,
        answerCount,
        descriptionMd
    }) {
        const rows = [
            ['URL', url],
            ['提问者', author || '匿名用户'],
            ['话题', (topics && topics.length > 0) ? topics.join(' / ') : '无'],
            ['关注 / 浏览 / 回答', `${followerCount} / ${viewCount} / ${answerCount}`]
        ];

        let md = `# ${title}\n\n`;
        md += __renderMarkdownTable(rows) + '\n';
        md += `## 问题描述\n\n`;
        md += (descriptionMd && descriptionMd.trim()) ? `${descriptionMd.trim()}\n\n` : '无\n\n';
        md += `---\n\n`;
        return md;
    }

    function __renderAnswerMarkdown({
        index,
        authorName,
        authorUrl,
        upvoteCount,
        commentCount,
        time,
        contentMd,
        commentsMd = ''
    }) {
        let md = `## 回答 ${index} | ${authorName}\n\n`;
        if (authorUrl && authorUrl !== '#') {
            md += `[作者主页](${authorUrl})\n\n`;
        }
        md += __renderMetricsTable([
            ['赞同', upvoteCount],
            ['评论', commentCount],
            ['时间', time]
        ]) + '\n';
        md += `### 正文\n\n`;
        md += `${(contentMd || '').trim() || '无'}\n\n`;

        const normalizedCommentsMd = commentsMd
            ? commentsMd.replace(/^#### 评论/m, '### 评论').trim()
            : '';
        if (normalizedCommentsMd) {
            md += `${normalizedCommentsMd}\n\n`;
        }

        md += `---\n\n`;
        return md;
    }

    function __collectAnswerExportData(answerEl) {
        const authorEl = answerEl.querySelector(SELECTORS.answerAuthorLink);
        const answerId = __getAnswerId(answerEl);
        const contentHtml = answerEl.querySelector(SELECTORS.answerContent)?.innerHTML || '';

        return {
            answerId,
            authorName: authorEl?.innerText || LABELS.anonymousUser,
            authorUrl: authorEl?.href || '#',
            upvoteCount: __getUpvoteCountFromAnswer(answerEl),
            commentCount: __getCommentCountFromAnswer(answerEl),
            time: __getAnswerTimeFromAnswer(answerEl),
            contentMd: turndownService.turndown(contentHtml)
        };
    }

    async function __focusAnswerForExtraction(answerEl, details = {}) {
        if (!answerEl?.scrollIntoView) return;
        __trace('answer', 'focus', details);
        try {
            answerEl.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (_) {
            try {
                answerEl.scrollIntoView();
            } catch (_) { }
        }
        await __sleep(120);
    }

    async function __buildAnswersMarkdown(answerElements, {
        batchSize = 10,
        includeComments = false,
        shouldInclude = () => true,
        headingBuilder = (count) => `## 回答 (${count})`,
        onMissingComments = () => '',
        onComplete = null
    } = {}) {
        const preparedAnswers = answerElements
            .map(answerEl => ({ answerEl, answerData: __collectAnswerExportData(answerEl) }))
            .filter(({ answerData }) => shouldInclude(answerData));
        const chunks = [];
        let index = 0;
        const exportedAnswerTokens = new Set();

        for (let i = 0; i < preparedAnswers.length; i += batchSize) {
            const batch = preparedAnswers.slice(i, i + batchSize);
            for (const { answerEl, answerData } of batch) {
                index++;
                if (answerData.answerId) {
                    exportedAnswerTokens.add(answerData.answerId);
                }

                await __focusAnswerForExtraction(answerEl, {
                    current: index,
                    total: preparedAnswers.length,
                    answerId: answerData.answerId,
                    author: answerData.authorName,
                    includeComments: includeComments ? 'yes' : 'no'
                });

                let commentsMd = '';
                if (includeComments) {
                    try {
                        if (answerData.answerId) {
                            __trace('answer', 'collect-comments:start', {
                                current: index,
                                total: preparedAnswers.length,
                                answerId: answerData.answerId,
                                author: answerData.authorName,
                                commentCount: answerData.commentCount
                            });
                            const comments = await __fetchCommentsForAnswer(answerData.answerId);
                            __trace('answer', 'collect-comments:done', {
                                current: index,
                                total: preparedAnswers.length,
                                answerId: answerData.answerId,
                                author: answerData.authorName,
                                roots: comments.length,
                                totalComments: __countCommentsDeep(comments)
                            });
                            commentsMd = __commentsBlockMarkdown(comments);
                        } else {
                            commentsMd = onMissingComments(answerData);
                        }
                    } finally {
                        __resetAnswerCommentUi(answerEl);
                    }
                }

                chunks.push(__renderAnswerMarkdown({
                    index,
                    authorName: answerData.authorName,
                    authorUrl: answerData.authorUrl,
                    upvoteCount: answerData.upvoteCount,
                    commentCount: answerData.commentCount,
                    time: answerData.time,
                    contentMd: answerData.contentMd,
                    commentsMd
                }));
            }
            await yieldToBrowser(0);
        }

        if (typeof onComplete === 'function') {
            onComplete({ index, exportedAnswerTokens });
        }

        return `${headingBuilder(index)}\n\n${chunks.join('')}`;
    }

    function getQuestionInfo() {
        const title = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.noTitle;
        const url = window.location.href;
        const descriptionElement = document.querySelector(SELECTORS.questionDescription);
        const descriptionHtml = descriptionElement?.innerHTML || '';
        const descriptionMd = turndownService.turndown(descriptionHtml);
        const topics = Array.from(document.querySelectorAll(SELECTORS.questionTopics)).map(topic => topic.innerText);
        const questionAuthorElement = document.querySelector(SELECTORS.questionAuthor);
        const author = questionAuthorElement?.innerText || LABELS.anonymousAuthor;
        const followerCount = document.querySelector(SELECTORS.questionFollowerCount)?.getAttribute('title') || 'N/A';
        const viewCount = document.querySelector(SELECTORS.questionViewCount)?.getAttribute('title') || 'N/A';
        const answerCount = document.querySelector(SELECTORS.answerListHeaderCount)?.innerText.match(/\d+/)?.[0] || 'N/A';
        return __renderQuestionMarkdown({
            title,
            url,
            author: author !== LABELS.anonymousAuthor ? author : LABELS.anonymousUser,
            topics,
            followerCount,
            viewCount,
            answerCount,
            descriptionMd
        });
    }

    // --- Answer Loading / Export Flow ---

    // Load at least N answers
    async function loadAtLeastNAnswers(targetCount) {
        console.log(`Loading at least ${targetCount} answers...`);
        let lastCount = 0;
        let stagnant = 0;
        const maxAttempts = 200;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            __throwIfStopRequested('answers', 'stop-during-load');
            const answers = document.querySelectorAll(SELECTORS.answerItem);
            const currentCount = answers.length;

            console.log(`Current: ${currentCount}/${targetCount}`);

            if (currentCount >= targetCount) {
                console.log(`Reached target: ${currentCount}/${targetCount}`);
                break;
            }

            // Trigger lazy loading / pagination controls
            await __nudgeAnswerLoading();

            // Wait for new content to load
            const growthResult = await __waitForGrowth(
                () => document.querySelectorAll(SELECTORS.answerItem).length,
                { timeoutMs: ANSWER_LOAD_WAIT_TIMEOUT }
            );
            if (growthResult.cancelled) throw __createStopError();
            const newCount = growthResult.value;
            if (newCount === lastCount) {
                stagnant++;
                if (stagnant >= RETRY_SCROLL_BOTTOM_TIMES) {
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
        await __sleep(200);
    }

    // Get top N answers
    async function getTopNAnswersMarkdown(n) {
        const answerElements = Array.from(document.querySelectorAll(SELECTORS.answerItem)).slice(0, n);
        return __buildAnswersMarkdown(answerElements, {
            batchSize: 1,
            headingBuilder: () => `## 前 ${n} 条回答`
        });
    }

    // Get top N answers with comments
    async function getTopNAnswersMarkdownWithComments(n) {
        const answerElements = Array.from(document.querySelectorAll(SELECTORS.answerItem)).slice(0, n);
        return __buildAnswersMarkdown(answerElements, {
            batchSize: 1,
            includeComments: true,
            headingBuilder: () => `## 前 ${n} 条回答（含评论）`
        });
    }

    // --- Comment Discovery / Extraction ---

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
            __throwIfStopRequested('comments', 'stop-before-open');
            const commentBtn = __getCommentActionButton(answerEl);
            if (!commentBtn) return [];

            const commentCount = __getCommentCountFromAnswer(answerEl);
            const rawCommentText = __getCommentButtonText(commentBtn);
            if (commentCount === '0' && /(^|[^\d])0\s*(条)?评论/.test(rawCommentText)) return [];
            __trace('comments', 'open-inline', { answerId, commentCount });

            const globalTriggerBaseline = __snapshotGlobalCommentTriggers(answerEl);
            const globalBaseline = __snapshotGlobalCommentsRoots(answerEl);

            // 1. 点击评论按钮
            commentBtn.click();
            await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);

            let commentsRoot = await __waitForCommentsModalReady(answerEl, globalBaseline);
            if (!commentsRoot) {
                commentsRoot = await __findFreshFullCommentsRoot(answerEl, globalBaseline);
            }

            if (!commentsRoot) {
                // 2. 没有直接出现完整评论根时，再查"查看全部评论"入口
                const viewAllBtn = await __waitForViewAllCommentsTrigger(answerEl, globalTriggerBaseline);
                if (viewAllBtn) {
                    __trace('comments', 'expand-full-entry', { answerId, trigger: viewAllBtn.textContent?.replace(/\s+/g, ' ').trim() });
                    __clickElement(viewAllBtn);
                    await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);
                    commentsRoot = await __findFullCommentsRoot(answerEl, globalBaseline);
                }
            }

                if (commentsRoot) {
                    __trace('comments', 'full-root-ready', {
                        answerId,
                        rootClass: commentsRoot.className || commentsRoot.id || commentsRoot.tagName,
                        rootItems: commentsRoot.querySelectorAll('[data-id], .CommentItem').length
                    });
                    const scrollContainer = __findCommentScrollContainer(commentsRoot);
                    if (scrollContainer) {
                        const targetCount = __getDisplayedCommentTotal(commentsRoot);
                        let lastHeight = 0;
                        let lastCount = 0;
                        let stablePasses = 0;
                        const maxScrollPasses = Math.max(RETRY_SCROLL_BOTTOM_TIMES * 4, 20);

                        for (let i = 0; i < maxScrollPasses; i++) {
                            // 人性化滑动到底部
                            await humanLikeScrollContainerToBottom(scrollContainer);

                            const growthResult = await __waitForCommentPanelProgress(
                                commentsRoot,
                                scrollContainer,
                                { timeoutMs: COMMENT_PANEL_WAIT_TIMEOUT, stablePollLimit: 3 }
                            );
                            if (growthResult.cancelled) throw __createStopError();
                            __trace('comments', 'scroll-pass', {
                                answerId,
                                pass: i + 1,
                                changed: growthResult.changed,
                                height: growthResult.height,
                                count: growthResult.count,
                                targetCount
                            });
                            if (targetCount > 0 && growthResult.count >= targetCount) break;
                            if (!growthResult.changed
                                && growthResult.height === lastHeight
                                && growthResult.count === lastCount) {
                                stablePasses++;
                                if (stablePasses >= 3) break;
                            } else {
                                stablePasses = 0;
                            }
                            lastHeight = growthResult.height;
                            lastCount = growthResult.count;
                        }

                    const commentsList = __findCommentListContainer(commentsRoot) || commentsRoot;
                    const comments = __extractCommentsFromPopup(commentsList);
                    await __collectNestedReplies(commentsRoot, comments);
                    __trace('comments', 'full-root-extracted', { answerId, roots: comments.length });
                    return comments;
                }
            } else {
                // 3. 没有"查看全部"按钮，从内嵌评论获取
                __trace('comments', 'inline-only', { answerId });
                const embeddedComments = __findCommentListContainer(answerEl);
                if (embeddedComments) {
                    const comments = __extractCommentsFromPopup(embeddedComments);
                    __trace('comments', 'inline-extracted', { answerId, roots: comments.length });
                    return comments;
                }
            }

            return [];
        } catch (e) {
            if (__isStopError(e)) {
                throw e;
            }
            console.warn('Failed to get comments:', e);
            return [];
        } finally {
            __resetAnswerCommentUi(answerEl);
        }
    }

    function __findCommentModalContent() {
        return document.querySelector('[role="dialog"] .Modal-content, .Modal-content, [role="dialog"]');
    }

    function __findViewAllCommentsTrigger(root) {
        if (!root?.querySelectorAll) return null;
        const explicit = root.querySelector(SELECTORS.exactViewAllTrigger);
        if (explicit && /^(点击)?查看全部评论$/.test((explicit.textContent || '').replace(/\s+/g, ' ').trim())) {
            return explicit;
        }
        const candidates = root.querySelectorAll(SELECTORS.globalCommentTriggerCandidates);
        for (const el of candidates) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^(点击)?查看全部评论$/.test(text) || /^查看全部评论$/.test(text)) return el;
        }
        return null;
    }

    function __snapshotGlobalCommentTriggers(answerEl) {
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const candidates = document.querySelectorAll(SELECTORS.globalCommentTriggerCandidates);
        const snapshot = new Set();
        for (const el of candidates) {
            if (!el?.textContent) continue;
            if (el.hidden) continue;
            if (el.closest('[hidden]')) continue;
            if (searchRoot.contains(el)) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^(点击)?查看全部评论$/.test(text) || /^查看全部评论$/.test(text)) {
                snapshot.add(el);
            }
        }
        return snapshot;
    }

    function __findFreshGlobalCommentsTrigger(answerEl, baseline = null) {
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const explicit = document.querySelector(SELECTORS.exactViewAllTrigger);
        if (explicit && !searchRoot.contains(explicit) && !baseline?.has(explicit)) {
            const text = (explicit.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^(点击)?查看全部评论$/.test(text) || /^查看全部评论$/.test(text)) {
                return explicit;
            }
        }
        const candidates = document.querySelectorAll(SELECTORS.globalCommentTriggerCandidates);
        for (const el of candidates) {
            if (!el?.textContent) continue;
            if (el.hidden) continue;
            if (el.closest('[hidden]')) continue;
            if (searchRoot.contains(el)) continue;
            if (baseline?.has(el)) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^(点击)?查看全部评论$/.test(text) || /^查看全部评论$/.test(text)) {
                return el;
            }
        }
        return null;
    }

    function __findSingleVisibleGlobalCommentsTrigger(answerEl) {
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const explicit = document.querySelector(SELECTORS.exactViewAllTrigger);
        if (explicit && !searchRoot.contains(explicit) && !explicit.hidden && !explicit.closest('[hidden]')) {
            const text = (explicit.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^(点击)?查看全部评论$/.test(text) || /^查看全部评论$/.test(text)) {
                return explicit;
            }
        }
        const candidates = Array.from(document.querySelectorAll(SELECTORS.globalCommentTriggerCandidates))
            .filter(el => {
                if (!el?.textContent) return false;
                if (el.hidden) return false;
                if (el.closest('[hidden]')) return false;
                if (searchRoot.contains(el)) return false;
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                return /^(点击)?查看全部评论$/.test(text) || /^查看全部评论$/.test(text);
            });

        return candidates.length === 1 ? candidates[0] : null;
    }

    function __findReplyThreadRoot(root) {
        if (!root?.querySelectorAll) return null;
        const candidates = Array.from(root.querySelectorAll(SELECTORS.replyThreadRootCandidates));
        return candidates.find(el =>
            /评论回复/.test((el.textContent || '').replace(/\s+/g, ' ').trim())
            && !!el.querySelector(SELECTORS.replyNestedContainer)
            && !!el.querySelector(SELECTORS.replyThreadItems)
        ) || null;
    }

    function __getAnswerSearchRoot(answerEl) {
        if (!answerEl?.parentElement) return answerEl;
        let node = answerEl;
        let best = answerEl;

        while (node.parentElement) {
            const parent = node.parentElement;
            const answerCount = parent.querySelectorAll(SELECTORS.answerItem).length;
            if (answerCount > 1) break;
            best = parent;
            node = parent;
        }

        return best;
    }

    function __findBetweenAnswerAndNextAnswer(answerEl, selector) {
        if (!answerEl || !selector) return null;
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const answers = Array.from(document.querySelectorAll(SELECTORS.answerItem));
        const currentIndex = answers.indexOf(answerEl);
        const nextAnswer = currentIndex >= 0 ? answers[currentIndex + 1] : null;
        const candidates = Array.from(document.querySelectorAll(selector));

        return candidates.find(node => {
            if (!node) return false;
            if (searchRoot.contains(node)) return false;
            if (!(searchRoot.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
            if (!nextAnswer) return true;
            return !!(node.compareDocumentPosition(nextAnswer) & Node.DOCUMENT_POSITION_FOLLOWING);
        }) || null;
    }

    function __findBetweenAnswerAndNextAnswer(answerEl, selector) {
        if (!answerEl || !selector) return null;
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const answers = Array.from(document.querySelectorAll(SELECTORS.answerItem));
        const currentIndex = answers.indexOf(answerEl);
        const nextAnswer = currentIndex >= 0 ? answers[currentIndex + 1] : null;
        const candidates = Array.from(document.querySelectorAll(selector));

        return candidates.find(node => {
            if (!node) return false;
            if (searchRoot.contains(node)) return false;
            if (!(searchRoot.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
            if (!nextAnswer) return true;
            return !!(node.compareDocumentPosition(nextAnswer) & Node.DOCUMENT_POSITION_FOLLOWING);
        }) || null;
    }

    function __snapshotGlobalCommentsRoots(answerEl) {
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const candidates = document.querySelectorAll(SELECTORS.globalCommentRootCandidates);
        const snapshot = new Map();
        const seen = new Set();
        for (const el of candidates) {
            const normalized = __normalizeCommentsRoot(el);
            if (!normalized?.querySelector) continue;
            if (normalized.hidden) continue;
            if (normalized.closest('[hidden]')) continue;
            if (searchRoot.contains(normalized)) continue;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            const count = normalized.querySelectorAll(SELECTORS.commentItems).length;
            if (count > 0) snapshot.set(normalized, count);
        }
        return snapshot;
    }

    function __findFreshGlobalCommentsRoot(answerEl, baseline = null) {
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const candidates = document.querySelectorAll(SELECTORS.globalCommentRootCandidates);
        let best = null;
        let bestCount = 0;
        let bestRank = -1;
        const seen = new Set();
        for (const el of candidates) {
            const normalized = __normalizeCommentsRoot(el);
            if (!normalized?.querySelector) continue;
            if (normalized.hidden) continue;
            if (normalized.closest('[hidden]')) continue;
            if (searchRoot.contains(normalized)) continue;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            const count = normalized.querySelectorAll(SELECTORS.commentItems).length;
            if (count === 0) continue;
            const previous = baseline?.get(normalized) || 0;
            const rank = __commentsRootRank(normalized);
            if (count > previous && (count > bestCount || (count === bestCount && rank > bestRank))) {
                best = normalized;
                bestCount = count;
                bestRank = rank;
            }
        }
        return best;
    }

    function __commentsRootRank(el) {
        if (!el?.matches) return 0;
        if (el.matches('.css-tpyajk')) return 5;
        if (el.matches('.css-u76jt1')) return 4;
        if (el.matches('.css-840pn3')) return 3;
        if (el.matches('.css-18ld3w0')) return 2;
        if (el.matches('[role="dialog"] .Modal-content, .Modal-content, [role="dialog"]')) return 1;
        return 0;
    }

    function __normalizeCommentsRoot(el) {
        if (!el?.querySelector) return el || null;
        return el.matches('.css-tpyajk') ? el : (el.querySelector('.css-tpyajk') || el);
    }

    function __findAnswerScopedCommentsRoot(root) {
        if (!root?.querySelector) return null;
        for (const selector of SELECTORS.scopedCommentRootCandidates) {
            const el = root.querySelector(selector);
            if (el && el.querySelector(SELECTORS.commentItems)) return el;
        }

        return root.querySelector(SELECTORS.commentItems) ? root : null;
    }

    function __findExpandedCommentsRoot(root) {
        return __findAnswerScopedCommentsRoot(root);
    }

    function __collapseAnswerComments(answerEl) {
        if (!answerEl?.querySelectorAll) return;
        const buttons = answerEl.querySelectorAll('button');
        for (const button of buttons) {
            const text = (button.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^收起评论$/.test(text)) {
                __clickElement(button);
                return;
            }
        }
    }

    function __resetAnswerCommentUi(answerEl) {
        __collapseAnswerComments(answerEl);
        closeCommentModal();
    }

    function __pickExpandedCommentsRoot(answerEl) {
        return __findAnswerScopedCommentsRoot(answerEl);
    }

    function __isCompleteCommentsRoot(root) {
        if (!root?.querySelector) return false;
        const itemCount = root.querySelectorAll(SELECTORS.commentItems).length;
        if (itemCount === 0) return false;
        const pendingTrigger = __findViewAllCommentsTrigger(root);
        return !pendingTrigger;
    }

    async function __findFreshFullCommentsRoot(answerEl, globalBaseline = null) {
        const searchRoot = __getAnswerSearchRoot(answerEl);
        const initialInlineRoot = __findAnswerScopedCommentsRoot(searchRoot);

        for (let i = 0; i < RETRY_SCROLL_BOTTOM_TIMES; i++) {
            const picked = __findAnswerScopedCommentsRoot(searchRoot);
            const freshGlobal = __findFreshGlobalCommentsRoot(answerEl, globalBaseline);

            if (picked && picked !== initialInlineRoot && __isCompleteCommentsRoot(picked)) return picked;
            if (freshGlobal && __isCompleteCommentsRoot(freshGlobal)) return freshGlobal;

            __trace('comments', 'wait-full-root', {
                pass: i + 1,
                inlineItems: initialInlineRoot?.querySelectorAll?.('[data-id], .CommentItem')?.length || 0,
                currentItems: picked?.querySelectorAll?.('[data-id], .CommentItem')?.length || 0,
                freshGlobalItems: freshGlobal?.querySelectorAll?.('[data-id], .CommentItem')?.length || 0
            });
            await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);
        }

        return null;
    }

    async function __waitForCommentsModalReady(answerEl, globalBaseline = null) {
        for (let i = 0; i < RETRY_SCROLL_BOTTOM_TIMES; i++) {
            const betweenRoot = __findBetweenAnswerAndNextAnswer(answerEl, '.Modal-content.css-1svde17, .css-tpyajk');
            const freshGlobal = __findFreshGlobalCommentsRoot(answerEl, globalBaseline);
            const candidate = betweenRoot || freshGlobal;
            if (candidate) {
                return candidate.matches('.css-tpyajk') ? candidate : (candidate.querySelector('.css-tpyajk') || candidate);
            }
            await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);
        }
        return null;
    }

    async function __waitForViewAllCommentsTrigger(answerEl, globalBaseline = null) {
        const searchRoot = __getAnswerSearchRoot(answerEl);
        for (let i = 0; i < RETRY_SCROLL_BOTTOM_TIMES; i++) {
            const trigger = __findViewAllCommentsTrigger(searchRoot);
            if (trigger) return trigger;
            const betweenTrigger = __findBetweenAnswerAndNextAnswer(answerEl, '.css-vurnku, button, [role="button"], div, span');
            if (betweenTrigger) {
                const text = (betweenTrigger.textContent || '').replace(/\s+/g, ' ').trim();
                if (/^(点击)?查看全部评论$/.test(text) || /^查看全部评论$/.test(text)) return betweenTrigger;
            }
            const freshGlobal = __findFreshGlobalCommentsTrigger(answerEl, globalBaseline);
            if (freshGlobal) return freshGlobal;
            const singleVisible = __findSingleVisibleGlobalCommentsTrigger(answerEl);
            if (singleVisible) return singleVisible;
            await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);
        }
        return null;
    }

    async function __findFullCommentsRoot(answerEl, globalBaseline = null) {
        const fresh = await __findFreshFullCommentsRoot(answerEl, globalBaseline);
        if (fresh) return fresh;
        const fallback = __findAnswerScopedCommentsRoot(__getAnswerSearchRoot(answerEl));
        return __isCompleteCommentsRoot(fallback) ? fallback : null;
    }

    function __clickElement(el) {
        if (!el) return;
        try { el.click(); } catch (_) { }
        try {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch (_) { }
    }

    function __findCommentScrollContainer(root) {
        if (!root?.querySelectorAll) return null;
        const explicitCandidates = [root, ...root.querySelectorAll(SELECTORS.commentScrollCandidates)];
        let best = null;
        let bestScrollableDelta = -1;
        for (const el of explicitCandidates) {
            if (!el) continue;
            const delta = (el.scrollHeight || 0) - (el.clientHeight || 0);
            if (delta > bestScrollableDelta) {
                best = el;
                bestScrollableDelta = delta;
            }
        }
        if (best && bestScrollableDelta > 24) return best;

        const candidates = [root, ...root.querySelectorAll('*')];
        for (const el of candidates) {
            if (el.scrollHeight > el.clientHeight + 24) return el;
        }
        return root;
    }

    function __findCommentListContainer(root) {
        if (!root?.querySelector) return null;

        const explicit = root.querySelector(SELECTORS.commentListCandidates);
        if (explicit) return explicit;

        const firstComment = root.querySelector(SELECTORS.commentItems);
        return firstComment?.parentElement || null;
    }

    function __getDisplayedCommentTotal(root) {
        const text = (root?.textContent || '').replace(/\s+/g, ' ');
        const match = text.match(/(\d+)\s*条评论/);
        return match ? Number(match[1]) : 0;
    }

    async function __waitForCommentPanelProgress(commentsRoot, scrollContainer, options = {}) {
        const {
            timeoutMs = COMMENT_PANEL_WAIT_TIMEOUT,
            intervalMs = WAIT_POLL_INTERVAL,
            stablePollLimit = 2
        } = options;

        let lastHeight = scrollContainer.scrollHeight;
        let lastCount = commentsRoot.querySelectorAll(SELECTORS.commentItems).length;
        let stablePolls = 0;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            if (__zudRunState.requested) {
                return { changed: false, height: lastHeight, count: lastCount, cancelled: true };
            }
            await __sleep(intervalMs);

            const nextHeight = scrollContainer.scrollHeight;
            const nextCount = commentsRoot.querySelectorAll(SELECTORS.commentItems).length;
            const changed = nextHeight > lastHeight || nextCount > lastCount;

            if (changed) {
                return { changed: true, height: nextHeight, count: nextCount, cancelled: false };
            }

            stablePolls++;
            if (stablePolls >= stablePollLimit) {
                return { changed: false, height: nextHeight, count: nextCount, cancelled: false };
            }
        }

        return {
            changed: false,
            height: scrollContainer.scrollHeight,
            count: commentsRoot.querySelectorAll(SELECTORS.commentItems).length,
            cancelled: false
        };
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

    function __getCommentUserTexts(item) {
        const links = Array.from(item.querySelectorAll(SELECTORS.commentUserLinks));
        return links
            .map(link => (link.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    function __getCommentTimeFromItem(item) {
        const semanticTime = item.querySelector('time, [datetime]');
        const semanticText = (semanticTime?.textContent || semanticTime?.getAttribute?.('datetime') || '').trim();
        if (semanticText) return semanticText;

        const footer = item.querySelector('.css-x1xlu5, [class*="CommentMeta"], [class*="meta"], [class*="Footer"]');
        if (footer) {
            const spanTexts = Array.from(footer.querySelectorAll('span'))
                .map(span => (span.textContent || '').replace(/\s+/g, ' ').trim())
                .filter(text => text && text !== '·');
            if (spanTexts.length > 0) return spanTexts[0];
        }

        return '';
    }

    function __extractSingleCommentItem(item) {
        if (!item) return null;

        const userTexts = __getCommentUserTexts(item);
        const author = userTexts[0] || item.querySelector('img[alt]')?.getAttribute('alt') || '匿名用户';
        const contentNode = item.querySelector('.CommentContent, [class*="CommentContent"], .RichText, .ztext');
        const content = contentNode?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
        if (!content) return null;

        const likeBtn = Array.from(item.querySelectorAll('button, .Button'))
            .find(el => /(赞|喜欢|\d)/.test((el.textContent || '').trim()));
        const likeCount = __parseZhihuCount(likeBtn?.textContent || '');
        const time = __getCommentTimeFromItem(item);
        const hasReplyArrow = !!item.querySelector('.css-gx7lzm, [class*="ArrowRight"]');
        const replyTo = hasReplyArrow ? (userTexts[1] || null) : null;

        const comment = {
            author: { name: author },
            content,
            like_count: likeCount,
            created_time: time,
            reply_to: replyTo
        };
        Object.defineProperty(comment, '__commentId', {
            value: item.getAttribute('data-id') || '',
            enumerable: false
        });
        return comment;
    }

    function __extractCommentsFromPopup(commentsList) {
        const comments = [];
        if (!commentsList) return comments;

        const nestedReplyContainer = commentsList.querySelector('.css-16zdamy');
        if (nestedReplyContainer) {
            const rootItem = commentsList.querySelector('.css-34podr [data-id], .css-34podr .CommentItem');
            const rootComment = __extractSingleCommentItem(rootItem);
            if (rootComment) {
                rootComment.child_comments_full = Array.from(nestedReplyContainer.children)
                    .filter(node => node.nodeType === Node.ELEMENT_NODE && node.matches('[data-id], .CommentItem'))
                    .map(__extractSingleCommentItem)
                    .filter(Boolean);
                return [rootComment];
            }
        }

        const commentItems = commentsList.querySelectorAll(SELECTORS.commentItems);
        commentItems.forEach(item => {
            const comment = __extractSingleCommentItem(item);
            if (comment) comments.push(comment);
        });
        return comments;
    }

    function __isReplyExpansionButton(button) {
        const text = (button?.textContent || '').replace(/\s+/g, ' ').trim();
        return /(查看全部|展开其他).*(条)?回复/.test(text);
    }

    function __getReplyTargetCountFromButton(button) {
        const text = (button?.textContent || '').replace(/\s+/g, ' ').trim();
        const match = text.match(/(\d+)\s*条回复/);
        return match ? Number(match[1]) : 0;
    }

    function __findReplyModalBackControl(root) {
        if (!root?.querySelectorAll) return null;
        const candidates = Array.from(root.querySelectorAll('button, [role="button"], div'));
        return candidates.find(el => {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            return /评论回复/.test(text) && el.querySelector('[class*="ArrowLeft"], .ZDI--ArrowLeftSmall24');
        }) || null;
    }

    async function __collectNestedReplies(containerRoot, rootComments, options = {}) {
        if (!containerRoot || !rootComments?.length) return;
        const {
            maxThreads = MAX_NESTED_REPLY_THREADS_PER_ANSWER
        } = options;

        const rootMap = new Map(
            rootComments
                .filter(comment => comment.__commentId)
                .map(comment => [comment.__commentId, comment])
        );
        if (rootMap.size === 0) return;

        const visitedOwnerIds = new Set();
        let processedThreads = 0;
        let previousButtonCount = -1;

        for (let pass = 0; pass < RETRY_SCROLL_BOTTOM_TIMES; pass++) {
            const replyButtons = Array.from(containerRoot.querySelectorAll('button'))
                .filter(button => __isReplyExpansionButton(button));
            __trace('replies', 'scan-start', {
                roots: rootComments.length,
                buttons: replyButtons.length,
                maxThreads,
                pass: pass + 1
            });

            if (replyButtons.length === previousButtonCount && pass > 0) {
                break;
            }
            previousButtonCount = replyButtons.length;

            for (const button of replyButtons) {
                __throwIfStopRequested('replies', 'stop-during-expand');
                const owner = button.closest('[data-id]');
                const ownerId = owner?.getAttribute('data-id') || '';
                if (!ownerId || !rootMap.has(ownerId)) continue;
                if (visitedOwnerIds.has(ownerId)) {
                    __trace('replies', 'skip-visited', { ownerId });
                    continue;
                }
                if (processedThreads >= maxThreads) {
                    console.warn(`Nested reply expansion capped at ${maxThreads} threads.`);
                    return;
                }
                visitedOwnerIds.add(ownerId);
                processedThreads++;
                __trace('replies', 'expand-thread', {
                    ownerId,
                    thread: processedThreads,
                    label: button.textContent?.replace(/\s+/g, ' ').trim()
                });

                try {
                    __clickElement(button);
                    await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);

                    let nestedRoot = null;
                    for (let i = 0; i < RETRY_SCROLL_BOTTOM_TIMES; i++) {
                        nestedRoot = __findReplyThreadRoot(containerRoot) || __findReplyThreadRoot(document) || __findExpandedCommentsRoot(containerRoot);
                        if (nestedRoot && nestedRoot !== containerRoot) break;
                        await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);
                    }
                    nestedRoot = nestedRoot || __findExpandedCommentsRoot(containerRoot) || containerRoot;
                    const replyTargetCount = __getReplyTargetCountFromButton(button);
                    const nestedReplyContainer = nestedRoot.querySelector('.css-16zdamy');
                    const nestedScrollContainer = __findCommentScrollContainer(nestedRoot);
                    if (replyTargetCount > 0 && nestedReplyContainer && nestedScrollContainer) {
                        let stablePasses = 0;
                        let lastCount = nestedReplyContainer.querySelectorAll('[data-id], .CommentItem').length;
                        const maxReplyPasses = Math.max(RETRY_SCROLL_BOTTOM_TIMES * 4, 20);

                        for (let j = 0; j < maxReplyPasses; j++) {
                            await humanLikeScrollContainerToBottom(nestedScrollContainer);
                            const progress = await __waitForCommentPanelProgress(
                                nestedReplyContainer,
                                nestedScrollContainer,
                                { timeoutMs: COMMENT_PANEL_WAIT_TIMEOUT, stablePollLimit: 3 }
                            );
                            if (progress.cancelled) throw __createStopError();
                            __trace('replies', 'scroll-thread', {
                                ownerId,
                                pass: j + 1,
                                count: progress.count,
                                targetCount: replyTargetCount,
                                changed: progress.changed
                            });
                            if (progress.count >= replyTargetCount) break;
                            if (!progress.changed && progress.count === lastCount) {
                                stablePasses++;
                                if (stablePasses >= 3) break;
                            } else {
                                stablePasses = 0;
                            }
                            lastCount = progress.count;
                        }
                    }
                    const nestedComments = __extractCommentsFromPopup(nestedRoot);
                    if (nestedComments[0]?.child_comments_full?.length) {
                        rootMap.get(ownerId).child_comments_full = nestedComments[0].child_comments_full;
                        __trace('replies', 'expand-thread:done', {
                            ownerId,
                            children: nestedComments[0].child_comments_full.length
                        });
                    }

                    const backControl = __findReplyModalBackControl(nestedRoot) || __findReplyModalBackControl(containerRoot);
                    if (backControl) {
                        __clickElement(backControl);
                        await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);
                    }
                } catch (error) {
                    console.warn('Failed to collect nested replies for comment:', ownerId, error);
                }
            }

            const listContainer = __findCommentScrollContainer(containerRoot);
            if (listContainer) {
                await humanLikeScrollContainerToBottom(listContainer);
                await __sleep(COMMENT_OPEN_WAIT_TIMEOUT);
            }
        }
    }

    function closeCommentModal() {
        const closeBtn = document.querySelector(SELECTORS.commentModalClose);
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

    // --- Markdown Rendering ---

    function __commentToMarkdown(comment, level = 0) {
        const author = comment.author?.name || '匿名用户';
        const content = comment.content || comment.comment?.content || '';
        const likeCount = comment.like_count || comment.vote_count || '0';
        const time = __normalizeCommentTime(comment.created_time);

        let line = `${__mdEscape(author)}`;
        if (comment.reply_to) line += ` -> ${__mdEscape(comment.reply_to)}`;
        if (time) line += ` [${time}]`;
        if (likeCount !== '0') line += ` ${likeCount}赞`;
        return `${line}\n${__mdEscape(content)}`;
    }

    function __normalizeCommentTime(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && Number.isFinite(value)) {
            return __formatUnixTs(value);
        }

        const raw = String(value).trim();
        if (!raw) return '';
        if (/^\d{10}$/.test(raw)) return __formatUnixTs(Number(raw));
        if (/^\d{13}$/.test(raw)) return __formatUnixTs(Math.floor(Number(raw) / 1000));
        const relative = raw.match(/^(今天|昨天|前天)(?:\s+(\d{1,2}:\d{2}))?$/);
        if (relative) {
            const base = new Date();
            base.setHours(0, 0, 0, 0);
            const offset = relative[1] === '今天' ? 0 : relative[1] === '昨天' ? 1 : 2;
            base.setDate(base.getDate() - offset);
            return __formatCalendarDate(base, relative[2] || '');
        }
        const monthDay = raw.match(/^(\d{2})-(\d{2})(?:\s+(\d{1,2}:\d{2}))?$/);
        if (monthDay) {
            const base = new Date();
            const year = base.getFullYear();
            const d = new Date(year, Number(monthDay[1]) - 1, Number(monthDay[2]));
            return __formatCalendarDate(d, monthDay[3] || '');
        }
        return raw;
    }

    function __formatCalendarDate(date, timePart = '') {
        const y = date.getFullYear();
        const M = String(date.getMonth() + 1).padStart(2, '0');
        const D = String(date.getDate()).padStart(2, '0');
        return timePart ? `${y}-${M}-${D} ${timePart}` : `${y}-${M}-${D}`;
    }

    function __buildChildTree(childComments) {
        // 简单返回子评论列表，不构建树结构
        return childComments || [];
    }

    function __countCommentsDeep(roots) {
        if (!roots || roots.length === 0) return 0;
        let total = 0;
        for (const root of roots) {
            total += 1;
            total += __countCommentsDeep(root.child_comments_full || []);
        }
        return total;
    }

    function __renderCommentTree(comment, prefix = '', isLast = true, isRoot = false) {
        const line = __commentToMarkdown(comment).split('\n');
        const marker = isRoot ? '- ' : `${prefix}${isLast ? '\\- ' : '|- '}`;
        const bodyPrefix = isRoot ? '  ' : `${prefix}${isLast ? '   ' : '|  '}`;
        let md = `${marker}${line[0]}\n`;
        if (line[1]) md += `${bodyPrefix}${line[1]}\n`;

        const children = __buildChildTree(comment.child_comments_full || []);
        children.forEach((child, index) => {
            md += __renderCommentTree(child, bodyPrefix, index === children.length - 1, false);
        });
        return md;
    }

    function __commentsBlockMarkdown(roots) {
        if (!roots || roots.length === 0) return '';
        const total = __countCommentsDeep(roots);
        let md = `#### 评论 (${total}，根评论 ${roots.length})\n\n`;
        roots.forEach((rc, index) => {
            md += __renderCommentTree(rc, '', index === roots.length - 1, true);
        });
        md += '\n';
        return md;
    }

    // Expand collapsed content
    async function expandCollapsedContent() {
        console.log("Expanding collapsed content...");
        let expandedCount = 0;
        const questionMoreButton = document.querySelector(SELECTORS.questionMoreButton);
        if (questionMoreButton && questionMoreButton.offsetParent !== null && questionMoreButton.innerText.includes('显示全部')) {
            questionMoreButton.click();
            expandedCount++;
            await __sleep(150);
        }
        const buttons = document.querySelectorAll(SELECTORS.collapsedContentButtons);
        for (const button of buttons) {
            if (button.offsetParent !== null) {
                button.click();
                expandedCount++;
                await __sleep(30);
            }
        }
        console.log(`Expanded ${expandedCount} collapsed sections.`);
        await __sleep(200);
    }

    // Load all answers
    async function loadAllAnswers() {
        const headerSpan = document.querySelector(SELECTORS.answerListHeaderCount);
        let headerText = headerSpan?.innerText || '';
        headerText = headerText.replace(',', '');
        const totalAnswers = parseInt(headerText.match(/\d+/)?.[0]) || 999999;
        let lastCount = 0;
        let stagnant = 0;
        const maxAttempts = 1000;
        const listContainer = document.getElementById('QuestionAnswers-answers');

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            __throwIfStopRequested('answers', 'stop-during-load-all');
            const answers = document.querySelectorAll(SELECTORS.answerItem);
            const now = answers.length;
            if (now >= totalAnswers) {
                console.log(`Reached total answers ${now}/${totalAnswers}.`);
                break;
            }
            await __nudgeAnswerLoading();
            const growthResult = await __waitForGrowth(
                () => document.querySelectorAll(SELECTORS.answerItem).length,
                { timeoutMs: ANSWER_LOAD_WAIT_TIMEOUT }
            );
            if (growthResult.cancelled) throw __createStopError();
            const after = growthResult.value;
            if (after === lastCount) {
                stagnant++;
            } else {
                stagnant = 0;
                lastCount = after;
            }
            if (stagnant >= RETRY_SCROLL_BOTTOM_TIMES) {
                console.log(`No progress after ${stagnant} idle cycles, stopping at ${after}/${totalAnswers}.`);
                break;
            }
        }
        window.scrollTo(0, 0);
        await __sleep(120);
    }

    // Get all answers markdown
    async function getAllAnswersMarkdown(batchSize = 10) {
        const answerElements = Array.from(document.querySelectorAll(SELECTORS.answerItem));
        return __buildAnswersMarkdown(answerElements, {
            batchSize,
            headingBuilder: (count) => `## 全部回答 (${count})`
        });
    }

    // Get all answers with comments
    async function getAllAnswersMarkdownWithComments(batchSize = 8) {
        const answerElements = Array.from(document.querySelectorAll(SELECTORS.answerItem));
        return __buildAnswersMarkdown(answerElements, {
            batchSize,
            includeComments: true,
            headingBuilder: (count) => `## 全部回答 (${count})`,
            onMissingComments: () => '_（未能识别回答 ID，评论跳过）_'
        });
    }

    // Get selected answers markdown
    async function getSelectedAnswersMarkdown(batchSize = 10) {
        const answerElements = Array.from(document.querySelectorAll('.AnswerItem'));
        let exportedAnswerTokens = new Set();
        const fullMd = await __buildAnswersMarkdown(answerElements, {
            batchSize,
            shouldInclude: ({ answerId }) => !!answerId && selectedAnswers.has(answerId),
            headingBuilder: (count) => `## 已选回答 (${count}/${selectedAnswers.size})`,
            onComplete: ({ exportedAnswerTokens: exported }) => {
                exportedAnswerTokens = exported;
            }
        });

        if (exportedAnswerTokens.size !== selectedAnswers.size) {
            console.warn(`Expected to export ${selectedAnswers.size} answers, but found only ${exportedAnswerTokens.size} in the DOM.`);
        }

        return fullMd;
    }

    // Get selected answers with comments
    async function getSelectedAnswersMarkdownWithComments(batchSize = 8) {
        const answerElements = Array.from(document.querySelectorAll('.AnswerItem'));
        return __buildAnswersMarkdown(answerElements, {
            batchSize,
            includeComments: true,
            shouldInclude: ({ answerId }) => !!answerId && selectedAnswers.has(answerId),
            headingBuilder: (count) => `## 已选回答 (${count}/${selectedAnswers.size})`
        });
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

        const answerToken = __getAnswerId(answerElement);
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
        const answerElements = document.querySelectorAll(SELECTORS.answerItem);
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
            __beginOperation('download-all');
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
                const questionTitle = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.defaultQuestionTitle;
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_all.md`;
                downloadMarkdownFile(filename, fullMarkdown);
                button.innerText = '下载完成!';
                console.log("Download all complete!");
                __endOperation('done');
            } catch (error) {
                if (__isStopError(error)) {
                    button.innerText = '已停止!';
                    __endOperation('stopped');
                } else {
                    console.error("An error occurred during download all:", error);
                    button.innerText = '下载失败!';
                    __endOperation('error');
                }
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
            __beginOperation('download-all-comments');
            try {
                await loadAllAnswers();
                button.innerText = '正在展开内容...';
                await expandCollapsedContent();
                button.innerText = '正在抓取评论...';
                const questionMd = getQuestionInfo();
                const answersMd = await getAllAnswersMarkdownWithComments();
                const fullMd = questionMd + answersMd;
                const questionTitle = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.defaultQuestionTitle;
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_all_with_comments.md`;
                downloadMarkdownFile(filename, fullMd);
                button.innerText = '下载完成!';
                __endOperation('done');
            } catch (e) {
                if (__isStopError(e)) {
                    button.innerText = '已停止!';
                    __endOperation('stopped');
                } else {
                    console.error(e);
                    button.innerText = '下载失败!';
                    __endOperation('error');
                }
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
            __beginOperation('download-selected');
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
                const questionTitle = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.defaultQuestionTitle;
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_selected.md`;
                downloadMarkdownFile(filename, fullMarkdown);
                button.innerText = '下载完成!';
                console.log("Download complete!");
                __endOperation('done');
            } catch (error) {
                if (__isStopError(error)) {
                    button.innerText = '已停止!';
                    __endOperation('stopped');
                } else {
                    console.error("An error occurred during selected download:", error);
                    button.innerText = '下载失败!';
                    __endOperation('error');
                }
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
            __beginOperation('download-selected-comments');
            try {
                await expandCollapsedContent();
                button.innerText = '正在抓取评论...';
                const questionMd = getQuestionInfo();
                const answersMd = await getSelectedAnswersMarkdownWithComments();
                const fullMd = questionMd + answersMd;
                const questionTitle = document.querySelector(SELECTORS.questionTitle)?.innerText || LABELS.defaultQuestionTitle;
                const filename = `${sanitizeFilename(questionTitle)}_${formatDownloadDateTime()}_selected_with_comments.md`;
                downloadMarkdownFile(filename, fullMd);
                button.innerText = '下载完成!';
                __endOperation('done');
            } catch (e) {
                if (__isStopError(e)) {
                    button.innerText = '已停止!';
                    __endOperation('stopped');
                } else {
                    console.error(e);
                    button.innerText = '下载失败!';
                    __endOperation('error');
                }
            } finally {
                setTimeout(() => {
                    button.innerText = '下载已选回答（含评论）';
                    button.disabled = false;
                }, 3000);
            }
        });
        (__zudEnsurePanel().querySelector('#zud-btns') || document.body).appendChild(button);
    }

    // --- Observers / Init ---

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
