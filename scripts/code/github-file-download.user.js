// ==UserScript==
// @name         GitHub 文件夹/文件 Zip 下载器
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  在 GitHub 仓库页面添加选择并打包下载文件/文件夹的功能
// @author       nerdneilsfield <dengqi935@gmail.com>
// @match        https://github.com/*
// @grant        GM_addStyle
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.9.1/jszip.min.js
// ==/UserScript==

(function () {
  "use strict";

  GM_addStyle(`
        .gh-fixed-button {
            position: fixed; bottom: 20px; right: 20px; z-index: 9999;
            padding: 10px 15px; background-color: #007BFF; color: #fff;
            border: none; border-radius: 5px; cursor: pointer; font-size: 14px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        }
    `)

  // 页面加载完成后初始化
  window.addEventListener("load", init);

  function init() {
    // 检查是否在 GitHub 仓库页面
    if (!isRepositoryPage()) return;

    // 等待 GitHub 动态内容完全加载
    setTimeout(() => {
      // 添加 UI 元素
      addUI();
    }, 1000);
  }

  // 检查是否在 GitHub 仓库页面
  function isRepositoryPage() {
    return (
      window.location.pathname.split("/").length >= 3 &&
      (document.querySelector(".js-repo-root") !== null ||
        document.querySelector(".repository-content") !== null)
    );
  }

  // 添加 UI 元素
  function addUI() {
    // 添加按钮以启用选择模式
    addSelectionButton();
  }

  // 添加启用选择模式的按钮
  function addSelectionButton() {
    
    // let overlay = document.createElement("div");
    // overlay.className = "sht-popup-overlay";
   

    // 创建按钮
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn ml-2 d-none d-md-block gh-fixed-button";
    button.innerHTML = `
            <svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-file-zip mr-1">
                <path fill-rule="evenodd" d="M3.5 1.75a.25.25 0 01.25-.25h3a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h2.5a.25.25 0 01.25.25v12.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V1.75zM8.75 4.75a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5zM6 7.75A.75.75 0 016.75 7h.5a.75.75 0 010 1.5h-.5A.75.75 0 016 7.75zm2 1.5a.75.75 0 000 1.5h.5a.75.75 0 000-1.5h-.5z"></path>
            </svg>
            选择并打包
        `;
    button.id = "gh-zip-select-btn";
    button.addEventListener("click", enableSelectionMode);

    // overlay.append(button);
    document.body.append(button);
  }

  // 启用选择模式
  function enableSelectionMode() {
    // 隐藏选择按钮
    document.getElementById("gh-zip-select-btn").style.display = "none";

    // 添加文件和文件夹的复选框
    addCheckboxes();

    // 添加控制按钮（下载、全选、取消）
    addControlButtons();
  }

  // 添加文件和文件夹的复选框
  function addCheckboxes() {
    // 获取文件/文件夹表格
    const table = document.querySelector(".js-navigation-container");
    if (!table) return;

    // 添加复选框样式
    const style = document.createElement("style");
    style.innerHTML = `
            .gh-zip-checkbox {
                margin-right: 5px;
                cursor: pointer;
            }
            .gh-zip-progress {
                position: fixed;
                top: 10px;
                right: 10px;
                padding: 10px;
                background-color: #f6f8fa;
                border: 1px solid #e1e4e8;
                border-radius: 6px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.12);
                z-index: 1000;
                max-height: 80vh;
                overflow-y: auto;
            }
            .gh-zip-spinner {
                display: inline-block;
                width: 16px;
                height: 16px;
                border: 2px solid rgba(0,0,0,0.1);
                border-top: 2px solid #0366d6;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
    document.head.appendChild(style);

    // 获取所有文件/文件夹行
    const rows = table.querySelectorAll(".js-navigation-item");

    rows.forEach((row) => {
      // 跳过父目录（..）条目
      if (row.querySelector(".octicon-reply")) return;

      // 获取项目名称、路径和类型
      const link = row.querySelector(".js-navigation-open");
      if (!link) return;

      const itemName = link.textContent.trim();
      const isFolder = row.querySelector('[aria-label="Directory"]') !== null;

      // 从 href 提取路径
      const href = link.getAttribute("href") || "";
      let itemPath = "";

      if (isFolder) {
        const match = href.match(/\/tree\/[^\/]+\/(.+)/);
        if (match) itemPath = match[1];
      } else {
        const match = href.match(/\/blob\/[^\/]+\/(.+)/);
        if (match) itemPath = match[1];
      }

      // 如果无法从 href 提取路径，则从当前位置构建它
      if (!itemPath) {
        const currentPath = getCurrentPath();
        itemPath = currentPath ? `${currentPath}/${itemName}` : itemName;
      }

      // 创建复选框
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "gh-zip-checkbox";
      checkbox.dataset.name = itemName;
      checkbox.dataset.path = itemPath;
      checkbox.dataset.isFolder = isFolder.toString();

      // 找到插入复选框的位置
      const iconCell = row.querySelector(".icon");
      if (iconCell) {
        iconCell.style.position = "relative";
        iconCell.insertBefore(checkbox, iconCell.firstChild);
      }
    });
  }

  // 添加控制按钮
  function addControlButtons() {
    // 查找文件导航栏
    const fileNav = document.querySelector(".file-navigation");
    if (!fileNav) return;

    // 创建控制按钮容器
    const btnContainer = document.createElement("div");
    btnContainer.className = "BtnGroup ml-2";
    btnContainer.id = "gh-zip-controls";

    // 创建全选按钮
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "btn btn-sm";
    selectAllBtn.innerHTML = "全选";
    selectAllBtn.addEventListener("click", () => {
      const checkboxes = document.querySelectorAll(".gh-zip-checkbox");
      checkboxes.forEach((cb) => (cb.checked = true));
    });

    // 创建取消按钮
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-sm";
    cancelBtn.innerHTML = "取消";
    cancelBtn.addEventListener("click", () => {
      // 移除复选框
      document
        .querySelectorAll(".gh-zip-checkbox")
        .forEach((cb) => cb.remove());

      // 移除控制按钮
      document.getElementById("gh-zip-controls").remove();

      // 再次显示选择按钮
      document.getElementById("gh-zip-select-btn").style.display = "";
    });

    // 创建下载按钮
    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "btn btn-primary btn-sm";
    downloadBtn.innerHTML = `
            <svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-desktop-download mr-1">
                <path fill-rule="evenodd" d="M7.47 10.78a.75.75 0 001.06 0l3.75-3.75a.75.75 0 00-1.06-1.06L8.75 8.44V1.75a.75.75 0 00-1.5 0v6.69L4.78 5.97a.75.75 0 00-1.06 1.06l3.75 3.75zM3.75 13a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5z"></path>
            </svg>
            下载 Zip
        `;
    downloadBtn.addEventListener("click", handleDownload);

    // 将按钮添加到容器
    btnContainer.appendChild(selectAllBtn);
    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(downloadBtn);

    // 将容器添加到文件导航栏
    fileNav.appendChild(btnContainer);
  }

  // 处理下载按钮点击
  async function handleDownload() {
    const selectedCheckboxes = document.querySelectorAll(
      ".gh-zip-checkbox:checked"
    );

    if (selectedCheckboxes.length === 0) {
      alert("请至少选择一个文件或文件夹进行下载");
      return;
    }

    // 对于大量选择项提示 API 速率限制警告
    if (selectedCheckboxes.length > 50) {
      const confirmDownload = confirm(
        "您选择了很多项目。GitHub API 对未认证用户有速率限制（每小时 60 个请求），" +
          "下载大量文件或文件夹时可能会出错。是否继续？"
      );

      if (!confirmDownload) return;
    }

    // 创建进度显示
    const progressDiv = document.createElement("div");
    progressDiv.className = "gh-zip-progress";
    progressDiv.innerHTML = `
            <h3>创建 Zip 文件...</h3>
            <div id="gh-zip-status">初始化...</div>
            <div id="gh-zip-items" style="margin-top: 10px; max-height: 300px; overflow-y: auto;"></div>
        `;
    document.body.appendChild(progressDiv);

    try {
      // 创建新的 JSZip 实例
      const zip = new JSZip();

      // 获取仓库信息
      const repoInfo = getRepositoryInfo();

      // 更新状态
      document.getElementById("gh-zip-status").textContent =
        "正在处理选定项...";

      // 处理每个选定项
      const itemsList = document.getElementById("gh-zip-items");
      let processedCount = 0;
      let totalFiles = 0;

      // 首先处理所有文件（非文件夹）
      const files = Array.from(selectedCheckboxes).filter(
        (cb) => cb.dataset.isFolder === "false"
      );
      totalFiles += files.length;

      for (const checkbox of files) {
        const path = checkbox.dataset.path;

        // 添加此文件的状态
        const itemDiv = document.createElement("div");
        itemDiv.textContent = `正在处理文件: ${path}`;
        itemsList.appendChild(itemDiv);

        try {
          await processFile(zip, path, repoInfo);
          itemDiv.textContent = `✓ ${path}`;
          processedCount++;
        } catch (error) {
          itemDiv.textContent = `❌ 错误: ${path} - ${error.message}`;
          itemDiv.style.color = "red";
        }

        // 更新总体状态
        document.getElementById(
          "gh-zip-status"
        ).textContent = `处理中... ${processedCount}/${totalFiles} 个文件已完成`;
      }

      // 然后处理文件夹
      const folders = Array.from(selectedCheckboxes).filter(
        (cb) => cb.dataset.isFolder === "true"
      );

      for (const checkbox of folders) {
        const path = checkbox.dataset.path;

        // 添加此文件夹的状态
        const folderDiv = document.createElement("div");
        folderDiv.textContent = `正在处理文件夹: ${path}`;
        itemsList.appendChild(folderDiv);

        try {
          const filesBefore = processedCount;
          await processFolder(zip, path, repoInfo, folderDiv, (count) => {
            totalFiles += count;
            processedCount += count;
            document.getElementById(
              "gh-zip-status"
            ).textContent = `处理中... ${processedCount}/${totalFiles} 个文件已完成`;
          });
          folderDiv.textContent = `✓ 文件夹: ${path} (${
            processedCount - filesBefore
          } 个文件)`;
        } catch (error) {
          folderDiv.textContent = `❌ 文件夹错误: ${path} - ${error.message}`;
          folderDiv.style.color = "red";
        }
      }

      // 更新状态
      document.getElementById("gh-zip-status").textContent =
        "正在生成 zip 文件...";

      // 生成 zip
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      // 创建下载链接
      const zipName = `${repoInfo.repo}-selected.zip`;
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // 最后更新状态
      document.getElementById("gh-zip-status").textContent = "下载完成！";
      setTimeout(() => {
        document.body.removeChild(progressDiv);
      }, 3000);
    } catch (error) {
      console.error("创建 zip 错误:", error);
      document.getElementById(
        "gh-zip-status"
      ).textContent = `错误: ${error.message}`;
    }
  }

  // 获取仓库中的当前路径
  function getCurrentPath() {
    // 从 URL 提取路径
    const match = window.location.pathname.match(
      /\/[^\/]+\/[^\/]+\/tree\/[^\/]+\/(.+)/
    );
    return match ? match[1] : "";
  }

  // 获取仓库信息
  function getRepositoryInfo() {
    const pathParts = window.location.pathname.split("/");
    const owner = pathParts[1];
    const repo = pathParts[2];

    // 确定分支
    let branch = "main"; // 默认值

    // 尝试从 URL 中提取分支
    const branchMatch = window.location.pathname.match(/\/tree\/([^\/]+)/);
    if (branchMatch) {
      branch = branchMatch[1];
    } else {
      // 尝试从 UI 元素获取
      const branchElem = document.querySelector(
        ".css-truncate-target[data-branch-name], .branch-name"
      );
      if (branchElem) {
        branch = branchElem.textContent.trim();
      }
    }

    // 获取当前路径
    const currentPath = getCurrentPath();

    return { owner, repo, branch, currentPath };
  }

  // 处理文件
  async function processFile(zip, filePath, repoInfo) {
    const { owner, repo, branch } = repoInfo;

    // 构建原始 URL
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

    try {
      // 获取文件
      const response = await fetch(rawUrl);

      if (!response.ok) {
        throw new Error(`HTTP 错误 ${response.status}`);
      }

      // 获取文件内容作为 ArrayBuffer
      const content = await response.arrayBuffer();

      // 添加到 zip
      zip.file(filePath, content);

      return true;
    } catch (error) {
      console.error(`获取文件 ${filePath} 出错:`, error);
      throw error;
    }
  }

  // 处理文件夹
  async function processFolder(
    zip,
    folderPath,
    repoInfo,
    statusElement,
    updateTotals
  ) {
    const { owner, repo, branch } = repoInfo;

    // 使用 GitHub API 获取文件夹内容
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${folderPath}?ref=${branch}`;

    try {
      // 获取文件夹内容
      const response = await fetch(apiUrl);

      if (!response.ok) {
        // 检查速率限制
        if (response.status === 403) {
          const rateLimitRemaining = response.headers.get(
            "X-RateLimit-Remaining"
          );
          const rateLimitReset = response.headers.get("X-RateLimit-Reset");

          if (rateLimitRemaining === "0" && rateLimitReset) {
            const resetDate = new Date(parseInt(rateLimitReset) * 1000);
            throw new Error(
              `GitHub API 速率限制已达到。将在 ${resetDate.toLocaleTimeString()} 重置`
            );
          }
        }

        throw new Error(`HTTP 错误 ${response.status}`);
      }

      // 解析响应
      const items = await response.json();

      if (!Array.isArray(items)) {
        throw new Error("无效的 API 响应");
      }

      // 在 zip 中创建文件夹
      zip.folder(folderPath);

      // 处理每个项目
      let fileCount = 0;
      const fileItems = items.filter((item) => item.type === "file");
      const folderItems = items.filter((item) => item.type === "dir");

      // 使用项目计数更新状态
      if (statusElement) {
        statusElement.textContent = `正在处理文件夹: ${folderPath} (${fileItems.length} 个文件, ${folderItems.length} 个子文件夹)`;
      }

      // 先处理文件
      if (fileItems.length > 0) {
        // 更新总数回调
        if (updateTotals) updateTotals(fileItems.length);

        for (const item of fileItems) {
          try {
            await processFile(zip, item.path, repoInfo);
            fileCount++;
          } catch (error) {
            console.error(`处理文件 ${item.path} 出错:`, error);
            // 添加错误状态
            const errorDiv = document.createElement("div");
            errorDiv.textContent = `❌ 错误: ${item.path} - ${error.message}`;
            errorDiv.style.color = "red";
            errorDiv.style.marginLeft = "20px";
            if (statusElement && statusElement.parentNode) {
              statusElement.parentNode.insertBefore(
                errorDiv,
                statusElement.nextSibling
              );
            }
          }
        }
      }

      // 然后处理子文件夹
      for (const folder of folderItems) {
        // 创建子文件夹状态元素
        const subfolderDiv = document.createElement("div");
        subfolderDiv.textContent = `正在处理子文件夹: ${folder.path}`;
        subfolderDiv.style.marginLeft = "20px";
        if (statusElement && statusElement.parentNode) {
          statusElement.parentNode.insertBefore(
            subfolderDiv,
            statusElement.nextSibling
          );
        }

        try {
          // 递归处理子文件夹
          const subfolderCount = await processFolder(
            zip,
            folder.path,
            repoInfo,
            subfolderDiv,
            updateTotals
          );
          fileCount += subfolderCount;
          subfolderDiv.textContent = `✓ 子文件夹: ${folder.path}`;
        } catch (error) {
          console.error(`处理子文件夹 ${folder.path} 出错:`, error);
          subfolderDiv.textContent = `❌ 子文件夹错误: ${folder.path} - ${error.message}`;
          subfolderDiv.style.color = "red";
        }
      }

      return fileCount;
    } catch (error) {
      console.error(`处理文件夹 ${folderPath} 出错:`, error);
      throw error;
    }
  }
})();
