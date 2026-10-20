// Construct with editor owners; callers serialize through the editor exporter.
exports.sceneImportFixture = (core) => {
  const scene = new core.Scene();
  const frame = core.newFrameElement({
    x: -20,
    y: -20,
    width: 700,
    height: 300,
    name: "Workflow",
  });
  scene.insertElement(frame);
  const roots = [0, 400].map((x) => {
    const element = core.newElement({
      type: "rectangle",
      x,
      y: 20,
      width: 160,
      height: 100,
    });
    scene.insertElement({
      ...element,
      frameId: frame.id,
      groupIds: ["workflow-group"],
    });
    return element.id;
  });
  const arrow = core.newArrowElement({
    type: "arrow",
    x: 160,
    y: 70,
    width: 240,
    height: 0,
    points: [
      [0, 0],
      [240, 0],
    ],
    endArrowhead: "arrow",
  });
  scene.insertElement({ ...arrow, frameId: frame.id });
  core.bindBindingElement(
    scene.getElement(arrow.id),
    scene.getElement(roots[0]),
    "orbit",
    "start",
    scene,
  );
  core.bindBindingElement(
    scene.getElement(arrow.id),
    scene.getElement(roots[1]),
    "orbit",
    "end",
    scene,
  );
  for (const id of [roots[0], arrow.id]) {
    const container = scene.getElement(id);
    const text = core.newTextElement({
      x: container.x,
      y: container.y,
      text: id === arrow.id ? "Next" : "Start",
      containerId: id,
      textAlign: "center",
      verticalAlign: "middle",
    });
    scene.insertElementsAtIndex(
      [{ ...text, frameId: frame.id }],
      scene
        .getElementsIncludingDeleted()
        .findIndex((element) => element.id === id) + 1,
    );
    scene.mutateElement(container, {
      boundElements: [
        ...(container.boundElements || []),
        { id: text.id, type: "text" },
      ],
    });
    core.redrawTextBoundingBox(
      scene.getElement(text.id),
      scene.getElement(id),
      scene,
    );
  }
  scene.insertElement({
    ...core.newFreeDrawElement({
      type: "freedraw",
      x: 30,
      y: 180,
      width: 40,
      height: 20,
      points: [
        [0, 0],
        [20, 20],
        [40, 0],
      ],
      pressures: [0.5, 0.7, 0.5],
      simulatePressure: false,
    }),
    frameId: frame.id,
  });
  scene.insertElement({
    ...core.newImageElement({
      type: "image",
      x: 500,
      y: 180,
      width: 20,
      height: 20,
      fileId: "source-image",
      status: "saved",
    }),
    frameId: frame.id,
  });
  return scene;
};

exports.assertSceneImport = (assert, core, Y, provider) => {
  const source = exports.sceneImportFixture(core);
  const input = {
    scene: {
      type: "excalidraw",
      version: 2,
      elements: source.getElementsIncludingDeleted(),
    },
    targetFileIDs: { "source-image": "logical-target-file" },
  };
  const doc = new Y.Doc();
  const target = new core.Scene(null, { doc });
  target.insertElementsAtIndex([...source.getElementsIncludingDeleted()], null);
  target.setAssetLocators({
    "source-image": "existing-file",
    unrelated: "keep-file",
  });
  target.yAppState.set("viewBackgroundColor", "pink");
  const before = Y.encodeStateAsUpdate(doc);
  const previousTail = target.getNonDeletedElements().at(-1).index;
  const original = JSON.stringify(input);
  const result = core.prepareSceneImport(doc, input, {
    textMetricsProvider: provider,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(JSON.stringify(input), original);
  const first = target.getNonDeletedElements()[0];
  const concurrentX = first.x + 3;
  target.mutateElement(first, { x: concurrentX });
  target.yAppState.set("name", "concurrent name");
  target.insertElement(
    core.newElement({ type: "ellipse", x: 900, y: 20, width: 30, height: 30 }),
  );
  Y.applyUpdate(doc, result.update);
  const added = result.addedElementIds.map((id) => target.getElement(id));
  assert.equal(added.length, input.scene.elements.length);
  assert.ok(added.every((element) => element.index > previousTail));
  assert.deepEqual(
    added.map(({ type, x, y, width, height }) => ({
      type,
      x,
      y,
      width,
      height,
    })),
    input.scene.elements.map(({ type, x, y, width, height }) => ({
      type,
      x,
      y,
      width,
      height,
    })),
  );
  const sourceIDs = new Set(input.scene.elements.map((element) => element.id));
  assert.ok(added.every((element) => !sourceIDs.has(element.id)));
  const importedIDs = new Set(added.map((element) => element.id));
  for (const element of added) {
    assert.ok(element.groupIds.every((id) => id !== "workflow-group"));
    for (const id of [
      element.frameId,
      element.containerId,
      element.startBinding?.elementId,
      element.endBinding?.elementId,
      ...(element.boundElements || []).map((edge) => edge.id),
    ].filter(Boolean)) {
      assert.ok(importedIDs.has(id));
    }
  }
  const image = added.find((element) => element.type === "image");
  assert.notEqual(image.fileId, "source-image");
  assert.equal(target.getAssetLocators()[image.fileId], "logical-target-file");
  assert.equal(target.getAssetLocators().unrelated, "keep-file");
  assert.equal(target.getAssetLocators()["source-image"], "existing-file");
  assert.equal(target.yAppState.get("viewBackgroundColor"), "pink");
  assert.equal(target.yAppState.get("name"), "concurrent name");
  assert.equal(target.getElement(first.id).x, concurrentX);
  assert.ok(
    target.getNonDeletedElements().some((element) => element.x === 900),
  );
  const once = Y.encodeStateAsUpdate(doc);
  Y.applyUpdate(doc, result.update);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), once);
  assert.ok(!new TextDecoder().decode(result.update).includes("data:image"));
  source.destroy();
  target.destroy();
};
