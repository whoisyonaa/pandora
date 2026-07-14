import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@aparajita/capacitor-biometric-auth", () => ({ BiometricAuth: {} }));

import { VaultEntryRow } from "./App";
import type { VaultEntry, VaultFolder } from "./types/vault";

const entry = {
  id: "entry-1",
  folderId: "folder-1",
  title: "Example",
  username: "user",
  password: "secret",
  url: "example.com",
  notes: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as VaultEntry;

const folders = [
  { id: "folder-1", name: "All", parentId: null, createdAt: "2026-01-01T00:00:00.000Z" },
] as VaultFolder[];

function renderRow() {
  const handlers = {
    onSelect: vi.fn(),
    onDragStart: vi.fn(),
    onMobileDragStart: vi.fn(),
    onMobileDragMove: vi.fn(),
    onMobileDragEnd: vi.fn(),
    onMobileDragCancel: vi.fn(),
  };
  const view = render(
    <div className="cipher-workspace" data-testid="scroll-container">
      <VaultEntryRow
        entry={entry}
        folders={folders}
        selected={false}
        dragEnabled={false}
        mobileDragEnabled
        {...handlers}
      />
    </div>,
  );
  return { ...view, handlers };
}

describe("mobile vault row gestures", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("leaves a normal swipe available for scrolling", () => {
    vi.useFakeTimers();
    const { getByRole, getByTestId, handlers } = renderRow();
    const row = getByRole("button");
    const scrollContainer = getByTestId("scroll-container");
    scrollContainer.scrollTop = 100;

    fireEvent.touchStart(row, { touches: [{ clientX: 120, clientY: 500 }] });
    const moveWasNotCancelled = fireEvent.touchMove(row, { touches: [{ clientX: 120, clientY: 460 }] });
    act(() => vi.advanceTimersByTime(500));

    expect(handlers.onMobileDragStart).not.toHaveBeenCalled();
    expect(scrollContainer.scrollTop).toBe(140);
    expect(moveWasNotCancelled).toBe(false);
    expect(row).toHaveAttribute("draggable", "false");

    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 120, clientY: 460 }] });
    act(() => vi.advanceTimersByTime(100));
    expect(scrollContainer.scrollTop).toBeGreaterThan(140);
  });

  it("starts touch drag only after a deliberate hold", () => {
    vi.useFakeTimers();
    const { getByRole, handlers } = renderRow();
    const row = getByRole("button");

    fireEvent.touchStart(row, { touches: [{ clientX: 120, clientY: 500 }] });
    act(() => vi.advanceTimersByTime(420));
    const moveWasNotCancelled = fireEvent.touchMove(row, { touches: [{ clientX: 120, clientY: 420 }] });
    fireEvent.touchEnd(row, { changedTouches: [{ clientX: 120, clientY: 160 }] });

    expect(handlers.onMobileDragStart).toHaveBeenCalledWith("entry-1", 120, 500);
    expect(handlers.onMobileDragMove).toHaveBeenCalled();
    expect(handlers.onMobileDragEnd).toHaveBeenCalledOnce();
    expect(moveWasNotCancelled).toBe(false);
  });
});
