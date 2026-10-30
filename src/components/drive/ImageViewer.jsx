import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import PropTypes from "prop-types";

import { Box } from "@mui/material";

// how far in a picture can be taken, as times its own pixels
const MAX_NATURAL = 4;
// zoom per wheel pixel; a notch of ~100 px is about a fifth
const WHEEL_STEP = 0.002;
// a sideways drag this long, when not zoomed in, moves to the next picture
const SWIPE = 60;

const START = { zoom: 1, x: 0, y: 0, rot: 0, animate: false };

/**
 * One picture that can be zoomed (wheel, pinch, double click), dragged
 * around once zoomed in, and turned a quarter at a time. `zoom` 1 is the
 * picture fitted to the area, never blown up past its own size.
 *
 * Until the picture itself has loaded, `placeholder` (its small thumbnail)
 * stands in, blurred. The parent drives the buttons and keys through the
 * ref: zoomIn(), zoomOut(), reset(), rotate().
 */
const ImageViewer = forwardRef(function ImageViewer(
    { src, placeholder, alt, onZoom, onSwipe, onSize },
    ref,
) {
    const box = useRef(null);
    const [area, setArea] = useState({ w: 0, h: 0 });
    const [natural, setNatural] = useState(null);
    const [view, setView] = useState(START);
    const pointers = useRef(new Map());
    const gesture = useRef(null);

    useLayoutEffect(() => {
        const node = box.current;
        const observer = new ResizeObserver(([entry]) =>
            setArea({
                w: entry.contentRect.width,
                h: entry.contentRect.height,
            }),
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    // the sizes every step below needs, kept fresh for the event handlers
    const geometry = useRef(null);
    const turned = (rot) => rot % 180 !== 0;
    const fitOf = (rot) => {
        if (!natural || !area.w || !area.h) return 1;
        const w = turned(rot) ? natural.h : natural.w;
        const h = turned(rot) ? natural.w : natural.h;
        return Math.min(1, area.w / w, area.h / h);
    };
    geometry.current = { natural, area, fitOf };

    /** Keep the picture over the area: no dragging it off into the dark. */
    const clamp = useCallback((next) => {
        const { natural: size, area: room, fitOf: fit } = geometry.current;
        if (!size) return next;
        const scale = fit(next.rot);
        const maxZoom = Math.max(2, MAX_NATURAL / scale);
        const zoom = Math.min(maxZoom, Math.max(1, next.zoom));
        const w = (turned(next.rot) ? size.h : size.w) * scale * zoom;
        const h = (turned(next.rot) ? size.w : size.h) * scale * zoom;
        const limitX = Math.max(0, (w - room.w) / 2);
        const limitY = Math.max(0, (h - room.h) / 2);
        return {
            ...next,
            zoom,
            x: Math.min(limitX, Math.max(-limitX, next.x)),
            y: Math.min(limitY, Math.max(-limitY, next.y)),
        };
    }, []);

    /** `now` zoomed by `factor`, keeping the point (px, py) from the centre still. */
    const zoomed = useCallback(
        (now, factor, px, py, animate) => {
            const next = clamp({ ...now, zoom: now.zoom * factor });
            const k = next.zoom / now.zoom;
            return clamp({
                ...next,
                x: px - (px - now.x) * k,
                y: py - (py - now.y) * k,
                animate,
            });
        },
        [clamp],
    );
    const zoomAt = useCallback(
        (factor, px = 0, py = 0, animate = false) =>
            setView((now) => zoomed(now, factor, px, py, animate)),
        [zoomed],
    );

    // a closed info panel or a resized window moves the edges the picture
    // was dragged against
    useEffect(() => {
        setView((now) => clamp(now));
    }, [area, natural, clamp]);

    useImperativeHandle(
        ref,
        () => ({
            zoomIn: () => zoomAt(1.5, 0, 0, true),
            zoomOut: () => zoomAt(1 / 1.5, 0, 0, true),
            reset: () =>
                setView((now) => ({ ...START, rot: now.rot, animate: true })),
            rotate: () =>
                setView((now) => ({
                    ...START,
                    rot: (now.rot + 90) % 360,
                    animate: true,
                })),
        }),
        [zoomAt],
    );

    // the zoom as a share of the picture's own pixels, for the toolbar
    const percent = Math.round(view.zoom * fitOf(view.rot) * 100);
    useEffect(() => {
        if (natural) onZoom?.(percent);
    }, [natural, percent, onZoom]);

    // a different picture starts fitted again
    useEffect(() => {
        setNatural(null);
        setView(START);
    }, [src]);

    // React's wheel handler is passive and cannot stop the page scrolling
    useEffect(() => {
        const node = box.current;
        const onWheel = (e) => {
            e.preventDefault();
            const rect = node.getBoundingClientRect();
            zoomAt(
                Math.exp(-e.deltaY * WHEEL_STEP),
                e.clientX - rect.left - rect.width / 2,
                e.clientY - rect.top - rect.height / 2,
            );
        };
        node.addEventListener("wheel", onWheel, { passive: false });
        return () => node.removeEventListener("wheel", onWheel);
    }, [zoomAt]);

    const fromCentre = (e) => {
        const rect = box.current.getBoundingClientRect();
        return {
            x: e.clientX - rect.left - rect.width / 2,
            y: e.clientY - rect.top - rect.height / 2,
        };
    };

    function startGesture() {
        const points = [...pointers.current.values()];
        if (points.length >= 2) {
            const [a, b] = points;
            gesture.current = {
                pinch: true,
                distance: Math.hypot(a.x - b.x, a.y - b.y),
                mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            };
        } else if (points.length === 1) {
            gesture.current = {
                pinch: false,
                start: points[0],
                last: points[0],
            };
        } else gesture.current = null;
    }

    function onPointerDown(e) {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        box.current.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, fromCentre(e));
        startGesture();
    }

    function onPointerMove(e) {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, fromCentre(e));
        const now = gesture.current;
        if (!now) return;
        const points = [...pointers.current.values()];
        if (now.pinch && points.length >= 2) {
            const [a, b] = points;
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const factor = distance / Math.max(1, now.distance);
            // moved and zoomed in one step, so the move is not cut short
            // by the edges of the zoom it is leaving
            setView((v) =>
                zoomed(
                    {
                        ...v,
                        x: v.x + mid.x - now.mid.x,
                        y: v.y + mid.y - now.mid.y,
                    },
                    factor,
                    mid.x,
                    mid.y,
                    false,
                ),
            );
            now.distance = distance;
            now.mid = mid;
            return;
        }
        if (!now.pinch) {
            const point = points[0];
            const dx = point.x - now.last.x;
            const dy = point.y - now.last.y;
            now.last = point;
            setView((v) =>
                v.zoom > 1
                    ? clamp({ ...v, x: v.x + dx, y: v.y + dy, animate: false })
                    : v,
            );
        }
    }

    function onPointerUp(e) {
        const now = gesture.current;
        pointers.current.delete(e.pointerId);
        if (now && !now.pinch && view.zoom <= 1) {
            const dx = now.last.x - now.start.x;
            const dy = now.last.y - now.start.y;
            if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5)
                onSwipe?.(dx < 0 ? "next" : "prev");
        }
        startGesture();
    }

    function onDoubleClick(e) {
        const point = fromCentre(e);
        if (view.zoom > 1.01) {
            setView((now) => ({ ...START, rot: now.rot, animate: true }));
            return;
        }
        // to the picture's own pixels, or twice the fit for a small one
        const target = Math.max(2, 1 / fitOf(view.rot));
        zoomAt(target, point.x, point.y, true);
    }

    const scale = fitOf(view.rot);
    return (
        <Box
            ref={box}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            sx={{
                position: "absolute",
                inset: 0,
                overflow: "hidden",
                touchAction: "none",
                userSelect: "none",
                cursor: view.zoom > 1 ? "grab" : "zoom-in",
                "&:active": { cursor: view.zoom > 1 ? "grabbing" : "zoom-in" },
            }}
        >
            {!natural && placeholder && (
                <img
                    src={placeholder}
                    alt=""
                    draggable={false}
                    style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        filter: "blur(12px)",
                        transform: "scale(1.02)",
                    }}
                />
            )}
            {src && (
                <img
                    src={src}
                    alt={alt}
                    draggable={false}
                    onLoad={(e) => {
                        const size = {
                            w: e.currentTarget.naturalWidth,
                            h: e.currentTarget.naturalHeight,
                        };
                        setNatural(size);
                        onSize?.(size);
                    }}
                    style={
                        natural
                            ? {
                                  position: "absolute",
                                  left: "50%",
                                  top: "50%",
                                  width: natural.w * scale,
                                  height: natural.h * scale,
                                  maxWidth: "none",
                                  transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${view.rot}deg) scale(${view.zoom})`,
                                  transition: view.animate
                                      ? "transform 0.18s ease-out"
                                      : "none",
                              }
                            : { position: "absolute", opacity: 0 }
                    }
                />
            )}
        </Box>
    );
});

ImageViewer.propTypes = {
    src: PropTypes.string,
    placeholder: PropTypes.string,
    alt: PropTypes.string,
    onZoom: PropTypes.func,
    onSwipe: PropTypes.func,
    onSize: PropTypes.func,
};

export default ImageViewer;
