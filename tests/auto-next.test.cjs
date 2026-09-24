// 开发验证：Node.js 26+，npm ci 后执行 npm test。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { JSDOM } = require('jsdom');

const source = readFileSync(resolve(__dirname, '../polymas-auto-next.user.js'), 'utf8');
function fixture(extra = '', options = {}) {
  const dom = new JSDOM(`<body><ul>
    <li><span>必学</span><span id="first">[6.1] 提示工程导引.mp4</span></li>
    <li><span>必学</span><span id="second">[6.2] 提示词设计原则与优化技巧.mp4</span></li>
    <li><span>必学</span><span id="third">[6.3] 高级提示模式.mp4</span><i data-icon="lock"></i></li>
    </ul><video src="one.mp4"></video>${extra}`, {
    url: `https://hike-teaching-center.polymas.com/study${options.detail ? '/resource-detail' : ''}`, runScripts: 'outside-only',
  });
  const w = dom.window;
  w.console.info = () => {};
  w.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [{ width: 100, height: 40 }]; };
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 40 });
  const originalTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms) => originalTimeout(fn, Math.min(ms, 5));
  const video = w.document.querySelector('video');
  Object.defineProperties(video, {
    ended: { value: !options.detail, writable: true },
    duration: { value: 100 },
    paused: { value: true, writable: true },
  });
  let initialPlays = 0;
  video.play = async () => { initialPlays++; video.paused = false; };
  if (options.saved) {
    w.sessionStorage.setItem('soochow-course-autoplay-state-v1', JSON.stringify(options.saved));
  }
  w.eval(source.replace(/\}\)\(\);\s*$/, 'window.qa = {state, CONFIG, onClick, rows, locked, advance, scan, tryPlay}; })();'));
  if (!options.detail) {
    w.qa.onClick({ isTrusted: true, target: w.document.querySelector('#first') });
    // 旧回归用例从“已播放完第一节”的状态开始；入口播放单独验证。
    w.qa.state.pending = null;
  }
  return { w, video, q: w.qa, initialPlays: () => initialPlays, close: () => { w.__POLYMAS_AUTO_NEXT__?.stop(); w.close(); } };
}

test('识别截图格式的目录、当前资源以及锁定状态', () => {
  const f = fixture();
  try {
    assert.equal(f.q.rows().length, 3);
    assert.equal(f.q.state.current, '[6.1] 提示工程导引.mp4');
    assert.equal(f.q.state.order.length, 3);
    assert.equal(f.q.locked(f.q.rows()[2].row), true);
    assert.equal(f.q.locked(f.q.rows()[1].row), false);
  } finally { f.close(); }
});

test('正常结束只切换一次，动态出现的新播放器会播放', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    let plays = 0;
    f.w.document.querySelector('#second').addEventListener('click', () => clicks++);
    await f.q.advance(f.video);
    await f.q.advance(f.video);
    assert.equal(clicks, 1);
    assert.equal(f.q.state.current, '[6.2] 提示词设计原则与优化技巧.mp4');
    const next = f.w.document.createElement('video');
    next.src = 'two.mp4';
    next.play = async () => { plays++; };
    f.w.document.body.append(next);
    f.q.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(plays, 1);
    assert.equal(f.q.state.pending, null);
  } finally { f.close(); }
});

test('视频尚未结束时不切换', async () => {
  const f = fixture();
  try {
    f.video.ended = false;
    await f.q.advance(f.video);
    assert.equal(f.q.state.pending, null);
    assert.equal(f.q.state.current, '[6.1] 提示工程导引.mp4');
  } finally { f.close(); }
});

test('优先使用下一节按钮，并同步目录中的课程名称', async () => {
  const f = fixture('<button id="next">下一节</button>');
  try {
    let clicks = 0;
    f.w.document.querySelector('#next').addEventListener('click', () => clicks++);
    await f.q.advance(f.video);
    assert.equal(clicks, 1);
    assert.equal(f.q.state.current, '[6.2] 提示词设计原则与优化技巧.mp4');
  } finally { f.close(); }
});

test('等待期间暂停会取消切换', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    f.w.document.querySelector('#second').addEventListener('click', () => clicks++);
    const task = f.q.advance(f.video);
    f.w.document.querySelector('[data-toggle]').click();
    await task;
    assert.equal(clicks, 0);
    assert.equal(f.q.state.enabled, false);
  } finally { f.close(); }
});

test('手动换课会取消上一节的待执行自动切换', async () => {
  const f = fixture();
  try {
    let clicks = 0;
    f.w.document.querySelector('#second').addEventListener('click', () => clicks++);
    const task = f.q.advance(f.video);
    f.q.onClick({ isTrusted: true, target: f.w.document.querySelector('#second') });
    await task;
    assert.equal(clicks, 0);
    assert.equal(f.q.state.current, '[6.2] 提示词设计原则与优化技巧.mp4');
  } finally { f.close(); }
});

test('锁定的下一节不会被点击，超时后显示提示', async () => {
  const f = fixture();
  try {
    f.q.CONFIG.unlockTimeout = 25;
    f.q.onClick({ isTrusted: true, target: f.w.document.querySelector('#second') });
    let clicks = 0;
    f.w.document.querySelector('#third').addEventListener('click', () => clicks++);
    await f.q.advance(f.video);
    assert.equal(clicks, 0);
    assert.match(f.w.__POLYMAS_AUTO_NEXT__.status().message, /仍未解锁/);
  } finally { f.close(); }
});

test('自动播放被阻止后允许通过按钮重试', async () => {
  const f = fixture();
  try {
    await f.q.advance(f.video);
    const next = f.w.document.createElement('video');
    next.src = 'two.mp4';
    let attempts = 0;
    next.play = async () => { if (++attempts === 1) throw new f.w.DOMException('Blocked', 'NotAllowedError'); };
    f.w.document.body.append(next);
    await f.q.tryPlay(next);
    assert.equal(f.w.document.querySelector('[data-play]').hidden, false);
    f.w.document.querySelector('[data-play]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.equal(f.q.state.pending, null);
  } finally { f.close(); }
});

test('重复执行脚本不会重复安装，stop 会删除控制面板', () => {
  const f = fixture();
  try {
    f.w.eval(source);
    assert.equal(f.w.document.querySelectorAll('#polymas-auto-next-panel').length, 1);
    f.w.__POLYMAS_AUTO_NEXT__.stop();
    assert.equal(f.w.document.querySelectorAll('#polymas-auto-next-panel').length, 0);
    assert.equal(f.w.__POLYMAS_AUTO_NEXT__, undefined);
  } finally { f.close(); }
});

test('手动选课后自动点击中央播放按钮，之后手动暂停不会被强制恢复', async () => {
  const f = fixture();
  try {
    f.q.onClick({ isTrusted: true, target: f.w.document.querySelector('#second') });
    // 旧播放器还没卸载时，不能误播旧课程。
    f.q.scan();
    assert.equal(f.initialPlays(), 0);
    const wrapper = f.w.document.createElement('div');
    wrapper.className = 'video-js';
    wrapper.innerHTML = '<video src="two.mp4"></video><button class="vjs-big-play-button">播放</button>';
    f.w.document.body.append(wrapper);
    const next = wrapper.querySelector('video');
    Object.defineProperty(next, 'paused', { value: true, writable: true });
    let clicks = 0;
    wrapper.querySelector('button').addEventListener('click', () => { clicks++; next.paused = false; });
    f.q.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clicks, 1);
    assert.equal(f.q.state.pending, null);
    next.paused = true;
    f.q.scan();
    assert.equal(clicks, 1);
    assert.equal(next.paused, true);
  } finally { f.close(); }
});

test('直接进入或刷新视频详情页也会尝试播放', async () => {
  const f = fixture('', { detail: true });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.initialPlays(), 1);
    assert.equal(f.video.paused, false);
    assert.equal(f.q.state.pending, null);
    f.q.scan();
    assert.equal(f.initialPlays(), 1);
  } finally { f.close(); }
});

test('先有封面按钮、点击后才创建 video 的播放器可以启动', async () => {
  const f = fixture();
  try {
    f.q.onClick({ isTrusted: true, target: f.w.document.querySelector('#second') });
    f.video.remove();
    const button = f.w.document.createElement('button');
    button.className = 'vjs-big-play-button';
    let clicks = 0;
    let plays = 0;
    button.addEventListener('click', () => {
      clicks++;
      const video = f.w.document.createElement('video');
      video.src = 'two.mp4';
      video.play = async () => { plays++; };
      f.w.document.body.append(video);
      button.remove();
    });
    f.w.document.body.append(button);
    f.q.scan();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clicks, 1);
    assert.equal(plays, 1);
    assert.equal(f.q.state.pending, null);
  } finally { f.close(); }
});

test('暂停续播后再手动选课不会启动播放', () => {
  const f = fixture();
  try {
    f.w.document.querySelector('[data-toggle]').click();
    f.q.onClick({ isTrusted: true, target: f.w.document.querySelector('#second') });
    f.q.scan();
    assert.equal(f.q.state.pending, null);
    assert.equal(f.initialPlays(), 0);
  } finally { f.close(); }
});

test('详情页播放结束后保存课程并点击返回目录', async () => {
  const saved = {
    enabled: true,
    current: '[6.1] 提示工程导引.mp4',
    order: ['[6.1] 提示工程导引.mp4', '[6.2] 提示词设计原则与优化技巧.mp4'],
  };
  const f = fixture('<button id="back">返回</button>', { detail: true, saved });
  try {
    let clicks = 0;
    f.w.document.querySelector('#back').addEventListener('click', () => clicks++);
    f.video.ended = true;
    f.video.paused = false;
    await f.q.advance(f.video);
    const stored = JSON.parse(f.w.sessionStorage.getItem('soochow-course-autoplay-state-v1'));
    assert.equal(clicks, 1);
    assert.equal(stored.returnAfterEnd, true);
    assert.equal(stored.completed, '[6.1] 提示工程导引.mp4');
    assert.match(f.w.__POLYMAS_AUTO_NEXT__.status().message, /返回目录/);
  } finally { f.close(); }
});

test('返回目录后根据保存状态自动打开下一节', () => {
  const saved = {
    enabled: true,
    current: '[6.1] 提示工程导引.mp4',
    order: ['[6.1] 提示工程导引.mp4', '[6.2] 提示词设计原则与优化技巧.mp4'],
    returnAfterEnd: true,
    completed: '[6.1] 提示工程导引.mp4',
  };
  const f = fixture('', { saved });
  try {
    let clicks = 0;
    f.w.document.querySelector('#second').addEventListener('click', () => clicks++);
    f.q.state.returnAfterEnd = true;
    f.q.state.completed = saved.completed;
    f.q.scan();
    const stored = JSON.parse(f.w.sessionStorage.getItem('soochow-course-autoplay-state-v1'));
    assert.equal(clicks, 1);
    assert.equal(f.q.state.current, '[6.2] 提示词设计原则与优化技巧.mp4');
    assert.equal(stored.returnAfterEnd, false);
    assert.equal(stored.completed, '');
  } finally { f.close(); }
});

test('即使没有预先记录目录，详情页也能从标题记录已完成课程', async () => {
  const f = fixture('<h1>[6.2] 提示词设计原则与优化技巧</h1><button id="back">返回</button>', { detail: true });
  try {
    f.q.state.current = '';
    f.video.ended = true;
    f.video.paused = false;
    await f.q.advance(f.video);
    const stored = JSON.parse(f.w.sessionStorage.getItem('soochow-course-autoplay-state-v1'));
    assert.equal(stored.returnAfterEnd, true);
    assert.match(stored.completed, /\[6\.2\]/);
  } finally { f.close(); }
});
