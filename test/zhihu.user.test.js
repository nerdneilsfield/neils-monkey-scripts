const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const scriptPath = path.join(__dirname, '..', 'scripts', 'forum', 'zhihu.user.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

function loadZhihuTestApi(html = '<!doctype html><html><head></head><body></body></html>') {
    const dom = new JSDOM(html, {
        url: 'https://www.zhihu.com/question/123',
        pretendToBeVisual: true
    });

    const { window } = dom;
    window.scrollTo = () => { };
    window.URL.createObjectURL = () => 'blob:test';
    window.URL.revokeObjectURL = () => { };

    class FakeTurndownService {
        addRule() { }
        turndown(value) {
            return value || '';
        }
    }

    const RealDate = Date;
    class FixedDate extends RealDate {
        constructor(...args) {
            if (args.length === 0) {
                super('2026-03-25T12:00:00+08:00');
            } else {
                super(...args);
            }
        }

        static now() {
            return new RealDate('2026-03-25T12:00:00+08:00').getTime();
        }

        static parse(value) {
            return RealDate.parse(value);
        }

        static UTC(...args) {
            return RealDate.UTC(...args);
        }
    }

    let rafTime = 0;

    const sandbox = {
        window,
        document: window.document,
        console: {
            log() { },
            warn() { },
            error() { }
        },
        MutationObserver: window.MutationObserver,
        Node: window.Node,
        Blob: window.Blob,
        URL: window.URL,
        KeyboardEvent: window.KeyboardEvent,
        XMLHttpRequest: window.XMLHttpRequest,
        navigator: window.navigator,
        performance: window.performance,
        Date: FixedDate,
        requestAnimationFrame: (cb) => {
            rafTime += 16;
            return cb(rafTime);
        },
        cancelAnimationFrame: () => { },
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        setInterval: window.setInterval.bind(window),
        clearInterval: window.clearInterval.bind(window),
        TurndownService: FakeTurndownService
    };

    const instrumentedSource = scriptSource.replace(
        /\}\)\(\);\s*$/,
        `window.__zudTestExports = {
            __getCommentCountFromAnswer,
            __extractCommentsFromPopup,
            __commentToMarkdown,
            __waitForGrowth,
            __getAnswerTimeFromAnswer,
            __nudgeAnswerLoading,
            __normalizeCommentTime,
            __commentsBlockMarkdown,
            __countCommentsDeep,
            __getDisplayedCommentTotal,
            __waitForCommentPanelProgress,
            __findViewAllCommentsTrigger,
            __getAnswerSearchRoot,
            __snapshotGlobalCommentTriggers,
            __findFreshGlobalCommentsTrigger,
            __findSingleVisibleGlobalCommentsTrigger,
            __findBetweenAnswerAndNextAnswer,
            __findReplyThreadRoot,
            __isCompleteCommentsRoot,
            __waitForCommentsModalReady,
            __pickExpandedCommentsRoot,
            __collectNestedReplies,
            __findFullCommentsRoot,
            __findAnswerScopedCommentsRoot,
            __collapseAnswerComments,
            __snapshotGlobalCommentsRoots,
            __findFreshGlobalCommentsRoot,
            __formatTraceMessage,
            __requestStop,
            __resetStopRequest,
            __getLogText,
            __renderQuestionMarkdown,
            __renderAnswerMarkdown,
            __fetchCommentsForAnswer
        };
})();`
    );

    vm.runInNewContext(instrumentedSource, sandbox, { filename: 'zhihu.user.js' });

    return {
        window,
        api: window.__zudTestExports
    };
}

test('reads comment count from the current action bar button markup', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <head></head>
          <body>
            <div class="AnswerItem" name="answer-1">
              <div class="ContentItem-meta"></div>
              <div class="ContentItem-actions">
                <button type="button">
                  <span class="Zi Zi--Comment"></span>
                  42 条评论
                </button>
              </div>
            </div>
          </body>
        </html>
    `);

    const answer = window.document.querySelector('.AnswerItem');
    assert.equal(api.__getCommentCountFromAnswer(answer), '42');
});

test('extracts author, content, likes and time from comment items without hashed css class names', () => {
    const { window, api } = loadZhihuTestApi();
    const list = window.document.createElement('div');
    list.innerHTML = `
        <div class="CommentItem" data-id="comment-1">
          <a class="UserLink" href="https://www.zhihu.com/people/alice">Alice</a>
          <div class="CommentContent">第一条评论</div>
          <button type="button">赞同 3</button>
          <time datetime="2026-03-25T10:00:00+08:00">03-25</time>
        </div>
    `;

    const comments = api.__extractCommentsFromPopup(list);

    assert.equal(comments.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(comments[0])), {
        author: { name: 'Alice' },
        content: '第一条评论',
        like_count: '3',
        created_time: '03-25',
        reply_to: null
    });
});

test('keeps human-readable comment times instead of rendering NaN timestamps', () => {
    const { api } = loadZhihuTestApi();

    const markdown = api.__commentToMarkdown({
        author: { name: 'Alice' },
        content: '第一条评论',
        like_count: '3',
        created_time: '03-25'
    });

    assert.match(markdown, /03-25/);
    assert.doesNotMatch(markdown, /NaN/);
});

test('waitForGrowth resolves soon after a value increases', async () => {
    const { api } = loadZhihuTestApi();
    let current = 3;

    setTimeout(() => {
        current = 7;
    }, 20);

    const startedAt = Date.now();
    const result = await api.__waitForGrowth(() => current, {
        timeoutMs: 200,
        intervalMs: 5,
        stablePollLimit: 50
    });

    assert.equal(result.changed, true);
    assert.equal(result.value, 7);
    assert.ok(Date.now() - startedAt < 150);
});

test('waitForGrowth stops early after repeated stable polls', async () => {
    const { api } = loadZhihuTestApi();
    const startedAt = Date.now();

    const result = await api.__waitForGrowth(() => 11, {
        timeoutMs: 200,
        intervalMs: 5,
        stablePollLimit: 3
    });

    assert.equal(result.changed, false);
    assert.equal(result.value, 11);
    assert.ok(Date.now() - startedAt < 120);
});

test('panel includes a stop button for long-running jobs', () => {
    const { window } = loadZhihuTestApi();
    const stopButton = window.document.getElementById('zudStop');
    assert.equal(stopButton?.textContent?.trim(), '停止');
});

test('panel includes copy and export log buttons', () => {
    const { window } = loadZhihuTestApi();
    assert.equal(window.document.getElementById('zudCopyLog')?.textContent?.trim(), '拷贝');
    assert.equal(window.document.getElementById('zudExportLog')?.textContent?.trim(), '导出');
});

test('waitForGrowth aborts quickly after a stop request', async () => {
    const { api } = loadZhihuTestApi();
    setTimeout(() => {
        api.__requestStop();
    }, 20);

    const startedAt = Date.now();
    const result = await api.__waitForGrowth(() => 11, {
        timeoutMs: 500,
        intervalMs: 5,
        stablePollLimit: 50
    });

    assert.equal(result.cancelled, true);
    assert.ok(Date.now() - startedAt < 200);
    api.__resetStopRequest();
});

test('getLogText returns plain text lines from the log panel', () => {
    const { window, api } = loadZhihuTestApi();
    const log = window.document.getElementById('zud-log');
    const line1 = window.document.createElement('div');
    const line2 = window.document.createElement('div');
    line1.textContent = '[14:00:00] first line';
    line2.textContent = '[14:00:01] second line';
    log.appendChild(line1);
    log.appendChild(line2);

    const text = api.__getLogText();
    assert.match(text, /\[14:00:00\] first line/);
    assert.match(text, /\[14:00:01\] second line/);
});

test('extracts author and time from zhihu comment markup with avatar link before profile name', () => {
    const { window, api } = loadZhihuTestApi();
    const list = window.document.createElement('div');
    list.innerHTML = `
        <div data-id="11444965519">
          <div class="css-jp43l4">
            <div class="css-1jll2aj">
              <div class="css-1gomreu">
                <a href="https://www.zhihu.com/people/66b366cb84037718f064609ee4740199" target="_blank" class="css-1dxejhk">
                  <img alt="omg">
                </a>
              </div>
            </div>
            <div class="css-14nvvry">
              <div class="css-z0cc58">
                <div class="css-swj9d4">
                  <div class="css-1tww9qq">
                    <div class="css-1gomreu">
                      <a href="https://www.zhihu.com/people/66b366cb84037718f064609ee4740199" target="_blank" class="css-10u695f">omg</a>
                    </div>
                  </div>
                </div>
              </div>
              <div class="CommentContent css-tgyln6">自动化是一条不可逆之路。</div>
              <div class="css-140jo2">
                <div class="css-x1xlu5">
                  <span class="css-12cl38p">03-23</span>
                  <span> · </span>
                  <span class="css-ntkn7q">上海</span>
                </div>
                <div class="css-18opwoy">
                  <button type="button" class="Button Button--plain Button--grey Button--withIcon Button--withLabel css-1vd72tl">578</button>
                </div>
              </div>
            </div>
          </div>
        </div>
    `;

    const comments = api.__extractCommentsFromPopup(list);

    assert.equal(comments.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(comments[0])), {
        author: { name: 'omg' },
        content: '自动化是一条不可逆之路。',
        like_count: '578',
        created_time: '03-23',
        reply_to: null
    });
});

test('groups reply modal content into root comment with nested child replies', () => {
    const { window, api } = loadZhihuTestApi();
    const modal = window.document.createElement('div');
    modal.innerHTML = `
        <div class="css-tpyajk">
          <div class="css-34podr">
            <div data-id="11444965519">
              <a class="css-10u695f" href="/people/root-user">omg</a>
              <div class="CommentContent css-tgyln6">根评论</div>
              <div class="css-x1xlu5"><span class="css-12cl38p">03-23</span></div>
              <button type="button" class="Button Button--plain Button--grey">578</button>
            </div>
          </div>
          <div class="css-16zdamy">
            <div data-id="11445726434">
              <a class="css-10u695f" href="/people/reply-user">望星楼楼主</a>
              <svg class="ZDI ZDI--ArrowRightAlt16 css-gx7lzm"></svg>
              <a class="css-10u695f" href="/people/root-user">用户名(必填)</a>
              <div class="CommentContent css-tgyln6">进化论是看待社会的最佳视角?</div>
              <div class="css-x1xlu5"><span class="css-12cl38p">昨天 10:38</span></div>
              <button type="button" class="Button Button--plain Button--grey">3</button>
            </div>
          </div>
        </div>
    `;

    const comments = api.__extractCommentsFromPopup(modal);

    assert.equal(comments.length, 1);
    const normalized = JSON.parse(JSON.stringify(comments[0]));
    assert.equal(normalized.author.name, 'omg');
    assert.equal(normalized.content, '根评论');
    assert.equal(normalized.child_comments_full.length, 1);
    assert.deepEqual(normalized.child_comments_full[0], {
        author: { name: '望星楼楼主' },
        content: '进化论是看待社会的最佳视角?',
        like_count: '3',
        created_time: '昨天 10:38',
        reply_to: '用户名(必填)'
    });
});

test('extracts answer time from content item time fallback when no time tag exists', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem">
              <div class="ContentItem-time">
                <a href="/question/1/answer/2">编辑于 2026-03-25 21:15</a>
              </div>
            </div>
          </body>
        </html>
    `);

    const answer = window.document.querySelector('.AnswerItem');
    assert.equal(api.__getAnswerTimeFromAnswer(answer), '编辑于 2026-03-25 21:15');
});

test('nudgeAnswerLoading clicks visible pagination controls and scrolls answer list container', async () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div id="QuestionAnswers-answers"></div>
            <div class="AnswerItem" id="answer-last"></div>
            <button class="ContentItem-more">more</button>
            <button class="PaginationButton">page</button>
          </body>
        </html>
    `);

    const listContainer = window.document.getElementById('QuestionAnswers-answers');
    let scrolledIntoView = false;
    let clicked = 0;

    Object.defineProperty(listContainer, 'scrollHeight', { value: 999, configurable: true });
    window.document.getElementById('answer-last').scrollIntoView = () => {
        scrolledIntoView = true;
    };

    for (const button of window.document.querySelectorAll('button')) {
        button.click = () => {
            clicked++;
        };
        Object.defineProperty(button, 'offsetParent', { value: window.document.body, configurable: true });
    }

    await api.__nudgeAnswerLoading();

    assert.equal(scrolledIntoView, true);
    assert.equal(listContainer.scrollTop, 999);
    assert.equal(clicked >= 2, true);
});

test('nudgeAnswerLoading also expands visible full-answer buttons', async () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div id="QuestionAnswers-answers"></div>
            <div class="AnswerItem" id="answer-last"></div>
            <button class="Button ContentItem-rightButton ContentItem-expandButton">阅读全文</button>
          </body>
        </html>
    `);

    let expandClicks = 0;
    const expandButton = window.document.querySelector('.ContentItem-expandButton');
    expandButton.click = () => {
        expandClicks++;
    };
    Object.defineProperty(expandButton, 'offsetParent', { value: window.document.body, configurable: true });
    Object.defineProperty(window.document.getElementById('QuestionAnswers-answers'), 'scrollHeight', { value: 999, configurable: true });
    window.document.getElementById('answer-last').scrollIntoView = () => { };

    await api.__nudgeAnswerLoading();

    assert.equal(expandClicks, 1);
});

test('finds non-button full-comments trigger elements', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="css-wu78cf">
              <div class="css-vurnku">点击查看全部评论</div>
            </div>
          </body>
        </html>
    `);

    const trigger = api.__findViewAllCommentsTrigger(window.document);
    assert.equal(trigger?.textContent?.trim(), '点击查看全部评论');
});

test('findViewAllCommentsTrigger returns the innermost trigger node instead of a large ancestor wrapper', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div id="wrapper">
              <div class="css-wu78cf">
                <div class="css-vurnku">点击查看全部评论</div>
                <svg></svg>
              </div>
            </div>
          </body>
        </html>
    `);

    const trigger = api.__findViewAllCommentsTrigger(window.document);
    assert.equal(trigger?.className, 'css-vurnku');
});

test('getAnswerSearchRoot can widen to the nearest container that still only contains the current answer', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="answer-shell" id="shell">
              <div class="AnswerItem" id="answer-1"></div>
              <div class="css-wu78cf"><div class="css-vurnku">点击查看全部评论</div></div>
            </div>
            <div class="AnswerItem" id="answer-2"></div>
          </body>
        </html>
    `);

    const root = api.__getAnswerSearchRoot(window.document.getElementById('answer-1'));
    assert.equal(root?.id, 'shell');
});

test('findFreshGlobalCommentsRoot picks a newly appeared portal comments root after clicking full comments', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="answer-shell" id="shell">
              <div class="AnswerItem" id="answer-1">
                <div class="css-u76jt1" id="inline-comments">
                  <div class="css-18ld3w0">
                    <div data-id="inline-1"><div class="CommentContent">热评 1</div></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="AnswerItem" id="answer-2"></div>
            <div class="css-tpyajk" id="portal-comments" hidden>
              <div class="css-34podr">
                <div data-id="full-1"><div class="CommentContent">完整评论 1</div></div>
                <div data-id="full-2"><div class="CommentContent">完整评论 2</div></div>
              </div>
            </div>
          </body>
        </html>
    `);

    const answer = window.document.getElementById('answer-1');
    const baseline = api.__snapshotGlobalCommentsRoots(answer);
    window.document.getElementById('portal-comments').hidden = false;

    const root = api.__findFreshGlobalCommentsRoot(answer, baseline);
    assert.equal(root?.id, 'portal-comments');
});

test('findFreshGlobalCommentsTrigger picks a newly appeared portal trigger when local scope has none', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="answer-shell" id="shell">
              <div class="AnswerItem" id="answer-1"></div>
            </div>
            <div class="AnswerItem" id="answer-2"></div>
            <div class="css-wu78cf" id="portal-trigger" hidden>
              <div class="css-vurnku">点击查看全部评论</div>
            </div>
          </body>
        </html>
    `);

    const answer = window.document.getElementById('answer-1');
    const baseline = api.__snapshotGlobalCommentTriggers(answer);
    window.document.getElementById('portal-trigger').hidden = false;

    const trigger = api.__findFreshGlobalCommentsTrigger(answer, baseline);
    assert.equal(trigger?.className, 'css-vurnku');
});

test('findSingleVisibleGlobalCommentsTrigger returns the only visible global trigger outside the current answer scope', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="answer-shell" id="shell">
              <div class="AnswerItem" id="answer-1"></div>
            </div>
            <div class="AnswerItem" id="answer-2"></div>
            <div class="css-wu78cf" id="portal-trigger">
              <div class="css-vurnku">点击查看全部评论</div>
            </div>
          </body>
        </html>
    `);

    const answer = window.document.getElementById('answer-1');
    const trigger = api.__findSingleVisibleGlobalCommentsTrigger(answer);
    assert.equal(trigger?.className, 'css-vurnku');
});

test('findBetweenAnswerAndNextAnswer can find a trigger inserted after the current answer and before the next one', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer-1"></div>
            <div class="css-wu78cf" id="between-trigger">
              <div class="css-vurnku">点击查看全部评论</div>
            </div>
            <div class="AnswerItem" id="answer-2"></div>
          </body>
        </html>
    `);

    const answer = window.document.getElementById('answer-1');
    const trigger = api.__findBetweenAnswerAndNextAnswer(answer, '.css-vurnku');
    assert.equal(trigger?.textContent?.trim(), '点击查看全部评论');
});

test('findBetweenAnswerAndNextAnswer can find a portal comments root inserted after the current answer', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer-1"></div>
            <div class="css-tpyajk" id="between-root">
              <div class="css-34podr">
                <div data-id="full-1"><div class="CommentContent">完整评论 1</div></div>
              </div>
            </div>
            <div class="AnswerItem" id="answer-2"></div>
          </body>
        </html>
    `);

    const answer = window.document.getElementById('answer-1');
    const root = api.__findBetweenAnswerAndNextAnswer(answer, '.css-tpyajk');
    assert.equal(root?.id, 'between-root');
});

test('findReplyThreadRoot recognizes the reply-thread view after a thread is opened', () => {
    const { window, api } = loadZhihuTestApi();
    const root = window.document.createElement('div');
    root.innerHTML = `
        <div class="css-tpyajk" id="reply-thread-root">
          <div class="css-1jm49l2">评论回复</div>
          <div class="css-34podr">
            <div data-id="11444965519"><div class="CommentContent">根评论</div></div>
          </div>
          <div class="css-16zdamy">
            <div data-id="11445726434"><div class="CommentContent">子回复</div></div>
          </div>
        </div>
    `;

    const threadRoot = api.__findReplyThreadRoot(root);
    assert.equal(threadRoot?.id, 'reply-thread-root');
});

test('normalizes relative comment times into absolute local dates', () => {
    const { api } = loadZhihuTestApi();

    assert.equal(api.__normalizeCommentTime('昨天 03:57'), '2026-03-24 03:57');
    assert.equal(api.__normalizeCommentTime('今天 08:34'), '2026-03-25 08:34');
    assert.equal(api.__normalizeCommentTime('前天 10:04'), '2026-03-23 10:04');
    assert.equal(api.__normalizeCommentTime('03-23'), '2026-03-23');
});

test('getDisplayedCommentTotal extracts the total comment count from the modal header', () => {
    const { window, api } = loadZhihuTestApi();
    const root = window.document.createElement('div');
    root.innerHTML = `
        <div class="css-tpyajk">
          <div class="css-1onritu">
            <div class="css-r4op92"><div class="css-1k10w8f">495 条评论</div></div>
          </div>
        </div>
    `;

    assert.equal(api.__getDisplayedCommentTotal(root), 495);
});

test('waitForCommentPanelProgress treats comment item growth as progress even when scroll height does not change', async () => {
    const { window, api } = loadZhihuTestApi();
    const root = window.document.createElement('div');
    root.innerHTML = `<div data-id="c1"><div class="CommentContent">one</div></div>`;
    const scrollContainer = window.document.createElement('div');
    let height = 1000;
    Object.defineProperty(scrollContainer, 'scrollHeight', {
        get() { return height; },
        configurable: true
    });

    setTimeout(() => {
        const item = window.document.createElement('div');
        item.setAttribute('data-id', 'c2');
        root.appendChild(item);
    }, 20);

    const result = await api.__waitForCommentPanelProgress(root, scrollContainer, {
        timeoutMs: 200,
        intervalMs: 5,
        stablePollLimit: 20
    });

    assert.equal(result.changed, true);
    assert.equal(result.count, 2);
    assert.equal(result.height, 1000);
});

test('renders nested comments as a tree-style markdown block', () => {
    const { api } = loadZhihuTestApi();

    const roots = [
        {
            author: { name: 'omg' },
            content: '根评论',
            like_count: '578',
            created_time: '03-23',
            child_comments_full: [
                {
                    author: { name: '用户名(必填)' },
                    content: '革新一定带来冲击',
                    like_count: '17',
                    created_time: '昨天 10:04',
                    reply_to: null
                },
                {
                    author: { name: '望星楼楼主' },
                    content: '进化论是看待社会的最佳视角?',
                    like_count: '3',
                    created_time: '昨天 10:38',
                    reply_to: '用户名(必填)'
                }
            ]
        }
    ];

    const markdown = api.__commentsBlockMarkdown(roots);

    assert.equal(api.__countCommentsDeep(roots), 3);
    assert.match(markdown, /#### 评论 \(3，根评论 1\)/);
    assert.match(markdown, /- omg \[2026-03-23\] 578赞/);
    assert.match(markdown, /\|- 用户名\(必填\) \[2026-03-24 10:04\] 17赞/);
    assert.match(markdown, /\\- 望星楼楼主 -> 用户名\(必填\) \[2026-03-24 10:38\] 3赞/);
});

test('renders question metadata as a markdown table', () => {
    const { api } = loadZhihuTestApi();

    const markdown = api.__renderQuestionMarkdown({
        title: 'AI 会淘汰多少岗位？',
        url: 'https://www.zhihu.com/question/123',
        author: '提问者A',
        topics: ['人工智能', '就业'],
        followerCount: '1000',
        viewCount: '20万',
        answerCount: '463',
        descriptionMd: '这里是问题描述。'
    });

    assert.match(markdown, /# AI 会淘汰多少岗位？/);
    assert.match(markdown, /\| 字段 \| 内容 \|/);
    assert.match(markdown, /\| 关注 \/ 浏览 \/ 回答 \| 1000 \/ 20万 \/ 463 \|/);
    assert.match(markdown, /## 问题描述/);
});

test('renders answer metadata as a section with table and body heading', () => {
    const { api } = loadZhihuTestApi();

    const markdown = api.__renderAnswerMarkdown({
        index: 1,
        authorName: 'omg',
        authorUrl: 'https://www.zhihu.com/people/omg',
        upvoteCount: '578',
        commentCount: '463',
        time: '2026-03-25 21:15',
        contentMd: '自动化是一条不可逆之路。',
        commentsMd: '#### 评论 (1)\n\n- 用户A [2026-03-23] 1赞\n  评论内容\n'
    });

    assert.match(markdown, /## 回答 1 \| omg/);
    assert.match(markdown, /\| 指标 \| 数值 \|/);
    assert.match(markdown, /\| 赞同 \| 578 \|/);
    assert.match(markdown, /\| 评论 \| 463 \|/);
    assert.match(markdown, /### 正文/);
    assert.match(markdown, /### 评论/);
});

test('prefers the fuller answer-scoped comments root when hot and full roots coexist inside one answer', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer">
              <div class="css-u76jt1">
                <div class="css-840pn3">
                  <div class="css-18ld3w0">
                    <div data-id="inline-1"><div class="CommentContent">只有一条热评</div></div>
                  </div>
                </div>
                <div class="css-tpyajk" id="full-comments">
                  <div class="css-34podr">
                    <div data-id="full-1"><div class="CommentContent">完整评论 1</div></div>
                    <div data-id="full-2"><div class="CommentContent">完整评论 2</div></div>
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>
    `);

    const answer = window.document.getElementById('answer');
    const picked = api.__pickExpandedCommentsRoot(answer);

    assert.equal(picked?.id, 'full-comments');
});

test('findFullCommentsRoot prefers the dedicated full-comments panel over inline hot comments', async () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer">
              <div class="css-u76jt1">
                <div class="css-840pn3">
                  <div class="css-18ld3w0">
                    <div data-id="inline-1"><div class="CommentContent">热评 1</div></div>
                  </div>
                </div>
                <div class="css-wu78cf">
                  <div class="css-vurnku">点击查看全部评论</div>
                </div>
                <div class="css-tpyajk" id="full-comments">
                  <div class="css-34podr">
                    <div data-id="full-1"><div class="CommentContent">完整评论 1</div></div>
                    <div data-id="full-2"><div class="CommentContent">完整评论 2</div></div>
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>
    `);

    const fullRoot = await api.__findFullCommentsRoot(window.document.getElementById('answer'));
    assert.equal(fullRoot?.id, 'full-comments');
});

test('findFullCommentsRoot can detect a full comments modal that appears directly after clicking comments', async () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer">
              <div class="css-u76jt1" id="inline-comments">
                <div class="css-18ld3w0">
                  <div data-id="inline-1"><div class="CommentContent">热评 1</div></div>
                </div>
              </div>
            </div>
            <div class="AnswerItem" id="answer-2"></div>
            <div class="css-1e7fksk" hidden>
              <div class="Modal-content css-1svde17">
                <div class="css-tpyajk" id="full-comments">
                  <div class="css-34podr">
                    <div data-id="full-1"><div class="CommentContent">完整评论 1</div></div>
                    <div data-id="full-2"><div class="CommentContent">完整评论 2</div></div>
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>
    `);

    const answer = window.document.getElementById('answer');
    const baseline = api.__snapshotGlobalCommentsRoots(answer);
    window.document.querySelector('.css-1e7fksk').hidden = false;

    const fullRoot = await api.__findFullCommentsRoot(answer, baseline);
    assert.equal(fullRoot?.id, 'full-comments');
});

test('waitForCommentsModalReady waits for the full comments modal shell before extraction', async () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer"></div>
            <div class="AnswerItem" id="answer-2"></div>
            <div class="css-1e7fksk" id="modal-shell" hidden>
              <div class="Modal-content css-1svde17">
                <div class="css-tpyajk" id="full-comments">
                  <div class="css-34podr">
                    <div class="css-18ld3w0">
                      <div data-id="full-1"><div class="CommentContent">完整评论 1</div></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>
    `);

    setTimeout(() => {
        window.document.getElementById('modal-shell').hidden = false;
    }, 20);

    const root = await api.__waitForCommentsModalReady(window.document.getElementById('answer'));
    assert.equal(root?.id, 'full-comments');
});

test('isCompleteCommentsRoot rejects a partial comments panel that still shows click-to-view-all', () => {
    const { window, api } = loadZhihuTestApi();
    const partialRoot = window.document.createElement('div');
    partialRoot.className = 'css-u76jt1';
    partialRoot.innerHTML = `
        <div class="css-18ld3w0">
          <div data-id="inline-1"><div class="CommentContent">热评 1</div></div>
        </div>
        <div class="css-wu78cf"><div class="css-vurnku">点击查看全部评论</div></div>
    `;

    const completeRoot = window.document.createElement('div');
    completeRoot.className = 'css-tpyajk';
    completeRoot.innerHTML = `
        <div class="css-34podr">
          <div class="css-18ld3w0">
            <div data-id="full-1"><div class="CommentContent">完整评论 1</div></div>
          </div>
        </div>
    `;

    assert.equal(api.__isCompleteCommentsRoot(partialRoot), false);
    assert.equal(api.__isCompleteCommentsRoot(completeRoot), true);
});

test('fetchCommentsForAnswer detects a full comments modal that appears immediately after clicking the comment button', async () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" name="answer-1">
              <div class="ContentItem-meta"></div>
              <div class="ContentItem-actions">
                <button type="button" id="comment-btn">
                  <span class="Zi Zi--Comment"></span>
                  495 条评论
                </button>
              </div>
            </div>
            <div class="AnswerItem" name="answer-2"></div>
            <div class="css-1e7fksk" id="modal-shell" hidden>
              <div class="Modal-content css-1svde17">
                <div class="css-tpyajk" id="full-comments">
                  <div class="css-34podr">
                    <div class="css-18ld3w0">
                      <div data-id="11444965519">
                        <a class="css-10u695f" href="/people/root-user">omg</a>
                        <div class="CommentContent css-tgyln6">根评论</div>
                        <div class="css-x1xlu5"><span class="css-12cl38p">03-23</span></div>
                        <button type="button" class="Button Button--plain Button--grey">601</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </body>
        </html>
    `);

    window.document.getElementById('comment-btn').click = () => {
        window.document.getElementById('modal-shell').hidden = false;
    };

    const comments = await api.__fetchCommentsForAnswer(window.document.querySelector('.AnswerItem'));
    assert.equal(comments.length, 1);
    assert.equal(comments[0].author.name, 'omg');
});

test('findAnswerScopedCommentsRoot does not reuse the first answer comment root for later answers', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer-1">
              <div class="css-u76jt1" id="comments-1">
                <div class="css-18ld3w0">
                  <div data-id="a1-c1"><div class="CommentContent">回答1评论</div></div>
                </div>
              </div>
            </div>
            <div class="AnswerItem" id="answer-2">
              <div class="css-u76jt1" id="comments-2">
                <div class="css-18ld3w0">
                  <div data-id="a2-c1"><div class="CommentContent">回答2评论</div></div>
                </div>
              </div>
            </div>
          </body>
        </html>
    `);

    const root = api.__findAnswerScopedCommentsRoot(window.document.getElementById('answer-2'));
    assert.equal(root?.id, 'comments-2');
});

test('collapseAnswerComments clicks the local collapse button for the current answer', () => {
    const { window, api } = loadZhihuTestApi(`
        <!doctype html>
        <html>
          <body>
            <div class="AnswerItem" id="answer-1">
              <button type="button" class="Button css-1503iqi">收起评论</button>
            </div>
          </body>
        </html>
    `);

    let clicks = 0;
    const button = window.document.querySelector('.css-1503iqi');
    button.click = () => {
        clicks++;
    };

    api.__collapseAnswerComments(window.document.getElementById('answer-1'));
    assert.equal(clicks, 1);
});

test('collectNestedReplies only processes each root comment once even if duplicate reply buttons exist', async () => {
    const { window, api } = loadZhihuTestApi();
    const root = window.document.createElement('div');
    root.innerHTML = `
        <div data-id="root-1">
          <button type="button" class="Button Button--secondary Button--grey">查看全部 27 条回复</button>
          <button type="button" class="Button Button--secondary Button--grey">展开其他 3 条回复</button>
        </div>
    `;

    let clicks = 0;
    for (const button of root.querySelectorAll('button')) {
        button.click = () => {
            clicks++;
        };
    }

    await api.__collectNestedReplies(root, [
        { __commentId: 'root-1', child_comments_full: [] }
    ]);

    assert.equal(clicks, 1);
});

test('collectNestedReplies respects a max thread cap for a single answer', async () => {
    const { window, api } = loadZhihuTestApi();
    const root = window.document.createElement('div');
    root.innerHTML = `
        <div data-id="root-1">
          <button type="button" class="Button Button--secondary Button--grey">查看全部 27 条回复</button>
        </div>
        <div data-id="root-2">
          <button type="button" class="Button Button--secondary Button--grey">查看全部 13 条回复</button>
        </div>
        <div data-id="root-3">
          <button type="button" class="Button Button--secondary Button--grey">查看全部 8 条回复</button>
        </div>
    `;

    let clicks = 0;
    for (const button of root.querySelectorAll('button')) {
        button.click = () => {
            clicks++;
        };
    }

    await api.__collectNestedReplies(root, [
        { __commentId: 'root-1', child_comments_full: [] },
        { __commentId: 'root-2', child_comments_full: [] },
        { __commentId: 'root-3', child_comments_full: [] }
    ], { maxThreads: 1 });

    assert.equal(clicks, 1);
});

test('formatTraceMessage renders scope, stage and key details in one line', () => {
    const { api } = loadZhihuTestApi();
    const line = api.__formatTraceMessage('comments', 'expand-root', {
        answerId: '2019449064857580523',
        index: 1,
        current: 12
    });

    assert.match(line, /\[comments\] expand-root/);
    assert.match(line, /answerId=2019449064857580523/);
    assert.match(line, /index=1/);
    assert.match(line, /current=12/);
});
