"use client";

import {
  createBindingId,
  createShapeId,
  Editor,
  TLShapeId,
  Tldraw,
  toRichText,
} from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import { useEffect, useRef } from "react";

const GEO_TYPES = ["rectangle", "ellipse", "triangle", "diamond"] as const;

// Plain text from a tldraw richText (tiptap) document.
function richTextToPlain(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    const inner = n.content.map(richTextToPlain);
    return n.type === "doc" ? inner.join("\n") : inner.join("");
  }
  return "";
}

// Resolve a label to a shape id. The in-memory map only knows shapes created in
// this tab session, so fall back to matching meta.label, then the shape's own
// text (exact, then first line, then prefix) against what's on the canvas.
function resolveShapeId(
  editor: Editor,
  map: Record<string, string>,
  label: string
): TLShapeId | undefined {
  const direct = map[label] as TLShapeId | undefined;
  if (direct && editor.getShape(direct)) return direct;
  if (editor.getShape(label as TLShapeId)) return label as TLShapeId;

  const norm = (s: string) => s.trim().toLowerCase();
  const target = norm(label);
  const shapes = editor.getCurrentPageShapes();

  let hit = shapes.find(
    (s) => typeof s.meta?.label === "string" && norm(s.meta.label) === target
  );
  if (!hit) {
    const withText = shapes
      .map((s) => ({
        s,
        text:
          "richText" in s.props ? norm(richTextToPlain(s.props.richText)) : "",
      }))
      .filter((e) => e.text);
    hit = (
      withText.find((e) => e.text === target) ||
      withText.find((e) => e.text.split("\n")[0].trim() === target) ||
      withText.find((e) => e.text.startsWith(target))
    )?.s;
  }

  if (hit) {
    map[label] = hit.id;
    return hit.id;
  }
  return undefined;
}

function bindArrow(
  editor: Editor,
  arrowId: TLShapeId,
  shapeId: TLShapeId,
  terminal: "start" | "end"
) {
  editor.createBinding({
    id: createBindingId(),
    type: "arrow",
    fromId: arrowId,
    toId: shapeId,
    props: {
      terminal,
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
      snap: "none",
    },
  });
}

export default function TldrawEditor() {
  const editorRef = useRef<Editor | null>(null);
  const shapesRef = useRef<Record<string, string>>({});
  useEffect(() => {
    // Only run in the browser
    if (typeof window === "undefined") return;

    console.log(
      "[TldrawEditor] Setting up EventSource connection to /api/events"
    );
    const eventSource = new EventSource("/api/events");

    eventSource.onopen = () => {
      console.log("[TldrawEditor] EventSource connection opened");
    };

    eventSource.onerror = (error) => {
      console.error("[TldrawEditor] EventSource error:", error);
    };
    eventSource.addEventListener("tldraw-operation", (event) => {
      const operation = JSON.parse(event.data);
      console.log("[TldrawEditor] Received tldraw operation:", operation);

      // Apply the operation to the tldraw editor
      if (editorRef.current) {
        const editor = editorRef.current;

        switch (operation.type) {
          case "createShape": {
            const { shapeType, x, y, width, height, text, color, fill, label } =
              operation.payload;
            const geo = GEO_TYPES.includes(shapeType) ? shapeType : "rectangle";
            const id = createShapeId();
            editor.createShape({
              id,
              type: "geo",
              x,
              y,
              ...(label ? { meta: { label } } : {}),
              props: {
                w: width,
                h: height,
                geo,
                ...(text ? { richText: toRichText(text) } : {}),
                ...(color ? { color } : {}),
                ...(fill ? { fill } : {}),
              },
            });

            if (label) shapesRef.current[label] = id;
            if ("stepNumber" in operation.payload) {
              shapesRef.current[`step-${operation.payload.stepNumber}`] = id;
            }

            console.log("Created shape with id:", id);
            break;
          }

          case "connectShapes": {
            const { fromId, toId, arrowType } = operation.payload;

            const fromShape = resolveShapeId(editor, shapesRef.current, fromId);
            const toShape = resolveShapeId(editor, shapesRef.current, toId);

            if (!fromShape || !toShape) {
              console.warn(
                "connectShapes: unknown shape handle(s):",
                fromId,
                toId
              );
              break;
            }

            const arrowId = createShapeId();
            editor.createShape({
              id: arrowId,
              type: "arrow",
              props: { bend: arrowType === "curved" ? 30 : 0 },
            });
            bindArrow(editor, arrowId, fromShape, "start");
            bindArrow(editor, arrowId, toShape, "end");

            console.log("Created arrow with id:", arrowId);
            break;
          }

          case "drawArrow": {
            const { x1, y1, x2, y2, arrowType } = operation.payload;
            const id = createShapeId();
            editor.createShape({
              id,
              type: "arrow",
              x: x1,
              y: y1,
              props: {
                start: { x: 0, y: 0 },
                end: { x: x2 - x1, y: y2 - y1 },
                bend: arrowType === "curved" ? 30 : 0,
              },
            });
            console.log("Drew free arrow with id:", id);
            break;
          }

          case "addText": {
            const { x, y, text, fontSize, label } = operation.payload;

            const id = createShapeId();
            editor.createShape({
              id,
              type: "text",
              x,
              y,
              ...(label ? { meta: { label } } : {}),
              props: {
                richText: toRichText(text),
                scale: fontSize ? fontSize / 20 : 1,
              },
            });

            if (label) shapesRef.current[label] = id;

            console.log("Created text with id:", id);
            break;
          }
          case "deleteShape": {
            const { label } = operation.payload;
            const shapeId = resolveShapeId(editor, shapesRef.current, label);

            if (shapeId) {
              editor.deleteShape(shapeId);
              delete shapesRef.current[label];
              console.log("Deleted shape:", label);
            } else {
              console.warn("deleteShape: unknown shape handle:", label);
            }
            break;
          }

          case "moveShape": {
            const { label, x, y } = operation.payload;
            const shapeId = resolveShapeId(editor, shapesRef.current, label);
            const shape = shapeId ? editor.getShape(shapeId) : undefined;

            if (shapeId && shape) {
              editor.updateShape({ id: shapeId, type: shape.type, x, y });
              console.log("Moved shape:", label);
            } else {
              console.warn("moveShape: unknown shape handle:", label);
            }
            break;
          }

          case "resizeShape": {
            const { label, width, height } = operation.payload;
            const shapeId = resolveShapeId(editor, shapesRef.current, label);
            const shape = shapeId ? editor.getShape(shapeId) : undefined;

            if (shapeId && shape && "w" in shape.props && "h" in shape.props) {
              editor.updateShape({
                id: shapeId,
                type: shape.type,
                props: { w: width, h: height },
              });
              console.log("Resized shape:", label);
            } else {
              console.warn(
                "resizeShape: unknown or non-resizable shape handle:",
                label
              );
            }
            break;
          }

          case "styleShape": {
            const { label, color, fill } = operation.payload;
            const shapeId = resolveShapeId(editor, shapesRef.current, label);
            const shape = shapeId ? editor.getShape(shapeId) : undefined;

            if (shapeId && shape) {
              editor.updateShape({
                id: shapeId,
                type: shape.type,
                props: {
                  ...(color && "color" in shape.props ? { color } : {}),
                  ...(fill && "fill" in shape.props ? { fill } : {}),
                },
              });
              console.log("Restyled shape:", label);
            } else {
              console.warn("styleShape: unknown shape handle:", label);
            }
            break;
          }

          case "deleteShapesByLabels": {
            const { labels } = operation.payload as { labels: string[] };
            const ids = labels
              .map((l) => resolveShapeId(editor, shapesRef.current, l))
              .filter((id): id is TLShapeId => !!id);

            if (ids.length) editor.deleteShapes(ids);
            for (const l of labels) delete shapesRef.current[l];
            console.log("Deleted shapes:", ids.length, "of", labels.length);
            break;
          }

          case "clearCanvas": {
            const ids = Array.from(editor.getCurrentPageShapeIds());
            if (ids.length) editor.deleteShapes(ids);
            shapesRef.current = {};
            console.log("Cleared canvas:", ids.length, "shapes");
            break;
          }

          case "deletePage": {
            const { name } = operation.payload;
            const pages = editor.getPages();
            const page = pages.find((p) => p.name === name);
            if (!page) {
              console.warn("deletePage: no page named:", name);
              break;
            }
            if (pages.length <= 1) {
              console.warn("deletePage: cannot delete the only page");
              break;
            }
            editor.deletePage(page.id);
            console.log("Deleted page:", name);
            break;
          }

          case "createFlowchartStep": {
            const { stepNumber, title, description, x, y, connectToPrevious } =
              operation.payload;

            const id = createShapeId();
            editor.createShape({
              id,
              type: "geo",
              x,
              y,
              meta: { label: title || `step-${stepNumber}` },
              props: {
                w: 160,
                h: 80,
                geo: "rectangle",
                richText: toRichText(
                  title + (description ? `\n${description}` : "")
                ),
              },
            });

            shapesRef.current[`step-${stepNumber}`] = id;
            if (title) shapesRef.current[title] = id;

            if (connectToPrevious && stepNumber > 1) {
              const prevStepId = shapesRef.current[
                `step-${stepNumber - 1}`
              ] as TLShapeId | undefined;

              if (prevStepId) {
                const arrowId = createShapeId();
                editor.createShape({ id: arrowId, type: "arrow" });
                bindArrow(editor, arrowId, prevStepId, "start");
                bindArrow(editor, arrowId, id, "end");
              }
            }

            console.log("Created flowchart step with id:", id);
            break;
          }

          case "createPage": {
            const { name } = operation.payload;
            const before = new Set(editor.getPages().map((p) => p.id));
            editor.createPage({ name });
            const created = editor.getPages().find((p) => !before.has(p.id));
            if (created) editor.setCurrentPage(created.id);
            console.log("Created and switched to page:", name);
            break;
          }

          case "switchPage": {
            const { name } = operation.payload;
            const page = editor.getPages().find((p) => p.name === name);
            if (page) {
              editor.setCurrentPage(page.id);
              console.log("Switched to page:", name);
            } else {
              console.warn("No page named:", name);
            }
            break;
          }

          case "requestPageList": {
            const { requestId } = operation.payload;
            const currentPageId = editor.getCurrentPageId();
            const pages = editor.getPages().map((p) => ({
              name: p.name,
              current: p.id === currentPageId,
            }));

            fetch("/api/page-list", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requestId, pages }),
            }).catch((error) => {
              console.error("Failed to send page list:", error);
            });
            break;
          }

          case "requestSnapshot": {
            const { requestId } = operation.payload;

            const snapshot = editor.store.getSnapshot();

            fetch("/api/snapshot", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                requestId,
                snapshot,
              }),
            }).catch((error) => {
              console.error("Failed to send snapshot:", error);
            });

            console.log("Snapshot requested with id:", requestId);
            break;
          }

          default:
            console.warn("Unknown operation type:", operation.type);
        }
      }
    }); // Add handler for connected event
    eventSource.addEventListener("connected", (event) => {
      console.log("[TldrawEditor] Received connected event:", event.data);
    });

    // Add handler for heartbeat event
    eventSource.addEventListener("heartbeat", (event) => {
      console.log("[TldrawEditor] Received heartbeat event:", event.data);
    });

    // Add handler for debug event
    eventSource.addEventListener("debug", (event) => {
      console.log("[TldrawEditor] Received debug event:", event.data);
    });

    return () => {
      console.log("[TldrawEditor] Closing EventSource connection");
      eventSource.close();
    };
  }, []);

  return (
    <div style={{ height: "calc(100vh - 80px)", width: "100%" }}>
      <Tldraw
        persistenceKey="tldraw-mcp"
        onMount={(editor) => {
          editorRef.current = editor;
          console.log("Tldraw editor mounted");
        }}
      />
    </div>
  );
}
