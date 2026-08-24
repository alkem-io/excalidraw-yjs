import React from "react";

import type * as TExcalidraw from "@excalidraw-yjs/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw-yjs/excalidraw/types";

import CustomFooter from "./CustomFooter";

const MobileFooter = ({
  excalidrawAPI,
  excalidrawLib,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  excalidrawLib: typeof TExcalidraw;
}) => {
  const { useEditorInterface, Footer } = excalidrawLib;

  const editorInterface = useEditorInterface();
  if (editorInterface.formFactor === "phone") {
    return (
      <Footer>
        <CustomFooter
          excalidrawAPI={excalidrawAPI}
          excalidrawLib={excalidrawLib}
        />
      </Footer>
    );
  }
  return null;
};
export default MobileFooter;
