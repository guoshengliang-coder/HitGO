import { describe, expect, it, vi } from 'vitest';
import { Player } from './player';

// node 环境没有 HTMLVideoElement：EventTarget + 播放器会读写的几个字段就够用
function fakeVideo(src = '/media/a.mp4') {
  const el = new EventTarget() as EventTarget & { src: string; currentTime: number; duration: number; readyState: number; pause: () => void };
  el.src = src;
  el.currentTime = 0;
  el.duration = 10;
  el.readyState = 0;
  el.pause = () => undefined;
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
