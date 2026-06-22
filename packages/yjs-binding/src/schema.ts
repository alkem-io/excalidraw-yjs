/**
 * The per-property element↔`Y.Map` schema moved into the core
 * (`@excalidraw/element`) as part of the native-Yjs rewrite (M1): the doc is now
 * the element store, so the schema is a core element concern.
 *
 * This file is a thin re-export shim so the (soon-to-be-deleted, M3) yjs-binding
 * keeps compiling and existing imports (`./schema`) resolve unchanged.
 */
export {
  ELEMENTS,
  FILES,
  APPSTATE,
  APPSTATE_ALLOW_LIST,
  JSON_LEAF_KEYS,
  BOUND_ELEMENTS_KEY,
  RECONCILE_META_KEYS,
  deepEqual,
  boundElementsToYMap,
  yMapToBoundElements,
  extraBoundTextIds,
  elementToYMap,
  yMapToElement,
  writeChangedKeys,
  diffBoundElements,
  BINDING_ORIGIN,
  LOCAL_ORIGIN,
} from "@excalidraw/element/yjs/schema";

export type {
  AppStateAllowKey,
  BoundElementType,
  ElementRecord,
} from "@excalidraw/element/yjs/schema";
