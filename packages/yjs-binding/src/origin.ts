/**
 * The transaction-origin sentinel moved into the core (`@excalidraw/element`) as
 * part of the native-Yjs rewrite (M1): the doc is now the element store, so its
 * write-origin is a core concern.
 *
 * This file is a thin re-export shim so the (soon-to-be-deleted, M3) yjs-binding
 * keeps compiling. `BINDING_ORIGIN` is the legacy alias of the core's
 * `LOCAL_ORIGIN`.
 */
export { BINDING_ORIGIN, LOCAL_ORIGIN } from "@excalidraw/element/yjs/origin";
export type {
  BindingOrigin,
  LocalOrigin,
} from "@excalidraw/element/yjs/origin";
