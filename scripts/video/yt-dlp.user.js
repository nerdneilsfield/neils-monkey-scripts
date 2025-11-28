// ==UserScript==
// @name         YouTube yt-dlp Link Generator
// @namespace    http://tampermonkey.net/
// @version      0.7
// @description  视频下方注入下载按钮：最高画质 MP4/MP3 & 播放列表批量下载，灰白风格美化
// @match        https://www.youtube.com/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @downloadURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/video/yt-dlp.user.js
// @updateURL https://github.com/nerdneilsfield/neils-monkey-scripts/raw/refs/heads/master/scripts/video/yt-dlp.user.js
// ==/UserScript==

(function() {
        'use strict';
    
        // —— 插入自定义样式 ——
        const style = document.createElement('style');
        style.textContent = `
        .ytdlp-container {
            display: inline-flex;
            gap: 8px;
            margin-right: 8px;
        }
        .ytdlp-btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            padding: 0 16px;
            height: 36px;
            background-color: rgba(0, 0, 0, 0.05);
            color: #0f0f0f;
            border: none;
            border-radius: 18px;
            font-family: "Roboto", "Arial", sans-serif;
            font-size: 14px;
            font-weight: 500;
            line-height: 36px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background-color 0.2s;
        }
        .ytdlp-btn:hover {
            background-color: rgba(0, 0, 0, 0.1);
        }
        .ytdlp-btn:active {
            background-color: rgba(0, 0, 0, 0.15);
        }
        @media (prefers-color-scheme: dark) {
            .ytdlp-btn {
                background-color: rgba(255, 255, 255, 0.1);
                color: #f1f1f1;
            }
            .ytdlp-btn:hover {
                background-color: rgba(255, 255, 255, 0.15);
            }
            .ytdlp-btn:active {
                background-color: rgba(255, 255, 255, 0.2);
            }
        }
        `;
        document.head.appendChild(style);
    
        // —— 按钮创建函数 ——
        function addBtn(container, id, label, cmd) {
            if (document.getElementById(id)) return; // 防重复
            const btn = document.createElement('button');
            btn.id = id;
            btn.className = 'ytdlp-btn';
            btn.textContent = label;
            btn.onclick = () => {
                GM_setClipboard(cmd);
                alert('已复制：' + label);
            };
            container.appendChild(btn);
        }
    
        // —— 注入逻辑 ——
        function inject() {
            const params = new URLSearchParams(window.location.search);
            const vid  = params.get('v');
            const list = params.get('list');
            if (!vid) return;  // 不是视频页就跳过

            // 按钮容器只插入一次
            if (document.getElementById('ytdlp-container')) return;

            // 构建基础链接
            const videoURL = `https://www.youtube.com/watch?v=${vid}`;
            const listURL  = window.location.href.split('#')[0]; // 保留 list= 参数

            // 找到按钮区域（适配新版 YouTube 结构）
            const menuRenderer = document.querySelector('ytd-menu-renderer.style-scope.ytd-watch-metadata #top-level-buttons-computed');
            if (!menuRenderer) return;

            // 容器
            const container = document.createElement('div');
            container.id = 'ytdlp-container';
            container.className = 'ytdlp-container';

            // 普通视频：2 个按钮
            addBtn(container, 'ytdlp-mp4', '下载 本视频（MP4）',
                   `yt-dlp -f bestvideo[ext=mp4]+bestaudio[ext=m4a] --merge-output-format mp4 "${videoURL}"`);
            addBtn(container, 'ytdlp-mp3', '下载 本视频（MP3）',
                   `yt-dlp -f bestaudio --extract-audio --audio-format mp3 "${videoURL}"`);

            // 列表内视频：再加 2 个批量下载按钮
            if (list) {
                addBtn(container, 'ytdlp-list-mp4', '下载 播放列表（MP4）',
                       `yt-dlp -f bestvideo[ext=mp4]+bestaudio[ext=m4a] --merge-output-format mp4 --yes-playlist "${listURL}"`);
                addBtn(container, 'ytdlp-list-mp3', '下载 播放列表（MP3）',
                       `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --yes-playlist "${listURL}"`);
            }

            // 插入到按钮组的最前面
            menuRenderer.insertBefore(container, menuRenderer.firstChild);
        }
    
        // —— 监听 SPA 导航 & DOM 变化 ——
        const obs = new MutationObserver(() => inject());
        obs.observe(document.body, { childList: true, subtree: true });
    })();
    