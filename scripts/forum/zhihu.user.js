// ==UserScript==
// @name         知乎问题回答批量/选择性导出为 Markdown
// @namespace    http://tampermonkey.net/
// @version      0.5
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
        const answerCountElement = document.querySelector('.List-headerText span');
        if (!answerCountElement) {
             console.warn("UserScript: Could not find answer count element for loading progress.");
        }
        let loadedAnswersCount = document.querySelectorAll('.AnswerItem').length;
        console.log(`UserScript: Initially loaded answers: ${loadedAnswersCount}`);

        let previousAnswersCount = loadedAnswersCount;
        let scrollAttempts = 0;
        const maxScrollAttempts = 50;

        const scrollInterval = 500;
        const settlementDelay = 1500;

        while (scrollAttempts < maxScrollAttempts) {
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise(resolve => setTimeout(resolve, scrollInterval));

            loadedAnswersCount = document.querySelectorAll('.AnswerItem').length;
            console.log(`UserScript: Attempt ${scrollAttempts + 1}: Loaded ${loadedAnswersCount} answers.`);

            if (loadedAnswersCount > previousAnswersCount) {
                previousAnswersCount = loadedAnswersCount;
                scrollAttempts = 0;
                 await new Promise(resolve => setTimeout(resolve, settlementDelay));
            } else {
                 scrollAttempts++;
                 console.log(`UserScript: No new answers loaded, attempt ${scrollAttempts}/${maxScrollAttempts}.`);
            }

             if (answerCountElement) {
                 const totalAnswersText = answerCountElement.textContent;
                 const totalAnswersMatch = totalAnswersText.match(/\d+/);
                 if (totalAnswersMatch) {
                      const totalAnswers = parseInt(totalAnswersMatch[0], 10);
                      if (loadedAnswersCount >= totalAnswers - (totalAnswers > 100 ? 20 : 5)) {
                           console.log(`UserScript: Loaded ${loadedAnswersCount}, total reported is ${totalAnswers}. Close enough, stopping loading.`);
                           break;
                      }
                 }
             }

             if (scrollAttempts >= 10 && loadedAnswersCount === previousAnswersCount) {
                 console.log(`UserScript: No new answers loaded after ${scrollAttempts} attempts. Stopping loading.`);
                 break;
             }
        }
        console.log("UserScript: Finished loading answers.");
        window.scrollTo(0, 0);
         await new Promise(resolve => setTimeout(resolve, 200));
    }


    // Function to extract and format ALL answers
    function getAllAnswersMarkdown() {
        const answerElements = document.querySelectorAll('.AnswerItem');
        let answersMd = '';
        let index = 0;

        answerElements.forEach((answerEl) => {
            index++;
            const authorEl = answerEl.querySelector('.AuthorInfo-name a');
            const authorName = authorEl?.innerText || '匿名用户';
            const authorUrl = authorEl?.href || '#';
             const voteButton = answerEl.querySelector('.VoteButton--up');
             const upvoteCount = voteButton ? (voteButton.getAttribute('aria-label')?.match(/\d+/) || [0])[0] : '0';

            const commentButton = answerEl.querySelector('.ContentItem-action svg.Zi--Comment')?.closest('button');
             const commentCount = commentButton ? (commentButton.innerText.match(/\d+/) || [0])[0] : '0';

             const timeElement = answerEl.querySelector('.ContentItem-time span[data-tooltip]');
             const time = timeElement ? timeElement.getAttribute('data-tooltip').replace('发布于 ', '').replace('编辑于 ', '编辑于 ') : '未知时间';

            const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
            const contentMd = turndownService.turndown(contentHtml);

            answersMd += `### ${index}. ${authorName}\n\n`;
             if (authorUrl && authorUrl !== '#') {
                 answersMd += `[${authorName}](${authorUrl})\n\n`;
             }
            answersMd += `**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`;
            answersMd += contentMd + '\n\n';
            answersMd += `--- \n\n`; // Separator between answers
        });

        let fullMd = `## 全部回答 (${index})\n\n`;
        fullMd += answersMd;

        return fullMd;
    }

    // Function to add the Download All button
    function addDownloadAllButton() {
        console.log("UserScript: addDownloadAllButton function started.");

        const button = document.createElement('button');
        button.id = 'downloadAllAnswersButton'; // Add an ID
        button.innerText = '下载全部回答 (Markdown)';
        button.style.cssText = `
            position: fixed;
            top: 100px; /* Position for Download All button */
            right: 20px;
            z-index: 1000;
            padding: 10px 15px;
            background-color: #0077ff; /* Blue color */
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;

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
                const answersMd = getAllAnswersMarkdown();
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

        document.body.appendChild(button);
        console.log("UserScript: Download all button added.");
    }
    // --- End Functions for Download ALL ---


    // --- Functions for Selective Download ---

    // Function to update the count on the main download button
    function updateDownloadButtonCount() {
        const downloadButton = document.getElementById('downloadSelectedAnswersButton');
        if (downloadButton) {
            downloadButton.innerText = `下载已选回答 (${selectedAnswers.size})`;
            downloadButton.disabled = selectedAnswers.size === 0;
        }
    }

    // Function to add the select button to an individual answer
    function addSelectButton(answerElement) {
        // Avoid adding button multiple times or to elements that aren't full answers
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
             console.log("UserScript: Select button added to AnswerItem.");


        } else {
            console.warn("UserScript: Could not find meta div for answer, skipping select button:", answerElement);
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
    function getSelectedAnswersMarkdown() {
        const answerElements = document.querySelectorAll('.AnswerItem');
        let answersMd = '';
        let selectedIndex = 0;
        let exportedAnswerTokens = new Set();

        answerElements.forEach((answerEl) => {
             const answerToken = answerEl.getAttribute('name') || answerEl.dataset.zop?.itemId || answerEl.id;
             if (answerToken && selectedAnswers.has(answerToken)) {
                 selectedIndex++;
                 exportedAnswerTokens.add(answerToken);

                const authorEl = answerEl.querySelector('.AuthorInfo-name a');
                const authorName = authorEl?.innerText || '匿名用户';
                const authorUrl = authorEl?.href || '#';
                 const voteButton = answerEl.querySelector('.VoteButton--up');
                 const upvoteCount = voteButton ? (voteButton.getAttribute('aria-label')?.match(/\d+/) || [0])[0] : '0';

                const commentButton = answerEl.querySelector('.ContentItem-action svg.Zi--Comment')?.closest('button');
                 const commentCount = commentButton ? (commentButton.innerText.match(/\d+/) || [0])[0] : '0';

                 const timeElement = answerEl.querySelector('.ContentItem-time span[data-tooltip]');
                 const time = timeElement ? timeElement.getAttribute('data-tooltip').replace('发布于 ', '').replace('编辑于 ', '编辑于 ') : '未知时间';

                const contentHtml = answerEl.querySelector('.RichText.ztext')?.innerHTML || '';
                const contentMd = turndownService.turndown(contentHtml);

                answersMd += `### ${selectedIndex}. ${authorName}\n\n`;
                 if (authorUrl && authorUrl !== '#') {
                     answersMd += `[${authorName}](${authorUrl})\n\n`;
                 }
                answersMd += `**赞同:** ${upvoteCount} | **评论:** ${commentCount} | **时间:** ${time}\n\n`;
                answersMd += contentMd + '\n\n';
                answersMd += `--- \n\n`;
             }
        });

        let fullMd = `## 已选回答 (${exportedAnswerTokens.size})\n\n`;
        fullMd += answersMd;

        if (exportedAnswerTokens.size !== selectedAnswers.size) {
            console.warn(`UserScript: Expected to export ${selectedAnswers.size} answers, but found only ${exportedAnswerTokens.size} in the DOM.`);
        }

        return fullMd;
    }

    // Function to add the main download selected button
    function addMainDownloadButton() {
         console.log("UserScript: addMainDownloadButton function started.");

        const button = document.createElement('button');
        button.id = 'downloadSelectedAnswersButton';
        button.innerText = '下载已选回答 (0)';
        button.disabled = true;
        button.style.cssText = `
            position: fixed;
            top: 160px; /* Position for Download Selected button (adjust as needed) */
            right: 20px;
            z-index: 1000;
            padding: 10px 15px;
            background-color: #28a745;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        `;

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
                const answersMd = getSelectedAnswersMarkdown();
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

        document.body.appendChild(button);
        console.log("UserScript: Download selected button added.");

        updateDownloadButtonCount();
    }
    // --- End Functions for Selective Download ---


    // --- MutationObserver Setup ---
     const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.addedNodes) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                         if (node.classList && node.classList.contains('AnswerItem')) {
                             addSelectButton(node);
                         } else {
                              node.querySelectorAll('.AnswerItem').forEach(addSelectButton);
                         }
                    }
                });
            }
        });
    });
    // --- End MutationObserver Setup ---


    // --- Script Initialization ---
    console.log("UserScript: Zhihu Download Script started.");

    // Add BOTH main buttons
    addDownloadAllButton(); // Download All
    addMainDownloadButton(); // Download Selected (positioned lower)


    // Add select buttons to answers already present on the page
    addSelectButtonsToAllAnswers();

    // Start observing the answer list for new answers
    const answerListContainer = document.getElementById('QuestionAnswers-answers');
    if (answerListContainer) {
        observer.observe(answerListContainer, { childList: true, subtree: true });
        console.log("UserScript: Started observing answer list for new answers and adding select buttons.");
    } else {
        console.warn("UserScript: Could not find answer list container (#QuestionAnswers-answers), dynamic loading of select buttons might not work.");
    }


})();