import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player } from './player';

// node 环境没有 HTMLVideoElement：EventTarget + 播放器会读写的几个字段就够用
function fakeVideo(src = '/media/a.mp4') {
  const el = new EventTarget() as EventTarget & { src: string; currentTime: number; duration: number; readyState: number; pause: () => void; play: () => Promise<void> };
  el.src = src;
  el.currentTime = 0;
  el.duration = 10;
  el.readyState = 0;
  el.pause = vi.fn();
  el.play = vi.fn(() => Promise.resolve());
  return el as unknown as HTMLVideoElement;
}

describe('Player 换元素（HIG-12）', () => {
  it('detach 之后 getVideo 为 null，不会再交出上一条素材的元素', () => {
    const p = new Player();
    const a = fakeVideo();
    p.attach(a);
    expect(p.getVideo()).toBe(a);
    p.detach();
    expect(p.getVideo()).toBeNull();
  });

  it('onFrame 只响应当前挂载元素的 loadeddata / seeked', () => {
    const p = new Player();
    const a = fakeVideo('/media/a.mp4');
    const b = fakeVideo('/media/b.mp4');
    const onFrame = vi.fn();
    p.onFrame(onFrame);

    p.attach(a);
    a.dispatchEvent(new Event('loadeddata'));
    expect(onFrame).toHaveBeenCalledTimes(1);

    p.attach(b);
    a.dispatchEvent(new Event('seeked'));
    expect(onFrame).toHaveBeenCalledTimes(1);
    b.dispatchEvent(new Event('loadeddata'));
    b.dispatchEvent(new Event('seeked'));
    expect(onFrame).toHaveBeenCalledTimes(3);
  });

  it('取消订阅后不再通知', () => {
    const p = new Player();
    const a = fakeVideo();
    const onFrame = vi.fn();
    const off = p.onFrame(onFrame);
    p.attach(a);
    off();
    a.dispatchEvent(new Event('loadeddata'));
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe('Player 封面段（HIG-9）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 手动推进 rAF：每次 tick 把 performance.now 往前拨 ms 毫秒。 */
  function manualFrames() {
    let cb: FrameRequestCallback | null = null;
    let now = 1000;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return (ms: number) => {
      now += ms;
      const fn = cb;
      cb = null;
      fn?.(now);
    };
  }

  function attached(preroll: number) {
    const p = new Player();
    const v = fakeVideo();
    p.attach(v);
    p.duration = 10;
    p.setPreroll(preroll);
    return { p, v };
  }

  it('seek 的下限是 -preroll；封面变短时播放头夹回新封面的起点', () => {
    const { p, v } = attached(2);
    p.seek(-5);
    expect(p.currentTime).toBe(-2);
    expect(v.currentTime).toBe(0); // 正片停在第 0 帧
    p.setPreroll(1);
    expect(p.currentTime).toBe(-1);
    p.setPreroll(0);
    expect(p.currentTime).toBe(0);
  });

  it('从封面开始播：封面段不启动正片，跨过 0 时正片从头接上', () => {
    const tick = manualFrames();
    const { p, v } = attached(1);
    p.seek(-1);
    p.play();
    expect(v.play).not.toHaveBeenCalled();
    tick(500);
    expect(p.currentTime).toBeCloseTo(-0.5);
    expect(v.play).not.toHaveBeenCalled();
    tick(600);
    expect(p.currentTime).toBe(0);
    expect(v.currentTime).toBe(0);
    expect(v.play).toHaveBeenCalledTimes(1);
    p.pause();
  });

  it('跨过 0 时先跳过开头的删除区间', () => {
    const tick = manualFrames();
    const { p, v } = attached(0.5);
    p.remove = [[0, 2]];
    p.seek(-0.5);
    p.play();
    tick(600);
    expect(p.currentTime).toBe(2);
    expect(v.currentTime).toBe(2);
    p.pause();
  });

  it('播到头再按播放从封面起点重来', () => {
    manualFrames();
    const { p, v } = attached(1.5);
    p.seek(10);
    p.play();
    expect(p.currentTime).toBe(-1.5);
    expect(v.play).not.toHaveBeenCalled();
    p.pause();
  });
});

describe('Player 倍速 / 倒放（HIG-30）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function manualFrames() {
    let cb: FrameRequestCallback | null = null;
    let now = 1000;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return (ms: number) => {
      now += ms;
      const fn = cb;
      cb = null;
      fn?.(now);
    };
  }

  it('合成时钟按倍速推进；暂停后倍速回到 1', () => {
    const tick = manualFrames();
    const p = new Player();
    p.duration = 10;
    p.shuttle(2);
    expect(p.rate).toBe(2);
    expect(p.mediaRate).toBe(2);
    tick(500);
    expect(p.currentTime).toBeCloseTo(1);
    p.shuttle(0);
    expect(p.isPlaying).toBe(false);
    expect(p.rate).toBe(1);
    expect(p.mediaRate).toBe(0);
  });

  it('正放给 <video> 设 playbackRate，切到倒放时暂停元素并逐帧 seek', () => {
    const tick = manualFrames();
    const p = new Player();
    const v = fakeVideo() as HTMLVideoElement & { playbackRate: number };
    p.attach(v);
    v.dispatchEvent(new Event('loadedmetadata'));
    p.seek(5);
    p.shuttle(4);
    expect(v.playbackRate).toBe(4);
    expect(v.play).toHaveBeenCalledTimes(1);
    p.shuttle(-1);
    expect(v.pause).toHaveBeenCalled();
    expect(p.mediaRate).toBe(0);
    tick(500);
    expect(p.currentTime).toBeCloseTo(4.5);
    expect(v.currentTime).toBeCloseTo(4.5);
    p.pause();
    expect(v.playbackRate).toBe(1);
  });

  it('倒放跳过删除区间，走到开头停下', () => {
    const tick = manualFrames();
    const p = new Player();
    p.duration = 10;
    p.remove = [[1, 3]];
    p.seek(3.5);
    p.shuttle(-1);
    tick(600);
    expect(p.currentTime).toBeLessThan(1);
    tick(2000);
    expect(p.currentTime).toBe(0);
    expect(p.isPlaying).toBe(false);
  });

  it('停在开头时倒放不启动', () => {
    manualFrames();
    const p = new Player();
    p.duration = 10;
    p.shuttle(-1);
    expect(p.isPlaying).toBe(false);
  });
});

describe('Player 循环补足（HIG-50 trim.duration）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function manualFrames() {
    let cb: FrameRequestCallback | null = null;
    let now = 1000;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return (ms: number) => {
      now += ms;
      const fn = cb;
      cb = null;
      fn?.(now);
    };
  }

  it('没设成片时长时只有 1 遍，播到源片尾就停', () => {
    const tick = manualFrames();
    const p = new Player();
    p.duration = 4;
    expect(p.laps).toBe(1);
    p.play();
    tick(4100);
    expect(p.isPlaying).toBe(false);
    expect(p.currentTime).toBe(4);
    expect(p.lap).toBe(0);
  });

  it('成片比剪后长：源片放完回到第一个保留帧接着放，lap 递增、postTime 跨遍累加，到成片时长停', () => {
    const tick = manualFrames();
    const p = new Player();
    p.duration = 4;
    p.remove = [[0, 1]]; // 剪后 3 秒
    p.setOutputDuration(7.5); // 3 遍：3 + 3 + 1.5
    expect(p.laps).toBe(3);
    const laps: number[] = [];
    p.subscribe((_t, _playing, lap) => laps.push(lap));
    p.play();
    expect(p.currentTime).toBe(1); // 跳过开头的删除区间
    tick(2000);
    expect(p.lap).toBe(0);
    expect(p.postTime).toBeCloseTo(2);
    tick(1500); // 源片到尾 → 第 1 遍
    expect(p.isPlaying).toBe(true);
    expect(p.lap).toBe(1);
    expect(p.currentTime).toBe(1);
    expect(p.postTime).toBeCloseTo(3);
    tick(500);
    expect(p.postTime).toBeCloseTo(3.5);
    tick(3000); // → 第 2 遍
    expect(p.lap).toBe(2);
    tick(2000); // 成片时刻 7.5 → 停
    expect(p.isPlaying).toBe(false);
    expect(p.lap).toBe(2);
    expect(p.postTime).toBeCloseTo(7.5);
    expect(laps).toContain(1);
    expect(laps).toContain(2);
  });

  it('成片比剪后短：在成片时长处截断', () => {
    const tick = manualFrames();
    const p = new Player();
    p.duration = 10;
    p.setOutputDuration(2.5);
    expect(p.laps).toBe(1);
    p.play();
    tick(3000);
    expect(p.isPlaying).toBe(false);
    expect(p.currentTime).toBeCloseTo(2.5);
  });

  it('seek 可指定遍数并夹到范围内；缺省保持当前遍；封面段只属于第 0 遍', () => {
    manualFrames();
    const p = new Player();
    p.duration = 4;
    p.setOutputDuration(10);
    expect(p.laps).toBe(3);
    p.seek(2, 1);
    expect(p.lap).toBe(1);
    expect(p.postTime).toBeCloseTo(6);
    p.seek(3);
    expect(p.lap).toBe(1);
    p.seek(1, 9);
    expect(p.lap).toBe(2);
    p.setPreroll(1);
    p.seek(-0.5);
    expect(p.lap).toBe(0);
    // 成片时长变短、遍数变少：播放头夹回最后一遍
    p.seek(1, 2);
    p.setOutputDuration(5);
    expect(p.lap).toBe(1);
    p.setOutputDuration(null);
    expect(p.lap).toBe(0);
    expect(p.laps).toBe(1);
  });

  it('停在成片末尾再按播放从第 0 遍的开头（有封面就从封面）重来；停在源片尾但还有下一遍时接着放下一遍', () => {
    const tick = manualFrames();
    const p = new Player();
    p.duration = 4;
    p.setOutputDuration(8);
    p.seek(4, 1);
    p.play();
    expect(p.lap).toBe(0);
    expect(p.currentTime).toBe(0);
    p.pause();
    p.seek(4, 0);
    p.play();
    expect(p.lap).toBe(1);
    expect(p.currentTime).toBe(0);
    tick(100);
    expect(p.isPlaying).toBe(true);
    p.pause();
  });

  it('挂着 <video> 时：ended 事件换遍并让元素从开头重播；seek 落地前不把片尾当成下一次到尾', () => {
    const tick = manualFrames();
    const p = new Player();
    const v = fakeVideo();
    p.attach(v);
    v.dispatchEvent(new Event('loadedmetadata')); // duration 10
    p.setOutputDuration(25);
    expect(p.laps).toBe(3);
    p.play();
    v.currentTime = 10;
    v.dispatchEvent(new Event('ended'));
    expect(p.lap).toBe(1);
    expect(p.isPlaying).toBe(true);
    expect(v.play).toHaveBeenCalledTimes(2);
    // 元素还没 seek 回去（仍报 10）：这几帧不能再跳一遍
    tick(16);
    tick(16);
    expect(p.lap).toBe(1);
    expect(p.currentTime).toBe(0);
    v.currentTime = 0.5;
    tick(16);
    expect(p.currentTime).toBe(0.5);
    // 最后一遍到尾：停
    p.seek(10, 2);
    v.dispatchEvent(new Event('ended'));
    expect(p.isPlaying).toBe(false);
  });

  it('倒放跨遍：从第 1 遍开头倒回第 0 遍的片尾', () => {
    const tick = manualFrames();
    const p = new Player();
    p.duration = 4;
    p.setOutputDuration(8);
    p.seek(0.2, 1);
    p.shuttle(-1);
    tick(500);
    expect(p.lap).toBe(0);
    expect(p.currentTime).toBeGreaterThan(3.5);
    p.pause();
  });
});
