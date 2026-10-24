import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD = 4; // px of movement before a press becomes a drag
const EDGE = 48; // px from the top or bottom edge where auto-scroll starts
const MAX_SPEED = 18; // px per frame at the very edge

/**
 * Drag a box over empty space to select the items under it, like Google
 * Drive. Items are found by their `data-id` attribute. Ctrl, Cmd or Shift
 * adds to the current selection instead of replacing it.
 *
 * Returns a ref and mouse handler for the scroll container, plus the box to
 * draw (in the container's content coordinates) while a drag is going on.
 */
export default function useMarquee(selected, setSelected) {
    const ref = useRef(null);
    const [box, setBox] = useState(null);
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const stop = useRef(null);

    useEffect(() => () => stop.current?.(), []);

    const onMouseDown = useCallback(
        (event) => {
            const el = ref.current;
            if (!el || event.button !== 0) return;
            if (event.target.closest("[data-id], button, a, input, th")) return;
            const rect = el.getBoundingClientRect();
            // a press on the scrollbar
            if (
                event.clientX - rect.left >= el.clientWidth ||
                event.clientY - rect.top >= el.clientHeight
            )
                return;
            event.preventDefault(); // no text selection while dragging

            const toContent = (clientX, clientY) => {
                const r = el.getBoundingClientRect();
                return {
                    x: Math.min(
                        Math.max(clientX - r.left + el.scrollLeft, 0),
                        el.scrollWidth,
                    ),
                    y: Math.min(
                        Math.max(clientY - r.top + el.scrollTop, 0),
                        el.scrollHeight,
                    ),
                };
            };
            const start = toContent(event.clientX, event.clientY);
            const base =
                event.ctrlKey || event.metaKey || event.shiftKey
                    ? new Set(selectedRef.current)
                    : new Set();
            let pointer = { x: event.clientX, y: event.clientY };
            let active = false;
            let frame = 0;
            let last = null;

            const update = () => {
                const end = toContent(pointer.x, pointer.y);
                const area = {
                    left: Math.min(start.x, end.x),
                    top: Math.min(start.y, end.y),
                    right: Math.max(start.x, end.x),
                    bottom: Math.max(start.y, end.y),
                };
                setBox({
                    left: area.left,
                    top: area.top,
                    width: area.right - area.left,
                    height: area.bottom - area.top,
                });

                const r = el.getBoundingClientRect();
                const next = new Set(base);
                for (const node of el.querySelectorAll("[data-id]")) {
                    const n = node.getBoundingClientRect();
                    const left = n.left - r.left + el.scrollLeft;
                    const top = n.top - r.top + el.scrollTop;
                    if (
                        left < area.right &&
                        left + n.width > area.left &&
                        top < area.bottom &&
                        top + n.height > area.top
                    )
                        next.add(node.dataset.id);
                }
                const key = [...next].join("\n");
                if (key !== last) {
                    last = key;
                    setSelected(next);
                }
            };

            const tick = () => {
                const r = el.getBoundingClientRect();
                let speed = 0;
                if (pointer.y < r.top + EDGE)
                    speed = -Math.min(1, (r.top + EDGE - pointer.y) / EDGE);
                else if (pointer.y > r.bottom - EDGE)
                    speed = Math.min(1, (pointer.y - r.bottom + EDGE) / EDGE);
                if (speed) {
                    const before = el.scrollTop;
                    el.scrollTop += Math.round(speed * MAX_SPEED);
                    if (el.scrollTop !== before) update();
                }
                frame = requestAnimationFrame(tick);
            };

            const onMove = (e) => {
                pointer = { x: e.clientX, y: e.clientY };
                if (!active) {
                    if (
                        Math.abs(e.clientX - event.clientX) < THRESHOLD &&
                        Math.abs(e.clientY - event.clientY) < THRESHOLD
                    )
                        return;
                    active = true;
                    frame = requestAnimationFrame(tick);
                }
                update();
            };

            const cleanup = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                cancelAnimationFrame(frame);
                stop.current = null;
                setBox(null);
            };

            const onUp = () => {
                if (active) {
                    // the click that follows would clear the selection
                    const swallow = (e) => e.stopPropagation();
                    window.addEventListener("click", swallow, {
                        capture: true,
                        once: true,
                    });
                    setTimeout(
                        () =>
                            window.removeEventListener("click", swallow, {
                                capture: true,
                            }),
                        0,
                    );
                }
                cleanup();
            };

            stop.current?.();
            stop.current = cleanup;
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        },
        [setSelected],
    );

    return { ref, onMouseDown, box };
}
