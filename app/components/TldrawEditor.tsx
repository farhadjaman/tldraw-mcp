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

            const fromShape = (shapesRef.current[fromId] || fromId) as TLShapeId;
            const toShape = (shapesRef.current[toId] || toId) as TLShapeId;

            if (!editor.getShape(fromShape) || !editor.getShape(toShape)) {
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
            const shapeId = (shapesRef.current[label] || label) as TLShapeId;

            if (editor.getShape(shapeId)) {
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
            const shapeId = (shapesRef.current[label] || label) as TLShapeId;
            const shape = editor.getShape(shapeId);

            if (shape) {
              editor.updateShape({ id: shapeId, type: shape.type, x, y });
              console.log("Moved shape:", label);
            } else {
              console.warn("moveShape: unknown shape handle:", label);
            }
            break;
          }

          case "resizeShape": {
            const { label, width, height } = operation.payload;
            const shapeId = (shapesRef.current[label] || label) as TLShapeId;
            const shape = editor.getShape(shapeId);

            if (shape && "w" in shape.props && "h" in shape.props) {
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
            const shapeId = (shapesRef.current[label] || label) as TLShapeId;
            const shape = editor.getShape(shapeId);

            if (shape) {
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
              .map((l) => (shapesRef.current[l] || l) as TLShapeId)
              .filter((id) => editor.getShape(id));

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
