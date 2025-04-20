// ==UserScript==
// @name         Shehuatang 下载助手
// @namespace    http://tampermonkey.net/
// @version      2025-04-21
// @description  收集色花堂页面图片链接并打包下载为 ZIP 文件
// @author       nerdneilsfield <dengqi935@gmail.com>
// @match        https://sehuatang.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=sehuatang.net
// @require      https://cdn.jsdelivr.net/npm/jszip@3.9.1/dist/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.0/FileSaver.min.js
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/nfw/shehuatang.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/nfw/shehuatang.user.js
// ==/UserScript==

/* global JSZip */ // 告诉 linter JSZip 是全局可用的 (通过 @require 引入)
/* global saveAs */ // 告诉 linter saveAs 是全局可用的 (通过 @require 引入)

(function () {
  "use strict";

  // --- 样式 ---
  GM_addStyle(`
        .sht-popup-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0,0,0,0.5); z-index: 10000; display: flex;
            justify-content: center; align-items: center;
        }
        .sht-popup-content {
            background-color: #fff; padding: 20px; border-radius: 5px;
            max-width: 80%; max-height: 80%; overflow-y: auto; display: flex;
            flex-direction: column; box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }
        .sht-popup-content h3 { margin-top: 0; }
        .sht-popup-content textarea { width: 100%; height: 300px; margin-bottom: 10px; box-sizing: border-box; }
        .sht-popup-actions button { margin-right: 10px; padding: 8px 12px; cursor: pointer; }
        .sht-popup-actions button:last-child { margin-right: 0; }
        .sht-fixed-button {
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            padding: 10px 15px; background-color: #007BFF; color: #fff;
            border: none; border-radius: 5px; cursor: pointer; font-size: 14px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        }
        .sht-progress-bar {
            width: 100%; background-color: #f3f3f3; border-radius: 3px;
            height: 10px; margin-top: 5px; overflow: hidden; display: none; /* 初始隐藏 */
        }
        .sht-progress-bar-inner {
            width: 0%; height: 100%; background-color: #4CAF50;
            text-align: center; line-height: 10px; color: white; font-size: 8px;
            transition: width 0.2s ease-in-out;
        }
    `);

  /**
   * 执行一个复杂的滚动序列，并在每个快速滚动/到达目的地后添加休息时间，
   * 缓慢向下滚动时会分段暂停：
   * 1. 快速滚动到页面底部 -> 休息。
   * 2. 快速滚动回页面顶部 -> 休息。
   * 3. 缓慢滚动到页面底部 (每滚动约 10000px 暂停一次) -> 休息。
   * 4. 再次快速滚动回页面顶部 -> 休息。
   * 5. 执行回调函数。
   * @param {function} callback - 滚动序列完成后要执行的回调函数。
   */
  function complexScrollingSequenceWithPauses(callback) {
    // --- 配置参数 ---
    const slowScrollStep = 68; // 缓慢向下滚动时每步的像素值
    const slowScrollInterval = 50; // 缓慢向下滚动时【每步之间】的时间间隔 (毫秒)
    const delayBetweenPhases = 1600; // 每个【主要阶段】完成后的休息时间 (毫秒)
    const pixelsPerChunk = 8000; // 缓慢向下滚动时，滚动这么多像素后暂停
    const slowScrollPauseDuration = 1050; // 缓慢向下滚动过程中【每次暂停】的时长 (毫秒)
    // ----------------

    const triggerButton = document.querySelector(".sht-fixed-button"); // 确保这是你的按钮选择器
    let totalPhases = 5;

    // 更新按钮状态和文字的辅助函数
    const updateButtonState = (phase, customText = null) => {
      if (triggerButton) {
        let text = customText;
        if (!text) {
          const phaseText =
            phase >= totalPhases ? "完成" : `${phase}/${totalPhases}`;
          text = `滚动中 (${phaseText})...`;
        }
        triggerButton.innerText = text;
        triggerButton.disabled = phase < totalPhases;
      }
    };

    // 记录日志并更新按钮状态
    const logPhase = (phase, message) => {
      console.log(`阶段 ${phase}/${totalPhases}: ${message}`);
      updateButtonState(phase);
    };

    // --- 滚动序列开始 ---
    console.log("滚动序列开始 (带分段暂停)...");

    // 阶段 1: 快速滚动到底部
    logPhase(1, "快速滚动到底部...");
    window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });

    // --- 休息时间 1 ---
    console.log(`   到达底部，休息 ${delayBetweenPhases}ms...`);
    setTimeout(() => {
      // 阶段 2: 快速滚动回顶部
      logPhase(2, "快速滚动回顶部...");
      window.scrollTo({ top: 0, behavior: "auto" });

      // --- 休息时间 2 ---
      console.log(`   到达顶部，休息 ${delayBetweenPhases}ms...`);
      setTimeout(() => {
        // 阶段 3: 缓慢向下滚动 (带分段暂停)
        logPhase(
          3,
          `开始缓慢向下滚动 (每 ${pixelsPerChunk} 像素暂停 ${slowScrollPauseDuration}ms)...`
        );

        let pixelsScrolledSinceLastPause = 0; // 用于追踪当前分段已滚动的像素

        // 定义阶段 4 和 5 的逻辑 (包含它们之前的休息)
        const executePhase4And5 = () => {
          console.log(`   缓慢滚动过程结束，休息 ${delayBetweenPhases}ms...`);
          setTimeout(() => {
            // 阶段 4: 再次快速滚动回顶部
            logPhase(4, "再次快速滚动回顶部...");
            window.scrollTo({ top: 0, behavior: "auto" });

            // --- 休息时间 4 ---
            console.log(`   再次到达顶部，休息 ${delayBetweenPhases}ms...`);
            setTimeout(() => {
              // 阶段 5: 执行回调
              logPhase(5, "滚动序列完成，执行回调函数...");
              updateButtonState(5, "收集图片链接"); // 恢复按钮文字和状态

              if (typeof callback === "function") {
                callback();
              } else {
                console.warn("未提供有效的回调函数。");
              }
            }, delayBetweenPhases); // 回调前的最后延迟
          }, delayBetweenPhases); // 回顶前的延迟
        };

        // --- 使用递归 setTimeout 实现缓慢滚动和分段暂停 ---
        function slowScrollDownStep() {
          const currentY = window.scrollY;
          const pageHeight = document.body.scrollHeight;
          const windowHeight = window.innerHeight;

          // 1. 检查是否已到达页面实际底部
          if (currentY + windowHeight >= pageHeight - 10) {
            // 留点余量
            console.log("   已到达页面底部 (在缓慢滚动中)。");
            window.scrollTo({ top: pageHeight, behavior: "auto" }); // 确保完全到底
            executePhase4And5(); // 进行后续阶段
            return; // 结束递归
          }

          // 2. 检查是否达到了分段暂停的像素阈值
          if (pixelsScrolledSinceLastPause >= pixelsPerChunk) {
            console.log(
              `   已滚动约 ${pixelsPerChunk} 像素，暂停 ${slowScrollPauseDuration}ms...`
            );
            pixelsScrolledSinceLastPause = 0; // 重置计数器，准备下一个分段
            // 暂停后继续调用自己
            setTimeout(slowScrollDownStep, slowScrollPauseDuration);
            return; // 等待暂停结束，本次不滚动
          }

          // 3. 计算本次滚动的步长
          // 确保不会超出当前分段的剩余量
          const remainingInChunk =
            pixelsPerChunk - pixelsScrolledSinceLastPause;
          const scrollAmountThisStep = Math.min(
            slowScrollStep,
            remainingInChunk
          );

          // 4. 执行滚动并更新计数器
          const scrollYBeforeStep = window.scrollY;
          window.scrollBy(0, scrollAmountThisStep);
          // 假设滚动成功，增加计数器（即使卡住也要增加，避免在卡住点无限尝试滚动小步）
          // 注意：如果页面高度动态变化，这个计数可能不完全精确反映视觉滚动距离，但足以触发暂停
          pixelsScrolledSinceLastPause += scrollAmountThisStep;

          // 5. 检查是否卡住 (滚动后 Y 坐标没变，且没到底)
          if (
            window.scrollY === scrollYBeforeStep &&
            currentY + windowHeight < pageHeight - 10
          ) {
            console.log("   滚动位置未改变，视为卡住，结束缓慢滚动。");
            executePhase4And5(); // 卡住了也进行后续阶段
            return; // 结束递归
          }

          // 6. 如果没到底也没到暂停点，计划下一次滚动
          setTimeout(slowScrollDownStep, slowScrollInterval);
        }

        // --- 启动缓慢向下滚动 ---
        slowScrollDownStep();
      }, delayBetweenPhases); // 缓慢滚动开始前的延迟
    }, delayBetweenPhases); // 第一个回顶前的延迟
  }

  // --- 创建右下角固定按钮 ---
  let fixedButton = document.createElement("button");
  fixedButton.innerText = "收集图片链接";
  fixedButton.className = "sht-fixed-button";
  document.body.appendChild(fixedButton);

  // --- 点击按钮时收集图片并弹出窗口 ---
  fixedButton.addEventListener("click", function () {
    complexScrollingSequenceWithPauses(collectImages);
  });

  // --- 收集符合条件的图片链接 ---
  function collectImages() {
    let imgs = document.querySelectorAll("img[src]"); // 使用 querySelectorAll 更精确
    let links = [];
    const minWidth = 150;
    const minHeight = 150;
    console.log(`发现 ${imgs.length} 个 img 标签`);

    // 使用 Set 去重
    const uniqueSrcs = new Set();

    for (let img of imgs) {
      if (!img.src) continue; // 跳过没有 src 的

      // 基础 URL 处理，移除可能的查询参数
      const baseUrl = img.src.split("?")[0];

      // 检查是否是支持的图片格式
      if (!/\.(jpe?g|png|webp|gif|jpg|bmp|tif)$/i.test(baseUrl)) continue; // 添加了 gif 支持，移除了末尾的 (\?.*)?$ 因为前面已分离

      // 优先使用 naturalWidth/Height，如果不可用则尝试 width/Height 属性
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      // 检查尺寸
      if (width > minWidth && height > minHeight) {
        uniqueSrcs.add(img.src); // 添加原始 src 到 Set
      }
    }
    links = Array.from(uniqueSrcs); // 从 Set 转换回数组
    console.log(`收集到 ${links.length} 个符合条件的图片链接`);
    showPopup(links);
  }

  // --- 弹出窗口显示链接和操作按钮 ---
  function showPopup(links) {
    // 移除旧的弹出窗口（如果存在）
    let oldOverlay = document.querySelector(".sht-popup-overlay");
    if (oldOverlay) {
      oldOverlay.remove();
    }

    // 创建遮罩层
    let overlay = document.createElement("div");
    overlay.className = "sht-popup-overlay";

    // 创建弹出窗口容器
    let popup = document.createElement("div");
    popup.className = "sht-popup-content";

    // 标题
    let title = document.createElement("h3");
    title.innerText = `图片链接列表 (${links.length} 张)`;
    popup.appendChild(title);

    // 文本区域：每行一个链接
    let textarea = document.createElement("textarea");
    textarea.readOnly = true; // 设为只读更合适
    textarea.value = links.join("\n");
    popup.appendChild(textarea);

    // 进度条
    let progressBarContainer = document.createElement("div");
    progressBarContainer.className = "sht-progress-bar";
    let progressBarInner = document.createElement("div");
    progressBarInner.className = "sht-progress-bar-inner";
    progressBarContainer.appendChild(progressBarInner);
    popup.appendChild(progressBarContainer); // 添加进度条到弹出窗口

    // 操作按钮容器
    let actionsDiv = document.createElement("div");
    actionsDiv.className = "sht-popup-actions";

    // 复制链接按钮
    let copyBtn = document.createElement("button");
    copyBtn.innerText = "复制链接";
    copyBtn.addEventListener("click", function () {
      GM_setClipboard(textarea.value);
      alert("链接已复制到剪贴板！");
    });
    actionsDiv.appendChild(copyBtn);

    // 一键下载所有图片按钮 (ZIP)
    let downloadBtn = document.createElement("button");
    downloadBtn.innerText = "下载所有图片 (ZIP)";
    downloadBtn.addEventListener("click", async function () {
      // 使用 async 函数
      if (!links || links.length === 0) {
        alert("没有图片链接可供下载。");
        return;
      }

      downloadBtn.disabled = true; // 禁用按钮防止重复点击
      copyBtn.disabled = true;
      closeBtn.disabled = true;
      downloadBtn.innerText = "准备下载... (0%)";
      progressBarContainer.style.display = "block"; // 显示进度条
      progressBarInner.style.width = "0%";
      progressBarInner.innerText = "0%";

      const zip = new JSZip();
      // 使用页面标题作为文件夹名 (清理非法字符)
      let title =
        document.title.replace(/[\\/:*?"<>|]/g, "_").trim() || "images";
      title = title.replace("Powered by Discuz!", "");
      let folderName = title;
      const imgFolder = zip.folder(folderName); // 在 ZIP 内创建文件夹
      console.log(`将在 ZIP 内创建文件夹: ${folderName}`);

      imgFolder.file("meta.txt", `title:${title}\n url: ${document.URL}`);

      let downloadedCount = 0;
      const totalImages = links.length;
      const failedDownloads = [];
      const filenames = new Set(); // 用于确保文件名唯一
      let totalDownloadedBytes = 0;

      // 定义一个函数来下载单个图片
      const downloadImage = (link, index) => {
        return new Promise((resolve, reject) => {
          console.log(`开始下载: ${link}`);
          GM_xmlhttpRequest({
            method: "GET",
            url: link,
            responseType: "arraybuffer",
            anonymous: false, // 尝试传递 cookie
            headers: {
              // 保持你原来的 headers
              dnt: "1",
              referer: "https://sehuatang.net/", // 重要，有些图床会检查 referer
              "sec-ch-ua": '"Not;A=Brand";v="24", "Chromium";v="128"',
              "sec-ch-ua-mobile": "?0",
              "sec-ch-ua-platform": '"Windows"',
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            },
            onload: function (response) {
              if (response.status >= 200 && response.status < 300) {
                console.log(`下载成功: ${link} (状态码: ${response.status})`);
                try {
                  // 生成文件名
                  let filename = link
                    .substring(link.lastIndexOf("/") + 1)
                    .split("?")[0];
                  // 如果文件名无效或太短，给一个默认的
                  if (
                    !filename ||
                    filename.length < 4 ||
                    !/\./.test(filename)
                  ) {
                    const extMatch = link.match(/\.(jpe?g|png|webp|gif)/i);
                    const ext = extMatch ? extMatch[0] : ".jpg"; // 默认 jpg
                    filename = `image_${String(index + 1).padStart(
                      3,
                      "0"
                    )}${ext}`;
                  }
                  // 保证文件名唯一性
                  let originalFilename = filename;
                  let counter = 1;
                  while (filenames.has(filename)) {
                    const namePart = originalFilename.substring(
                      0,
                      originalFilename.lastIndexOf(".")
                    );
                    const extPart = originalFilename.substring(
                      originalFilename.lastIndexOf(".")
                    );
                    filename = `${namePart}_${counter}${extPart}`;
                    counter++;
                  }
                  filenames.add(filename);
                  totalDownloadedBytes += response.response.byteLength;

                  // 添加到 zip
                  console.log(`将 ${filename} 存进 zip 中....`);
                  imgFolder.file(filename, response.response);
                  console.log(`添加 ${filename} 成功`);
                  resolve(link); // 成功时 resolve
                } catch (zipError) {
                  console.error(`添加到 ZIP 失败: ${link}`, zipError);
                  reject({
                    link: link,
                    error: "添加到 ZIP 失败: " + zipError.message,
                  });
                }
              } else {
                console.error(`下载失败 (状态码 ${response.status}): ${link}`);
                reject({ link: link, error: `HTTP 状态 ${response.status}` });
              }
            },
            onerror: function (err) {
              console.error(`下载网络错误: ${link}`, err);
              reject({ link: link, error: "网络错误" });
            },
            ontimeout: function () {
              console.error(`下载超时: ${link}`);
              reject({ link: link, error: "超时" });
            },
          });
        });
      };

      // 并发下载，但限制并发数量防止请求过多被阻止
      const concurrencyLimit = 12; // 例如，同时最多下载 12 张
      let promises = [];
      let currentIndex = 0;

      const run = async () => {
        while (currentIndex < totalImages) {
          while (
            promises.length < concurrencyLimit &&
            currentIndex < totalImages
          ) {
            const link = links[currentIndex];
            const index = currentIndex;
            currentIndex++;

            const promise = downloadImage(link, index)
              .then(
                (resolvedLink) => {
                  downloadedCount++;
                }, // 成功计数
                (rejection) => {
                  failedDownloads.push(rejection.link);
                } // 失败记录
              )
              .finally(() => {
                // 更新进度条
                const progress = Math.round(
                  ((downloadedCount + failedDownloads.length) / totalImages) *
                    100
                );
                progressBarInner.style.width = `${progress}%`;
                progressBarInner.innerText = `${progress}%`;
                downloadBtn.innerText = `处理中... (${progress}%)`;

                // 从 promises 数组中移除已完成的 promise
                const completedPromiseIndex = promises.findIndex(
                  (p) => p === promise
                );
                if (completedPromiseIndex > -1) {
                  promises.splice(completedPromiseIndex, 1);
                }
                // 启动下一个任务（如果还有）
                // 这里不需要显式调用 run()，因为 finally 会在 Promise 完成后执行，
                // 外层 while 循环会继续检查是否可以添加新任务。
              });
            promises.push(promise);
          }
          // 等待至少一个 Promise 完成，以便为新任务腾出空间
          if (promises.length >= concurrencyLimit) {
            await Promise.race(promises);
          }
        }
        // 等待所有正在进行的任务完成
        await Promise.allSettled(promises);
      };

      await run(); // 开始执行并发下载

      // 所有图片处理完成后
      console.log(
        `所有图片下载尝试完成。总图片大小 ${(
          totalDownloadedBytes /
          1024 /
          1024
        ).toFixed(2)} MB`
      );
      downloadBtn.innerText = "正在生成 ZIP...";
      console.log("正在生成 zip 压缩包。");

      if (downloadedCount === 0) {
        alert("没有图片成功下载，无法生成 ZIP 文件。");
        progressBarContainer.style.display = "none"; // 隐藏进度条
        downloadBtn.innerText = "下载所有图片 (ZIP)";
        downloadBtn.disabled = false; // 重新启用按钮
        copyBtn.disabled = false;
        closeBtn.disabled = false;
        return;
      }

      // --- 生成并下载 ZIP 文件 ---
      try {
        downloadBtn.innerText = "正在生成 ZIP...";
        progressBarInner.style.width = `100%`; // 可选，或使用 generateAsync 进度
        progressBarInner.innerText = `压缩中...`;

        console.log("准备调用 zip.generateAsync...");

        // ***修改点: 使用 .then() 和 saveAs ***
        zip
          .generateAsync(
            {
              type: "blob",
              compression: "DEFLATE",
              compressionOptions: { level: 6 },
            },
            (metadata) => {
              // Progress callback
              const zipProgress = Math.round(metadata.percent);
              console.log(`压缩进度: ${zipProgress}%`); // <-- Added log
              downloadBtn.innerText = `正在压缩... (${zipProgress}%)`;
              progressBarInner.style.width = `${zipProgress}%`;
              progressBarInner.innerText = `${zipProgress}%`;
              // zip.generateAsync({
              //     type: "blob" // NO compression options, NO progress callback initially
            }
          )
          .then(function (content) {
            console.log("zip.generateAsync .then() block reached."); // <-- Added log
            console.log("Blob 生成成功, 大小:", content.size); // <-- Log blob size
            console.log("准备调用 saveAs..."); // <-- Added log
            saveAs(content, `${folderName}.zip`); // 使用文件夹名作为 ZIP 文件名
            console.log("saveAs 调用完成."); // <-- Added log

            // 显示最终结果
            let zippedBytes = content.byteLength;
            let resultMessage = `ZIP 文件 (${folderName}.zip) 已开始下载！\n成功下载 ${downloadedCount} 张图片。`;
            if (failedDownloads.length > 0) {
              resultMessage += `\n${
                failedDownloads.length
              } 张图片下载失败:\n${failedDownloads.join("\n")}`;
              console.warn("以下图片下载失败:", failedDownloads);
            }
            resultMessage += `\n原始大小 ${(totalBytes / 1024 / 1024).toFixed(2)} MB\n`;
            resultMessage += `\n压缩后大小 ${(zippedBytes / 1024 / 1024).toFixed(2)} MB`;
            alert(resultMessage);
          })
          .catch(function (err) {
            // 处理 generateAsync 或 saveAs 的错误
            console.error("生成或下载 ZIP 文件时出错:", err);
            alert("生成或下载 ZIP 文件时出错: " + err.message);
          })
          .finally(() => {
            // 恢复按钮状态
            progressBarContainer.style.display = "none"; // 隐藏进度条
            downloadBtn.innerText = "下载所有图片 (ZIP)";
            downloadBtn.disabled = false;
            copyBtn.disabled = false;
            closeBtn.disabled = false;
          });
      } catch (err) {
        // 这个 catch 主要捕获同步代码错误 (例如 folderName 处理等)
        console.error("准备生成 ZIP 时出错:", err);
        alert("准备生成 ZIP 时出错: " + err.message);
        // 恢复按钮状态
        progressBarContainer.style.display = "none";
        downloadBtn.innerText = "下载所有图片 (ZIP)";
        downloadBtn.disabled = false;
        copyBtn.disabled = false;
        closeBtn.disabled = false;
      }
    });
    actionsDiv.appendChild(downloadBtn);

    // 关闭按钮
    let closeBtn = document.createElement("button");
    closeBtn.innerText = "关闭";
    closeBtn.addEventListener("click", function () {
      document.body.removeChild(overlay);
    });
    actionsDiv.appendChild(closeBtn);

    popup.appendChild(actionsDiv); // 添加按钮容器到弹出窗口
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
  }
})();
