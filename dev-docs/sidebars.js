/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */

// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    {
      type: "category",
      label: "Introduction",
      link: {
        type: "doc",
        id: "introduction/get-started",
      },
      items: ["introduction/development", "introduction/contributing"],
    },
    {
      type: "category",
      label: "Codebase",
      items: ["codebase/json-schema", "codebase/frames"],
    },
    {
      type: "category",
      label: "@excalidraw-yjs/excalidraw",
      collapsed: false,
      items: [
        "@excalidraw-yjs/excalidraw/installation",
        "@excalidraw-yjs/excalidraw/integration",
        "@excalidraw-yjs/excalidraw/customizing-styles",
        {
          type: "category",
          label: "API",
          link: {
            type: "doc",
            id: "@excalidraw-yjs/excalidraw/api/api-intro",
          },
          items: [
            {
              type: "category",
              label: "Props",
              link: {
                type: "doc",
                id: "@excalidraw-yjs/excalidraw/api/props/props",
              },
              items: [
                "@excalidraw-yjs/excalidraw/api/props/initialdata",
                "@excalidraw-yjs/excalidraw/api/props/excalidraw-api",
                "@excalidraw-yjs/excalidraw/api/props/render-props",
                "@excalidraw-yjs/excalidraw/api/props/ui-options",
              ],
            },
            {
              type: "category",
              label: "Children Components",
              link: {
                type: "doc",
                id: "@excalidraw-yjs/excalidraw/api/children-components/children-components-intro",
              },
              items: [
                "@excalidraw-yjs/excalidraw/api/children-components/main-menu",
                "@excalidraw-yjs/excalidraw/api/children-components/welcome-screen",
                "@excalidraw-yjs/excalidraw/api/children-components/sidebar",
                "@excalidraw-yjs/excalidraw/api/children-components/footer",
                "@excalidraw-yjs/excalidraw/api/children-components/live-collaboration-trigger",
              ],
            },
            {
              type: "category",
              label: "Utils",
              link: {
                type: "doc",
                id: "@excalidraw-yjs/excalidraw/api/utils/utils-intro",
              },
              items: [
                "@excalidraw-yjs/excalidraw/api/utils/export",
                "@excalidraw-yjs/excalidraw/api/utils/restore",
              ],
            },
            "@excalidraw-yjs/excalidraw/api/constants",
            "@excalidraw-yjs/excalidraw/api/excalidraw-element-skeleton",
          ],
        },
        "@excalidraw-yjs/excalidraw/faq",
        "@excalidraw-yjs/excalidraw/development",
      ],
    },
    {
      type: "category",
      label: "@excalidraw/mermaid-to-excalidraw",
      link: {
        type: "doc",
        id: "@excalidraw/mermaid-to-excalidraw/installation",
      },
      items: [
        "@excalidraw/mermaid-to-excalidraw/api",
        "@excalidraw/mermaid-to-excalidraw/development",
        {
          type: "category",
          label: "Codebase",
          link: {
            type: "doc",
            id: "@excalidraw/mermaid-to-excalidraw/codebase/codebase",
          },
          items: [
            {
              type: "category",
              label: "How Parser works under the hood?",
              link: {
                type: "doc",
                id: "@excalidraw/mermaid-to-excalidraw/codebase/parser/parser",
              },
              items: [
                "@excalidraw/mermaid-to-excalidraw/codebase/parser/flowchart",
              ],
            },
            "@excalidraw/mermaid-to-excalidraw/codebase/new-diagram-type",
          ],
        },
      ],
    },
  ],
};

module.exports = sidebars;
