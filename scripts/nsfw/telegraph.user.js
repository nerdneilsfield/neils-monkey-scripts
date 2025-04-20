// ==UserScript==
// @name         Telegraph 下载助手
// @namespace    http://tampermonkey.net/
// @version      2025-04-21
// @description  收集 telegraph.ph 页面图片链接并打包下载为 ZIP 文件
// @author       nerdneilsfield <dengqi935@gmail.com>
// @match        https://telegra.ph/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=telegra.ph
// @require      https://cdn.jsdelivr.net/npm/jszip@3.9.1/dist/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.0/FileSaver.min.js
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/nfw/telegraph.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/nfw/telegraph.user.js
// ==/UserScript==

/* global JSZip */ // 告诉 linter JSZip 是全局可用的 (通过 @require 引入)
/* global saveAs */ // 告诉 linter saveAs 是全局可用的 (通过 @require 引入)

(function () {
  "use strict";

  // 样式
  GM_addStyle(`
        .tph-popup-overlay { position: fixed; top: 0; left: 0; width:100%; height:100%; background-color: rgba(0,0,0,0.5); z-index:10000; display:flex; justify-content:center; align-items:center; }
        .tph-popup-content { background-color:#fff; padding:20px; border-radius:5px; max-width:80%; max-height:80%; overflow-y:auto; display:flex; flex-direction:column; box-shadow:0 4px 8px rgba(0,0,0,0.2); }
        .tph-popup-content textarea { width:100%; flex:1; margin-bottom:10px; box-sizing:border-box; }
        .tph-popup-actions { display:flex; justify-content:flex-end; margin-top:10px; }
        .tph-popup-actions button { margin-left:10px; padding:8px 12px; cursor:pointer; }
        .tph-fixed-button { position: fixed; bottom: 20px; right: 20px; z-index: 9999; padding:10px 15px; background-color:#007BFF; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:14px; box-shadow:0 2px 5px rgba(0,0,0,0.2); }
        .tph-progress-bar { width:100%; background-color:#f3f3f3; border-radius:3px; height:10px; margin-top:5px; overflow:hidden; display:none; }
        .tph-progress-bar-inner { width:0%; height:100%; background-color:#4CAF50; text-align:center; line-height:10px; color:#fff; font-size:8px; transition:width 0.2s ease-in-out; }
    `);

  // 创建按钮
  let fixedButton = document.createElement("button");
  fixedButton.innerText = "下载图片";
  fixedButton.className = "tph-fixed-button";
  document.body.appendChild(fixedButton);
  fixedButton.addEventListener("click", collectImages);

  function collectImages() {
    // 获取文章标题
    let titleEl = document.querySelector("main.tl_article_header h1");
    let title = titleEl ? titleEl.innerText.trim() : document.title;
    let folderName = title.replace(/[\\/:*?"<>|]/g, "_");

    const zip = new JSZip();

    const imgFolder = zip.folder(folderName); // 在 ZIP 内创建文件夹
    console.log(`将在 ZIP 内创建文件夹: ${folderName}`);

    imgFolder.file(
      "meta.txt",
      `title:${title}\nurl: ${document.URL}\ndate:${new Date().toISOString()}`
    );

    // 收集图片链接
    let imgs = Array.from(document.querySelectorAll("main.tl_article img")).map(
      (img) => img.src
    );
    if (imgs.length === 0) {
      alert("未找到图片");
      return;
    }
    showPopup(imgs, folderName, zip, imgFolder);
  }

  function showPopup(links, folderName, zip, imgFolder) {
    // 创建覆盖层和弹窗
    let overlay = document.createElement("div");
    overlay.className = "tph-popup-overlay";
    let popup = document.createElement("div");
    popup.className = "tph-popup-content";

    // 标题
    let title = document.createElement("h3");
    title.innerText = `图片链接列表 (${links.length} 张)`;
    popup.appendChild(title);
    // 文本区域
    let textarea = document.createElement("textarea");
    textarea.value = links.join("\n");
    popup.appendChild(textarea);
    // 进度条
    let progressBar = document.createElement("div");
    progressBar.className = "tph-progress-bar";
    let progressBarInner = document.createElement("div");
    progressBarInner.className = "tph-progress-bar-inner";
    progressBar.appendChild(progressBarInner);
    popup.appendChild(progressBar);
    // 操作按钮
    let actions = document.createElement("div");
    actions.className = "tph-popup-actions";
    // 复制链接
    let copyBtn = document.createElement("button");
    copyBtn.innerText = "复制链接";
    copyBtn.addEventListener("click", () => {
      GM_setClipboard(textarea.value);
      alert("链接已复制到剪贴板");
    });
    actions.appendChild(copyBtn);
    // 下载ZIP
    let downloadBtn = document.createElement("button");
    downloadBtn.innerText = "下载所有图片 (ZIP)";
    downloadBtn.addEventListener("click", () => {
      let totalBytes = 0;
      downloadBtn.disabled = true;
      copyBtn.disabled = true;
      let downloaded = 0;
      let failed = [];
      progressBar.style.display = "block";
      links.forEach((url, idx) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "blob",
          onload(res) {
            imgFolder.file(`${idx + 1}_${url.split("/").pop()}`, res.response);
            downloaded++;
            totalBytes += res.response.byteLength;
            update();
          },
          onerror() {
            failed.push(url);
            update();
          },
          ontimeout() {
            failed.push(url);
            update();
          },
        });
      });
      function update() {
        let done = downloaded + failed.length;
        let pct = Math.round((done / links.length) * 100);
        progressBarInner.style.width = `${pct}%`;
        progressBarInner.innerText = `${pct}%`;
        if (done === links.length) generate();
      }
      function generate() {
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
            }
          )
          .then((content) => {
            saveAs(content, `${folderName}.zip`);
            let zippedBytes = content.byteLength;
            let resultMessage = `ZIP 文件 (${folderName}.zip) 已开始下载！\n成功下载 ${downloaded} 张图片。`;
            if (failed.length > 0) {
              resultMessage += `\n${
                failed.length
              } 张图片下载失败:\n${failed.join("\n")}`;
            }
            resultMessage += `\n原始大小 ${(totalBytes / 1024 / 1024).toFixed(
              2
            )} MB\n`;
            resultMessage += `\n压缩后大小 ${(
              zippedBytes /
              1024 /
              1024
            ).toFixed(2)} MB`;
            alert(resultMessage);
            closeOverlay();
          })
          .catch((e) => {
            console.error(e);
            alert("生成或下载 ZIP 文件时出错: " + e.message);
            closeOverlay();
          });
      }
    });
    actions.appendChild(downloadBtn);
    // 关闭
    let closeBtn = document.createElement("button");
    closeBtn.innerText = "关闭";
    closeBtn.addEventListener("click", () => closeOverlay());
    actions.appendChild(closeBtn);
    popup.appendChild(actions);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    function closeOverlay() {
      document.body.removeChild(overlay);
    }
  }
})();
