// ==UserScript==
// @name         YouTube yt-dlp Link Generator
// @namespace    http://tampermonkey.net/
// @version      0.4
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
            display: flex;
            flex-wrap: wrap;
            margin-top: 8px;
        }
        .ytdlp-btn {
            margin: 4px 8px 0 0;
            padding: 6px 12px;
            background-color: #f1f1f1;
            color: #000;
            border: 1px solid #ccc;
            border-radius: 3px;
            font-size: 14px;
            cursor: pointer;
            transition: background-color .2s;
        }
        .ytdlp-btn:hover {
            background-color: #e2e2e2;
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
    
            // 找到标题下方的 info 区域
            const info = document.querySelector('#info-contents, #meta-contents ytd-watch-metadata');
            if (!info) return;
    
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
    
            // 插入到 info 区域后
            info.parentNode.insertBefore(container, info.nextSibling);
        }
    
        // —— 监听 SPA 导航 & DOM 变化 ——
        const obs = new MutationObserver(() => inject());
        obs.observe(document.body, { childList: true, subtree: true });
    })();
    