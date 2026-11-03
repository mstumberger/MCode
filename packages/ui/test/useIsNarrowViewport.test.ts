// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  NARROW_VIEWPORT_MEDIA_QUERY,
  readIsNarrowViewport,
  useIsNarrowViewport,
} from "@/hooks/useIsNarrowViewport.js";

type ChangeListener = (event: { matches: boolean }) => void;

function stubSharedMatchMedia(initialMatches: boolean) {
  const listeners = new Set<ChangeListener>();
  const state = { matches: initialMatches };
  const mediaQueryList = {
    get matches() {
      return state.matches;
    },
    addEventListener: vi.fn((_type: string, listener: ChangeListener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: ChangeListener) => {
      listeners.delete(listener);
    }),
  };
  const matchMedia = vi.fn(() => mediaQueryList);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    mediaQueryList,
    emitChange(matches: boolean) {
      state.matches = matches;
      listeners.forEach((listener) => listener({ matches }));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("readIsNarrowViewport 用统一媒体查询常量同步读取", () => {
  const { matchMedia } = stubSharedMatchMedia(true);

  expect(readIsNarrowViewport()).toBe(true);
  expect(matchMedia).toHaveBeenCalledWith(NARROW_VIEWPORT_MEDIA_QUERY);
  expect(matchMedia).toHaveReturnedWith(expect.objectContaining({ matches: true }));
});

it("无 window.matchMedia（SSR）时恒为 false，hook 不订阅", () => {
  vi.stubGlobal("matchMedia", undefined);

  expect(readIsNarrowViewport()).toBe(false);

  const { result } = renderHook(() => useIsNarrowViewport());
  expect(result.current).toBe(false);
});

it("首帧用同步读初始化，订阅前再同步一次覆盖旋转/拖窗窗口期", () => {
  // 首次调用（useState 初始化）命中 true，effect 内再次读取已是 false：
  // 覆盖首帧到 effect 之间用户旋转屏幕或拖窄窗口的真实时序。
  let callCount = 0;
  const matchMedia = vi.fn(() => {
    callCount += 1;
    return {
      matches: callCount === 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });
  vi.stubGlobal("matchMedia", matchMedia);

  const { result } = renderHook(() => useIsNarrowViewport());

  expect(result.current).toBe(false);
  expect(callCount).toBe(2);
});

it("订阅 change 事件跟随视口变化，卸载时移除监听", () => {
  const { matchMedia, mediaQueryList, emitChange } = stubSharedMatchMedia(false);

  const { result, unmount } = renderHook(() => useIsNarrowViewport());
  expect(result.current).toBe(false);
  expect(mediaQueryList.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

  act(() => {
    emitChange(true);
  });
  expect(result.current).toBe(true);

  act(() => {
    emitChange(false);
  });
  expect(result.current).toBe(false);

  unmount();
  expect(matchMedia().removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
});
