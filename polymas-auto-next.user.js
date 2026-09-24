// ==UserScript==
// @name         苏州大学网课自动播放
// @namespace    local.polymas.auto-next
// @version      1.2.2
// @author       Hanratty211
// @license      MIT
// @homepageURL  https://github.com/Hanratty211/soochow-university-course-autoplay
// @supportURL   https://github.com/Hanratty211/soochow-university-course-autoplay/issues
// @downloadURL  https://raw.githubusercontent.com/Hanratty211/soochow-university-course-autoplay/main/polymas-auto-next.user.js
// @updateURL    https://raw.githubusercontent.com/Hanratty211/soochow-university-course-autoplay/main/polymas-auto-next.user.js
// @description  进入视频页后启动播放，正常结束后打开下一节，支持暂停与同源 iframe。
// @match        https://hike-teaching-center.polymas.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (window.__POLYMAS_AUTO_NEXT__) return;

  // 若平台更新，可在这里填入实际页面的 CSS 选择器；留空时自动识别。
  const CONFIG = {
    nextButtonSelector: '',
    resourceRowSelector: '',
    startButtonSelector: '.vjs-big-play-button, .prism-big-play-btn, .dplayer-play-icon, .xgplayer-start, xg-start, .plyr__control--overlaid',
    lockedSelector: '[aria-disabled="true"], [disabled], [data-icon="lock"], .anticon-lock, .el-icon-lock, [class*="icon-lock"], [class*="icon_lock"]',
    unlockTimeout: 90000,
    playerTimeout: 30000,
    catalogReloadDelay: 2500,
    reloadPage: () => location.reload(),
  };
  const STORAGE_KEY = 'soochow-course-autoplay-state-v1';
  const loadSaved = () => {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch { return {}; }
  };
  const saved = loadSaved();
  const state = {
    enabled: saved.enabled !== false,
    current: typeof saved.current === 'string' ? saved.current : '',
    order: Array.isArray(saved.order) ? saved.order.filter(item => typeof item === 'string') : [],
    returnAfterEnd: saved.returnAfterEnd === true,
    completed: typeof saved.completed === 'string' ? saved.completed : '',
    catalogReloadAttempted: saved.catalogReloadAttempted === true,
    pending: null,
    switching: false, generation: 0, blockedVideo: null, stopped: false,
    catalogWaitStarted: Date.now(), catalogReloadScheduled: false,
  };
  const videoHandlers = new Map();
  const handledEnds = new WeakMap();
  const documents = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
  const filename = text => {
    const value = normalize(text);
    if (value.length > 260 || (value.match(/\.mp4\b/gi) || []).length !== 1) return '';
    const match = value.match(/(?:\[[\d.]+\]\s*)?[^\n]*?\.mp4\b/i);
    return match ? match[0].replace(/^(?:必学|选学)\s*/, '').trim() : '';
  };
  const lessonKey = text => normalize(text)
    .replace(/^(?:必学|选学)\s*/, '')
    .replace(/\.mp4\b/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  const sameLesson = (left, right) => !!left && !!right && lessonKey(left) === lessonKey(right);
  const isDetailPage = () => /\/resource-detail(?:\/|$)/.test(location.pathname);
  const saveState = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: state.enabled,
        current: state.current,
        order: state.order,
        returnAfterEnd: state.returnAfterEnd,
        completed: state.completed,
        catalogReloadAttempted: state.catalogReloadAttempted,
      }));
    } catch { /* 存储被禁用时仍可在单页内工作。 */ }
  };
  const visible = element => !!element?.isConnected && !!element.getClientRects().length &&
    element.ownerDocument.defaultView.getComputedStyle(element).visibility !== 'hidden';
  const signature = video => video.currentSrc || video.getAttribute('src') || video.querySelector('source')?.src || '';
  const alive = generation => state.enabled && !state.stopped && generation === state.generation;

  const panel = document.createElement('div');
  panel.id = 'polymas-auto-next-panel';
  panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:280px;padding:14px;border:1px solid #dbe3ef;border-radius:12px;background:#fff;color:#172b4d;box-shadow:0 4px 24px #0002;font:13px/1.6 system-ui,sans-serif;text-align:left';
  panel.innerHTML = '<b>视频自动续播</b><div data-status style="margin:8px 0;overflow-wrap:anywhere"></div><button data-toggle type="button">暂停续播</button> <button data-play type="button" hidden>点击播放</button><div style="font-size:11px;color:#667085;margin-top:8px">首次使用，请从目录手动打开一节视频。</div>';
  document.body.appendChild(panel);
  const status = panel.querySelector('[data-status]');
  const toggle = panel.querySelector('[data-toggle]');
  const play = panel.querySelector('[data-play]');
  const report = message => { status.textContent = message; console.info('[自动续播]', message); };

  function getDocuments(root = document, result = [], seen = new Set()) {
    if (seen.has(root)) return result;
    seen.add(root);
    result.push(root);
    for (const frame of root.querySelectorAll('iframe')) {
      try { if (frame.contentDocument) getDocuments(frame.contentDocument, result, seen); } catch { /* 跨域播放器不能直接读取。 */ }
    }
    return result;
  }

  function rowFor(label) {
    if (CONFIG.resourceRowSelector) return label.closest(CONFIG.resourceRowSelector) || label;
    let row = label;
    for (let parent = label.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth++) {
      if (parent === label.ownerDocument.body || parent.getBoundingClientRect().height > 150) break;
      if ((parent.textContent.match(/\.mp4\b/gi) || []).length !== 1) break;
      row = parent;
      if (parent.matches('li, [role="listitem"], [role="treeitem"]')) break;
    }
    return row;
  }

  function rows() {
    const result = [];
    const names = new Set();
    for (const doc of getDocuments()) {
      const elements = doc.querySelectorAll(CONFIG.resourceRowSelector || 'a, span, div, p, li, button');
      for (const element of elements) {
        if (panel.contains(element) || !visible(element)) continue;
        // 只使用最内层标题，避免将章节容器误认为一节课。
        if (!CONFIG.resourceRowSelector && [...element.children].some(child => filename(child.textContent))) continue;
        const name = filename(element.textContent);
        if (!name || names.has(name)) continue;
        names.add(name);
        result.push({ name, label: element, row: rowFor(element) });
      }
    }
    return result;
  }

  function rememberOrder(items) {
    // 弹窗可能只显示当前标题，不能用它覆盖完整目录。
    if (items.length >= 2 && items.some(item => item.name === state.current)) {
      state.order = items.map(item => item.name);
      saveState();
    }
  }

  function inferCurrentFromPage() {
    if (state.current) {
      const pageText = normalize(document.body?.innerText || document.body?.textContent);
      if (!isDetailPage() || pageText.includes(state.current.replace(/\.mp4\b/i, ''))) return state.current;
    }
    const candidates = [...document.querySelectorAll('h1, h2, h3, header, [class*="title"], [class*="name"]')]
      .filter(element => visible(element) && !panel.contains(element))
      .map(element => normalize(element.textContent))
      .filter(text => text && text.length <= 180);
    if (!candidates.some(text => /\[[\d.]+\]/.test(text))) {
      candidates.push(...[...document.body.querySelectorAll('*')]
        .filter(element => visible(element) && !panel.contains(element) &&
          ![...element.children].some(child => /\[[\d.]+\]/.test(normalize(child.textContent))))
        .map(element => normalize(element.textContent))
        .filter(text => /^\[[\d.]+\]\s*\S/.test(text) && text.length <= 180));
    }
    const known = state.order.find(name => candidates.some(text => text.includes(name.replace(/\.mp4\b/i, ''))));
    if (known) return known;
    const numbered = candidates.find(text => /\[[\d.]+\]/.test(text));
    return numbered ? numbered.replace(/\s*(?:必学|选学)\s*$/, '').trim() : '';
  }

  function locked(element) {
    if (element.matches(CONFIG.lockedSelector) || element.querySelector(CONFIG.lockedSelector)) return true;
    if (/(?:^|\s)(?:is-)?(?:locked|disabled)(?:\s|$)/i.test(element.className || '')) return true;
    return [...element.querySelectorAll('[title], [aria-label], img, svg use')].some(icon =>
      /未解锁|锁定|解锁后|(?:^|[-_/#])lock(?:ed)?(?:$|[-_])/i.test([
        icon.getAttribute('title'), icon.getAttribute('aria-label'), icon.getAttribute('src'),
        icon.getAttribute('href'), icon.getAttribute('xlink:href'),
      ].filter(Boolean).join(' ')));
  }

  function nextButton() {
    for (const doc of getDocuments()) {
      if (CONFIG.nextButtonSelector) {
        const custom = [...doc.querySelectorAll(CONFIG.nextButtonSelector)].find(visible);
        if (custom) return custom;
        continue;
      }
      const found = [...doc.querySelectorAll('button, a, [role="button"], [title], [aria-label]')].find(element => {
        if (panel.contains(element) || !visible(element)) return false;
        const text = normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
        return /^(?:播放|进入|学习)?\s*(?:下一(?:节|课|讲|小节|资源)|下一个视频|下一视频)(?:\s*[>›»→])?$/.test(text);
      });
      if (found) return found;
    }
    return null;
  }

  function returnButton() {
    for (const doc of getDocuments()) {
      const found = [...doc.querySelectorAll('button, a, [role="button"]')].find(element => {
        if (panel.contains(element) || !visible(element)) return false;
        const text = normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
        return /^(?:[‹<←]\s*)?返回(?:课程|目录|上一页)?$/.test(text);
      });
      if (found) return found;
    }
    return null;
  }

  function resumeFromCatalog() {
    if (!state.enabled || !state.returnAfterEnd || state.switching || isDetailPage()) return false;
    const items = rows();
    if (items.length < 2) {
      const pageText = normalize(document.body?.innerText || document.body?.textContent);
      const explicitlyEmpty = /暂无数据|暂无学习资源|共\s*0\s*个学习资源/.test(pageText);
      if (explicitlyEmpty && Date.now() - state.catalogWaitStarted >= CONFIG.catalogReloadDelay) {
        if (!state.catalogReloadAttempted && !state.catalogReloadScheduled) {
          state.catalogReloadScheduled = true;
          state.catalogReloadAttempted = true;
          saveState();
          report('返回后课程列表显示无数据，正在自动刷新一次…');
          setTimeout(() => {
            if (!state.stopped && state.returnAfterEnd) CONFIG.reloadPage();
          }, 300);
        } else if (state.catalogReloadAttempted && !state.catalogReloadScheduled) {
          report('刷新后课程列表仍无数据，请手动刷新或重新进入课程。');
        }
      }
      return false;
    }
    if (state.catalogReloadAttempted) {
      state.catalogReloadAttempted = false;
      saveState();
    }
    state.order = items.map(item => item.name);
    let index = items.findIndex(item => sameLesson(item.name, state.completed));
    if (index < 0) index = items.findIndex(item => sameLesson(item.name, state.current));
    if (index < 0) {
      report('已返回目录，但未找到刚播放的课程。请展开对应章节。');
      saveState();
      return false;
    }
    const next = items[index + 1];
    if (!next) {
      saveState();
      report('当前展开的目录中没有下一节。若课程尚未结束，请展开下一个章节。');
      return false;
    }
    if (locked(next.row)) {
      report(`已返回目录，等待下一节解锁：${next.name}`);
      saveState();
      return false;
    }
    state.switching = true;
    state.current = next.name;
    state.returnAfterEnd = false;
    state.completed = '';
    state.catalogReloadAttempted = false;
    state.pending = makePending();
    saveState();
    report(`正在打开：${next.name}`);
    (next.label.closest('a, button, [role="button"]') || next.label).click();
    state.switching = false;
    return true;
  }

  function closePlayerDialog(video) {
    const dialog = video.closest('[role="dialog"], .ant-modal, .el-dialog');
    if (!dialog) return;
    const close = dialog.querySelector('.ant-modal-close, .el-dialog__headerbtn, button[aria-label="Close"], button[aria-label="关闭"]');
    if (close && visible(close)) close.click();
  }

  function makePending(oldVideo = null) {
    return {
      oldVideo, oldSource: oldVideo ? signature(oldVideo) : '',
      started: Date.now(), attempting: false, blocked: false,
      clickedStarts: new WeakSet(),
    };
  }

  function startButton(root) {
    const known = [...root.querySelectorAll(CONFIG.startButtonSelector)]
      .find(element => visible(element) && !locked(element));
    if (known) return known;
    // 文本匹配只限播放器内部，避免点击课程列表等其他区域。
    if (root.nodeType === 9) return null;
    return [...root.querySelectorAll('button, [role="button"], [aria-label], [title]')].find(element => {
      const label = normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
      return visible(element) && !locked(element) && /^(播放|开始播放|播放视频|Play|Play Video)$/i.test(label);
    });
  }

  function clickStart(button, pending) {
    if (!button || pending.clickedStarts.has(button)) return;
    pending.clickedStarts.add(button);
    button.click();
  }

  async function tryPlay(video) {
    if (!state.enabled || !state.pending || !visible(video) || video.ended) return;
    const pending = state.pending;
    if (video === pending.oldVideo && signature(video) === pending.oldSource) return;
    if (pending.attempting || pending.blocked) return;
    pending.attempting = true;
    try {
      const root = video.closest('.video-js, .prism-player, .dplayer, .xgplayer, .plyr') || video.parentElement;
      if (video.paused && root) clickStart(startButton(root), pending);
      // 优先走平台的播放按钮；没有按钮或按钮未启动时再调用媒体接口。
      if (video.paused) await video.play();
      if (state.pending !== pending) return;
      state.pending = null;
      state.blockedVideo = null;
      play.hidden = true;
      report(`正在播放：${state.current || '当前视频'}`);
    } catch (error) {
      if (state.pending !== pending) return;
      if (error.name === 'AbortError') { pending.attempting = false; return; }
      pending.blocked = true;
      state.blockedVideo = video;
      play.hidden = false;
      report(error.name === 'NotAllowedError'
        ? '浏览器阻止了自动播放，请点击“点击播放”。'
        : '暂未能启动视频，请点击“点击播放”重试，或使用播放器中央按钮。');
    }
  }

  async function advance(video) {
    if (!state.enabled || state.switching || !video.ended || !Number.isFinite(video.duration) || video.duration <= 0 || !visible(video)) return;
    if (handledEnds.get(video) === signature(video)) return;
    handledEnds.set(video, signature(video));
    state.switching = true;
    const generation = state.generation;
    const oldSource = signature(video);
    const oldName = state.current || inferCurrentFromPage();
    if (oldName && !state.current) {
      state.current = oldName;
      saveState();
    }
    const deadline = Date.now() + CONFIG.unlockTimeout;
    report('视频已结束，等待下一节可播放…');
    rememberOrder(rows());
    let closed = false;
    let clicked = false;
    try {
      // 让平台自己的播放完成回调先更新学习状态。
      await sleep(1800);
      while (alive(generation) && Date.now() < deadline) {
        const button = nextButton();
        let target = button;
        const oldIndex = state.order.indexOf(oldName);
        let nextName = oldIndex >= 0 ? state.order[oldIndex + 1] || '' : '';
        if (!button) {
          if (isDetailPage()) {
            state.returnAfterEnd = true;
            state.completed = oldName || inferCurrentFromPage();
            state.catalogReloadAttempted = false;
            state.catalogWaitStarted = Date.now();
            saveState();
            const back = returnButton();
            if (back) {
              report('视频已结束，正在返回目录查找下一节…');
              back.click();
              clicked = true;
              return;
            }
            report('视频已结束，但没有找到“返回”按钮。请手动返回课程目录，脚本会继续打开下一节。');
            return;
          }
          if (!closed) { closePlayerDialog(video); closed = true; await sleep(500); }
          if (!alive(generation)) return;
          const items = rows();
          rememberOrder(items);
          const index = state.order.indexOf(oldName);
          if (index < 0) {
            report('未识别当前课程。请返回目录并展开当前章节。');
            return;
          }
          nextName = state.order[index + 1];
          if (!nextName) {
            report('当前已显示目录中没有下一节。若还有课程，请展开后手动打开。');
            return;
          }
          const next = items.find(item => item.name === nextName);
          if (next && !locked(next.row)) target = next.label.closest('a, button, [role="button"]') || next.label;
        }
        if (target && !locked(target)) {
          if (!alive(generation)) return;
          state.pending = makePending(video);
          state.pending.oldSource = oldSource;
          if (nextName) state.current = nextName;
          saveState();
          report(`正在打开：${nextName || '下一节视频'}`);
          target.click();
          clicked = true;
          return;
        }
        await sleep(1000);
      }
      if (alive(generation)) report('下一节仍未解锁或未找到，请检查页面后手动打开。');
    } finally {
      if (generation === state.generation) state.switching = false;
      if (!clicked && generation === state.generation) state.pending = null;
    }
  }

  function onClick(event) {
    if (!event.isTrusted || panel.contains(event.target)) return;
    const item = rows().find(item => item.row.contains(event.target));
    if (!item || locked(item.row)) return;
    const oldVideo = getDocuments().flatMap(doc => [...doc.querySelectorAll('video')]).find(visible);
    state.generation++;
    state.switching = false;
    state.pending = state.enabled ? makePending(oldVideo) : null;
    state.blockedVideo = null;
    play.hidden = true;
    state.current = item.name;
    rememberOrder(rows());
    saveState();
    report(`${state.enabled ? '已选课，等待播放器并自动播放' : '已暂停续播'}：${item.name}`);
  }

  function scan() {
    if (state.stopped) return;
    try {
      const docs = getDocuments();
      if (resumeFromCatalog()) return;
      for (const [doc, handler] of documents) {
        if (!docs.includes(doc)) { doc.removeEventListener('click', handler, true); documents.delete(doc); }
      }
      for (const doc of docs) {
        if (!documents.has(doc)) { doc.addEventListener('click', onClick, true); documents.set(doc, onClick); }
        // 部分播放器点击封面后才创建 video 元素。
        if (state.enabled && state.pending && !state.pending.blocked &&
            ![...doc.querySelectorAll('video')].some(visible)) {
          clickStart(startButton(doc), state.pending);
        }
        for (const video of doc.querySelectorAll('video')) {
          if (!videoHandlers.has(video)) {
            const ended = () => void advance(video).catch(error => report(`续播失败：${error.message}`));
            const ready = () => void tryPlay(video);
            const playing = () => { if (!video.ended) handledEnds.delete(video); };
            video.addEventListener('ended', ended);
            video.addEventListener('loadedmetadata', ready);
            video.addEventListener('canplay', ready);
            video.addEventListener('playing', playing);
            videoHandlers.set(video, { ended, ready, playing });
          }
          if (isDetailPage() && video.ended) {
            void advance(video).catch(error => report(`续播失败：${error.message}`));
          }
          if (state.pending) void tryPlay(video);
        }
      }
      for (const [video, handlers] of videoHandlers) {
        if (!video.isConnected || !docs.includes(video.ownerDocument)) {
          video.removeEventListener('ended', handlers.ended);
          video.removeEventListener('loadedmetadata', handlers.ready);
          video.removeEventListener('canplay', handlers.ready);
          video.removeEventListener('playing', handlers.playing);
          videoHandlers.delete(video);
        }
      }
      if (state.pending && !state.pending.blocked && Date.now() - state.pending.started > CONFIG.playerTimeout) {
        state.pending = null;
        report('未能启动播放器，请点击页面中央的播放按钮；跨域播放器需要单独适配。');
      }
    } catch (error) { report(`页面识别失败：${error.message}`); }
  }

  toggle.addEventListener('click', () => {
    state.enabled = !state.enabled;
    state.generation++;
    state.switching = false;
    state.pending = null;
    state.blockedVideo = null;
    play.hidden = true;
    toggle.textContent = state.enabled ? '暂停续播' : '开启续播';
    saveState();
    report(state.enabled ? '已开启，请播放当前视频；播完后自动续播。' : '已暂停自动续播，当前视频可继续播放。');
  });
  play.addEventListener('click', () => {
    if (state.pending && state.blockedVideo) {
      state.pending.blocked = false;
      state.pending.attempting = false;
      void tryPlay(state.blockedVideo);
    }
  });
  const interval = setInterval(scan, 1000);
  window.__POLYMAS_AUTO_NEXT__ = {
    stop() {
      state.stopped = true;
      state.enabled = false;
      state.generation++;
      clearInterval(interval);
      for (const [doc, handler] of documents) doc.removeEventListener('click', handler, true);
      for (const [video, handlers] of videoHandlers) {
        video.removeEventListener('ended', handlers.ended);
        video.removeEventListener('loadedmetadata', handlers.ready);
        video.removeEventListener('canplay', handlers.ready);
        video.removeEventListener('playing', handlers.playing);
      }
      panel.remove();
      delete window.__POLYMAS_AUTO_NEXT__;
    },
    status: () => ({ enabled: state.enabled, current: state.current, message: status.textContent }),
  };
  toggle.textContent = state.enabled ? '暂停续播' : '开启续播';
  if (!state.enabled) {
    report('自动播放与续播已暂停。');
  } else if (isDetailPage()) {
    const inferred = inferCurrentFromPage();
    if (inferred) state.current = inferred;
    state.pending = makePending();
    saveState();
    report('已进入视频页，等待播放器并自动播放…');
  } else {
    report(state.returnAfterEnd
      ? '已返回目录，正在定位下一节…'
      : '已开启。从目录打开视频后，将自动尝试播放。');
  }
  scan();
})();
